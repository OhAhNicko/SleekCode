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
use super::{RenderTuning, ThemeColors};

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

/// SGR 2 (dim / faint): fade a resolved foreground toward the background it
/// sits on by `strength` (0 = no fade, 1 = invisible).
///
/// `alacritty_terminal` parses SGR 2 into `Flags::DIM`, but the color
/// resolution above is flag-blind — so every dim run painted at FULL
/// foreground brightness. Most visibly, Claude Code's TAB-to-complete ghost
/// suggestion looked like text the user had already typed (reported
/// 2026-07-26).
///
/// Toward-the-background rather than alacritty's `* 0.66`: xterm.js draws dim
/// as alpha over the cell background, and MADE runs both renderers side by
/// side, so parity beats matching alacritty. It is also the only one of the
/// two that stays correct on light themes — a multiply drives text toward
/// black, i.e. toward MORE contrast on light paper, which is backwards.
///
/// `strength` is user-tunable (`RenderTuning::dim_strength`); the default 0.5
/// reproduces the historical halfway blend EXACTLY — `floor` of the linear
/// interpolation equals the old `(fg + bg) / 2` integer division for every
/// byte pair, and both operands are small enough to be exact in f32.
#[inline]
fn dim_toward(fg: [u8; 3], bg: [u8; 3], strength: f32) -> [u8; 3] {
    let mix = |f: u8, b: u8| -> u8 {
        (f as f32 + (b as f32 - f as f32) * strength)
            .floor()
            .clamp(0.0, 255.0) as u8
    };
    [mix(fg[0], bg[0]), mix(fg[1], bg[1]), mix(fg[2], bg[2])]
}

/// `boldIsBright`: promote an ANSI 0..=7 foreground to its bright twin
/// (slot i + 8) for BOLD cells. Anything else — a 256-color index, a truecolor
/// spec, `Foreground`/`Background`/`Cursor` — is returned untouched, so the
/// promotion can only ever affect the eight colors that HAVE a bright variant.
///
/// Applied to the cell's fg attribute BEFORE the INVERSE swap: xterm brightens
/// the foreground the SGR selected, not whichever color ends up as ink.
#[inline]
fn bright_ansi(c: AnsiColor) -> AnsiColor {
    match c {
        AnsiColor::Named(n) => {
            let bright = match n {
                NamedColor::Black => NamedColor::BrightBlack,
                NamedColor::Red => NamedColor::BrightRed,
                NamedColor::Green => NamedColor::BrightGreen,
                NamedColor::Yellow => NamedColor::BrightYellow,
                NamedColor::Blue => NamedColor::BrightBlue,
                NamedColor::Magenta => NamedColor::BrightMagenta,
                NamedColor::Cyan => NamedColor::BrightCyan,
                NamedColor::White => NamedColor::BrightWhite,
                _ => return c,
            };
            AnsiColor::Named(bright)
        }
        AnsiColor::Indexed(i) if i < 8 => AnsiColor::Indexed(i + 8),
        _ => c,
    }
}

/// sRGB → linear for one channel, per the WCAG 2.x relative-luminance
/// definition.
#[inline]
fn srgb_to_linear(v: u8) -> f32 {
    let s = v as f32 / 255.0;
    if s <= 0.03928 {
        s / 12.92
    } else {
        ((s + 0.055) / 1.055).powf(2.4)
    }
}

#[inline]
fn relative_luminance(c: [u8; 3]) -> f32 {
    0.2126 * srgb_to_linear(c[0]) + 0.7152 * srgb_to_linear(c[1]) + 0.0722 * srgb_to_linear(c[2])
}

/// WCAG contrast ratio between two opaque colors — 1.0 (identical) to 21.0
/// (black on white).
#[inline]
fn contrast_ratio(a: [u8; 3], b: [u8; 3]) -> f32 {
    let (la, lb) = (relative_luminance(a), relative_luminance(b));
    let (hi, lo) = if la >= lb { (la, lb) } else { (lb, la) };
    (hi + 0.05) / (lo + 0.05)
}

