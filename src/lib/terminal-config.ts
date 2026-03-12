import type { TerminalConfig, TerminalType, TerminalBackend } from "../types";
import { getCachedWslPath, getCachedCliPath, getCachedDistro } from "./wsl-cache";
import { getCachedWindowsCliPath } from "./windows-cli-cache";
import { getResumeFlag, supportsSessionResume } from "./session-resume";

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

/**
 * Get terminal config for a given type.
 * When backend is "windows", uses native Windows executables directly.
 * When backend is "wsl" (default), uses cached PATH + absolute CLI path
 * when available (fast path), falls back to bash -lic (slow path) otherwise.
 */
export function getTerminalConfig(type: TerminalType, sessionResumeId?: string, extraArgs?: string[], wslCwd?: string, backend?: TerminalBackend): TerminalConfig {
  // Windows native backend — use resolved .exe/.cmd path directly
  if (backend === "windows") {
    const winBase = TERMINAL_CONFIGS_WINDOWS[type];
    if (type === "shell" || type === "devserver") return winBase;

    const cliPath = getCachedWindowsCliPath(type);
    const resumeArgs = sessionResumeId && supportsSessionResume(type)
      ? getResumeFlag(type, sessionResumeId).split(" ")
      : [];
    const extra = extraArgs ?? [];

    return {
      ...winBase,
      command: cliPath ?? winBase.command,
      args: [...extra, ...resumeArgs],
    };
  }

  // WSL backend (default)
  const base = TERMINAL_CONFIGS_BASE[type];
  if (type === "shell" || type === "devserver") return base;

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
    const fullCmd = [execCmd, ...suffixParts].join(" ");
    const distroArgs = distro ? ["-d", distro] : [];
    const cdPart = wslCwd ? `cd '${wslCwd}' && ` : "";
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

  const cachedPath = getCachedWslPath();
  const cliPath = getCachedCliPath(type);

  // Require both — pooled bash has no profile, can't find CLIs by name
  if (!cachedPath || !cliPath) return null;

  const extraSuffix = extraArgs?.length ? ` ${extraArgs.join(" ")}` : "";
  const resumeSuffix = sessionResumeId && supportsSessionResume(type)
    ? ` ${getResumeFlag(type, sessionResumeId)}`
    : "";

  const parts: string[] = [];
  parts.push(`export PATH='${cachedPath}'`);
  parts.push("export TERM=xterm-256color COLORTERM=truecolor");
  if (wslCwd) {
    parts.push(`cd '${wslCwd}'`);
  }

  // Clear the screen before exec so startup noise from Codex/Gemini is never visible.
  parts.push("printf '\\033[2J\\033[H'");
  parts.push(`exec ${cliPath}${extraSuffix}${resumeSuffix}`);

  return parts.join("; ");
}

/** Returns true if the terminal type runs inside WSL */
export function isWslTerminal(type: TerminalType, backend?: TerminalBackend): boolean {
  if (backend === "windows") return false;
  return type !== "shell";
}

/** Map terminal type to the remote command to exec over SSH */
function getRemoteExecCommand(type: TerminalType, sessionResumeId?: string): string {
  const resumeSuffix = sessionResumeId && supportsSessionResume(type)
    ? ` ${getResumeFlag(type, sessionResumeId)}`
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
 * Uses native Windows ssh.exe (no WSL wrapping needed).
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
    args.push(`${envExport} cd ${remoteCwd} && ${remoteCmd}`);
  } else {
    args.push(`${envExport} ${remoteCmd}`);
  }

  return { command: "ssh.exe", args };
}
