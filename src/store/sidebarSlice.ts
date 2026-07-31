import type { StateCreator } from "zustand";
import type { SidebarTab } from "../types";

export interface SidebarSlice {
  sidebarOpen: boolean;
  sidebarTab: SidebarTab;
  devServerPanelOpen: boolean;
  expandedDirs: string[];
  expandedRemoteDirs: string[];
  /** One-shot "show this file in the Files tree" request (see
   *  requestRevealFile). Nonce so the same file can be revealed twice.
   *  Deliberately NOT persisted. */
  revealFileRequest: { path: string; nonce: number } | null;
  /** True while the file sidebar is open because a reveal opened it, not the
   *  user. Any manual toggle clears it — the user owns the sidebar from then
   *  on. Drives closeAutoOpenedSidebar on editor close. Not persisted. */
  sidebarAutoOpened: boolean;
  /** Close the file sidebar IF the last reveal auto-opened it. */
  closeAutoOpenedSidebar: () => void;
  toggleSidebar: () => void;
  setSidebarTab: (tab: SidebarTab) => void;
  toggleDevServerPanel: () => void;
  toggleExpandDir: (path: string) => void;
  toggleExpandRemoteDir: (path: string) => void;
  /** Open the file sidebar on the Files tab and highlight `path` in the
   *  tree. Store-driven rather than a window event so a request fired while
   *  the sidebar is still closed is consumed when FileExplorer mounts a
   *  frame later. */
  requestRevealFile: (path: string) => void;
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
  expandedRemoteDirs: [],
  revealFileRequest: null,
  sidebarAutoOpened: false,

  toggleSidebar: () => {
    set((state) => ({
      sidebarOpen: !state.sidebarOpen,
      // Manual toggle — the user owns the sidebar state from here on.
      sidebarAutoOpened: false,
      // Mutual exclusion: close dev server panel when opening sidebar
      devServerPanelOpen: !state.sidebarOpen ? false : state.devServerPanelOpen,
    }));
  },

  closeAutoOpenedSidebar: () => {
    set((state) =>
      state.sidebarAutoOpened ? { sidebarOpen: false, sidebarAutoOpened: false } : {},
    );
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

  requestRevealFile: (path) => {
    set((state) => ({
      sidebarOpen: true,
      // Auto-opened only when this call actually opened it — a sidebar the
      // user had open stays theirs and won't close with the editor.
      sidebarAutoOpened: state.sidebarAutoOpened || !state.sidebarOpen,
      // Same mutual exclusion as toggleSidebar.
      devServerPanelOpen: false,
      // Remote tabs keep their tab — Sidebar's own effect owns the
      // files ↔ remote-files flip; forcing "files" here would fight it.
      sidebarTab: state.sidebarTab === "remote-files" ? state.sidebarTab : "files",
      revealFileRequest: { path, nonce: (state.revealFileRequest?.nonce ?? 0) + 1 },
    }));
  },

  toggleExpandRemoteDir: (path) => {
    set((state) => {
      const exists = state.expandedRemoteDirs.includes(path);
      return {
        expandedRemoteDirs: exists
          ? state.expandedRemoteDirs.filter((d) => d !== path)
          : [...state.expandedRemoteDirs, path],
      };
    });
  },
});
