// Glyphon-backed text rendering bundle.
//
// Owns the glyphon resources required to layout and render text on top of a
// wgpu surface: FontSystem (cosmic-text), SwashCache, Cache (glyphon's pipeline
// cache), TextAtlas (GPU glyph cache), Viewport (resolution uniform),
// TextRenderer (the actual draw pipeline).
//
// Holds the active font family + size; reset on `set_font_scaled` hot-swap so
// the next prepare() rebuilds Buffer layouts with the new metrics. P5a: all
// metrics are PHYSICAL px — `set_font_scaled` is the single derivation point
// (logical px × dpr, then advance-quantized so the cell advance is integer).
//
// API verified against `glyphon-0.6.0/src/`:
//   - `Cache::new(device)` — cache.rs:44
//   - `TextAtlas::with_color_mode(device, queue, cache, format, ColorMode::Web)` — text_atlas.rs:309
//   - `Viewport::new(device, cache)` then `viewport.update(queue, Resolution)` — viewport.rs:20, 46
//   - `TextRenderer::new(&mut atlas, device, MultisampleState, None)` — text_render.rs:24
//   - `prepare(device, queue, font_system, atlas, viewport, [TextArea], swash_cache)` — text_render.rs:49
//   - `render(&atlas, &viewport, &mut pass)` — text_render.rs:334

use glyphon::{
    Attrs, Buffer, Cache, ColorMode, Family, FontSystem, Metrics, Resolution, Shaping, SwashCache,
    TextArea, TextAtlas, TextBounds, TextRenderer, Viewport,
};
use wgpu::{Device, MultisampleState, Queue, RenderPass, TextureFormat};

// P5b: embed Hack v3.003 (Warp's default terminal font — MADE targets 1:1
// Warp parity) so the native renderer's look is deterministic on every
// machine instead of depending on whether the user has Hack installed.
// Registered into the per-pane FontSystem in `GlyphStack::new` BEFORE any
// measurement — the construction-time `set_font_scaled` call measures the
// cell advance, and that measurement must shape against the bundled face.
// License: MIT-style + Bitstream Vera (redistribution permitted with license
// text) — see `src-tauri/assets/fonts/HACK-LICENSE.md`.

/// All glyphon state needed to layout-and-draw a single native_term pane.
/// One instance per pane.
pub struct GlyphStack {
    /// Shared with every other pane — see renderer/fonts.rs. NOT per pane:
    /// building one cost 60-76ms of system-font parsing each time.
    pub font_system: std::sync::Arc<std::sync::Mutex<FontSystem>>,
    pub swash_cache: SwashCache,
    pub atlas: TextAtlas,
    pub viewport: Viewport,
    pub renderer: TextRenderer,
    pub font_family: String,
    /// P5b: the parsed PRIMARY family name — first comma-separated segment
    /// of `font_family`, trimmed of whitespace/quotes ("Hack, monospace" →
    /// "Hack"). This is the name handed to cosmic-text as `Family::Name(..)`
    /// at every shaping/measure site. The raw wire string in `font_family`
    /// is never a valid fontdb lookup key — the old code sidestepped that
    /// with `Family::Monospace`, which IGNORED the requested family entirely
    /// and rendered whatever monospace face fontdb ranked first. cosmic-text
    /// falls back per-glyph automatically for coverage the primary face
    /// lacks, so no explicit fallback chain is needed here.
    pub family_name: String,
    /// PHYSICAL font size in pixels handed to cosmic-text `Metrics` — the
    /// P5a-scaled value `logical_px * dpr * quantization_scale` (see
    /// `set_font_scaled`), NOT the logical CSS px the JS wire sends. The
    /// surface is physical px, so rasterizing at this size is what makes
    /// glyphs sharp on 125%/150% displays.
    pub font_size_px: f32,
    /// PHYSICAL line height: `(font_size_px * 1.2).ceil()` — always integer,
    /// so row tops (`y * line_height_px`) are integer by construction.
    pub line_height_px: f32,
    /// Real per-cell horizontal advance in PHYSICAL pixels, measured via
    /// cosmic-text by shaping a representative monospace glyph ("M").
    /// After `set_font_scaled`'s advance quantization this is an INTEGER
    /// (unless the verify re-measure failed and the raw fallback kept the
    /// fractional advance — correct beats pretty). Refreshed by
    /// `set_font_scaled`.
    pub cell_advance_px: f32,
    /// Memo for `fits_cell`, cleared on every metric re-derivation. Keyed by
    /// char because the answer depends only on (char, current font metrics).
    cell_fit: std::collections::HashMap<char, bool>,
}

