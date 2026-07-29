import type { StateCreator } from "zustand";
import { DEFAULT_THEME_ID } from "../lib/themes";

export type NativeCursorStyle = "bar" | "block" | "underline";

export interface ThemeSlice {
  themeId: string;
  setTheme: (id: string) => void;
  vibrantColors: boolean;
  setVibrantColors: (v: boolean) => void;
  projectPaneTint: boolean;
  setProjectPaneTint: (v: boolean) => void;
  /** Wash strength in whole percent (1–15). 4 = default subtle hint. */
  projectPaneTintStrength: number;
  setProjectPaneTintStrength: (v: number) => void;
  /** false = active pane background stays identical to inactive; the pane
   *  header (surface-raised + brand border) remains the only active marker. */
  activePaneLift: boolean;
  setActivePaneLift: (v: boolean) => void;
  nativeCursorStyle: NativeCursorStyle;
  setNativeCursorStyle: (style: NativeCursorStyle) => void;
  nativeCursorBlink: boolean;
  setNativeCursorBlink: (blink: boolean) => void;
}

export const createThemeSlice: StateCreator<ThemeSlice, [], [], ThemeSlice> = (
  set
) => ({
  themeId: DEFAULT_THEME_ID,
  setTheme: (id) => set({ themeId: id }),
  vibrantColors: false,
  setVibrantColors: (v) => set({ vibrantColors: v }),
  projectPaneTint: true,
  setProjectPaneTint: (v) => set({ projectPaneTint: v }),
  projectPaneTintStrength: 4,
  setProjectPaneTintStrength: (v) => set({ projectPaneTintStrength: v }),
  activePaneLift: true,
  setActivePaneLift: (v) => set({ activePaneLift: v }),
  nativeCursorStyle: "bar",
  setNativeCursorStyle: (style) => set({ nativeCursorStyle: style }),
  nativeCursorBlink: true,
  setNativeCursorBlink: (blink) => set({ nativeCursorBlink: blink }),
});
