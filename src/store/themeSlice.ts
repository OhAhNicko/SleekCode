import type { StateCreator } from "zustand";
import { DEFAULT_THEME_ID } from "../lib/themes";
import { DEFAULT_UI_FONT, type UiFont } from "../lib/ui-fonts";

export type NativeCursorStyle = "bar" | "block" | "underline";

/** The app's sans face. The union is derived from the UI_FONTS registry, so
 *  adding a face there widens this automatically — see lib/ui-fonts.ts.
 *  Re-exported here because the slice's public shape includes it. */
export type { UiFont };

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
  uiFont: UiFont;
  setUiFont: (f: UiFont) => void;
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
  uiFont: DEFAULT_UI_FONT,
  setUiFont: (f) => set({ uiFont: f }),
  nativeCursorStyle: "bar",
  setNativeCursorStyle: (style) => set({ nativeCursorStyle: style }),
  nativeCursorBlink: true,
  setNativeCursorBlink: (blink) => set({ nativeCursorBlink: blink }),
});
