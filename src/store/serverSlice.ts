import type { StateCreator } from "zustand";
import type { RemoteServer } from "../types";

export interface ServerSlice {
  servers: RemoteServer[];
  addServer: (server: RemoteServer) => void;
  updateServer: (id: string, updates: Partial<RemoteServer>) => void;
  removeServer: (id: string) => void;
}

export const createServerSlice: StateCreator<
  ServerSlice,
  [],
  [],
  ServerSlice
> = (set) => ({
  servers: [],

  addServer: (server) => {
    set((state) => ({
      servers: [...state.servers, server],
    }));
  },

  updateServer: (id, updates) => {
    set((state) => ({
      servers: state.servers.map((s) =>
        s.id === id ? { ...s, ...updates } : s
      ),
    }));
  },

  removeServer: (id) => {
    set((state) => ({
      servers: state.servers.filter((s) => s.id !== id),
    }));
  },
});
