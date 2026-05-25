// Phase 4 macOS spike: NSView sibling of WKWebView + wgpu Metal surface.
//
// The plan calls for the native pane to be a SIBLING of Tauri's WKWebView
// inside the main NSWindow's contentView — NOT a child of WKWebView (Apple's
// view hierarchy makes that impossible anyway). Both views are subviews of
// `[NSWindow contentView]`, z-ordered with the native pane above the webview.
//
// What this spike proves (success criteria, gated by Phase 4 plan):
//   1. NSView can be inserted as a sibling above WKWebView via
//      addSubview:positioned:above: with NSWindowOrderingMode::Above.
//   2. wgpu Metal surface renders into a CAMetalLayer attached to that NSView.
//   3. Lifecycle (show/hide/resize/destroy) leaves no orphan views or surfaces.
//
// What this spike does NOT include (deferred until the embedding pattern is
// proven by visual confirmation on the Mac mini):
//   • PTY routing / alacritty parser bridge — set_pty / detach_pty stay Err.
//   • Glyph rendering — uses solid-color clear, no glyphon, no grid.
//   • IME (NSTextInputClient).
//   • Hole-cutting (CAShapeLayer mask).
//   • Theme / font / cursor hot-swap.
//
// Threading model: AppKit requires main-thread access for any NSView mutation.
// Tauri command handlers run on the tokio runtime (off-main), so every
// NSView op goes through `main_sync()` which bounces onto the main GCD queue
// synchronously. wgpu Metal calls are thread-safe and run inline.

#![allow(unexpected_cfgs)]

use std::ffi::c_void;
use std::ptr::NonNull;

use dispatch2::Queue;
use objc2::rc::Retained;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSView, NSWindowOrderingMode};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use objc2_quartz_core::CAMetalLayer;
use raw_window_handle::{
    AppKitDisplayHandle, AppKitWindowHandle, RawDisplayHandle, RawWindowHandle,
};

use super::{NativeTermWindow, Rect, TerminalTheme};

/// Default clear color for the spike: a distinctive green so visual
/// confirmation on the Mac mini doesn't depend on the webview being any
/// particular state. If you see solid green where a terminal pane should be,
/// the NSView is correctly sibling-z-above the WKWebView.
const SPIKE_CLEAR_COLOR: wgpu::Color = wgpu::Color {
    r: 0.10,
    g: 0.55,
    b: 0.30,
    a: 1.0,
};

pub struct PlatformWindow {
    /// Retained NSView pointer (one strong ref taken at construction, dropped
    /// in `destroy`). Stored as `usize` because Retained<NSView> is not Send
    /// and the trait requires Send. All dereferences go through main_sync.
    ns_view_ptr: usize,
    /// Non-owning pointer to the parent contentView. Already retained for the
    /// app's lifetime by the NSWindow itself — we don't release.
    parent_view_ptr: usize,
    /// Cached so resize can compute the macOS-flipped y coordinate (AppKit
    /// origin is bottom-left, our JS rects are top-left).
    last_dpr: f32,
    /// Logical-px frame last set, kept around to repeat-render on show().
    last_frame_logical: Rect,

    // wgpu objects — Send + Sync, held off-main without issue.
    _instance: wgpu::Instance,
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
}

// SAFETY: ns_view_ptr / parent_view_ptr are raw pointers we never dereference
// off-main. All NSView ops go through main_sync. wgpu objects are themselves
// Send + Sync.
unsafe impl Send for PlatformWindow {}