/// Raise `fg` until it reaches `target` contrast against `bg`, by stepping it
/// toward white on a dark background or toward black on a light one — the
/// direction that can actually gain contrast. Bounded to 8 steps so the cost
/// per cell stays flat; the last step IS the endpoint, so this always returns
/// the best available color even when the target is unreachable (e.g. 21:1
/// against mid-grey).
///
/// Callers must skip this entirely when `target <= 1.0`: every color pair
/// already clears 1.0, so the pass would be pure cost.
fn enforce_min_contrast(fg: [u8; 3], bg: [u8; 3], target: f32) -> [u8; 3] {
    if contrast_ratio(fg, bg) >= target {
        return fg;
    }
    let end: [u8; 3] = if relative_luminance(bg) < 0.5 {
        [0xFF, 0xFF, 0xFF]
    } else {
        [0x00, 0x00, 0x00]
    };
    const STEPS: u8 = 8;
    for step in 1..=STEPS {
        let t = step as f32 / STEPS as f32;
        let mix = |a: u8, b: u8| -> u8 {
            (a as f32 + (b as f32 - a as f32) * t).round().clamp(0.0, 255.0) as u8
        };
        let candidate = [mix(fg[0], end[0]), mix(fg[1], end[1]), mix(fg[2], end[2])];
        if contrast_ratio(candidate, bg) >= target {
            return candidate;
        }
    }
    end
}

/// Map an xterm 256-color index to RGB. Caller guarantees `i >= 16`.
///
/// A theme may replace the whole 16..=255 range — light themes must, since the
/// standard cube is a fixed set of constants picked for dark canvases and
/// renders at ~1.2:1 on paper.
fn indexed_256_to_rgb(i: u8, theme: &ThemeColors) -> [u8; 3] {
    if let Some(ext) = theme.extended.as_ref() {
        return rgb3(ext[(i - 16) as usize]);
    }
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
        AnsiColor::Indexed(i) => indexed_256_to_rgb(i, theme),
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
    /// Column this run starts at. Anchors the run's shaped text to the cell
    /// grid instead of letting it inherit the previous run's accumulated
    /// advances.
    col: u16,
    /// This run is a SINGLE glyph that does not shape to one cell width (an
    /// emoji/symbol/CJK glyph from a fallback face — see
    /// `GlyphStack::fits_cell`). It gets its own buffer at its own cell x so
    /// its odd advance can only shift itself, never the rest of the row.
    anchored: bool,
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
    /// The character sitting in the (spacer-normalized) cursor cell, with the
    /// empty-cell NUL mapped to a space. Read only by the OPAQUE block cursor,
    /// which re-draws it in `cursor_accent` on top of the block — the
    /// translucent block leaves the row's own glyph showing through and
    /// ignores this.
    pub cursor_char: char,
    /// SGR weight/slant of the cursor cell, so the re-drawn inverse glyph
    /// matches the row's own rendering of it. Without these a bold prompt
    /// visibly thins out under the cursor as it moves across.
    pub cursor_bold: bool,
    pub cursor_italic: bool,
}

