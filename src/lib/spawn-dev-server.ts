import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { generateTerminalId } from "./layout-utils";
import { getDefaultBackend, getPlatform } from "./platform";
import type { TerminalBackend } from "../types";

/**
 * Decide which shell a dev server's PTY should spawn in.
 *
 *  - SSH/remote (serverId) → backend is irrelevant (the SSH spawn path takes
 *    over in usePty), so just return the global backend.
 *  - Non-Windows host → there's no WSL/Windows split; return the global backend
 *    (native on macOS/Linux).
 *  - A per-project override (`serverInWindows`) wins: true → "windows",
 *    false → "wsl".
 *  - Otherwise auto-detect: Tauri projects route to "windows" so
 *    `npm run tauri:dev` runs against the Windows MSVC toolchain instead of
 *    failing inside WSL bash with "Cannot find native binding".
 */
export async function resolveDevServerBackend(
  workingDir: string,
  serverId: string | undefined,
): Promise<TerminalBackend> {
  const state = useAppStore.getState();
  const globalBackend: TerminalBackend = state.terminalBackend ?? getDefaultBackend();
  if (serverId) return globalBackend;
  if (getPlatform() !== "windows") return globalBackend;

  const norm = (p: string) => p.replace(/\\/g, "/");
  const project = state.recentProjects.find(
    (p) => norm(p.path) === norm(workingDir) && p.serverId === serverId,
  );
  const override = project?.serverInWindows;
  if (override === true) return "windows";
  if (override === false) return "wsl";

  try {
    const isTauri = await invoke<boolean>("is_tauri_project", { directory: workingDir });
    if (isTauri) return "windows";
  } catch {
    // Detection failed (command missing, unreadable dir) — fall back to global.
  }
  return globalBackend;
}

export function spawnDevServer(
  tabId: string,
  tabName: string,
  workingDir: string,
  command: string,
  serverId?: string,
): string {
  const store = useAppStore.getState();
  const norm = (p: string) => p.replace(/\\/g, "/");
  const existing = store.devServers.find(
    (ds) => norm(ds.workingDir) === norm(workingDir) && ds.serverId === serverId,
  );
  if (existing) return existing.terminalId;

  const terminalId = generateTerminalId();
  const devServerId = `ds-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  store.addTerminal(terminalId, "devserver", workingDir, serverId);
  store.addDevServer({
    id: devServerId,
    terminalId,
    tabId,
    projectName: tabName,
    command,
    workingDir,
    port: 0,
    status: "running",
    serverId,
    // backend left undefined → DevServerTerminalHost waits to resolve it before
    // mounting the pane, so we never spawn a throwaway WSL shell first.
  });
  useAppStore.setState((state) => ({
    tabs: state.tabs.map((t) =>
      t.id === tabId ? { ...t, serverCommand: command } : t,
    ),
  }));
  // Persist the command onto the project so it survives restart (create-flow,
  // quick-open and boot-restore all funnel through here).
  store.updateProjectServerCommand(workingDir, command, serverId);

  // Resolve the spawn backend (project override → Tauri auto-detect → global),
  // then publish it so the pane mounts in the correct shell.
  resolveDevServerBackend(workingDir, serverId).then((backend) => {
    useAppStore.getState().setDevServerBackend(devServerId, backend);
  });

  return terminalId;
}
