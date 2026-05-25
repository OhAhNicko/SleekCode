// Phase 4 macOS R4 implementation: NSView sibling of WKWebView + wgpu Metal
// surface driven by the shared Renderer + ParserBridge + pty_route stack.
//
// The plan calls for the native pane to be a SIBLING of Tauri's WKWebView
// inside the main NSWindow's contentView — NOT a child of WKWebView (Apple's
// view hierarchy makes that impossible anyway). Both views are subviews of
// `[NSWindow contentView]`, z-ordered with the native pane above the webview.
//
// Phasing of this file:
//   R4-α (commit 5322fce): NSView + CAMetalLayer + solid-color spike.
//   R4-β (commit 1595656): drop the spike's inline wgpu and use the production
//        Renderer; wire ParserBridge + pty_route so a real shell runs through
//        the native pane.
//   R4-δ (commit 08d97e0): CAShapeLayer hole-cut for popups.
//   R4-γ (this revision): NSView subclass (MadeTerminalView) overriding
//        keyDown / scrollWheel / mouseDown so the pane accepts keyboard typing
//        and scroll-wheel scrollback. Mouse selection + xterm mouse modes +
//        NSTextInputClient IME deferred to follow-up commits.
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
use objc2::rc::{Allocated, Retained};
use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSEvent, NSEventModifierFlags, NSPasteboard, NSPasteboardTypeString, NSResponder, NSView,
    NSWindowOrderingMode,
    NSDeleteFunctionKey, NSDownArrowFunctionKey, NSEndFunctionKey, NSF10FunctionKey,
    NSF11FunctionKey, NSF12FunctionKey, NSF1FunctionKey, NSF2FunctionKey, NSF3FunctionKey,
    NSF4FunctionKey, NSF5FunctionKey, NSF6FunctionKey, NSF7FunctionKey, NSF8FunctionKey,
    NSF9FunctionKey, NSHomeFunctionKey, NSLeftArrowFunctionKey, NSPageDownFunctionKey,
    NSPageUpFunctionKey, NSRightArrowFunctionKey, NSUpArrowFunctionKey,
};
use objc2_foundation::{NSObjectProtocol, NSPoint, NSRect, NSSize, NSString};
use objc2_core_graphics::{CGColorCreateSRGB, CGMutablePath, CGPath};
use objc2_quartz_core::{kCAFillRuleEvenOdd, CALayer, CAMetalLayer, CAShapeLayer};
use raw_window_handle::{
    AppKitDisplayHandle, AppKitWindowHandle, RawDisplayHandle, RawWindowHandle,
};

use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Column, Line, Point, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::term::{Term, TermMode};

use super::super::events::{
    emit_key_down_preview, emit_r_button, emit_selection, KeyDownPreview, KeyEventDto, RButton,
    Selection as SelectionEvent,
};

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

/// Number of lines per scroll-wheel notch — mirrors win32.rs's WM_MOUSEWHEEL.
const SCROLL_LINES_PER_NOTCH: i32 = 3;

// ─── MadeTerminalView (NSView subclass for input) ──────────────────────
//
// R4-γ-1: per-pane subclass of NSView with overrides for keyDown, scrollWheel,
// mouseDown, acceptsFirstResponder. Without it, the pane renders fine but
// receives no keyboard or scroll input from AppKit.
//
// State the subclass touches lives in MtvState behind an Arc<Mutex<>>. The
// PlatformWindow holds a sibling Arc, so attach_pty / detach_pty / set_app_handle
// can update the view's state without the view having to call back into Rust
// owner objects.

/// Shared mutable state between PlatformWindow and the MadeTerminalView's
/// event-handler overrides. All Option<...> so a fresh view (no PTY yet)
/// can still receive events safely.
pub(super) struct MtvState {
    pub(super) pty_id: Option<u32>,
    pub(super) term: Option<Arc<Mutex<Term<TermListener>>>>,
    pub(super) app: Option<tauri::AppHandle>,
    pub(super) term_id: Option<u32>,
    /// True between mouseDown and mouseUp/mouseExited — gates the
    /// selection-extend branch of mouseDragged.
    pub(super) lbutton_down: bool,
    /// Per-cell logical-px metrics in the macOS-native (top-left flipped)
    /// coordinate space the view uses. Seeded from `INITIAL_CELL_*_LOGICAL`
    /// and refreshed when `set_font` lands hot-swap support.
    pub(super) cell_w_px: f32,
    pub(super) cell_h_px: f32,
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
        }
    }
}

