import type { StateCreator } from "zustand";
import { DEFAULT_THEME_ID } from "../lib/themes";
import { DEFAULT_UI_FONT, UI_FONT_SIZE_DEFAULT, type UiFont } from "../lib/ui-fonts";
import { DEFAULT_APP_ICON_VARIANT, type AppIconVariant } from "../lib/app-icon";
import type { OverrideKey, TerminalColorPreset } from "../lib/color-overrides";
import { DEFAULT_TERMINAL_FONT } from "../lib/terminal-fonts";
import type { TerminalType } from "../types";

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
  /** Global override for every corner radius in the app, consumed as
   *  `--ezy-radius-scale`. `null` = follow the ACTIVE THEME's own
   *  `radiusScale` (Sorbet 2, every other theme 1) — the default, so shipping
   *  this setting changes nobody's appearance until they move the slider.
   *  A number pins one roundness across all themes. */
  radiusScaleOverride: number | null;
  setRadiusScaleOverride: (v: number | null) => void;
  uiFont: UiFont;
  setUiFont: (f: UiFont) => void;
  /** Size in px of the app's PRIMARY LABEL text. The chrome uses 17 distinct
   *  sizes, so there is no single size to set outright: this one is the
   *  anchor, and App.tsx turns it into the ratio `--ezy-font-scale` that
   *  every other size is multiplied by. 13 = the sizes as authored. */
  uiFontSize: number;
  setUiFontSize: (v: number) => void;
  nativeCursorStyle: NativeCursorStyle;
  setNativeCursorStyle: (style: NativeCursorStyle) => void;
  nativeCursorBlink: boolean;
  setNativeCursorBlink: (blink: boolean) => void;
  /** The terminal face for every pane, as a BARE family name ("Hack",
   *  "Cascadia Code") — the native renderer takes a family, not a CSS stack.
   *  The picker's choices come from the machine's installed monospace fonts
   *  (nativeTermListMonoFonts); resolve a pane's face through
   *  `resolveTerminalFontFamily`, never by reading this field alone. */
  terminalFontFamily: string;
  setTerminalFontFamily: (family: string) => void;
  /** Opt in to a different face per CLI. Off means every pane uses
   *  `terminalFontFamily` and the per-CLI map is remembered but ignored, so
   *  toggling back restores the picks instead of losing them. */
  perCliFontFamily: boolean;
  setPerCliFontFamily: (v: boolean) => void;
  /** Sparse per-CLI faces — an entry only exists once the user picks one, and
   *  a CLI without an entry falls back to `terminalFontFamily`. */
  cliFontFamilies: Partial<Record<TerminalType, string>>;
  setCliFontFamily: (cli: TerminalType, family: string) => void;
  /** Row height as a multiple of the font's natural line height (1–1.6).
   *  1 = as authored. Changes cell metrics, so both renderers re-grid and the
   *  PTY is resized — not a purely cosmetic setting. */
  terminalLineHeight: number;
  setTerminalLineHeight: (v: number) => void;
  /** Draw bold text in the BRIGHT ANSI color, the way classic terminals do.
   *  false (default) keeps bold a weight change only. */
  boldUsesBright: boolean;
  setBoldUsesBright: (v: boolean) => void;
  /** Minimum foreground/background contrast ratio the renderer enforces.
   *  1 = off (colors exactly as the program sent them); 4.5 and 7 are the WCAG
   *  AA / AAA steps the Settings picker offers. */
  minContrast: number;
  setMinContrast: (v: number) => void;
  /** How far SGR 2 (dim/faint) text fades toward the background, in whole
   *  percent (20–80). 50 = the renderer's long-standing hardcoded value. */
  dimStrength: number;
  setDimStrength: (v: number) => void;
  /** Block-cursor fill opacity in whole percent (10–100). 30 = today's
   *  translucent block; 100 flips it to an opaque block with the glyph redrawn
   *  in the cursor accent (classic inverse cursor). Native panes only. */
  cursorBlockOpacity: number;
  setCursorBlockOpacity: (v: number) => void;
  /** Lines of scrollback a pane keeps. Native panes read this at CREATE only —
   *  the Rust grid cannot be re-sized live — so a change reaches them on the
   *  next pane; xterm panes apply it immediately. */
  scrollbackLines: number;
  setScrollbackLines: (v: number) => void;
  /** Which bundled window icon the OS shows (lib/app-icon.ts). Applying it
   *  is the caller's job — the slice only remembers the choice. */
  appIconVariant: AppIconVariant;
  setAppIconVariant: (v: AppIconVariant) => void;
  /** Named color presets: sparse per-key overrides that sit ON TOP of the
   *  active theme (lib/color-overrides.ts). Global overlay — the active
   *  preset stays applied across theme switches. */
  colorPresets: TerminalColorPreset[];
  /** null = no preset active, panes render pure theme colors. */
  activeColorPresetId: string | null;
  /** Creates an empty preset and makes it active, so the pickers that appear
   *  immediately edit the preset just named. */
  createColorPreset: (name: string) => void;
  renameColorPreset: (id: string, name: string) => void;
  deleteColorPreset: (id: string) => void;
  setActiveColorPreset: (id: string | null) => void;
  setPresetColor: (presetId: string, key: OverrideKey, value: string) => void;
  /** Deletes the key from the sparse map — the color returns to theme default. */
  clearPresetColor: (presetId: string, key: OverrideKey) => void;
  /** Wipes EVERY override in the preset — all colors return to the current
   *  theme's defaults; the preset itself (name, active state) survives. */
  clearPresetColors: (presetId: string) => void;
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
  radiusScaleOverride: null,
  setRadiusScaleOverride: (v) => set({ radiusScaleOverride: v }),
  uiFont: DEFAULT_UI_FONT,
  setUiFont: (f) => set({ uiFont: f }),
  uiFontSize: UI_FONT_SIZE_DEFAULT,
  setUiFontSize: (v) => set({ uiFontSize: v }),
  nativeCursorStyle: "bar",
  setNativeCursorStyle: (style) => set({ nativeCursorStyle: style }),
  nativeCursorBlink: true,
  setNativeCursorBlink: (blink) => set({ nativeCursorBlink: blink }),
  terminalFontFamily: DEFAULT_TERMINAL_FONT,
  setTerminalFontFamily: (family) => set({ terminalFontFamily: family }),
  perCliFontFamily: false,
  setPerCliFontFamily: (v) => set({ perCliFontFamily: v }),
  cliFontFamilies: {},
  setCliFontFamily: (cli, family) =>
    set((s) => ({ cliFontFamilies: { ...s.cliFontFamilies, [cli]: family } })),
  terminalLineHeight: 1,
  setTerminalLineHeight: (v) => set({ terminalLineHeight: v }),
  boldUsesBright: false,
  setBoldUsesBright: (v) => set({ boldUsesBright: v }),
  minContrast: 1,
  setMinContrast: (v) => set({ minContrast: v }),
  dimStrength: 50,
  setDimStrength: (v) => set({ dimStrength: v }),
  cursorBlockOpacity: 30,
  setCursorBlockOpacity: (v) => set({ cursorBlockOpacity: v }),
  scrollbackLines: 10000,
  setScrollbackLines: (v) => set({ scrollbackLines: v }),
  appIconVariant: DEFAULT_APP_ICON_VARIANT,
  setAppIconVariant: (v) => set({ appIconVariant: v }),
  colorPresets: [],
  activeColorPresetId: null,
  createColorPreset: (name) =>
    set((s) => {
      const preset: TerminalColorPreset = {
        id: `cp-${Date.now()}`,
        name,
        overrides: {},
        createdAt: Date.now(),
      };
      return {
        colorPresets: [...s.colorPresets, preset],
        activeColorPresetId: preset.id,
      };
    }),
  renameColorPreset: (id, name) =>
    set((s) => ({
      colorPresets: s.colorPresets.map((p) => (p.id === id ? { ...p, name } : p)),
    })),
  deleteColorPreset: (id) =>
    set((s) => ({
      colorPresets: s.colorPresets.filter((p) => p.id !== id),
      activeColorPresetId:
        s.activeColorPresetId === id ? null : s.activeColorPresetId,
    })),
  setActiveColorPreset: (id) => set({ activeColorPresetId: id }),
  setPresetColor: (presetId, key, value) =>
    set((s) => ({
      colorPresets: s.colorPresets.map((p) =>
        p.id === presetId ? { ...p, overrides: { ...p.overrides, [key]: value } } : p
      ),
    })),
  clearPresetColor: (presetId, key) =>
    set((s) => ({
      colorPresets: s.colorPresets.map((p) => {
        if (p.id !== presetId) return p;
        const { [key]: _removed, ...rest } = p.overrides;
        return { ...p, overrides: rest };
      }),
    })),
  clearPresetColors: (presetId) =>
    set((s) => ({
      colorPresets: s.colorPresets.map((p) =>
        p.id === presetId ? { ...p, overrides: {} } : p
      ),
    })),
});
