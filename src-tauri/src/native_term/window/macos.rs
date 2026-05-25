// Phase 4 macOS R4 implementation: NSView sibling of WKWebView + wgpu Metal
// surface driven by the shared Renderer + ParserBridge + pty_route stack.
//
// The plan calls for the native pane to be a SIBLING of Tauri's WKWebView
// inside the main NSWindow's contentView — NOT a child of WKWebView (Apple's
// view hierarchy makes that impossible anyway). Both views are subviews of
// `[NSWindow contentView]`, z-ordered with the native pane above the webview.
//
// Phasing of this file:
//   R4-α (committed in 5322fce): NSView + CAMetalLayer + solid-color spike.
//   R4-β (this revision): drop the spike's inline wgpu and use the production
//        Renderer; wire ParserBridge + pty_route so a real shell runs through
//        the native pane.
//   R4-γ (next): mouse + keyboard + IME via NSTextInputClient.
//   R4-δ: hole-cut via CAShapeLayer mask.
//
// Threading model
// ─────────────────
//   • AppKit mutations (frame, addSubview, isHidden, removeFromSuperview) go
//     through `main_sync()` — Tauri command handlers run on the tokio pool,
//     not the main thread. dispatch2's Queue::main().exec_sync provides the
//     bounce; we short-circuit when already on main so we don't deadlock.
//   • wgpu calls (Renderer::render / resize / set_theme / etc.) are
//     thread-safe; the render thread locks the Renderer's Mutex and calls
//     `render()` at ~60Hz while a PTY is attached. Command handlers acquire
//     the same Mutex briefly when they need to update state.
//   • The Renderer itself owns the wgpu Surface, which holds the NSView via
//     raw-window-handle. The Surface MUST be dropped before
//     `removeFromSuperview`, so destroy() takes a careful sequence: stop the
//     render thread → drop ParserBridge → drop Renderer → main_sync to remove
//     the view and release our +1 NSView strong ref.

#![allow(unexpected_cfgs)]

use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use dispatch2::Queue;
use objc2::rc::Retained;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSView, NSWindowOrderingMode};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use objc2_core_graphics::{CGColorCreateSRGB, CGMutablePath, CGPath};
use objc2_quartz_core::{kCAFillRuleEvenOdd, CALayer, CAMetalLayer, CAShapeLayer};
use raw_window_handle::{
    AppKitDisplayHandle, AppKitWindowHandle, RawDisplayHandle, RawWindowHandle,
};

use alacritty_terminal::term::Term;

use super::{NativeTermWindow, Rect, TerminalTheme};
use super::super::parser_bridge::{ParserBridge, TermListener};
use super::super::pty_route;
use super::super::renderer::{Renderer, ThemeColors};

/// Frame interval for the render pump while a PTY is attached. Matches the
/// Win32 WM_TIMER tick — close to 60Hz but slightly behind so we don't
/// busy-spin when the parser is idle.
const RENDER_INTERVAL: Duration = Duration::from_millis(16);

/// Initial per-cell logical-px metrics handed to ParserBridge::spawn. These
/// are the same Hack-14 defaults Win32 uses pre-set_font; once set_font is
/// wired through Renderer they get refreshed via `cell_metrics()`.
const INITIAL_CELL_W_LOGICAL: f32 = 8.4;
const INITIAL_CELL_H_LOGICAL: f32 = 17.0;

pub struct PlatformWindow {
    /// Retained NSView pointer (one strong ref taken at construction, released
    /// in `destroy`). Stored as `usize` because Retained<NSView> is !Send.
    /// All dereferences go through main_sync.
    ns_view_ptr: usize,
    /// Non-owning pointer to the parent contentView. NSWindow retains its
    /// contentView for its lifetime, so we don't manage this ref.
    parent_view_ptr: usize,
    /// Cached DPR — used for AppKit-y-flip math on resize and for the wgpu
    /// surface pixel dims.
    last_dpr: f32,

    /// Production Renderer (parser bridge + glyphon + cursor pass). Behind
    /// Arc<Mutex> so the render thread can lock it while command handlers
    /// (resize, set_theme, set_font) also need brief access. `Option` so
    /// `destroy()` can `take()` it and drop it explicitly BEFORE the NSView
    /// leaves its superview — the wgpu surface holds a CAMetalLayer ref that
    /// must be released first.
    renderer: Option<Arc<Mutex<Renderer>>>,

