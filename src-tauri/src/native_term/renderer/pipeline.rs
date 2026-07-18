// R1.b renderer: wgpu surface + glyphon text pass.
//
// Phase 0 used a hardcoded 4-quad colored flag to prove the HWND + wgpu
// pipeline path; R1.b replaces that with a real text renderer driven by
// glyphon. The Phase-0 vertex/shader machinery is gone — glyphon owns its
// own pipeline and shader (`glyphon-0.6.0/src/shader.wgsl`).
//
// Sub-deliverable boundaries:
//   - R1.b: surface + glyphon stack + static "Hello, MADE" fallback when no
//     Term is attached. If a Term IS attached (via `attach_term`), render its
//     visible grid.
//   - R1.c: `attach_term` wires from the new `native_term_attach_pty` cmd.
//   - R1.d: per-cell SGR colors, background quads, cursor pass.

use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

use alacritty_terminal::term::Term;
use glyphon::{Attrs, Buffer, Family, Shaping, TextArea, TextBounds};
use raw_window_handle::{RawDisplayHandle, RawWindowHandle};

use super::super::parser_bridge::TermListener;
use super::super::window::Rect;
use super::cursor::CursorStyle;
use super::glyph_atlas::GlyphStack;
use super::grid::{CellGrid, TermFrameInfo};
use super::quad_pipeline::{QuadInstance, QuadPipeline};
use super::ThemeColors;

/// Static text shown on the no-Term placeholder path (pre-`attach_term`).
/// Shared by construction and `rebuild_placeholder` so the two build sites
/// can never drift.
const PLACEHOLDER_TEXT: &str =
    "Hello, MADE — native_term R1.b alive\n(no PTY attached yet)";

/// P3a frame-scheduler stage 1: externally-visible state that can change the
/// rendered output WITHOUT marking any row in the damage bitset. Compared
/// against the previous rendered frame's snapshot in `render()` — any
/// difference dirties the frame. Row content/selection changes are already
/// covered by `CellGrid`'s damage tracking (`snapshot_rows` folds the
/// selection overlay into row bg identity), so this covers the rest: cursor
/// movement without content change (arrow keys), blink phase flips,
/// DECSET-25 show/hide, style/focus swaps, wheel-scroll display offset, and
/// search-highlight swaps (via a generation counter — comparing rect Vecs
/// per-frame would defeat the point of a cheap check).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct FrameSnapshot {
    /// Cursor (line, column); `None` when no Term is attached.
    cursor_point: Option<(i32, usize)>,
    /// DECSET 25 SHOW_CURSOR mode bit.
    show_cursor: bool,
    /// Blink phase (true = visible half-period).
    cursor_visible: bool,
    cursor_style: CursorStyle,
    focused: bool,
    /// Scrollback display offset (0 = pinned to bottom).
    display_offset: usize,
    /// Search-highlight generation; bumped by set/clear_search_highlights.
    search_gen: u64,
    /// P6b: cursor sits on a double-width (WIDE_CHAR) cell — Block/
    /// Underline/hollow cursors span 2 cells, so a narrow↔wide flip is a
    /// visible change even at an unchanged cursor point.
    cursor_wide: bool,
}

/// Outcome of a `render()` call so the platform paint handler can tell
/// whether a frame was actually PRESENTED. With the 16ms pump gone (P3b),
/// nothing regenerates a WM_PAINT for free — a frame that did not present
/// after a SurfaceError::Lost/Outdated reconfigure must be retried
/// explicitly by the caller or an idle pane can show a stale/garbage
/// swapchain buffer indefinitely.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RenderOutcome {
    /// A frame was rendered and presented.
    Presented,
    /// Clean-frame early-out: nothing dirty, nothing presented. The
    /// flip-model swapchain retains the previous (valid) buffer — no retry
    /// needed.
    SkippedClean,
    /// `get_current_texture` failed with Lost/Outdated: the surface was
    /// reconfigured and NOTHING was presented. Damage/force/snapshot state
    /// is preserved, so the caller must schedule a bounded retry paint —
    /// the retry re-evaluates as dirty and redraws.
    SkippedLost,
}

