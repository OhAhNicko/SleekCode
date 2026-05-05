import type { StateCreator } from "zustand";

export interface PendingDir {
  name: string;
  dir: string;
  serverId?: string;
}

export interface LayoutSlice {
  verticalModeEnabled: boolean;
  setVerticalModeEnabled: (enabled: boolean) => void;
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
  verticalModeEnabled: true,

  setVerticalModeEnabled: (enabled) => {
    set({ verticalModeEnabled: enabled });
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
