import type { StateCreator } from "zustand";

export interface PendingDir {
  name: string;
  dir: string;
  serverId?: string;
}

export interface LayoutSlice {
  verticalModeEnabled: boolean;
  setVerticalModeEnabled: (enabled: boolean) => void;
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

  pendingDir: null,

  setPendingDir: (dir) => {
    set({ pendingDir: dir });
  },
});
