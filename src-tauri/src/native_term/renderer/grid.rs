// Cell-grid text rendering.
//
// R1.b: glyphon-backed monochrome rendering with per-row caching.
// R1.d-α: per-cell foreground colors via set_rich_text + Attrs spans.
// R1.d-δ: 256-color palette, SGR attrs (bold/italic/underline/strike/inverse),
//         per-cell background quads, decoration quads, real cell-advance.

use std::sync::{Arc, Mutex, RwLock};

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::{Term, TermMode};
use alacritty_terminal::vte::ansi::{Color as AnsiColor, NamedColor, Rgb};
use glyphon::{Attrs, Buffer, Color, Family, Shaping, Style, TextArea, TextBounds, Weight};

use super::super::parser_bridge::TermListener;
use super::damage::DamageTracker;
use super::glyph_atlas::GlyphStack;
use super::quad_pipeline::QuadInstance;
use super::ThemeColors;

/// Hard-coded fallback selection overlay used when the live theme has not yet
/// been swapped in. Matches the previous `SELECTION_BG` constant so a freshly
/// created pane (pre-set_theme) still renders the same semi-blue overlay.
const SELECTION_BG_FALLBACK: [u8; 3] = [0x44, 0x55, 0x6B];

/// 6×6×6 RGB cube component levels for xterm 256-color indices 16..=231.
const XTERM_CUBE_LEVELS: [u8; 6] = [0, 95, 135, 175, 215, 255];

fn named_to_rgb(n: NamedColor, theme: &ThemeColors) -> Option<[u8; 3]> {
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
        NamedColor::Foreground => return Some(rgb3(theme.foreground)),
        NamedColor::Background => return Some(rgb3(theme.background)),
        _ => return None, // DimX, Cursor, etc — fall back to default
    };
    Some(rgb3(theme.ansi[idx]))
}

#[inline]
fn rgb3(rgba: [u8; 4]) -> [u8; 3] {
    [rgba[0], rgba[1], rgba[2]]
}

/// Map an xterm 256-color index to RGB. Caller guarantees `i >= 16`.
fn indexed_256_to_rgb(i: u8) -> [u8; 3] {
    if i <= 231 {
        let n = (i - 16) as usize;
        let r = XTERM_CUBE_LEVELS[(n / 36) % 6];
        let g = XTERM_CUBE_LEVELS[(n / 6) % 6];
        let b = XTERM_CUBE_LEVELS[n % 6];
        [r, g, b]
    } else {
        // 232..=255 grayscale ramp.
        let n = (i - 232) as u16;
        let gray = (8 + n * 10).min(255) as u8;
        [gray, gray, gray]
    }
}

fn ansi_color_to_rgb(c: AnsiColor, default: [u8; 3], theme: &ThemeColors) -> [u8; 3] {
    match c {
        AnsiColor::Spec(Rgb { r, g, b }) => [r, g, b],
        AnsiColor::Named(n) => named_to_rgb(n, theme).unwrap_or(default),
        AnsiColor::Indexed(i) if (i as usize) < 16 => rgb3(theme.ansi[i as usize]),
        AnsiColor::Indexed(i) => indexed_256_to_rgb(i),
    }
}

/// Background variant: same logic, different default so unstyled cells map
/// to the renderer's clear color (which we then suppress to avoid an
/// over-draw on every blank cell).
fn ansi_color_to_rgb_bg(c: AnsiColor, theme: &ThemeColors) -> [u8; 3] {
    ansi_color_to_rgb(c, rgb3(theme.background), theme)
}

/// True for Unicode "Block Elements" (U+2580..=U+259F): full/half/eighth
/// blocks, shades, and quadrants. These are the glyphs the Claude Code banner
/// uses to draw its logo. We render them as solid quads on the fixed cell grid
/// (see `block_element_fills` / `build_block_quads`) instead of as font glyphs:
/// cosmic-text shapes them at advances that don't match the "M"-derived cell
/// width, which sheared the pixel-art apart cell-by-cell. Grid-aligned quads
/// also sidestep any gaps in the active font's coverage of these codepoints.
#[inline]
fn is_block_element(ch: char) -> bool {
    ('\u{2580}'..='\u{259F}').contains(&ch)
}

