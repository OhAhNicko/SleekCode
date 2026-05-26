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

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::Term;
use glyphon::{Attrs, Buffer, Family, Shaping, TextArea, TextBounds};
use raw_window_handle::{RawDisplayHandle, RawWindowHandle};

use super::super::parser_bridge::TermListener;
use super::super::window::Rect;
use super::cursor::{CursorPipeline, CursorStyle};
use super::glyph_atlas::GlyphStack;
use super::grid::{CellGrid, CursorRenderInfo};
use super::quad_pipeline::{QuadInstance, QuadPipeline};
use super::ThemeColors;

/// Cursor blink half-period (ms). xterm uses ~530ms on/off; matched here so
/// the blink cadence feels native.
const BLINK_HALF_PERIOD_MS: u128 = 530;

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
    cursor: CursorPipeline,
    /// Shared instanced-quad pipeline used for per-cell backgrounds (drawn
    /// BEFORE glyphon) and decorations like underline / strikeout (drawn
    /// AFTER glyphon). The single struct holds two GPU draws per frame —
    /// one bg pass, one decor pass — by re-uploading the instance buffer
    /// between them.
    bg_quads: QuadPipeline,
    decor_quads: QuadPipeline,
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
    /// Current blink phase (true = visible). Toggled in `render` once the
    /// configured half-period has elapsed since `blink_phase_started_at`.
    cursor_visible: bool,
    /// When the current blink phase began. Reset on `set_cursor_style` so a
    /// style change starts the cursor in the visible state.
    blink_phase_started_at: Instant,
    /// Pane-local search highlight rects (overlay marks drawn between the bg
    /// quads and the glyph pass). Set by `set_search_highlights`, cleared by
    /// `clear_search_highlights`. Coordinates are pane-local pixels in the
    /// same space the search command emits (CELL_W × CELL_H derived).
    search_highlights: Vec<Rect>,
    /// Dedicated quad pipeline for search highlight overlays. We keep it
    /// separate from `bg_quads`/`decor_quads` so each pipeline owns its own
    /// uploaded instance buffer — sharing would force ordering hacks.
    search_quads: QuadPipeline,
}

impl Renderer {
    pub fn new(
        rwh: RawWindowHandle,
        rdh: RawDisplayHandle,
        width_px: u32,
        height_px: u32,
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
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|f| matches!(f, wgpu::TextureFormat::Bgra8Unorm | wgpu::TextureFormat::Bgra8UnormSrgb))
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

        // R1.b: hardcoded font + size + bg. R1.c receives these via CreateOpts.
        let mut glyph = GlyphStack::new(
            &device,
            &queue,
            format,
            width_px,
            height_px,
            "Hack, monospace".to_string(),
            14.0,
        );

        // Build the static placeholder buffer once. Visible in the spike pane
        // until R1.c calls `attach_term`.
        let mut placeholder_buffer = glyph.make_buffer();
        placeholder_buffer.set_text(
            &mut glyph.font_system,
            "Hello, MADE — native_term R1.b alive\n(no PTY attached yet)",
            Attrs::new().family(Family::Monospace),
            Shaping::Advanced,
        );

