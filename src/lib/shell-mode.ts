import { useAppStore } from "../store";
import type { TerminalBackend } from "../types";

export type ShellPsMode = "wsl" | "windows";

/**
 * Resolve which mode a SHELL pane's PowerShell should launch in on a Windows
 * host — the single source of truth shared by the spawn path (usePty /
 * usePtyNative) and the header's WSL/WIN badge, so what the badge shows is
 * always what the next spawn does.
 *
 *  1. Per-project override (`RecentProject.shellInWindows`, set by the badge).
 *  2. Otherwise follow the pane's backend: wsl-backed projects (which includes
 *     `/mnt/<drive>/…` via detectBackendForPath) get the WSL preload —
 *     PowerShell that immediately drops into bash at the project — restoring
 *     the pre-v0.1.40 behavior that the path-shape-only routing lost.
 */
export function shellPsModeFor(
  workingDir: string | undefined,
  serverId: string | undefined,
  backend: TerminalBackend | undefined,
): ShellPsMode {
  const state = useAppStore.getState();
  if (workingDir) {
    const norm = (p: string) => p.replace(/\\/g, "/");
    const proj = state.recentProjects.find(
      (p) => norm(p.path) === norm(workingDir) && p.serverId === serverId,
    );
    if (proj?.shellInWindows !== undefined) {
      return proj.shellInWindows ? "windows" : "wsl";
    }
  }
  const b = backend ?? state.terminalBackend ?? "wsl";
  return b === "windows" ? "windows" : "wsl";
}