/// Map a block-element char to its filled sub-rectangles in normalized cell
/// space ([x0, y0, x1, y1], origin top-left, components in 0..1) plus a
/// coverage alpha (< 1.0 only for the shade glyphs ░▒▓). Returns None for
/// non-block chars.
fn block_element_fills(ch: char) -> Option<(Vec<[f32; 4]>, f32)> {
    // Eighth fractions of the cell box; H = half (4/8).
    const E1: f32 = 1.0 / 8.0;
    const E2: f32 = 2.0 / 8.0;
    const E3: f32 = 3.0 / 8.0;
    const E5: f32 = 5.0 / 8.0;
    const E6: f32 = 6.0 / 8.0;
    const E7: f32 = 7.0 / 8.0;
    const H: f32 = 0.5;
    let rects: Vec<[f32; 4]> = match ch {
        '\u{2580}' => vec![[0.0, 0.0, 1.0, H]],   // ▀ upper half
        '\u{2581}' => vec![[0.0, E7, 1.0, 1.0]],  // ▁ lower 1/8
        '\u{2582}' => vec![[0.0, E6, 1.0, 1.0]],  // ▂ lower 1/4
        '\u{2583}' => vec![[0.0, E5, 1.0, 1.0]],  // ▃ lower 3/8
        '\u{2584}' => vec![[0.0, H, 1.0, 1.0]],   // ▄ lower half
        '\u{2585}' => vec![[0.0, E3, 1.0, 1.0]],  // ▅ lower 5/8
        '\u{2586}' => vec![[0.0, E2, 1.0, 1.0]],  // ▆ lower 3/4
        '\u{2587}' => vec![[0.0, E1, 1.0, 1.0]],  // ▇ lower 7/8
        '\u{2588}' => vec![[0.0, 0.0, 1.0, 1.0]], // █ full block
        '\u{2589}' => vec![[0.0, 0.0, E7, 1.0]],  // ▉ left 7/8
        '\u{258A}' => vec![[0.0, 0.0, E6, 1.0]],  // ▊ left 3/4
        '\u{258B}' => vec![[0.0, 0.0, E5, 1.0]],  // ▋ left 5/8
        '\u{258C}' => vec![[0.0, 0.0, H, 1.0]],   // ▌ left half
        '\u{258D}' => vec![[0.0, 0.0, E3, 1.0]],  // ▍ left 3/8
        '\u{258E}' => vec![[0.0, 0.0, E2, 1.0]],  // ▎ left 1/4
        '\u{258F}' => vec![[0.0, 0.0, E1, 1.0]],  // ▏ left 1/8
        '\u{2590}' => vec![[H, 0.0, 1.0, 1.0]],   // ▐ right half
        '\u{2591}' => return Some((vec![[0.0, 0.0, 1.0, 1.0]], 0.25)), // ░ light shade
        '\u{2592}' => return Some((vec![[0.0, 0.0, 1.0, 1.0]], 0.50)), // ▒ medium shade
        '\u{2593}' => return Some((vec![[0.0, 0.0, 1.0, 1.0]], 0.75)), // ▓ dark shade
        '\u{2594}' => vec![[0.0, 0.0, 1.0, E1]],  // ▔ upper 1/8
        '\u{2595}' => vec![[E7, 0.0, 1.0, 1.0]],  // ▕ right 1/8
        '\u{2596}' => vec![[0.0, H, H, 1.0]],     // ▖ lower-left quadrant
        '\u{2597}' => vec![[H, H, 1.0, 1.0]],     // ▗ lower-right quadrant
        '\u{2598}' => vec![[0.0, 0.0, H, H]],     // ▘ upper-left quadrant
        '\u{2599}' => vec![[0.0, 0.0, H, H], [0.0, H, 1.0, 1.0]], // ▙ UL + lower half
        '\u{259A}' => vec![[0.0, 0.0, H, H], [H, H, 1.0, 1.0]],   // ▚ UL + LR
        '\u{259B}' => vec![[0.0, 0.0, 1.0, H], [0.0, H, H, 1.0]], // ▛ upper half + LL
        '\u{259C}' => vec![[0.0, 0.0, 1.0, H], [H, H, 1.0, 1.0]], // ▜ upper half + LR
        '\u{259D}' => vec![[H, 0.0, 1.0, H]],     // ▝ upper-right quadrant
        '\u{259E}' => vec![[H, 0.0, 1.0, H], [0.0, H, H, 1.0]],   // ▞ UR + LL
        '\u{259F}' => vec![[H, 0.0, 1.0, H], [0.0, H, 1.0, 1.0]], // ▟ UR + lower half
        _ => return None,
    };
    Some((rects, 1.0))
}

/// Per-cell visual attrs that need to be reflected in `RowRun` identity so
/// that two runs with the same text but different bold-ness re-shape and
/// re-decorate correctly.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
struct CellAttrs {
    bold: bool,
    italic: bool,
    underline: bool,
    strikeout: bool,
}

