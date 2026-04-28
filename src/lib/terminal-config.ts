import type { TerminalConfig, TerminalType, TerminalBackend } from "../types";
import { getCachedWslPath, getCachedCliPath, getCachedDistro } from "./wsl-cache";
import { getCachedWindowsCliPath } from "./windows-cli-cache";
import { getCachedNativeCliPath } from "./macos-cli-cache";
import { getResumeFlag, supportsSessionResume } from "./session-resume";
import { isWindows } from "./platform";

// POSIX shell single-quote an arbitrary string. Escapes embedded single quotes
// via the standard `'\''` sequence. Safe for any character including (, ), $, etc.
function sh(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Returns the YOLO/skip-permissions flag for a given CLI, or null if not applicable. */
export function getYoloFlag(type: TerminalType): string | null {
  switch (type) {
    case "claude": return "--dangerously-skip-permissions";
    case "codex": return "--yolo";
    case "gemini": return "--yolo";
    default: return null;
  }
}

// Base configs for each terminal type.
const TERMINAL_CONFIGS_BASE: Record<TerminalType, TerminalConfig> = {
  claude: {
    command: "wsl.exe",
    args: ["--", "bash", "-lic", "exec claude"],
    label: "Claude Code",
    description: "Anthropic's AI coding assistant",
  },
  codex: {
    command: "wsl.exe",
    args: ["--", "bash", "-lic", "exec codex"],
    label: "Codex CLI",
    description: "OpenAI's coding CLI",
  },
  gemini: {
    command: "wsl.exe",
    args: ["--", "bash", "-lic", "exec gemini"],
    label: "Gemini CLI",
    description: "Google's AI coding CLI",
  },
  shell: {
    command: "powershell.exe",
    args: [],
    label: "PowerShell",
    description: "Windows PowerShell",
  },
  devserver: {
    command: "wsl.exe",
    args: ["--", "bash", "-lic", "exec bash"],
    label: "Dev Server",
    description: "WSL bash for dev servers",
  },
};

// Base configs for Windows native backend (no WSL wrapping).
const TERMINAL_CONFIGS_WINDOWS: Record<TerminalType, TerminalConfig> = {
  claude: {
    command: "claude",
    args: [],
    label: "Claude Code",
    description: "Anthropic's AI coding assistant",
  },
  codex: {
    command: "codex",
    args: [],
    label: "Codex CLI",
    description: "OpenAI's coding CLI",
  },
  gemini: {
    command: "gemini",
    args: [],
    label: "Gemini CLI",
    description: "Google's AI coding CLI",
  },
  shell: {
    command: "powershell.exe",
    args: [],
    label: "PowerShell",
    description: "Windows PowerShell",
  },
  devserver: {
    command: "powershell.exe",
    args: [],
    label: "Dev Server",
    description: "PowerShell for dev servers",
  },
};

// Base configs for native backend (macOS/Linux — direct shell, no WSL).
const TERMINAL_CONFIGS_NATIVE: Record<TerminalType, TerminalConfig> = {
  claude: {
    command: "claude",
    args: [],
    label: "Claude Code",
    description: "Anthropic's AI coding assistant",
  },
  codex: {
    command: "codex",
    args: [],
    label: "Codex CLI",
    description: "OpenAI's coding CLI",
  },
  gemini: {
    command: "gemini",
    args: [],
    label: "Gemini CLI",
    description: "Google's AI coding CLI",
  },
  shell: {
    command: "/bin/zsh",
    args: ["-l"],
    label: "Shell",
    description: "Default shell",
  },
  devserver: {
    command: "/bin/zsh",
    args: ["-l"],
    label: "Dev Server",
    description: "Shell for dev servers",
  },
};

/**
 * Build PowerShell launch args that drop the user into the project's
 * working directory. Decision is purely **path-shape based** — independent
 * of tab.backend / global terminalBackend, since powershell.exe is always
 * the same executable regardless of where the project lives. PS panes
 * therefore have their OWN routing, decoupled from CLI-pane routing.
 *
 *  - Windows filesystem (`C:\…`, `\\server\share\…`, `/mnt/<drive>/…`):
 *    → `-NoExit -Command "Set-Location -LiteralPath '<winpath>'"`
 *    `/mnt/<drive>/foo` translates to `<drive>:\foo` first, since `/mnt/c`
 *    is just the WSL view of a real Windows disk.
 *  - WSL filesystem (`/home/…`, `/root/…`, `\\wsl.localhost\…`, `\\wsl$\…`):
 *    → `-NoExit -Command "wsl -d <distro> --cd <path>"` — PS opens and
 *    immediately drops into bash inside WSL. Navigating PS to a
 *    \\wsl.localhost\ UNC breaks PSReadLine and many tools, so we don't.
 *  - Empty cwd: returns `[]` — PS spawns at parent process's cwd.
 *
 * The command runs via `-NoExit -Command` so it executes BEFORE PSReadLine
 * takes over the input line — avoiding the char-by-char redraw chaos that
 * would happen if the same command were piped through stdin after launch.
 */
export function buildPowerShellLaunchArgsForCwd(cwd: string | undefined): string[] {
  if (!cwd) return [];

  const norm = cwd.replace(/\\/g, "/").toLowerCase();
  const isWslFs =
    norm.startsWith("/home/") ||
    norm.startsWith("/root/") ||
    norm.startsWith("//wsl.localhost/") ||
    norm.startsWith("//wsl$/");

  if (isWslFs) {
    // WSL filesystem — drop into bash inside the distro at the project path.
    const distro = getCachedDistro();
    const distroFlag = distro ? `-d ${distro} ` : "";
    return ["-NoExit", "-Command", `wsl ${distroFlag}--cd ${cwd}`];
  }

  // Windows filesystem (incl. /mnt/<drive>/ which is just a WSL view of a
  // Windows disk) — Set-Location to the translated Windows path.
  const winPath = mntToWindowsPath(cwd);
  const escaped = winPath.replace(/'/g, "''");
  return ["-NoExit", "-Command", `Set-Location -LiteralPath '${escaped}'`];
}

/** /mnt/c/Users/foo → C:\Users\foo. Pass-through for any non-/mnt path. */
function mntToWindowsPath(p: string): string {
  const m = p.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (!m) return p;
  const drive = m[1].toUpperCase();
  const rest = m[2].replace(/\//g, "\\");
  return `${drive}:\\${rest}`;
}

/**
 * Get terminal config for a given type.
 * When backend is "native", uses direct macOS/Linux executables.
 * When backend is "windows", uses native Windows executables directly.
 * When backend is "wsl" (default), uses cached PATH + absolute CLI path
 * when available (fast path), falls back to bash -lic (slow path) otherwise.
 */
export function getTerminalConfig(type: TerminalType, sessionResumeId?: string, extraArgs?: string[], wslCwd?: string, backend?: TerminalBackend): TerminalConfig {
  // Native backend (macOS/Linux) — direct spawn, no WSL
  if (backend === "native") {
    const nativeBase = TERMINAL_CONFIGS_NATIVE[type];
    if (type === "shell" || type === "devserver") return nativeBase;

    const cliPath = getCachedNativeCliPath(type);
    const resumeArgs = sessionResumeId && supportsSessionResume(type)
      ? getResumeFlag(type, sessionResumeId).split(" ")
      : [];
    const extra = extraArgs ?? [];

    return {
      ...nativeBase,
      command: cliPath ?? nativeBase.command,
      args: [...extra, ...resumeArgs],
    };
  }

  // Windows native backend — use resolved .exe/.cmd path directly
  if (backend === "windows") {
    const winBase = TERMINAL_CONFIGS_WINDOWS[type];
    if (type === "shell" || type === "devserver") {
      const cwdArgs = buildPowerShellLaunchArgsForCwd(wslCwd);
      return cwdArgs.length ? { ...winBase, args: cwdArgs } : winBase;
    }

    const cliPath = getCachedWindowsCliPath(type);
    const resumeArgs = sessionResumeId && supportsSessionResume(type)
      ? getResumeFlag(type, sessionResumeId).split(" ")
      : [];
    const extra = extraArgs ?? [];

    // npm-installed CLIs on Windows are typically .cmd/.bat shims. CreateProcessW
    // (which portable_pty uses) can't execute batch files directly — they must be
    // run through cmd.exe /c. Without this wrapper, the spawn fails immediately
    // and the user sees "[Process exited]" before any output appears.
    if (cliPath && /\.(cmd|bat)$/i.test(cliPath)) {
      return {
        ...winBase,
        command: "cmd.exe",
        args: ["/c", cliPath, ...extra, ...resumeArgs],
      };
    }

    return {
      ...winBase,
      command: cliPath ?? winBase.command,
      args: [...extra, ...resumeArgs],
    };
  }

  // WSL backend (default). Shell type still spawns powershell.exe on Windows
  // (we're not in a WSL pane — that's claude/codex/gemini). Apply the same
  // cwd-injection so PS drops the user straight into WSL bash at the project.
  const base = TERMINAL_CONFIGS_BASE[type];
  if (type === "shell" || type === "devserver") {
    const cwdArgs = buildPowerShellLaunchArgsForCwd(wslCwd);
    return cwdArgs.length ? { ...base, args: cwdArgs } : base;
  }

  const resumeArgs = sessionResumeId && supportsSessionResume(type)
    ? getResumeFlag(type, sessionResumeId).split(" ")
    : [];
  const extra = extraArgs ?? [];

  const cachedPath = getCachedWslPath();
  const cliPath = getCachedCliPath(type);
  const distro = getCachedDistro();

  // When resuming a session, always use bash -lic (slow path).
  // wsl.exe -e /usr/bin/env passes --resume as separate args which can get
  // mangled by wsl.exe's argument parser. bash -lic wraps everything in a
  // single shell command string, matching manual `claude --resume <uuid>`.
  if (cachedPath && cliPath && resumeArgs.length === 0) {
    // Fast path: skip bash entirely, use dash (sh) for env + exec.
    const distroArgs = distro ? ["-d", distro] : [];
    const envArgs = [
      `PATH=${cachedPath}`,
      "TERM=xterm-256color",
      "COLORTERM=truecolor",
    ];
    return {
      ...base,
      args: [
        ...distroArgs, "-e", "/usr/bin/env",
        ...envArgs,
        cliPath,
        ...extra,
      ],
    };
  }

  // Resume / slow path: bash -lic — bake cd + exec into a single shell string.
  // This matches the manual `cd /path && claude --resume <uuid>` that works.
  // When wslCwd is provided, cd is inside bash (no wsl.exe --cd flag needed).
  const suffixParts = [...extra, ...resumeArgs];
  if (suffixParts.length > 0 || (cachedPath && cliPath)) {
    const execCmd = cliPath ?? base.args[base.args.length - 1];
    // Quote the exec path and every arg so paths with `(`, spaces, or quotes
    // (e.g. `/mnt/c/Program Files (x86)/...`) don't blow up bash.
    const fullCmd = [sh(execCmd), ...suffixParts.map(sh)].join(" ");
    const distroArgs = distro ? ["-d", distro] : [];
    const cdPart = wslCwd ? `cd ${sh(wslCwd)} && ` : "";
    return {
      ...base,
      args: [...distroArgs, "--", "bash", "-lic", `export TERM=xterm-256color COLORTERM=truecolor; ${cdPart}exec ${fullCmd}`],
    };
  }

  return base;
}

// For label/description lookups (non-spawn uses)
export const TERMINAL_CONFIGS = TERMINAL_CONFIGS_BASE;

/**
 * Convert a Windows path to a WSL Linux path.
 * Handles both drive paths and UNC WSL paths:
 *   C:\Users\foo       → /mnt/c/Users/foo
 *   \\wsl.localhost\Ubuntu-24.04\home\foo → /home/foo
 *   \\wsl$\Ubuntu-24.04\home\foo         → /home/foo
 */
export function toWslPath(winPath: string): string {
  if (!winPath) return "";

  // UNC WSL path: \\wsl.localhost\Distro\path or \\wsl$\Distro\path
  const uncMatch = winPath.match(
    /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/][^\\/]+[\\/]?(.*)/i
  );
  if (uncMatch) {
    const rest = uncMatch[1].replace(/\\/g, "/");
    return rest ? `/${rest}` : "/";
  }

  // Standard drive path: C:\foo\bar → /mnt/c/foo/bar
  return winPath
    .replace(
      /^([A-Za-z]):\\/,
      (_m, drive: string) => `/mnt/${drive.toLowerCase()}/`
    )
    .replace(/\\/g, "/");
}

/**
 * Build the shell command to send to a pre-warmed WSL bash session.
 * Returns null if we don't have the absolute CLI path cached
 * (pooled bash has --norc --noprofile, so it can't resolve CLI names).
 */
export function getPooledInitCommand(type: TerminalType, wslCwd?: string, sessionResumeId?: string, extraArgs?: string[], backend?: TerminalBackend): string | null {
  if (type === "shell") return null;
  if (backend === "windows") return null; // No WSL pool in Windows mode
  if (backend === "native") return null;  // No WSL pool on macOS/Linux

  const cachedPath = getCachedWslPath();
  const cliPath = getCachedCliPath(type);

  // Require both — pooled bash has no profile, can't find CLIs by name
  if (!cachedPath || !cliPath) return null;

  const extraSuffix = extraArgs?.length ? ` ${extraArgs.map(sh).join(" ")}` : "";
  // getResumeFlag returns e.g. "--resume <uuid>" — split + quote each token.
  const resumeSuffix = sessionResumeId && supportsSessionResume(type)
    ? ` ${getResumeFlag(type, sessionResumeId).split(" ").map(sh).join(" ")}`
    : "";

  const parts: string[] = [];
  parts.push(`export PATH=${sh(cachedPath)}`);
  parts.push("export TERM=xterm-256color COLORTERM=truecolor");
  if (wslCwd) {
    parts.push(`cd ${sh(wslCwd)}`);
  }

  // Clear the screen before exec so startup noise from Codex/Gemini is never visible.
  parts.push("printf '\\033[2J\\033[H'");
  parts.push(`exec ${sh(cliPath)}${extraSuffix}${resumeSuffix}`);

  return parts.join("; ");
}

/** Returns true if the terminal type runs inside WSL */
export function isWslTerminal(type: TerminalType, backend?: TerminalBackend): boolean {
  if (backend === "windows") return false;
  if (backend === "native") return false;
  return type !== "shell";
}

/** Map terminal type to the remote command to exec over SSH */
function getRemoteExecCommand(type: TerminalType, sessionResumeId?: string): string {
  const resumeSuffix = sessionResumeId && supportsSessionResume(type)
    ? ` ${getResumeFlag(type, sessionResumeId).split(" ").map(sh).join(" ")}`
    : "";
  switch (type) {
    case "claude":
      return `exec claude${resumeSuffix}`;
    case "codex":
      return `exec codex${resumeSuffix}`;
    case "gemini":
      return `exec gemini${resumeSuffix}`;
    case "shell":
      return "exec bash -l";
    case "devserver":
      return "exec bash -l";
  }
}

/**
 * Build SSH command + args for spawning a remote terminal.
 * Uses ssh.exe on Windows, ssh on macOS/Linux.
 */
export function getSshCommand(
  server: { username: string; host: string; authMethod: string; sshKeyPath?: string },
  terminalType: TerminalType,
  remoteCwd?: string,
  sessionResumeId?: string
): { command: string; args: string[] } {
  const host = server.host;
  const userHost = `${server.username}@${host}`;

  const args: string[] = ["-t"];

  // Add identity file for ssh-key auth
  if (server.authMethod === "ssh-key" && server.sshKeyPath) {
    args.push("-i", server.sshKeyPath);
  }

  // Disable strict host key checking for convenience (local network / Tailscale)
  args.push("-o", "StrictHostKeyChecking=no");

  args.push(userHost);

  // Build the remote command: cd to dir (if specified) then exec the tool
  const envExport = "export TERM=xterm-256color COLORTERM=truecolor;";
  const remoteCmd = getRemoteExecCommand(terminalType, sessionResumeId);
  if (remoteCwd) {
    args.push(`${envExport} cd ${sh(remoteCwd)} && ${remoteCmd}`);
  } else {
    args.push(`${envExport} ${remoteCmd}`);
  }

  return { command: isWindows() ? "ssh.exe" : "ssh", args };
}