impl PlatformWindow {
    pub fn new(parent_handle: isize, rect: Rect, dpr: f32) -> Result<Self, String> {
        if parent_handle == 0 {
            return Err("native_term/macos: parent NSView pointer is null".into());
        }

        // ── Step 1: create the NSView + CAMetalLayer on the main thread.
        // We pass parent_handle as plain `isize` (Send-safe) into the closure
        // and cast to *mut AnyObject inside. Raw pointers are !Send so we
        // can't carry them across the dispatch.
        let rect_for_closure = rect;
        let dpr_for_closure = dpr;
        let view_ptr = main_sync(move || -> Result<usize, String> {
            let mtm = MainThreadMarker::new()
                .ok_or_else(|| "main_sync ran off main thread".to_string())?;

            // SAFETY: parent_handle is the contentView pointer we cached in
            // lib.rs setup(). NSWindow owns its contentView for the app's
            // lifetime, so the pointer stays valid throughout this borrow.
            let parent_view: &NSView =
                unsafe { &*(parent_handle as *const NSView) };

            let parent_bounds = parent_view.bounds();
            let frame = flip_rect(rect_for_closure, parent_bounds.size.height as f32);

            // Create the NSView. We'll attach a CAMetalLayer as its hosting
            // layer below — wgpu's Metal backend renders into it.
            let view: Retained<NSView> = NSView::initWithFrame(NSView::alloc(mtm), frame);

            // Layer-hosting setup. setWantsLayer first, then setLayer — that
            // order matters for layer-hosting semantics (layer-hosting vs
            // layer-backed is decided by which property is set first).
            let metal_layer: Retained<CAMetalLayer> = CAMetalLayer::new();
            metal_layer.setContentsScale(dpr_for_closure as f64);
            view.setWantsLayer(true);
            // setLayer wants &CALayer; CAMetalLayer derefs to CALayer through
            // the extern_class!-generated chain. Force the coercion with an
            // explicit type ascription so it's not a hidden inference.
            let layer_ref: &objc2_quartz_core::CALayer = &metal_layer;
            view.setLayer(Some(layer_ref));

            // Insert as subview ABOVE all existing siblings — WKWebView is
            // already there. NSWindowOrderingMode::Above with `nil` ref
            // means "above every existing subview".
            parent_view.addSubview_positioned_relativeTo(
                &view,
                NSWindowOrderingMode::Above,
                None,
            );

            // Take one strong reference out as a raw pointer. addSubview
            // retains the view too, so the view stays alive as long as it's
            // in the hierarchy — our +1 is what we release in destroy().
            let raw = Retained::into_raw(view) as usize;
            Ok(raw)
        })??;

        // ── Step 2: build the wgpu surface. raw-window-handle's AppKit
        // handle is a single pointer (NSView*) — wgpu's metal backend
        // walks up to find the CAMetalLayer we attached above.
        let view_nn = NonNull::new(view_ptr as *mut c_void)
            .ok_or_else(|| "ns_view ptr unexpectedly null after creation".to_string())?;
        let win_handle = AppKitWindowHandle::new(view_nn);
        let raw_window = RawWindowHandle::AppKit(win_handle);
        let raw_display = RawDisplayHandle::AppKit(AppKitDisplayHandle::new());

        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::METAL,
            ..Default::default()
        });

        let surface = unsafe {
            instance.create_surface_unsafe(wgpu::SurfaceTargetUnsafe::RawHandle {
                raw_display_handle: raw_display,
                raw_window_handle: raw_window,
            })
        }
        .map_err(|e| format!("native_term/macos: create_surface_unsafe: {e}"))?;

        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            compatible_surface: Some(&surface),
        }))
        .ok_or_else(|| "native_term/macos: no compatible Metal adapter".to_string())?;

        let (device, queue) = pollster::block_on(adapter.request_device(
            &wgpu::DeviceDescriptor {
                label: Some("native_term_macos_spike"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::downlevel_defaults(),
                memory_hints: wgpu::MemoryHints::Performance,
            },
            None,
        ))
        .map_err(|e| format!("native_term/macos: request_device: {e}"))?;

        let caps = surface.get_capabilities(&adapter);
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|f| !f.is_srgb())
            .or_else(|| caps.formats.first().copied())
            .ok_or_else(|| "native_term/macos: no surface format".to_string())?;

        let w_px = (rect.width.max(1.0) * dpr) as u32;
        let h_px = (rect.height.max(1.0) * dpr) as u32;
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: w_px.max(1),
            height: h_px.max(1),
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 2,
            alpha_mode: caps.alpha_modes.first().copied().unwrap_or(wgpu::CompositeAlphaMode::Auto),
            view_formats: vec![],
        };
        surface.configure(&device, &config);

        let win = PlatformWindow {
            ns_view_ptr: view_ptr,
            parent_view_ptr: parent_handle as usize,
            last_dpr: dpr,
            last_frame_logical: rect,
            _instance: instance,
            surface,
            device,
            queue,
            config,
        };

        // Initial paint so the spike's visible-green criterion holds even
        // before the JS side calls show().
        win.render_clear();

        Ok(win)
    }

    /// Trait parity with win32::PlatformWindow. AppHandle plumbing is not
    /// needed for the solid-color spike — no per-pane events are emitted
    /// yet. Stored but unused.
    pub fn set_app_handle(&mut self, _app: tauri::AppHandle) {}

    pub fn set_term_id(&mut self, _id: u32) {}

    /// Single solid-color clear pass. Called from new(), show(), resize().
    /// macOS doesn't need a continuous render loop for a static color —
    /// Core Animation keeps compositing the last drawable.
    fn render_clear(&self) {
        let frame = match self.surface.get_current_texture() {
            Ok(t) => t,
            Err(_) => return, // surface lost / resize race — skip
        };
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("native_term_macos_spike_clear"),
            });
        {
            let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("spike_clear_pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(SPIKE_CLEAR_COLOR),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
        }
        self.queue.submit(std::iter::once(encoder.finish()));
        frame.present();
    }
}