impl CellAttrs {
    fn from_flags(f: Flags) -> Self {
        Self {
            bold: f.contains(Flags::BOLD),
            italic: f.contains(Flags::ITALIC),
            // Treat any underline style as a plain underline for now; the
            // double / curly / dotted variants land later.
            underline: f.intersects(Flags::ALL_UNDERLINES),
            strikeout: f.contains(Flags::STRIKEOUT),
        }
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
struct RowRun {
    text: String,
    color: [u8; 3],
    attrs: CellAttrs,
}

/// One contiguous background segment within a row. Built only for cells
/// whose effective bg differs from the renderer clear color.
#[derive(Clone, Copy, Debug)]
struct BgSegment {
    col_start: u16,
    col_end: u16, // exclusive
    color: [u8; 3],
}

/// One contiguous decoration (underline or strikeout) segment within a row.
#[derive(Clone, Copy, Debug)]
struct DecorSegment {
    col_start: u16,
    col_end: u16, // exclusive
    color: [u8; 3],
    kind: DecorKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DecorKind {
    Underline,
    Strikeout,
}

/// One block-element cell (U+2580..=U+259F) rendered as grid-aligned quads
/// rather than a font glyph. `color` is the resolved foreground (post-inverse)
/// — the block's "ink". The text run substitutes a space at this column so
/// surrounding glyphs keep their cell alignment.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct BlockCell {
    col: u16,
    color: [u8; 3],
    ch: char,
}

/// P3a frame-scheduler: cursor + viewport state captured under the SAME Term
/// lock as `snapshot_rows`, so `Renderer::render` takes exactly ONE Term lock
/// acquisition per frame (the cursor pass previously re-locked). Returned by
/// `sync_from_term`; feeds both the renderer's cursor quads and its
/// `FrameSnapshot` dirty check (cursor movement / DECSET-25 / wheel-scroll
/// offset changes must dirty a frame even when no row content changed).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TermFrameInfo {
    /// Cursor column (0-based, alacritty `Column.0`).
    pub cursor_col: usize,
    /// Cursor line in alacritty's signed viewport space (`Line.0`).
    pub cursor_line: i32,
    /// Visible grid rows (`screen_lines`).
    pub visible_rows: usize,
    /// Visible grid columns.
    pub visible_cols: usize,
    /// DECSET 25 SHOW_CURSOR mode bit (vim hides the cursor through it).
    pub show_cursor: bool,
    /// Scrollback display offset (0 = pinned to the live bottom).
    pub display_offset: usize,
    /// P6b wide chars: the (spacer-normalized) cursor cell carries
    /// WIDE_CHAR — the cursor pass widens Block/Underline/hollow-outline
    /// cursors to span 2 cells (Bar keeps its normal thin width).
    /// `cursor_col` is already normalized to the wide-char START column when
    /// the raw cursor sat on the trailing WIDE_CHAR_SPACER half (mirrors
    /// alacritty's RenderableCursor), so consumers never see the spacer col.
    pub cursor_wide: bool,
}

/// One Buffer per visible row, kept across frames so cosmic-text can reuse
/// shape caches.
pub struct CellGrid {
    /// Per-visible-row Buffer storage. Index 0 = top of screen.
    row_buffers: Vec<Buffer>,
    /// Per-row run snapshot used to skip re-shape when unchanged.
    row_runs: Vec<Vec<RowRun>>,
    /// Per-row background segments. Recomputed alongside row_runs whenever a
    /// row changes; lives across frames so render() can rebuild the full
    /// QuadInstance list each frame cheaply.
    row_bg: Vec<Vec<BgSegment>>,
    /// Per-row decoration segments (underline/strikeout).
    row_decor: Vec<Vec<DecorSegment>>,
    /// Per-row block-element cells (U+2580..=U+259F), rendered as grid-aligned
    /// quads by `build_block_quads` instead of as font glyphs.
    row_block: Vec<Vec<BlockCell>>,
    /// Per-row cache validity. `false` forces a re-shape regardless of the
    /// identity check — the ONLY safe way to invalidate a slot whose Buffer
    /// may hold stale glyphs, because a cleared runs-cache compares EQUAL to
    /// a genuinely-blank incoming row and would skip `set_rich_text` on a
    /// Buffer still holding old content (the P6a aliasing trap).
    row_valid: Vec<bool>,
    /// Shared theme palette. Owned by Renderer; cloned into CellGrid so
    /// snapshot_rows / sync_from_term can resolve named/indexed ansi colors
    /// against the current theme. Updated atomically by `Renderer::set_theme`.
    theme: Arc<RwLock<ThemeColors>>,
    /// P6a scrollback: `display_offset` of the most recent `sync_from_term`.
    /// The per-row caches above are keyed by ROW SLOT (viewport position),
    /// not by grid line — when the offset changes, `rotate_for_offset_delta`
    /// shifts the caches so unchanged content keeps skipping the shaper and
    /// only the |delta| newly-exposed slots re-shape. (The original
    /// re-shape-everything fallback made wheel scrolling unusably slow: a
    /// full screenful of cosmic-text shaping per wheel notch.)
    last_display_offset: usize,
    pub damage: DamageTracker,
    pub cols: usize,
    pub rows: usize,
}

impl CellGrid {
    pub fn new(
        glyph: &mut GlyphStack,
        cols: usize,
        rows: usize,
        theme: Arc<RwLock<ThemeColors>>,
    ) -> Self {
        let row_buffers = (0..rows).map(|_| glyph.make_buffer()).collect();
        let row_runs = vec![Vec::new(); rows];
        let row_bg = vec![Vec::new(); rows];
        let row_decor = vec![Vec::new(); rows];
        let row_block = vec![Vec::new(); rows];
        CellGrid {
            row_buffers,
            row_runs,
            row_bg,
            row_decor,
            row_block,
            row_valid: vec![false; rows],
            theme,
            last_display_offset: 0,
            damage: DamageTracker::new(rows),
            cols,
            rows,
        }
    }

