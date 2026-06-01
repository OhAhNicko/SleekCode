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
use alacritty_terminal::term::Term;
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
    /// Shared theme palette. Owned by Renderer; cloned into CellGrid so
    /// snapshot_rows / sync_from_term can resolve named/indexed ansi colors
    /// against the current theme. Updated atomically by `Renderer::set_theme`.
    theme: Arc<RwLock<ThemeColors>>,
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
        CellGrid {
            row_buffers,
            row_runs,
            row_bg,
            row_decor,
            theme,
            damage: DamageTracker::new(rows),
            cols,
            rows,
        }
    }

    /// Invalidate cached row data so the next `sync_from_term` re-shapes every
    /// row against the new theme palette. Called by `Renderer::set_theme`
    /// after swapping in the new colors — without this the per-row identity
    /// check would short-circuit when the underlying glyph text hasn't
    /// changed even though the resolved color did.
    pub fn invalidate_for_theme_swap(&mut self) {
        for runs in self.row_runs.iter_mut() {
            runs.clear();
        }
        for bg in self.row_bg.iter_mut() {
            bg.clear();
        }
        for decor in self.row_decor.iter_mut() {
            decor.clear();
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
        for runs in self.row_runs.iter_mut() {
            runs.clear();
        }
        for bg in self.row_bg.iter_mut() {
            bg.clear();
        }
        for decor in self.row_decor.iter_mut() {
            decor.clear();
        }
        for y in 0..self.rows {
            self.damage.mark_row(y);
        }
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
        for (y, row) in snapshot.into_iter().enumerate().take(len) {
            let RowSnapshot { runs, bg, decor } = row;
            if self.row_runs[y] == runs && self.row_bg_matches(y, &bg) && self.row_decor_matches(y, &decor) {
                continue;
            }
            // Apply text/Attrs to buffer via set_rich_text. We need a vec of
            // (&str, Attrs) borrowed from `runs` — build it just-in-time.
            let spans: Vec<(&str, Attrs)> = runs
                .iter()
                .map(|r| {
                    let [cr, cg, cb] = r.color;
                    let mut attrs = Attrs::new()
                        .family(Family::Monospace)
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
            let default_attrs = Attrs::new().family(Family::Monospace).color(Color::rgba(
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
            self.damage.mark_row(y);
        }
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
    /// dropped from runs to avoid shaping blank suffixes.
    fn snapshot_rows(&self, term: &Arc<Mutex<Term<TermListener>>>) -> Vec<RowSnapshot> {
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
        // R3-mouse: capture the live selection range as absolute (line, column)
        // bounds. Selection lines are alacritty grid lines (signed, scrollback
        // is negative); we test cells with their viewport-row Line(y) below
        // — matching the renderer's convention of rendering Line(0..screen_lines)
        // as the visible viewport regardless of display_offset.
        let sel_range = t.selection.as_ref().and_then(|s| s.to_range(&*t));
        let mut out = Vec::with_capacity(visible_rows);
        for y in 0..visible_rows {
            let line = Line(y as i32);
            let mut runs: Vec<RowRun> = Vec::new();
            let mut bg_segs: Vec<BgSegment> = Vec::new();
            let mut decor_segs: Vec<DecorSegment> = Vec::new();
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

                // Resolve fg / bg with INVERSE applied AFTER color resolution
                // (xterm semantics: swap the two final colors, not the inputs).
                let raw_fg = ansi_color_to_rgb(cell.fg, fg_default_rgb, &theme);
                let raw_bg = ansi_color_to_rgb_bg(cell.bg, &theme);
                let (fg, mut bg) = if inverse { (raw_bg, raw_fg) } else { (raw_fg, raw_bg) };

                // R3-mouse: selection overlay. Override bg to the selection
                // color when this cell falls inside the active selection. We
                // build a Point in viewport-row space (matches the renderer's
                // Line(y) iteration above) and check containment.
                if let Some(range) = sel_range {
                    let p = Point::new(line, Column(x));
                    if range.contains(p) {
                        bg = selection_rgb;
                    }
                }

                // --- text runs (fg color + attrs identity) ---
                if Some(fg) == current_color && attrs == current_attrs {
                    current_text.push(ch);
                } else {
                    if !current_text.is_empty() {
                        runs.push(RowRun {
                            text: std::mem::take(&mut current_text),
                            color: current_color.unwrap_or(fg_default_rgb),
                            attrs: current_attrs,
                        });
                    }
                    current_color = Some(fg);
                    current_attrs = attrs;
                    current_text.push(ch);
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
            out.push(RowSnapshot { runs, bg: bg_segs, decor: decor_segs });
        }
        out
    }

    /// Build a TextArea per row, positioned at line_height * y. Lifetime tied
    /// to `&self` so the caller can pass straight into prepare().
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
    /// background fills sit behind the text.
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
}

/// Internal: one row's worth of decoded data returned by `snapshot_rows`.
struct RowSnapshot {
    runs: Vec<RowRun>,
    bg: Vec<BgSegment>,
    decor: Vec<DecorSegment>,
}