impl GlyphStack {
    pub fn new(
        device: &Device,
        queue: &Queue,
        format: TextureFormat,
        width_px: u32,
        height_px: u32,
        font_family: String,
        font_logical_px: f32,
        dpr: f32,
    ) -> Self {
        // The FontSystem is process-wide (renderer/fonts.rs): building one per
        // pane cost 60-76ms of system-font enumeration, for an identical result.
        let t0 = std::time::Instant::now();
        let font_system = super::fonts::shared();
        let t_fontsystem = t0.elapsed();
        let swash_cache = SwashCache::new();
        let cache = Cache::new(device);
        // ColorMode::Web disables glyphon's sRGB→linear text conversion so glyph
    // colors are written raw, matching the background quad + clear-color paths
    // (which also write raw sRGB values). Paired with the non-sRGB surface
    // format chosen in pipeline.rs, the whole frame stays in one consistent
    // color space — fixing the "background/text colors look off" bug. The
    // default `TextAtlas::new` uses ColorMode::Accurate, which only renders
    // correctly on an *Srgb surface. DELIBERATE — do not "fix" either half
    // (browser color parity depends on the pair).
    let mut atlas = TextAtlas::with_color_mode(device, queue, &cache, format, ColorMode::Web);
        let mut viewport = Viewport::new(device, &cache);
        viewport.update(
            queue,
            Resolution {
                width: width_px.max(1),
                height: height_px.max(1),
            },
        );
        let renderer = TextRenderer::new(&mut atlas, device, MultisampleState::default(), None);

        // Metric fields are placeholders here — `set_font_scaled` below is
        // the single derivation point (construction + every hot-swap).
        let mut stack = Self {
            font_system,
            swash_cache,
            atlas,
            viewport,
            renderer,
            font_family: String::new(),
            family_name: String::new(),
            font_size_px: font_logical_px.max(1.0),
            line_height_px: (font_logical_px.max(1.0) * 1.2).ceil(),
            cell_advance_px: font_logical_px.max(1.0) * 0.6,
            cell_fit: std::collections::HashMap::new(),
        };
        let t_gpu = t0.elapsed();
        stack.set_font_scaled(&font_family, font_logical_px, dpr);
        let line = format!(
            "[native_term] glyph_atlas: {:.1}ms = shared FontSystem {:.1} + gpu objects {:.1} + measure {:.1}",
            t0.elapsed().as_secs_f32() * 1000.0,
            t_fontsystem.as_secs_f32() * 1000.0,
            (t_gpu - t_fontsystem).as_secs_f32() * 1000.0,
            (t0.elapsed() - t_gpu).as_secs_f32() * 1000.0,
        );
        eprintln!("{line}");
        crate::debug_log::dlog(&line);
        stack
    }

    /// Update the surface size. Call on every WM_SIZE-driven reconfigure so
    /// the resolution uniform stays in sync with the wgpu surface.
    pub fn resize(&mut self, queue: &Queue, width_px: u32, height_px: u32) {
        self.viewport.update(
            queue,
            Resolution {
                width: width_px.max(1),
                height: height_px.max(1),
            },
        );
    }

    /// Build a cosmic-text Buffer ready for `set_text`. Caller can fill with
    /// text, then add to `prepare()`'s TextArea list. Allocation isn't free
    /// but cheap enough to do per-frame for the spike — R1.d will pool these
    /// per-row if profiling shows it matters.
    /// Does `ch` shape to exactly one cell width in the current font?
    ///
    /// Rows are shaped as STRINGS (`set_rich_text`), so cosmic-text lays each
    /// glyph out at its own natural advance and a glyph that is not exactly one
    /// cell wide shifts every glyph after it in that row. Hack's own glyphs are
    /// all one cell, so this only bites text that falls back to another face —
    /// most visibly Claude Code's animated spinner (✻ ✽ ✳ …), which swaps glyph
    /// every frame and made the whole status row slide back and forth
    /// (user-reported 2026-07-26). Callers give a non-fitting glyph its own run
    /// anchored at its own cell x, so it can only ever shift itself.
    ///
    /// ASCII short-circuits: the primary family is monospace by contract, so
    /// every ASCII char is one cell and never needs measuring. Everything else
    /// is measured once and memoised — the answer changes only with the font
    /// metrics, and `set_font_scaled` clears the memo.
    pub fn fits_cell(&mut self, ch: char) -> bool {
        if ch.is_ascii() {
            return true;
        }
        if let Some(&hit) = self.cell_fit.get(&ch) {
            return hit;
        }
        let adv = {
            let mut fs = self.font_system.lock().expect("fonts: shared FontSystem poisoned");
            measure_char_advance(
                &mut fs,
                &self.family_name,
                self.font_size_px,
                self.line_height_px,
                ch,
            )
        };
        // A tolerance rather than equality: the advance quantization in
        // `set_font_scaled` leaves sub-pixel slack, and a fraction of a pixel
        // never reads as movement. Anything past a few percent of a cell does.
        let fits = (adv - self.cell_advance_px).abs() <= self.cell_advance_px * 0.05;
        self.cell_fit.insert(ch, fits);
        fits
    }