    /// P6a-rotate: the display offset moved by `d` rows — cached content is
    /// still valid, just at a shifted viewport slot (slot y shows grid line
    /// `y - offset`, so content moves to slot `old_slot + d`). Rotate every
    /// per-row cache so the identity check keeps skipping unmoved rows;
    /// only the |d| newly-exposed slots (wrapped-around entries holding
    /// stale buffers) are invalidated via `row_valid` and re-shape.
    fn rotate_for_offset_delta(&mut self, d: i64) {
        let rows = self.rows;
        if rows == 0 || d == 0 {
            return;
        }
        let ad = d.unsigned_abs() as usize;
        if ad >= rows {
            for v in self.row_valid.iter_mut() {
                *v = false;
            }
            for y in 0..rows {
                self.damage.mark_row(y);
            }
            return;
        }
        if d > 0 {
            // Scrolled toward history: content shifts DOWN; new rows at top.
            self.row_buffers.rotate_right(ad);
            self.row_runs.rotate_right(ad);
            self.row_bg.rotate_right(ad);
            self.row_decor.rotate_right(ad);
            self.row_block.rotate_right(ad);
            self.row_valid.rotate_right(ad);
            for y in 0..ad {
                self.row_valid[y] = false;
                self.damage.mark_row(y);
            }
        } else {
            // Scrolled toward bottom: content shifts UP; new rows at bottom.
            self.row_buffers.rotate_left(ad);
            self.row_runs.rotate_left(ad);
            self.row_bg.rotate_left(ad);
            self.row_decor.rotate_left(ad);
            self.row_block.rotate_left(ad);
            self.row_valid.rotate_left(ad);
            for y in rows - ad..rows {
                self.row_valid[y] = false;
                self.damage.mark_row(y);
            }
        }
    }

    /// Invalidate cached row data so the next `sync_from_term` re-shapes every
    /// row against the new theme palette. Called by `Renderer::set_theme`
    /// after swapping in the new colors — without this the per-row identity
    /// check would short-circuit when the underlying glyph text hasn't
    /// changed even though the resolved color did.
    pub fn invalidate_for_theme_swap(&mut self) {
        for v in self.row_valid.iter_mut() {
            *v = false;
        }
        for runs in self.row_runs.iter_mut() {
            runs.clear();
        }
        for bg in self.row_bg.iter_mut() {
            bg.clear();
        }
        for decor in self.row_decor.iter_mut() {
            decor.clear();
        }
        for block in self.row_block.iter_mut() {
            block.clear();
        }
        for y in 0..self.rows {
            self.damage.mark_row(y);
        }
    }

    /// Current foreground default — read once per frame for placeholder
    /// fallback paths. Cheap (RwLock read uncontended; bytes copied).
    fn fg_default(&self) -> [u8; 3] {
        rgb3(self.theme.read().expect("theme poisoned").foreground)
    }

    /// Grid size changed. Tear down old buffers and rebuild — cosmic-text
    /// Buffers' Metrics depend on font size which can also be changing.
    pub fn resize(&mut self, glyph: &mut GlyphStack, cols: usize, rows: usize) {
        self.row_buffers = (0..rows).map(|_| glyph.make_buffer()).collect();
        self.row_runs = vec![Vec::new(); rows];
        self.row_bg = vec![Vec::new(); rows];
        self.row_decor = vec![Vec::new(); rows];
        self.row_block = vec![Vec::new(); rows];
        self.row_valid = vec![false; rows];
        self.damage.resize(rows);
        self.cols = cols;
        self.rows = rows;
    }

    /// Rebuild every row Buffer against the GlyphStack's current Metrics.
    /// Called from `Renderer::set_font` AFTER `GlyphStack::set_font` so the
    /// new font_size / line_height baked into Metrics::new is picked up. Also
    /// clears the per-row run/bg/decor caches so the next `sync_from_term`
    /// re-shapes every row instead of short-circuiting on stale identity.
    pub fn rebuild_buffers(&mut self, glyph: &mut GlyphStack) {
        self.row_buffers = (0..self.rows).map(|_| glyph.make_buffer()).collect();
        for v in self.row_valid.iter_mut() {
            *v = false;
        }
        for runs in self.row_runs.iter_mut() {
            runs.clear();
        }
        for bg in self.row_bg.iter_mut() {
            bg.clear();
        }
        for decor in self.row_decor.iter_mut() {
            decor.clear();
        }
        for block in self.row_block.iter_mut() {
            block.clear();
        }
        for y in 0..self.rows {
            self.damage.mark_row(y);
        }
    }