    /// Parser worker thread + Term Arc. Spawned in `attach_pty`, dropped on
    /// `detach_pty` / `destroy` (which joins the worker).
    parser_bridge: Option<ParserBridge>,
    attached_pty_id: Option<u32>,
    term_id: Option<u32>,

    /// Render pump (stops on `detach_pty` / `destroy`). The AtomicBool is the
    /// stop signal; we join the JoinHandle to make sure the thread is gone
    /// before we drop the Renderer it was locking.
    render_stop: Option<Arc<AtomicBool>>,
    render_thread: Option<JoinHandle<()>>,

    /// AppHandle for ParserBridge cursor event emission. Set by
    /// `set_app_handle` right after `new()`.
    app: Option<tauri::AppHandle>,
}

// SAFETY: ns_view_ptr / parent_view_ptr are raw pointers we never dereference
// off-main; all NSView ops go through main_sync. Renderer, ParserBridge, and
// the Arc/Mutex/thread plumbing are themselves Send.
unsafe impl Send for PlatformWindow {}

impl PlatformWindow {
    pub fn new(parent_handle: isize, rect: Rect, dpr: f32) -> Result<Self, String> {
        if parent_handle == 0 {
            return Err("native_term/macos: parent NSView pointer is null".into());
        }

        // ── Step 1: build the NSView + CAMetalLayer on the main thread.
        // We cast `parent_handle` (isize) to *mut NSView inside the closure
        // because raw pointers are !Send and can't cross dispatch_sync.
        let rect_for_closure = rect;
        let dpr_for_closure = dpr;
        let view_ptr = main_sync(move || -> Result<usize, String> {
            let mtm = MainThreadMarker::new()
                .ok_or_else(|| "main_sync ran off main thread".to_string())?;

            // SAFETY: parent_handle is the contentView pointer cached in
            // lib.rs setup(). NSWindow owns its contentView for the app's
            // lifetime, so the pointer is valid for this borrow.
            let parent_view: &NSView =
                unsafe { &*(parent_handle as *const NSView) };

            let parent_bounds = parent_view.bounds();
            let frame = flip_rect(rect_for_closure, parent_bounds.size.height as f32);

            let view: Retained<NSView> = NSView::initWithFrame(NSView::alloc(mtm), frame);

            // Layer-hosting setup: setWantsLayer → setLayer (in that order)
            // makes us a layer-hosting view. wgpu's Metal backend will use
            // the CAMetalLayer we attach here instead of creating its own.
            let metal_layer: Retained<CAMetalLayer> = CAMetalLayer::new();
            metal_layer.setContentsScale(dpr_for_closure as f64);
            view.setWantsLayer(true);
            let layer_ref: &objc2_quartz_core::CALayer = &metal_layer;
            view.setLayer(Some(layer_ref));

            // Sibling above WKWebView. `nil` reference with NSWindowOrderingMode::Above
            // means "above every existing subview".
            parent_view.addSubview_positioned_relativeTo(
                &view,
                NSWindowOrderingMode::Above,
                None,
            );

            // Hand the +1 strong ref out as a raw pointer for destroy() to
            // reclaim. addSubview retains independently, so the view stays
            // alive in the hierarchy until removeFromSuperview drops that
            // retain plus our destroy() drops ours.
            Ok(Retained::into_raw(view) as usize)
        })??;

        // ── Step 2: build the Renderer. It owns the wgpu Instance / Surface /
        // Device / Queue and a glyphon stack. Its surface will find the
        // CAMetalLayer we just attached.
        let view_nn = NonNull::new(view_ptr as *mut c_void)
            .ok_or_else(|| "ns_view ptr unexpectedly null after creation".to_string())?;
        let rwh = RawWindowHandle::AppKit(AppKitWindowHandle::new(view_nn));
        let rdh = RawDisplayHandle::AppKit(AppKitDisplayHandle::new());

        let w_px = (rect.width.max(1.0) * dpr) as u32;
        let h_px = (rect.height.max(1.0) * dpr) as u32;
        let renderer = Renderer::new(rwh, rdh, w_px.max(1), h_px.max(1)).map_err(|e| {
            // Renderer construction failed — roll back the NSView so we don't
            // leak a view sitting in the hierarchy with nothing rendering it.
            let _ = main_sync(move || {
                let view: Retained<NSView> = unsafe {
                    Retained::from_raw(view_ptr as *mut NSView)
                        .expect("ns_view ptr nil during error rollback")
                };
                view.removeFromSuperview();
                drop(view);
            });
            format!("native_term/macos: Renderer::new: {e}")
        })?;

        // Wrap the Renderer for shared access between command handlers and
        // (later) the render pump thread.
        let renderer_arc = Arc::new(Mutex::new(renderer));

        // Initial paint so the pane shows the placeholder buffer ("Hello,
        // MADE" until attach_pty installs a Term) instead of an uninit drawable.
        if let Ok(mut r) = renderer_arc.lock() {
            let _ = r.render();
        }

        Ok(PlatformWindow {
            ns_view_ptr: view_ptr,
            parent_view_ptr: parent_handle as usize,
            last_dpr: dpr,
            renderer: Some(renderer_arc),
            parser_bridge: None,
            attached_pty_id: None,
            term_id: None,
            render_stop: None,
            render_thread: None,
            app: None,
        })
    }

