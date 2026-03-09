import type { StateCreator } from "zustand";
import type { SidebarTab } from "../types";

export interface SidebarSlice {
  sidebarOpen: boolean;
  sidebarTab: SidebarTab;
  devServerPanelOpen: boolean;
  expandedDirs: string[];
  toggleSidebar: () => void;
  setSidebarTab: (tab: SidebarTab) => void;
  toggleDevServerPanel: () => void;
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
  devServerPanelOpen: false,
  expandedDirs: [],

  toggleSidebar: () => {
    set((state) => ({
      sidebarOpen: !state.sidebarOpen,
      // Mutual exclusion: close dev server panel when opening sidebar
      devServerPanelOpen: !state.sidebarOpen ? false : state.devServerPanelOpen,
    }));
  },

  setSidebarTab: (tab) => {
    set({ sidebarTab: tab });
  },

  toggleDevServerPanel: () => {
    set((state) => ({
      devServerPanelOpen: !state.devServerPanelOpen,
      // Mutual exclusion: close sidebar when opening dev server panel
      sidebarOpen: !state.devServerPanelOpen ? false : state.sidebarOpen,
    }));
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
