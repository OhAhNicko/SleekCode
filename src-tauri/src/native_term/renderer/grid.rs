// Cell-grid text rendering.
//
// R1.b: glyphon-backed monochrome rendering with per-row caching.
// R1.d-α: per-cell foreground colors via set_rich_text + Attrs spans.
// Still ahead in R1.d: bold/italic/underline flags, background quads,
// cursor render, 256-color/truecolor indexed lookup, alternate screen.

use std::sync::{Arc, Mutex};

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::Cell;
use alacritty_terminal::term::Term;
use alacritty_terminal::vte::ansi::{Color as AnsiColor, NamedColor, Rgb};
use glyphon::{Attrs, Buffer, Color, Family, Shaping, TextArea, TextBounds};

use super::super::parser_bridge::TermListener;
use super::damage::DamageTracker;
use super::glyph_atlas::GlyphStack;

/// 16-color ANSI palette (Tango-ish dark, matches the existing MADE feel).
/// Slot i in this table = NamedColor::Black (0) through NamedColor::BrightWhite (15)
/// AND alacritty Color::Indexed(i) for i < 16 (the standard ANSI <-> 16-color
/// mapping). 256-color lookups for i >= 16 are deferred to R1.d-β.
const ANSI_PALETTE: [[u8; 3]; 16] = [
    [0x00, 0x00, 0x00], // Black
    [0xCC, 0x00, 0x00], // Red
    [0x4E, 0x9A, 0x06], // Green
    [0xC4, 0xA0, 0x00], // Yellow
    [0x34, 0x65, 0xA4], // Blue
    [0x75, 0x50, 0x7B], // Magenta
    [0x06, 0x98, 0x9A], // Cyan
    [0xD3, 0xD7, 0xCF], // White
    [0x55, 0x57, 0x53], // BrightBlack
    [0xEF, 0x29, 0x29], // BrightRed
    [0x8A, 0xE2, 0x34], // BrightGreen
    [0xFC, 0xE9, 0x4F], // BrightYellow
    [0x72, 0x9F, 0xCF], // BrightBlue
    [0xAD, 0x7F, 0xA8], // BrightMagenta
    [0x34, 0xE2, 0xE2], // BrightCyan
    [0xEE, 0xEE, 0xEC], // BrightWhite
];
const FG_DEFAULT: [u8; 3] = [0xD3, 0xD7, 0xCF]; // White
const BG_DEFAULT: [u8; 3] = [0x0D, 0x0D, 0x11]; // matches Renderer::bg_clear

fn named_to_rgb(n: NamedColor) -> Option<[u8; 3]> {
    let idx = match n {
        NamedColor::Black => 0,
        NamedColor::Red => 1,
        NamedColor::Green => 2,
        NamedColor::Yellow => 3,
        NamedColor::Blue => 4,
        NamedColor::Magenta => 5,
        NamedColor::Cyan => 6,
        NamedColor::White => 7,
        NamedColor::BrightBlack => 8,
        NamedColor::BrightRed => 9,
        NamedColor::BrightGreen => 10,
        NamedColor::BrightYellow => 11,
        NamedColor::BrightBlue => 12,
        NamedColor::BrightMagenta => 13,
        NamedColor::BrightCyan => 14,
        NamedColor::BrightWhite => 15,
        NamedColor::Foreground => return Some(FG_DEFAULT),
        NamedColor::Background => return Some(BG_DEFAULT),
        _ => return None, // DimX, Cursor, etc — fall back to default fg
    };
    Some(ANSI_PALETTE[idx])
}

