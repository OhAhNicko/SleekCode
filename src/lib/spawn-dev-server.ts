import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { generateTerminalId } from "./layout-utils";
import { getDefaultBackend, getPlatform } from "./platform";
import type { DevServer, TerminalBackend } from "../types";

/** Path comparison for project identity — Windows and POSIX slashes are the same project. */
const normPath = (p: string) => p.replace(/\\/g, "/");

/** True when a dev server belongs to this project, i.e. same directory on the same host. */
export function isSameProject(
  ds: Pick<DevServer, "workingDir" | "serverId">,
  workingDir: string,
  serverId?: string,
): boolean {
  return normPath(ds.workingDir) === normPath(workingDir) && ds.serverId === serverId;
}

/**
 * Persist a project's dev-server commands, recomputed from its LIVE rows.
 *
 * A project can hold several dev servers, so "save the command" is no longer a
 * single-field write. Deriving the whole list from the rows on every add / edit
 * / remove — rather than patching the slot a row thinks it owns — is what makes
 * removal safe: there is no index to go stale, and the persisted list can never
 * name a server that isn't there.
 */
export function syncProjectServerCommands(workingDir: string, serverId?: string): void {
  const state = useAppStore.getState();
  const commands = state.devServers
    .filter((ds) => isSameProject(ds, workingDir, serverId))
    .map((ds) => ds.command);
  state.setProjectServerCommands(workingDir, serverId, commands);
}

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

  const project = state.recentProjects.find(
    (p) => normPath(p.path) === normPath(workingDir) && p.serverId === serverId,
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

export interface CreateDevServerOptions {
  /** Owning tab, or "" for a server created straight from the panel. */
  tabId: string;
  projectName: string;
  workingDir: string;
  command: string;
  serverId?: string;
  /**
   * Write the project's command list back to `recentProjects`. Boot restore
   * passes `false`: it is already iterating that list, and syncing mid-loop
   * would rewrite it from the rows created SO FAR — truncating the user's
   * extra servers if a later spawn in the same loop throws.
   */
  persist?: boolean;
}

/**
 * The one place a `DevServer` is born.
 *
 * Every field here has cost someone a debugging session: `status: "starting"`
 * rather than "running" (a green dot next to "detecting..." — 2026-07-27), and
 * the backend resolution below, which the panel's create path once omitted and
 * shipped a permanently black pane (2026-08-01). Three call sites drifting
 * apart is what caused both, so they now share this function.
 */
export function createDevServer({
  tabId,
  projectName,
  workingDir,
  command,
  serverId,
  persist = true,
}: CreateDevServerOptions): string {
  const store = useAppStore.getState();
  // Dedupe on (path, host, COMMAND). A project may legitimately run several
  // dev servers — web + Tauri, app + API, a second instance on another port —
  // but the same command twice is always an accident, and boot restore relies
  // on that staying true to be idempotent.
  const existing = store.devServers.find(
    (ds) => isSameProject(ds, workingDir, serverId) && ds.command === command,
  );
  if (existing) return existing.terminalId;

  const terminalId = generateTerminalId();
  const devServerId = `ds-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  store.addTerminal(terminalId, "devserver", workingDir, serverId);
  store.addDevServer({
    id: devServerId,
    terminalId,
    tabId,
    projectName,
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
  // Stamp the tab with the project's PRIMARY (first-row) command, not with
  // whichever command was just added. A tab holds one command — it is what
  // boot restore falls back to when recentProjects has nothing — so letting
  // the newest server win would quietly re-point it at the second server.
  if (tabId) {
    const primary =
      useAppStore
        .getState()
        .devServers.find((ds) => isSameProject(ds, workingDir, serverId))?.command ?? command;
    useAppStore.setState((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId ? { ...t, serverCommand: primary } : t,
      ),
    }));
  }
  // Persist the project's commands so they survive restart (create-flow,
  // quick-open and boot-restore all funnel through here).
  if (persist) syncProjectServerCommands(workingDir, serverId);

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

/**
 * Positional wrapper kept for the tab-centric callers (quick-open, project
 * create, boot restore). New code should prefer `createDevServer`.
 */
export function spawnDevServer(
  tabId: string,
  tabName: string,
  workingDir: string,
  command: string,
  serverId?: string,
  persist = true,
): string {
  return createDevServer({
    tabId,
    projectName: tabName,
    workingDir,
    command,
    serverId,
    persist,
  });
}
