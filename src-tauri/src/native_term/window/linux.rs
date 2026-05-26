// Phase 4 Linux R4 implementation: GTK 3 DrawingArea sibling of webkit2gtk
// WebView + wgpu surface driven by the shared Renderer + ParserBridge +
// pty_route stack.
//
// Mirrors `window/macos.rs` chunk-for-chunk; differences explained inline:
//   • macOS subclasses NSView via objc2 `define_class!`. GTK3 widget subclassing
//     in Rust requires heavy boilerplate (subclass module + glib::wrapper!
//     + ObjectSubclass impls), so for the spike we use a plain
//     `gtk::DrawingArea` and attach behaviour via `connect_*` signal handlers.
//     The behavioural contract (keyDown / mouseDown / scroll / hover / ime) is
//     identical; only the dispatch mechanism differs.
//   • macOS uses `dispatch2::Queue::main().exec_sync` for off-main → main
//     sync bounce. GTK3 has no native sync bounce — we use
//     `glib::MainContext::invoke()` + `mpsc::sync_channel` to recover sync
//     semantics.
//   • macOS owns its CAMetalLayer directly. On Linux the wgpu Surface adopts
//     the GdkWindow's underlying Xlib XID or Wayland wl_surface; both come
//     from the realized DrawingArea via `gdk_x11_window_get_xid` /
//     `gdk_wayland_window_get_wl_surface` declared as extern "C" below
//     (avoids pulling in gdkx11-sys / gdkwayland-sys crates as separate deps).
//   • macOS hole-cuts with a CAShapeLayer mask (alpha-correct). Linux input
//     hole-cut uses `gtk_widget_input_shape_combine_region` (Cairo region) —
//     pointer/keyboard events fall through, but the widget's RENDERED pixels
//     still cover the area. Full visual hole-cut needs an alpha-aware
//     compositor pass in the wgpu renderer; deferred to follow-up (see TODO).
//   • IME is stubbed — γ-5 equivalent (GtkIMContextSimple / IBus integration)
//     is deferred. The wiring point is marked with a TODO inside the key-press
//     handler.
//
// Threading model
// ─────────────────
//   • GTK widget mutations (size_request, show/hide, queue_draw, region
//     setters) MUST happen on the GLib main thread. `main_sync` bounces.
//   • wgpu calls (Renderer::render / resize / set_theme / ...) are
//     thread-safe; the render thread locks the Renderer's Mutex and calls
//     `render()` at ~60Hz while a PTY is attached. Command handlers acquire
//     the same Mutex briefly.
//   • The Renderer's wgpu Surface holds an Xlib/Wayland handle to the
//     DrawingArea's GdkWindow. The Surface MUST be dropped before the widget
//     unparents, so `destroy()` follows the macOS order: stop render thread
//     → drop ParserBridge → drop Renderer → main_sync to unparent the widget.

#![allow(unexpected_cfgs)]
#![allow(dead_code)]

use std::ffi::c_void;
use std::os::raw::c_ulong;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use gdk::prelude::*;
use gtk::prelude::*;
use glib::Propagation;
use gtk::{ApplicationWindow, Container, DrawingArea, Widget};

use raw_window_handle::{
    RawDisplayHandle, RawWindowHandle, WaylandDisplayHandle, WaylandWindowHandle,
    XlibDisplayHandle, XlibWindowHandle,
};

use alacritty_terminal::grid::Scroll;
use alacritty_terminal::index::{Column, Line, Point, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::term::{Term, TermMode};

use super::super::events::{
    emit_cell_hover, emit_cell_hover_end, emit_key_down_preview, emit_link_click, emit_link_hover,
    emit_r_button, emit_selection, CellHover, KeyDownPreview, KeyEventDto, KeyModifiers, LinkClick,
    LinkHover, RButton, Selection as SelectionEvent,
};

use super::super::parser_bridge::{ParserBridge, TermListener};
use super::super::pty_route;
use super::super::renderer::Renderer;
use super::super::theme_parse::parse_theme;
use super::{NativeTermWindow, Rect, TerminalTheme};

/// Frame interval for the render pump while a PTY is attached. Matches macOS /
/// Win32 — close to 60Hz but slightly behind so we don't busy-spin when the
/// parser is idle.
const RENDER_INTERVAL: Duration = Duration::from_millis(16);

/// Initial per-cell logical-px metrics handed to ParserBridge::spawn. Same
/// Hack-14 defaults as the other platforms.
const INITIAL_CELL_W_LOGICAL: f32 = 8.4;
const INITIAL_CELL_H_LOGICAL: f32 = 17.0;

/// Number of lines per scroll-wheel notch — mirrors the macOS / win32 helpers.
const SCROLL_LINES_PER_NOTCH: i32 = 3;

// ─── extern "C" GDK platform helpers ─────────────────────────────────────
// gdkx11 / gdkwayland have dedicated Rust crates (`gdkx11-sys` /
// `gdkwayland-sys`), but pulling them in just for two FFI calls is overkill
// for the spike. Declare the symbols directly; libgdk-3 always exposes them
// on Linux builds.
extern "C" {
    fn gdk_x11_window_get_xid(window: *mut gdk::ffi::GdkWindow) -> c_ulong;
    fn gdk_x11_display_get_xdisplay(display: *mut gdk::ffi::GdkDisplay) -> *mut c_void;
    fn gdk_wayland_window_get_wl_surface(window: *mut gdk::ffi::GdkWindow) -> *mut c_void;
    fn gdk_wayland_display_get_wl_display(display: *mut gdk::ffi::GdkDisplay) -> *mut c_void;
}

/// Detected display server. Decided at runtime in PlatformWindow::new from
/// the GDK display's backend name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Backend {
    X11,
    Wayland,
}

fn detect_backend(display: &gdk::Display) -> Result<Backend, String> {
    // gdk::DisplayExtManual::backend() returns gdk::Backend, decided by the
    // runtime GObject type name (GdkX11Display / GdkWaylandDisplay).
    let b = display.backend();
    if b.is_x11() {
        Ok(Backend::X11)
    } else if b.is_wayland() {
        Ok(Backend::Wayland)
    } else {
        Err(format!(
            "native_term/linux: unsupported GDK backend {b:?} (need x11 or wayland)"
        ))
    }
}

