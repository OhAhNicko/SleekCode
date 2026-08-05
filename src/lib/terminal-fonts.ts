import type { TerminalType } from "../types";

// P5b: single source of truth for the terminal font stack — Warp parity
// (Warp's default terminal font IS Hack). Consumed by the xterm pane, the
// PromptComposer ghost/overlay layers, and the native renderer's set_font
// wire (TerminalPaneNative). The Rust side parses the first comma-separated
// segment ("Hack") and shapes with the Hack v3.003 TTFs embedded in
// src-tauri/assets/fonts/; the web side loads the same faces via the
// FontFace API in TerminalPaneXterm. Keep the value in sync with both.
export const TERMINAL_FONT_FAMILY = "Hack, monospace";

/** The face a pane falls back to when the user has picked nothing — the bundled
 *  one, so a fresh install and an unset setting render identically. Bare family
 *  name (no fallback tail): the native renderer takes a family, not a stack. */
export const DEFAULT_TERMINAL_FONT = "Hack";

/** The store fields that decide a pane's face. Structural rather than the whole
 *  AppStore so the resolver can be called from lib code and tests without
 *  dragging the store type in. */
export interface TerminalFontPrefs {
  terminalFontFamily: string;
  perCliFontFamily: boolean;
  cliFontFamilies: Partial<Record<TerminalType, string>>;
}

/**
 * Which font family a pane of `cli` renders in.
 *
 * Per-CLI faces are opt-in (`perCliFontFamily`) and sparse — an unset CLI falls
 * through to the global face while the toggle is on, so turning it on doesn't
 * silently reset every pane that has no per-CLI pick.
 */
export function resolveTerminalFontFamily(
  prefs: TerminalFontPrefs,
  cli: TerminalType,
): string {
  const perCli = prefs.perCliFontFamily ? prefs.cliFontFamilies[cli] : undefined;
  return perCli || prefs.terminalFontFamily || DEFAULT_TERMINAL_FONT;
}

/** CSS stack for a resolved face — quoted so a multi-word family ("Cascadia
 *  Code") stays ONE family, plus the generic tail the panes have always
 *  carried. The native renderer needs the bare family instead; only the web
 *  side (xterm, composer overlays) goes through this. */
export function terminalFontStack(family: string): string {
  return `"${family}", monospace`;
}