    /// Stash the AppHandle so attach_pty can pass it to ParserBridge for
    /// per-pane cursor / OSC133 / scroll event emission.
    pub fn set_app_handle(&mut self, app: tauri::AppHandle) {
        self.app = Some(app);
    }

    /// native_term_id mirror, matches win32's set_term_id role. Not used yet
    /// on macOS (no wnd_proc to thread per-pane channel names through) but
    /// kept for trait parity.
    pub fn set_term_id(&mut self, id: u32) {
        self.term_id = Some(id);
    }

    /// Stop the render pump if running. Used by detach_pty and destroy.
    fn stop_render_pump(&mut self) {
        if let Some(stop) = self.render_stop.take() {
            stop.store(true, Ordering::Relaxed);
        }
        if let Some(handle) = self.render_thread.take() {
            let _ = handle.join();
        }
    }
}

impl NativeTermWindow for PlatformWindow {
    fn resize(&mut self, rect: Rect, dpr: f32) -> Result<(), String> {
        self.last_dpr = dpr;

        // Reposition the NSView. Run on main thread.
        let view_ptr = self.ns_view_ptr;
        let parent_ptr = self.parent_view_ptr;
        main_sync(move || {
            // SAFETY: pointers are live (parent retained by NSWindow, view
            // retained by our +1 + addSubview).
            let parent: &NSView = unsafe { &*(parent_ptr as *const NSView) };
            let view: &NSView = unsafe { &*(view_ptr as *const NSView) };
            let parent_h = parent.bounds().size.height as f32;
            view.setFrame(flip_rect(rect, parent_h));
        })?;

        // Resize the wgpu surface + repaint.
        let w_px = (rect.width.max(1.0) * dpr) as u32;
        let h_px = (rect.height.max(1.0) * dpr) as u32;
        if let Some(arc) = &self.renderer {
            if let Ok(mut r) = arc.lock() {
                r.resize(w_px.max(1), h_px.max(1));
                let _ = r.render();
            }
        }
        Ok(())
    }

    fn show(&mut self) -> Result<(), String> {
        let view_ptr = self.ns_view_ptr;
        main_sync(move || {
            let view: &NSView = unsafe { &*(view_ptr as *const NSView) };
            view.setHidden(false);
        })?;
        if let Some(arc) = &self.renderer {
            if let Ok(mut r) = arc.lock() {
                let _ = r.render();
            }
        }
        Ok(())
    }

    fn hide(&mut self) -> Result<(), String> {
        let view_ptr = self.ns_view_ptr;
        main_sync(move || {
            let view: &NSView = unsafe { &*(view_ptr as *const NSView) };
            view.setHidden(true);
        })
    }

