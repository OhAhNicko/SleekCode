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
use std::sync::{Arc, Mutex, OnceLock};

use windows::core::PCWSTR;
use windows::Win32::Foundation::{BOOL, HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{InvalidateRect, ValidateRect};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::UI::Input::Ime::{
    ImmGetCompositionStringW, ImmGetContext, ImmReleaseContext, GCS_COMPSTR, GCS_CURSORPOS,
    GCS_RESULTSTR,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyState, ReleaseCapture, SetCapture, SetFocus, TrackMouseEvent, TME_LEAVE,
    TRACKMOUSEEVENT,
};
use windows::Win32::UI::WindowsAndMessaging::*;

/// `WM_MOUSELEAVE` is defined in the Controls module of windows-rs; pulling it
/// in directly avoids a wildcard import that conflicts with the
/// `WindowsAndMessaging::*` namespace.
const WM_MOUSELEAVE: u32 = 0x02A3;

use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Column, Line, Point, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::term::{Term, TermMode};

use tauri::AppHandle;

use super::super::events::{
    emit_cell_hover, emit_cell_hover_end, emit_ime_composition, emit_key_down_preview,
    emit_link_click, emit_link_hover, emit_mouse_passthrough, emit_r_button, emit_selection,
    CellHover, ImeComposition, KeyDownPreview, KeyEventDto, KeyModifiers, LinkClick, LinkHover,
    MousePassthrough, RButton, Selection as SelectionEvent,
};
use super::super::parser_bridge::{ParserBridge, TermListener};
use super::super::renderer::ThemeColors;
use super::super::pty_route;
use super::super::region;
use super::{NativeTermWindow, Rect, TerminalTheme};

/// CF_UNICODETEXT clipboard format id. Hardcoded because the windows-rs
/// constant lives behind a different feature gate; this is a stable Win32 value.
const CF_UNICODETEXT: u32 = 13;

/// Per-cell PHYSICAL-pixel metrics for the default Hack 14px font in
/// pipeline.rs. These are the INITIAL values stored on every ChildState; the
/// per-pane fields are updated by `set_font` once the renderer reports back
/// fresh measurements from `GlyphStack::cell_advance_px / line_height_px`.
/// Default matches `glyph_atlas::measure_cell_advance` fallback (14*0.6 ≈ 8.4)
/// and `(14*1.2).ceil() = 17`.
const CELL_W_PX: f32 = 8.4;
const CELL_H_PX: f32 = 17.0;

/// Edge band (logical px) inside which WM_MOUSEMOVE is forwarded to JS as a
/// `mouse_passthrough` event so the splitter handler can pick up the cursor.
/// Below ~4px the splitter visual is too narrow; above ~8px hover noise leaks
/// into pane content. Locked at 8 for the O2-B slice; tunable later.
const SPLITTER_EDGE_BAND_LOGICAL_PX: f32 = 8.0;

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
    /// AppHandle stored at create time so event arms (WM_IME_*, WM_RBUTTONDOWN,
    /// WM_MOUSEMOVE) can emit per-pane Tauri events without a global lookup.
    /// Set by `PlatformWindow::set_app_handle` after `new()`.
    app: Option<AppHandle>,
    /// native_term id (the registry-allocated u32) cached here so event arms
    /// can format channel names. Mirrors PlatformWindow.term_id.
    term_id: Option<u32>,
    /// Current device-pixel ratio. Mirrors PlatformWindow.last_dpr so wnd_proc
    /// can convert physical → logical px without locking the outer struct.
    /// Updated on every resize.
    dpr: f32,
    /// Client-area size in physical pixels (width, height). Mirrors WM_SIZE
    /// so edge-band detection in WM_MOUSEMOVE doesn't need GetClientRect on
    /// every move (which would be a syscall per event).
    client_px: (i32, i32),
    /// Last emitted (x, y) for mouse_passthrough coalescing — round to integer
    /// logical px and skip emission when unchanged. Prevents flooding the JS
    /// side with sub-pixel jitter.
    last_passthrough: Option<(i32, i32)>,
    /// R3-mouse: mirror of `ParserBridge::term`, set on `attach_pty` and
    /// cleared on `detach_pty`. Lets WM_MOUSEWHEEL / WM_LBUTTON* drive
    /// scrollback + selection directly without locking the outer PlatformWindow.
    term: Option<Arc<Mutex<Term<TermListener>>>>,
    /// Tracks whether the left mouse button is currently held. Set on
    /// WM_LBUTTONDOWN, cleared on WM_LBUTTONUP and on capture loss. Gates
    /// WM_MOUSEMOVE's selection-extend branch.
    lbutton_down: bool,
    /// R3: last emitted (line, col) for cell_hover coalescing. The hover
    /// event fires only when (line, col) differs from the previous emit so
    /// sub-cell mouse jitter doesn't flood the bus. Reset to None on
    /// WM_MOUSELEAVE so the next entry is guaranteed to emit even if the
    /// cursor returns to the same cell. Line is in alacritty's signed
    /// space — negative when the cursor is over scrollback rows.
    last_cell_hover: Option<(i64, u32)>,
    /// R3: OSC 8 hyperlink hover coalescing. Stores last emitted
    /// (line, col, uri) so we only re-emit `link_hover` when the hovered URI
    /// changes. When the cell under the cursor has NO hyperlink we DO NOT
    /// emit a clearing event — the React side keys link UI off `cell_hover`
    /// arriving for a cell without a `link_hover`, which is simpler than a
    /// nullable payload (decision: emit-only-when-present).
    last_link_hover: Option<(i64, u32, String)>,
    /// R3: have we called `TrackMouseEvent(TME_LEAVE)` since the last
    /// WM_MOUSELEAVE? Win32 requires re-arming after every leave; this flag
    /// avoids re-calling on every WM_MOUSEMOVE (one syscall is enough).
    mouse_tracking: bool,
    /// Phase 3 set_font: per-pane PHYSICAL cell width (horizontal advance) in
    /// pixels. Initialised to the Hack 14px default and refreshed in
    /// `set_font` from the renderer's freshly-measured glyph advance. Read by
    /// `wnd_proc` hot paths via state pointer so mouse-coord math stays in
    /// sync after a font swap.
    cell_w_px: f32,
    /// Phase 3 set_font: per-pane PHYSICAL line height in pixels. Same source
    /// + lifecycle as `cell_w_px`.
    cell_h_px: f32,
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
                app: None,
                term_id: None,
                dpr,
                client_px: (w.max(1), h.max(1)),
                last_passthrough: None,
                term: None,
                lbutton_down: false,
                last_cell_hover: None,
                last_link_hover: None,
                mouse_tracking: false,
                cell_w_px: CELL_W_PX,
                cell_h_px: CELL_H_PX,
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

    /// O2-B: stash the AppHandle on ChildState so wnd_proc can emit per-pane
    /// events. Called from `native_term_create` immediately after `new()`.
    /// Idempotent — later calls overwrite (we never expect that, but it's
    /// safer than panicking).
    pub fn set_app_handle(&mut self, app: AppHandle) {
        unsafe {
            self.state.as_mut().app = Some(app);
        }
    }

    /// O2-B: mirror the registry-allocated term id into ChildState so event
    /// arms can format `native_term:{id}:...` channels.
    pub fn set_term_id(&mut self, id: u32) {
        self.term_id = Some(id);
        unsafe {
            self.state.as_mut().term_id = Some(id);
        }
    }
}