/// Instance variables on the NSView subclass. Cloned-Arc lets the view read
/// the same MtvState that PlatformWindow writes to.
pub(super) struct MtvIvars {
    pub(super) state: Arc<Mutex<MtvState>>,
}

define_class!(
    /// MADE's NSView subclass — owns terminal-pane input handling. Subclassing
    /// is required because AppKit dispatches keyDown / scrollWheel / mouseDown
    /// to the firstResponder, and only an NSResponder subclass can override
    /// those selectors. (NSEvent.addLocalMonitor would work app-wide but loses
    /// per-pane dispatch.)
    ///
    /// SAFETY:
    /// - NSView has no subclassing restrictions for the methods we override.
    /// - We don't implement Drop on the ivars beyond the implicit Arc-drop.
    #[unsafe(super(NSView, NSResponder))]
    #[thread_kind = MainThreadOnly]
    #[name = "MadeTerminalView"]
    #[ivars = MtvIvars]
    pub(super) struct MadeTerminalView;

    impl MadeTerminalView {
        /// Required for the view to receive keyboard events when clicked.
        /// NSView's default returns false.
        #[unsafe(method(acceptsFirstResponder))]
        fn _accepts_first_responder(&self) -> bool {
            true
        }

        /// Take keyboard focus on click. After this, AppKit dispatches keyDown
        /// to us instead of the webview. Clicking the webview elsewhere takes
        /// focus back automatically.
        ///
        /// Mouse-mode forwarding (xterm DECSET 1000/1002/1003/1006): when the
        /// running TUI has enabled mouse reporting and Shift is NOT held,
        /// encode the press as an xterm escape sequence and ship it to the
        /// PTY. Shift bypasses forwarding so the user can still text-select
        /// inside mouse-aware apps (xterm convention).
        ///
        /// Otherwise: begin a fresh text selection at the click cell.
        #[unsafe(method(mouseDown:))]
        fn _mouse_down(&self, event: &NSEvent) {
            // Take keyboard focus first.
            if let Some(window) = self.window() {
                let responder: &NSResponder = self;
                let _ = window.makeFirstResponder(Some(responder));
            }

            let (x_px, y_px) = match self.view_local_event_px(event) {
                Some(p) => p,
                None => return,
            };
            let flags = event.modifierFlags();
            let shift = flags.contains(NSEventModifierFlags::Shift);
            let ctrl = flags.contains(NSEventModifierFlags::Control);
            let alt = flags.contains(NSEventModifierFlags::Option);

            // Snapshot the bits we need without holding the state lock across
            // the term mutex acquisition below.
            let (pty_id, term_arc, cell_w, cell_h) = {
                let mut s = match self.ivars().state.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                s.lbutton_down = true;
                (s.pty_id, s.term.clone(), s.cell_w_px, s.cell_h_px)
            };

            // xterm mouse-mode forwarding takes precedence (unless Shift).
            if !shift {
                let modes = term_arc
                    .as_ref()
                    .map(|t| read_mouse_modes_from_term(t))
                    .unwrap_or_default();
                if modes.clicks_enabled {
                    let (x_cell, y_cell) = px_to_cell_1based(x_px, y_px, cell_w, cell_h);
                    let fmt = mouse_format(modes);
                    if let Some(bytes) = encode_mouse_event(
                        0, x_cell, y_cell, ctrl, shift, alt, true, false, fmt,
                    ) {
                        if let Some(pid) = pty_id {
                            let _ = crate::pty::write_to_pty_sync(pid, &bytes);
                        }
                    }
                    return;
                }
            }

            // Fall through to text-selection start.
            let Some(term_arc) = term_arc else { return };
            if let Some(point) =
                mouse_to_point(&term_arc, x_px, y_px, cell_w, cell_h)
            {
                if let Ok(mut t) = term_arc.lock() {
                    t.selection = Some(Selection::new(SelectionType::Simple, point, Side::Left));
                }
            }
        }

        /// Extend the active selection during a drag. Mouse-mode 1002/1003
        /// drag forwarding lands in γ-3 when we add an NSTrackingArea +
        /// motion reporting; for now drag only does text-selection.
        #[unsafe(method(mouseDragged:))]
        fn _mouse_dragged(&self, event: &NSEvent) {
            let down = match self.ivars().state.lock() {
                Ok(g) => g.lbutton_down,
                Err(_) => return,
            };
            if !down {
                return;
            }
            let Some((x_px, y_px)) = self.view_local_event_px(event) else { return };

            let (term_arc, cell_w, cell_h) = {
                let s = match self.ivars().state.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                (s.term.clone(), s.cell_w_px, s.cell_h_px)
            };
            let Some(term_arc) = term_arc else { return };
            if let Some(point) =
                mouse_to_point(&term_arc, x_px, y_px, cell_w, cell_h)
            {
                if let Ok(mut t) = term_arc.lock() {
                    if let Some(sel) = t.selection.as_mut() {
                        sel.update(point, Side::Right);
                    }
                }
            }
        }

        /// Finalize selection (copy to NSPasteboard + emit selection event) or
        /// forward release to PTY if xterm mouse mode is on (and no Shift).
        #[unsafe(method(mouseUp:))]
        fn _mouse_up(&self, event: &NSEvent) {
            let Some((x_px, y_px)) = self.view_local_event_px(event) else { return };
            let flags = event.modifierFlags();
            let shift = flags.contains(NSEventModifierFlags::Shift);
            let ctrl = flags.contains(NSEventModifierFlags::Control);
            let alt = flags.contains(NSEventModifierFlags::Option);

            let (pty_id, term_arc, app, term_id, cell_w, cell_h) = {
                let mut s = match self.ivars().state.lock() {
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

            // xterm mouse mode forward (unless Shift escape-hatched).
            if !shift {
                let modes = term_arc
                    .as_ref()
                    .map(|t| read_mouse_modes_from_term(t))
                    .unwrap_or_default();
                if modes.clicks_enabled {
                    let (x_cell, y_cell) = px_to_cell_1based(x_px, y_px, cell_w, cell_h);
                    let fmt = mouse_format(modes);
                    // SGR distinguishes release via lowercase `m`; X10/URXVT
                    // use button code 3.
                    let btn = if fmt == MouseFormat::Sgr { 0 } else { 3 };
                    if let Some(bytes) = encode_mouse_event(
                        btn, x_cell, y_cell, ctrl, shift, alt, false, false, fmt,
                    ) {
                        if let Some(pid) = pty_id {
                            let _ = crate::pty::write_to_pty_sync(pid, &bytes);
                        }
                    }
                    return;
                }
            }

            // Selection finalize: snapshot text under a brief lock, drop the
            // lock, then emit + copy to NSPasteboard.
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
                copy_to_clipboard_macos(&text);
            }
        }

        /// Right-click → emit r_button so React's GlobalContextMenu opens at
        /// the click site. Coordinates are pane-local logical px (top-left
        /// origin), matching the win32 contract.
        #[unsafe(method(rightMouseDown:))]
        fn _right_mouse_down(&self, event: &NSEvent) {
            let Some((x_px, y_px)) = self.view_local_event_px(event) else { return };
            let (app, term_id) = {
                let s = match self.ivars().state.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                (s.app.clone(), s.term_id)
            };
            if let (Some(app), Some(tid)) = (app, term_id) {
                emit_r_button(&app, tid, RButton { x: x_px, y: y_px });
            }
        }

        /// Forward keystrokes to the PTY, with two escape hatches:
        ///   1. Cmd-held keystrokes (Cmd+T new tab, Cmd+W close, AppKit menu
        ///      shortcuts) → forward to NSView's keyDown via super so the
        ///      responder chain handles them normally. We DO NOT emit
        ///      key_down_preview for these — MADE's App.tsx shortcut handler
        ///      keys off ctrlKey, not metaKey.
        ///   2. Ctrl/Alt UI shortcuts (Ctrl+K palette, Ctrl+B sidebar, Alt+1..9
        ///      tab switch, etc.) → emit key_down_preview so the React side
        ///      can synthesize a window-level KeyboardEvent that App.tsx's
        ///      capture handler picks up. Skip PTY forwarding.
        ///   3. Everything else → translate NSEvent characters to PTY bytes
        ///      (xterm escape sequences for navigation/function keys, UTF-8
        ///      pass-through for printable text).
        #[unsafe(method(keyDown:))]
        fn _key_down(&self, event: &NSEvent) {
            let flags = event.modifierFlags();
            let cmd = flags.contains(NSEventModifierFlags::Command);
            let ctrl = flags.contains(NSEventModifierFlags::Control);
            let alt = flags.contains(NSEventModifierFlags::Option);
            let shift = flags.contains(NSEventModifierFlags::Shift);

            // (1) Cmd-held: defer to AppKit. We must call super.keyDown
            // explicitly — overriding without calling super is what AppKit
            // takes as "I handled it", which would swallow Cmd+T etc.
            if cmd {
                unsafe {
                    let _: () = msg_send![super(self), keyDown: event];
                }
                return;
            }

            // (2) UI-shortcut whitelist. Use charactersIgnoringModifiers so
            // Ctrl+K gives "k" (not "\v"), Alt+1 gives "1", etc.
            if let Some(unmod_ns) = event.charactersIgnoringModifiers() {
                let unmod = unmod_ns.to_string();
                if let Some((js_key, js_code)) =
                    key_to_ui_shortcut(&unmod, ctrl, alt, shift)
                {
                    let (app, term_id) = {
                        let s = match self.ivars().state.lock() {
                            Ok(g) => g,
                            Err(_) => return,
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
                                    repeat: event.isARepeat(),
                                },
                            },
                        );
                    }
                    return;
                }
            }

            // (3) Forward to PTY.
            let pty_id_opt = match self.ivars().state.lock() {
                Ok(g) => g.pty_id,
                Err(_) => return,
            };
            let Some(pty_id) = pty_id_opt else { return };

            let Some(ns_chars) = event.characters() else { return };
            let bytes = translate_keys_to_pty(&ns_chars.to_string());
            if bytes.is_empty() {
                return;
            }
            let _ = crate::pty::write_to_pty_sync(pty_id, &bytes);
        }

        /// Forward vertical scroll to the alacritty Term's scrollback. Direction
        /// matches xterm convention: deltaY > 0 means scroll content down (older
        /// lines come into view, terminal scrollback offset increases).
        #[unsafe(method(scrollWheel:))]
        fn _scroll_wheel(&self, event: &NSEvent) {
            let term_opt = match self.ivars().state.lock() {
                Ok(g) => g.term.clone(),
                Err(_) => return,
            };
            let Some(term_arc) = term_opt else { return };

            let dy = event.scrollingDeltaY();
            let lines = if dy > 0.5 {
                SCROLL_LINES_PER_NOTCH
            } else if dy < -0.5 {
                -SCROLL_LINES_PER_NOTCH
            } else {
                0
            };
            if lines == 0 {
                return;
            }
            if let Ok(mut t) = term_arc.lock() {
                t.scroll_display(Scroll::Delta(lines));
            }
        }
    }

    unsafe impl NSObjectProtocol for MadeTerminalView {}
);

