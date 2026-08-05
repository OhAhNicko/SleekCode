/**
 * Install an AI CLI on the backend a pane is going to use, streaming the
 * installer's output back live.
 *
 * The commands live here AND in `src-tauri/src/cli_install.rs`, deliberately:
 * Rust runs them, this copy is what the UI shows the user BEFORE they press
 * Install. Showing the exact command first is what makes a one-click
 * `curl … | bash` informed consent rather than a surprise. The two lists have
 * a test on each side; if you change one, change the other.
 *
 * Claude has a two-rung ladder (native installer, then npm) because its native
 * installer needs no Node — the likeliest thing to be missing on a remote box.
 * Codex and Gemini ship only on npm, so they have nothing to fall back to.
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import type { RemoteServer, TerminalBackend } from "../types";
import { type AiCli, cliTarget, invalidateCliStatus } from "./cli-availability";
import { clearWslCliCache, resolveWslCliPaths } from "./wsl-cache";
import { resolveWindowsCliPaths } from "./windows-cli-cache";
import { resolveNativeCliPaths } from "./macos-cli-cache";
import { detectRemoteCliShells } from "./remote-cli-shells";

const NPM_PACKAGE: Record<AiCli, string> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  gemini: "@google/gemini-cli",
};

/**
 * What MADE will run, in ladder order — rung 2 only runs if rung 1 fails.
 * Mirrors `unix_ladder` / `windows_ladder` in cli_install.rs.
 */
export function installCommands(cli: AiCli, backend: TerminalBackend): string[] {
  const npm = `npm install -g ${NPM_PACKAGE[cli]}`;
  if (cli !== "claude") return [npm];
  return backend === "windows"
    ? ["irm https://claude.ai/install.ps1 | iex", npm]
    : ["curl -fsSL https://claude.ai/install.sh | bash", npm];
}

/** Exit code the backend reports when the user cancelled. */
export const EXIT_CANCELLED = 130;

export interface CliInstallRun {
  /** Backend-side id — pass to `cancelCliInstall`. */
  id: number;
}

/**
 * Start an install. Resolves as soon as the backend has accepted the job;
 * `onLine` then streams stdout+stderr and `onExit` fires once with the final
 * code (0 = installed, EXIT_CANCELLED = stopped, anything else = failed).
 *
 * Rejects only when the request itself is malformed — an unreachable host or a
 * missing npm shows up as output plus a non-zero exit, not as a throw.
 */
export async function startCliInstall(opts: {
  cli: AiCli;
  backend: TerminalBackend;
  server?: RemoteServer | null;
  onLine: (line: string) => void;
  onExit: (code: number) => void;
}): Promise<CliInstallRun> {
  const onLine = new Channel<string>();
  onLine.onmessage = (line) => opts.onLine(line);
  const onExit = new Channel<number>();
  onExit.onmessage = (code) => opts.onExit(code);

  const id = await invoke<number>("cli_install_start", {
    cli: opts.cli,
    ...cliTarget(opts.backend, opts.server),
    onLine,
    onExit,
  });
  return { id };
}

/** Stop a running install. Safe to call after it has already finished. */
export function cancelCliInstall(id: number): Promise<void> {
  return invoke<void>("cli_install_cancel", { id }).catch(() => {});
}

/**
 * Re-resolve everything that caches "where is this CLI" after an install, so
 * the pane that follows takes the fast absolute-path spawn instead of the
 * login-shell fallback.
 *
 * On native Windows this cannot fully succeed: the installer updates the user's
 * PATH in the registry, but MADE (and therefore `where.exe`) inherited its
 * environment at launch. The caller checks the returned status and tells the
 * user to restart rather than offering a Launch button that would fail.
 */
export async function refreshAfterInstall(
  cli: AiCli,
  backend: TerminalBackend,
  server?: RemoteServer | null,
): Promise<void> {
  invalidateCliStatus(cli, backend, server);
  try {
    if (backend === "wsl") {
      clearWslCliCache();
      await resolveWslCliPaths();
    } else if (backend === "windows") {
      await resolveWindowsCliPaths();
    } else if (backend === "native") {
      await resolveNativeCliPaths();
    } else if (server) {
      await detectRemoteCliShells(server);
    }
  } catch {
    // A failed refresh is not a failed install — the status probe below is the
    // authority, and the spawn path still has its login-shell fallback.
  }
}