    /// `make_buffer` for a caller that ALREADY holds the FontSystem guard.
    /// The mutex is not reentrant, so a row-shaping loop must take the guard
    /// once and use this instead of `make_buffer`.
    pub fn make_buffer_with(fs: &mut FontSystem, font_size_px: f32, line_height_px: f32) -> Buffer {
        Buffer::new(fs, Metrics::new(font_size_px, line_height_px))
    }

    /// Single-shot prepare+render path for a list of `TextArea`s. The
    /// canonical "draw text this frame" call from `pipeline::render`.
    pub fn prepare_and_render<'pass>(
        &'pass mut self,
        device: &Device,
        queue: &Queue,
        text_areas: &[TextArea<'pass>],
        pass: &mut RenderPass<'pass>,
    ) -> Result<(), String> {
        {
            let mut fs = self.font_system.lock().expect("fonts: shared FontSystem poisoned");
            self.renderer
                .prepare(
                    device,
                    queue,
                    &mut fs,
                    &mut self.atlas,
                    &self.viewport,
                    text_areas.iter().cloned(),
                    &mut self.swash_cache,
                )
                .map_err(|e| format!("glyphon prepare: {e:?}"))?;
        }
        self.renderer
            .render(&self.atlas, &self.viewport, pass)
            .map_err(|e| format!("glyphon render: {e:?}"))?;
        Ok(())
    }

    /// P5a text sharpness — the SINGLE metric-derivation entry point, called
    /// from construction and every font/dpr hot-swap. Caller must rebuild all
    /// Buffers with `make_buffer()` after this — old Buffers' Metrics are
    /// stale.
    ///
    /// Physical-pixel rasterization + advance quantization:
    ///   1. `font_px_raw = logical_px * dpr` — the surface is PHYSICAL px, so
    ///      the font must be rasterized at physical size (the old code handed
    ///      glyphon the logical 14.0, so on a 125%/150% display every glyph
    ///      rasterized at the wrong size and came out soft).
    ///   2. Measure the real cell advance AT that physical size, then
    ///      `advance_int = max(1, round(advance_raw))` and scale the FONT by
    ///      `clamp(advance_int / advance_raw, 0.95, 1.05)` so its natural
    ///      advance IS the integer. Do NOT "simplify" this to rounding only
    ///      the grid advance: cosmic-text lays each row as ONE continuous
    ///      Buffer using the font's true advance — rounding only the grid
    ///      value drifts ~0.5px per column across a row. Scaling the font
    ///      makes cosmic-text and the quad grid agree exactly and makes
    ///      glyphon's per-glyph rounding a no-op (identical stems in every
    ///      column).
    ///   3. Verify by re-measuring at the scaled size; if the advance moved
    ///      more than 0.05px off the integer target (non-linear hinting /
    ///      fallback font), fall back to `font_px_raw` with the RAW
    ///      fractional advance — correct beats pretty.
    ///
    /// Final metrics:
    ///   - `cell_advance_px` = `advance_int` (or raw fallback)
    ///   - `line_height_px`  = `(font_px * 1.2).ceil()` — integer either way
    ///
    /// Known accepted residuals: glyphs whose advance is not the monospace
    /// cell (CJK doublewidth, emoji) still drift fractionally within a row;
    /// subpixel/ClearType rendering is impossible under glyphon (its atlas is
    /// single-channel alpha) — do not attempt it here.
    pub fn set_font_scaled(&mut self, family: &str, logical_px: f32, dpr: f32) {
        self.font_family = family.to_string();
        // Every cached answer was measured against the OLD metrics.
        self.cell_fit.clear();
        // P5b: parse the primary family name once per swap — every shaping
        // and measure site below (and in grid.rs) uses `Family::Name` with
        // this, so the measured advance and the drawn glyphs come from the
        // SAME face.
        self.family_name = parse_family_name(family);
        let dpr = if dpr > 0.0 { dpr } else { 1.0 };
        let logical_px = logical_px.max(1.0);
        let font_px_raw = logical_px * dpr;
        let line_h_raw = (font_px_raw * 1.2).ceil();
        let advance_raw = {
            let mut fs = self.font_system.lock().expect("fonts: shared FontSystem poisoned");
            measure_cell_advance(&mut fs, &self.family_name, font_px_raw, line_h_raw)
        };
        let advance_int = {
            let rounded = advance_raw.round().max(1.0);
            // Warp-parity bias: never quantize the font DOWN — shrinking to
            // reach a lower integer advance thins strokes (verified thinner
            // than Warp side-by-side). If rounding would shrink, take the
            // next integer UP instead; the verify below still guards faces
            // that don't scale linearly (falls back to raw + fractional).
            if rounded < advance_raw {
                rounded + 1.0
            } else {
                rounded
            }
        };
        let scale = (advance_int / advance_raw).clamp(1.0, 1.06);
        let font_px = font_px_raw * scale;
        let line_h_scaled = (font_px * 1.2).ceil();
        let advance_check = {
            let mut fs = self.font_system.lock().expect("fonts: shared FontSystem poisoned");
            measure_cell_advance(&mut fs, &self.family_name, font_px, line_h_scaled)
        };
        if (advance_check - advance_int).abs() > 0.05 {
            // Verify failed — the face doesn't scale linearly enough (or the
            // 5% clamp stopped short of the integer). Keep the RAW physical
            // size + fractional advance so text and grid still agree.
            self.font_size_px = font_px_raw;
            self.line_height_px = line_h_raw;
            self.cell_advance_px = advance_raw;
        } else {
            self.font_size_px = font_px;
            self.line_height_px = line_h_scaled;
            self.cell_advance_px = advance_int;
        }
    }
}