impl MadeTerminalView {
    /// Construct a view, install ivars, and chain to NSView's initWithFrame:.
    /// Must run on the main thread (MainThreadOnly classes require an MTM
    /// to alloc).
    pub(super) fn new(
        state: Arc<Mutex<MtvState>>,
        frame: NSRect,
        mtm: MainThreadMarker,
    ) -> Retained<Self> {
        let allocated: Allocated<Self> = Self::alloc(mtm);
        let this = allocated.set_ivars(MtvIvars { state });
        unsafe { msg_send![super(this), initWithFrame: frame] }
    }

    /// Convert an NSEvent into view-local logical pixels with origin in the
    /// TOP-LEFT (matching the grid coordinate system the terminal renderer
    /// uses). AppKit's native view coords are bottom-left, so we flip y
    /// against the view's bounds height after `convertPoint:fromView:nil`.
    /// Returns None if the event has no associated window or the click was
    /// outside the view.
    fn view_local_event_px(&self, event: &NSEvent) -> Option<(f32, f32)> {
        let window_pt = event.locationInWindow();
        // None → convert from window coords.
        let local = self.convertPoint_fromView(window_pt, None);
        let bounds = self.bounds();
        let w = bounds.size.width as f32;
        let h = bounds.size.height as f32;
        let x = local.x as f32;
        // AppKit bottom-left → top-left: flip y.
        let y = h - local.y as f32;
        if x < 0.0 || x > w || y < 0.0 || y > h {
            return None;
        }
        Some((x, y))
    }
}

