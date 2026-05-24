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

use std::sync::{Arc, Mutex};

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::Term;
use glyphon::{Attrs, Buffer, Family, Shaping, TextArea, TextBounds};
use raw_window_handle::{RawDisplayHandle, RawWindowHandle};

use super::super::parser_bridge::TermListener;
use super::cursor::CursorPipeline;
use super::glyph_atlas::GlyphStack;
use super::grid::CellGrid;

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
    /// Placeholder Buffer used in the no-Term path. Pre-built once in `new`
    /// so render() doesn't re-shape every frame.
    placeholder_buffer: Buffer,
    /// Background color from CreateOpts.theme.background. R1.b uses a single
    /// uniform background via the clear pass; per-cell bg quads land in R1.d.
    bg_clear: wgpu::Color,
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

        Ok(Self {
            surface,
            device,
            queue,
            config,
            glyph,
            grid: None,
            term: None,
            cursor,
            placeholder_buffer,
            bg_clear: wgpu::Color { r: 0.05, g: 0.05, b: 0.07, a: 1.0 },
        })
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
        let grid = CellGrid::new(&mut self.glyph, cols, rows, [255, 255, 255, 255]);
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

        // If a Term is attached, refresh row buffers from its grid. Mutex
        // held briefly inside sync_from_term, released before glyph prepare.
        if let (Some(grid), Some(term)) = (self.grid.as_mut(), self.term.as_ref()) {
            grid.sync_from_term(&mut self.glyph, term);
        }

        // Snapshot font metrics before glyphon takes &mut self.glyph.
        // Cell width is an approximation for Hack mono; R1.d-δ will pull
        // real advance metrics from cosmic-text.
        let line_h = self.glyph.line_height_px;
        let cell_w = self.glyph.font_size_px * 0.6;
        let surface_w = self.config.width as f32;
        let surface_h = self.config.height as f32;
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
            self.glyph.prepare_and_render(
                &self.device,
                &self.queue,
                &text_areas,
                &mut pass,
            )?;

            // R1.d-γ cursor bar — drawn AFTER glyphon so it sits visually
            // on top of the cell text. Position read from the live Term
            // grid under one short lock.
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
                    self.cursor.draw(
                        &self.queue,
                        surface_w,
                        surface_h,
                        col as f32 * cell_w,
                        line_idx as f32 * line_h,
                        2.0,
                        line_h,
                        // Soft white, ~80% alpha for non-jarring visual.
                        [0.86, 0.84, 0.81, 0.80],
                        &mut pass,
                    );
                }
            }
        }

        self.queue.submit(Some(enc.finish()));
        frame.present();
        Ok(())
    }
}
