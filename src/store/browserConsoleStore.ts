import { create } from "zustand";

export interface ConsoleEntry {
  id: number;
  method: "log" | "warn" | "error" | "info";
  text: string;
  timestamp: number;
}

interface BrowserConsoleStore {
  entries: ConsoleEntry[];
  /** Whether BrowserPreview is mounted */
  active: boolean;
  selectMode: boolean;
  selectedIds: Set<number>;
  /** One-shot flag: EzyComposer sets true, BrowserPreview consumes and opens console tab */
  requestOpenConsole: boolean;
  setEntries: (entries: ConsoleEntry[]) => void;
  setActive: (on: boolean) => void;
  setSelectMode: (on: boolean) => void;
  toggleSelected: (id: number) => void;
  clearSelection: () => void;
  setRequestOpenConsole: (on: boolean) => void;
}

/** Session-only store for browser console entries (not persisted) */
export const useBrowserConsoleStore = create<BrowserConsoleStore>((set) => ({
  entries: [],
  active: false,
  selectMode: false,
  selectedIds: new Set(),
  requestOpenConsole: false,
  setEntries: (entries) => set({ entries }),
  setActive: (on) => set({ active: on }),
  setSelectMode: (on) => set(on ? { selectMode: true, selectedIds: new Set() } : { selectMode: false }),
  toggleSelected: (id) =>
    set((state) => {
      const next = new Set(state.selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selectedIds: next };
    }),
  clearSelection: () => set({ selectedIds: new Set(), selectMode: false }),
  setRequestOpenConsole: (on) => set({ requestOpenConsole: on }),
}));
