// P5b: single source of truth for the terminal font stack — Warp parity
// (Warp's default terminal font IS Hack). Consumed by the xterm pane, the
// PromptComposer ghost/overlay layers, and the native renderer's set_font
// wire (TerminalPaneNative). The Rust side parses the first comma-separated
// segment ("Hack") and shapes with the Hack v3.003 TTFs embedded in
// src-tauri/assets/fonts/; the web side loads the same faces via the
// FontFace API in TerminalPaneXterm. Keep the value in sync with both.
export const TERMINAL_FONT_FAMILY = "Hack, monospace";