impl NativeTermWindow for PlatformWindow {
    fn resize(&mut self, rect: Rect, dpr: f32) -> Result<(), String> {
        self.last_dpr = dpr;
        self.last_frame_logical = rect;

        let view_ptr = self.ns_view_ptr;
        let parent_ptr = self.parent_view_ptr;
        main_sync(move || {
            // SAFETY: pointers are kept alive: parent by NSWindow ownership,
            // view by our Retained-into-raw + addSubview retain. We never
            // dereference these off-main.
            let parent: &NSView = unsafe { &*(parent_ptr as *const NSView) };
            let view: &NSView = unsafe { &*(view_ptr as *const NSView) };
            let parent_h = parent.bounds().size.height as f32;
            view.setFrame(flip_rect(rect, parent_h));
        })?;

        let w_px = (rect.width.max(1.0) * dpr) as u32;
        let h_px = (rect.height.max(1.0) * dpr) as u32;
        if w_px != self.config.width || h_px != self.config.height {
            self.config.width = w_px.max(1);
            self.config.height = h_px.max(1);
            self.surface.configure(&self.device, &self.config);
        }
        self.render_clear();
        Ok(())
    }

    fn show(&mut self) -> Result<(), String> {
        let view_ptr = self.ns_view_ptr;
        main_sync(move || {
            let view: &NSView = unsafe { &*(view_ptr as *const NSView) };
            view.setHidden(false);
        })?;
        self.render_clear();
        Ok(())
    }

    fn hide(&mut self) -> Result<(), String> {
        let view_ptr = self.ns_view_ptr;
        main_sync(move || {
            let view: &NSView = unsafe { &*(view_ptr as *const NSView) };
            view.setHidden(true);
        })
    }

    fn set_region(&mut self, _holes: &[Rect], _dpr: f32) -> Result<(), String> {
        // Phase 4 follow-up: CAShapeLayer mask. For the spike we accept the
        // call as a no-op so the JS region driver doesn't error out.
        Ok(())
    }

    fn destroy(self: Box<Self>) -> Result<(), String> {
        let view_ptr = self.ns_view_ptr;
        main_sync(move || {
            // SAFETY: view_ptr is the +1 strong reference we took in new().
            // Reclaiming it via Retained::from_raw releases that ref when the
            // Retained drops below. addSubview also retains, so the view
            // outlives our drop until removeFromSuperview unparents it.
            let view: Retained<NSView> = unsafe {
                Retained::from_raw(view_ptr as *mut NSView)
                    .expect("native_term/macos: view ptr nil at destroy")
            };
            view.removeFromSuperview();
            drop(view);
        })?;
        // wgpu Surface, Device, Queue dropped by Box<Self> drop after this fn returns.
        Ok(())
    }

    fn attach_pty(
        &mut self,
        _term_id: u32,
        _pty_id: u32,
        _cols: usize,
        _rows: usize,
    ) -> Result<(), String> {
        Err("native_term/macos: attach_pty not implemented in Phase 4 spike (solid-color only)".into())
    }

    fn detach_pty(&mut self) -> Result<(), String> {
        Err("native_term/macos: detach_pty not implemented in Phase 4 spike".into())
    }

    fn propose_dimensions(&self, _width_px: u32, _height_px: u32) -> (u32, u32) {
        // No font metrics yet — give the JS narrow-guard floor.
        (20, 1)
    }

    fn set_theme(&mut self, _theme: &TerminalTheme) -> Result<(), String> {
        Ok(()) // accept silently for parity; no glyph rendering yet
    }

    fn set_font(&mut self, _family: &str, _size_px: f32) -> Result<(), String> {
        Ok(())
    }

    fn set_cursor_style(&mut self, _style: &str, _blink: bool) -> Result<(), String> {
        Ok(())
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────

/// AppKit origin is bottom-left of the parent; CSS/web/Windows is top-left.
/// We flip y when setting the NSView's frame so the JS-supplied rect lines
/// up visually with the corresponding webview region.
fn flip_rect(rect: Rect, parent_height_logical: f32) -> NSRect {
    let flipped_y = parent_height_logical - rect.y - rect.height;
    NSRect::new(
        NSPoint::new(rect.x as f64, flipped_y as f64),
        NSSize::new(rect.width as f64, rect.height as f64),
    )
}

/// Run a closure synchronously on the main GCD queue and return its value.
///
/// `dispatch_sync` on the main queue would deadlock if invoked from the main
/// thread (libdispatch traps on self-targeting), so we short-circuit: if
/// we're already on main, run inline.
///
/// All NSView mutation in this file flows through here. Tauri command
/// handlers run on the tokio runtime (off-main) so the short-circuit is
/// only defensive — but it makes this safe to call from anywhere.
fn main_sync<F, R>(f: F) -> Result<R, String>
where
    F: FnOnce() -> R + Send,
    R: Send,
{
    if MainThreadMarker::new().is_some() {
        return Ok(f());
    }
    // dispatch2 0.3's exec_sync is `FnOnce()`, not `FnOnce() -> R`. We
    // smuggle the result out through a borrowed Option — the closure is
    // synchronous so by the time exec_sync returns, the slot is populated.
    let mut slot: Option<R> = None;
    let slot_ref = &mut slot;
    Queue::main().exec_sync(move || {
        *slot_ref = Some(f());
    });
    Ok(slot.expect("dispatch_sync ran without populating result slot"))
}