pub struct Renderer {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    glyph: GlyphStack,
    /// Optional attached parser-bridge Term. When None, render the static
    /// "Hello, MADE" placeholder buffer so the spike pane has something to
    /// show during R1.b before R1.c wires `attach_term`.
    grid: Option<CellGrid>,
    term: Option<Arc<Mutex<Term<TermListener>>>>,
    /// P2a: dedicated instanced-quad pipeline for the cursor pass (focused
    /// bar/block/underline is 1 quad; the unfocused hollow outline is 4 edge
    /// quads). Replaces the old single-quad `CursorPipeline` — QuadPipeline
    /// alpha-blends, which the 0.30-alpha focused block needs, and instancing
    /// batches the outline in one draw.
    cursor_quads: QuadPipeline,
    /// Shared instanced-quad pipeline used for per-cell backgrounds (drawn
    /// BEFORE glyphon) and decorations like underline / strikeout (drawn
    /// AFTER glyphon). The single struct holds two GPU draws per frame —
    /// one bg pass, one decor pass — by re-uploading the instance buffer
    /// between them.
    bg_quads: QuadPipeline,
    decor_quads: QuadPipeline,
    /// Dedicated quad pipeline for block-element glyphs (U+2580..=U+259F),
    /// drawn right after `bg_quads` and before the glyph pass. Kept separate so
    /// it owns its own uploaded instance buffer (same rationale as
    /// `search_quads`). See `CellGrid::build_block_quads`.
    block_quads: QuadPipeline,
    /// Placeholder Buffer used in the no-Term path. Pre-built once in `new`
    /// so render() doesn't re-shape every frame.
    placeholder_buffer: Buffer,
    /// Surface clear color used as the default background. Cells whose bg
    /// matches this color skip emitting a quad (saves overdraw on blank
    /// regions); cells with a non-default bg are filled by `bg_quads`.
    /// Recomputed from `theme.background` on every `set_theme` call.
    bg_clear: wgpu::Color,
    /// Shared per-renderer palette. Wrapped in `Arc<RwLock>` so the
    /// `CellGrid`'s snapshot loop can read the current colors without us
    /// re-passing them through `attach_term` on every theme swap. The
    /// CellGrid clones the Arc on construction.
    theme: Arc<RwLock<ThemeColors>>,
    /// Active cursor visual style. Mutated by `set_cursor_style`.
    cursor_style: CursorStyle,
    /// True when the cursor should be blinking. When false, the cursor is
    /// drawn every frame (no toggle).
    cursor_blink: bool,
    /// Current blink phase (true = visible). P2a: blink ownership moved OUT
    /// of `render()` — the win32 BLINK timer drives `toggle_blink_phase`
    /// each half-period, and `reset_blink_visible` pins the phase visible
    /// whenever the timer is killed. `render()` only reads this flag.
    cursor_visible: bool,
    /// P2a: does this pane's HWND own keyboard focus? Only the focused pane
    /// blinks; unfocused panes draw a static hollow-outline cursor that
    /// ignores the blink phase. Set via `set_focused`.
    focused: bool,
    /// Device-pixel ratio, seeded by `Renderer::new` and updated by
    /// `set_scale` (win32 calls it on every resize). P5a: drives PHYSICAL-
    /// pixel font rasterization — a real dpr change re-derives the glyph
    /// metrics via `GlyphStack::set_font_scaled` and rebuilds every row
    /// Buffer. Also scales cursor bar/outline thickness so the cursor stays
    /// ~2 logical px on high-DPI monitors.
    dpr: f32,
    /// LOGICAL CSS-px font size as sent over the JS wire (`set_font`).
    /// Stored so a dpr change (`set_scale`) can re-derive the physical
    /// metrics from the same logical size. The PHYSICAL size actually handed
    /// to cosmic-text lives on `GlyphStack::font_size_px`.
    font_logical_px: f32,
    /// Pane-local search highlight rects (overlay marks drawn between the bg
    /// quads and the glyph pass). Set by `set_search_highlights`, cleared by
    /// `clear_search_highlights`. P6a: coordinates are pane-local CONTENT-
    /// space pixels as emitted by `native_term_search` (y = absolute grid
    /// line × physical cell_h, negative for history rows); `render()`
    /// translates by display_offset × line_h per frame and clips rows
    /// outside the viewport, so highlights stay glued to their text while
    /// the user scrolls.
    search_highlights: Vec<Rect>,
    /// Dedicated quad pipeline for search highlight overlays. We keep it
    /// separate from `bg_quads`/`decor_quads` so each pipeline owns its own
    /// uploaded instance buffer — sharing would force ordering hacks.
    search_quads: QuadPipeline,
    /// P3a: set by EVERY externally-visible mutation (resize, resize_grid,
    /// theme/font/cursor-style/focus swaps, blink toggles, search-highlight
    /// changes, attach/detach, dpr change, win32 show via
    /// `force_next_frame`) so the next `render()` draws even when the damage
    /// bitset and FrameSnapshot comparison both say "clean". Cleared only
    /// after a successful present — the SurfaceError::Lost/Outdated
    /// reconfigure-and-skip path deliberately leaves it (and the damage bits
    /// + `last_snapshot`) untouched so the retry frame stays dirty.
    force_render: bool,
    /// P3a: FrameSnapshot of the last successfully RENDERED frame. `None`
    /// until the first present so the first frame is always dirty.
    last_snapshot: Option<FrameSnapshot>,
    /// P3a: search-highlight generation counter — bumped by
    /// `set_search_highlights` / `clear_search_highlights` so the
    /// FrameSnapshot comparison catches overlay swaps cheaply.
    search_gen: u64,

    // =====================================================================
    // P0 perf instrumentation — plain counters, measurement only (no effect
    // on render behavior). Snapshotted by `PlatformWindow::debug_stats`.
    // Fields are `pub` so the win32 wrapper can read them and later phases
    // can wire the not-yet-incremented ones without new accessors.
    // =====================================================================
    /// Total frames fully rendered + presented by `render()`.
    pub frames_rendered: u64,
    /// Frames skipped because nothing was dirty. LIVE as of P3a — the
    /// clean-frame early-out in `render()` increments it on every skip.
    pub frames_skipped_clean: u64,
    /// CPU-side cost of the most recent completed `render()` call, in ms.
    pub last_frame_cpu_ms: f32,
    /// EWMA (alpha 0.1) of `last_frame_cpu_ms`. Seeded with the first
    /// frame's cost so early readings aren't dragged toward 0.
    pub frame_cpu_ms_ewma: f32,
    /// Number of `surface.configure` calls after construction (resize +
    /// the SurfaceError::Lost/Outdated reconfigure path).
    pub configures: u64,
    // P3b: the wakes_posted / wakes_coalesced counters that were reserved
    // here in P0 now live on `parser_bridge::RenderWake` — the parser worker
    // (a different thread) increments them, so they must be atomics shared
    // via the wake Arc, not plain fields on the render-thread-owned
    // Renderer. `PlatformWindow::debug_stats` reads the wake atomics
    // directly into the DebugStats wire struct.
}