    /// Refresh row buffers from the alacritty grid. Reads only — does not
    /// hold the Term lock while shaping. P3a: returns the cursor/viewport
    /// state captured under `snapshot_rows`'s Term lock so the renderer never
    /// needs a second lock acquisition in the same frame.
    pub fn sync_from_term(
        &mut self,
        glyph: &mut GlyphStack,
        term: &Arc<Mutex<Term<TermListener>>>,
    ) -> TermFrameInfo {
        let (snapshot, info) = self.snapshot_rows(term);

        // P6a-rotate: shift the slot-keyed caches by the offset delta so
        // scrolling only re-shapes the newly-exposed rows (the fallback
        // re-shaped the whole viewport per wheel notch — unusably slow).
        if info.display_offset != self.last_display_offset {
            self.rotate_for_offset_delta(
                info.display_offset as i64 - self.last_display_offset as i64,
            );
            self.last_display_offset = info.display_offset;
        }

        // P5b: shape with the pane's ACTUAL font family. One clone per sync
        // keeps the borrow simple (`set_rich_text` needs `&mut glyph` while
        // the Attrs borrow the name). `Family::Monospace` here was the
        // family-ignored bug — set_font's family string never reached the
        // shaper, so most machines rendered the system-default mono instead
        // of Hack.
        let family_name = glyph.family_name.clone();

        let len = snapshot.len().min(self.rows);
        for (y, row) in snapshot.into_iter().enumerate().take(len) {
            let RowSnapshot { runs, bg, decor, block } = row;
            // Skip re-shaping only when the slot is VALID (not newly-exposed
            // by a rotation / init / theme-swap) AND its content is byte-for-
            // byte unchanged. `row_valid[y] == false` forces a re-shape even
            // on an identity match — the aliasing guard documented on the
            // `row_valid` field.
            if self.row_valid[y]
                && self.row_runs[y] == runs
                && self.row_bg_matches(y, &bg)
                && self.row_decor_matches(y, &decor)
                && self.row_block.get(y).map(Vec::as_slice) == Some(block.as_slice())
            {
                continue;
            }
            // Apply text/Attrs to buffer via set_rich_text. We need a vec of
            // (&str, Attrs) borrowed from `runs` — build it just-in-time.
            let spans: Vec<(&str, Attrs)> = runs
                .iter()
                .map(|r| {
                    let [cr, cg, cb] = r.color;
                    let mut attrs = Attrs::new()
                        .family(Family::Name(family_name.as_str()))
                        .color(Color::rgba(cr, cg, cb, 0xFF));
                    if r.attrs.bold {
                        attrs = attrs.weight(Weight::BOLD);
                    }
                    if r.attrs.italic {
                        attrs = attrs.style(Style::Italic);
                    }
                    (r.text.as_str(), attrs)
                })
                .collect();
            // Default Attrs used for any text not covered by a span; with
            // contiguous spans this never fires, but cosmic-text requires it.
            let fg_default = self.fg_default();
            let default_attrs = Attrs::new()
                .family(Family::Name(family_name.as_str()))
                .color(Color::rgba(
                    fg_default[0],
                    fg_default[1],
                    fg_default[2],
                    0xFF,
                ));
            self.row_buffers[y].set_rich_text(
                &mut glyph.font_system,
                spans.iter().copied(),
                default_attrs,
                Shaping::Advanced,
            );
            self.row_runs[y] = runs;
            self.row_bg[y] = bg;
            self.row_decor[y] = decor;
            self.row_block[y] = block;
            self.row_valid[y] = true;
            self.damage.mark_row(y);
        }
        info
    }

    fn row_bg_matches(&self, y: usize, other: &[BgSegment]) -> bool {
        let a = &self.row_bg[y];
        a.len() == other.len()
            && a.iter().zip(other.iter()).all(|(x, y)| {
                x.col_start == y.col_start && x.col_end == y.col_end && x.color == y.color
            })
    }

    fn row_decor_matches(&self, y: usize, other: &[DecorSegment]) -> bool {
        let a = &self.row_decor[y];
        a.len() == other.len()
            && a.iter().zip(other.iter()).all(|(x, y)| {
                x.col_start == y.col_start
                    && x.col_end == y.col_end
                    && x.color == y.color
                    && x.kind == y.kind
            })
    }

