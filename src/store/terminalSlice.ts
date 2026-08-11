import type { StateCreator } from "zustand";
import type { TerminalInstance, TerminalType, DevServer, TerminalBackend } from "../types";
import { clearTerminalActivity } from "../lib/terminal-activity";
import { cachedHomeDir, isJiraVirtualDir, jiraFsCwd } from "../lib/jira-virtual-dir";

// PTY write callbacks — runtime only, not persisted.
// Stored outside Zustand to avoid unnecessary re-renders.
const ptyWriteCallbacks: Record<string, (text: string) => void> = {};

export function registerPtyWrite(terminalId: string, writeFn: (text: string) => void): void {
  ptyWriteCallbacks[terminalId] = writeFn;
}

export function unregisterPtyWrite(terminalId: string): void {
  delete ptyWriteCallbacks[terminalId];
}

export function getPtyWrite(terminalId: string): ((text: string) => void) | undefined {
  return ptyWriteCallbacks[terminalId];
}

export function getAllPtyWriteTerminalIds(): string[] {
  return Object.keys(ptyWriteCallbacks);
}

// Terminal focus callbacks — runtime only, not persisted.
// Lets non-pane code (e.g. clipboard-insert) programmatically focus the xterm after writing.
const terminalFocusCallbacks: Record<string, () => void> = {};

export function registerTerminalFocus(terminalId: string, focusFn: () => void): void {
  terminalFocusCallbacks[terminalId] = focusFn;
}

export function unregisterTerminalFocus(terminalId: string): void {
  delete terminalFocusCallbacks[terminalId];
}

export function getTerminalFocus(terminalId: string): (() => void) | undefined {
  return terminalFocusCallbacks[terminalId];
}

// Terminal data listeners — called when PTY output arrives.
// Used by DevServerTerminalHost for port detection.
const terminalDataListeners: Record<string, (data: Uint8Array) => void> = {};

/* ---- Retained backlog (fixes the port-detection startup race) -------------
 *
 * A pane forwards PTY output with `getTerminalDataListener(id)?.(data)`, so any
 * output produced BEFORE a consumer attached was dropped on the floor. Dev-server
 * port detection scrapes exactly one line ("Local: http://localhost:3000"), which
 * a fast server prints during the window between the PTY spawning and
 * DevServerTerminalHost's effect registering — hence the intermittent
 * "detecting..." forever on startup.
 *
 * Output is therefore RETAINED for terminals that are known to be expecting a
 * consumer, and replayed the moment one registers. Retention is armed by
 * `addDevServer`, which necessarily runs before the dev server's terminal exists,
 * so there is no window left to lose.
 *
 * Only armed terminals retain anything: the AI/shell panes stream far more data
 * and have no consumer, so buffering them would be pure waste. The backlog is
 * byte-capped as well, because a server that never prints a port must not grow a
 * buffer forever. */
const RETAIN_MAX_BYTES = 64 * 1024;

interface Backlog {
  chunks: Uint8Array[];
  bytes: number;
}
const retained = new Map<string, Backlog>();

/** Start retaining PTY output for a terminal that will get a consumer shortly. */
export function armTerminalDataRetention(terminalId: string): void {
  if (!retained.has(terminalId)) {
    retained.set(terminalId, { chunks: [], bytes: 0 });
  }
}

/** Stop retaining and discard any backlog (dev server removed). */
export function disarmTerminalDataRetention(terminalId: string): void {
  retained.delete(terminalId);
}

function retain(terminalId: string, data: Uint8Array): void {
  const backlog = retained.get(terminalId);
  // Not armed = not a terminal anyone is waiting on. Drop, as before.
  if (!backlog) return;
  backlog.chunks.push(data);
  backlog.bytes += data.byteLength;
  // Trim oldest first; the port line appears early, but a lock error or a
  // late-bound port can appear after a lot of noise, so keep the cap generous.
  while (backlog.bytes > RETAIN_MAX_BYTES && backlog.chunks.length > 1) {
    const dropped = backlog.chunks.shift();
    if (dropped) backlog.bytes -= dropped.byteLength;
  }
}