// ─── MtvState (shared input-handler state) ──────────────────────────────
//
// Mirrors `MtvState` in macos.rs. Holds the PTY id, the alacritty `Term` arc,
// the AppHandle for event emission, and per-pane mouse-hover coalescing keys.
// All Option<...> so a fresh widget (no PTY yet) handles events safely.
pub(super) struct MtvState {
    pub(super) pty_id: Option<u32>,
    pub(super) term: Option<Arc<Mutex<Term<TermListener>>>>,
    pub(super) app: Option<tauri::AppHandle>,
    pub(super) term_id: Option<u32>,
    pub(super) lbutton_down: bool,
    pub(super) cell_w_px: f32,
    pub(super) cell_h_px: f32,
    pub(super) last_cell_hover: Option<(i64, u32)>,
    pub(super) last_link_hover: Option<(i64, u32, String)>,
    pub(super) last_motion_cell: Option<(u32, u32)>,
}

impl MtvState {
    fn new() -> Self {
        Self {
            pty_id: None,
            term: None,
            app: None,
            term_id: None,
            lbutton_down: false,
            cell_w_px: INITIAL_CELL_W_LOGICAL,
            cell_h_px: INITIAL_CELL_H_LOGICAL,
            last_cell_hover: None,
            last_link_hover: None,
            last_motion_cell: None,
        }
    }
}

pub struct PlatformWindow {
    /// Strong reference to the DrawingArea widget. GObject reference counting
    /// keeps it alive while parented; we hold one extra ref to enable
    /// explicit reparent / destroy.
    drawing_area: DrawingArea,
    /// The container the drawing_area was added into. Kept around so destroy
    /// can call `container.remove(&drawing_area)` symmetrically.
    parent: Widget,
    /// Cached DPR — used for surface pixel dims and resize math.
    last_dpr: f32,

    /// Production Renderer (parser bridge + glyphon + cursor pass). Behind
    /// Arc<Mutex>. `Option` so `destroy()` can `take()` it BEFORE the widget
    /// unparents — the wgpu Surface holds the GdkWindow handle that must be
    /// released first.
    renderer: Option<Arc<Mutex<Renderer>>>,

    parser_bridge: Option<ParserBridge>,
    attached_pty_id: Option<u32>,
    term_id: Option<u32>,

    render_stop: Option<Arc<AtomicBool>>,
    render_thread: Option<JoinHandle<()>>,

    app: Option<tauri::AppHandle>,

    /// Shared input-handler state. Cloned-Arc lives inside the
    /// connect_*-installed signal handlers so they can read pty_id + term.
    mtv_state: Arc<Mutex<MtvState>>,

    backend: Backend,
}

// SAFETY: drawing_area / parent are GTK objects that are `!Send` (GObject
// borrow rules). All widget operations are bounced through main_sync onto the
// GLib main thread, so off-main accesses are confined to inert handle moves.
// The Send marker is required because `registry::insert` boxes us as
// `Box<dyn NativeTermWindow + Send>`.
unsafe impl Send for PlatformWindow {}

impl PlatformWindow {
    pub fn new(parent_handle: isize, rect: Rect, dpr: f32) -> Result<Self, String> {
        if parent_handle == 0 {
            return Err("native_term/linux: parent GTK window pointer is null".into());
        }

        // ── Step 1: build the DrawingArea on the GLib main thread, parent
        // it, and capture the realized GdkWindow handle for wgpu.
        let mtv_state = Arc::new(Mutex::new(MtvState::new()));
        let mtv_state_for_widget = Arc::clone(&mtv_state);
        let rect_for_closure = rect;

        let setup = main_sync(move || -> Result<SetupResult, String> {
            // SAFETY: parent_handle is the GtkApplicationWindow raw pointer
            // cached in lib.rs setup(). Tauri keeps the main window alive for
            // the app's lifetime, so the pointer is valid for this borrow.
            // `from_glib_none` takes a shared (non-owning) reference and
            // wraps it in a Rust GObject smart pointer (incrementing the
            // refcount).
            let app_window: ApplicationWindow = unsafe {
                let ptr = parent_handle as *mut gtk::ffi::GtkApplicationWindow;
                glib::translate::from_glib_none(ptr)
            };

            // Locate the child container holding the webview. Tauri/tao's
            // default Linux setup wraps the WebView in a `gtk::Box` placed as
            // the ApplicationWindow's sole child.
            let parent_widget: Widget = app_window
                .child()
                .ok_or_else(|| "native_term/linux: ApplicationWindow has no child".to_string())?;

            let drawing_area = DrawingArea::new();
            drawing_area.set_can_focus(true);
            drawing_area.set_size_request(
                rect_for_closure.width.max(1.0) as i32,
                rect_for_closure.height.max(1.0) as i32,
            );
            // Event masks for every connect_* handler installed below.
            drawing_area.add_events(
                gdk::EventMask::BUTTON_PRESS_MASK
                    | gdk::EventMask::BUTTON_RELEASE_MASK
                    | gdk::EventMask::POINTER_MOTION_MASK
                    | gdk::EventMask::SCROLL_MASK
                    | gdk::EventMask::SMOOTH_SCROLL_MASK
                    | gdk::EventMask::KEY_PRESS_MASK
                    | gdk::EventMask::KEY_RELEASE_MASK
                    | gdk::EventMask::ENTER_NOTIFY_MASK
                    | gdk::EventMask::LEAVE_NOTIFY_MASK,
            );

            // Add as another child of the existing container. GtkBox doesn't
            // honor z-order the way an NSView contentView or an HWND child
            // stack does — for true above-the-WebView painting we'd need to
            // swap the existing child for a GtkOverlay. Spike-quality: just
            // append; if the WebView covers the widget visually, the user
            // sees the WebView's frame but our input/render plumbing still
            // works for later refinement.
            //
            // TODO: replace the container with a GtkOverlay so the
            // DrawingArea sits genuinely above the WebView.
            if let Some(container) = parent_widget.downcast_ref::<Container>() {
                container.add(&drawing_area);
            } else {
                // ApplicationWindow has only one child slot. Swap the child
                // for a GtkOverlay holding both. (Won't happen with vanilla
                // Tauri but defends against unusual embedding.)
                app_window.remove(&parent_widget);
                let overlay = gtk::Overlay::new();
                overlay.add(&parent_widget);
                overlay.add_overlay(&drawing_area);
                app_window.add(&overlay);
                overlay.show_all();
            }
            drawing_area.show();

            // Detect backend now that we have a display.
            let display = drawing_area.display();
            let backend = detect_backend(&display)?;

            // Realize so the GdkWindow exists; wgpu needs a live native
            // handle.
            drawing_area.realize();
            let gdk_window = drawing_area.window().ok_or_else(|| {
                "native_term/linux: DrawingArea has no GdkWindow after realize".to_string()
            })?;

            // Wire input-handler signals. Each closure clones the shared
            // MtvState arc; all of them dispatch on the GLib main thread, so
            // the lock is uncontested in practice.
            install_signal_handlers(&drawing_area, Arc::clone(&mtv_state_for_widget));

            // Pull the raw native handles for wgpu surface creation.
            let (rwh, rdh) = build_raw_handles(backend, &gdk_window, &display)?;

            Ok(SetupResult {
                drawing_area,
                parent_widget,
                rwh: SendableRwh(rwh),
                rdh: SendableRdh(rdh),
                backend,
            })
        })??;

        // ── Step 2: build the Renderer outside the main-thread closure —
        // Renderer::new internally pollster-blocks the wgpu device request,
        // which would deadlock the GLib main loop if run inside main_sync.
        let w_px = (rect.width.max(1.0) * dpr) as u32;
        let h_px = (rect.height.max(1.0) * dpr) as u32;
        let renderer =
            Renderer::new(setup.rwh.0, setup.rdh.0, w_px.max(1), h_px.max(1)).map_err(|e| {
                // Roll back the widget if Renderer::new failed.
                let da = setup.drawing_area.clone();
                let _ = main_sync(move || {
                    if let Some(p) = da.parent() {
                        if let Some(c) = p.downcast_ref::<Container>() {
                            c.remove(&da);
                        }
                    }
                });
                format!("native_term/linux: Renderer::new: {e}")
            })?;

        let renderer_arc = Arc::new(Mutex::new(renderer));

        // Initial paint.
        if let Ok(mut r) = renderer_arc.lock() {
            let _ = r.render();
        }

        Ok(PlatformWindow {
            drawing_area: setup.drawing_area,
            parent: setup.parent_widget,
            last_dpr: dpr,
            renderer: Some(renderer_arc),
            parser_bridge: None,
            attached_pty_id: None,
            term_id: None,
            render_stop: None,
            render_thread: None,
            app: None,
            mtv_state,
            backend: setup.backend,
        })
    }