    fn set_region(&mut self, holes: &[Rect], _dpr: f32) -> Result<(), String> {
        // R4-δ hole-cut. Build a CAShapeLayer whose path covers the whole
        // pane MINUS the hole rects (even-odd fill), and install it as the
        // NSView layer's mask. CoreAnimation will composite our Metal output
        // through the mask, so popups z-above the pane appear through the
        // hole regions cleanly. Unlike Win32's SetWindowRgn (1-bit aliased
        // edges), CAShapeLayer supports antialiased + alpha-correct masking.
        let view_ptr = self.ns_view_ptr;
        let holes_vec: Vec<Rect> = holes.to_vec();
        main_sync(move || {
            // SAFETY: view_ptr is live (+1 ref held by PlatformWindow).
            let view: &NSView = unsafe { &*(view_ptr as *const NSView) };
            let bounds = view.bounds();
            let pane_w = bounds.size.width;
            let pane_h = bounds.size.height;

            let Some(layer) = view.layer() else {
                // wantsLayer was false at construction — nothing to mask.
                return;
            };

            if holes_vec.is_empty() {
                // Clear any previously-installed mask.
                unsafe { layer.setMask(None) };
                return;
            }

            // Build the CGPath: outer rect + each hole. Even-odd fill rule
            // subtracts the hole sub-paths from the outer fill area.
            // (NSRect/NSPoint/NSSize are type aliases for CGRect/CGPoint/CGSize
            // on Apple platforms, so CGPath functions accept them directly.)
            let path = CGMutablePath::new();
            let outer = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(pane_w, pane_h));
            unsafe { CGMutablePath::add_rect(Some(&path), std::ptr::null(), outer) };
            for h in &holes_vec {
                // AppKit origin is bottom-left of the layer; JS rects are
                // top-left. Flip y per-hole.
                let y_flipped = pane_h - h.y as f64 - h.height as f64;
                let r = NSRect::new(
                    NSPoint::new(h.x as f64, y_flipped),
                    NSSize::new(h.width as f64, h.height as f64),
                );
                unsafe { CGMutablePath::add_rect(Some(&path), std::ptr::null(), r) };
            }

            // CAShapeLayer with the path. Only the mask's alpha matters when
            // used via setMask; opaque black gives full visibility inside the
            // filled (even-odd) area and transparent outside.
            let shape: Retained<CAShapeLayer> = CAShapeLayer::new();
            let path_ref: &CGPath = &path;
            shape.setPath(Some(path_ref));
            unsafe { shape.setFillRule(kCAFillRuleEvenOdd) };
            let opaque = CGColorCreateSRGB(0.0, 0.0, 0.0, 1.0);
            // Explicit deref: opaque is CFRetained<CGColor>, setFillColor
            // wants Option<&CGColor>. Skipping the deref lets Option<>'s
            // monomorphisation hide the coercion and produces a confusing
            // type-mismatch error if anything changes.
            shape.setFillColor(Some(&*opaque));
            // Mask layers don't auto-track their target's bounds; we set them
            // explicitly so the path's coordinate system matches the layer it
            // masks.
            let shape_as_layer: &CALayer = &shape;
            shape_as_layer.setFrame(bounds);

            unsafe { layer.setMask(Some(shape_as_layer)) };
        })
    }

    fn destroy(self: Box<Self>) -> Result<(), String> {
        let mut this = self;

        // 1. Stop the render pump so it stops touching the renderer.
        this.stop_render_pump();

        // 2. Drop the parser bridge — joining its worker on Drop — and unwire
        //    the pty_route channel.
        if let Some(pty_id) = this.attached_pty_id.take() {
            pty_route::unlink(pty_id);
        }
        if let Some(term_id) = this.term_id.take() {
            pty_route::close_channel(term_id);
        }
        this.parser_bridge.take();

        // 3. Drop the Renderer BEFORE removing the view. The wgpu Surface
        //    holds the CAMetalLayer; releasing it first lets the layer
        //    deallocate cleanly when removeFromSuperview drops the NSView.
        this.renderer.take();

        // 4. removeFromSuperview + release our +1 strong ref on the NSView.
        let view_ptr = this.ns_view_ptr;
        main_sync(move || {
            // SAFETY: view_ptr is the +1 strong reference we took in new().
            // Retained::from_raw reclaims it; drop releases.
            let view: Retained<NSView> = unsafe {
                Retained::from_raw(view_ptr as *mut NSView)
                    .expect("native_term/macos: view ptr nil at destroy")
            };
            view.removeFromSuperview();
            drop(view);
        })?;
        Ok(())
    }

    fn attach_pty(
        &mut self,
        term_id: u32,
        pty_id: u32,
        cols: usize,
        rows: usize,
    ) -> Result<(), String> {
        // Idempotency: if anything is already attached, tear it down first.
        if self.parser_bridge.is_some() {
            let _ = self.detach_pty();
        }

        // pty_route channel must exist before pty.rs side-emits the first byte.
        let rx = pty_route::create_channel(term_id);
        pty_route::link(term_id, pty_id);

        // Spawn the parser worker. Cell metrics are the Hack-14 default; once
        // set_font is hot-swappable on macOS the bridge will be re-spawned
        // with fresh metrics — same as Win32 ChildState.cell_*_px.
        let bridge = ParserBridge::spawn(
            term_id,
            cols,
            rows,
            rx,
            INITIAL_CELL_W_LOGICAL,
            INITIAL_CELL_H_LOGICAL,
            self.app.clone(),
        );
        let term_arc = Arc::clone(&bridge.term);

        // Hand the Term Arc to the renderer's grid + start the render pump.
        if let Some(arc) = &self.renderer {
            if let Ok(mut r) = arc.lock() {
                r.attach_term(Arc::clone(&term_arc), cols, rows);
            }
        }
        self.parser_bridge = Some(bridge);
        self.attached_pty_id = Some(pty_id);
        self.term_id = Some(term_id);

        // Render pump: while the AtomicBool is false, lock the renderer
        // mutex and call render(), then sleep. Equivalent to win32's
        // WM_TIMER tick but cross-thread.
        let renderer_for_thread = self
            .renderer
            .as_ref()
            .expect("renderer missing at attach_pty")
            .clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_for_thread = stop.clone();
        let handle = std::thread::Builder::new()
            .name(format!("native_term-{}-render", term_id))
            .spawn(move || {
                while !stop_for_thread.load(Ordering::Relaxed) {
                    if let Ok(mut r) = renderer_for_thread.lock() {
                        let _ = r.render();
                    }
                    std::thread::sleep(RENDER_INTERVAL);
                }
            })
            .map_err(|e| format!("native_term/macos: spawn render thread: {e}"))?;
        self.render_stop = Some(stop);
        self.render_thread = Some(handle);

        Ok(())
    }

    fn detach_pty(&mut self) -> Result<(), String> {
        self.stop_render_pump();

        if let Some(pty_id) = self.attached_pty_id.take() {
            pty_route::unlink(pty_id);
        }
        if let Some(term_id) = self.term_id.take() {
            pty_route::close_channel(term_id);
        }
        self.parser_bridge.take();

        if let Some(arc) = &self.renderer {
            if let Ok(mut r) = arc.lock() {
                r.detach_term();
                // One final frame so the pane doesn't sit on a stale buffer.
                let _ = r.render();
            }
        }
        Ok(())
    }

    fn propose_dimensions(&self, width_px: u32, height_px: u32) -> (u32, u32) {
        // Heuristic mirror of win32's R1.c impl: ~Hack-14 metrics. Real
        // pull-through from cell_metrics() lands when set_font is wired.
        // The cols ≥ 20 floor is the plan's narrow-pane guard.
        let cell_w: u32 = 9;
        let cell_h: u32 = 17;
        let cols = (width_px / cell_w).max(20);
        let rows = (height_px / cell_h).max(1);
        (cols, rows)
    }

    fn set_theme(&mut self, theme: &TerminalTheme) -> Result<(), String> {
        let colors = parse_theme(theme)?;
        if let Some(arc) = &self.renderer {
            if let Ok(mut r) = arc.lock() {
                r.set_theme(colors);
                let _ = r.render(); // immediate visual feedback
            }
        }
        Ok(())
    }

    fn set_font(&mut self, family: &str, size_px: f32) -> Result<(), String> {
        if let Some(arc) = &self.renderer {
            if let Ok(mut r) = arc.lock() {
                r.set_font(family.to_string(), size_px);
                let _ = r.render();
            }
        }
        Ok(())
    }

    fn set_cursor_style(&mut self, style: &str, blink: bool) -> Result<(), String> {
        if let Some(arc) = &self.renderer {
            if let Ok(mut r) = arc.lock() {
                r.set_cursor_style(style, blink);
                let _ = r.render();
            }
        }
        Ok(())
    }

    fn set_search_highlights(&mut self, rects: Vec<Rect>) -> Result<(), String> {
        if let Some(arc) = &self.renderer {
            if let Ok(mut r) = arc.lock() {
                r.set_search_highlights(rects);
                let _ = r.render();
            }
        }
        Ok(())
    }

    fn clear_search_highlights(&mut self) -> Result<(), String> {
        if let Some(arc) = &self.renderer {
            if let Ok(mut r) = arc.lock() {
                r.clear_search_highlights();
                let _ = r.render();
            }
        }
        Ok(())
    }

    fn term(&self) -> Option<Arc<Mutex<Term<TermListener>>>> {
        self.parser_bridge.as_ref().map(|b| Arc::clone(&b.term))
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
/// `dispatch_sync` on the main queue traps if invoked from the main thread,
/// so we short-circuit when already on main. Tauri command handlers run on
/// the tokio pool (off-main) — the short-circuit is defensive but makes the
/// helper safe to call from any thread.
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

/// Parse a `#RRGGBB` or `#RRGGBBAA` hex string into a 4-byte RGBA color.
/// Same logic as the Win32 helper; duplicated here so this file can land
/// without touching `window/win32.rs`. Consolidate into a shared
/// `theme_parse` module after macOS is daily-driverable.
fn parse_hex_color(s: &str, field: &str) -> Result<[u8; 4], String> {
    let bytes = s.strip_prefix('#').unwrap_or(s);
    if bytes.len() != 6 && bytes.len() != 8 {
        return Err(format!(
            "native_term::set_theme: field `{field}` must be #RRGGBB or #RRGGBBAA (got `{s}`)"
        ));
    }
    let parse = |i: usize| -> Result<u8, String> {
        u8::from_str_radix(&bytes[i..i + 2], 16)
            .map_err(|_| format!("native_term::set_theme: field `{field}` is not valid hex"))
    };
    let r = parse(0)?;
    let g = parse(2)?;
    let b = parse(4)?;
    let a = if bytes.len() == 8 { parse(6)? } else { 0xFF };
    Ok([r, g, b, a])
}

fn parse_theme(theme: &TerminalTheme) -> Result<ThemeColors, String> {
    let ansi = [
        parse_hex_color(&theme.ansi0, "ansi0")?,
        parse_hex_color(&theme.ansi1, "ansi1")?,
        parse_hex_color(&theme.ansi2, "ansi2")?,
        parse_hex_color(&theme.ansi3, "ansi3")?,
        parse_hex_color(&theme.ansi4, "ansi4")?,
        parse_hex_color(&theme.ansi5, "ansi5")?,
        parse_hex_color(&theme.ansi6, "ansi6")?,
        parse_hex_color(&theme.ansi7, "ansi7")?,
        parse_hex_color(&theme.ansi8, "ansi8")?,
        parse_hex_color(&theme.ansi9, "ansi9")?,
        parse_hex_color(&theme.ansi10, "ansi10")?,
        parse_hex_color(&theme.ansi11, "ansi11")?,
        parse_hex_color(&theme.ansi12, "ansi12")?,
        parse_hex_color(&theme.ansi13, "ansi13")?,
        parse_hex_color(&theme.ansi14, "ansi14")?,
        parse_hex_color(&theme.ansi15, "ansi15")?,
    ];
    Ok(ThemeColors {
        ansi,
        foreground: parse_hex_color(&theme.foreground, "foreground")?,
        background: parse_hex_color(&theme.background, "background")?,
        cursor: parse_hex_color(&theme.cursor, "cursor")?,
        cursor_accent: parse_hex_color(&theme.cursor_accent, "cursorAccent")?,
        selection: parse_hex_color(&theme.selection, "selection")?,
    })
}