export function registerTerminalDataListener(terminalId: string, cb: (data: Uint8Array) => void): void {
  terminalDataListeners[terminalId] = cb;
  // Replay whatever arrived before this consumer existed. The backlog is cleared
  // but retention stays ARMED: the dev-server host unregisters after detection
  // and re-registers a stopped-detection listener, and that second gap needs the
  // same protection.
  const backlog = retained.get(terminalId);
  if (backlog && backlog.chunks.length > 0) {
    const chunks = backlog.chunks;
    backlog.chunks = [];
    backlog.bytes = 0;
    for (const chunk of chunks) {
      // One bad consumer must not swallow the rest of the replay.
      try {
        cb(chunk);
      } catch {
        /* ignore */
      }
    }
  }
}

export function unregisterTerminalDataListener(terminalId: string): void {
  delete terminalDataListeners[terminalId];
}

/** Returns a sink for a terminal's PTY output.
 *
 *  Never undefined: with no consumer attached this is a retaining sink for armed
 *  terminals and a no-op for everything else, so callers keep using
 *  `getTerminalDataListener(id)?.(data)` unchanged. */
export function getTerminalDataListener(terminalId: string): ((data: Uint8Array) => void) | undefined {
  const cb = terminalDataListeners[terminalId];
  if (cb) return cb;
  if (retained.has(terminalId)) {
    return (data: Uint8Array) => retain(terminalId, data);
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/*  Pending first prompts (Jira tickets)                               */
/* ------------------------------------------------------------------ */

/**
 * A prompt to hand the CLI as its positional argument the next time a specific
 * terminal spawns. Set just before the pane is created, consumed once by the
 * spawn.
 *
 * A module registry rather than store state, matching the listener registries
 * above: nothing renders from it, and — the point — it can never be persisted.
 * A prompt that survived into a restored layout would re-run the investigation
 * every time MADE restarts.
 */
const pendingPrompts = new Map<string, string>();

export function setPendingPrompt(terminalId: string, prompt: string): void {
  pendingPrompts.set(terminalId, prompt);
}

/** Read-and-delete: a prompt fires on the first spawn and never on a restart. */
export function takePendingPrompt(terminalId: string): string | undefined {
  const prompt = pendingPrompts.get(terminalId);
  if (prompt !== undefined) pendingPrompts.delete(terminalId);
  return prompt;
}

/** Drop a prompt whose pane never spawned (creation aborted mid-flight). */
export function clearPendingPrompt(terminalId: string): void {
  pendingPrompts.delete(terminalId);
}

export interface TerminalSlice {
  terminals: Record<string, TerminalInstance>;
  devServers: DevServer[];
  expandedDevServerId: string | null;
  addTerminal: (id: string, type: TerminalType, workingDir: string, serverId?: string) => void;
  addTerminals: (batch: Array<{ id: string; type: TerminalType; workingDir: string; serverId?: string }>) => void;
  removeTerminal: (id: string) => void;
  /** Batch removal (tab hibernation): one store update for N panes. */
  removeTerminals: (ids: string[]) => void;
  changeTerminalType: (id: string, newType: TerminalType) => void;
  setTerminalPid: (id: string, pid: number) => void;
  setActiveTerminal: (id: string) => void;
  /** True while a NON-terminal pane (browser, editor, kanban, …) is the one
   *  the user last engaged. `activeTerminal` is never cleared, so without
   *  this bit terminal cursors keep their solid focused look while the user
   *  types in a browser pane. Set by the app-wide mousedown delegate +
   *  BrowserPreview's made-focus; cleared by handleTerminalFocus. */
  nonTerminalPaneActive: boolean;
  setNonTerminalPaneActive: (value: boolean) => void;
  addDevServer: (server: DevServer) => void;
  removeDevServer: (serverId: string) => void;
  updateDevServerStatus: (
    serverId: string,
    status: DevServer["status"]
  ) => void;
  updateDevServerCommand: (serverId: string, command: string) => void;
  updateDevServerPort: (serverId: string, port: number) => void;
  /** `conflictPort` is the port a "port already in use" failure named — it is
   *  what makes the row's banner actionable, and it is cleared with the message. */
  updateDevServerError: (
    serverId: string,
    errorMessage: string | undefined,
    conflictPort?: number,
  ) => void;
  setDevServerNetworkUrls: (serverId: string, urls: string[]) => void;
  setDevServerBackend: (serverId: string, backend: TerminalBackend) => void;
  setDevServerStalled: (serverId: string, stalledSince: number | undefined) => void;
  setExpandedDevServerId: (id: string | null) => void;
}

/** A dev server is "running" ONLY once its port is known.
 *
 *  Enforced HERE, not at the call sites, because trusting call sites is exactly
 *  what failed: the status setter was fixed to only go green alongside the port,
 *  but `spawn-dev-server.ts` built the object with `status: "running"` and
 *  `port: 0` directly, so the auto-start path still painted a green dot next to
 *  "detecting..." — a state the UI cannot explain and the browser pane treats as
 *  not-ready (`status === "running" && port > 0`).
 *
 *  Coercing here makes that combination unrepresentable no matter who writes it.
 *  A server whose port is never scraped now stays "starting", which is the honest
 *  reading: the process may well be up, but MADE does not know where it is. */
function withPortConsistentStatus(
  status: DevServer["status"],
  port: number
): DevServer["status"] {
  return status === "running" && !(port > 0) ? "starting" : status;
}

/**
 * The directory a terminal actually spawns in. Keyed Jira projects carry a
 * virtual `jira://…` workingDir that must never reach a PTY; translate it to
 * the projects dir (or home) HERE, the single funnel every terminal creator
 * goes through — ticket open, boot restore, splits, hibernation wake, voice.
 * The tab keeps the virtual dir; only the terminal record gets the real one.
 */
function toSpawnDir(workingDir: string, get: () => TerminalSlice): string {
  if (!isJiraVirtualDir(workingDir)) return workingDir;
  const projectsDir =
    ((get() as unknown as { projectsDir?: string }).projectsDir ?? "").trim();
  return jiraFsCwd(workingDir, projectsDir || cachedHomeDir());
}

export const createTerminalSlice: StateCreator<
  TerminalSlice,
  [],
  [],
  TerminalSlice
> = (set, get) => ({
  terminals: {},
  devServers: [],
  expandedDevServerId: null,

  addTerminal: (id, type, workingDir, serverId?) => {
    const fsDir = toSpawnDir(workingDir, get);
    set((state) => ({
      terminals: {
        ...state.terminals,
        [id]: { id, type, workingDir: fsDir, isActive: false, serverId },
      },
    }));
  },

  addTerminals: (batch) => {
    set((state) => {
      const newTerminals = { ...state.terminals };
      for (const { id, type, workingDir, serverId } of batch) {
        newTerminals[id] = { id, type, workingDir: toSpawnDir(workingDir, get), isActive: false, serverId };
      }
      return { terminals: newTerminals };
    });
  },

  removeTerminal: (id) => {
    clearTerminalActivity(id);
    unregisterPtyWrite(id);
    set((state) => {
      const { [id]: _, ...rest } = state.terminals;
      return {
        terminals: rest,
        devServers: state.devServers.filter((ds) => ds.terminalId !== id),
      };
    });
  },

  removeTerminals: (ids) => {
    if (ids.length === 0) return;
    for (const id of ids) {
      clearTerminalActivity(id);
      unregisterPtyWrite(id);
    }
    const drop = new Set(ids);
    set((state) => {
      const terminals = { ...state.terminals };
      for (const id of ids) delete terminals[id];
      return {
        terminals,
        devServers: state.devServers.filter((ds) => !drop.has(ds.terminalId)),
      };
    });
  },

  changeTerminalType: (id, newType) => {
    set((state) => {
      const existing = state.terminals[id];
      if (!existing) return state;
      return {
        terminals: {
          ...state.terminals,
          [id]: { ...existing, type: newType },
        },
      };
    });
  },

  setTerminalPid: (id, pid) => {
    set((state) => ({
      terminals: {
        ...state.terminals,
        [id]: { ...state.terminals[id], pid },
      },
    }));
  },

  setActiveTerminal: (id) => {
    set((state) => {
      const terminals: Record<string, TerminalInstance> = {};
      for (const [key, term] of Object.entries(state.terminals)) {
        terminals[key] = { ...term, isActive: key === id };
      }
      return { terminals };
    });
  },

  nonTerminalPaneActive: false,
  setNonTerminalPaneActive: (value) =>
    set((state) => (state.nonTerminalPaneActive === value ? state : { nonTerminalPaneActive: value })),

  addDevServer: (server) => {
    // Arm retention BEFORE the terminal can produce a byte. This runs when the
    // dev-server row is created, which always precedes its terminal existing, so
    // the port line cannot be missed however fast the server starts.
    armTerminalDataRetention(server.terminalId);
    const normalized: DevServer = {
      ...server,
      status: withPortConsistentStatus(server.status, server.port),
    };
    set((state) => ({
      devServers: [...state.devServers, normalized],
    }));
  },

  removeDevServer: (serverId) => {
    const gone = get().devServers.find((ds: DevServer) => ds.id === serverId);
    if (gone) disarmTerminalDataRetention(gone.terminalId);
    set((state) => ({
      devServers: state.devServers.filter((ds) => ds.id !== serverId),
    }));
  },

  updateDevServerStatus: (serverId, status) => {
    set((state) => ({
      devServers: state.devServers.map((ds) =>
        ds.id === serverId
          ? { ...ds, status: withPortConsistentStatus(status, ds.port) }
          : ds
      ),
    }));
  },

  updateDevServerCommand: (serverId, command) => {
    set((state) => ({
      devServers: state.devServers.map((ds) =>
        ds.id === serverId ? { ...ds, command } : ds
      ),
    }));
  },

  updateDevServerPort: (serverId, port) => {
    set((state) => ({
      devServers: state.devServers.map((ds) =>
        ds.id === serverId ? { ...ds, port } : ds
      ),
    }));
  },

  // `conflictPort` rides along with the message rather than getting its own
  // setter: it only ever means "the port THIS error is about", so writing it
  // separately would allow a stale port to outlive the failure that named it and
  // offer the user a "Kill 6180" button for a conflict that is long gone.
  // Clearing the message clears it too.
  updateDevServerError: (serverId, errorMessage, conflictPort) => {
    set((state) => ({
      devServers: state.devServers.map((ds) =>
        ds.id === serverId
          ? {
              ...ds,
              errorMessage,
              conflictPort: errorMessage ? conflictPort : undefined,
              status: errorMessage ? "error" : ds.status,
            }
          : ds
      ),
    }));
  },

  setDevServerNetworkUrls: (serverId, urls) => {
    set((state) => ({
      devServers: state.devServers.map((ds) => {
        if (ds.id !== serverId) return ds;
        const prev = ds.networkUrls ?? [];
        if (prev.length === urls.length && prev.every((u, i) => u === urls[i])) return ds;
        return { ...ds, networkUrls: urls };
      }),
    }));
  },

  setDevServerBackend: (serverId, backend) => {
    set((state) => ({
      devServers: state.devServers.map((ds) =>
        ds.id === serverId ? { ...ds, backend } : ds
      ),
    }));
  },

  setDevServerStalled: (serverId, stalledSince) => {
    set((state) => {
      const ds = state.devServers.find((d) => d.id === serverId);
      // No-op when already in the requested state — the stall sweep runs on an
      // interval and the clear runs on every PTY chunk, so most calls are.
      if (!ds || ds.stalledSince === stalledSince) return state;
      return {
        devServers: state.devServers.map((d) =>
          d.id === serverId ? { ...d, stalledSince } : d
        ),
      };
    });
  },

  setExpandedDevServerId: (id) => {
    set({ expandedDevServerId: id });
  },
});
