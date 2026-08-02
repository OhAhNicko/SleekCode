import type { TerminalConfig, TerminalType, TerminalBackend } from "../types";
import { getCachedWslPath, getCachedCliPath, getCachedDistro } from "./wsl-cache";
import { getCachedWindowsCliPath } from "./windows-cli-cache";
import { getCachedNativeCliPath } from "./macos-cli-cache";
import { getResumeFlag, supportsSessionResume } from "./session-resume";
import { isWindows } from "./platform";
import { getKeychainUnlockPreamble } from "./keychain";

// POSIX shell single-quote an arbitrary string. Escapes embedded single quotes
// via the standard `'\''` sequence. Safe for any character including (, ), $, etc.
function sh(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * PowerShell single-quote an arbitrary string. Inside `'…'` PowerShell expands
 * nothing and the only escape is a doubled quote, so this is safe for spaces,
 * `$`, backticks and parentheses alike.
 */
function psq(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Drop trailing path separators before a path is handed to a NATIVE command
 * (wsl.exe) from inside a PowerShell string.
 *
 * PowerShell re-quotes native arguments with DOUBLE quotes when it builds the
 * child's command line, so `'C:\proj\CS 16\'` leaves the callee parsing
 * `"C:\proj\CS 16\"` — the trailing backslash escapes the closing quote and the
 * argument swallows whatever follows. Harmless for `-LiteralPath`, which
 * PowerShell consumes itself, so this is only applied on the wsl branch.
 *
 * A bare root (`/`, `C:\`) is left alone — there is nothing to trim to.
 */
function stripTrailingSep(p: string): string {
  if (/^[a-zA-Z]:[\\/]?$/.test(p) || /^[\\/]+$/.test(p)) return p;
  return p.replace(/[\\/]+$/, "");
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
    args: ["--", "bash", "-lic", "export TERM=xterm-256color COLORTERM=truecolor; exec claude"],
    label: "Claude Code",
    description: "Anthropic's AI coding assistant",
  },
  codex: {
    command: "wsl.exe",
    args: ["--", "bash", "-lic", "export TERM=xterm-256color COLORTERM=truecolor; exec codex"],
    label: "Codex CLI",
    description: "OpenAI's coding CLI",
  },
  gemini: {
    command: "wsl.exe",
    args: ["--", "bash", "-lic", "export TERM=xterm-256color COLORTERM=truecolor; exec gemini"],
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
    args: ["--", "bash", "-lic", "export TERM=xterm-256color COLORTERM=truecolor; exec bash"],
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
 * working directory, in the requested `mode`:
 *
 *  - `"wsl"` → `-NoExit -Command "wsl -d <distro> --cd <path>"` — PS opens
 *    and immediately drops into bash inside WSL at the project. wsl.exe's
 *    `--cd` accepts Linux paths (`/mnt/c/foo`, `/home/foo`) and Windows paths
 *    (`C:\foo`, auto-translated) alike, so `cwd` is passed as-is.
 *  - `"windows"` → `-NoExit -Command "Set-Location -LiteralPath '<winpath>'"`
 *    with `/mnt/<drive>/foo` translated to `<drive>:\foo` first, since `/mnt/c`
 *    is just the WSL view of a real Windows disk.
 *  - WSL-filesystem paths (`/home/…`, `/root/…`, `\\wsl.localhost\…`,
 *    `\\wsl$\…`) are ALWAYS routed via `wsl --cd`, whatever the mode:
 *    navigating PS to a \\wsl.localhost\ UNC breaks PSReadLine and many tools.
 *  - Empty cwd: returns `[]` — PS spawns at parent process's cwd.
 *
 * The mode is caller-supplied (per-project WSL/WIN badge override, else the
 * pane's backend — see `shellPsModeFor`). It was path-shape-only from v0.1.40
 * to v0.2.4, which silently dropped the WSL preload for every `/mnt/<drive>/`
 * project: the tab resolved to the wsl backend but the shell opened plain PS.
 *
 * The command runs via `-NoExit -Command` so it executes BEFORE PSReadLine
 * takes over the input line — avoiding the char-by-char redraw chaos that
 * would happen if the same command were piped through stdin after launch.
 */
export function buildPowerShellLaunchArgsForCwd(
  cwd: string | undefined,
  mode: "wsl" | "windows",
  paneId?: string,
): string[] {
  if (!cwd) return [];

  const norm = cwd.replace(/\\/g, "/").toLowerCase();
  const isWslFs =
    norm.startsWith("/home/") ||
    norm.startsWith("/root/") ||
    norm.startsWith("//wsl.localhost/") ||
    norm.startsWith("//wsl$/");

  if (isWslFs || mode === "wsl") {
    // Drop into bash inside the distro at the project path.
    const distro = getCachedDistro();
    const distroFlag = distro ? `-d ${distro} ` : "";
    // Pane tagging (hibernation idle gate): WSLENV is the only way a Windows
    // env var crosses into the Linux environment, and appending (not
    // overwriting) preserves whatever the user already forwards. Done via
    // $env: so the user's default WSL shell is untouched — wrapping the
    // command in an explicit bash would silently override zsh/fish setups.
    const tag = paneId
      ? `$env:MADE_PANE_ID='${safePaneId(paneId)}'; if ($env:WSLENV) { $env:WSLENV += ':MADE_PANE_ID' } else { $env:WSLENV = 'MADE_PANE_ID' }; `
      : "";
    // QUOTED, always. Unquoted, PowerShell split the path on its spaces before
    // wsl.exe ever saw it: a project at `…\projects\CS 16` became
    // `--cd …\projects\CS` plus a stray `16` that wsl tried to EXECUTE, so the
    // pane died with `Wsl/ERROR_FILE_NOT_FOUND` and sat at a bare PS prompt in
    // the user's home directory. Every sibling call site here already quoted
    // (`sh()` for bash, `-LiteralPath` below); this branch was the one that
    // did not.
    return ["-NoExit", "-Command", `${tag}wsl ${distroFlag}--cd ${psq(stripTrailingSep(cwd))}`];
  }

  // Windows filesystem (incl. /mnt/<drive>/ which is just a WSL view of a
  // Windows disk) — Set-Location to the translated Windows path.
  return ["-NoExit", "-Command", `Set-Location -LiteralPath ${psq(mntToWindowsPath(cwd))}`];
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
/**
 * Claude supports `--session-id <uuid>` ("Use a specific session ID for the
 * conversation (must be a valid UUID)"), verified on 2.1.219: passing it makes
 * Claude write exactly `<uuid>.jsonl`.
 *
 * That lets MADE ASSIGN the session id up front instead of guessing it
 * afterwards from the newest .jsonl mtime — the heuristic behind the
 * session-steal, clock-skew and case-sensitivity bug classes, where two panes
 * racing to claim the same freshly-written file swap each other's sessions.
 *
 * Only for NEW Claude sessions: a resume passes `--resume <id>` instead, and
 * reusing an existing id here would collide.
 *
 * NOTE: `CLAUDE_CODE_SESSION_ID` does NOT do this — it is read-only (Claude
 * exports it to hooks/child processes). Tested: Claude ignored it and created
 * its own id.
 */
/**
 * Terminal identity advertised to the AI CLIs via TERM_PROGRAM.
 *
 * Claude Code keeps a capability table keyed by TERM_PROGRAM and gates
 * `syncOutput`, `progressReporting` and its automatic notification channel on
 * recognising the terminal. With none set, MADE gets none of them — which is
 * why the progress bar has nothing to draw and notifications fall back to the
 * bell.
 *
 * FREE-FORM ON PURPOSE. The capability table is a flat string list in the
 * binary, so which terminals sit in which capability sets could NOT be
 * reconstructed — it is genuinely unknown whether e.g. `alacritty` qualifies
 * for syncOutput. Rather than hardcode a guess, any value can be entered and
 * tried; these are the names the table contains:
 *
 *   iTerm.app · WezTerm · WarpTerminal · ghostty · contour · vscode
 *   alacritty · mintty · Tabby · kitty · xterm-ghostty · foot
 *
 * DEFAULT: `ghostty`. The rule is "only advertise what MADE can render", and
 * MADE now honours everything ghostty implies that Claude uses — synchronized
 * output, ConEmu progress, and OSC 777 notifications (the richest of the three
 * channels, the only one carrying a title as well as a body).
 *
 * `alacritty` was tried first on the reasoning that MADE's parser IS
 * alacritty_terminal, so claiming it was the "honest" answer. That was the
 * wrong test: TERM_PROGRAM is a capability negotiation, not a statement of
 * fact. Alacritty has no desktop-notification protocol, so on Claude's default
 * "Auto" channel that identity resolves to the bell — which MADE deliberately
 * ignores — guaranteeing silence. A default should make the features work.
 *
 * Residual risk, unchanged: ghostty also implies kitty graphics and CSI-u
 * keyboard, which MADE does NOT support. Programs query before using those and
 * MADE answers nothing, so it should not arise; if a pane ever shows garbage,
 * switching identity in Settings undoes it immediately.
 */

/** Version reported when the user leaves the version field blank. Claude
 * enforces per-terminal minimums (ghostty 1.2.0, iTerm.app 3.6.6), so a known
 * name with no version can be rejected outright. Keys are lowercased. */
const DEFAULT_TERM_PROGRAM_VERSIONS: Record<string, string> = {
  "iterm.app": "3.6.6",
  wezterm: "20240203-110809-5046fc22",
  warpterminal: "v0.2024.11.12.08.02.stable_01",
  ghostty: "1.2.0",
  contour: "0.4.3",
  vscode: "1.95.0",
  alacritty: "0.24.2",
  mintty: "3.7.0",
  tabby: "1.0.215",
  kitty: "0.36.4",
  "xterm-ghostty": "1.2.0",
  foot: "1.19.0",
};

/** The names Claude's capability table contains, for the settings hint. */
export const KNOWN_TERM_PROGRAMS = [
  "iTerm.app", "WezTerm", "WarpTerminal", "ghostty", "contour", "vscode",
  "alacritty", "mintty", "Tabby", "kitty", "xterm-ghostty", "foot",
] as const;

/**
 * `KEY=VALUE` pairs for the advertised identity. Empty when `program` is blank,
 * so clearing the field genuinely advertises nothing rather than an empty
 * TERM_PROGRAM (which some programs treat as "a terminal called ''").
 */
export function termProgramEnvPairs(program: string, version?: string): string[] {
  const name = program.trim();
  if (!name) return [];
  const v = (version ?? "").trim() || DEFAULT_TERM_PROGRAM_VERSIONS[name.toLowerCase()] || "";
  const pairs = [`TERM_PROGRAM=${name}`];
  if (v) pairs.push(`TERM_PROGRAM_VERSION=${v}`);
  return pairs;
}

/** MADE_PANE_ID values are `term-<ms>-<n>` (generateTerminalId), but the id is
 *  embedded in shell/PS command strings, so strip anything outside the known
 *  alphabet defensively rather than trusting the format forever. */
function safePaneId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "");
}

export function claudeSessionIdArgs(
  type: TerminalType,
  resumeId?: string,
): { args: string[]; sessionId?: string } {
  if (type !== "claude" || resumeId) return { args: [] };
  const sessionId = crypto.randomUUID();
  return { args: ["--session-id", sessionId], sessionId };
}

export function getTerminalConfig(type: TerminalType, sessionResumeId?: string, extraArgs?: string[], wslCwd?: string, backend?: TerminalBackend, termProgram = "", termProgramVersion = "", psMode?: "wsl" | "windows", paneId?: string): TerminalConfig {
  // Advertised terminal identity (see termProgramEnvPairs). Only the AI CLIs
  // consult it; shell/devserver panes are left exactly as they were.
  const idEnv = type === "shell" || type === "devserver" ? [] : termProgramEnvPairs(termProgram, termProgramVersion);
  const idExport = idEnv.length ? `export ${idEnv.join(" ")}; ` : "";
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
      // psMode is only supplied for shell panes (WSL/WIN badge); dev servers
      // routed to the Windows backend always want plain PS at the project.
      const cwdArgs = buildPowerShellLaunchArgsForCwd(wslCwd, psMode ?? "windows");
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
    // Default "wsl": on the wsl backend the shell preloads WSL unless the
    // per-project badge override says otherwise. (Devserver never passes a
    // cwd on this branch — it spawns wsl.exe directly, not PowerShell.
    // Devserver panes are excluded from hibernation, so they go untagged.)
    const cwdArgs = buildPowerShellLaunchArgsForCwd(wslCwd, psMode ?? "wsl", type === "shell" ? paneId : undefined);
    return cwdArgs.length ? { ...base, args: cwdArgs } : base;
  }

  const resumeArgs = sessionResumeId && supportsSessionResume(type)
    ? getResumeFlag(type, sessionResumeId).split(" ")
    : [];
  const extra = extraArgs ?? [];

  const cachedPath = getCachedWslPath();
  const cliPath = getCachedCliPath(type);
  const distro = getCachedDistro();

  // An argument containing whitespace (the Jira ticket pane's positional first
  // prompt — a whole sentence) must NOT go through the fast path below: that
  // hands argv straight to wsl.exe, whose parser is exactly what the resume
  // comment says mangles multi-token args. The bash -lic path `sh()`-quotes
  // every argument, so the prompt survives as one word. Flag-shaped args, which
  // is everything else MADE passes, never trip this.
  const hasSpacedArg = extra.some((a) => /\s/.test(a));

  // When resuming a session, always use bash -lic (slow path).
  // wsl.exe -e /usr/bin/env passes --resume as separate args which can get
  // mangled by wsl.exe's argument parser. bash -lic wraps everything in a
  // single shell command string, matching manual `claude --resume <uuid>`.
  if (cachedPath && cliPath && resumeArgs.length === 0 && !hasSpacedArg) {
    // Fast path: skip bash entirely, use dash (sh) for env + exec.
    const distroArgs = distro ? ["-d", distro] : [];
    const envArgs = [
      `PATH=${cachedPath}`,
      "TERM=xterm-256color",
      "COLORTERM=truecolor",
      // Pane tagging (hibernation idle gate): /usr/bin/env plants it in the
      // Linux process env, so every descendant — claude, its subagents, their
      // tools — inherits it and the /proc sweep can attribute their CPU.
      ...(paneId ? [`MADE_PANE_ID=${safePaneId(paneId)}`] : []),
      ...idEnv,
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
    const paneExport = paneId ? ` MADE_PANE_ID=${safePaneId(paneId)}` : "";
    return {
      ...base,
      args: [...distroArgs, "--", "bash", "-lic", `export TERM=xterm-256color COLORTERM=truecolor${paneExport}; ${idExport}${cdPart}exec ${fullCmd}`],
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
export function getPooledInitCommand(type: TerminalType, wslCwd?: string, sessionResumeId?: string, extraArgs?: string[], backend?: TerminalBackend, paneId?: string): string | null {
  if (type === "shell") return null;
  if (backend === "windows") return null; // No WSL pool in Windows mode
  if (backend === "native") return null;  // No WSL pool on macOS/Linux

  const cachedPath = getCachedWslPath();
  const cliPath = getCachedCliPath(type);

  // Fast form needs both: pooled bash has no profile, so the CLI must be an
  // absolute path and PATH must be the cached login PATH (nvm shims need it).
  // When CLI resolution failed — resolvedPaths shipped {} on real hardware
  // (2026-07-30) and EVERY pane silently took the ~7s cold wsl.exe spawn —
  // fall back to exec-ing a LOGIN shell inside the already-warm pooled
  // session: same semantics as the cold path (profile PATH + aliases), minus
  // the wsl.exe session boot that makes the cold path slow. Only for the
  // CLIs whose binary name IS the terminal type; devserver's command is
  // composed elsewhere.
  const loginFallback = !cliPath && type !== "devserver";
  if (!loginFallback && (!cachedPath || !cliPath)) return null;

  const extraSuffix = extraArgs?.length ? ` ${extraArgs.map(sh).join(" ")}` : "";
  // getResumeFlag returns e.g. "--resume <uuid>" — split + quote each token.
  const resumeSuffix = sessionResumeId && supportsSessionResume(type)
    ? ` ${getResumeFlag(type, sessionResumeId).split(" ").map(sh).join(" ")}`
    : "";

  const parts: string[] = [];
  // In the fallback the login shell rebuilds PATH itself; exporting a stale
  // or missing cache over it would only hurt.
  if (!loginFallback) parts.push(`export PATH=${sh(cachedPath!)}`);
  parts.push("export TERM=xterm-256color COLORTERM=truecolor");
  // Pane tagging must ride the pooled path too — it is the COMMON path for
  // fresh AI panes, and the `--session-id` regression proved that a spawn
  // detail present only on the non-pooled path silently vanishes for most
  // panes (usePty.ts:150-156).
  if (paneId) parts.push(`export MADE_PANE_ID=${safePaneId(paneId)}`);
  if (wslCwd) {
    parts.push(`cd ${sh(wslCwd)}`);
  }

  // Clear the screen before exec so startup noise from Codex/Gemini is never visible.
  parts.push("printf '\\033[2J\\033[H'");
  if (loginFallback) {
    // Exported vars (TERM, MADE_PANE_ID) and the cd survive the exec into the
    // login shell. Double sh(): the inner command is one -c argument.
    parts.push(`exec bash -lic ${sh(`exec ${sh(type)}${extraSuffix}${resumeSuffix}`)}`);
  } else {
    parts.push(`exec ${sh(cliPath!)}${extraSuffix}${resumeSuffix}`);
  }

  return parts.join("; ");
}

/** Returns true if the terminal type runs inside WSL */
export function isWslTerminal(type: TerminalType, backend?: TerminalBackend): boolean {
  if (backend === "windows") return false;
  if (backend === "native") return false;
  return type !== "shell";
}

/** Clear + cursor home, the same sequence the local pooled path emits before
 *  its exec (getPooledInitCommand), so both spawn routes reach first paint
 *  looking identical. */
const CLEAR_SCREEN = `printf '\\033[2J\\033[H'`;

/** Map terminal type to the remote command to exec over SSH */
function getRemoteExecCommand(
  type: TerminalType,
  sessionResumeId?: string,
  extraCliArgs?: string[],
  execShell?: string,
): string {
  const resumeArgs = sessionResumeId && supportsSessionResume(type)
    ? getResumeFlag(type, sessionResumeId).split(" ")
    : [];
  // Extra CLI flags (e.g. `--name SUPPORT-24920` for Jira ticket panes) —
  // claude only; the other CLIs don't take them.
  const extraArgs = type === "claude" && extraCliArgs?.length ? extraCliArgs : [];

  const cliExec = (bin: string) => {
    const inner = [bin, ...resumeArgs, ...extraArgs].map(sh).join(" ");
    // Exec through an interactive login shell when detection knows which
    // shell's rc files put the CLI on PATH (`remote-cli-shells.ts`): the plain
    // remote command runs the login shell NON-interactively, so PATH entries
    // from .zshrc/.zprofile are missing and the bare CLI name fails even
    // though it works in a hand-typed SSH session.
    // Braces are load-bearing, not style: the caller emits `cd <dir> && <this>`,
    // and an ungrouped `printf …; exec …` would bind `&&` to the printf alone,
    // leaving the CLI to exec in the WRONG directory after a failed cd.
    if (!execShell) return `{ ${CLEAR_SCREEN}; exec ${inner}; }`;

    // …but sourcing /etc/zprofile + ~/.zshrc also prints whatever the user's
    // setup prints — version managers, greeters, update nags — and THAT is the
    // text that flashed in the pane for the ~0.5-1s before the CLI painted.
    //
    // Clearing afterwards is not enough: the bytes are still DISPLAYED first,
    // which is exactly the flash. So rc gets /dev/null for both streams, and
    // the real tty — dup'd to fds 9/8 by the outer shell — is restored inside
    // the -c command immediately before exec'ing the CLI. Those fds survive
    // the exec because POSIX only closes descriptors marked close-on-exec,
    // which an explicit `exec 9>&1` never sets; they are closed again in the
    // same redirection list so the CLI does not inherit strays.
    //
    // The login shell still RUNS, so everything ~/.zshrc exports reaches the
    // CLI and every command its Bash tool spawns — byte-identical to before.
    // The alternatives (exec an absolute CLI path with a probed PATH, or
    // replay a captured env) are faster but silently drop that environment,
    // and the replay variant would additionally copy secrets like GH_TOKEN
    // into MADE's persisted store and the remote argv, where `ps` shows them
    // to every other account on the box.
    //
    // Losing rc's stderr costs the diagnostic for a broken rc file. The far
    // commoner failure — the CLI itself missing — is reported by the shell
    // AFTER the restore, so `zsh:1: command not found: claude` still shows.
    // Verified under a real pty before shipping, along with `[ -t 1 ]` and
    // `[ -t 2 ]` still holding for the CLI.
    //
    // The brace group keeps the fd setup bound to the exec: the caller emits
    // `cd <dir> && <this>`, and without grouping `&&` would bind to the fd
    // setup alone, leaving the exec to run with fd 9 unopened after a failed
    // cd — a shell error instead of a pane.
    const quiet = `exec 1>&9 2>&8 9>&- 8>&-; ${CLEAR_SCREEN}; exec ${inner}`;
    return `{ exec 9>&1 8>&2; exec ${execShell} -lic ${sh(quiet)} >/dev/null 2>&1; }`;
  };

  switch (type) {
    case "claude":
      return cliExec("claude");
    case "codex":
      return cliExec("codex");
    case "gemini":
      return cliExec("gemini");
    case "shell":
      // Land the user in their actual login shell when known, not blindly bash.
      return `exec ${execShell ?? "bash"} -l`;
    case "devserver":
      return `exec ${execShell ?? "bash"} -l`;
  }
}

/**
 * Build SSH command + args for spawning a remote terminal.
 * Uses ssh.exe on Windows, ssh on macOS/Linux.
 */
export function getSshCommand(
  server: {
    username: string;
    host: string;
    authMethod: string;
    sshKeyPath?: string;
    claudeOauthToken?: string;
    claudeAuth?: string;
  },
  terminalType: TerminalType,
  remoteCwd?: string,
  sessionResumeId?: string,
  extraCliArgs?: string[],
  execShell?: string
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
  // …which makes the client print "Warning: Permanently added '<host>' to the
  // list of known hosts." into the pane on first connect. ERROR keeps genuine
  // failures (refused, permission denied) and drops that one-time warning —
  // the only ssh-client chatter that reaches a pane's first paint.
  args.push("-o", "LogLevel=ERROR");

  args.push(userHost);

  // Build the remote command: cd to dir (if specified) then exec the tool
  // BASH_SILENCE_DEPRECATION_WARNING suppresses macOS's "default shell is now zsh"
  // banner that /etc/bashrc prints on every interactive bash login.
  let envExport = "export TERM=xterm-256color COLORTERM=truecolor BASH_SILENCE_DEPRECATION_WARNING=1;";
  // Keep Claude Code logged in across SSH panes: the remote macOS Keychain is locked to
  // non-GUI SSH shells, so without this every new pane re-prompts for login. Preferred way
  // (claudeAuth "keychain", the default): unlock the login keychain in-session via the
  // preamble below — the keychain watcher in the PTY hooks answers its password sentinel.
  // Optional fallback (claudeAuth "token"): inject the long-lived OAuth token
  // (`claude setup-token`), bypassing the Keychain entirely. Either applies to every
  // terminal type so a manually launched `claude` in a shell pane also stays signed in.
  let preamble = "";
  if (server.claudeAuth === "token" && server.claudeOauthToken) {
    envExport += ` export CLAUDE_CODE_OAUTH_TOKEN=${sh(server.claudeOauthToken)};`;
  } else {
    preamble = ` ${getKeychainUnlockPreamble()}`;
  }
  const remoteCmd = getRemoteExecCommand(terminalType, sessionResumeId, extraCliArgs, execShell);
  if (remoteCwd) {
    args.push(`${envExport}${preamble} cd ${sh(remoteCwd)} && ${remoteCmd}`);
  } else {
    args.push(`${envExport}${preamble} ${remoteCmd}`);
  }

  return { command: isWindows() ? "ssh.exe" : "ssh", args };
}

/**
 * Build SSH command + args to run `claude setup-token` on a remote server.
 * Used by the token-setup wizard: it spawns this in a PTY, parses the OAuth URL,
 * feeds the browser code back, and captures the printed `sk-ant-oat…` token.
 * Deliberately does NOT inject CLAUDE_CODE_OAUTH_TOKEN (we're creating one).
 */
export function getClaudeSetupTokenCommand(
  server: { username: string; host: string; authMethod: string; sshKeyPath?: string },
  execShell?: string
): { command: string; args: string[] } {
  const userHost = `${server.username}@${server.host}`;
  const args: string[] = ["-t"];
  if (server.authMethod === "ssh-key" && server.sshKeyPath) {
    args.push("-i", server.sshKeyPath);
  }
  args.push("-o", "StrictHostKeyChecking=no");
  args.push(userHost);
  const envExport = "export TERM=xterm-256color COLORTERM=truecolor BASH_SILENCE_DEPRECATION_WARNING=1;";
  // Same non-interactive-PATH problem as getRemoteExecCommand — see there.
  const cmd = execShell ? `${execShell} -lic 'claude setup-token'` : "claude setup-token";
  args.push(`${envExport} ${cmd}`);
  return { command: isWindows() ? "ssh.exe" : "ssh", args };
}

/**
 * Build SSH command + args to append `publicKey` to the remote
 * `~/.ssh/authorized_keys`. Used by the key-setup wizard: it spawns this in a
 * hidden PTY, answers ssh's password prompt from a masked dialog, and waits
 * for the `__MADE_KEY_INSTALLED__` sentinel. The pubkey content travels as an
 * argument (no local pipe/shell), and `grep -qxF` makes retries idempotent —
 * re-running never duplicates authorized_keys lines.
 */
export function getSshInstallKeyCommand(
  server: { username: string; host: string },
  publicKey: string
): { command: string; args: string[] } {
  const userHost = `${server.username}@${server.host}`;
  const pub = sh(publicKey);
  const remote =
    `mkdir -p ~/.ssh && chmod 700 ~/.ssh && ` +
    `{ grep -qxF ${pub} ~/.ssh/authorized_keys 2>/dev/null || printf '%s\\n' ${pub} >> ~/.ssh/authorized_keys; } && ` +
    `chmod 600 ~/.ssh/authorized_keys && echo __MADE_KEY_INSTALLED__`;
  return {
    command: isWindows() ? "ssh.exe" : "ssh",
    args: [
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ConnectTimeout=10",
      "-o", "NumberOfPasswordPrompts=3",
      // Deterministic wizard flow: go straight to the server password instead
      // of trying local keys first (a passphrase-protected default key would
      // otherwise hijack the prompt with "Enter passphrase for key …").
      "-o", "PreferredAuthentications=password,keyboard-interactive",
      userHost,
      remote,
    ],
  };
}