    /// Stash the AppHandle so attach_pty can hand it to ParserBridge for
    /// per-pane cursor / OSC133 / scroll event emission. Also mirrors it
    /// into the input-handler state so per-pane events emit without a
    /// global lookup.
    pub fn set_app_handle(&mut self, app: tauri::AppHandle) {
        if let Ok(mut s) = self.mtv_state.lock() {
            s.app = Some(app.clone());
        }
        self.app = Some(app);
    }

    /// native_term_id mirror; matches win32 / macOS set_term_id role.
    pub fn set_term_id(&mut self, id: u32) {
        self.term_id = Some(id);
        if let Ok(mut s) = self.mtv_state.lock() {
            s.term_id = Some(id);
        }
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

/// Carries the realized-widget bits out of main_sync. The raw-window-handle
/// values are wrapped in send-marker newtypes because the FFI pointers are
/// `*mut c_void` and the closure containing them must be Send to cross the
/// main_sync boundary.
struct SetupResult {
    drawing_area: DrawingArea,
    parent_widget: Widget,
    rwh: SendableRwh,
    rdh: SendableRdh,
    backend: Backend,
}

struct SendableRwh(RawWindowHandle);
struct SendableRdh(RawDisplayHandle);
// SAFETY: the inner pointers (XID / wl_surface / X Display / wl_display) are
// stable references managed by GDK for the lifetime of the display. We never
// dereference them off-main; wgpu's surface creation is the only consumer
// and it runs immediately after main_sync returns.
unsafe impl Send for SendableRwh {}
unsafe impl Send for SendableRdh {}

/// Pull `RawWindowHandle` + `RawDisplayHandle` from a realized GdkWindow.
fn build_raw_handles(
    backend: Backend,
    gdk_window: &gdk::Window,
    display: &gdk::Display,
) -> Result<(RawWindowHandle, RawDisplayHandle), String> {
    use glib::translate::ToGlibPtr;
    let win_ptr: *mut gdk::ffi::GdkWindow = gdk_window.to_glib_none().0;
    let disp_ptr: *mut gdk::ffi::GdkDisplay = display.to_glib_none().0;

    match backend {
        Backend::X11 => {
            let xid = unsafe { gdk_x11_window_get_xid(win_ptr) };
            if xid == 0 {
                return Err("native_term/linux: gdk_x11_window_get_xid returned 0".into());
            }
            let xdisplay = unsafe { gdk_x11_display_get_xdisplay(disp_ptr) };
            let wh = XlibWindowHandle::new(xid as c_ulong);
            // wh.visual_id stays at the constructor default (0); wgpu
            // queries it from the display when needed.
            let dh = XlibDisplayHandle::new(NonNull::new(xdisplay), 0 /* screen */);
            Ok((RawWindowHandle::Xlib(wh), RawDisplayHandle::Xlib(dh)))
        }
        Backend::Wayland => {
            let surface_ptr = unsafe { gdk_wayland_window_get_wl_surface(win_ptr) };
            let surface_nn = NonNull::new(surface_ptr)
                .ok_or_else(|| "native_term/linux: wl_surface is null".to_string())?;
            let display_ptr = unsafe { gdk_wayland_display_get_wl_display(disp_ptr) };
            let display_nn = NonNull::new(display_ptr)
                .ok_or_else(|| "native_term/linux: wl_display is null".to_string())?;
            let wh = WaylandWindowHandle::new(surface_nn);
            let dh = WaylandDisplayHandle::new(display_nn);
            Ok((RawWindowHandle::Wayland(wh), RawDisplayHandle::Wayland(dh)))
        }
    }
}

// ─── signal handlers (the GTK equivalent of macOS's NSView overrides) ────

fn install_signal_handlers(da: &DrawingArea, state: Arc<Mutex<MtvState>>) {
    // Button-press → focus + selection-start / xterm mouse / ctrl-click link.
    {
        let state = Arc::clone(&state);
        da.connect_button_press_event(move |w, ev| {
            handle_button_press(w, ev, &state);
            Propagation::Stop
        });
    }
    // Motion-notify → selection-extend / xterm 1002+1003 motion / hover.
    {
        let state = Arc::clone(&state);
        da.connect_motion_notify_event(move |w, ev| {
            handle_motion(w, ev, &state);
            Propagation::Proceed
        });
    }
    // Button-release → selection finalize + clipboard / xterm mouse release.
    {
        let state = Arc::clone(&state);
        da.connect_button_release_event(move |w, ev| {
            handle_button_release(w, ev, &state);
            Propagation::Proceed
        });
    }
    // Scroll → forward to alacritty's scroll_display.
    {
        let state = Arc::clone(&state);
        da.connect_scroll_event(move |w, ev| {
            handle_scroll(w, ev, &state);
            Propagation::Stop
        });
    }
    // Key-press → UI-shortcut whitelist + translate to PTY bytes.
    //
    // TODO: IME via GtkIMContextSimple / IBus. The current implementation
    // unconditionally translates GdkKey to PTY bytes. Full IME support
    // routes through IMContext::filter_keypress() so dead-keys / CJK
    // composition fan out as `ime_composition` events (mirrors macOS γ-5 /
    // win32 WM_IME_*). Deferred per the Phase 4 Linux scope.
    {
        let state = Arc::clone(&state);
        da.connect_key_press_event(move |w, ev| {
            let handled = handle_key_press(w, ev, &state);
            if handled {
                Propagation::Stop
            } else {
                Propagation::Proceed
            }
        });
    }
    // Leave-notify → cell_hover_end + reset coalescing keys.
    {
        let state = Arc::clone(&state);
        da.connect_leave_notify_event(move |_w, _ev| {
            let (app, term_id) = {
                let mut s = match state.lock() {
                    Ok(g) => g,
                    Err(_) => return Propagation::Proceed,
                };
                s.last_cell_hover = None;
                s.last_link_hover = None;
                (s.app.clone(), s.term_id)
            };
            if let (Some(app), Some(tid)) = (app, term_id) {
                emit_cell_hover_end(&app, tid);
            }
            Propagation::Proceed
        });
    }
}

fn handle_button_press(
    widget: &DrawingArea,
    ev: &gdk::EventButton,
    state: &Arc<Mutex<MtvState>>,
) {
    // Take keyboard focus.
    widget.grab_focus();

    let (x_px, y_px) = {
        let (x, y) = ev.position();
        (x as f32, y as f32)
    };
    let modifiers = ev.state();
    let shift = modifiers.contains(gdk::ModifierType::SHIFT_MASK);
    let ctrl = modifiers.contains(gdk::ModifierType::CONTROL_MASK);
    let alt = modifiers.contains(gdk::ModifierType::MOD1_MASK);

    // Button 3 = right-click → r_button event.
    if ev.button() == 3 {
        let (app, term_id) = {
            let s = match state.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            (s.app.clone(), s.term_id)
        };
        if let (Some(app), Some(tid)) = (app, term_id) {
            emit_r_button(&app, tid, RButton { x: x_px, y: y_px });
        }
        return;
    }

    // LMB-only beyond this point — match macOS `_mouse_down`.
    if ev.button() != 1 {
        return;
    }

    let (pty_id, term_arc, app, term_id, cell_w, cell_h) = {
        let mut s = match state.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        s.lbutton_down = true;
        (
            s.pty_id,
            s.term.clone(),
            s.app.clone(),
            s.term_id,
            s.cell_w_px,
            s.cell_h_px,
        )
    };

    // Ctrl+click on a hyperlinked cell → link_click + skip selection.
    if ctrl {
        let click_link = if let Some(term) = term_arc.as_ref() {
            let t = match term.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            let grid = t.grid();
            let cols = grid.columns();
            let rows = grid.screen_lines();
            let display_offset_i = grid.display_offset() as i32;
            let cell_w_safe = cell_w.max(0.001);
            let line_h_safe = cell_h.max(0.001);
            let row_visible = (y_px / line_h_safe).floor() as i32;
            let col_raw = (x_px / cell_w_safe).floor() as i32;
            if cols > 0
                && rows > 0
                && row_visible >= 0
                && (row_visible as usize) < rows
                && col_raw >= 0
                && (col_raw as usize) < cols
            {
                let line_i32 = row_visible - display_offset_i;
                let cell = &grid[Line(line_i32)][Column(col_raw as usize)];
                cell.hyperlink()
                    .map(|h| (h.uri().to_owned(), line_i32 as i64, col_raw as u32))
            } else {
                None
            }
        } else {
            None
        };
        if let Some((uri, line, col)) = click_link {
            if let (Some(app), Some(tid)) = (app.as_ref(), term_id) {
                emit_link_click(
                    app,
                    tid,
                    LinkClick {
                        uri,
                        line,
                        col,
                        modifiers: KeyModifiers {
                            ctrl,
                            shift,
                            alt,
                            meta: false,
                        },
                    },
                );
            }
            return;
        }
    }

    // xterm mouse-mode forwarding (unless Shift escape-hatched).
    if !shift {
        let modes = term_arc
            .as_ref()
            .map(|t| read_mouse_modes_from_term(t))
            .unwrap_or_default();
        if modes.clicks_enabled {
            let (x_cell, y_cell) = px_to_cell_1based(x_px, y_px, cell_w, cell_h);
            let fmt = mouse_format(modes);
            if let Some(bytes) =
                encode_mouse_event(0, x_cell, y_cell, ctrl, shift, alt, true, false, fmt)
            {
                if let Some(pid) = pty_id {
                    let _ = crate::pty::write_to_pty_sync(pid, &bytes);
                }
            }
            return;
        }
    }

    // Selection start.
    let Some(term_arc) = term_arc else { return };
    if let Some(point) = mouse_to_point(&term_arc, x_px, y_px, cell_w, cell_h) {
        if let Ok(mut t) = term_arc.lock() {
            t.selection = Some(Selection::new(SelectionType::Simple, point, Side::Left));
        }
    }
}

fn handle_motion(_widget: &DrawingArea, ev: &gdk::EventMotion, state: &Arc<Mutex<MtvState>>) {
    let (x_px, y_px) = {
        let (x, y) = ev.position();
        (x as f32, y as f32)
    };
    let modifiers = ev.state();
    let shift = modifiers.contains(gdk::ModifierType::SHIFT_MASK);
    let ctrl = modifiers.contains(gdk::ModifierType::CONTROL_MASK);
    let alt = modifiers.contains(gdk::ModifierType::MOD1_MASK);
    let lbutton_held = modifiers.contains(gdk::ModifierType::BUTTON1_MASK);

    let (pty_id, term_arc, app, term_id, cell_w, cell_h, lbutton_state) = {
        let s = match state.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        (
            s.pty_id,
            s.term.clone(),
            s.app.clone(),
            s.term_id,
            s.cell_w_px,
            s.cell_h_px,
            s.lbutton_down,
        )
    };
    let Some(term_arc) = term_arc else { return };

    let dragging = lbutton_state && lbutton_held;

    // xterm 1002 (drag) / 1003 (any-motion) forwarding.
    if !shift {
        let modes = read_mouse_modes_from_term(&term_arc);
        let drag_active = dragging && modes.drag_enabled;
        let motion_active = modes.motion_enabled;
        if drag_active || motion_active {
            let (x_cell, y_cell) = px_to_cell_1based(x_px, y_px, cell_w, cell_h);
            let cell_key = (x_cell, y_cell);
            let should_emit = {
                let mut s = match state.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                if s.last_motion_cell == Some(cell_key) {
                    false
                } else {
                    s.last_motion_cell = Some(cell_key);
                    true
                }
            };
            if should_emit {
                let fmt = mouse_format(modes);
                let btn = if dragging { 0 } else { 3 };
                if let Some(bytes) =
                    encode_mouse_event(btn, x_cell, y_cell, ctrl, shift, alt, true, true, fmt)
                {
                    if let Some(pid) = pty_id {
                        let _ = crate::pty::write_to_pty_sync(pid, &bytes);
                    }
                }
            }
            return;
        }
    }

    // Selection extend while LMB held.
    if dragging {
        if let Some(point) = mouse_to_point(&term_arc, x_px, y_px, cell_w, cell_h) {
            if let Ok(mut t) = term_arc.lock() {
                if let Some(sel) = t.selection.as_mut() {
                    sel.update(point, Side::Right);
                }
            }
        }
        return;
    }

    // Hover (cell_hover + link_hover).
    let cell_w_safe = cell_w.max(0.001);
    let line_h_safe = cell_h.max(0.001);
    let row_visible = (y_px / line_h_safe).floor() as i32;
    let col_raw = (x_px / cell_w_safe).floor() as i32;

    let (display_offset, hover_uri) = {
        let t = match term_arc.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let grid = t.grid();
        let cols = grid.columns();
        let rows = grid.screen_lines();
        let display_offset_i = grid.display_offset() as i32;
        let uri = if cols > 0
            && rows > 0
            && row_visible >= 0
            && (row_visible as usize) < rows
            && col_raw >= 0
            && (col_raw as usize) < cols
        {
            let line = Line(row_visible - display_offset_i);
            let cell = &grid[line][Column(col_raw as usize)];
            cell.hyperlink().map(|h| h.uri().to_owned())
        } else {
            None
        };
        (display_offset_i, uri)
    };

    let line_signed = row_visible as i64 - display_offset as i64;
    let col = col_raw.max(0) as u32;
    let key = (line_signed, col);

    let cell_changed = {
        let mut s = match state.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if s.last_cell_hover == Some(key) {
            false
        } else {
            s.last_cell_hover = Some(key);
            true
        }
    };
    if cell_changed {
        if let (Some(app), Some(tid)) = (app.as_ref(), term_id) {
            emit_cell_hover(
                app,
                tid,
                CellHover {
                    line: line_signed,
                    col,
                },
            );
        }
    }

    match hover_uri {
        Some(uri) => {
            let link_key = (line_signed, col, uri.clone());
            let link_changed = {
                let mut s = match state.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                if s.last_link_hover.as_ref() == Some(&link_key) {
                    false
                } else {
                    s.last_link_hover = Some(link_key);
                    true
                }
            };
            if link_changed {
                if let (Some(app), Some(tid)) = (app.as_ref(), term_id) {
                    let rect = Rect {
                        x: col as f32 * cell_w_safe,
                        y: row_visible.max(0) as f32 * line_h_safe,
                        width: cell_w_safe,
                        height: line_h_safe,
                    };
                    emit_link_hover(app, tid, LinkHover { uri, rect });
                }
            }
        }
        None => {
            if let Ok(mut s) = state.lock() {
                s.last_link_hover = None;
            }
        }
    }
}

fn handle_button_release(
    _widget: &DrawingArea,
    ev: &gdk::EventButton,
    state: &Arc<Mutex<MtvState>>,
) {
    if ev.button() != 1 {
        return;
    }
    let (x_px, y_px) = {
        let (x, y) = ev.position();
        (x as f32, y as f32)
    };
    let modifiers = ev.state();
    let shift = modifiers.contains(gdk::ModifierType::SHIFT_MASK);
    let ctrl = modifiers.contains(gdk::ModifierType::CONTROL_MASK);
    let alt = modifiers.contains(gdk::ModifierType::MOD1_MASK);

    let (pty_id, term_arc, app, term_id, cell_w, cell_h) = {
        let mut s = match state.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        s.lbutton_down = false;
        (
            s.pty_id,
            s.term.clone(),
            s.app.clone(),
            s.term_id,
            s.cell_w_px,
            s.cell_h_px,
        )
    };

    // xterm mouse-mode release forward.
    if !shift {
        let modes = term_arc
            .as_ref()
            .map(|t| read_mouse_modes_from_term(t))
            .unwrap_or_default();
        if modes.clicks_enabled {
            let (x_cell, y_cell) = px_to_cell_1based(x_px, y_px, cell_w, cell_h);
            let fmt = mouse_format(modes);
            let btn = if fmt == MouseFormat::Sgr { 0 } else { 3 };
            if let Some(bytes) =
                encode_mouse_event(btn, x_cell, y_cell, ctrl, shift, alt, false, false, fmt)
            {
                if let Some(pid) = pty_id {
                    let _ = crate::pty::write_to_pty_sync(pid, &bytes);
                }
            }
            return;
        }
    }

    // Selection finalize.
    let Some(term_arc) = term_arc else { return };
    let text = {
        let t = match term_arc.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        t.selection_to_string().filter(|s| !s.is_empty())
    };
    if let Some(text) = text {
        if let (Some(app), Some(tid)) = (app.as_ref(), term_id) {
            emit_selection(app, tid, SelectionEvent { text: text.clone() });
        }
        copy_to_clipboard_linux(&text);
    }
}

fn handle_scroll(_widget: &DrawingArea, ev: &gdk::EventScroll, state: &Arc<Mutex<MtvState>>) {
    let term_opt = match state.lock() {
        Ok(g) => g.term.clone(),
        Err(_) => return,
    };
    let Some(term_arc) = term_opt else { return };

    let lines = match ev.direction() {
        gdk::ScrollDirection::Up => SCROLL_LINES_PER_NOTCH,
        gdk::ScrollDirection::Down => -SCROLL_LINES_PER_NOTCH,
        gdk::ScrollDirection::Smooth => {
            let (_dx, dy) = ev.delta();
            if dy < -0.1 {
                SCROLL_LINES_PER_NOTCH
            } else if dy > 0.1 {
                -SCROLL_LINES_PER_NOTCH
            } else {
                0
            }
        }
        _ => 0,
    };
    if lines == 0 {
        return;
    }
    if let Ok(mut t) = term_arc.lock() {
        t.scroll_display(Scroll::Delta(lines));
    }
}

/// Returns true if the event was consumed (Propagation::Stop).
fn handle_key_press(
    _widget: &DrawingArea,
    ev: &gdk::EventKey,
    state: &Arc<Mutex<MtvState>>,
) -> bool {
    let modifiers = ev.state();
    let ctrl = modifiers.contains(gdk::ModifierType::CONTROL_MASK);
    let alt = modifiers.contains(gdk::ModifierType::MOD1_MASK);
    let shift = modifiers.contains(gdk::ModifierType::SHIFT_MASK);
    let meta = modifiers.contains(gdk::ModifierType::META_MASK)
        || modifiers.contains(gdk::ModifierType::SUPER_MASK);

    // Super/Meta-held → bubble (matches macOS Cmd → super.keyDown). On Linux
    // GTK doesn't have an AppKit-style menu responder chain — just don't
    // consume the event and let upstream handlers (window-level shortcuts)
    // run.
    if meta {
        return false;
    }

    let keyval = ev.keyval();

    // UI-shortcut whitelist.
    if let Some((js_key, js_code)) = keyval_to_ui_shortcut(&keyval, ctrl, alt, shift) {
        let (app, term_id) = {
            let s = match state.lock() {
                Ok(g) => g,
                Err(_) => return false,
            };
            (s.app.clone(), s.term_id)
        };
        if let (Some(app), Some(tid)) = (app, term_id) {
            emit_key_down_preview(
                &app,
                tid,
                KeyDownPreview {
                    ev: KeyEventDto {
                        code: js_code.to_string(),
                        key: js_key.to_string(),
                        ctrl,
                        shift,
                        alt,
                        meta: false,
                        // GDK doesn't surface key-repeat on EventKey directly.
                        // X server / Wayland repeat the keysym; the React
                        // side doesn't currently key off `repeat` so false
                        // is safe for the spike.
                        repeat: false,
                    },
                },
            );
        }
        return true;
    }

    // Translate to PTY bytes.
    //
    // TODO: route through GtkIMContextSimple for proper IME (CJK / dead
    // keys). The current implementation maps GdkKey → bytes directly.
    let bytes = translate_keyval_to_pty(&keyval, ctrl);
    if !bytes.is_empty() {
        let pty_id_opt = match state.lock() {
            Ok(g) => g.pty_id,
            Err(_) => return false,
        };
        if let Some(pty_id) = pty_id_opt {
            let _ = crate::pty::write_to_pty_sync(pty_id, &bytes);
            return true;
        }
    }
    false
}

impl NativeTermWindow for PlatformWindow {
    fn resize(&mut self, rect: Rect, dpr: f32) -> Result<(), String> {
        self.last_dpr = dpr;

        let da = self.drawing_area.clone();
        main_sync(move || {
            da.set_size_request(rect.width.max(1.0) as i32, rect.height.max(1.0) as i32);
            // GtkOverlay / GtkFixed honor (x,y); GtkBox ignores it (laid out
            // by the box). The set_size_request above gives the correct
            // dimensions; positioning relies on the parent container.
            //
            // TODO: when we install our own Overlay parent (see new()),
            // reposition via overlay child properties here.
        })?;

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
        let da = self.drawing_area.clone();
        main_sync(move || {
            da.show();
        })?;
        if let Some(arc) = &self.renderer {
            if let Ok(mut r) = arc.lock() {
                let _ = r.render();
            }
        }
        Ok(())
    }

    fn hide(&mut self) -> Result<(), String> {
        let da = self.drawing_area.clone();
        main_sync(move || {
            da.hide();
        })
    }

    fn set_region(&mut self, holes: &[Rect], _dpr: f32) -> Result<(), String> {
        // R4-δ equivalent: build a Cairo region covering the pane MINUS the
        // hole rects, then apply via `gtk_widget_input_shape_combine_region`.
        // POINTER and KEYBOARD events fall through the holes; rendered
        // pixels are NOT cut (GTK3 has no per-widget compositing mask). Full
        // visual hole-cut needs the wgpu renderer to render with alpha and
        // an alpha-aware compositor — deferred to follow-up.
        //
        // Empty `holes` → clear the input mask.
        let da = self.drawing_area.clone();
        let holes_vec: Vec<Rect> = holes.to_vec();
        main_sync(move || {
            if holes_vec.is_empty() {
                da.input_shape_combine_region(None);
                return;
            }
            let alloc = da.allocation();
            let outer = cairo::RectangleInt::new(0, 0, alloc.width(), alloc.height());
            let region = cairo::Region::create_rectangle(&outer);
            for h in &holes_vec {
                let r = cairo::RectangleInt::new(
                    h.x as i32,
                    h.y as i32,
                    h.width as i32,
                    h.height as i32,
                );
                let _ = region.subtract_rectangle(&r);
            }
            da.input_shape_combine_region(Some(&region));
        })
    }

    fn destroy(self: Box<Self>) -> Result<(), String> {
        let mut this = self;

        // 1. Stop render pump.
        this.stop_render_pump();

        // 2. Drop ParserBridge, unlink pty_route.
        if let Some(pty_id) = this.attached_pty_id.take() {
            pty_route::unlink(pty_id);
        }
        if let Some(term_id) = this.term_id.take() {
            pty_route::close_channel(term_id);
        }
        this.parser_bridge.take();

        // 3. Drop Renderer BEFORE unparenting the widget — wgpu Surface
        //    holds the GdkWindow handle that must be released first.
        this.renderer.take();

        // 4. Clear input state.
        if let Ok(mut s) = this.mtv_state.lock() {
            s.pty_id = None;
            s.term = None;
        }

        // 5. Unparent + destroy the widget on the main thread.
        let da = this.drawing_area.clone();
        main_sync(move || {
            if let Some(parent) = da.parent() {
                if let Some(container) = parent.downcast_ref::<Container>() {
                    container.remove(&da);
                }
            }
            // Explicit GObject destroy to release platform resources.
            unsafe { da.destroy() };
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
        if self.parser_bridge.is_some() {
            let _ = self.detach_pty();
        }

        let rx = pty_route::create_channel(term_id);
        pty_route::link(term_id, pty_id);

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

        if let Some(arc) = &self.renderer {
            if let Ok(mut r) = arc.lock() {
                r.attach_term(Arc::clone(&term_arc), cols, rows);
            }
        }
        if let Ok(mut s) = self.mtv_state.lock() {
            s.pty_id = Some(pty_id);
            s.term = Some(Arc::clone(&term_arc));
            s.term_id = Some(term_id);
        }
        self.parser_bridge = Some(bridge);
        self.attached_pty_id = Some(pty_id);
        self.term_id = Some(term_id);

        // Render pump.
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
            .map_err(|e| format!("native_term/linux: spawn render thread: {e}"))?;
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

        if let Ok(mut s) = self.mtv_state.lock() {
            s.pty_id = None;
            s.term = None;
        }

        if let Some(arc) = &self.renderer {
            if let Ok(mut r) = arc.lock() {
                r.detach_term();
                let _ = r.render();
            }
        }
        Ok(())
    }

    fn propose_dimensions(&self, width_px: u32, height_px: u32) -> (u32, u32) {
        // Heuristic mirror of macOS/Win32: ~Hack-14 metrics + cols ≥ 20 floor.
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
                let _ = r.render();
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

// ─── Helpers ─────────────────────────────────────────────────────────────

/// Run a closure synchronously on the GLib main thread and return its value.
///
/// GLib's `MainContext::invoke` is async — the closure runs on the next main
/// loop iteration. We use a `mpsc::sync_channel` to bounce the result back;
/// the calling thread blocks on `recv()` until the iteration has run.
///
/// Short-circuits when already on the main thread — calling main_sync from
/// inside a connect_*-installed signal would otherwise deadlock waiting for
/// our own future iteration.
fn main_sync<F, R>(f: F) -> Result<R, String>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    let ctx = glib::MainContext::default();
    if ctx.is_owner() {
        // Already on the GLib main thread (the default context is acquired
        // by the GLib main loop). Run directly.
        return Ok(f());
    }
    let (tx, rx) = mpsc::sync_channel::<R>(1);
    ctx.invoke(move || {
        let r = f();
        let _ = tx.send(r);
    });
    rx.recv()
        .map_err(|e| format!("native_term/linux: main_sync recv: {e}"))
}

/// GDK keyval → React-side UI-shortcut mapping. Matches macOS / win32 sets.
fn keyval_to_ui_shortcut(
    keyval: &gdk::keys::Key,
    ctrl: bool,
    alt: bool,
    _shift: bool,
) -> Option<(&'static str, &'static str)> {
    use gdk::keys::constants as K;
    if ctrl && !alt {
        if *keyval == K::k || *keyval == K::K {
            return Some(("k", "KeyK"));
        }
        if *keyval == K::b || *keyval == K::B {
            return Some(("b", "KeyB"));
        }
        if *keyval == K::f || *keyval == K::F {
            return Some(("f", "KeyF"));
        }
        if *keyval == K::slash {
            return Some(("/", "Slash"));
        }
        if *keyval == K::comma {
            return Some((",", "Comma"));
        }
    }
    if alt && !ctrl {
        if *keyval == K::_1 {
            return Some(("1", "Digit1"));
        }
        if *keyval == K::_2 {
            return Some(("2", "Digit2"));
        }
        if *keyval == K::_3 {
            return Some(("3", "Digit3"));
        }
        if *keyval == K::_4 {
            return Some(("4", "Digit4"));
        }
        if *keyval == K::_5 {
            return Some(("5", "Digit5"));
        }
        if *keyval == K::_6 {
            return Some(("6", "Digit6"));
        }
        if *keyval == K::_7 {
            return Some(("7", "Digit7"));
        }
        if *keyval == K::_8 {
            return Some(("8", "Digit8"));
        }
        if *keyval == K::_9 {
            return Some(("9", "Digit9"));
        }
    }
    None
}

/// Translate a GDK keyval to PTY bytes. Special keys get xterm escape
/// sequences; printable Unicode passes through as UTF-8. Ctrl+letter is
/// collapsed to the corresponding control byte (0x01..0x1A).
fn translate_keyval_to_pty(keyval: &gdk::keys::Key, ctrl: bool) -> Vec<u8> {
    use gdk::keys::constants as K;
    let mut out = Vec::new();

    if *keyval == K::Up {
        out.extend_from_slice(b"\x1b[A");
        return out;
    }
    if *keyval == K::Down {
        out.extend_from_slice(b"\x1b[B");
        return out;
    }
    if *keyval == K::Right {
        out.extend_from_slice(b"\x1b[C");
        return out;
    }
    if *keyval == K::Left {
        out.extend_from_slice(b"\x1b[D");
        return out;
    }
    if *keyval == K::Home {
        out.extend_from_slice(b"\x1b[H");
        return out;
    }
    if *keyval == K::End {
        out.extend_from_slice(b"\x1b[F");
        return out;
    }
    if *keyval == K::Page_Up {
        out.extend_from_slice(b"\x1b[5~");
        return out;
    }
    if *keyval == K::Page_Down {
        out.extend_from_slice(b"\x1b[6~");
        return out;
    }
    if *keyval == K::Delete {
        out.extend_from_slice(b"\x1b[3~");
        return out;
    }
    if *keyval == K::F1 {
        out.extend_from_slice(b"\x1bOP");
        return out;
    }
    if *keyval == K::F2 {
        out.extend_from_slice(b"\x1bOQ");
        return out;
    }
    if *keyval == K::F3 {
        out.extend_from_slice(b"\x1bOR");
        return out;
    }
    if *keyval == K::F4 {
        out.extend_from_slice(b"\x1bOS");
        return out;
    }
    if *keyval == K::F5 {
        out.extend_from_slice(b"\x1b[15~");
        return out;
    }
    if *keyval == K::F6 {
        out.extend_from_slice(b"\x1b[17~");
        return out;
    }
    if *keyval == K::F7 {
        out.extend_from_slice(b"\x1b[18~");
        return out;
    }
    if *keyval == K::F8 {
        out.extend_from_slice(b"\x1b[19~");
        return out;
    }
    if *keyval == K::F9 {
        out.extend_from_slice(b"\x1b[20~");
        return out;
    }
    if *keyval == K::F10 {
        out.extend_from_slice(b"\x1b[21~");
        return out;
    }
    if *keyval == K::F11 {
        out.extend_from_slice(b"\x1b[23~");
        return out;
    }
    if *keyval == K::F12 {
        out.extend_from_slice(b"\x1b[24~");
        return out;
    }
    if *keyval == K::BackSpace {
        out.push(0x7F);
        return out;
    }
    if *keyval == K::Tab || *keyval == K::ISO_Left_Tab {
        out.push(b'\t');
        return out;
    }
    if *keyval == K::Return || *keyval == K::KP_Enter {
        out.push(b'\r');
        return out;
    }
    if *keyval == K::Escape {
        out.push(0x1B);
        return out;
    }

    // Printable: GDK gives us the Unicode codepoint via to_unicode().
    if let Some(c) = keyval.to_unicode() {
        if ctrl {
            // Ctrl+<letter> → 0x01..0x1A.
            let cp = c as u32;
            if (b'a' as u32..=b'z' as u32).contains(&cp) {
                out.push((cp - b'a' as u32 + 1) as u8);
                return out;
            }
            if (b'A' as u32..=b'Z' as u32).contains(&cp) {
                out.push((cp - b'A' as u32 + 1) as u8);
                return out;
            }
        }
        let mut buf = [0u8; 4];
        let s = c.encode_utf8(&mut buf);
        out.extend_from_slice(s.as_bytes());
    }
    out
}

// ─── Mouse helpers (γ-2) ─────────────────────────────────────────────────
// Duplicated from macos.rs (which duplicated from win32.rs) to keep this
// file landing without touching the other platforms. Consolidate into a
// shared module after Linux is testable.

#[derive(Clone, Copy, Debug, Default)]
struct MouseModes {
    clicks_enabled: bool,
    drag_enabled: bool,
    motion_enabled: bool,
    sgr: bool,
    urxvt: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MouseFormat {
    Sgr,
    Urxvt,
    X10,
}

fn mouse_format(modes: MouseModes) -> MouseFormat {
    if modes.sgr {
        MouseFormat::Sgr
    } else if modes.urxvt {
        MouseFormat::Urxvt
    } else {
        MouseFormat::X10
    }
}

fn read_mouse_modes_from_term(term: &Arc<Mutex<Term<TermListener>>>) -> MouseModes {
    let t = match term.lock() {
        Ok(g) => g,
        Err(_) => return MouseModes::default(),
    };
    let m = *t.mode();
    drop(t);
    let click = m.contains(TermMode::MOUSE_REPORT_CLICK);
    let drag = m.contains(TermMode::MOUSE_DRAG);
    let motion = m.contains(TermMode::MOUSE_MOTION);
    MouseModes {
        clicks_enabled: click || drag || motion,
        drag_enabled: drag || motion,
        motion_enabled: motion,
        sgr: m.contains(TermMode::SGR_MOUSE),
        urxvt: false,
    }
}

fn px_to_cell_1based(x_px: f32, y_px: f32, cell_w_px: f32, line_h_px: f32) -> (u32, u32) {
    let cell_w = cell_w_px.max(0.001);
    let line_h = line_h_px.max(0.001);
    let col = (x_px / cell_w).floor().max(0.0) as u32 + 1;
    let row = (y_px / line_h).floor().max(0.0) as u32 + 1;
    (col, row)
}

fn mouse_to_point(
    term: &Arc<Mutex<Term<TermListener>>>,
    x_px: f32,
    y_px: f32,
    cell_w_px: f32,
    line_h_px: f32,
) -> Option<Point> {
    let cell_w = cell_w_px.max(0.001);
    let line_h = line_h_px.max(0.001);
    let (cols, rows) = {
        let t = term.lock().ok()?;
        let g = t.grid();
        (g.columns(), g.screen_lines())
    };
    if cols == 0 || rows == 0 {
        return None;
    }
    let col_raw = (x_px / cell_w).floor() as i32;
    let row_raw = (y_px / line_h).floor() as i32;
    let col = col_raw.clamp(0, (cols as i32).saturating_sub(1)) as usize;
    let row = row_raw.clamp(0, (rows as i32).saturating_sub(1));
    Some(Point::new(Line(row), Column(col)))
}

fn encode_mouse_event(
    button: u32,
    x_cell: u32,
    y_cell: u32,
    ctrl: bool,
    shift: bool,
    alt: bool,
    press: bool,
    motion: bool,
    format: MouseFormat,
) -> Option<Vec<u8>> {
    let mut b = button;
    if shift {
        b |= 4;
    }
    if alt {
        b |= 8;
    }
    if ctrl {
        b |= 16;
    }
    if motion {
        b |= 32;
    }
    match format {
        MouseFormat::Sgr => {
            let m = if press { 'M' } else { 'm' };
            Some(format!("\x1b[<{};{};{}{}", b, x_cell, y_cell, m).into_bytes())
        }
        MouseFormat::Urxvt => Some(format!("\x1b[{};{};{}M", b + 32, x_cell, y_cell).into_bytes()),
        MouseFormat::X10 => {
            if x_cell > 223 || y_cell > 223 {
                return None;
            }
            let b_byte = (b + 32) as u8;
            let x_byte = (x_cell + 32) as u8;
            let y_byte = (y_cell + 32) as u8;
            Some(vec![0x1b, b'[', b'M', b_byte, x_byte, y_byte])
        }
    }
}

/// Copy a UTF-8 string to the GtkClipboard. Best-effort; silent on failure —
/// matches the win32 / macOS `let _ = copy_to_clipboard(...)` pattern.
fn copy_to_clipboard_linux(text: &str) {
    let owned = text.to_string();
    let _ = main_sync(move || {
        let display = match gdk::Display::default() {
            Some(d) => d,
            None => return,
        };
        if let Some(cb) = gtk::Clipboard::default(&display) {
            cb.set_text(&owned);
            cb.store();
        }
    });
}

// `parse_hex_color` / `parse_theme` consolidated into
// `super::super::theme_parse`. Same wire-format folding all three platform
// backends share.
