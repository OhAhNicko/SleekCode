import type { StateCreator } from "zustand";
import type { TerminalInstance, TerminalType, DevServer } from "../types";
import { clearTerminalActivity } from "../lib/terminal-activity";

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

export function registerTerminalDataListener(terminalId: string, cb: (data: Uint8Array) => void): void {
  terminalDataListeners[terminalId] = cb;
}

export function unregisterTerminalDataListener(terminalId: string): void {
  delete terminalDataListeners[terminalId];
}

export function getTerminalDataListener(terminalId: string): ((data: Uint8Array) => void) | undefined {
  return terminalDataListeners[terminalId];
}

export interface TerminalSlice {
  terminals: Record<string, TerminalInstance>;
  devServers: DevServer[];
  expandedDevServerId: string | null;
  addTerminal: (id: string, type: TerminalType, workingDir: string, serverId?: string) => void;
  addTerminals: (batch: Array<{ id: string; type: TerminalType; workingDir: string; serverId?: string }>) => void;
  removeTerminal: (id: string) => void;
  changeTerminalType: (id: string, newType: TerminalType) => void;
  setTerminalPid: (id: string, pid: number) => void;
  setActiveTerminal: (id: string) => void;
  addDevServer: (server: DevServer) => void;
  removeDevServer: (serverId: string) => void;
  updateDevServerStatus: (
    serverId: string,
    status: DevServer["status"]
  ) => void;
  updateDevServerCommand: (serverId: string, command: string) => void;
  updateDevServerPort: (serverId: string, port: number) => void;
  updateDevServerError: (serverId: string, errorMessage: string | undefined) => void;
  setDevServerNetworkUrls: (serverId: string, urls: string[]) => void;
  setExpandedDevServerId: (id: string | null) => void;
}

export const createTerminalSlice: StateCreator<
  TerminalSlice,
  [],
  [],
  TerminalSlice
> = (set) => ({
  terminals: {},
  devServers: [],
  expandedDevServerId: null,

  addTerminal: (id, type, workingDir, serverId?) => {
    set((state) => ({
      terminals: {
        ...state.terminals,
        [id]: { id, type, workingDir, isActive: false, serverId },
      },
    }));
  },

  addTerminals: (batch) => {
    set((state) => {
      const newTerminals = { ...state.terminals };
      for (const { id, type, workingDir, serverId } of batch) {
        newTerminals[id] = { id, type, workingDir, isActive: false, serverId };
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

  addDevServer: (server) => {
    set((state) => ({
      devServers: [...state.devServers, server],
    }));
  },

  removeDevServer: (serverId) => {
    set((state) => ({
      devServers: state.devServers.filter((ds) => ds.id !== serverId),
    }));
  },

  updateDevServerStatus: (serverId, status) => {
    set((state) => ({
      devServers: state.devServers.map((ds) =>
        ds.id === serverId ? { ...ds, status } : ds
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

  updateDevServerError: (serverId, errorMessage) => {
    set((state) => ({
      devServers: state.devServers.map((ds) =>
        ds.id === serverId ? { ...ds, errorMessage, status: errorMessage ? "error" : ds.status } : ds
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

  setExpandedDevServerId: (id) => {
    set({ expandedDevServerId: id });
  },
});