    /// Pull each visible row into a sequence of color-runs + bg/decoration
    /// segments under one short lock of the Term. Trailing empty cells are
    /// dropped from runs to avoid shaping blank suffixes. P3a: also captures
    /// cursor + viewport state (`TermFrameInfo`) under the SAME lock — the
    /// renderer's only Term lock acquisition per frame.
    fn snapshot_rows(
        &self,
        term: &Arc<Mutex<Term<TermListener>>>,
    ) -> (Vec<RowSnapshot>, TermFrameInfo) {
        // Snapshot theme under its own (very short) read lock. We copy the
        // ~88-byte struct so the inner loop reads from the stack — avoids
        // holding both the term mutex and a theme RwLock guard at once and
        // keeps the per-cell hot path allocation-free.
        let theme = *self.theme.read().expect("theme poisoned");
        let fg_default_rgb = rgb3(theme.foreground);
        let bg_default_rgb = rgb3(theme.background);
        let selection_rgb = {
            // Use the theme's selection color if the alpha byte is non-zero;
            // otherwise fall back to the hard-coded default. The wire format
            // accepts #RRGGBB (alpha defaults to 0xFF in win32::set_theme) and
            // #RRGGBBAA, so a zero alpha here means parsing skipped/failed.
            if theme.selection[3] != 0 {
                rgb3(theme.selection)
            } else {
                SELECTION_BG_FALLBACK
            }
        };
        let t = term.lock().expect("CellGrid::snapshot_rows: term poisoned");
        let grid = t.grid();
        let visible_rows = grid.screen_lines();
        let visible_cols = grid.columns();
        // P3a: cursor + viewport capture, same lock as the row scan. The
        // renderer's cursor pass and FrameSnapshot dirty check both consume
        // this instead of re-locking the Term later in the frame.
        //
        // P6b wide chars: normalize the cursor to the wide-char START cell —
        // when the raw cursor sits on the trailing WIDE_CHAR_SPACER half,
        // draw it at col-1 (mirrors alacritty's RenderableCursor). Then flag
        // whether the (possibly adjusted) cell is a WIDE_CHAR so the cursor
        // pass can span 2 cells. Flags read under this same Term lock.
        let cursor_point = grid.cursor.point;
        let mut cursor_col = cursor_point.column.0;
        if cursor_col > 0
            && grid[cursor_point.line][Column(cursor_col)]
                .flags
                .contains(Flags::WIDE_CHAR_SPACER)
        {
            cursor_col -= 1;
        }
        let cursor_wide = grid[cursor_point.line][Column(cursor_col)]
            .flags
            .contains(Flags::WIDE_CHAR);
        let info = TermFrameInfo {
            cursor_col,
            cursor_line: cursor_point.line.0,
            visible_rows,
            visible_cols,
            show_cursor: t.mode().contains(TermMode::SHOW_CURSOR),
            display_offset: grid.display_offset(),
            cursor_wide,
        };
        // P6a scrollback: visible row y shows grid line (y - display_offset).
        // Offset 0 pins the live screen (lines 0..screen_lines); scrolling
        // back N exposes history lines (negative Line values) — the same
        // signed indexing `native_term_get_buffer_lines` walks.
        let display_offset = info.display_offset as i32;
        // R3-mouse: capture the live selection range as absolute (line, column)
        // bounds. Selection lines are alacritty grid lines (signed, scrollback
        // is negative). P6a: we now test cells with their TRUE grid line
        // (`Line(y - display_offset)` below), so selection containment stays
        // anchored to content — and therefore correct — while scrolled.
        let sel_range = t.selection.as_ref().and_then(|s| s.to_range(&*t));
        let mut out = Vec::with_capacity(visible_rows);
        for y in 0..visible_rows {
            let line = Line(y as i32 - display_offset);
            let mut runs: Vec<RowRun> = Vec::new();
            let mut bg_segs: Vec<BgSegment> = Vec::new();
            let mut decor_segs: Vec<DecorSegment> = Vec::new();
            let mut block_cells: Vec<BlockCell> = Vec::new();
            // Run accumulators for text spans.
            let mut current_color: Option<[u8; 3]> = None;
            let mut current_attrs: CellAttrs = CellAttrs::default();
            let mut current_text = String::new();
            // Run accumulators for bg/decoration (separate from text runs:
            // a bg run spans cells regardless of fg color).
            let mut bg_run: Option<(u16, [u8; 3])> = None; // (start_col, color)
            let mut underline_run: Option<(u16, [u8; 3])> = None;
            let mut strike_run: Option<(u16, [u8; 3])> = None;

            for x in 0..visible_cols {
                let cell: &Cell = &grid[line][Column(x)];
                let ch = if cell.c == '\u{0}' { ' ' } else { cell.c };
                let attrs = CellAttrs::from_flags(cell.flags);
                let inverse = cell.flags.contains(Flags::INVERSE);
                // P6b wide chars: spacer cells (the trailing half of a CJK
                // glyph, or the line-end LEADING spacer before a wrapped
                // one) are SKIPPED from the TEXT run — appending their ' '
                // made a double-width glyph consume ~3 cells of advance
                // (em-square glyph + spacer space). Skipping lets the wide
                // glyph advance ~2 cells naturally (Hack has no CJK;
                // cosmic-text per-glyph fallback supplies em-square faces).
                // Spacers STAY in the bg/decor/selection segment logic below
                // — they carry the wide char's background/selection color.
                // Accepted residual: a fallback face whose em-square advance
                // is not exactly 2×cell_w drifts glyphs AFTER it within the
                // row; exact per-cell alignment for wide glyphs is a future
                // per-run re-anchoring project.
                let is_spacer = cell
                    .flags
                    .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER);

                // Resolve fg / bg with INVERSE applied AFTER color resolution
                // (xterm semantics: swap the two final colors, not the inputs).
                let raw_fg = ansi_color_to_rgb(cell.fg, fg_default_rgb, &theme);
                let raw_bg = ansi_color_to_rgb_bg(cell.bg, &theme);
                let (fg, mut bg) = if inverse { (raw_bg, raw_fg) } else { (raw_fg, raw_bg) };

                // R3-mouse: selection overlay. Override bg to the selection
                // color when this cell falls inside the active selection.
                // P6a: `line` is the TRUE grid line (offset-adjusted above),
                // the same space `Selection::to_range` reports — containment
                // is exact whether or not the viewport is scrolled.
                if let Some(range) = sel_range {
                    let p = Point::new(line, Column(x));
                    if range.contains(p) {
                        bg = selection_rgb;
                    }
                }

                // --- block elements (U+2580..=U+259F) ---
                // Render these as grid-aligned quads (see build_block_quads),
                // not font glyphs: cosmic-text shapes them at advances that
                // don't match the cell grid, which sheared the Claude Code
                // logo apart. Substitute a space (default fg/attrs) in the text
                // run so it merges with blank runs and keeps the surrounding
                // glyphs on the grid; the real ink is drawn by the block quad.
                let is_block = is_block_element(ch);
                if is_block {
                    block_cells.push(BlockCell { col: x as u16, color: fg, ch });
                }
                let (text_ch, text_fg, text_attrs) = if is_block {
                    (' ', fg_default_rgb, CellAttrs::default())
                } else {
                    (ch, fg, attrs)
                };

                // --- text runs (fg color + attrs identity) ---
                // P6b: spacer cells contribute NO text (see comment above) —
                // and must not break the current run either, or a wide
                // char's spacer would split its own run on color identity.
                if !is_spacer {
                    if Some(text_fg) == current_color && text_attrs == current_attrs {
                        current_text.push(text_ch);
                    } else {
                        if !current_text.is_empty() {
                            runs.push(RowRun {
                                text: std::mem::take(&mut current_text),
                                color: current_color.unwrap_or(fg_default_rgb),
                                attrs: current_attrs,
                            });
                        }
                        current_color = Some(text_fg);
                        current_attrs = text_attrs;
                        current_text.push(text_ch);
                    }
                }

                // --- background segments (skip cells matching clear color) ---
                let want_bg = bg != bg_default_rgb;
                match (want_bg, bg_run) {
                    (true, Some((_, c))) if c == bg => { /* extend */ }
                    (true, Some((start, c))) => {
                        bg_segs.push(BgSegment { col_start: start, col_end: x as u16, color: c });
                        bg_run = Some((x as u16, bg));
                    }
                    (true, None) => bg_run = Some((x as u16, bg)),
                    (false, Some((start, c))) => {
                        bg_segs.push(BgSegment { col_start: start, col_end: x as u16, color: c });
                        bg_run = None;
                    }
                    (false, None) => {}
                }

                // --- underline segments (color = fg of the cell) ---
                match (attrs.underline, underline_run) {
                    (true, Some((_, c))) if c == fg => { /* extend */ }
                    (true, Some((start, c))) => {
                        decor_segs.push(DecorSegment {
                            col_start: start,
                            col_end: x as u16,
                            color: c,
                            kind: DecorKind::Underline,
                        });
                        underline_run = Some((x as u16, fg));
                    }
                    (true, None) => underline_run = Some((x as u16, fg)),
                    (false, Some((start, c))) => {
                        decor_segs.push(DecorSegment {
                            col_start: start,
                            col_end: x as u16,
                            color: c,
                            kind: DecorKind::Underline,
                        });
                        underline_run = None;
                    }
                    (false, None) => {}
                }

                // --- strikeout segments ---
                match (attrs.strikeout, strike_run) {
                    (true, Some((_, c))) if c == fg => { /* extend */ }
                    (true, Some((start, c))) => {
                        decor_segs.push(DecorSegment {
                            col_start: start,
                            col_end: x as u16,
                            color: c,
                            kind: DecorKind::Strikeout,
                        });
                        strike_run = Some((x as u16, fg));
                    }
                    (true, None) => strike_run = Some((x as u16, fg)),
                    (false, Some((start, c))) => {
                        decor_segs.push(DecorSegment {
                            col_start: start,
                            col_end: x as u16,
                            color: c,
                            kind: DecorKind::Strikeout,
                        });
                        strike_run = None;
                    }
                    (false, None) => {}
                }
            }

            // Flush trailing accumulators.
            if !current_text.is_empty() {
                runs.push(RowRun {
                    text: current_text,
                    color: current_color.unwrap_or(fg_default_rgb),
                    attrs: current_attrs,
                });
            }
            if let Some((start, c)) = bg_run {
                bg_segs.push(BgSegment {
                    col_start: start,
                    col_end: visible_cols as u16,
                    color: c,
                });
            }
            if let Some((start, c)) = underline_run {
                decor_segs.push(DecorSegment {
                    col_start: start,
                    col_end: visible_cols as u16,
                    color: c,
                    kind: DecorKind::Underline,
                });
            }
            if let Some((start, c)) = strike_run {
                decor_segs.push(DecorSegment {
                    col_start: start,
                    col_end: visible_cols as u16,
                    color: c,
                    kind: DecorKind::Strikeout,
                });
            }

            // Drop a trailing run that's purely default-fg-color spaces with
            // no special attrs — the most common case (blank tail of a line)
            // and shaping it costs glyph atlas slots for no visible benefit.
            // Preserved from R1.d-α; still safe because runs with bg/underline
            // attrs differ in `attrs` and bypass this check.
            if let Some(last) = runs.last() {
                if last.color == fg_default_rgb
                    && last.attrs == CellAttrs::default()
                    && last.text.chars().all(|c| c == ' ')
                {
                    runs.pop();
                }
            }
            out.push(RowSnapshot { runs, bg: bg_segs, decor: decor_segs, block: block_cells });
        }
        (out, info)
    }

