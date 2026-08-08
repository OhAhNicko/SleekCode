import type { StateCreator } from "zustand";

export interface PendingDir {
  name: string;
  dir: string;
  serverId?: string;
}

/** auto = follow window orientation, always/never = force the choice. */
export type VerticalTabMode = "auto" | "always" | "never";

export type SidebarSide = "left" | "right";

export interface LayoutSlice {
  verticalTabMode: VerticalTabMode;
  setVerticalTabMode: (mode: VerticalTabMode) => void;
  sidebarSide: SidebarSide;
  setSidebarSide: (side: SidebarSide) => void;
  verticalTabBarCompact: boolean;
  setVerticalTabBarCompact: (compact: boolean) => void;
  pendingDir: PendingDir | null;
  setPendingDir: (dir: PendingDir | null) => void;
}

export const createLayoutSlice: StateCreator<
  LayoutSlice,
  [],
  [],
  LayoutSlice
> = (set) => ({
  verticalTabMode: "auto",

  setVerticalTabMode: (mode) => {
    set({ verticalTabMode: mode });
  },

  sidebarSide: "left",

  setSidebarSide: (side) => {
    set({ sidebarSide: side });
  },

  verticalTabBarCompact: false,

  setVerticalTabBarCompact: (compact) => {
    set({ verticalTabBarCompact: compact });
  },

  pendingDir: null,

  setPendingDir: (dir) => {
    set({ pendingDir: dir });
  },
});