/// One Buffer per visible row, kept across frames so cosmic-text can reuse
/// shape caches.
pub struct CellGrid {
    /// Per-visible-row Buffer storage. Index 0 = top of screen.
    /// Per row, the shaped buffers and the x (physical px) each is drawn at.
    /// Normally ONE entry per row covering the whole line; a row containing a
    /// glyph that is not one cell wide splits into a buffer per anchored glyph
    /// plus one per span between them (see `RowRun::anchored`).
    row_buffers: Vec<Vec<(f32, Buffer)>>,
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
    /// Shared rendering tunables, same ownership + snapshot discipline as
    /// `theme`. Updated atomically by `Renderer::set_render_opts`, which also
    /// invalidates every row so the resolved colors re-derive.
    tuning: Arc<RwLock<RenderTuning>>,
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
        _glyph: &mut GlyphStack,
        cols: usize,
        rows: usize,
        theme: Arc<RwLock<ThemeColors>>,
        tuning: Arc<RwLock<RenderTuning>>,
    ) -> Self {
        let row_buffers = (0..rows).map(|_| Vec::new()).collect();
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
            tuning,
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
    pub fn resize(&mut self, _glyph: &mut GlyphStack, cols: usize, rows: usize) {
        self.row_buffers = (0..rows).map(|_| Vec::new()).collect();
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
    pub fn rebuild_buffers(&mut self, _glyph: &mut GlyphStack) {
        // Empty, not pre-made: buffers are now built per span in
        // `sync_from_term`, which the `row_valid` reset below forces to re-run
        // for every row. Pre-allocating one buffer per row would just be
        // thrown away — and would bake the OLD metrics.
        self.row_buffers = (0..self.rows).map(|_| Vec::new()).collect();
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
        let (snapshot, info) = self.snapshot_rows(glyph, term);

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
        // ONE guard for the whole sync. The shared FontSystem's mutex is not
        // reentrant, so nothing inside this loop may call a GlyphStack method
        // that locks (`make_buffer`) — `make_buffer_with` takes the guard we
        // already hold. Uncontended in practice: all panes shape on the UI
        // thread.
        let mut font_guard = glyph
            .font_system
            .lock()
            .expect("fonts: shared FontSystem poisoned");

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
            // Shape the row into as FEW buffers as correctness allows: one per
            // maximal span of ordinary runs (which keeps the common all-ASCII
            // row at exactly one `set_rich_text`, as before), plus one per
            // anchored glyph. Each buffer records the x it must be drawn at, so
            // a glyph with an odd advance cannot push the next span off-grid.
            let cell_w = glyph.cell_advance_px;
            let mut built: Vec<(f32, Buffer)> = Vec::new();
            let mut i = 0usize;
            while i < runs.len() {
                let start = i;
                if runs[i].anchored {
                    i += 1;
                } else {
                    while i < runs.len() && !runs[i].anchored {
                        i += 1;
                    }
                }
                let spans: Vec<(&str, Attrs)> = runs[start..i]
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
                let mut buf = GlyphStack::make_buffer_with(
                    &mut font_guard,
                    glyph.font_size_px,
                    glyph.line_height_px,
                );
                buf.set_rich_text(
                    &mut font_guard,
                    spans.iter().copied(),
                    default_attrs,
                    Shaping::Advanced,
                );
                built.push((runs[start].col as f32 * cell_w, buf));
            }
            self.row_buffers[y] = built;
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
    /// `glyph` is taken mutably only for `fits_cell`, which measures a char's
    /// advance the first time it is seen and memoises it — the Term lock below
    /// is held across that, but a measurement happens at most once per distinct
    /// non-ASCII char per font.
    fn snapshot_rows(
        &self,
        glyph: &mut GlyphStack,
        term: &Arc<Mutex<Term<TermListener>>>,
    ) -> (Vec<RowSnapshot>, TermFrameInfo) {
        // Snapshot theme under its own (very short) read lock. We copy the
        // struct (~100 bytes, or ~1KB once a theme carries an adapted 256-color
        // palette) so the inner loop reads from the stack — avoids
        // holding both the term mutex and a theme RwLock guard at once and
        // keeps the per-cell hot path allocation-free.
        let theme = *self.theme.read().expect("theme poisoned");
        // Same discipline as the theme: one short read lock, copied by value
        // so the per-cell loop reads the stack copy.
        let tuning = *self.tuning.read().expect("tuning poisoned");
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
        // User preset extras (`None` = pre-preset behavior; see ThemeColors).
        let selection_fg_rgb = theme.selection_foreground.map(rgb3);
        let link_rgb = theme.link.map(rgb3);
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
        let cursor_cell = &grid[cursor_point.line][Column(cursor_col)];
        let cursor_wide = cursor_cell.flags.contains(Flags::WIDE_CHAR);
        let cursor_char = if cursor_cell.c == '\u{0}' { ' ' } else { cursor_cell.c };
        let cursor_bold = cursor_cell.flags.contains(Flags::BOLD);
        let cursor_italic = cursor_cell.flags.contains(Flags::ITALIC);
        let info = TermFrameInfo {
            cursor_col,
            cursor_line: cursor_point.line.0,
            visible_rows,
            visible_cols,
            show_cursor: t.mode().contains(TermMode::SHOW_CURSOR),
            display_offset: grid.display_offset(),
            cursor_wide,
            cursor_char,
            cursor_bold,
            cursor_italic,
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
        // Always-on link underline: per-row scratch, reused across rows.
        let mut link_text = String::new();
        let mut link_byte_cols: Vec<(usize, u16)> = Vec::new();
        let mut link_cols: Vec<bool> = Vec::new();
        for y in 0..visible_rows {
            let line = Line(y as i32 - display_offset);
            let mut runs: Vec<RowRun> = Vec::new();

            // --- always-on link underline (user decision 2026-07-24) ---
            // Pre-pass: rebuild the row's text (spacer cells contribute no
            // char, mirroring the text-run rules below) with a byte->col map,
            // scan it with the SAME link matchers the JS hover/click paths
            // use (link_scan ports them), and mark matched columns. The main
            // cell loop then forces the underline attr on those cells, so
            // links are spottable without hovering — in every CLI, matching
            // the requested xterm/native parity.
            link_text.clear();
            link_byte_cols.clear();
            link_cols.clear();
            link_cols.resize(visible_cols, false);
            for x in 0..visible_cols {
                let cell: &Cell = &grid[line][Column(x)];
                if cell
                    .flags
                    .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
                {
                    continue;
                }
                let ch = if cell.c == '\u{0}' { ' ' } else { cell.c };
                link_byte_cols.push((link_text.len(), x as u16));
                link_text.push(ch);
            }
            if link_text.contains("://") || link_text.contains('/') {
                for (bs, be) in super::link_scan::link_byte_ranges(&link_text) {
                    for &(byte_off, col) in &link_byte_cols {
                        if byte_off >= bs && byte_off < be {
                            link_cols[col as usize] = true;
                        }
                    }
                }
            }
            let mut bg_segs: Vec<BgSegment> = Vec::new();
            let mut decor_segs: Vec<DecorSegment> = Vec::new();
            let mut block_cells: Vec<BlockCell> = Vec::new();
            // Run accumulators for text spans.
            let mut current_color: Option<[u8; 3]> = None;
            let mut current_attrs: CellAttrs = CellAttrs::default();
            let mut current_text = String::new();
            let mut current_col: u16 = 0;
            // Run accumulators for bg/decoration (separate from text runs:
            // a bg run spans cells regardless of fg color).
            let mut bg_run: Option<(u16, [u8; 3])> = None; // (start_col, color)
            let mut underline_run: Option<(u16, [u8; 3])> = None;
            let mut strike_run: Option<(u16, [u8; 3])> = None;

            for x in 0..visible_cols {
                let cell: &Cell = &grid[line][Column(x)];
                let ch = if cell.c == '\u{0}' { ' ' } else { cell.c };
                let mut attrs = CellAttrs::from_flags(cell.flags);
                // Always-on link underline (see the row pre-pass above).
                // OSC 8 hyperlinked cells join the link set ONLY when a user
                // link color exists — without one they keep their historical
                // no-visual treatment (hover cursor + click only).
                let osc8_link = link_rgb.is_some() && cell.hyperlink().is_some();
                if link_cols[x] || osc8_link {
                    attrs.underline = true;
                }
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
                // `boldIsBright` rewrites the fg ATTRIBUTE first, so a bold
                // cell picks the bright slot before any swap — and only when
                // the attribute is one of the eight that has a bright twin.
                let cell_fg = if tuning.bold_uses_bright && cell.flags.contains(Flags::BOLD) {
                    bright_ansi(cell.fg)
                } else {
                    cell.fg
                };
                let raw_fg = ansi_color_to_rgb(cell_fg, fg_default_rgb, &theme);
                let raw_bg = ansi_color_to_rgb_bg(cell.bg, &theme);
                let (mut fg, mut bg) = if inverse { (raw_bg, raw_fg) } else { (raw_fg, raw_bg) };

                // SGR 2, applied AFTER the inverse swap so it always fades the
                // colour that ends up as ink, against the one that ends up as
                // paper. Selection (below) overrides bg afterwards on purpose:
                // xterm.js likewise computes dim against the cell's own
                // background, not against the selection overlay. Runs are keyed
                // on the resolved colour, so a dim span splits from its
                // neighbours here without needing a flag in `CellAttrs`.
                if cell.flags.contains(Flags::DIM) {
                    fg = dim_toward(fg, bg, tuning.dim_strength);
                }

                // User link color: recolor link text (auto-detected + OSC 8).
                // The underline/strike runs copy `fg`, so the underline
                // follows for free. Applied BEFORE the selection override so
                // selected links keep the selection's own contrast pair.
                if link_cols[x] || osc8_link {
                    if let Some(lc) = link_rgb {
                        fg = lc;
                    }
                }

                // R3-mouse: selection overlay. Override bg to the selection
                // color when this cell falls inside the active selection.
                // P6a: `line` is the TRUE grid line (offset-adjusted above),
                // the same space `Selection::to_range` reports — containment
                // is exact whether or not the viewport is scrolled.
                if let Some(range) = sel_range {
                    let p = Point::new(line, Column(x));
                    if range.contains(p) {
                        bg = selection_rgb;
                        // Selection foreground repaints selected TEXT too —
                        // xterm parity (every theme authors it; native used
                        // to silently drop it).
                        if let Some(sf) = selection_fg_rgb {
                            fg = sf;
                        }
                    }
                }

                // Minimum contrast, applied LAST — after dim, the link
                // recolor and the selection override, so it judges the pair
                // that actually reaches the screen. Gated on the tunable
                // being on: every color pair already clears 1.0, and the
                // luminance maths is the most expensive thing in this loop.
                // Runs are keyed on the resolved color, so a lifted cell
                // splits from its neighbours for free.
                if tuning.min_contrast > 1.0 {
                    fg = enforce_min_contrast(fg, bg, tuning.min_contrast);
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
                    // A glyph that does not shape to one cell drags everything
                    // after it along the row (the animated-spinner jitter).
                    // Give it its own run so it is anchored at its own cell and
                    // the text after it resumes at ITS cell — the shift can no
                    // longer propagate. Blanks are never worth the test.
                    let anchored = text_ch != ' ' && !glyph.fits_cell(text_ch);
                    if anchored {
                        if !current_text.is_empty() {
                            runs.push(RowRun {
                                text: std::mem::take(&mut current_text),
                                color: current_color.unwrap_or(fg_default_rgb),
                                attrs: current_attrs,
                                col: current_col,
                                anchored: false,
                            });
                        }
                        runs.push(RowRun {
                            text: text_ch.to_string(),
                            color: text_fg,
                            attrs: text_attrs,
                            col: x as u16,
                            anchored: true,
                        });
                        // Force the next cell to open a fresh run at its own
                        // column: leaving `current_color` set would let the
                        // following text merge into a run that starts here.
                        current_color = None;
                        current_attrs = CellAttrs::default();
                        current_col = x as u16 + 1;
                    } else if Some(text_fg) == current_color && text_attrs == current_attrs {
                        current_text.push(text_ch);
                    } else {
                        if !current_text.is_empty() {
                            runs.push(RowRun {
                                text: std::mem::take(&mut current_text),
                                color: current_color.unwrap_or(fg_default_rgb),
                                attrs: current_attrs,
                                col: current_col,
                                anchored: false,
                            });
                        }
                        current_color = Some(text_fg);
                        current_attrs = text_attrs;
                        current_col = x as u16;
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
                    col: current_col,
                    anchored: false,
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
            .flat_map(|(y, bufs)| {
                bufs.iter().map(move |(left, buf)| TextArea {
                    buffer: buf,
                    // Baked at build time from the run's start column, so a
                    // fallback glyph's odd advance cannot leak into the next
                    // span's origin.
                    left: *left,
                    top: y as f32 * line_height_px,
                    scale: 1.0,
                    bounds: TextBounds::default(),
                    default_color,
                    custom_glyphs: &[],
                })
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
    /// `text_h` is the UNSCALED glyph line box — equal to `line_h` at the
    /// default line-height scale, smaller once the user stretches the cell.
    /// cosmic-text centers the glyph box inside the taller line box
    /// (`centering_offset` in its `LayoutRunIter`), so the decorations have to
    /// be measured against the glyph box and shifted by the same amount, or an
    /// underline drifts toward the bottom of the cell as the scale grows.
    pub fn build_decor_quads(&self, cell_w: f32, line_h: f32, text_h: f32) -> Vec<QuadInstance> {
        // Heuristic placement against the glyph box. cosmic-text doesn't give
        // us a baseline directly here; ~85% from its top for underline and
        // ~55% for strikeout is a reasonable monospace default.
        let center_offset = ((line_h - text_h) * 0.5).max(0.0);
        let underline_y_offset = (center_offset + text_h * 0.85).round();
        let strike_y_offset = (center_offset + text_h * 0.55).round();
        let thickness = (text_h * 0.07).max(1.0).round();
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
