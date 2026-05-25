import type { StateCreator } from "zustand";
import { DEFAULT_THEME_ID } from "../lib/themes";

export type NativeCursorStyle = "bar" | "block" | "underline";

export interface ThemeSlice {
  themeId: string;
  setTheme: (id: string) => void;
  vibrantColors: boolean;
  setVibrantColors: (v: boolean) => void;
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
  nativeCursorStyle: "bar",
  setNativeCursorStyle: (style) => set({ nativeCursorStyle: style }),
  nativeCursorBlink: true,
  setNativeCursorBlink: (blink) => set({ nativeCursorBlink: blink }),
});