impl NativeTermWindow for PlatformWindow {
    fn resize(&mut self, rect: Rect, dpr: f32) -> Result<(), String> {
        unsafe {
            self.last_dpr = dpr;
            // Mirror dpr into ChildState so the wnd_proc edge-band /
            // RButton / passthrough math uses the up-to-date scale even when
            // WM_SIZE doesn't carry DPR info.
            self.state.as_mut().dpr = dpr;
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
        // Per-cell logical-px metrics for the cursor event. ChildState's
        // cell_*_px are PHYSICAL and reflect the active font (initial Hack
        // 14px until `set_font` swaps them) — divide by dpr to get logical
        // for the JS-side IME popup.
        let dpr = self.last_dpr.max(0.0001);
        let (cell_w_physical, cell_h_physical) = unsafe {
            let s = self.state.as_ref();
            (s.cell_w_px, s.cell_h_px)
        };
        let cell_w_logical = cell_w_physical / dpr;
        let line_h_logical = cell_h_physical / dpr;
        let app_for_bridge = unsafe { self.state.as_ref().app.clone() };
        let bridge = ParserBridge::spawn(
            term_id,
            cols,
            rows,
            rx,
            cell_w_logical,
            line_h_logical,
            app_for_bridge,
        );
        let term_arc = Arc::clone(&bridge.term);

        unsafe {
            let state = self.state.as_mut();
            if let Some(r) = state.renderer.as_mut() {
                r.attach_term(Arc::clone(&term_arc), cols, rows);
            }
            // Mirror the pty_id into ChildState so wnd_proc's key handlers
            // can locate the PTY writer when forwarding keystrokes.
            state.pty_id = Some(pty_id);
            // Mirror the Term Arc so wnd_proc can drive scroll + selection.
            state.term = Some(term_arc);
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
            state.term = None;
            state.lbutton_down = false;
            state.last_cell_hover = None;
            state.last_link_hover = None;
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

    fn set_theme(&mut self, theme: &TerminalTheme) -> Result<(), String> {
        // Parse hex strings into byte RGBA, fold into a ThemeColors, and hand
        // it to the renderer. The renderer atomically swaps its shared palette
        // and invalidates the per-row cache; we then force a repaint so the
        // next WM_PAINT picks up the new colors immediately instead of waiting
        // on the WM_TIMER tick.
        let colors = parse_theme(theme)?;
        unsafe {
            let state = self.state.as_mut();
            if let Some(r) = state.renderer.as_mut() {
                r.set_theme(colors);
            }
            let _ = InvalidateRect(self.hwnd, None, BOOL(0));
        }
        Ok(())
    }

    fn set_font(&mut self, family: &str, size_px: f32) -> Result<(), String> {
        // Phase 3: hot-swap the GlyphStack font + size. The renderer also
        // rebuilds every row Buffer so cosmic-text's Metrics pick up the new
        // size. Mirror the freshly-measured cell metrics back into ChildState
        // so wnd_proc's mouse / cell-coord math stays consistent.
        unsafe {
            let state = self.state.as_mut();
            if let Some(r) = state.renderer.as_mut() {
                r.set_font(family.to_string(), size_px);
                let (cw, ch) = r.cell_metrics();
                state.cell_w_px = cw.max(0.001);
                state.cell_h_px = ch.max(0.001);
            }
            let _ = InvalidateRect(self.hwnd, None, BOOL(0));
        }
        Ok(())
    }

    fn set_cursor_style(&mut self, style: &str, blink: bool) -> Result<(), String> {
        // Phase 3: forward to the renderer's cursor pass + force a repaint
        // so the new style appears on the next WM_PAINT rather than waiting
        // on the WM_TIMER tick.
        unsafe {
            let state = self.state.as_mut();
            if let Some(r) = state.renderer.as_mut() {
                r.set_cursor_style(style, blink);
            }
            let _ = InvalidateRect(self.hwnd, None, BOOL(0));
        }
        Ok(())
    }

    fn set_search_highlights(&mut self, rects: Vec<Rect>) -> Result<(), String> {
        unsafe {
            let state = self.state.as_mut();
            if let Some(r) = state.renderer.as_mut() {
                r.set_search_highlights(rects);
            }
            let _ = InvalidateRect(self.hwnd, None, BOOL(0));
        }
        Ok(())
    }

    fn clear_search_highlights(&mut self) -> Result<(), String> {
        unsafe {
            let state = self.state.as_mut();
            if let Some(r) = state.renderer.as_mut() {
                r.clear_search_highlights();
            }
            let _ = InvalidateRect(self.hwnd, None, BOOL(0));
        }
        Ok(())
    }

    fn term(&self) -> Option<Arc<Mutex<Term<TermListener>>>> {
        // R3: hand out a strong clone of the Term Arc so the per-pane command
        // handlers (get_buffer_lines / scroll / search) can snapshot the grid
        // without holding the registry mutex. The closure scope keeps the
        // outer `with_window` lock window tight — each command should acquire
        // term(), drop the registry guard via the closure return, then lock
        // the Term separately.
        self.parser_bridge.as_ref().map(|b| Arc::clone(&b.term))
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
                // Mirror the physical client-area size into ChildState so the
                // WM_MOUSEMOVE edge-band check doesn't need GetClientRect on
                // every mouse move (cheap syscall, but it adds up).
                (*state_ptr).client_px = (w as i32, h as i32);
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
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ChildState;
            if !state_ptr.is_null() {
                let x_px = (lparam.0 as i16) as i32;
                let y_px = ((lparam.0 >> 16) as i16) as i32;
                let ctrl = (GetKeyState(VK_CONTROL_RAW as i32) as u16 & 0x8000) != 0;
                let shift = (GetKeyState(VK_SHIFT_RAW as i32) as u16 & 0x8000) != 0;
                let alt = (GetKeyState(VK_MENU_RAW as i32) as u16 & 0x8000) != 0;

                // R3: Ctrl+click on a hyperlinked cell → dispatch link_click
                // and SKIP selection-start. Browser-style: fire on press, not
                // release. We do not SetCapture — the user can release
                // normally, and the navigation happens on the React side.
                if ctrl {
                    let cell_w_px = (*state_ptr).cell_w_px.max(0.001);
                    let line_h_px = (*state_ptr).cell_h_px.max(0.001);
                    let row_visible = (y_px as f32 / line_h_px).floor() as i32;
                    let col_raw = (x_px as f32 / cell_w_px).floor() as i32;
                    let click_link = if let Some(term) = (*state_ptr).term.as_ref() {
                        let t = term.lock().expect("term lock poisoned");
                        let grid = t.grid();
                        let cols = grid.columns();
                        let rows = grid.screen_lines();
                        let display_offset_i = grid.display_offset() as i32;
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
                        if let (Some(app), Some(tid)) =
                            ((*state_ptr).app.as_ref(), (*state_ptr).term_id)
                        {
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
                        return LRESULT(0);
                    }
                }

                // R4-mouse: xterm mouse-mode forwarding. When the running TUI
                // has enabled mouse reporting (DECSET 1000/1002/1003) and
                // Shift is NOT held, encode the press as an xterm escape
                // sequence and ship it to the PTY. Holding Shift bypasses
                // forwarding so the user can still text-select even inside
                // mouse-aware apps (xterm/iTerm/Warp convention).
                let modes = read_mouse_modes(&*state_ptr);
                if modes.clicks_enabled && !shift {
                    let (x_cell, y_cell) = px_to_cell_1based(x_px, y_px, (*state_ptr).cell_w_px, (*state_ptr).cell_h_px);
                    let fmt = mouse_format(modes);
                    if let Some(bytes) = encode_mouse_event(
                        0, x_cell, y_cell, ctrl, shift, alt, true, false, fmt,
                    ) {
                        if let Some(pid) = (*state_ptr).pty_id {
                            let _ = crate::pty::write_to_pty_sync(pid, &bytes);
                        }
                    }
                    // Capture so WM_LBUTTONUP / drag-motion still routes here.
                    (*state_ptr).lbutton_down = true;
                    let _ = SetCapture(hwnd);
                    return LRESULT(0);
                }

                // R3-mouse: begin a fresh text selection at the click cell. We
                // intentionally clear any prior selection (Shift-click extending
                // an existing selection is a future enhancement). Capture the
                // mouse so we keep receiving WM_MOUSEMOVE even when the cursor
                // leaves the child HWND mid-drag.
                if let Some(point) = mouse_to_point(&*state_ptr, x_px, y_px) {
                    if let Some(term) = (*state_ptr).term.as_ref() {
                        let mut t = term.lock().expect("term lock poisoned");
                        t.selection = Some(Selection::new(SelectionType::Simple, point, Side::Left));
                        drop(t);
                    }
                }
                (*state_ptr).lbutton_down = true;
                let _ = SetCapture(hwnd);
                let _ = InvalidateRect(hwnd, None, BOOL(0));
            }
            LRESULT(0)
        }
        WM_LBUTTONUP => {
            // R3-mouse: finalize the selection. Read the selection text under
            // a brief lock, drop the lock, then emit + copy. Selection stays
            // visible (Warp/iTerm convention) until a new LBUTTONDOWN clears it.
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ChildState;
            if !state_ptr.is_null() {
                (*state_ptr).lbutton_down = false;
                let _ = ReleaseCapture();

                // R4-mouse: when xterm mouse mode is on and Shift is not held,
                // forward the release event to the PTY and skip the
                // selection-finalise path. Shift-bypass uses the same gate as
                // WM_LBUTTONDOWN so a Shift-drag still copies to clipboard.
                let shift = (GetKeyState(VK_SHIFT_RAW as i32) as u16 & 0x8000) != 0;
                let ctrl = (GetKeyState(VK_CONTROL_RAW as i32) as u16 & 0x8000) != 0;
                let alt = (GetKeyState(VK_MENU_RAW as i32) as u16 & 0x8000) != 0;
                let modes = read_mouse_modes(&*state_ptr);
                if modes.clicks_enabled && !shift {
                    let x_px = (lparam.0 as i16) as i32;
                    let y_px = ((lparam.0 >> 16) as i16) as i32;
                    let (x_cell, y_cell) = px_to_cell_1based(x_px, y_px, (*state_ptr).cell_w_px, (*state_ptr).cell_h_px);
                    // SGR distinguishes release via lowercase `m`; X10/URXVT
                    // use button code 3.
                    let fmt = mouse_format(modes);
                    let btn = if fmt == MouseFormat::Sgr { 0 } else { 3 };
                    if let Some(bytes) = encode_mouse_event(
                        btn, x_cell, y_cell, ctrl, shift, alt, false, false, fmt,
                    ) {
                        if let Some(pid) = (*state_ptr).pty_id {
                            let _ = crate::pty::write_to_pty_sync(pid, &bytes);
                        }
                    }
                    return LRESULT(0);
                }

                let text = if let Some(term) = (*state_ptr).term.as_ref() {
                    let t = term.lock().expect("term lock poisoned");
                    t.selection_to_string().filter(|s| !s.is_empty())
                } else {
                    None
                };
                if let Some(text) = text {
                    if let (Some(app), Some(tid)) =
                        ((*state_ptr).app.as_ref(), (*state_ptr).term_id)
                    {
                        emit_selection(
                            app,
                            tid,
                            SelectionEvent { text: text.clone() },
                        );
                    }
                    // Best-effort clipboard write; failure is silent (no
                    // surface to surface the error to here).
                    let _ = copy_to_clipboard(hwnd, &text);
                }
            }
            LRESULT(0)
        }
        WM_CAPTURECHANGED => {
            // Another window stole capture (e.g. WM_KILLFOCUS path, alt-tab).
            // Treat it like an LBUTTONUP-without-finalisation: clear the
            // dragging flag but leave the existing selection in place.
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ChildState;
            if !state_ptr.is_null() {
                (*state_ptr).lbutton_down = false;
            }
            LRESULT(0)
        }
        WM_MOUSEWHEEL => {
            // R3-mouse: scrollback. wparam HIWORD is signed wheel delta;
            // multiples of WHEEL_DELTA (120). Positive = wheel forward
            // (towards user) = scroll towards OLDER content in xterm terms.
            // alacritty's Scroll::Delta uses the same sign convention: positive
            // → older lines come into view.
            const WHEEL_DELTA: i32 = 120;
            const LINES_PER_NOTCH: i32 = 3;
            let delta_raw = ((wparam.0 >> 16) as i16) as i32;
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ChildState;
            if state_ptr.is_null() {
                return LRESULT(0);
            }

            // R4-mouse: when the TUI has mouse mode enabled and Shift is not
            // held, forward wheel events to the PTY (button 64 = up, 65 = down,
            // one event per notch). htop/lazygit/btop all expect this. Shift
            // bypasses for local scrollback.
            //
            // WM_MOUSEWHEEL's lparam is in SCREEN coords (unlike other mouse
            // messages which are client-area). ScreenToClient would be the
            // pedantic fix, but cursor coords cost nothing on practical
            // hardware and the TUI mostly ignores wheel coords anyway —
            // clamp to (1,1) as a safe default when conversion is skipped.
            let shift = (GetKeyState(VK_SHIFT_RAW as i32) as u16 & 0x8000) != 0;
            let ctrl = (GetKeyState(VK_CONTROL_RAW as i32) as u16 & 0x8000) != 0;
            let alt = (GetKeyState(VK_MENU_RAW as i32) as u16 & 0x8000) != 0;
            let modes = read_mouse_modes(&*state_ptr);
            if modes.clicks_enabled && !shift {
                let notches = (delta_raw / WHEEL_DELTA).abs();
                if notches > 0 {
                    let btn = if delta_raw > 0 { 64 } else { 65 };
                    // Convert screen → client for cell coords.
                    let mut pt = windows::Win32::Foundation::POINT {
                        x: (lparam.0 as i16) as i32,
                        y: ((lparam.0 >> 16) as i16) as i32,
                    };
                    let _ = windows::Win32::Graphics::Gdi::ScreenToClient(hwnd, &mut pt);
                    let (x_cell, y_cell) = px_to_cell_1based(
                        pt.x,
                        pt.y,
                        (*state_ptr).cell_w_px,
                        (*state_ptr).cell_h_px,
                    );
                    if let Some(pid) = (*state_ptr).pty_id {
                        let fmt = mouse_format(modes);
                        for _ in 0..notches {
                            // Wheel events use `M` (press) in SGR; X10/URXVT
                            // always press-style too.
                            if let Some(bytes) = encode_mouse_event(
                                btn, x_cell, y_cell, ctrl, shift, alt, true, false, fmt,
                            ) {
                                let _ = crate::pty::write_to_pty_sync(pid, &bytes);
                            }
                        }
                    }
                }
                return LRESULT(0);
            }

            let lines = delta_raw / WHEEL_DELTA * LINES_PER_NOTCH;
            if lines != 0 {
                if let Some(term) = (*state_ptr).term.as_ref() {
                    let mut t = term.lock().expect("term lock poisoned");
                    t.scroll_display(Scroll::Delta(lines));
                    drop(t);
                    let _ = InvalidateRect(hwnd, None, BOOL(0));
                }
            }
            LRESULT(0)
        }
        WM_KEYDOWN | WM_SYSKEYDOWN => {
            // Whitelist UI shortcuts (Ctrl+K palette, Ctrl+B sidebar, Ctrl+F search,
            // Ctrl+/ shortcuts, Ctrl+, settings, Alt+1..9 tabs). These get emitted
            // as key_down_preview events for the React side to consume and DO NOT
            // forward to PTY. Other Ctrl combos (Ctrl+C SIGINT, Ctrl+R reverse-search,
            // Ctrl+L clear, Ctrl+W kill-word, Ctrl+D EOF) stay with the terminal —
            // the user can use mouse/menu equivalents for those if needed.
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ChildState;
            let vk = wparam.0 as u32;
            let ctrl = (GetKeyState(VK_CONTROL_RAW as i32) as u16 & 0x8000) != 0;
            let shift = (GetKeyState(VK_SHIFT_RAW as i32) as u16 & 0x8000) != 0;
            let alt = (GetKeyState(VK_MENU_RAW as i32) as u16 & 0x8000) != 0;
            if !state_ptr.is_null() {
                if let Some((key, code)) = vk_to_ui_shortcut(vk, ctrl, alt, shift) {
                    if let (Some(app), Some(tid)) =
                        ((*state_ptr).app.as_ref(), (*state_ptr).term_id)
                    {
                        emit_key_down_preview(
                            app,
                            tid,
                            KeyDownPreview {
                                ev: KeyEventDto {
                                    code: code.to_string(),
                                    key: key.to_string(),
                                    ctrl,
                                    shift,
                                    alt,
                                    meta: false,
                                    repeat: false,
                                },
                            },
                        );
                    }
                    return LRESULT(0);
                }
            }
            // Translate non-character keys (arrows, Enter, Backspace, Esc,
            // Home/End, Delete, PgUp/PgDn, F-keys) into terminal byte sequences
            // and forward to the PTY writer. Printable keys are handled by
            // WM_CHAR instead — we return DefWindowProc for unhandled vkeys so
            // Windows can dispatch the corresponding WM_CHAR.
            let pty_id = if !state_ptr.is_null() {
                (*state_ptr).pty_id
            } else {
                None
            };
            let bytes = vk_to_bytes(vk);
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
        WM_RBUTTONDOWN => {
            // O2-B: forward right-click coords (pane-local logical px) to JS
            // so the existing GlobalContextMenu opens at the cursor. We do NOT
            // call DefWindowProc — that would let Windows synthesize WM_CONTEXTMENU,
            // which we want to suppress (the React menu is the source of truth).
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ChildState;
            if !state_ptr.is_null() {
                // LPARAM packs x in LOWORD, y in HIWORD as signed 16-bit
                // (negative on multi-monitor with the cursor above/left of
                // the primary). Sign-extend via i16 cast before widening.
                let x_px = (lparam.0 as i16) as i32;
                let y_px = ((lparam.0 >> 16) as i16) as i32;

                // R4-mouse: when xterm mouse mode is active and Shift is not
                // held, forward the right-click to the PTY and SUPPRESS the
                // `r_button` event — TUI apps (lazygit, htop) expect raw
                // button-2 reports here, and showing the React context menu
                // on top of them is confusing. Shift bypasses to keep the
                // context-menu escape hatch.
                let shift = (GetKeyState(VK_SHIFT_RAW as i32) as u16 & 0x8000) != 0;
                let ctrl = (GetKeyState(VK_CONTROL_RAW as i32) as u16 & 0x8000) != 0;
                let alt = (GetKeyState(VK_MENU_RAW as i32) as u16 & 0x8000) != 0;
                let modes = read_mouse_modes(&*state_ptr);
                if modes.clicks_enabled && !shift {
                    let (x_cell, y_cell) = px_to_cell_1based(x_px, y_px, (*state_ptr).cell_w_px, (*state_ptr).cell_h_px);
                    let fmt = mouse_format(modes);
                    if let Some(bytes) = encode_mouse_event(
                        2, x_cell, y_cell, ctrl, shift, alt, true, false, fmt,
                    ) {
                        if let Some(pid) = (*state_ptr).pty_id {
                            let _ = crate::pty::write_to_pty_sync(pid, &bytes);
                        }
                    }
                    return LRESULT(0);
                }

                let dpr = (*state_ptr).dpr.max(0.0001);
                let x = x_px as f32 / dpr;
                let y = y_px as f32 / dpr;
                if let (Some(app), Some(tid)) =
                    ((*state_ptr).app.as_ref(), (*state_ptr).term_id)
                {
                    emit_r_button(app, tid, RButton { x, y });
                }
            }
            LRESULT(0)
        }
        WM_RBUTTONUP => {
            // R4-mouse: forward right-button release when mouse mode is on.
            // No legacy behaviour to preserve — WM_RBUTTONDOWN previously
            // handled the entire context-menu interaction. Outside mouse mode
            // we just swallow the event (DefWindowProc would synthesize
            // WM_CONTEXTMENU, which we already suppressed on press).
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ChildState;
            if !state_ptr.is_null() {
                let shift = (GetKeyState(VK_SHIFT_RAW as i32) as u16 & 0x8000) != 0;
                let ctrl = (GetKeyState(VK_CONTROL_RAW as i32) as u16 & 0x8000) != 0;
                let alt = (GetKeyState(VK_MENU_RAW as i32) as u16 & 0x8000) != 0;
                let modes = read_mouse_modes(&*state_ptr);
                if modes.clicks_enabled && !shift {
                    let x_px = (lparam.0 as i16) as i32;
                    let y_px = ((lparam.0 >> 16) as i16) as i32;
                    let (x_cell, y_cell) = px_to_cell_1based(x_px, y_px, (*state_ptr).cell_w_px, (*state_ptr).cell_h_px);
                    let fmt = mouse_format(modes);
                    let btn = if fmt == MouseFormat::Sgr { 2 } else { 3 };
                    if let Some(bytes) = encode_mouse_event(
                        btn, x_cell, y_cell, ctrl, shift, alt, false, false, fmt,
                    ) {
                        if let Some(pid) = (*state_ptr).pty_id {
                            let _ = crate::pty::write_to_pty_sync(pid, &bytes);
                        }
                    }
                }
            }
            LRESULT(0)
        }
        WM_MBUTTONDOWN => {
            // R4-mouse: middle-button press. Only forwarded when mouse mode
            // is active — otherwise swallowed (paste-on-middle-click is not a
            // MADE convention and X11-style middle-paste would be surprising
            // on Windows).
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ChildState;
            if !state_ptr.is_null() {
                let shift = (GetKeyState(VK_SHIFT_RAW as i32) as u16 & 0x8000) != 0;
                let ctrl = (GetKeyState(VK_CONTROL_RAW as i32) as u16 & 0x8000) != 0;
                let alt = (GetKeyState(VK_MENU_RAW as i32) as u16 & 0x8000) != 0;
                let modes = read_mouse_modes(&*state_ptr);
                if modes.clicks_enabled && !shift {
                    let x_px = (lparam.0 as i16) as i32;
                    let y_px = ((lparam.0 >> 16) as i16) as i32;
                    let (x_cell, y_cell) = px_to_cell_1based(x_px, y_px, (*state_ptr).cell_w_px, (*state_ptr).cell_h_px);
                    let fmt = mouse_format(modes);
                    if let Some(bytes) = encode_mouse_event(
                        1, x_cell, y_cell, ctrl, shift, alt, true, false, fmt,
                    ) {
                        if let Some(pid) = (*state_ptr).pty_id {
                            let _ = crate::pty::write_to_pty_sync(pid, &bytes);
                        }
                    }
                }
            }
            LRESULT(0)
        }
        WM_MBUTTONUP => {
            // R4-mouse: middle-button release. See WM_MBUTTONDOWN comment.
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ChildState;
            if !state_ptr.is_null() {
                let shift = (GetKeyState(VK_SHIFT_RAW as i32) as u16 & 0x8000) != 0;
                let ctrl = (GetKeyState(VK_CONTROL_RAW as i32) as u16 & 0x8000) != 0;
                let alt = (GetKeyState(VK_MENU_RAW as i32) as u16 & 0x8000) != 0;
                let modes = read_mouse_modes(&*state_ptr);
                if modes.clicks_enabled && !shift {
                    let x_px = (lparam.0 as i16) as i32;
                    let y_px = ((lparam.0 >> 16) as i16) as i32;
                    let (x_cell, y_cell) = px_to_cell_1based(x_px, y_px, (*state_ptr).cell_w_px, (*state_ptr).cell_h_px);
                    let fmt = mouse_format(modes);
                    let btn = if fmt == MouseFormat::Sgr { 1 } else { 3 };
                    if let Some(bytes) = encode_mouse_event(
                        btn, x_cell, y_cell, ctrl, shift, alt, false, false, fmt,
                    ) {
                        if let Some(pid) = (*state_ptr).pty_id {
                            let _ = crate::pty::write_to_pty_sync(pid, &bytes);
                        }
                    }
                }
            }
            LRESULT(0)
        }
        WM_MOUSEMOVE => {
            // O2-B: emit `mouse_passthrough` when the cursor is within the
            // splitter edge band. The React side uses this to surface the
            // cursor to the splitter drag handler when the native pane "ate"
            // the move. Coalesce by rounded logical px to keep emit volume
            // proportional to actual cursor displacement.
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ChildState;
            if !state_ptr.is_null() {
                let x_px = (lparam.0 as i16) as i32;
                let y_px = ((lparam.0 >> 16) as i16) as i32;

                // R3: arm WM_MOUSELEAVE once per "enter". Win32 requires a
                // per-leave TrackMouseEvent call — without it WM_MOUSELEAVE
                // never fires. We re-arm on the next move after every leave.
                if !(*state_ptr).mouse_tracking {
                    let mut tme = TRACKMOUSEEVENT {
                        cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                        dwFlags: TME_LEAVE,
                        hwndTrack: hwnd,
                        dwHoverTime: 0,
                    };
                    let _ = TrackMouseEvent(&mut tme);
                    (*state_ptr).mouse_tracking = true;
                }

                // R4-mouse: forward motion / drag events to the PTY when the
                // running TUI requested them. Drag mode (1002) reports motion
                // ONLY while a button is held; any-motion mode (1003) reports
                // every move. Shift bypasses to keep cell_hover / selection
                // working as escape hatches.
                let shift = (GetKeyState(VK_SHIFT_RAW as i32) as u16 & 0x8000) != 0;
                let ctrl = (GetKeyState(VK_CONTROL_RAW as i32) as u16 & 0x8000) != 0;
                let alt = (GetKeyState(VK_MENU_RAW as i32) as u16 & 0x8000) != 0;
                let modes = read_mouse_modes(&*state_ptr);
                let mouse_mode_bypass = shift;
                let mouse_mode_active = modes.clicks_enabled && !mouse_mode_bypass;
                if mouse_mode_active {
                    // Detect which button (if any) is held — use Win32 wparam
                    // flags rather than GetKeyState so we get the same state
                    // Windows used to synthesise the move.
                    const MK_LBUTTON: usize = 0x0001;
                    const MK_RBUTTON: usize = 0x0002;
                    const MK_MBUTTON: usize = 0x0010;
                    let wflags = wparam.0;
                    let held_btn: Option<u32> = if wflags & MK_LBUTTON != 0 {
                        Some(0)
                    } else if wflags & MK_MBUTTON != 0 {
                        Some(1)
                    } else if wflags & MK_RBUTTON != 0 {
                        Some(2)
                    } else {
                        None
                    };
                    // Drag mode reports motion only while a button is held.
                    // Motion-only mode (1003) reports button code 3 + motion bit
                    // when no button is held.
                    let emit = match (modes.motion_enabled, modes.drag_enabled, held_btn) {
                        (true, _, Some(b)) => Some(b),
                        (true, _, None) => Some(3),
                        (false, true, Some(b)) => Some(b),
                        _ => None,
                    };
                    if let Some(btn) = emit {
                        let (x_cell, y_cell) = px_to_cell_1based(x_px, y_px, (*state_ptr).cell_w_px, (*state_ptr).cell_h_px);
                        // Coalesce: only emit when the cell changed. xterm
                        // mouse reports are spammy enough without sub-cell
                        // jitter — re-use last_cell_hover as the dedup key.
                        let key = (y_cell as i64, x_cell);
                        if (*state_ptr).last_cell_hover != Some(key) {
                            (*state_ptr).last_cell_hover = Some(key);
                            let fmt = mouse_format(modes);
                            if let Some(bytes) = encode_mouse_event(
                                btn, x_cell, y_cell, ctrl, shift, alt, true, true, fmt,
                            ) {
                                if let Some(pid) = (*state_ptr).pty_id {
                                    let _ = crate::pty::write_to_pty_sync(pid, &bytes);
                                }
                            }
                        }
                    }
                    // SKIP cell_hover / link_hover / selection-extend / passthrough
                    // emissions while a TUI is consuming raw mouse events — they
                    // would clutter the React side with hover effects the TUI
                    // never knows about. Re-arm TrackMouseEvent already happened
                    // above so WM_MOUSELEAVE still fires.
                    return LRESULT(0);
                }

                // R3: cell_hover. Translate physical px → cell coords using
                // the cached cell metrics, factoring display_offset so the
                // line index is in alacritty's signed space (negative when
                // hovering scrollback rows). Coalesced by (line, col).
                let cell_w_px = (*state_ptr).cell_w_px.max(0.001);
                let line_h_px = (*state_ptr).cell_h_px.max(0.001);
                let row_visible = (y_px as f32 / line_h_px).floor() as i32;
                let col_raw = (x_px as f32 / cell_w_px).floor() as i32;
                // Single brief lock: read display_offset AND the hyperlink at
                // the hovered cell so WM_MOUSEMOVE only crosses the term mutex
                // once per move. Emits happen AFTER the lock drops.
                let (display_offset, hover_uri) = if let Some(term) = (*state_ptr).term.as_ref() {
                    let t = term.lock().expect("term lock poisoned");
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
                } else {
                    (0, None)
                };
                // Visible row 0 = top of screen; line = row - display_offset.
                // When user has scrolled back N lines, row 0 maps to Line(-N).
                let line_signed = row_visible as i64 - display_offset as i64;
                let col = col_raw.max(0) as u32;
                let key = (line_signed, col);
                if (*state_ptr).last_cell_hover != Some(key) {
                    (*state_ptr).last_cell_hover = Some(key);
                    if let (Some(app), Some(tid)) =
                        ((*state_ptr).app.as_ref(), (*state_ptr).term_id)
                    {
                        emit_cell_hover(
                            app,
                            tid,
                            CellHover { line: line_signed, col },
                        );
                    }
                }
                // R3: OSC 8 hyperlink hover. Coalesce by (line, col, uri).
                // Re-emit only when the hovered URI changes (cell-to-cell
                // within the same link is a no-op). When the hovered cell
                // has NO hyperlink, we DO NOT emit a clearing event — the
                // React side clears its link UI when it sees `cell_hover`
                // arrive without a matching `link_hover` for the new cell.
                // This keeps the wire format simple (no nullable payload).
                match hover_uri {
                    Some(uri) => {
                        let link_key = (line_signed, col, uri.clone());
                        if (*state_ptr).last_link_hover.as_ref() != Some(&link_key) {
                            (*state_ptr).last_link_hover = Some(link_key);
                            if let (Some(app), Some(tid)) =
                                ((*state_ptr).app.as_ref(), (*state_ptr).term_id)
                            {
                                let dpr_l = (*state_ptr).dpr.max(0.0001);
                                let cell_w_logical = (*state_ptr).cell_w_px / dpr_l;
                                let line_h_logical = (*state_ptr).cell_h_px / dpr_l;
                                let rect = Rect {
                                    x: col as f32 * cell_w_logical,
                                    y: row_visible.max(0) as f32 * line_h_logical,
                                    width: cell_w_logical,
                                    height: line_h_logical,
                                };
                                emit_link_hover(app, tid, LinkHover { uri, rect });
                            }
                        }
                    }
                    None => {
                        // Clear coalescing key so re-entering a link cell
                        // is guaranteed to emit.
                        (*state_ptr).last_link_hover = None;
                    }
                }
                // R3-mouse: if we're mid-drag, extend the active selection.
                // Cheap: brief lock, mutate the existing Selection, invalidate.
                if (*state_ptr).lbutton_down {
                    if let Some(point) = mouse_to_point(&*state_ptr, x_px, y_px) {
                        if let Some(term) = (*state_ptr).term.as_ref() {
                            let mut t = term.lock().expect("term lock poisoned");
                            if let Some(sel) = t.selection.as_mut() {
                                sel.update(point, Side::Right);
                            }
                            drop(t);
                            let _ = InvalidateRect(hwnd, None, BOOL(0));
                        }
                    }
                }
                let (w_px, h_px) = (*state_ptr).client_px;
                let dpr = (*state_ptr).dpr.max(0.0001);
                let edge_px = (SPLITTER_EDGE_BAND_LOGICAL_PX * dpr).round() as i32;
                let near_left = x_px <= edge_px;
                let near_right = x_px >= w_px - edge_px;
                let near_top = y_px <= edge_px;
                let near_bottom = y_px >= h_px - edge_px;
                if near_left || near_right || near_top || near_bottom {
                    let x = x_px as f32 / dpr;
                    let y = y_px as f32 / dpr;
                    let key = (x.round() as i32, y.round() as i32);
                    if (*state_ptr).last_passthrough != Some(key) {
                        (*state_ptr).last_passthrough = Some(key);
                        if let (Some(app), Some(tid)) =
                            ((*state_ptr).app.as_ref(), (*state_ptr).term_id)
                        {
                            emit_mouse_passthrough(app, tid, MousePassthrough { x, y });
                        }
                    }
                } else {
                    // Reset coalescing key once we leave the band, so the next
                    // edge entry is guaranteed to emit even if it lands on the
                    // same rounded coord as the previous exit.
                    (*state_ptr).last_passthrough = None;
                }
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        WM_MOUSELEAVE => {
            // R3: emit cell_hover_end + reset coalescing state. Must re-arm
            // TrackMouseEvent on the next WM_MOUSEMOVE; clear the flag so the
            // WM_MOUSEMOVE branch knows to call it again.
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ChildState;
            if !state_ptr.is_null() {
                (*state_ptr).mouse_tracking = false;
                (*state_ptr).last_cell_hover = None;
                (*state_ptr).last_link_hover = None;
                if let (Some(app), Some(tid)) =
                    ((*state_ptr).app.as_ref(), (*state_ptr).term_id)
                {
                    emit_cell_hover_end(app, tid);
                }
            }
            LRESULT(0)
        }
        WM_IME_STARTCOMPOSITION => {
            // Suppress Windows' default IME UI by NOT forwarding to DefWindowProc.
            // The React-side popup owns the visual.
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ChildState;
            if !state_ptr.is_null() {
                if let (Some(app), Some(tid)) =
                    ((*state_ptr).app.as_ref(), (*state_ptr).term_id)
                {
                    emit_ime_composition(
                        app,
                        tid,
                        ImeComposition {
                            text: String::new(),
                            cursor: 0,
                            committed: false,
                        },
                    );
                }
            }
            LRESULT(0)
        }
        WM_IME_COMPOSITION => {
            // lparam is a bitmask of GCS_* flags telling us which composition
            // string changed. We care about GCS_COMPSTR (in-progress preedit)
            // and GCS_RESULTSTR (committed text the user just finalised).
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ChildState;
            let flags = lparam.0 as u32;
            let has_comp = (flags & GCS_COMPSTR.0) != 0;
            let has_result = (flags & GCS_RESULTSTR.0) != 0;
            if !state_ptr.is_null() && (has_comp || has_result) {
                let himc = ImmGetContext(hwnd);
                if !himc.is_invalid() {
                    if has_result {
                        let text = read_imm_string(himc, GCS_RESULTSTR);
                        if let (Some(app), Some(tid)) =
                            ((*state_ptr).app.as_ref(), (*state_ptr).term_id)
                        {
                            emit_ime_composition(
                                app,
                                tid,
                                ImeComposition {
                                    text,
                                    cursor: 0,
                                    committed: true,
                                },
                            );
                        }
                    }
                    if has_comp {
                        let text = read_imm_string(himc, GCS_COMPSTR);
                        // GCS_CURSORPOS returns the cursor position in the
                        // composition string as the LOWORD of the return value
                        // (when called with a null buffer). HIWORD is undefined
                        // for cursor pos — mask to 16 bits explicitly.
                        let cursor_raw = ImmGetCompositionStringW(
                            himc,
                            GCS_CURSORPOS,
                            None,
                            0,
                        );
                        // Negative return is an error code — clamp to 0.
                        let cursor = if cursor_raw < 0 {
                            0u32
                        } else {
                            (cursor_raw as u32) & 0xFFFF
                        };
                        if let (Some(app), Some(tid)) =
                            ((*state_ptr).app.as_ref(), (*state_ptr).term_id)
                        {
                            emit_ime_composition(
                                app,
                                tid,
                                ImeComposition {
                                    text,
                                    cursor,
                                    committed: false,
                                },
                            );
                        }
                    }
                    let _ = ImmReleaseContext(hwnd, himc);
                }
            }
            // Suppress DefWindowProc so Windows doesn't paint its own preedit
            // overlay on top of our wgpu surface.
            LRESULT(0)
        }
        WM_IME_ENDCOMPOSITION => {
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ChildState;
            if !state_ptr.is_null() {
                if let (Some(app), Some(tid)) =
                    ((*state_ptr).app.as_ref(), (*state_ptr).term_id)
                {
                    emit_ime_composition(
                        app,
                        tid,
                        ImeComposition {
                            text: String::new(),
                            cursor: 0,
                            committed: false,
                        },
                    );
                }
            }
            LRESULT(0)
        }
        WM_SETFOCUS => {
            // DECSET 1004 focus reporting: when the TUI has it enabled, emit
            // `\e[I` on every focus-in so it can re-highlight its UI. Always
            // call DefWindowProc afterwards so Windows still performs its
            // normal focus bookkeeping (caret, IME context, etc). Shift state
            // is irrelevant here — focus is not a click.
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ChildState;
            if !state_ptr.is_null() && is_focus_reporting_enabled(&*state_ptr) {
                if let Some(pid) = (*state_ptr).pty_id {
                    let _ = crate::pty::write_to_pty_sync(pid, b"\x1b[I");
                }
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        WM_KILLFOCUS => {
            // DECSET 1004 focus reporting: emit `\e[O` on focus-out. Mirror
            // WM_SETFOCUS — always DefWindowProc through so Windows can release
            // the caret / clean up IME. Note WM_CAPTURECHANGED is the place we
            // clear `lbutton_down`; we deliberately don't touch it here because
            // losing focus does NOT release mouse capture by itself.
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ChildState;
            if !state_ptr.is_null() && is_focus_reporting_enabled(&*state_ptr) {
                if let Some(pid) = (*state_ptr).pty_id {
                    let _ = crate::pty::write_to_pty_sync(pid, b"\x1b[O");
                }
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// Read a composition string (GCS_COMPSTR or GCS_RESULTSTR) from the given
/// IMM context. Two-pass: first call with a null buffer returns the required
/// byte count, second call fills the buffer. Always returns valid Rust UTF-8
/// — invalid UTF-16 surrogates are replaced via `from_utf16_lossy`.
unsafe fn read_imm_string(
    himc: windows::Win32::UI::Input::Ime::HIMC,
    index: windows::Win32::UI::Input::Ime::IME_COMPOSITION_STRING,
) -> String {
    // Pass 1: query required byte length. ImmGetCompositionStringW returns
    // bytes (not WCHARs) for COMPSTR/RESULTSTR — divide by 2 for the Vec<u16>.
    let bytes = ImmGetCompositionStringW(himc, index, None, 0);
    if bytes <= 0 {
        return String::new();
    }
    let wide_len = (bytes as usize) / 2;
    let mut buf: Vec<u16> = vec![0u16; wide_len];
    let got = ImmGetCompositionStringW(
        himc,
        index,
        Some(buf.as_mut_ptr() as *mut std::ffi::c_void),
        bytes as u32,
    );
    if got <= 0 {
        return String::new();
    }
    // got is bytes — usually equals `bytes`, but guard against truncation.
    let got_wide = (got as usize) / 2;
    String::from_utf16_lossy(&buf[..got_wide.min(wide_len)])
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

// Raw VK constants for modifier-state lookups via GetKeyState.
const VK_CONTROL_RAW: u32 = 0x11;
const VK_SHIFT_RAW: u32 = 0x10;
const VK_MENU_RAW: u32 = 0x12; // Alt

/// If the keystroke matches a React-side UI shortcut, return the
/// `(KeyboardEvent.key, KeyboardEvent.code)` pair to synthesize on the JS
/// side. Returning `Some` causes WM_KEYDOWN to skip PTY forwarding and emit
/// `key_down_preview` instead. Keep this list aligned with the Ctrl/Alt
/// shortcuts in `src/App.tsx`'s global keydown handler — items here are the
/// ones the user explicitly asked to keep working when the native pane
/// has keyboard focus.
fn vk_to_ui_shortcut(
    vk: u32,
    ctrl: bool,
    alt: bool,
    _shift: bool,
) -> Option<(&'static str, &'static str)> {
    // Ctrl combos
    if ctrl && !alt {
        match vk {
            0x4B => return Some(("k", "KeyK")), // Ctrl+K → palette
            0x42 => return Some(("b", "KeyB")), // Ctrl+B → sidebar
            0x46 => return Some(("f", "KeyF")), // Ctrl+F → search
            0xBF => return Some(("/", "Slash")), // Ctrl+/ → shortcuts
            0xBC => return Some((",", "Comma")), // Ctrl+, → settings
            _ => {}
        }
    }
    // Alt+digit (without Ctrl)
    if alt && !ctrl {
        match vk {
            0x31 => return Some(("1", "Digit1")),
            0x32 => return Some(("2", "Digit2")),
            0x33 => return Some(("3", "Digit3")),
            0x34 => return Some(("4", "Digit4")),
            0x35 => return Some(("5", "Digit5")),
            0x36 => return Some(("6", "Digit6")),
            0x37 => return Some(("7", "Digit7")),
            0x38 => return Some(("8", "Digit8")),
            0x39 => return Some(("9", "Digit9")),
            _ => {}
        }
    }
    None
}

/// Snapshot of xterm mouse-mode flags pulled from `Term::mode()` under a brief
/// lock. Computed once per mouse-handler entry so the WM_MOUSE* arms don't
/// re-acquire the Term mutex while deciding routing. See:
/// `clicks_enabled` → any of MOUSE_REPORT_CLICK (1000) / MOUSE_DRAG (1002) /
/// MOUSE_MOTION (1003); `drag_enabled` → DRAG or MOTION; `motion_enabled` →
/// MOTION only; `sgr` → SGR_MOUSE (1006); `urxvt` → URXVT_MOUSE (1015).
///
/// NOTE: alacritty_terminal 0.24.2 does NOT expose a `TermMode::URXVT_MOUSE`
/// flag — the upstream parser silently drops DECSET 1015. We keep the
/// `urxvt` field + `MouseFormat::Urxvt` encoder for forward-compat (so the
/// code path lights up the moment alacritty adds the flag), but in practice
/// `urxvt` is always `false` today and the precedence ladder falls through to
/// SGR or X10. Stubbed; see task notes.
#[derive(Clone, Copy, Default)]
struct MouseModes {
    clicks_enabled: bool,
    drag_enabled: bool,
    motion_enabled: bool,
    sgr: bool,
    urxvt: bool,
}

/// Wire-format selector for `encode_mouse_event`. Picked by `mouse_format` per
/// the precedence ladder SGR > URXVT > X10 — SGR is preferred (modern, no
/// coord limits), URXVT is the urxvt-extended fallback (decimal coords, classic
/// `\e[M` framing), X10 is the last-resort single-byte form (coords cap at 223).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MouseFormat {
    Sgr,
    Urxvt,
    X10,
}

/// Resolve the wire format to emit based on the current mode bitmask. Locked
/// precedence: SGR > URXVT > X10. Callers should snapshot once per handler
/// entry alongside `read_mouse_modes`.
fn mouse_format(modes: MouseModes) -> MouseFormat {
    if modes.sgr {
        MouseFormat::Sgr
    } else if modes.urxvt {
        MouseFormat::Urxvt
    } else {
        MouseFormat::X10
    }
}

/// Read mouse-mode flags from the attached Term under a brief lock. Returns
/// defaults (all false) when no Term is attached — the caller's mode-check
/// branches will fall through to the legacy selection/hover/scrollback paths.
unsafe fn read_mouse_modes(state: &ChildState) -> MouseModes {
    let Some(term) = state.term.as_ref() else {
        return MouseModes::default();
    };
    let t = term.lock().expect("term lock poisoned");
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
        // URXVT_MOUSE doesn't exist in alacritty_terminal 0.24.2 — see struct
        // docs. Pin to false so the precedence ladder is well-defined.
        urxvt: false,
    }
}

/// Is xterm focus-event reporting (DECSET 1004) currently enabled? Brief
/// term-mutex lock; safe to call from any wnd_proc arm. Returns false when no
/// Term is attached (no PTY → nothing to write to).
unsafe fn is_focus_reporting_enabled(state: &ChildState) -> bool {
    let Some(term) = state.term.as_ref() else {
        return false;
    };
    let t = term.lock().expect("term lock poisoned");
    let enabled = t.mode().contains(TermMode::FOCUS_IN_OUT);
    drop(t);
    enabled
}

/// Convert physical-px coords to 1-based cell (col, row) coords. Floors then
/// adds 1 so the top-left cell becomes (1, 1) — the xterm wire convention.
/// Cell metrics come from the live ChildState so font hot-swaps are reflected.
fn px_to_cell_1based(x_px: i32, y_px: i32, cell_w_px: f32, line_h_px: f32) -> (u32, u32) {
    let cell_w = cell_w_px.max(0.001);
    let line_h = line_h_px.max(0.001);
    let col = (x_px as f32 / cell_w).floor().max(0.0) as u32 + 1;
    let row = (y_px as f32 / line_h).floor().max(0.0) as u32 + 1;
    (col, row)
}

/// Encode an xterm mouse event into the bytes to send to the PTY.
///
/// `button` is the base button code:
///   * 0 = left, 1 = middle, 2 = right
///   * 3 = release marker (X10/URXVT only — SGR uses lowercase `m` instead)
///   * 64 = wheel up, 65 = wheel down
///   * (motion-without-button uses 3 + motion bit, callers add the 32)
///
/// Modifier bits (OR'd into `button`):
///   * 4 = Shift, 8 = Alt/Meta, 16 = Ctrl, 32 = motion
///
/// `press` only matters for SGR — selects `M` (press) vs `m` (release). For
/// X10 and URXVT the release event is encoded with button code 3 (caller decides).
///
/// Formats:
///   * `Sgr`   — `\e[<{b};{x};{y}{M|m}`. Modern xterm SGR (DECSET 1006). No
///                coord ceiling.
///   * `Urxvt` — `\e[{b+32};{x};{y}M`. urxvt-extended (DECSET 1015). Same
///                classic `\e[M` framing as X10 but with decimal-ASCII
///                coordinates; always uses `M` regardless of press/release
///                (release distinguished via button code 3). The `b+32`
///                offset matches the X10 button-byte encoding (urxvt kept
///                that convention).
///   * `X10`   — `\e[M` + 3 single-byte components (button+32, x+32, y+32).
///                Coords > 223 (255 - 32) are unrepresentable; we return
///                `None` rather than emit a corrupt sequence (real X10
///                limitation, harmless for typical TUIs).
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
        MouseFormat::Urxvt => {
            // urxvt-extended (1015): same b+32 button encoding as X10 but
            // coords are decimal ASCII, framed `\e[{b};{x};{y}M`. Always `M`
            // — release is signaled via the caller passing button=3.
            Some(format!("\x1b[{};{};{}M", b + 32, x_cell, y_cell).into_bytes())
        }
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

/// Translate physical mouse coords (LPARAM x/y) into an alacritty grid Point.
/// Uses the cached cell metrics (mirrored from the renderer's hardcoded font)
/// and clamps to the visible grid. Returns None if no Term is attached or the
/// grid has zero columns/rows (defensive — shouldn't happen post-attach).
///
/// Scrollback handling: the renderer currently always renders rows 0..N as
/// alacritty Line(0)..Line(N), regardless of display_offset (R2 frozen — the
/// scrollback-aware rendering pass isn't built yet). For consistency with what
/// the user actually sees, we map visible_row → Line(row). When the rendering
/// pass learns to honour display_offset, this fn must subtract it: the
/// alacritty Line for visible_row y becomes `Line(y as i32 - display_offset as i32)`.
unsafe fn mouse_to_point(state: &ChildState, x_px: i32, y_px: i32) -> Option<Point> {
    let term = state.term.as_ref()?;
    let cell_w = state.cell_w_px.max(0.001);
    let line_h = state.cell_h_px.max(0.001);
    let (cols, rows) = {
        let t = term.lock().expect("term lock poisoned");
        let grid = t.grid();
        (grid.columns(), grid.screen_lines())
    };
    if cols == 0 || rows == 0 {
        return None;
    }
    let col_raw = (x_px as f32 / cell_w).floor() as i32;
    let row_raw = (y_px as f32 / line_h).floor() as i32;
    let col = col_raw.clamp(0, (cols as i32).saturating_sub(1)) as usize;
    let row = row_raw.clamp(0, (rows as i32).saturating_sub(1));
    Some(Point::new(Line(row), Column(col)))
}

/// Copy a UTF-8 string to the Windows clipboard as CF_UNICODETEXT.
/// Allocates HGLOBAL via GlobalAlloc(GMEM_MOVEABLE), encodes UTF-16 with a
/// trailing nul, and hands ownership to the clipboard. We do NOT free the
/// HGLOBAL on success — the clipboard subsystem takes ownership and frees it
/// when the data is replaced. On error paths we don't allocate, so there's
/// nothing to free either.
unsafe fn copy_to_clipboard(owner: HWND, text: &str) -> Result<(), String> {
    if OpenClipboard(owner).is_err() {
        return Err("OpenClipboard failed".into());
    }
    // EmptyClipboard reports its outcome via SetLastError; ignoring is safe —
    // failure here just leaves the prior contents intact, and the subsequent
    // SetClipboardData will surface a more useful error.
    let _ = EmptyClipboard();

    // UTF-16 encode with trailing NUL (CF_UNICODETEXT requires nul-termination).
    let mut wide: Vec<u16> = text.encode_utf16().collect();
    wide.push(0);
    let bytes = wide.len() * std::mem::size_of::<u16>();

    let hglobal = match GlobalAlloc(GMEM_MOVEABLE, bytes) {
        Ok(h) => h,
        Err(e) => {
            let _ = CloseClipboard();
            return Err(format!("GlobalAlloc: {e}"));
        }
    };
    let locked = GlobalLock(hglobal);
    if locked.is_null() {
        let _ = CloseClipboard();
        return Err("GlobalLock returned null".into());
    }
    std::ptr::copy_nonoverlapping(wide.as_ptr(), locked as *mut u16, wide.len());
    let _ = GlobalUnlock(hglobal);

    // SetClipboardData transfers ownership of the HGLOBAL to the clipboard.
    // On success do NOT free; on failure we leak the alloc (rare, and the
    // alternative — GlobalFree on a moveable handle whose lock count just
    // hit 0 — is correct, but the failure path here is "Windows is dying"
    // territory and not worth complicating the happy path for).
    let set_result = SetClipboardData(CF_UNICODETEXT, HANDLE(hglobal.0));
    let _ = CloseClipboard();
    set_result
        .map(|_| ())
        .map_err(|e| format!("SetClipboardData: {e}"))
}

/// Parse a `#RRGGBB` or `#RRGGBBAA` hex string into a 4-byte RGBA color.
/// Missing alpha defaults to 0xFF (fully opaque). The `field` argument is used
/// only in the error message so the JS side can pinpoint which theme key was
/// malformed; we return `Result<[u8;4], String>` rather than panicking because
/// the wire format originates from JS and shouldn't be able to crash the
/// process if a user installs a hand-edited theme file.
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

/// Fold a wire-format `TerminalTheme` (hex strings) into a `ThemeColors` the
/// renderer can consume directly. Order of fields mirrors `ThemeColors`.
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