    /// Build a TextArea per row, positioned at line_height * y. Lifetime tied
    /// to `&self` so the caller can pass straight into prepare(). P5a: tops
    /// are integer by construction — `line_height_px` is `.ceil()`ed in
    /// `GlyphStack::set_font_scaled`, so `y * line_height_px` is exact and
    /// glyphon never sees a fractional TextArea origin.
    pub fn text_areas<'a>(&'a self, line_height_px: f32) -> Vec<TextArea<'a>> {
        let fg = self.fg_default();
        let default_color = Color::rgba(fg[0], fg[1], fg[2], 0xFF);
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

    /// Convert per-row bg segments into QuadInstance rects in pixel space.
    /// Called every frame by `pipeline::render` BEFORE the glyph pass so
    /// background fills sit behind the text. P5a: origins/sizes are integer
    /// by construction — `cell_w` is the quantized integer advance and
    /// `line_h` is ceiled, so `col * cell_w` / `y * line_h` are exact (no
    /// per-quad rounding needed; only the raw-advance fallback path is
    /// fractional, and there correctness beats snapping).
    pub fn build_bg_quads(&self, cell_w: f32, line_h: f32) -> Vec<QuadInstance> {
        let mut out = Vec::new();
        for (y, segs) in self.row_bg.iter().enumerate() {
            for s in segs {
                let x0 = s.col_start as f32 * cell_w;
                let x1 = s.col_end as f32 * cell_w;
                let y0 = y as f32 * line_h;
                let [r, g, b] = s.color;
                out.push(QuadInstance {
                    rect: [x0, y0, (x1 - x0).max(0.0), line_h],
                    color: [
                        r as f32 / 255.0,
                        g as f32 / 255.0,
                        b as f32 / 255.0,
                        1.0,
                    ],
                });
            }
        }
        out
    }

    /// Convert per-row underline/strikeout segments into QuadInstance rects.
    /// Underlines sit just below the baseline; strikeouts cross the x-height.
    /// Both use the same instance buffer as bg quads but get drawn AFTER the
    /// glyph pass so they overlay the glyph pixels.
    pub fn build_decor_quads(&self, cell_w: f32, line_h: f32) -> Vec<QuadInstance> {
        // Heuristic placement against the line box. cosmic-text doesn't give
        // us a baseline directly here; ~85% from top for underline and ~55%
        // for strikeout is a reasonable monospace default.
        let underline_y_offset = (line_h * 0.85).round();
        let strike_y_offset = (line_h * 0.55).round();
        let thickness = (line_h * 0.07).max(1.0).round();
        let mut out = Vec::new();
        for (y, segs) in self.row_decor.iter().enumerate() {
            for s in segs {
                let x0 = s.col_start as f32 * cell_w;
                let x1 = s.col_end as f32 * cell_w;
                let row_top = y as f32 * line_h;
                let bar_y = row_top
                    + match s.kind {
                        DecorKind::Underline => underline_y_offset,
                        DecorKind::Strikeout => strike_y_offset,
                    };
                let [r, g, b] = s.color;
                out.push(QuadInstance {
                    rect: [x0, bar_y, (x1 - x0).max(0.0), thickness],
                    color: [
                        r as f32 / 255.0,
                        g as f32 / 255.0,
                        b as f32 / 255.0,
                        1.0,
                    ],
                });
            }
        }
        out
    }

    /// Convert per-row block-element cells (U+2580..=U+259F) into QuadInstance
    /// rects on the fixed cell grid — the same coordinate system as
    /// `build_bg_quads`, so the block "pixels" tile seamlessly and align to
    /// their colored cells. Drawn right after the bg quads (before the glyph
    /// pass). Shade glyphs (░▒▓) carry an alpha < 1 and alpha-blend over the bg.
    ///
    /// P5a integer snapping: the eighth/quadrant fractions are inherently
    /// sub-pixel, so each EDGE is rounded in ABSOLUTE pixel space —
    /// `x0 = round(cell_x + fx0*w)`, `x1 = round(cell_x + fx1*w)`, width =
    /// `x1 - x0` (same for vertical). Rounding edges (not origin + size)
    /// means two fills that share a fractional edge round to the SAME pixel
    /// coordinate — adjacent blocks tile with no seams and no overlaps.
    pub fn build_block_quads(&self, cell_w: f32, line_h: f32) -> Vec<QuadInstance> {
        let mut out = Vec::new();
        for (y, cells) in self.row_block.iter().enumerate() {
            let row_top = y as f32 * line_h;
            for bc in cells {
                if let Some((rects, alpha)) = block_element_fills(bc.ch) {
                    let cell_x = bc.col as f32 * cell_w;
                    let [r, g, b] = bc.color;
                    let color = [r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0, alpha];
                    for [fx0, fy0, fx1, fy1] in rects {
                        let x0 = (cell_x + fx0 * cell_w).round();
                        let x1 = (cell_x + fx1 * cell_w).round();
                        let y0 = (row_top + fy0 * line_h).round();
                        let y1 = (row_top + fy1 * line_h).round();
                        out.push(QuadInstance {
                            rect: [x0, y0, x1 - x0, y1 - y0],
                            color,
                        });
                    }
                }
            }
        }
        out
    }
}

/// Internal: one row's worth of decoded data returned by `snapshot_rows`.
struct RowSnapshot {
    runs: Vec<RowRun>,
    bg: Vec<BgSegment>,
    decor: Vec<DecorSegment>,
    block: Vec<BlockCell>,
}
