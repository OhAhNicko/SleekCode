import type { StateCreator } from "zustand";
import type { TerminalInstance, TerminalType, DevServer } from "../types";

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

export interface TerminalSlice {
  terminals: Record<string, TerminalInstance>;
  devServers: DevServer[];
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
}

export const createTerminalSlice: StateCreator<
  TerminalSlice,
  [],
  [],
  TerminalSlice
> = (set) => ({
  terminals: {},
  devServers: [],

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
});