/// Translate the NSEvent `characters` string into bytes for the PTY. Most
/// printable text passes through; macOS sends function / navigation keys as
/// private-use Unicode codepoints (0xF700..) which we map to xterm escape
/// sequences. Control characters that the OS hasn't already collapsed
/// (`Ctrl+letter` is handled by macOS pre-keyDown via charactersIgnoringModifiers,
/// so `characters()` typically yields the control byte directly) pass through.
fn translate_keys_to_pty(input: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len());
    for c in input.chars() {
        let cp = c as u32;
        match cp {
            v if v == NSUpArrowFunctionKey => out.extend_from_slice(b"\x1b[A"),
            v if v == NSDownArrowFunctionKey => out.extend_from_slice(b"\x1b[B"),
            v if v == NSLeftArrowFunctionKey => out.extend_from_slice(b"\x1b[D"),
            v if v == NSRightArrowFunctionKey => out.extend_from_slice(b"\x1b[C"),
            v if v == NSHomeFunctionKey => out.extend_from_slice(b"\x1b[H"),
            v if v == NSEndFunctionKey => out.extend_from_slice(b"\x1b[F"),
            v if v == NSPageUpFunctionKey => out.extend_from_slice(b"\x1b[5~"),
            v if v == NSPageDownFunctionKey => out.extend_from_slice(b"\x1b[6~"),
            v if v == NSDeleteFunctionKey => out.extend_from_slice(b"\x1b[3~"),
            v if v == NSF1FunctionKey => out.extend_from_slice(b"\x1bOP"),
            v if v == NSF2FunctionKey => out.extend_from_slice(b"\x1bOQ"),
            v if v == NSF3FunctionKey => out.extend_from_slice(b"\x1bOR"),
            v if v == NSF4FunctionKey => out.extend_from_slice(b"\x1bOS"),
            v if v == NSF5FunctionKey => out.extend_from_slice(b"\x1b[15~"),
            v if v == NSF6FunctionKey => out.extend_from_slice(b"\x1b[17~"),
            v if v == NSF7FunctionKey => out.extend_from_slice(b"\x1b[18~"),
            v if v == NSF8FunctionKey => out.extend_from_slice(b"\x1b[19~"),
            v if v == NSF9FunctionKey => out.extend_from_slice(b"\x1b[20~"),
            v if v == NSF10FunctionKey => out.extend_from_slice(b"\x1b[21~"),
            v if v == NSF11FunctionKey => out.extend_from_slice(b"\x1b[23~"),
            v if v == NSF12FunctionKey => out.extend_from_slice(b"\x1b[24~"),
            // macOS Backspace sends 0x7F via NSEvent characters; xterm wants 0x7F.
            // Some keyboards send 0x08 (BS); also remap to 0x7F so editors like
            // bash readline see the expected DEL byte.
            0x7F => out.push(0x7F),
            0x08 => out.push(0x7F),
            // Enter / Return: NSCarriageReturnCharacter (0x0D) is canonical; some
            // contexts also send NSEnterCharacter (0x03 — the OS-level Enter key
            // semantic). Both map to CR for PTY input.
            0x0D | 0x03 => out.push(b'\r'),
            0x09 => out.push(b'\t'),
            0x1B => out.push(0x1B),
            // Regular Unicode: pass through as UTF-8.
            _ => {
                let mut buf = [0u8; 4];
                let s = c.encode_utf8(&mut buf);
                out.extend_from_slice(s.as_bytes());
            }
        }
    }
    out
}

