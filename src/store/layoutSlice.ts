import type { StateCreator } from "zustand";

export interface PendingDir {
  name: string;
  dir: string;
  serverId?: string;
}

/** auto = follow window orientation, always/never = force the choice. */
export type VerticalTabMode = "auto" | "always" | "never";

export type SidebarSide = "left" | "right";

export const VERTICAL_TABBAR_MIN_WIDTH = 180;
export const VERTICAL_TABBAR_MAX_WIDTH = 340;
export const VERTICAL_TABBAR_DEFAULT_WIDTH = 220;

export interface LayoutSlice {
  verticalTabMode: VerticalTabMode;
  setVerticalTabMode: (mode: VerticalTabMode) => void;
  sidebarSide: SidebarSide;
  setSidebarSide: (side: SidebarSide) => void;
  verticalTabBarCompact: boolean;
  setVerticalTabBarCompact: (compact: boolean) => void;
  /** Opt into the redesigned strip (VerticalTabBarV2). v1 stays the fallback. */
  verticalTabBarV2: boolean;
  setVerticalTabBarV2: (on: boolean) => void;
  /** Expanded width of the v2 strip, drag-resizable. Compact stays fixed. */
  verticalTabBarWidth: number;
  setVerticalTabBarWidth: (width: number) => void;
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

  verticalTabBarV2: false,

  setVerticalTabBarV2: (on) => {
    set({ verticalTabBarV2: on });
  },

  verticalTabBarWidth: VERTICAL_TABBAR_DEFAULT_WIDTH,

  // Clamped here rather than at the drag handle so a hand-edited persisted
  // value can never leave the strip unusably narrow or eat the canvas.
  setVerticalTabBarWidth: (width) => {
    set({
      verticalTabBarWidth: Math.min(
        VERTICAL_TABBAR_MAX_WIDTH,
        Math.max(VERTICAL_TABBAR_MIN_WIDTH, Math.round(width)),
      ),
    });
  },

  pendingDir: null,

  setPendingDir: (dir) => {
    set({ pendingDir: dir });
  },
});