/// P5b: extract the primary family name from a CSS-style comma-separated
/// family list — first segment, trimmed of whitespace and surrounding
/// quotes: `"Hack, monospace"` → `Hack`, `'Cascadia Code', monospace` →
/// `Cascadia Code`. An empty/blank wire string falls back to "Hack" (the
/// bundled default) so shaping always targets a real, deterministic face.
fn parse_family_name(family: &str) -> String {
    let name = family
        .split(',')
        .next()
        .unwrap_or("")
        .trim()
        .trim_matches(|c| c == '"' || c == '\'')
        .trim();
    if name.is_empty() {
        "Hack".to_string()
    } else {
        name.to_string()
    }
}

/// Shape a single representative monospace glyph and return its layout-glyph
/// advance ("w" in cosmic-text 0.12 — `LayoutGlyph::w`, verified against
/// `cosmic-text-0.12.1/src/layout.rs:30`). P5b: shapes with the parsed
/// primary family (`Family::Name`) so the measured advance comes from the
/// face that actually renders — `Family::Monospace` ignored the requested
/// family and measured whatever fontdb ranked first. If shaping yields no
/// glyph for any reason (font missing, etc.), fall back to the legacy
/// `size * 0.6` heuristic so we never divide by zero downstream.
fn measure_cell_advance(
    font_system: &mut FontSystem,
    family_name: &str,
    size_px: f32,
    line_h_px: f32,
) -> f32 {
    let adv = measure_char_advance(font_system, family_name, size_px, line_h_px, 'M');
    if adv > 0.0 {
        adv
    } else {
        size_px * 0.6
    }
}

/// Total shaped advance of a single char, in the same physical px as
/// `cell_advance_px`. Returns 0.0 if the char shapes to nothing.
///
/// Sums the run's glyph widths rather than taking the first: one char can shape
/// to several glyphs, and it is the TOTAL advance that decides how far the rest
/// of the row gets pushed.
fn measure_char_advance(
    font_system: &mut FontSystem,
    family_name: &str,
    size_px: f32,
    line_h_px: f32,
    ch: char,
) -> f32 {
    let mut tmp = [0u8; 4];
    let mut buf = Buffer::new(font_system, Metrics::new(size_px, line_h_px));
    // Give the buffer effectively-unbounded width so the shaper doesn't wrap.
    buf.set_size(font_system, Some(f32::INFINITY), Some(line_h_px));
    buf.set_text(
        font_system,
        ch.encode_utf8(&mut tmp),
        Attrs::new().family(Family::Name(family_name)),
        Shaping::Advanced,
    );
    let mut total = 0.0;
    for run in buf.layout_runs() {
        for g in run.glyphs {
            total += g.w;
        }
    }
    total
}

/// Default text bounds: no clipping. R1.d will compute pane-rect bounds.
#[allow(dead_code)]
pub fn no_clip_bounds() -> TextBounds {
    TextBounds::default()
}