pub struct PlatformWindow {
    /// Retained MadeTerminalView pointer (one strong ref taken at construction,
    /// released in `destroy`). Stored as `usize` because Retained<...> is !Send.
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

    /// Shared input-handler state. Cloned-Arc lives inside MadeTerminalView's
    /// ivars so the view's keyDown / scrollWheel can read pty_id + term. We
    /// keep our own clone so attach_pty / detach_pty / set_app_handle can
    /// write to the same Mutex.
    mtv_state: Arc<Mutex<MtvState>>,
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

        // ── Step 1: build the MadeTerminalView + CAMetalLayer on the main
        // thread. We carry parent_handle as plain isize across the dispatch
        // (raw pointers are !Send) plus a clone of the shared MtvState so
        // the view's ivars can read pty_id / term once attach_pty fires.
        let mtv_state = Arc::new(Mutex::new(MtvState::new()));
        let mtv_state_for_view = Arc::clone(&mtv_state);
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

            let view: Retained<MadeTerminalView> =
                MadeTerminalView::new(mtv_state_for_view, frame, mtm);

            // Layer-hosting setup: setWantsLayer → setLayer (in that order)
            // makes us a layer-hosting view. wgpu's Metal backend will use
            // the CAMetalLayer we attach here instead of creating its own.
            let metal_layer: Retained<CAMetalLayer> = CAMetalLayer::new();
            metal_layer.setContentsScale(dpr_for_closure as f64);
            // MadeTerminalView derefs to NSView, so the NSView methods
            // (setWantsLayer, setLayer) resolve through auto-deref.
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
            // Renderer construction failed — roll back the view so we don't
            // leak one sitting in the hierarchy with nothing rendering it.
            let _ = main_sync(move || {
                let view: Retained<MadeTerminalView> = unsafe {
                    Retained::from_raw(view_ptr as *mut MadeTerminalView)
                        .expect("MadeTerminalView ptr nil during error rollback")
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
            mtv_state,
        })
    }