        let cursor = CursorPipeline::new(&device, format);
        let bg_quads = QuadPipeline::new(&device, format);
        let decor_quads = QuadPipeline::new(&device, format);
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
            cursor,
            bg_quads,
            decor_quads,
            placeholder_buffer,
            bg_clear,
            theme,
            cursor_style: CursorStyle::Bar,
            cursor_blink: false,
            cursor_visible: true,
            blink_phase_started_at: Instant::now(),
            search_highlights: Vec::new(),
            search_quads,
        })
    }

    /// Hot-swap the active font family + size. Updates the GlyphStack's
    /// Metrics (so future Buffer constructions pick up the new size) and
    /// rebuilds every existing row Buffer in the CellGrid — old Buffers were
    /// constructed with the previous Metrics and would render at the wrong
    /// size otherwise. Caller must follow up with an `InvalidateRect` (or
    /// equivalent) so the next paint picks the new metrics up.
    pub fn set_font(&mut self, family: String, size_px: f32) {
        self.glyph.set_font(family, size_px);
        if let Some(grid) = self.grid.as_mut() {
            grid.rebuild_buffers(&mut self.glyph);
        }
    }

    /// Read the current per-cell metrics (horizontal advance, line height) in
    /// pixels. Used by the win32 wrapper so the wnd_proc's cell-coord math
    /// stays in sync with the renderer after a font hot-swap.
    pub fn cell_metrics(&self) -> (f32, f32) {
        (self.glyph.cell_advance_px, self.glyph.line_height_px)
    }

    /// Hot-swap the cursor visual style + blink behaviour. Parses the wire
    /// string ("bar" | "block" | "underline" — anything else falls back to
    /// "bar") and resets the blink phase so the cursor starts visible
    /// immediately after the swap.
    pub fn set_cursor_style(&mut self, style: &str, blink: bool) {
        self.cursor_style = CursorStyle::parse(style);
        self.cursor_blink = blink;
        self.cursor_visible = true;
        self.blink_phase_started_at = Instant::now();
    }

    /// Set the pane-local search highlight rects. The pipeline draws them
    /// each frame between the bg quad pass and the glyph pass. An empty
    /// slice clears the overlay.
    pub fn set_search_highlights(&mut self, rects: Vec<Rect>) {
        self.search_highlights = rects;
    }

    /// Drop all search highlight rects. Called from `native_term_search_clear`.
    pub fn clear_search_highlights(&mut self) {
        self.search_highlights.clear();
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
        self.glyph.resize(&self.queue, width_px, height_px);
    }

    /// R1.c will call this from `native_term_attach_pty`. Hands the renderer
    /// an Arc to the parser-bridge's Term so it can read the live grid.
    /// `cols`/`rows` are the terminal-cell dimensions (NOT pixels).
    #[allow(dead_code)] // R1.c consumer
    pub fn attach_term(&mut self, term: Arc<Mutex<Term<TermListener>>>, cols: usize, rows: usize) {
        let grid = CellGrid::new(&mut self.glyph, cols, rows, Arc::clone(&self.theme));
        self.term = Some(term);
        self.grid = Some(grid);
    }

    /// R1.c hook for `native_term_detach_pty`.
    #[allow(dead_code)]
    pub fn detach_term(&mut self) {
        self.term = None;
        self.grid = None;
    }

    pub fn render(&mut self) -> Result<(), String> {
        let frame = match self.surface.get_current_texture() {
            Ok(f) => f,
            Err(wgpu::SurfaceError::Lost | wgpu::SurfaceError::Outdated) => {
                // Phase 0 lesson: reconfigure and skip; next WM_PAINT redraws.
                self.surface.configure(&self.device, &self.config);
                return Ok(());
            }
            Err(e) => return Err(format!("get_current_texture: {e:?}")),
        };
        let view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
        let mut enc = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("native_term R1 encoder"),
            });

        // Blink-phase advance — moved BEFORE sync_from_term so the inverse
        // block-cursor path can see the live visibility bit. (The other
        // cursor styles read the same flag below; the move is a no-op for
        // them.) Toggle visibility once per half-period; if blink is
        // disabled, force visible so a paused cursor never strands off-screen
        // after a config flip.
        if self.cursor_blink {
            if self.blink_phase_started_at.elapsed().as_millis() > BLINK_HALF_PERIOD_MS {
                self.cursor_visible = !self.cursor_visible;
                self.blink_phase_started_at = Instant::now();
            }
        } else {
            self.cursor_visible = true;
        }

        // Compute cursor-render info for the cell-grid snapshot. Only Block
        // style opts into the inverse-glyph swap; Bar / Underline keep
        // their additive-quad render path below.
        let inverse_block_active = matches!(self.cursor_style, CursorStyle::Block)
            && self.cursor_visible;

        // If a Term is attached, refresh row buffers from its grid. Mutex
        // held briefly inside sync_from_term, released before glyph prepare.
        if let (Some(grid), Some(term)) = (self.grid.as_mut(), self.term.as_ref()) {
            let cursor_info = if inverse_block_active {
                let t = term.lock().expect("term poisoned");
                let point = t.grid().cursor.point;
                drop(t);
                Some(CursorRenderInfo {
                    point,
                    inverse_block: true,
                })
            } else {
                None
            };
            grid.sync_from_term(&mut self.glyph, term, cursor_info);
        }

        // Snapshot font metrics before glyphon takes &mut self.glyph. The
        // cell advance is the real shaped-glyph width measured by cosmic-text
        // in `GlyphStack::new` / `set_font` (replaces the old `size * 0.6`
        // heuristic so non-mono fallbacks and DPI scaling line up).
        let line_h = self.glyph.line_height_px;
        let cell_w = self.glyph.cell_advance_px;
        let surface_w = self.config.width as f32;
        let surface_h = self.config.height as f32;

        // Build bg + decoration quad instances for the current frame. Both
        // are cheap allocations (Vec<QuadInstance>) over the grid's cached
        // per-row segment lists; the grid only re-snapshots rows that
        // actually changed.
        let (bg_instances, decor_instances) = if let Some(grid) = self.grid.as_ref() {
            (grid.build_bg_quads(cell_w, line_h), grid.build_decor_quads(cell_w, line_h))
        } else {
            (Vec::new(), Vec::new())
        };
        self.bg_quads
            .upload(&self.device, &self.queue, surface_w, surface_h, &bg_instances);
        self.decor_quads
            .upload(&self.device, &self.queue, surface_w, surface_h, &decor_instances);

        // Search highlight instances. Translucent overlay drawn AFTER bg
        // quads but BEFORE the glyph pass so the underlying text stays
        // crisp on top. CLAUDE.md bans amber/yellow palette colors even in
        // native code (project-wide rule applies); we use a semi-transparent
        // neutral white that reads as "highlighted" against any theme bg.
        let search_color = [0.9_f32, 0.9, 0.9, 0.40];
        let search_instances: Vec<QuadInstance> = self
            .search_highlights
            .iter()
            .map(|r| QuadInstance {
                rect: [r.x, r.y, r.width.max(0.0), r.height.max(0.0)],
                color: search_color,
            })
            .collect();
        self.search_quads
            .upload(&self.device, &self.queue, surface_w, surface_h, &search_instances);

        // (Blink-phase advance has already happened before sync_from_term so
        // the cursor-row snapshot can see this frame's visibility bit.)
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

            // Cursor pass — drawn AFTER glyphon so it sits visually on top
            // of the cell text. Position read from the live Term grid under
            // one short lock. Style + blink-phase honoured per Phase 3.
            if self.cursor_visible {
                if let Some(term) = self.term.as_ref() {
                    let (col, line_idx, visible_rows, visible_cols) = {
                        let t = term.lock().expect("renderer term lock poisoned");
                        let grid = t.grid();
                        let pt = grid.cursor.point;
                        (
                            pt.column.0,
                            pt.line.0.max(0) as usize,
                            grid.screen_lines(),
                            grid.columns(),
                        )
                    };
                    if line_idx < visible_rows && col < visible_cols {
                        // Cursor color comes from the live theme — read once per
                        // frame under a short shared lock and convert byte RGBA
                        // to wgpu's 0..1 floats. The default Tango theme keeps
                        // the previous soft-white look.
                        let c = self.theme.read().expect("theme poisoned").cursor;
                        let cursor_rgba = [
                            c[0] as f32 / 255.0,
                            c[1] as f32 / 255.0,
                            c[2] as f32 / 255.0,
                            c[3] as f32 / 255.0,
                        ];
                        let cell_x = col as f32 * cell_w;
                        let cell_y = line_idx as f32 * line_h;
                        // Style-specific quad geometry + alpha.
                        //   Block:     handled by snapshot_rows via the
                        //              CursorRenderInfo inverse swap above —
                        //              cell bg becomes cursor color, glyph
                        //              becomes theme bg. No quad drawn here.
                        //   Underline: 2-3px tall bar at cell bottom.
                        //   Bar:       2px wide vertical strip at cell x.
                        let underline_h = (line_h * 0.12).max(2.0).round();
                        let geom = match self.cursor_style {
                            CursorStyle::Bar => Some((cell_x, cell_y, 2.0, line_h)),
                            CursorStyle::Underline => Some((
                                cell_x,
                                cell_y + line_h - underline_h,
                                cell_w,
                                underline_h,
                            )),
                            CursorStyle::Block => None,
                        };
                        if let Some((qx, qy, qw, qh)) = geom {
                            let rgba = cursor_rgba;
                            self.cursor.draw(
                                &self.queue,
                                surface_w,
                                surface_h,
                                qx,
                                qy,
                                qw,
                                qh,
                                rgba,
                                &mut pass,
                            );
                        }
                    }
                }
            }
        }

        self.queue.submit(Some(enc.finish()));
        frame.present();
        Ok(())
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