fn ansi_color_to_rgb(c: AnsiColor, default: [u8; 3]) -> [u8; 3] {
    match c {
        AnsiColor::Spec(Rgb { r, g, b }) => [r, g, b],
        AnsiColor::Named(n) => named_to_rgb(n).unwrap_or(default),
        AnsiColor::Indexed(i) if (i as usize) < 16 => ANSI_PALETTE[i as usize],
        AnsiColor::Indexed(_) => default, // R1.d-β: 256-color cube lookup
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
struct RowRun {
    text: String,
    color: [u8; 3],
}

/// One Buffer per visible row, kept across frames so cosmic-text can reuse
/// shape caches.
///
/// Cursor rendering is intentionally deferred to a dedicated wgpu quad
/// pipeline (R1.d-γ). A character-overlay approach renders "│" as a full
/// cell glyph that occludes the character behind it and looks oversized;
/// the right primitive is a 2px-wide colored quad positioned at the cursor
/// cell, which needs its own vertex buffer + shader pass.
pub struct CellGrid {
    /// Per-visible-row Buffer storage. Index 0 = top of screen.
    row_buffers: Vec<Buffer>,
    /// Per-row run snapshot used to skip re-shape when unchanged.
    row_runs: Vec<Vec<RowRun>>,
    /// Foreground color fallback from theme (cells with Named(Foreground) or
    /// Indexed beyond what's resolved fall back here).
    fg_default: [u8; 3],
    pub damage: DamageTracker,
    pub cols: usize,
    pub rows: usize,
}

impl CellGrid {
    pub fn new(glyph: &mut GlyphStack, cols: usize, rows: usize, fg_rgba: [u8; 4]) -> Self {
        let row_buffers = (0..rows).map(|_| glyph.make_buffer()).collect();
        let row_runs = vec![Vec::new(); rows];
        // `glyph` reserved here for the R1.d-γ cursor pipeline (will need a
        // wgpu device handle and the same metrics glyph already computed).
        let _ = glyph;
        CellGrid {
            row_buffers,
            row_runs,
            fg_default: [fg_rgba[0], fg_rgba[1], fg_rgba[2]],
            damage: DamageTracker::new(rows),
            cols,
            rows,
        }
    }

    /// Grid size changed. Tear down old buffers and rebuild — cosmic-text
    /// Buffers' Metrics depend on font size which can also be changing.
    pub fn resize(&mut self, glyph: &mut GlyphStack, cols: usize, rows: usize) {
        self.row_buffers = (0..rows).map(|_| glyph.make_buffer()).collect();
        self.row_runs = vec![Vec::new(); rows];
        self.damage.resize(rows);
        self.cols = cols;
        self.rows = rows;
    }

    /// Refresh row buffers from the alacritty grid. Reads only — does not
    /// hold the Term lock while shaping.
    pub fn sync_from_term(
        &mut self,
        glyph: &mut GlyphStack,
        term: &Arc<Mutex<Term<TermListener>>>,
    ) {
        let snapshot = self.snapshot_rows(term);

        let len = snapshot.len().min(self.rows);
        for (y, runs) in snapshot.into_iter().enumerate().take(len) {
            if self.row_runs[y] == runs {
                continue;
            }
            // Apply to buffer via set_rich_text. We need a vec of (&str, Attrs)
            // borrowed from `runs` — build it just-in-time.
            let spans: Vec<(&str, Attrs)> = runs
                .iter()
                .map(|r| {
                    let [cr, cg, cb] = r.color;
                    let attrs = Attrs::new()
                        .family(Family::Monospace)
                        .color(Color::rgba(cr, cg, cb, 0xFF));
                    (r.text.as_str(), attrs)
                })
                .collect();
            // Default Attrs used for any text not covered by a span; with
            // contiguous spans this never fires, but cosmic-text requires it.
            let default_attrs = Attrs::new().family(Family::Monospace).color(Color::rgba(
                self.fg_default[0],
                self.fg_default[1],
                self.fg_default[2],
                0xFF,
            ));
            self.row_buffers[y].set_rich_text(
                &mut glyph.font_system,
                spans.iter().copied(),
                default_attrs,
                Shaping::Advanced,
            );
            self.row_runs[y] = runs;
            self.damage.mark_row(y);
        }
    }

    /// Pull each visible row into a sequence of color-runs under one short
    /// lock of the Term. Trailing empty cells are dropped to avoid shaping
    /// blank suffixes.
    fn snapshot_rows(&self, term: &Arc<Mutex<Term<TermListener>>>) -> Vec<Vec<RowRun>> {
        let t = term.lock().expect("CellGrid::snapshot_rows: term poisoned");
        let grid = t.grid();
        let visible_rows = grid.screen_lines();
        let visible_cols = grid.columns();
        let mut out = Vec::with_capacity(visible_rows);
        for y in 0..visible_rows {
            let line = Line(y as i32);
            let mut runs: Vec<RowRun> = Vec::new();
            let mut current_color: Option<[u8; 3]> = None;
            let mut current_text = String::new();
            for x in 0..visible_cols {
                let cell: &Cell = &grid[line][Column(x)];
                let ch = if cell.c == '\u{0}' { ' ' } else { cell.c };
                let color = ansi_color_to_rgb(cell.fg, self.fg_default);
                if Some(color) == current_color {
                    current_text.push(ch);
                } else {
                    if !current_text.is_empty() {
                        runs.push(RowRun {
                            text: std::mem::take(&mut current_text),
                            color: current_color.unwrap_or(self.fg_default),
                        });
                    }
                    current_color = Some(color);
                    current_text.push(ch);
                }
            }
            if !current_text.is_empty() {
                runs.push(RowRun {
                    text: current_text,
                    color: current_color.unwrap_or(self.fg_default),
                });
            }
            // Drop a trailing run that's purely spaces in the default color —
            // common case (most of a blank line) and shaping it costs glyph
            // atlas slots for no visible benefit.
            if let Some(last) = runs.last() {
                if last.color == self.fg_default && last.text.chars().all(|c| c == ' ') {
                    runs.pop();
                }
            }
            out.push(runs);
        }
        out
    }

    /// Build a TextArea per row, positioned at line_height * y. Lifetime tied
    /// to `&self` so the caller can pass straight into prepare().
    pub fn text_areas<'a>(&'a self, line_height_px: f32) -> Vec<TextArea<'a>> {
        let default_color = Color::rgba(self.fg_default[0], self.fg_default[1], self.fg_default[2], 0xFF);
        self.row_buffers
            .iter()
            .enumerate()
            .map(|(y, buf)| TextArea {
                buffer: buf,
                left: 0.0,
                top: y as f32 * line_height_px,
                scale: 1.0,
                bounds: TextBounds::default(),
                default_color,
                custom_glyphs: &[],
            })
            .collect()
    }
}
