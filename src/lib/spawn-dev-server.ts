import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { generateTerminalId } from "./layout-utils";
import { getDefaultBackend, getPlatform } from "./platform";
import type { TerminalBackend } from "../types";

/**
 * `is_tauri_project` is three filesystem stats — it answers in microseconds or
 * it is never going to. Racing it against a deadline is what separates
 * "auto-detect failed, use the global backend" from a dev server that never
 * spawns at all: this function's result is the ONLY thing that sets
 * `DevServer.backend`, and until that is set the pane is not rendered, no PTY
 * exists, no command is sent, and the sidebar row sits on "detecting..."
 * forever with nothing to explain it.
 */
const TAURI_DETECT_TIMEOUT_MS = 3000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

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
    const isTauri = await withTimeout(
      invoke<boolean>("is_tauri_project", { directory: workingDir }),
      TAURI_DETECT_TIMEOUT_MS,
      "is_tauri_project",
    );
    if (isTauri) return "windows";
  } catch (e) {
    // Detection failed (command missing, unreadable dir, IPC never answered) —
    // fall back to global. Logged rather than swallowed: a silent failure here
    // used to be indistinguishable from a correct "not a Tauri project".
    console.warn(
      `[DevServer] Tauri detection failed for ${workingDir} — using "${globalBackend}"`,
      e,
    );
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
    // "starting", NOT "running". A dev server is created with port 0 and the
    // port is only known once its output is scraped, so being born "running"
    // painted the sidebar dot green immediately and left it green next to
    // "detecting..." — the contradiction reported on 2026-07-27, with all four
    // auto-started servers green and none of them reachable. The sibling
    // creation site (DevServerTab.tsx) already used "starting"; this one is why
    // the STARTUP path in particular looked wrong, since auto-start comes
    // through here. Green now means the port was actually found.
    status: "starting",
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
  resolveDevServerBackend(workingDir, serverId)
    .then((backend) => {
      useAppStore.getState().setDevServerBackend(devServerId, backend);
    })
    .catch(() => {
      // backend === undefined keeps the pane unmounted forever (no PTY, no
      // command, "detecting..." with an empty terminal) — never leave it there.
      const fallback = useAppStore.getState().terminalBackend ?? getDefaultBackend();
      useAppStore.getState().setDevServerBackend(devServerId, fallback);
    });

  return terminalId;
}
