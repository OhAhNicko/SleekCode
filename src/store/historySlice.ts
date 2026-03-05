import type { StateCreator } from "zustand";

export interface HistoryEntry {
  id: string;
  command: string;
  exitCode: number | null;
  timestamp: number;
  endTimestamp: number | null;
  workingDir: string;
  terminalId: string;
  tabName: string;
}

const MAX_HISTORY_ENTRIES = 1000;

export interface HistorySlice {
  commandHistory: HistoryEntry[];
  addHistoryEntry: (entry: Omit<HistoryEntry, "id">) => void;
  clearHistory: () => void;
}

export const createHistorySlice: StateCreator<
  HistorySlice,
  [],
  [],
  HistorySlice
> = (set) => ({
  commandHistory: [],

  addHistoryEntry: (entry) => {
    const newEntry: HistoryEntry = {
      ...entry,
      id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    };
    set((state) => {
      const updated = [...state.commandHistory, newEntry];
      // FIFO eviction if over cap
      if (updated.length > MAX_HISTORY_ENTRIES) {
        return { commandHistory: updated.slice(updated.length - MAX_HISTORY_ENTRIES) };
      }
      return { commandHistory: updated };
    });
  },

  clearHistory: () => {
    set({ commandHistory: [] });
  },
});
