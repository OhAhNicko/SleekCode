// Glyphon-backed text rendering bundle.
//
// Owns the glyphon resources required to layout and render text on top of a
// wgpu surface: FontSystem (cosmic-text), SwashCache, Cache (glyphon's pipeline
// cache), TextAtlas (GPU glyph cache), Viewport (resolution uniform),
// TextRenderer (the actual draw pipeline).
//
// Holds the active font family + size; reset on `set_font` hot-swap so the
// next prepare() rebuilds Buffer layouts with the new metrics.
//
// API verified against `glyphon-0.6.0/src/`:
//   - `Cache::new(device)` — cache.rs:44
//   - `TextAtlas::new(device, queue, cache, format)` — text_atlas.rs:304
//   - `Viewport::new(device, cache)` then `viewport.update(queue, Resolution)` — viewport.rs:20, 46
//   - `TextRenderer::new(&mut atlas, device, MultisampleState, None)` — text_render.rs:24
//   - `prepare(device, queue, font_system, atlas, viewport, [TextArea], swash_cache)` — text_render.rs:49
//   - `render(&atlas, &viewport, &mut pass)` — text_render.rs:334

use glyphon::{
    Attrs, Buffer, Cache, Family, FontSystem, Metrics, Resolution, Shaping, SwashCache, TextArea,
    TextAtlas, TextBounds, TextRenderer, Viewport,
};
use wgpu::{Device, MultisampleState, Queue, RenderPass, TextureFormat};

/// All glyphon state needed to layout-and-draw a single native_term pane.
/// One instance per pane.
pub struct GlyphStack {
    pub font_system: FontSystem,
    pub swash_cache: SwashCache,
    pub atlas: TextAtlas,
    pub viewport: Viewport,
    pub renderer: TextRenderer,
    pub font_family: String,
    pub font_size_px: f32,
    pub line_height_px: f32,
    /// Real per-cell horizontal advance in pixels, measured via cosmic-text
    /// by shaping a representative monospace glyph ("M"). Replaces the old
    /// `font_size_px * 0.6` heuristic. Refreshed by `set_font`.
    pub cell_advance_px: f32,
}

impl GlyphStack {
    pub fn new(
        device: &Device,
        queue: &Queue,
        format: TextureFormat,
        width_px: u32,
        height_px: u32,
        font_family: String,
        font_size_px: f32,
    ) -> Self {
        let mut font_system = FontSystem::new();
        let swash_cache = SwashCache::new();
        let cache = Cache::new(device);
        let mut atlas = TextAtlas::new(device, queue, &cache, format);
        let mut viewport = Viewport::new(device, &cache);
        viewport.update(
            queue,
            Resolution {
                width: width_px.max(1),
                height: height_px.max(1),
            },
        );
        let renderer = TextRenderer::new(&mut atlas, device, MultisampleState::default(), None);

        let line_height_px = (font_size_px * 1.2).ceil();
        let cell_advance_px =
            measure_cell_advance(&mut font_system, font_size_px, line_height_px);

        Self {
            font_system,
            swash_cache,
            atlas,
            viewport,
            renderer,
            font_family,
            font_size_px,
            line_height_px,
            cell_advance_px,
        }
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
    pub fn make_buffer(&mut self) -> Buffer {
        Buffer::new(
            &mut self.font_system,
            Metrics::new(self.font_size_px, self.line_height_px),
        )
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
        self.renderer
            .prepare(
                device,
                queue,
                &mut self.font_system,
                &mut self.atlas,
                &self.viewport,
                text_areas.iter().cloned(),
                &mut self.swash_cache,
            )
            .map_err(|e| format!("glyphon prepare: {e:?}"))?;
        self.renderer
            .render(&self.atlas, &self.viewport, pass)
            .map_err(|e| format!("glyphon render: {e:?}"))?;
        Ok(())
    }

    /// Hot-swap font family + size. Caller must rebuild all Buffers with
    /// `make_buffer()` after this — old Buffers' Metrics are stale.
    pub fn set_font(&mut self, family: String, size_px: f32) {
        self.font_family = family;
        self.font_size_px = size_px;
        self.line_height_px = (size_px * 1.2).ceil();
        self.cell_advance_px =
            measure_cell_advance(&mut self.font_system, self.font_size_px, self.line_height_px);
    }
}

/// Shape a single representative monospace glyph and return its layout-glyph
/// advance ("w" in cosmic-text 0.12 — `LayoutGlyph::w`, verified against
/// `cosmic-text-0.12.1/src/layout.rs:30`). If shaping yields no glyph for any
/// reason (font missing, etc.), fall back to the legacy `size * 0.6`
/// heuristic so we never divide by zero downstream.
fn measure_cell_advance(font_system: &mut FontSystem, size_px: f32, line_h_px: f32) -> f32 {
    let mut buf = Buffer::new(font_system, Metrics::new(size_px, line_h_px));
    // Give the buffer effectively-unbounded width so the shaper doesn't wrap.
    buf.set_size(font_system, Some(f32::INFINITY), Some(line_h_px));
    buf.set_text(
        font_system,
        "M",
        Attrs::new().family(Family::Monospace),
        Shaping::Advanced,
    );
    for run in buf.layout_runs() {
        if let Some(g) = run.glyphs.first() {
            if g.w > 0.0 {
                return g.w;
            }
        }
    }
    size_px * 0.6
}

/// Default text bounds: no clipping. R1.d will compute pane-rect bounds.
#[allow(dead_code)]
pub fn no_clip_bounds() -> TextBounds {
    TextBounds::default()
}
