// Cursor visual style shared by the renderer's cursor pass.
//
// P2a: the old single-quad `CursorPipeline` (dedicated uniform + shader) is
// gone — the cursor now renders through the shared instanced `QuadPipeline`
// (see `pipeline.rs`, `cursor_quads`), which alpha-blends (needed for the
// 0.30-alpha focused block) and batches the unfocused hollow outline's four
// edge quads in a single draw. This module keeps only the style enum.

/// Cursor visual style. Mirrors the xterm.js `cursorStyle` option set:
///   - `Bar`       — thin vertical line at the cursor x. Default.
///   - `Block`     — full cell-rect tinted quad, drawn AFTER the glyph pass at
///                   reduced alpha so the cell character remains visible
///                   underneath (true xterm "inverse" requires re-rendering
///                   the glyph in the bg color, which would require an extra
///                   glyphon pass — deferred to a future slice).
///   - `Underline` — full cell-width horizontal bar at the cell bottom.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CursorStyle {
    Bar,
    Block,
    Underline,
}

impl CursorStyle {
    pub fn parse(s: &str) -> Self {
        match s {
            "block" => CursorStyle::Block,
            "underline" => CursorStyle::Underline,
            _ => CursorStyle::Bar,
        }
    }
}
