// Phase-0 spike: a single child HWND parented to the Tauri main window.
//
// Key invariants (derived from the migration plan + project memory):
//   * Style is WS_CHILD | WS_CLIPSIBLINGS. NOT WS_EX_COMPOSITED — that would
//     route paints through DWM's per-pixel compositor and reintroduce the
//     WebView2 flicker we are trying to eliminate.
//   * The child subscribes only to WM_PAINT, WM_SIZE, WM_MOUSE*, WM_KEY*,
//     and WM_IME_* (the latter two are no-ops in the spike). Parent-driven
//     relayout is wired off WM_WINDOWPOSCHANGED on the *parent*, NOT
//     SIZE_RESTORED on the parent's WM_SIZE — per memory
//     feedback_wm_size_restored_not_transition.md, that wparam fires on
//     every drag-resize tick and would shake the surface.
//   * wgpu's Surface holds an unsafe borrow of the HWND. The Renderer is
//     dropped before DestroyWindow is called in destroy().

use raw_window_handle::{
    RawDisplayHandle, RawWindowHandle, Win32WindowHandle, WindowsDisplayHandle,
};
use std::cell::RefCell;
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::ptr::NonNull;
use std::sync::OnceLock;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{BOOL, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{InvalidateRect, ValidateRect};
use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
use windows::Win32::UI::WindowsAndMessaging::*;

use super::super::parser_bridge::ParserBridge;
use super::super::pty_route;
use super::super::region;
use super::{NativeTermWindow, Rect, TerminalTheme};

const CLASS_NAME: &[u16] = &[
    'M' as u16, 'a' as u16, 'd' as u16, 'e' as u16, '_' as u16,
    'N' as u16, 'a' as u16, 't' as u16, 'i' as u16, 'v' as u16, 'e' as u16,
    'T' as u16, 'e' as u16, 'r' as u16, 'm' as u16, 0,
];

static CLASS_REGISTERED: OnceLock<()> = OnceLock::new();

/// Timer id for the continuous-repaint timer set on attach_pty. Per-HWND so
/// the constant is fine — SetTimer scopes the id to the target window.
const RENDER_TIMER_ID: usize = 1;

thread_local! {
    // Set during CreateWindowExW so WM_NCCREATE/WM_CREATE can stash the
    // Box<ChildState> pointer into GWLP_USERDATA before the first real
    // message arrives. Standard Win32 init dance.
    static PENDING_STATE: RefCell<Option<*mut ChildState>> = const { RefCell::new(None) };
}

struct ChildState {
    renderer: Option<super::super::renderer::Renderer>,
    hwnd: HWND,
    /// Currently-attached PTY id, mirrored from PlatformWindow.attached_pty_id
    /// so the wnd_proc (which only has access to ChildState via GWLP_USERDATA)
    /// can forward WM_CHAR / WM_KEYDOWN bytes to the PTY writer directly.
    pty_id: Option<u32>,
}

pub struct PlatformWindow {
    hwnd: HWND,
    last_dpr: f32,
    /// Set on `attach_pty`, dropped on `detach_pty` or `destroy`. Owns the
    /// parser worker thread. The renderer holds an Arc to the same Term.
    parser_bridge: Option<ParserBridge>,
    /// Tracks which PTY (if any) is attached, for unlink on detach/destroy.
    attached_pty_id: Option<u32>,
    /// The native_term_id assigned by the mod.rs handler. Cached so detach
    /// can close the crossbeam channel.
    term_id: Option<u32>,
    // Owned heap allocation — pointer matches GWLP_USERDATA. We free it in
    // destroy() AFTER DestroyWindow returns.
    state: NonNull<ChildState>,
}

// SAFETY: We only access `state` from the owning thread (Tauri command
// handler thread). Win32 messages run on whichever thread owns the HWND;
// because we create it on the same thread that calls into us, the subclass
// hits the state via GWLP_USERDATA, not via this field.
unsafe impl Send for PlatformWindow {}

impl PlatformWindow {
    pub fn new(parent_hwnd: isize, rect: Rect, dpr: f32) -> Result<Self, String> {
        unsafe {
            ensure_class_registered()?;

            // Physical-pixel rect for the SetWindowPos / CreateWindowExW call.
            let (x, y, w, h) = logical_rect_to_physical(rect, dpr);

            // Pre-allocate the state Box so WM_NCCREATE can find it.
            let state = Box::leak(Box::new(ChildState {
                renderer: None,
                hwnd: HWND(std::ptr::null_mut()),
                pty_id: None,
            })) as *mut ChildState;
            PENDING_STATE.with(|cell| *cell.borrow_mut() = Some(state));

            let hwnd = CreateWindowExW(
                // WS_EX_NOACTIVATE: tells Windows this window never wants the
                // foreground/keyboard-focus role. Without this, clicking the
                // child HWND would steal focus from the React UI — observed
                // during live spike #2 (typing dies, Chromium pauses rAF on
                // the now-unfocused document). Belt-and-suspenders: the
                // subclass also returns MA_NOACTIVATE on WM_MOUSEACTIVATE,
                // since WS_EX_NOACTIVATE alone is not reliably honored under
                // every Windows version + parent-window-activation interaction.
                WS_EX_NOACTIVATE,
                PCWSTR(CLASS_NAME.as_ptr()),
                PCWSTR(std::ptr::null()),
                WS_CHILD | WS_CLIPSIBLINGS | WS_VISIBLE,
                x, y, w, h,
                HWND(parent_hwnd as *mut _),
                HMENU::default(),
                HINSTANCE::default(),
                None,
            )
            .map_err(|e| {
                // Reset the thread-local so a future call doesn't see a stale ptr.
                PENDING_STATE.with(|cell| *cell.borrow_mut() = None);
                drop(Box::from_raw(state));
                format!("CreateWindowExW failed: {e}")
            })?;

            // Clear thread-local — WM_NCCREATE has already consumed it (or
            // not, in which case it was never read).
            PENDING_STATE.with(|cell| *cell.borrow_mut() = None);

            (*state).hwnd = hwnd;

            // Build the renderer now. We pass raw_window_handle's Win32 +
            // Windows display handles directly. The HWND will outlive the
            // Renderer (we drop the renderer in destroy() before DestroyWindow).
            let hwnd_isize = hwnd.0 as isize;
            let mut win32_handle = Win32WindowHandle::new(
                std::num::NonZeroIsize::new(hwnd_isize).ok_or("zero HWND")?,
            );
            // hinstance is informational on modern Windows; passing 0 is fine.
            win32_handle.hinstance = std::num::NonZeroIsize::new(0);
            let rwh = RawWindowHandle::Win32(win32_handle);
            let rdh = RawDisplayHandle::Windows(WindowsDisplayHandle::new());

            let renderer = super::super::renderer::Renderer::new(
                rwh,
                rdh,
                w.max(1) as u32,
                h.max(1) as u32,
            )
            .map_err(|e| {
                // Roll back the window we just created.
                let _ = DestroyWindow(hwnd);
                drop(Box::from_raw(state));
                format!("Renderer::new: {e}")
            })?;

            (*state).renderer = Some(renderer);

            // Bring the child HWND above the WebView2 child in the parent's
            // child-window Z-order. Without this, WebView2 (also a WS_CHILD
            // of the main window) renders on top and our wgpu output is fully
            // occluded — observed during the first live spike run.
            // SWP_NOACTIVATE keeps keyboard focus on the React UI; SWP_NOMOVE
            // | SWP_NOSIZE preserves the geometry we just set.
            let _ = bring_above_siblings(hwnd);

            // Force the first paint.
            let _ = InvalidateRect(hwnd, None, BOOL(0));

            Ok(PlatformWindow {
                hwnd,
                last_dpr: dpr,
                parser_bridge: None,
                attached_pty_id: None,
                term_id: None,
                state: NonNull::new_unchecked(state),
            })
        }
    }
}

impl NativeTermWindow for PlatformWindow {
    fn resize(&mut self, rect: Rect, dpr: f32) -> Result<(), String> {
        unsafe {
            self.last_dpr = dpr;
            let (x, y, w, h) = logical_rect_to_physical(rect, dpr);
            SetWindowPos(
                self.hwnd,
                HWND::default(),
                x, y, w, h,
                SWP_NOZORDER | SWP_NOACTIVATE,
            )
            .map_err(|e| format!("SetWindowPos: {e}"))?;
            // WM_SIZE will fire and the subclass will resize the surface.
            Ok(())
        }
    }

    fn show(&mut self) -> Result<(), String> {
        unsafe {
            let _ = ShowWindow(self.hwnd, SW_SHOW);
            // Re-assert Z-order on every show — Workspace tab switches will
            // call hide/show, and Windows may have re-stacked siblings
            // (e.g. WebView2 popups, IME windows) while we were hidden.
            let _ = bring_above_siblings(self.hwnd);
        }
        Ok(())
    }

    fn hide(&mut self) -> Result<(), String> {
        unsafe {
            let _ = ShowWindow(self.hwnd, SW_HIDE);
        }
        Ok(())
    }

    fn set_region(&mut self, holes: &[Rect], dpr_arg: f32) -> Result<(), String> {
        unsafe {
            // mod.rs passes 0.0 — the locked wire format omits dpr from
            // set_region. We use the cached last_dpr instead.
            let dpr = if dpr_arg > 0.0 { dpr_arg } else { self.last_dpr };
            let mut r = RECT::default();
            let _ = GetClientRect(self.hwnd, &mut r);
            let size_px = (r.right - r.left, r.bottom - r.top);
            region::apply_region(self.hwnd.0 as isize, size_px, holes, dpr)
        }
    }

    fn destroy(mut self: Box<Self>) -> Result<(), String> {
        // Kill the repaint timer before tearing down anything else so a
        // pending WM_TIMER can't fire mid-destroy and touch a freed state.
        unsafe {
            let _ = KillTimer(self.hwnd, RENDER_TIMER_ID);
        }
        // Tear down PTY routing first so the parser worker exits cleanly
        // before we drop anything else.
        if let Some(pty_id) = self.attached_pty_id.take() {
            pty_route::unlink(pty_id);
        }
        if let Some(term_id) = self.term_id.take() {
            pty_route::close_channel(term_id);
        }
        // Dropping the ParserBridge joins the worker thread.
        self.parser_bridge.take();

        unsafe {
            // Drop the renderer FIRST so wgpu releases its surface while the
            // HWND is still alive (the swap-chain holds an HWND reference).
            let state_ptr = self.state.as_ptr();
            (*state_ptr).renderer.take();

            // Now destroy the window.
            let _ = DestroyWindow(self.hwnd);

            // Free the heap state.
            drop(Box::from_raw(state_ptr));
        }
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

        // Create the crossbeam channel for this term, then spawn the parser
        // worker. Order matters: create_channel must precede link() so the
        // first byte pty.rs side-emits has a destination.
        let rx = pty_route::create_channel(term_id);
        pty_route::link(term_id, pty_id);
        let bridge = ParserBridge::spawn(term_id, cols, rows, rx);
        let term_arc = std::sync::Arc::clone(&bridge.term);

        unsafe {
            let state = self.state.as_mut();
            if let Some(r) = state.renderer.as_mut() {
                r.attach_term(term_arc, cols, rows);
            }
            // Mirror the pty_id into ChildState so wnd_proc's key handlers
            // can locate the PTY writer when forwarding keystrokes.
            state.pty_id = Some(pty_id);
        }

        self.parser_bridge = Some(bridge);
        self.attached_pty_id = Some(pty_id);
        self.term_id = Some(term_id);

        // R1.c continuous-repaint timer. WM_PAINT alone doesn't fire on PTY
        // bytes arriving — without this, screen would freeze after first paint.
        // 16ms ≈ 60Hz; the WM_TIMER handler InvalidateRects which triggers
        // WM_PAINT which calls renderer.render(). Cheap when no damage; the
        // renderer rebuilds dirty rows only. Killed on detach + destroy.
        // R1.d will replace this with damage-driven repaint signaled from
        // parser_bridge.
        unsafe {
            let _ = InvalidateRect(self.hwnd, None, BOOL(0));
            SetTimer(self.hwnd, RENDER_TIMER_ID, 16, None);
        }

        Ok(())
    }

    fn detach_pty(&mut self) -> Result<(), String> {
        unsafe {
            let _ = KillTimer(self.hwnd, RENDER_TIMER_ID);
        }
        if let Some(pty_id) = self.attached_pty_id.take() {
            pty_route::unlink(pty_id);
        }
        if let Some(term_id) = self.term_id.take() {
            pty_route::close_channel(term_id);
        }
        // Drop the bridge — its worker exits as soon as the Sender is gone.
        self.parser_bridge.take();

        unsafe {
            let state = self.state.as_mut();
            if let Some(r) = state.renderer.as_mut() {
                r.detach_term();
            }
            state.pty_id = None;
            let _ = InvalidateRect(self.hwnd, None, BOOL(0));
        }
        Ok(())
    }

    fn propose_dimensions(&self, width_px: u32, height_px: u32) -> (u32, u32) {
        // R1.c stub: approximate Hack 14px metrics. Real font-metrics
        // pull-through lands in R1.d when glyph_atlas exposes them.
        // 14px @ ~60% character aspect ≈ 8.4px advance, line-height 1.2 → ~17px.
        // We cap cols at minimum 20 per the plan's narrow-pane guard rather
        // than returning an error — the JS side treats this as a soft floor.
        let cell_w: u32 = 9;
        let cell_h: u32 = 17;
        let cols = (width_px / cell_w).max(20);
        let rows = (height_px / cell_h).max(1);
        (cols, rows)
    }

    fn set_theme(&mut self, _theme: &TerminalTheme) -> Result<(), String> {
        // R1.c: accept the call, store for R1.d wiring. No-op visually.
        // R1.d will pipe colors through to the renderer's bg_clear + per-cell
        // attributes once SGR support lands.
        Ok(())
    }

    fn set_font(&mut self, _family: &str, _size_px: f32) -> Result<(), String> {
        // R1.c: accept, stub. R1.d will call GlyphStack::set_font and
        // re-shape all CellGrid buffers.
        Ok(())
    }

    fn set_cursor_style(&mut self, _style: &str, _blink: bool) -> Result<(), String> {
        // R1.c: accept, stub. R1.d will plumb to the cursor render pass.
        Ok(())
    }
}

/// Promote the child HWND to the top of the parent window's child Z-order.
/// SWP_NOACTIVATE keeps input focus on whoever currently owns it (the React
/// UI), SWP_NOMOVE | SWP_NOSIZE preserves the current geometry, and
/// HWND_TOP places this window above all sibling children including WebView2.
unsafe fn bring_above_siblings(hwnd: HWND) -> Result<(), String> {
    SetWindowPos(
        hwnd,
        HWND_TOP,
        0, 0, 0, 0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
    )
    .map_err(|e| format!("SetWindowPos(HWND_TOP): {e}"))
}

fn logical_rect_to_physical(rect: Rect, dpr: f32) -> (i32, i32, i32, i32) {
    let x = (rect.x * dpr).round() as i32;
    let y = (rect.y * dpr).round() as i32;
    let w = (rect.width * dpr).round() as i32;
    let h = (rect.height * dpr).round() as i32;
    (x, y, w.max(1), h.max(1))
}

unsafe fn ensure_class_registered() -> Result<(), String> {
    if CLASS_REGISTERED.get().is_some() {
        return Ok(());
    }
    let hinstance: HINSTANCE = HINSTANCE(
        windows::Win32::System::LibraryLoader::GetModuleHandleW(PCWSTR(std::ptr::null()))
            .map_err(|e| format!("GetModuleHandleW: {e}"))?
            .0,
    );
    let class = WNDCLASSW {
        style: CS_HREDRAW | CS_VREDRAW,
        lpfnWndProc: Some(wnd_proc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: hinstance,
        hIcon: HICON::default(),
        hCursor: LoadCursorW(HINSTANCE::default(), IDC_ARROW).unwrap_or_default(),
        // No background brush: we paint via wgpu. Setting a brush would let
        // GDI fill the client area with a system color first → 1-frame flash.
        hbrBackground: windows::Win32::Graphics::Gdi::HBRUSH::default(),
        lpszMenuName: PCWSTR(std::ptr::null()),
        lpszClassName: PCWSTR(CLASS_NAME.as_ptr()),
    };
    if RegisterClassW(&class) == 0 {
        return Err("RegisterClassW failed".to_string());
    }
    let _ = CLASS_REGISTERED.set(());
    Ok(())
}

unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_NCCREATE => {
            // Stash the pre-allocated ChildState pointer into GWLP_USERDATA.
            let ptr = PENDING_STATE.with(|cell| cell.borrow_mut().take());
            if let Some(p) = ptr {
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, p as isize);
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        WM_PAINT => {
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ChildState;
            if !state_ptr.is_null() {
                if let Some(r) = (*state_ptr).renderer.as_mut() {
                    let _ = r.render();
                }
            }
            // Validate the whole client area — we drew with wgpu, not GDI.
            // Skipping ValidateRect would cause WM_PAINT to fire continuously.
            let _ = ValidateRect(hwnd, None);
            LRESULT(0)
        }
        WM_SIZE => {
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ChildState;
            if !state_ptr.is_null() {
                let w = (lparam.0 & 0xFFFF) as u32;
                let h = ((lparam.0 >> 16) & 0xFFFF) as u32;
                if let Some(r) = (*state_ptr).renderer.as_mut() {
                    r.resize(w, h);
                }
            }
            LRESULT(0)
        }
        WM_TIMER => {
            // R1.c continuous-repaint pump. Only active while a PTY is
            // attached (SetTimer in attach_pty, KillTimer in detach_pty).
            let _ = InvalidateRect(hwnd, None, BOOL(0));
            LRESULT(0)
        }
        WM_MOUSEACTIVATE => {
            // Tell Windows: "process this mouse click but DO NOT activate me."
            // Belt-and-suspenders with WS_EX_NOACTIVATE on the window's ex-style.
            // Critical because Chromium pauses rAF when its document loses focus —
            // any click on this HWND without MA_NOACTIVATE freezes React animations.
            // In Phase R2 the same handler will still return MA_NOACTIVATE; mouse
            // events for terminal mouse modes are routed via the explicit WM_MOUSE*
            // arms, not via activation.
            LRESULT(MA_NOACTIVATE as isize)
        }
        WM_LBUTTONDOWN => {
            // Click-to-focus the native HWND for keyboard input. WS_EX_NOACTIVATE
            // prevents activation on mouse-down, but we still want the focus
            // for keyboard messages — SetFocus moves keyboard focus without
            // activating. WM_CHAR / WM_KEYDOWN only fire on the focused HWND.
            let _ = SetFocus(hwnd);
            LRESULT(0)
        }
        WM_KEYDOWN | WM_SYSKEYDOWN => {
            // Translate non-character keys (arrows, Enter, Backspace, Esc,
            // Home/End, Delete, PgUp/PgDn, F-keys) into terminal byte sequences
            // and forward to the PTY writer. Printable keys are handled by
            // WM_CHAR instead — we return DefWindowProc for unhandled vkeys so
            // Windows can dispatch the corresponding WM_CHAR.
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ChildState;
            let pty_id = if !state_ptr.is_null() {
                (*state_ptr).pty_id
            } else {
                None
            };
            let bytes = vk_to_bytes(wparam.0 as u32);
            if let (Some(pid), Some(b)) = (pty_id, bytes) {
                let _ = crate::pty::write_to_pty_sync(pid, b);
                return LRESULT(0);
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        WM_CHAR => {
            // wparam is a UTF-16 code unit. We collect surrogates if needed and
            // encode to UTF-8 before forwarding to the PTY.
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ChildState;
            let pty_id = if !state_ptr.is_null() {
                (*state_ptr).pty_id
            } else {
                None
            };
            if let Some(pid) = pty_id {
                let unit = wparam.0 as u16;
                // Single-unit fast path — surrogate-pair handling can be added
                // later for U+10000+ codepoints. ConPTY rarely sees them from
                // shell input anyway.
                if (0xD800..=0xDFFF).contains(&unit) {
                    // Skip lone surrogates — not the common case for keyboard input.
                    return LRESULT(0);
                }
                if let Some(c) = char::from_u32(unit as u32) {
                    let mut buf = [0u8; 4];
                    let s = c.encode_utf8(&mut buf);
                    let _ = crate::pty::write_to_pty_sync(pid, s.as_bytes());
                }
            }
            LRESULT(0)
        }
        WM_ERASEBKGND => {
            // Return non-zero to tell DefWindowProc we've handled erasing.
            // We don't actually erase — wgpu's clear pass owns the framebuffer.
            // This prevents the 1-frame GDI flash on size/show.
            LRESULT(1)
        }
        // The spike intentionally ignores mouse, keyboard, and IME messages;
        // R1 will hook them up.
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

#[allow(dead_code)]
fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

/// Translate a Win32 virtual-key code into the byte sequence a terminal
/// emulator expects. Returns `None` for keys that should fall through to
/// WM_CHAR (printable characters, plus modified versions which Windows
/// composes into character codes itself).
fn vk_to_bytes(vk: u32) -> Option<&'static [u8]> {
    // Constants from windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY.
    // Using raw u32 values avoids importing the whole VK_* module.
    const VK_BACK: u32 = 0x08;
    const VK_TAB: u32 = 0x09;
    const VK_RETURN: u32 = 0x0D;
    const VK_ESCAPE: u32 = 0x1B;
    const VK_PRIOR: u32 = 0x21; // PgUp
    const VK_NEXT: u32 = 0x22; // PgDn
    const VK_END: u32 = 0x23;
    const VK_HOME: u32 = 0x24;
    const VK_LEFT: u32 = 0x25;
    const VK_UP: u32 = 0x26;
    const VK_RIGHT: u32 = 0x27;
    const VK_DOWN: u32 = 0x28;
    const VK_DELETE: u32 = 0x2E;
    const VK_F1: u32 = 0x70;
    const VK_F12: u32 = 0x7B;

    match vk {
        // Most terminals expect DEL (0x7F) for Backspace, not BS (0x08).
        // bash, fish, zsh, cmd.exe all treat 0x7F as delete-prev-char.
        VK_BACK => Some(b"\x7F"),
        VK_TAB => Some(b"\t"),
        VK_RETURN => Some(b"\r"),
        VK_ESCAPE => Some(b"\x1b"),
        VK_UP => Some(b"\x1b[A"),
        VK_DOWN => Some(b"\x1b[B"),
        VK_RIGHT => Some(b"\x1b[C"),
        VK_LEFT => Some(b"\x1b[D"),
        VK_HOME => Some(b"\x1b[H"),
        VK_END => Some(b"\x1b[F"),
        VK_DELETE => Some(b"\x1b[3~"),
        VK_PRIOR => Some(b"\x1b[5~"),
        VK_NEXT => Some(b"\x1b[6~"),
        VK_F1 => Some(b"\x1bOP"),
        0x71 /* VK_F2 */ => Some(b"\x1bOQ"),
        0x72 /* VK_F3 */ => Some(b"\x1bOR"),
        0x73 /* VK_F4 */ => Some(b"\x1bOS"),
        0x74 /* VK_F5 */ => Some(b"\x1b[15~"),
        0x75 /* VK_F6 */ => Some(b"\x1b[17~"),
        0x76 /* VK_F7 */ => Some(b"\x1b[18~"),
        0x77 /* VK_F8 */ => Some(b"\x1b[19~"),
        0x78 /* VK_F9 */ => Some(b"\x1b[20~"),
        0x79 /* VK_F10 */ => Some(b"\x1b[21~"),
        0x7A /* VK_F11 */ => Some(b"\x1b[23~"),
        VK_F12 => Some(b"\x1b[24~"),
        _ => None,
    }
}
