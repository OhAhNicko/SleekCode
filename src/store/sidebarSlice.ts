import type { StateCreator } from "zustand";
import type { SidebarTab } from "../types";

export interface SidebarSlice {
  sidebarOpen: boolean;
  sidebarTab: SidebarTab;
  expandedDirs: string[];
  toggleSidebar: () => void;
  setSidebarTab: (tab: SidebarTab) => void;
  toggleExpandDir: (path: string) => void;
}

export const createSidebarSlice: StateCreator<
  SidebarSlice,
  [],
  [],
  SidebarSlice
> = (set) => ({
  sidebarOpen: false,
  sidebarTab: "files",
  expandedDirs: [],

  toggleSidebar: () => {
    set((state) => ({ sidebarOpen: !state.sidebarOpen }));
  },

  setSidebarTab: (tab) => {
    set({ sidebarTab: tab });
  },

  toggleExpandDir: (path) => {
    set((state) => {
      const exists = state.expandedDirs.includes(path);
      return {
        expandedDirs: exists
          ? state.expandedDirs.filter((d) => d !== path)
          : [...state.expandedDirs, path],
      };
    });
  },
});