impl Renderer {
    pub fn new(
        rwh: RawWindowHandle,
        rdh: RawDisplayHandle,
        width_px: u32,
        height_px: u32,
        dpr: f32,
    ) -> Result<Self, String> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::DX12 | wgpu::Backends::VULKAN | wgpu::Backends::METAL,
            ..Default::default()
        });

        // SAFETY: caller (window/win32.rs) ensures the underlying HWND lives
        // at least as long as this Renderer. Renderer is dropped BEFORE
        // DestroyWindow in PlatformWindow::destroy (verified Phase 0).
        struct HandleHolder {
            rwh: RawWindowHandle,
            rdh: RawDisplayHandle,
        }
        unsafe impl Send for HandleHolder {}
        unsafe impl Sync for HandleHolder {}
        impl raw_window_handle::HasWindowHandle for HandleHolder {
            fn window_handle(
                &self,
            ) -> Result<raw_window_handle::WindowHandle<'_>, raw_window_handle::HandleError> {
                Ok(unsafe { raw_window_handle::WindowHandle::borrow_raw(self.rwh) })
            }
        }
        impl raw_window_handle::HasDisplayHandle for HandleHolder {
            fn display_handle(
                &self,
            ) -> Result<raw_window_handle::DisplayHandle<'_>, raw_window_handle::HandleError> {
                Ok(unsafe { raw_window_handle::DisplayHandle::borrow_raw(self.rdh) })
            }
        }

        let holder = HandleHolder { rwh, rdh };
        let surface = unsafe {
            instance.create_surface_unsafe(
                wgpu::SurfaceTargetUnsafe::from_window(&holder)
                    .map_err(|e| format!("SurfaceTargetUnsafe::from_window: {e}"))?,
            )
        }
        .map_err(|e| format!("create_surface_unsafe: {e}"))?;

        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            force_fallback_adapter: false,
        }))
        .or_else(|| {
            pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::LowPower,
                compatible_surface: Some(&surface),
                force_fallback_adapter: true,
            }))
        })
        .ok_or_else(|| "no compatible wgpu adapter".to_string())?;

        let (device, queue) = pollster::block_on(adapter.request_device(
            &wgpu::DeviceDescriptor {
                label: Some("native_term R1 device"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::downlevel_defaults(),
                memory_hints: wgpu::MemoryHints::Performance,
            },
            None,
        ))
        .map_err(|e| format!("request_device: {e}"))?;

        let caps = surface.get_capabilities(&adapter);
        // Pick a NON-sRGB (linear) surface explicitly so the GPU performs no
        // linear→sRGB re-encode on write. Combined with glyphon's
        // ColorMode::Web (no text color conversion) and the raw quad/clear
        // color paths, the whole frame stays in one consistent sRGB-value
        // space — matching the xterm/canvas pane. The previous code accepted
        // EITHER Bgra8Unorm or Bgra8UnormSrgb (whichever the adapter listed
        // first), which was non-deterministic across backends and broke the
        // text-vs-background color match. Choosing the format here makes it
        // deterministic.
        let format = [
            wgpu::TextureFormat::Bgra8Unorm,
            wgpu::TextureFormat::Rgba8Unorm,
        ]
        .into_iter()
        .find(|f| caps.formats.contains(f))
        .unwrap_or(caps.formats[0]);

        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: width_px.max(1),
            height: height_px.max(1),
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 2,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
        };
        surface.configure(&device, &config);

        // R1.b: hardcoded font + size + bg. R1.c receives these via CreateOpts
        // (set_font right after create). P5a: 14.0 is the LOGICAL default —
        // GlyphStack::set_font_scaled derives the physical rasterization size
        // from logical × dpr with advance quantization.
        let dpr = if dpr > 0.0 { dpr } else { 1.0 };
        let mut glyph = GlyphStack::new(
            &device,
            &queue,
            format,
            width_px,
            height_px,
            "Hack, monospace".to_string(),
            14.0,
            dpr,
        );

        // Build the static placeholder buffer once. Visible in the spike pane
        // until R1.c calls `attach_term`.
        let mut placeholder_buffer = glyph.make_buffer();
        // P5b: shape with the parsed primary family (construction just set
        // it via `set_font_scaled`) — `Family::Monospace` ignored the
        // requested family and rendered whatever mono face fontdb ranked
        // first. Disjoint field borrows of `glyph` keep this one call.
        placeholder_buffer.set_text(
            &mut glyph.font_system,
            PLACEHOLDER_TEXT,
            Attrs::new().family(Family::Name(&glyph.family_name)),
            Shaping::Advanced,
        );

        let cursor_quads = QuadPipeline::new(&device, format);
        let bg_quads = QuadPipeline::new(&device, format);
        let decor_quads = QuadPipeline::new(&device, format);
        let block_quads = QuadPipeline::new(&device, format);
        let search_quads = QuadPipeline::new(&device, format);

        let theme_init = ThemeColors::default_tango();
        let bg_clear = color_to_wgpu(theme_init.background);
        let theme = Arc::new(RwLock::new(theme_init));

        Ok(Self {
            surface,
            device,
            queue,
            config,
            glyph,
            grid: None,
            term: None,
            cursor_quads,
            bg_quads,
            decor_quads,
            block_quads,
            placeholder_buffer,
            bg_clear,
            theme,
            cursor_style: CursorStyle::Bar,
            cursor_blink: false,
            cursor_visible: true,
            focused: false,
            dpr,
            font_logical_px: 14.0,
            search_highlights: Vec::new(),
            search_quads,
            // P3a: first frame must draw unconditionally (nothing presented
            // yet). `last_snapshot: None` would catch it too — belt and
            // suspenders.
            force_render: true,
            last_snapshot: None,
            search_gen: 0,
            frames_rendered: 0,
            frames_skipped_clean: 0,
            last_frame_cpu_ms: 0.0,
            frame_cpu_ms_ewma: 0.0,
            configures: 0,
        })
    }

    /// Current surface dimensions in PHYSICAL pixels, straight from the wgpu
    /// SurfaceConfiguration. Used by `PlatformWindow::debug_stats`.
    pub fn surface_size(&self) -> (u32, u32) {
        (self.config.width, self.config.height)
    }

    /// Hot-swap the active font family + size. `size_px` is LOGICAL CSS px
    /// (the JS wire value) — P5a derives the physical rasterization size via
    /// `GlyphStack::set_font_scaled` with the stored dpr. Updates the
    /// GlyphStack's Metrics (so future Buffer constructions pick up the new
    /// size) and rebuilds every existing row Buffer in the CellGrid — old
    /// Buffers were constructed with the previous Metrics and would render
    /// at the wrong size otherwise. Caller must follow up with an
    /// `InvalidateRect` (or equivalent) so the next paint picks the new
    /// metrics up.
    pub fn set_font(&mut self, family: String, size_px: f32) {
        self.font_logical_px = size_px;
        self.glyph.set_font_scaled(&family, size_px, self.dpr);
        if let Some(grid) = self.grid.as_mut() {
            grid.rebuild_buffers(&mut self.glyph);
        }
        // The pre-attach placeholder is a Buffer too — same stale-Metrics
        // rule as the grid rows.
        self.rebuild_placeholder();
        // P3a: font swap is externally visible even on the no-grid
        // placeholder path (metrics changed) — never let the clean-frame
        // early-out swallow it.
        self.force_render = true;
    }

    /// Rebuild the pre-attach placeholder Buffer with the CURRENT glyph
    /// metrics + primary family — the same construction path `new` uses.
    /// Buffers bake the Metrics they were created with, so every metric
    /// re-derivation (`set_font`, `set_scale`) must rebuild this one too or
    /// the no-Term placeholder keeps rendering at construction-time size
    /// after a hot-swap.
    fn rebuild_placeholder(&mut self) {
        self.placeholder_buffer = self.glyph.make_buffer();
        // P5b: shape with the parsed primary family, mirroring `new` —
        // disjoint field borrows of `glyph` (mut font_system + shared
        // family_name) keep this one call.
        self.placeholder_buffer.set_text(
            &mut self.glyph.font_system,
            PLACEHOLDER_TEXT,
            Attrs::new().family(Family::Name(&self.glyph.family_name)),
            Shaping::Advanced,
        );
    }

    /// Read the current per-cell metrics (horizontal advance, line height) in
    /// FINAL PHYSICAL surface pixels — post-P5a these are the dpr-scaled,
    /// advance-quantized values (integer advance unless the quantization
    /// fallback kept a fractional one). Used by the win32 wrapper so the
    /// wnd_proc's cell-coord math, the ChildState mirrors, and the Run A
    /// propose/commit_dims/search consumers all stay in sync with what the
    /// renderer actually draws.
    pub fn cell_metrics(&self) -> (f32, f32) {
        (self.glyph.cell_advance_px, self.glyph.line_height_px)
    }

    /// Rescale the glyph pipeline for a new device-pixel ratio. P5a: a REAL
    /// dpr change re-derives the physical font metrics from the stored
    /// logical size (`GlyphStack::set_font_scaled`), rebuilds every row
    /// Buffer (old Buffers bake the previous Metrics; `rebuild_buffers` also
    /// marks all rows damaged), and forces the next frame. Guarded on actual
    /// change because win32 re-sends an unchanged dpr on every JS resize
    /// call — re-deriving there would re-shape the whole grid per resize
    /// tick for no visible difference. The dpr also feeds cursor bar/outline
    /// thickness.
    pub fn set_scale(&mut self, dpr: f32) {
        let new = if dpr > 0.0 { dpr } else { 1.0 };
        if new == self.dpr {
            return;
        }
        self.dpr = new;
        let family = self.glyph.font_family.clone();
        self.glyph.set_font_scaled(&family, self.font_logical_px, new);
        if let Some(grid) = self.grid.as_mut() {
            grid.rebuild_buffers(&mut self.glyph);
        }
        // Same stale-Metrics rule as the grid rows: the placeholder Buffer
        // baked the pre-rescale Metrics.
        self.rebuild_placeholder();
        self.force_render = true;
    }

    /// Hot-swap the cursor visual style + blink behaviour. Parses the wire
    /// string ("bar" | "block" | "underline" — anything else falls back to
    /// "bar") and resets the blink phase so the cursor starts visible
    /// immediately after the swap.
    pub fn set_cursor_style(&mut self, style: &str, blink: bool) {
        self.cursor_style = CursorStyle::parse(style);
        self.cursor_blink = blink;
        self.cursor_visible = true;
        // P3a: style/visibility live in the FrameSnapshot, but force anyway —
        // the snapshot only compares against the last RENDERED frame, and an
        // explicit force keeps every mutator self-sufficient.
        self.force_render = true;
    }

    /// P2a: focus flag. Focus gain resets the blink phase so the cursor is
    /// solid immediately; focus loss also pins the phase visible — the
    /// unfocused hollow outline ignores phase, and pinning guarantees the
    /// cursor can't strand hidden if the pane regains focus mid-phase.
    pub fn set_focused(&mut self, focused: bool) {
        self.focused = focused;
        self.reset_blink_visible();
        // P3a: solid ↔ hollow cursor swap must render (reset_blink_visible
        // above also forces — explicit here per the every-mutator rule).
        self.force_render = true;
    }

    /// P2a: flip the blink phase. Called from the win32 BLINK timer each
    /// half-period; `render()` only reads `cursor_visible`.
    pub fn toggle_blink_phase(&mut self) {
        // While the TUI hides the cursor via DECSET 25 (last RENDERED frame
        // had show_cursor == false — e.g. vim), a phase flip changes nothing
        // visible. Skip the flip AND the force so the tick's invalidation
        // takes the clean-frame early-out instead of burning a full
        // sync+upload+present frame every 530ms. Pin the phase visible so
        // the cursor reappears in the visible half-phase when DECSET 25
        // re-shows it (that flip itself dirties via the FrameSnapshot's
        // show_cursor field).
        if let Some(s) = self.last_snapshot {
            if !s.show_cursor {
                self.cursor_visible = true;
                return;
            }
        }
        self.cursor_visible = !self.cursor_visible;
        // P3a: each half-period flip is a visible change (cursor on/off).
        self.force_render = true;
    }

    /// P2a: pin the blink phase visible. Called on focus gain and whenever
    /// the win32 BLINK timer is killed so a paused cursor never strands in
    /// the hidden half-phase.
    pub fn reset_blink_visible(&mut self) {
        self.cursor_visible = true;
        // P3a: un-pinning from the hidden half-phase must render the cursor.
        self.force_render = true;
    }

    /// P2a: should the platform layer run a blink timer for this pane?
    /// Only a focused pane with blink enabled and a live Term needs ticks —
    /// unfocused panes show the static hollow outline (never blinks) and the
    /// placeholder (no-Term) path has no cursor at all.
    pub fn wants_blink_ticks(&self) -> bool {
        self.focused && self.cursor_blink && self.term.is_some()
    }

    /// Set the pane-local search highlight rects. The pipeline draws them
    /// each frame between the bg quad pass and the glyph pass. An empty
    /// slice clears the overlay.
    pub fn set_search_highlights(&mut self, rects: Vec<Rect>) {
        self.search_highlights = rects;
        // P3a: bump the generation (FrameSnapshot identity) + force so the
        // overlay swap renders immediately.
        self.search_gen = self.search_gen.wrapping_add(1);
        self.force_render = true;
    }

    /// Drop all search highlight rects. Called from `native_term_search_clear`.
    pub fn clear_search_highlights(&mut self) {
        self.search_highlights.clear();
        // P3a: same bookkeeping as set_search_highlights.
        self.search_gen = self.search_gen.wrapping_add(1);
        self.force_render = true;
    }

    /// Hot-swap the renderer's color palette. Called from
    /// `PlatformWindow::set_theme` after the wire-format `TerminalTheme`
    /// hex strings have been parsed. Updates:
    ///   - `bg_clear` (the wgpu clear color used as the default background)
    ///   - the shared `theme` Arc (visible to CellGrid::snapshot_rows on the
    ///     next sync, including ansi indices, fg, bg, selection)
    ///   - cursor color is read from `theme.cursor` directly in `render`.
    /// Forces every row's cached run snapshot to invalidate so the next
    /// `sync_from_term` re-shapes with the new colors — without this, rows
    /// whose underlying glyph text hasn't changed would short-circuit and
    /// keep rendering with stale colors.
    pub fn set_theme(&mut self, colors: ThemeColors) {
        self.bg_clear = color_to_wgpu(colors.background);
        // Swap atomically under a short write lock. CellGrid::snapshot_rows
        // takes a read lock per call; both are uncontended in practice.
        {
            let mut guard = self.theme.write().expect("theme lock poisoned");
            *guard = colors;
        }
        if let Some(grid) = self.grid.as_mut() {
            grid.invalidate_for_theme_swap();
        }
        // P3a: theme swap repaints even on the no-grid placeholder path
        // (bg_clear changed) where invalidate_for_theme_swap marks nothing.
        self.force_render = true;
    }

    /// Re-configure the surface and the glyphon viewport. Called from the
    /// WM_SIZE handler. width/height are PHYSICAL pixels.
    pub fn resize(&mut self, width_px: u32, height_px: u32) {
        if width_px == 0 || height_px == 0 {
            return;
        }
        self.config.width = width_px;
        self.config.height = height_px;
        self.surface.configure(&self.device, &self.config);
        self.configures += 1;
        self.glyph.resize(&self.queue, width_px, height_px);
        // P3a: a reconfigured swapchain has no presented buffer at the new
        // size — the next frame must draw regardless of damage state.
        self.force_render = true;
    }

    /// P1b resize-commit: rebuild the CellGrid for new terminal-cell
    /// dimensions (NOT pixels — that's `resize` above). Wraps
    /// `CellGrid::resize` and marks every row damaged so the next frame
    /// re-shapes and repaints the full surface. No-op when no Term is
    /// attached (placeholder path has no grid).
    pub fn resize_grid(&mut self, cols: usize, rows: usize) {
        if let Some(grid) = self.grid.as_mut() {
            grid.resize(&mut self.glyph, cols, rows);
            // CellGrid::resize already re-marks damage via
            // DamageTracker::resize; mark_all keeps the "ALL rows damaged"
            // invariant explicit and is idempotent.
            grid.damage.mark_all();
        }
        // P3a: unconditional (grid may be None) — grid dims changed.
        self.force_render = true;
    }

    /// R1.c will call this from `native_term_attach_pty`. Hands the renderer
    /// an Arc to the parser-bridge's Term so it can read the live grid.
    /// `cols`/`rows` are the terminal-cell dimensions (NOT pixels).
    #[allow(dead_code)] // R1.c consumer
    pub fn attach_term(&mut self, term: Arc<Mutex<Term<TermListener>>>, cols: usize, rows: usize) {
        let grid = CellGrid::new(&mut self.glyph, cols, rows, Arc::clone(&self.theme));
        self.term = Some(term);
        self.grid = Some(grid);
        // P3a: placeholder → live grid swap must render.
        self.force_render = true;
    }

    /// R1.c hook for `native_term_detach_pty`.
    #[allow(dead_code)]
    pub fn detach_term(&mut self) {
        self.term = None;
        self.grid = None;
        // P3a: live grid → placeholder swap must render.
        self.force_render = true;
    }

    /// P3a: arm the clean-frame early-out override — the NEXT `render()`
    /// call draws unconditionally. For externally-visible changes the
    /// renderer can't observe itself, e.g. win32 `show()` after SW_SHOW
    /// (the swapchain's retained buffer may be stale after a hidden stretch
    /// of skipped frames).
    pub fn force_next_frame(&mut self) {
        self.force_render = true;
    }

    pub fn render(&mut self) -> Result<RenderOutcome, String> {
        // P0 instrumentation: CPU-side frame cost, wall-clock from entry to
        // just after present. Measurement only — no scheduling impact.
        let frame_start = Instant::now();

        // P3a: sync FIRST — sync_from_term IS the change detector. It
        // refreshes row buffers from the alacritty grid (marking the damage
        // bitset for rows whose content/selection identity changed) and
        // captures cursor + viewport state under that SAME Term lock, so the
        // frame takes exactly one lock acquisition (the cursor pass below
        // reuses the capture instead of re-locking).
        let term_info: Option<TermFrameInfo> =
            if let (Some(grid), Some(term)) = (self.grid.as_mut(), self.term.as_ref()) {
                Some(grid.sync_from_term(&mut self.glyph, term))
            } else {
                None
            };

        // P3a clean-frame early-out: no row damage, no forced invalidation,
        // and an unchanged externally-visible snapshot → return BEFORE
        // get_current_texture. Zero GPU work, nothing presented — the
        // flip-model swapchain retains the last buffer on screen. P3b
        // deleted the 16ms pump, so this early-out is the only thing between
        // an InvalidateRect and a present; repaints arrive from the
        // WM_APP_RENDER wake, the watchdog, the blink/settle timers, and
        // explicit invalidations — never from a pump tick.
        let snapshot = FrameSnapshot {
            cursor_point: term_info.map(|i| (i.cursor_line, i.cursor_col)),
            show_cursor: term_info.map_or(false, |i| i.show_cursor),
            display_offset: term_info.map_or(0, |i| i.display_offset),
            cursor_visible: self.cursor_visible,
            cursor_style: self.cursor_style,
            focused: self.focused,
            search_gen: self.search_gen,
            cursor_wide: term_info.map_or(false, |i| i.cursor_wide),
        };
        let dirty = self.force_render
            || self.grid.as_ref().map_or(false, |g| g.damage.any_dirty())
            || self.last_snapshot != Some(snapshot);
        if !dirty {
            self.frames_skipped_clean += 1;
            return Ok(RenderOutcome::SkippedClean);
        }

        let frame = match self.surface.get_current_texture() {
            Ok(f) => f,
            Err(wgpu::SurfaceError::Lost | wgpu::SurfaceError::Outdated) => {
                // Phase 0 lesson: reconfigure and skip. P3a: damage bits,
                // force_render, and last_snapshot are left untouched here
                // (they only reset after a successful present), so the retry
                // frame re-evaluates as dirty and redraws. P3b: with the
                // 16ms pump gone, "the next WM_PAINT" is NOT guaranteed on
                // an idle pane — we report SkippedLost so the win32 paint
                // arm schedules a bounded retry.
                self.surface.configure(&self.device, &self.config);
                self.configures += 1;
                return Ok(RenderOutcome::SkippedLost);
            }
            Err(e) => return Err(format!("get_current_texture: {e:?}")),
        };
        let view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
        let mut enc = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("native_term R1 encoder"),
            });

        // Snapshot font metrics before glyphon takes &mut self.glyph. The
        // cell advance is the real shaped-glyph width measured by cosmic-text
        // in `GlyphStack::set_font_scaled` (physical px, advance-quantized to
        // an integer so quads and cosmic-text's continuous row layout agree
        // to the pixel and glyph stems land identically in every column).
        let line_h = self.glyph.line_height_px;
        let cell_w = self.glyph.cell_advance_px;
        let surface_w = self.config.width as f32;
        let surface_h = self.config.height as f32;

        // Build bg + decoration quad instances for the current frame. Both
        // are cheap allocations (Vec<QuadInstance>) over the grid's cached
        // per-row segment lists; the grid only re-snapshots rows that
        // actually changed.
        let (bg_instances, decor_instances, block_instances) = if let Some(grid) = self.grid.as_ref() {
            (
                grid.build_bg_quads(cell_w, line_h),
                grid.build_decor_quads(cell_w, line_h),
                grid.build_block_quads(cell_w, line_h),
            )
        } else {
            (Vec::new(), Vec::new(), Vec::new())
        };
        self.bg_quads
            .upload(&self.device, &self.queue, surface_w, surface_h, &bg_instances);
        self.decor_quads
            .upload(&self.device, &self.queue, surface_w, surface_h, &decor_instances);
        self.block_quads
            .upload(&self.device, &self.queue, surface_w, surface_h, &block_instances);

        // Search highlight instances. Translucent overlay drawn AFTER bg
        // quads but BEFORE the glyph pass so the underlying text stays
        // crisp on top. CLAUDE.md bans amber/yellow palette colors even in
        // native code (project-wide rule applies); we use a semi-transparent
        // neutral white that reads as "highlighted" against any theme bg.
        //
        // P6a scrollback contract: `search_highlights` rects arrive in
        // CONTENT space — y = absolute grid line × cell_h, NEGATIVE for
        // history rows (see `native_term_search` in mod.rs). We translate by
        // display_offset * line_h per frame so highlights track their content
        // while the user scrolls, and clip rects wholly outside the surface
        // (the swapchain would clip anyway; skipping keeps the instance
        // buffer small when most matches live in history).
        let search_color = [0.9_f32, 0.9, 0.9, 0.40];
        let search_offset_px =
            term_info.map_or(0.0, |i| i.display_offset as f32) * line_h;
        let search_instances: Vec<QuadInstance> = self
            .search_highlights
            .iter()
            .filter_map(|r| {
                let y = r.y + search_offset_px;
                if y + r.height <= 0.0 || y >= surface_h {
                    return None;
                }
                Some(QuadInstance {
                    rect: [r.x, y, r.width.max(0.0), r.height.max(0.0)],
                    color: search_color,
                })
            })
            .collect();
        self.search_quads
            .upload(&self.device, &self.queue, surface_w, surface_h, &search_instances);

        // P2a cursor pass — instances built + uploaded BEFORE the render
        // pass (upload takes &mut self while the pass borrows the pipelines).
        // Position AND the SHOW_CURSOR mode (DECSET 25 — vim hides the
        // cursor through it; unset → no cursor at all, focused or not) come
        // from the `term_info` capture taken under sync_from_term's Term
        // lock — P3a removed this pass's second lock acquisition. Blink
        // phase is owned by the win32 BLINK timer; render() only reads
        // `cursor_visible`. Geometry is physical px, integer-snapped
        // (rounded origins/sizes).
        let mut cursor_instances: Vec<QuadInstance> = Vec::new();
        if let Some(info) = term_info {
            let col = info.cursor_col;
            // P6a scrollback: cursor.line is a GRID line; the viewport shows
            // grid line (y - display_offset) at visual row y, so the cursor's
            // visual row is line + offset. Draw ONLY while that row is inside
            // the viewport — the cursor stays put on its content row while
            // scrolling and disappears exactly when it scrolls out the bottom.
            let visual_line = info.cursor_line + info.display_offset as i32;
            let line_idx = visual_line.max(0) as usize;
            if info.show_cursor
                && visual_line >= 0
                && line_idx < info.visible_rows
                && col < info.visible_cols
            {
                // Cursor color comes from the live theme — read once per
                // frame under a short shared lock and convert byte RGBA to
                // wgpu's 0..1 floats.
                let c = self.theme.read().expect("theme poisoned").cursor;
                let cursor_rgba = [
                    c[0] as f32 / 255.0,
                    c[1] as f32 / 255.0,
                    c[2] as f32 / 255.0,
                    c[3] as f32 / 255.0,
                ];
                let x = (col as f32 * cell_w).round();
                let y = (line_idx as f32 * line_h).round();
                // P6b wide chars: `info.cursor_col` is already normalized to
                // the wide-char START column (grid.rs snapshot); when that
                // cell is a WIDE_CHAR, the cell-shaped cursor styles (Block,
                // Underline, and the unfocused hollow outline — everything
                // that uses `w`) span BOTH halves of the glyph. Bar keeps
                // its normal thin width (it never reads `w`).
                let w = if info.cursor_wide {
                    (2.0 * cell_w).round().max(1.0)
                } else {
                    cell_w.round().max(1.0)
                };
                let h = line_h.round().max(1.0);
                let dpr = self.dpr;
                if self.focused {
                    // Focused pane: honour the blink phase (timer-owned).
                    if self.cursor_visible {
                        match self.cursor_style {
                            CursorStyle::Bar => {
                                let bar_w = (2.0 * dpr).round().max(1.0);
                                cursor_instances.push(QuadInstance {
                                    rect: [x, y, bar_w, h],
                                    color: cursor_rgba,
                                });
                            }
                            CursorStyle::Underline => {
                                let under_h =
                                    (2.0 * dpr).round().max((line_h * 0.12).round()).max(1.0);
                                cursor_instances.push(QuadInstance {
                                    rect: [x, y + h - under_h, w, under_h],
                                    color: cursor_rgba,
                                });
                            }
                            CursorStyle::Block => {
                                // 0.30 alpha keeps the underlying glyph
                                // visible (QuadPipeline alpha-blends). True
                                // xterm "inverse" block would re-render the
                                // glyph in the bg color — deferred.
                                cursor_instances.push(QuadInstance {
                                    rect: [x, y, w, h],
                                    color: [
                                        cursor_rgba[0],
                                        cursor_rgba[1],
                                        cursor_rgba[2],
                                        cursor_rgba[3] * 0.30,
                                    ],
                                });
                            }
                        }
                    }
                } else {
                    // Unfocused pane (any style setting): static hollow
                    // outline — four edge quads, never blinks (the phase is
                    // pinned visible by the timer kill and ignored here).
                    let t_px = dpr.round().max(1.0);
                    let inner_h = (h - 2.0 * t_px).max(0.0);
                    cursor_instances.push(QuadInstance {
                        rect: [x, y, w, t_px],
                        color: cursor_rgba,
                    });
                    cursor_instances.push(QuadInstance {
                        rect: [x, y + h - t_px, w, t_px],
                        color: cursor_rgba,
                    });
                    cursor_instances.push(QuadInstance {
                        rect: [x, y + t_px, t_px, inner_h],
                        color: cursor_rgba,
                    });
                    cursor_instances.push(QuadInstance {
                        rect: [x + w - t_px, y + t_px, t_px, inner_h],
                        color: cursor_rgba,
                    });
                }
            }
        }
        self.cursor_quads
            .upload(&self.device, &self.queue, surface_w, surface_h, &cursor_instances);

        let text_areas: Vec<TextArea> = if let Some(grid) = self.grid.as_ref() {
            grid.text_areas(line_h)
        } else {
            vec![TextArea {
                buffer: &self.placeholder_buffer,
                left: 16.0,
                top: 16.0,
                scale: 1.0,
                bounds: TextBounds::default(),
                default_color: glyphon::Color::rgba(0xE6, 0xE6, 0xE6, 0xFF),
                custom_glyphs: &[],
            }]
        };

        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("native_term R1 pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(self.bg_clear),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            // Per-cell backgrounds first so glyphs and decorations layer
            // on top of them.
            self.bg_quads.draw(&mut pass);

            // Block-element glyphs (▀ ▄ █ ░▒▓ …) rendered as grid-aligned
            // quads, right after the cell backgrounds so they sit on top of
            // them and tile seamlessly (the cells' text glyph is a space).
            self.block_quads.draw(&mut pass);

            // Search highlights sit between bg and glyphs — alpha-blended so
            // the matching text underneath stays legible.
            self.search_quads.draw(&mut pass);

            self.glyph.prepare_and_render(
                &self.device,
                &self.queue,
                &text_areas,
                &mut pass,
            )?;

            // Underline / strikeout bars sit on top of the glyph pass.
            self.decor_quads.draw(&mut pass);

            // P2a cursor pass — drawn AFTER glyphon + decor so it sits
            // visually on top of the cell text. Instances were built and
            // uploaded before the pass began; empty = no draw (SHOW_CURSOR
            // unset, blink half-phase, no Term attached).
            self.cursor_quads.draw(&mut pass);
        }

        self.queue.submit(Some(enc.finish()));
        frame.present();

        // P3a bookkeeping — this frame rendered, so:
        //   - consume the damage bitset (first-ever DamageTracker::clear
        //     caller; before this task the bits accumulated unread),
        //   - let the glyph atlas evict entries unused since the last
        //     rendered frame (glyphon 0.6 TextAtlas::trim, called after the
        //     render pass per upstream convention),
        //   - move the FrameSnapshot baseline + drop the force flag so the
        //     next unchanged frame takes the clean early-out.
        if let Some(grid) = self.grid.as_mut() {
            grid.damage.clear();
        }
        self.glyph.atlas.trim();
        self.last_snapshot = Some(snapshot);
        self.force_render = false;

        // P0 instrumentation: record the completed frame. EWMA alpha 0.1;
        // seeded with the first sample so the average starts meaningful.
        let cpu_ms = frame_start.elapsed().as_secs_f32() * 1000.0;
        self.last_frame_cpu_ms = cpu_ms;
        self.frame_cpu_ms_ewma = if self.frames_rendered == 0 {
            cpu_ms
        } else {
            self.frame_cpu_ms_ewma * 0.9 + cpu_ms * 0.1
        };
        self.frames_rendered += 1;
        Ok(RenderOutcome::Presented)
    }
}

/// Convert a `[u8; 4]` byte-RGBA color (matching `ThemeColors` fields) into a
/// `wgpu::Color` in 0..1 floats. Used for `bg_clear`.
fn color_to_wgpu(rgba: [u8; 4]) -> wgpu::Color {
    wgpu::Color {
        r: rgba[0] as f64 / 255.0,
        g: rgba[1] as f64 / 255.0,
        b: rgba[2] as f64 / 255.0,
        a: rgba[3] as f64 / 255.0,
    }
}