    /// Stash the AppHandle so attach_pty can pass it to ParserBridge for
    /// per-pane cursor / OSC133 / scroll event emission. Also mirrors it into
    /// the MadeTerminalView's ivars so future per-pane events (γ-4
    /// key_down_preview) can emit without a global lookup.
    pub fn set_app_handle(&mut self, app: tauri::AppHandle) {
        if let Ok(mut s) = self.mtv_state.lock() {
            s.app = Some(app.clone());
        }
        self.app = Some(app);
    }

    /// native_term_id mirror, matches win32's set_term_id role. Not used yet
    /// on macOS (no wnd_proc to thread per-pane channel names through) but
    /// kept for trait parity.
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

        // 4. Clear input-state so any in-flight event handlers can't reach a
        //    half-torn-down PTY (the view itself is about to leave the
        //    hierarchy, but a queued keyDown might still dispatch).
        if let Ok(mut s) = this.mtv_state.lock() {
            s.pty_id = None;
            s.term = None;
        }

        // 5. removeFromSuperview + release our +1 strong ref on the view.
        let view_ptr = this.ns_view_ptr;
        main_sync(move || {
            // SAFETY: view_ptr is the +1 strong reference we took in new().
            // Retained::from_raw reclaims it; drop releases.
            let view: Retained<MadeTerminalView> = unsafe {
                Retained::from_raw(view_ptr as *mut MadeTerminalView)
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
        // Publish pty_id + term to the MadeTerminalView's shared state so
        // keyDown / scrollWheel can route input.
        if let Ok(mut s) = self.mtv_state.lock() {
            s.pty_id = Some(pty_id);
            s.term = Some(Arc::clone(&term_arc));
            s.term_id = Some(term_id);
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

        // Clear the view's input-state mirror so a stale keyDown can't write
        // to a dead pty_id.
        if let Ok(mut s) = self.mtv_state.lock() {
            s.pty_id = None;
            s.term = None;
        }

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

/// If the keystroke matches a React-side UI shortcut, return the
/// `(KeyboardEvent.key, KeyboardEvent.code)` pair to synthesize on JS. Keep
/// this list aligned with `src/App.tsx`'s global keydown handler and with
/// `vk_to_ui_shortcut` in `window/win32.rs` — same shortcuts, different key
/// representation (macOS gives us a string from NSEvent.characters; win32
/// gives a VK code).
fn key_to_ui_shortcut(
    unmod_chars: &str,
    ctrl: bool,
    alt: bool,
    _shift: bool,
) -> Option<(&'static str, &'static str)> {
    // Ctrl combos
    if ctrl && !alt {
        match unmod_chars {
            "k" | "K" => return Some(("k", "KeyK")), // Ctrl+K → palette
            "b" | "B" => return Some(("b", "KeyB")), // Ctrl+B → sidebar
            "f" | "F" => return Some(("f", "KeyF")), // Ctrl+F → search
            "/" => return Some(("/", "Slash")),       // Ctrl+/ → shortcuts
            "," => return Some((",", "Comma")),       // Ctrl+, → settings
            _ => {}
        }
    }
    // Alt+digit (without Ctrl). NSEvent.charactersIgnoringModifiers for
    // Alt+1..9 gives "1".."9" on a US layout.
    if alt && !ctrl {
        match unmod_chars {
            "1" => return Some(("1", "Digit1")),
            "2" => return Some(("2", "Digit2")),
            "3" => return Some(("3", "Digit3")),
            "4" => return Some(("4", "Digit4")),
            "5" => return Some(("5", "Digit5")),
            "6" => return Some(("6", "Digit6")),
            "7" => return Some(("7", "Digit7")),
            "8" => return Some(("8", "Digit8")),
            "9" => return Some(("9", "Digit9")),
            _ => {}
        }
    }
    None
}

// ─── Mouse helpers (γ-2) ──────────────────────────────────────────────
// Duplicated from win32.rs to keep that file untouched per the
// "don't regress Windows" instruction. Consolidate once macOS daily-drives.

#[derive(Clone, Copy, Debug, Default)]
struct MouseModes {
    clicks_enabled: bool,
    /// Reserved for γ-3 motion-while-down forwarding (1002).
    #[allow(dead_code)]
    drag_enabled: bool,
    /// Reserved for γ-3 motion forwarding (1003).
    #[allow(dead_code)]
    motion_enabled: bool,
    sgr: bool,
    /// alacritty_terminal 0.24.2 does not define URXVT_MOUSE — pinned false
    /// until upstream adds it. Mirrors win32.rs's note.
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

/// Snapshot the mouse-mode bits from a Term under a brief lock.
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

/// Convert logical-px coords to 1-based cell (col, row) coords. Floors + 1
/// so the top-left cell becomes (1, 1) — the xterm wire convention.
fn px_to_cell_1based(x_px: f32, y_px: f32, cell_w_px: f32, line_h_px: f32) -> (u32, u32) {
    let cell_w = cell_w_px.max(0.001);
    let line_h = line_h_px.max(0.001);
    let col = (x_px / cell_w).floor().max(0.0) as u32 + 1;
    let row = (y_px / line_h).floor().max(0.0) as u32 + 1;
    (col, row)
}

/// Translate logical-px coords into an alacritty grid Point clamped to the
/// visible grid. Scrollback handling matches win32: the renderer maps
/// visible_row → Line(row) regardless of display_offset, so this fn doesn't
/// subtract it. When the renderer learns to honor display_offset, the
/// matching subtraction must land in both files together.
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

/// Encode an xterm mouse event. Identical wire format to the win32 helper
/// — see that file's doc-comment block for the full SGR / URXVT / X10
/// specification.
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

/// Copy a UTF-8 string to the macOS pasteboard. Best-effort; silent on
/// failure (we have no surface to bubble errors here, matching win32's
/// `let _ = copy_to_clipboard(...)` pattern).
fn copy_to_clipboard_macos(text: &str) {
    // NSPasteboard mutations must happen on the main thread.
    let owned = text.to_string();
    let _ = main_sync(move || {
        let pb = NSPasteboard::generalPasteboard();
        let _ = pb.clearContents();
        let ns_text = NSString::from_str(&owned);
        // SAFETY: NSPasteboardTypeString is an extern static; reading it
        // requires unsafe in Rust 2021. The pointer is a process-lifetime
        // CFString constant.
        let pasteboard_type = unsafe { NSPasteboardTypeString };
        let _ = pb.setString_forType(&ns_text, pasteboard_type);
    });
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
