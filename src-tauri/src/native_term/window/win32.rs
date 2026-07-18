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
use std::sync::atomic::Ordering as AtomicOrdering;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

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
use alacritty_terminal::term::cell::Flags as CellFlags;
use alacritty_terminal::term::{Term, TermMode};

use tauri::AppHandle;

use super::super::events::{
    emit_cell_hover, emit_cell_hover_end, emit_focus_gained, emit_focus_lost,
    emit_ime_composition, emit_key_down_preview, emit_link_click, emit_link_hover,
    emit_mouse_passthrough, emit_r_button, emit_resized, emit_scroll, emit_selection,
    CellHover, ImeComposition, KeyDownPreview, KeyEventDto, KeyModifiers, LinkClick,
    LinkHover, MousePassthrough, RButton, Resized, Scroll as ScrollEvt,
    Selection as SelectionEvent,
};
use super::super::parser_bridge::{ParserBridge, RenderWake, TermDims, TermListener};
use super::super::renderer::pipeline::RenderOutcome;
use super::super::renderer::ThemeColors;
use super::super::pty_route;
use super::super::region;
use super::{DebugStats, NativeTermWindow, Rect, TerminalTheme};

/// CF_UNICODETEXT clipboard format id. Hardcoded because the windows-rs
/// constant lives behind a different feature gate; this is a stable Win32 value.
const CF_UNICODETEXT: u32 = 13;

/// Pre-renderer PLACEHOLDER per-cell metrics (Hack 14px approximation at
/// dpr 1.0). Only used to seed ChildState between CreateWindowExW and
/// Renderer construction — `PlatformWindow::new` overwrites both mirrors
/// from `Renderer::cell_metrics()` (the single source of truth: the
/// measured, P5a dpr-scaled `GlyphStack::cell_advance_px / line_height_px`)
/// as soon as the renderer exists; `set_font` and the `prepare_move`
/// dpr-change path refresh them on every hot-swap. Values match the
/// `glyph_atlas::measure_cell_advance` fallback (14*0.6 ≈ 8.4) and
/// `(14*1.2).ceil() = 17`.
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

// Timer id 1 was the retired R1.c 16ms continuous-repaint pump (RENDER_TIMER_ID),
// deleted in P3b — the event-driven WM_APP_RENDER wake + the 500ms watchdog
// below replace it. Do NOT reuse id 1 without auditing for stale-timer
// interactions in older builds.

/// P2a cursor-blink timer id. Armed by `update_blink_timer` ONLY when the
/// renderer wants ticks (focused + blink enabled + Term attached) and the
/// window is visible; killed (with the phase pinned visible) otherwise. The
/// WM_TIMER arm flips the renderer's blink phase each tick.
const BLINK_TIMER_ID: usize = 2;
/// Cursor blink half-period (ms). xterm uses ~530ms on/off; matched so the
/// blink cadence feels native.
const BLINK_HALF_PERIOD_MS: u32 = 530;

/// P3b watchdog timer id. Armed @500ms in `attach_pty`, killed in
/// `detach_pty` and at the top of `destroy()`. Each tick compares the
/// wake's `batches` counter against `ChildState.last_seen_batches`; a
/// mismatch means PTY batches landed since the last check — repaint.
/// Safety net for the event-driven scheduler: converts any missed-wake bug
/// into a <=500ms hiccup instead of a frozen pane. Cheap when idle (counter
/// unchanged → no-op) and when the wake already painted (the renderer's
/// clean-frame early-out makes the extra invalidation nearly free).
const WATCHDOG_TIMER_ID: usize = 3;
const WATCHDOG_INTERVAL_MS: u32 = 500;

/// P3b event-driven render wake. Posted by the parser worker thread via
/// `RenderWake::notify` (PostMessageW — the documented thread-safe
/// cross-thread wake) after each byte batch mutates the Term. The paired
/// `RenderWake::pending` AtomicBool bounds the queue to ONE in-flight
/// message; the wnd_proc arm clears `pending` BEFORE invalidating so a
/// batch landing mid-paint posts a fresh wake (no lost-wake window).
/// `pub(crate)` + re-exported through `window/mod.rs` for the worker side.
pub(crate) const WM_APP_RENDER: u32 = WM_APP + 1;

/// P7b keyboard-focus request, posted by `focus_keyboard` (the
/// `native_term_focus_keyboard` command). SetFocus is only valid when the
/// calling thread owns the HWND — a Tauri command context can't guarantee
/// that, so the command POSTS this message and the wnd_proc arm calls
/// SetFocus thread-correctly. The arm mirrors WM_LBUTTONDOWN's
/// click-to-focus SetFocus: keyboard focus moves WITHOUT activation
/// (WS_EX_NOACTIVATE + MA_NOACTIVATE stay in charge of that), and the
/// resulting WM_SETFOCUS emits `focus_gained` exactly like a click.
const WM_APP_FOCUS: u32 = WM_APP + 2;

/// P1b resize-settle timer id. Armed (re-armed) on every WM_SIZE; because
/// SetTimer with the same id RESETS the countdown, the timer only fires once
/// the resize has been quiet for `RESIZE_SETTLE_MS`. The WM_TIMER arm kills
/// it (one-shot semantics) and then commits the settled dimensions via
/// `commit_dims`.
const RESIZE_SETTLE_TIMER_ID: usize = 4;
const RESIZE_SETTLE_MS: u32 = 150;

/// Surface-loss retry timer id. One-shot: armed via `render_with_retry`
/// (the WM_PAINT arm and the P4a WM_SIZE synchronous repaint) whenever
/// `render()` did NOT present (SurfaceError::Lost/Outdated reconfigure-and-
/// skip, or a hard render error). Pre-P3b the 16ms pump guaranteed the "next
/// WM_PAINT redraws" after a surface loss; with the pump gone an idle pane
/// would otherwise display a stale/garbage frame until the next wake/watchdog
/// activity. The WM_TIMER arm kills the timer and invalidates — if the
/// surface is still lost, the paint arm re-arms, giving a paced ~16ms retry
/// loop (the old pump cadence) instead of an Invalidate busy-spin.
const SURFACE_RETRY_TIMER_ID: usize = 5;
const SURFACE_RETRY_MS: u32 = 16;

/// P6a: coalesce window for LOCAL scrollback `scroll` emits (WM_MOUSEWHEEL +
/// the snap-to-bottom typing path). Matches the parser worker's 50ms
/// SCROLL_COALESCE_MS so the two emitters share one cadence on the JS bus —
/// keep them in sync (the parser-side constant is locked; change neither
/// independently).
const SCROLL_EMIT_COALESCE_MS: u128 = 50;

/// P6a trailing-edge flush for the coalesced local `scroll` emit. One-shot:
/// armed by `emit_scroll_coalesced` whenever the 50ms window SUPPRESSES an
/// emit — without it, the final notch of a fast wheel flick would be
/// swallowed and (with a quiet PTY — no parser-side emits) JS would keep a
/// stale viewportY forever, hiding the jump-to-bottom button while the pane
/// sits scrolled back. The WM_TIMER arm kills the timer, re-reads the LIVE
/// offset, and re-runs the coalesced emit (by then the window has elapsed;
/// an offset that bounced back to the last-emitted value dedups to nothing).
/// 60ms = just past the coalesce window.
const SCROLL_EMIT_FLUSH_TIMER_ID: usize = 6;
const SCROLL_EMIT_FLUSH_MS: u32 = 60;

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
    /// P2a: JS-authoritative focus flag, mirrored from `set_focused` so the
    /// wnd_proc's BLINK arm can guard against a stale WM_TIMER that was
    /// already posted when focus was lost (timer killed, message in flight).
    focused: bool,
    /// P3b: shared render-wake handle for the event-driven scheduler.
    /// Created per-attach in `attach_pty` (hwnd pre-set), a clone goes to
    /// the DETACHED parser worker; this copy serves the wnd_proc
    /// WM_APP_RENDER arm (pending-clear), the watchdog (batches compare)
    /// and `debug_stats` (wake counters). The hwnd inside is zeroed on
    /// detach/destroy BEFORE the bridge drop so the outliving worker can
    /// never post to a dead window.
    wake: Option<Arc<RenderWake>>,
    /// P3b watchdog bookkeeping: `wake.batches` value at the last watchdog
    /// tick. Reset to 0 whenever a new wake is installed (fresh wake starts
    /// its counter at 0).
    last_seen_batches: u64,
    /// P6a: display_offset of the most recent LOCAL `scroll` emit (wheel /
    /// snap-to-bottom). Emit-side dedup — unchanged offset never re-emits.
    /// Independent of the parser worker's own coalescer state by design;
    /// the payloads are idempotent so double emission is harmless.
    last_scroll_emitted_offset: Option<usize>,
    /// P6a: timestamp of the most recent local `scroll` emit, for the 50ms
    /// coalesce window (`SCROLL_EMIT_COALESCE_MS`). `None` = never emitted,
    /// so the first emit always passes.
    last_scroll_emit: Option<Instant>,
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
    /// Shared LOGICAL-px per-cell metrics `(cell_w, line_h)` consumed by the
    /// parser-bridge worker for its cursor-event pixel math. Same unit the
    /// worker always used (ChildState physical mirrors ÷ dpr) — this is
    /// plumbing, not a unit change. A clone is handed to
    /// `ParserBridge::spawn` on attach; `set_font` updates the pair right
    /// after refreshing the ChildState mirrors so the worker picks the new
    /// metrics up on its next batch.
    cursor_metrics: Arc<Mutex<(f32, f32)>>,
    /// P7a: CreateOpts.scrollback (max scrollback history in lines).
    /// Recorded via `set_scrollback` right after create; consumed by
    /// `attach_pty`, which hands it to `ParserBridge::spawn` →
    /// alacritty's `Config::scrolling_history`. Defaults to 10_000 (the
    /// alacritty default) so a create path that never sets it keeps the
    /// pre-P7a behavior.
    scrollback: u32,
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
                focused: false,
                wake: None,
                last_seen_batches: 0,
                last_scroll_emitted_offset: None,
                last_scroll_emit: None,
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

            // P5a: Renderer::new takes the dpr so the very first glyph
            // metrics are already physical-px scaled + advance-quantized —
            // no separate set_scale seeding step (set_scale is now a no-op
            // on an unchanged dpr and a full font re-derivation otherwise).
            let renderer = super::super::renderer::Renderer::new(
                rwh,
                rdh,
                w.max(1) as u32,
                h.max(1) as u32,
                dpr,
            )
            .map_err(|e| {
                // Roll back the window we just created.
                let _ = DestroyWindow(hwnd);
                drop(Box::from_raw(state));
                format!("Renderer::new: {e}")
            })?;

            (*state).renderer = Some(renderer);

            // P1a metrics unification: refresh the ChildState mirrors from
            // the renderer's freshly-measured metrics NOW, not just in
            // set_font — otherwise a pane whose set_font call short-circuits
            // (or never arrives) runs its whole life on the 8.4/17
            // placeholder consts while the renderer draws with the real
            // measured advance/line-height.
            if let Some(r) = (*state).renderer.as_ref() {
                let (cw, ch) = r.cell_metrics();
                (*state).cell_w_px = cw.max(0.001);
                (*state).cell_h_px = ch.max(0.001);
            }

            // Bring the child HWND above the WebView2 child in the parent's
            // child-window Z-order. Without this, WebView2 (also a WS_CHILD
            // of the main window) renders on top and our wgpu output is fully
            // occluded — observed during the first live spike run.
            // SWP_NOACTIVATE keeps keyboard focus on the React UI; SWP_NOMOVE
            // | SWP_NOSIZE preserves the geometry we just set.
            let _ = bring_above_siblings(hwnd);

            // Force the first paint.
            let _ = InvalidateRect(hwnd, None, BOOL(0));

            // Seed the shared parser-bridge metrics with the current
            // LOGICAL values (physical mirrors ÷ dpr) — attach_pty re-primes
            // the pair with the same formula before spawning the worker.
            let dpr_div = dpr.max(0.0001);
            let cursor_metrics = Arc::new(Mutex::new((
                (*state).cell_w_px / dpr_div,
                (*state).cell_h_px / dpr_div,
            )));

            Ok(PlatformWindow {
                hwnd,
                last_dpr: dpr,
                parser_bridge: None,
                attached_pty_id: None,
                term_id: None,
                cursor_metrics,
                scrollback: 10_000,
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

    /// P7a: record CreateOpts.scrollback. Called by `native_term_create`
    /// before any PTY attaches; `attach_pty` reads it when spawning the
    /// parser bridge (the Term's scrolling_history is fixed at spawn — a
    /// later change would need a detach/re-attach, which no caller does).
    pub fn set_scrollback(&mut self, lines: u32) {
        self.scrollback = lines;
    }

    /// P4a/D3: pre-move bookkeeping shared by `resize` (plain SetWindowPos)
    /// and `resize_deferred` (DeferWindowPos batch). Stores the dpr on the
    /// outer struct + the ChildState mirror, refreshes the renderer's scale,
    /// and returns the physical target rect. The MOVE itself is the caller's
    /// job; the surface reconfigure + D1 synchronous repaint happen in
    /// WM_SIZE when the move actually lands.
    fn prepare_move(&mut self, rect: Rect, dpr: f32) -> (i32, i32, i32, i32) {
        unsafe {
            // P5a: detect a REAL dpr change (monitor swap / zoom) before
            // overwriting last_dpr — a change means the physical glyph
            // metrics are about to be re-derived and every metric consumer
            // must be refreshed below.
            let dpr_changed = dpr != self.last_dpr;
            self.last_dpr = dpr;
            // Mirror dpr into ChildState so the wnd_proc edge-band /
            // RButton / passthrough math uses the up-to-date scale even when
            // WM_SIZE doesn't carry DPR info.
            let state = self.state.as_mut();
            state.dpr = dpr;
            // Keep the renderer's dpr in sync. Safe to call unconditionally:
            // set_scale no-ops on an unchanged dpr and only re-derives the
            // scaled font (physical rasterization + advance quantization +
            // row-buffer rebuild + full damage + force_render) on a change.
            if let Some(r) = state.renderer.as_mut() {
                r.set_scale(dpr);
            }
            if dpr_changed {
                // P5a dpr-change fan-out, mirroring the set_font flow:
                // 1) refresh the ChildState PHYSICAL metric mirrors from the
                //    re-derived renderer metrics (mouse/hit-test math);
                if let Some(r) = state.renderer.as_ref() {
                    let (cw, ch) = r.cell_metrics();
                    state.cell_w_px = cw.max(0.001);
                    state.cell_h_px = ch.max(0.001);
                }
                // 2) re-prime the parser-bridge's shared LOGICAL pair
                //    (physical mirrors ÷ dpr — same formula as attach_pty /
                //    set_font) for the worker's cursor-event pixel math;
                let dpr_div = dpr.max(0.0001);
                if let Ok(mut m) = self.cursor_metrics.lock() {
                    *m = (state.cell_w_px / dpr_div, state.cell_h_px / dpr_div);
                }
                // 3) commit dims — the same client rect holds a different
                //    grid when the cell size changed (Term::resize →
                //    resize_grid → resize_pty_sync → `resized` emit; no-ops
                //    when detached or unchanged);
                commit_dims(state, self.hwnd);
                // 4) repaint even if the grid dims happened to stay equal —
                //    the glyphs themselves changed size. (The move that
                //    usually accompanies a dpr change repaints synchronously
                //    in WM_SIZE, but an equal-pixel-size move skips WM_SIZE.)
                let _ = InvalidateRect(self.hwnd, None, BOOL(0));
            }
        }
        logical_rect_to_physical(rect, dpr)
    }
}

/// P4a/D3: open a DeferWindowPos transaction sized for `count` window moves.
/// Returns the HDWP as an isize (0 on failure — callers fall back to plain
/// per-window `resize`). Exposed cross-platform through
/// `window::begin_move_batch`.
pub(crate) fn begin_move_batch(count: usize) -> isize {
    unsafe {
        BeginDeferWindowPos(count as i32)
            .map(|hdwp| hdwp.0 as isize)
            .unwrap_or(0)
    }
}

/// P4a/D3: commit a move batch. Every deferred move applies atomically in
/// ONE EndDeferWindowPos transaction — panes flanking a splitter reposition
/// together with no transient gap/overlap shear. Each moved window receives
/// its WM_WINDOWPOSCHANGED → WM_SIZE (surface reconfigure + D1 synchronous
/// repaint) INSIDE this call, on the calling (owning) thread. `batch == 0`
/// (no transaction — begin failed or everything already applied immediately)
/// is a no-op Ok.
pub(crate) fn end_move_batch(batch: isize) -> Result<(), String> {
    if batch == 0 {
        return Ok(());
    }
    unsafe {
        EndDeferWindowPos(HDWP(batch as *mut _))
            .map_err(|e| format!("EndDeferWindowPos: {e}"))
    }
}

impl NativeTermWindow for PlatformWindow {
    fn resize(&mut self, rect: Rect, dpr: f32) -> Result<(), String> {
        // P4a: bookkeeping split into `prepare_move` so `resize_deferred`
        // shares it. The singular resize path deliberately stays plain
        // SetWindowPos (no single-entry defer batch) — one window can't
        // shear against itself, and the HDWP round-trip would buy nothing.
        let (x, y, w, h) = self.prepare_move(rect, dpr);
        unsafe {
            SetWindowPos(
                self.hwnd,
                HWND::default(),
                x, y, w, h,
                // P4a/D2: SWP_NOCOPYBITS stops Windows blitting the OLD
                // client pixels into the new rect (the drag smear). The D1
                // synchronous repaint in WM_SIZE draws real content in the
                // same pump turn, so nothing stale is ever composited.
                SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOCOPYBITS,
            )
            .map_err(|e| format!("SetWindowPos: {e}"))?;
            // WM_SIZE fires inside SetWindowPos: the subclass reconfigures
            // the surface AND presents a fresh frame synchronously (D1).
            Ok(())
        }
    }

    fn resize_deferred(&mut self, rect: Rect, dpr: f32, batch: isize) -> Result<isize, String> {
        // P4a/D3: same bookkeeping as `resize`, but the window move is
        // DEFERRED into the caller's DeferWindowPos transaction so all
        // panes in a frame_sync batch reposition atomically at
        // EndDeferWindowPos. `batch == 0` means "no active transaction" —
        // apply immediately.
        let (x, y, w, h) = self.prepare_move(rect, dpr);
        unsafe {
            if batch != 0 {
                match DeferWindowPos(
                    HDWP(batch as *mut _),
                    self.hwnd,
                    HWND::default(),
                    x, y, w, h,
                    SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOCOPYBITS,
                ) {
                    // Success: hand back the (possibly reallocated) handle.
                    Ok(next) if !next.0.is_null() => return Ok(next.0 as isize),
                    // Failure (Err, or a paranoid null-Ok): per the Win32
                    // contract the HDWP is now INVALID — abandoned, never to
                    // be passed to DeferWindowPos or EndDeferWindowPos
                    // again. Fall through and apply THIS move immediately.
                    // Ok(0) marks the batch dead so the caller's remaining
                    // moves flip to the immediate path; if the SetWindowPos
                    // below ALSO fails we return Err and the caller must
                    // STILL treat its handle as dead (frame_sync zeroes its
                    // batch on Err before continuing).
                    _ => {}
                }
            }
            SetWindowPos(
                self.hwnd,
                HWND::default(),
                x, y, w, h,
                SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOCOPYBITS,
            )
            .map_err(|e| format!("SetWindowPos: {e}"))?;
        }
        Ok(0)
    }

    fn show(&mut self) -> Result<(), String> {
        unsafe {
            let _ = ShowWindow(self.hwnd, SW_SHOW);
            // Re-assert Z-order on every show — Workspace tab switches will
            // call hide/show, and Windows may have re-stacked siblings
            // (e.g. WebView2 popups, IME windows) while we were hidden.
            let _ = bring_above_siblings(self.hwnd);
            // P3a: force the first frame after SW_SHOW. While hidden, the
            // pane's WM_PAINTs may have taken the clean-frame early-out, and
            // the swapchain's retained buffer can be stale — pair an explicit
            // force with an InvalidateRect so WM_PAINT fires AND renders.
            if let Some(r) = self.state.as_mut().renderer.as_mut() {
                r.force_next_frame();
            }
            let _ = InvalidateRect(self.hwnd, None, BOOL(0));
            // P2a: the blink timer is gated on visibility — re-evaluate now
            // that the window is showing again.
            update_blink_timer(self.state.as_mut(), self.hwnd);
        }
        Ok(())
    }

    fn hide(&mut self) -> Result<(), String> {
        unsafe {
            let _ = ShowWindow(self.hwnd, SW_HIDE);
            // P2a: hidden panes never need blink ticks — kills the timer
            // (visibility gate) + pins the phase visible.
            update_blink_timer(self.state.as_mut(), self.hwnd);
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
        // Kill the timers before tearing down anything else so a pending
        // WM_TIMER can't fire mid-destroy and touch a freed state
        // (KillTimer-before-free rule).
        unsafe {
            let _ = KillTimer(self.hwnd, WATCHDOG_TIMER_ID);
            let _ = KillTimer(self.hwnd, BLINK_TIMER_ID);
            let _ = KillTimer(self.hwnd, RESIZE_SETTLE_TIMER_ID);
            let _ = KillTimer(self.hwnd, SURFACE_RETRY_TIMER_ID);
            let _ = KillTimer(self.hwnd, SCROLL_EMIT_FLUSH_TIMER_ID);
        }
        // P3b: zero the wake's HWND BEFORE the bridge drop / DestroyWindow /
        // state free. The parser worker is DETACHED (drop below does not
        // join) and holds its own Arc<RenderWake> — a zeroed hwnd makes any
        // post-teardown notify a no-op instead of a PostMessageW to a
        // destroyed (or recycled) window.
        unsafe {
            if let Some(w) = self.state.as_mut().wake.take() {
                w.hwnd.store(0, AtomicOrdering::Release);
            }
        }
        // Tear down PTY routing first so the parser worker exits cleanly
        // before we drop anything else.
        if let Some(pty_id) = self.attached_pty_id.take() {
            pty_route::unlink(pty_id);
        }
        if let Some(term_id) = self.term_id.take() {
            pty_route::close_channel(term_id);
        }
        // Drop the ParserBridge handle. The worker thread is detached — it
        // exits on its own once the channel Sender (closed above) drains.
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
        // Prime the shared pair with the same values the bridge previously
        // received by value, then hand it a clone — the worker re-reads the
        // pair per batch so later set_font swaps propagate live.
        if let Ok(mut m) = self.cursor_metrics.lock() {
            *m = (cell_w_logical, line_h_logical);
        }
        let app_for_bridge = unsafe { self.state.as_ref().app.clone() };
        // P3b event-driven wake: created with the HWND pre-set so the very
        // first parsed batch can post. One clone rides with the detached
        // worker; the ChildState copy serves the WM_APP_RENDER arm, the
        // watchdog and debug_stats. Per-attach lifetime — detach/destroy
        // zero the hwnd, and a re-attach builds a FRESH wake (counters and
        // pending state start clean).
        let wake = Arc::new(RenderWake::new(self.hwnd.0 as isize));
        let bridge = ParserBridge::spawn(
            term_id,
            cols,
            rows,
            self.scrollback as usize,
            rx,
            Arc::clone(&self.cursor_metrics),
            Arc::clone(&wake),
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
            // P3b: install the wake + reset the watchdog baseline (a fresh
            // wake's batch counter starts at 0).
            state.wake = Some(wake);
            state.last_seen_batches = 0;
        }

        self.parser_bridge = Some(bridge);
        self.attached_pty_id = Some(pty_id);
        self.term_id = Some(term_id);

        // P3b frame scheduling: force the first frame now; every subsequent
        // repaint is event-driven — the parser worker posts WM_APP_RENDER
        // per batch (bounded to one in-flight by RenderWake.pending) and the
        // 500ms watchdog below converts any missed wake into a short hiccup.
        // This replaces the R1.c 16ms continuous-repaint pump (deleted).
        unsafe {
            let _ = InvalidateRect(self.hwnd, None, BOOL(0));
            SetTimer(self.hwnd, WATCHDOG_TIMER_ID, WATCHDOG_INTERVAL_MS, None);
        }

        // P1b: commit dimensions once at attach. No-op when the JS-proposed
        // cols/rows already match the live client rect ÷ cell metrics;
        // synchronously corrects any drift (alacritty grid + renderer
        // CellGrid + PTY + `resized` event) when they do not.
        unsafe {
            commit_dims(self.state.as_mut(), self.hwnd);
        }

        // P2a: a Term is now attached — a focused pane with blink enabled
        // starts ticking immediately.
        unsafe {
            update_blink_timer(self.state.as_mut(), self.hwnd);
        }

        Ok(())
    }

    fn detach_pty(&mut self) -> Result<(), String> {
        unsafe {
            let _ = KillTimer(self.hwnd, RESIZE_SETTLE_TIMER_ID);
            let _ = KillTimer(self.hwnd, WATCHDOG_TIMER_ID);
            // P6a: a pending trailing-flush tick after detach would find no
            // Term and no-op, but kill it anyway — detached panes should own
            // zero live timers besides blink (handled below).
            let _ = KillTimer(self.hwnd, SCROLL_EMIT_FLUSH_TIMER_ID);
        }
        // P3b: zero the wake's HWND BEFORE dropping the bridge. The worker
        // is detached and keeps its own Arc<RenderWake> — zeroing here makes
        // any notify from a still-draining batch a no-op. A stale
        // WM_APP_RENDER already in the queue is harmless: the arm just
        // invalidates and the renderer takes the clean-frame early-out.
        unsafe {
            let state = self.state.as_mut();
            if let Some(w) = state.wake.take() {
                w.hwnd.store(0, AtomicOrdering::Release);
            }
            state.last_seen_batches = 0;
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
            // D-review: drop the P6a local scroll-emit dedup state so a
            // re-attach on this pane starts clean — the new Term begins at
            // offset 0, and a stale cached offset from the OLD term could
            // swallow the first wheel emit that happens to land on it.
            state.last_scroll_emitted_offset = None;
            state.last_scroll_emit = None;
            // P2a: no Term → no blink ticks (wants_blink_ticks goes false);
            // this kills the BLINK timer + pins the phase visible.
            update_blink_timer(state, self.hwnd);
            let _ = InvalidateRect(self.hwnd, None, BOOL(0));
        }
        Ok(())
    }

    fn propose_dimensions(&self, width_px: u32, height_px: u32) -> (u32, u32) {
        // Contract: width_px/height_px arrive in LOGICAL CSS px (the JS
        // rectOf convention — same space as the create/resize rects).
        // Convert to physical with the same dpr `logical_rect_to_physical`
        // uses, then divide by the renderer-measured PHYSICAL cell metrics
        // mirrored on ChildState. We cap cols at minimum 20 per the plan's
        // narrow-pane guard rather than returning an error — the JS side
        // treats this as a soft floor.
        let dpr = self.last_dpr.max(0.0001);
        let (cell_w, cell_h) = unsafe {
            let s = self.state.as_ref();
            (s.cell_w_px.max(0.001), s.cell_h_px.max(0.001))
        };
        let cols = ((width_px as f32 * dpr / cell_w).floor() as u32).clamp(20, 4096);
        let rows = ((height_px as f32 * dpr / cell_h).floor() as u32).clamp(1, 4096);
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
                // Propagate to the parser-bridge's shared LOGICAL pair
                // (mirrors ÷ dpr — same formula as attach_pty) so the
                // worker's cursor-event math tracks the new font on its
                // next batch.
                let dpr = self.last_dpr.max(0.0001);
                if let Ok(mut m) = self.cursor_metrics.lock() {
                    *m = (state.cell_w_px / dpr, state.cell_h_px / dpr);
                }
            }
            // P1d: a font swap changes the cell metrics, so the same client
            // rect now holds a different grid — re-propose dims through the
            // whole chain (Term::resize → renderer resize_grid →
            // resize_pty_sync → `resized` emit). Safe to call directly:
            // native_term commands run on the wnd_proc's (main) thread, and
            // commit_dims itself guards the detached / zero-size cases and
            // no-ops when the grid already matches.
            commit_dims(state, self.hwnd);
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
            // P2a: the blink setting may have flipped — re-evaluate the
            // BLINK timer (arms when focused + blink + attached + visible,
            // kills + pins the phase visible otherwise).
            update_blink_timer(state, self.hwnd);
            let _ = InvalidateRect(self.hwnd, None, BOOL(0));
        }
        Ok(())
    }

    fn set_focused(&mut self, focused: bool) -> Result<(), String> {
        // P2a: JS-authoritative focus flag. Only the focused pane blinks its
        // cursor; unfocused panes render a static hollow outline. Store the
        // flag (ChildState mirror + renderer), re-evaluate the BLINK timer,
        // and repaint so the cursor swaps solid/hollow immediately.
        unsafe {
            let state = self.state.as_mut();
            state.focused = focused;
            if let Some(r) = state.renderer.as_mut() {
                r.set_focused(focused);
            }
            update_blink_timer(state, self.hwnd);
            let _ = InvalidateRect(self.hwnd, None, BOOL(0));
        }
        Ok(())
    }

    fn focus_keyboard(&mut self) -> Result<(), String> {
        // P7b: keyboard-focus request from JS (active-pane parity with the
        // xterm pane's term.focus()). SetFocus is thread-sensitive, so post
        // WM_APP_FOCUS and let the wnd_proc call it on the owning thread.
        // Fire-and-forget: delivery is confirmed by the WM_SETFOCUS →
        // `focus_gained` round-trip, same as the click-to-focus path.
        unsafe {
            PostMessageW(self.hwnd, WM_APP_FOCUS, WPARAM(0), LPARAM(0))
                .map_err(|e| format!("PostMessageW(WM_APP_FOCUS): {e}"))
        }
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

    fn cell_metrics(&self) -> (f32, f32) {
        // P1a: live per-pane metrics — the ChildState mirrors, refreshed
        // from `Renderer::cell_metrics()` at construction, on every
        // set_font, and on every dpr change (prepare_move). PHYSICAL
        // surface px — P5a scales the font by dpr and quantizes the
        // advance, so these are no longer numerically equal to logical.
        unsafe {
            let s = self.state.as_ref();
            (s.cell_w_px, s.cell_h_px)
        }
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

    fn request_redraw(&mut self) -> Result<(), String> {
        // P3b: explicit invalidation hook for Term mutations performed
        // OUTSIDE the PlatformWindow (the mod.rs scroll_to_bottom /
        // scroll_to_line / clear / reset handlers lock the Term Arc
        // directly). The renderer detects what actually changed on the next
        // WM_PAINT — display_offset via the FrameSnapshot, row content via
        // sync_from_term's damage bitset — so an invalidation with nothing
        // changed takes the clean-frame early-out.
        unsafe {
            let _ = InvalidateRect(self.hwnd, None, BOOL(0));
        }
        Ok(())
    }

    fn emit_scroll_state(&mut self) -> Result<(), String> {
        // D-review: command-driven viewport changes (scroll_to_bottom /
        // scroll_to_line) must reach the JS bus — the parser worker only
        // emits `scroll` on byte arrival, so on a quiet PTY the
        // jump-to-bottom button state would go permanently stale after a
        // command scroll. Read the LIVE offset under a brief Term lock
        // (we're inside the registry closure here: registry → term is the
        // allowed lock order, same as attach_pty → commit_dims), then
        // funnel through emit_scroll_coalesced so ChildState's
        // last_scroll_emitted_offset dedup cache stays coherent with what
        // JS last saw (a plain emit_scroll here would desync it).
        let term = unsafe {
            match self.state.as_ref().term.as_ref() {
                Some(t) => Arc::clone(t),
                None => return Ok(()),
            }
        };
        let (offset_now, history) = {
            let t = term.lock().map_err(|_| "term mutex poisoned".to_string())?;
            let grid = t.grid();
            (grid.display_offset(), grid.history_size() as i64)
        }; // Term lock released before the emit below.
        unsafe {
            emit_scroll_coalesced(self.state.as_mut(), self.hwnd, offset_now, history);
        }
        Ok(())
    }

    fn debug_stats(&self) -> DebugStats {
        // P0 perf instrumentation: read-only snapshot. Renderer counters are
        // reached through the ChildState pointer (same-thread access, like
        // every other accessor); `visible` is queried from Win32 directly so
        // ShowWindow-driven hide/show is reflected without extra mirroring.
        unsafe {
            let state = self.state.as_ref();
            let mut out = DebugStats::default();
            if let Some(r) = state.renderer.as_ref() {
                out.frames_rendered = r.frames_rendered;
                out.frames_skipped_clean = r.frames_skipped_clean;
                out.last_frame_cpu_ms = r.last_frame_cpu_ms;
                out.frame_cpu_ms_ewma = r.frame_cpu_ms_ewma;
                out.configures = r.configures;
                let (sw, sh) = r.surface_size();
                out.surface_w = sw;
                out.surface_h = sh;
            }
            // P3b: the wake counters are the RenderWake atomics (shared with
            // the detached parser worker) — they never lived on the
            // Renderer. Zeros when no PTY is attached (no wake installed).
            if let Some(w) = state.wake.as_ref() {
                out.wakes_posted = w.wakes_posted.load(AtomicOrdering::Relaxed);
                out.wakes_coalesced = w.wakes_coalesced.load(AtomicOrdering::Relaxed);
            }
            out.attached = self.parser_bridge.is_some();
            out.visible = IsWindowVisible(self.hwnd).as_bool();
            out.cell_w_px = state.cell_w_px;
            out.cell_h_px = state.cell_h_px;
            out.dpr = state.dpr;
            out
        }
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

/// P4a/D1: run `render()` and — when the frame did NOT present
/// (SurfaceError::Lost/Outdated reconfigure-and-skip, or a hard render
/// error) — arm the one-shot SURFACE_RETRY timer for a paced ~16ms retry.
/// Presented and SkippedClean frames need nothing (the flip-model swapchain
/// holds a valid buffer). Shared by the WM_PAINT arm and the WM_SIZE
/// synchronous repaint so the retry-pacing semantics stay identical in both
/// paths.
unsafe fn render_with_retry(state: &mut ChildState, hwnd: HWND) {
    if let Some(r) = state.renderer.as_mut() {
        let outcome = r.render();
        let presented_or_clean = matches!(
            outcome,
            Ok(RenderOutcome::Presented | RenderOutcome::SkippedClean)
        );
        if !presented_or_clean {
            SetTimer(hwnd, SURFACE_RETRY_TIMER_ID, SURFACE_RETRY_MS, None);
        }
    }
}

/// P2a: single decision point for the cursor-blink timer. Arms the BLINK
/// timer when the renderer wants ticks (focused + cursor_blink + Term
/// attached) AND a Term is attached AND the window is visible; otherwise
/// kills it and pins the blink phase visible so an unfocused/hidden pane can
/// never strand its cursor in the hidden half-phase (the unfocused hollow
/// outline ignores phase anyway — pinning is belt-and-suspenders for the
/// next focus gain). Called from set_focused / set_cursor_style / attach_pty
/// / detach_pty / show / hide; SetTimer with the same id just resets the
/// countdown, so re-arming is idempotent.
unsafe fn update_blink_timer(state: &mut ChildState, hwnd: HWND) {
    let attached = state.term.is_some();
    let visible = IsWindowVisible(hwnd).as_bool();
    let wants = state
        .renderer
        .as_ref()
        .map_or(false, |r| r.wants_blink_ticks());
    if wants && attached && visible {
        SetTimer(hwnd, BLINK_TIMER_ID, BLINK_HALF_PERIOD_MS, None);
    } else {
        let _ = KillTimer(hwnd, BLINK_TIMER_ID);
        if let Some(r) = state.renderer.as_mut() {
            r.reset_blink_visible();
        }
    }
}

/// P6a: coalesced LOCAL-scrollback `scroll` emit, shared by the
/// WM_MOUSEWHEEL arm and the snap-to-bottom typing path. Same payload shape
/// + space as the parser worker's emit: viewport_y = -display_offset (0 =
/// pinned to the live bottom, negative while scrolled into history),
/// base_y = -history. Needed because the parser only emits on byte arrival
/// — during quiet output a wheel scroll would otherwise never reach JS and
/// the jump-to-bottom UI could never appear.
///
/// Coalescing: dedup on unchanged offset, then a 50ms window matching the
/// parser-side constant. `display_offset == 0` bypasses the time window —
/// the return-to-bottom edge must always land so the JS at-bottom check
/// (`viewportY >= -3`) hides the jump button promptly instead of sticking
/// until the next PTY batch. A window-suppressed emit arms the one-shot
/// SCROLL_EMIT_FLUSH timer so the trailing edge of a fast flick is never
/// permanently swallowed (see the constant's docs).
unsafe fn emit_scroll_coalesced(
    state: &mut ChildState,
    hwnd: HWND,
    display_offset: usize,
    history: i64,
) {
    if state.last_scroll_emitted_offset == Some(display_offset) {
        return;
    }
    let now = Instant::now();
    let past_window = state
        .last_scroll_emit
        .map_or(true, |t| now.duration_since(t).as_millis() >= SCROLL_EMIT_COALESCE_MS);
    if !past_window && display_offset != 0 {
        SetTimer(hwnd, SCROLL_EMIT_FLUSH_TIMER_ID, SCROLL_EMIT_FLUSH_MS, None);
        return;
    }
    state.last_scroll_emitted_offset = Some(display_offset);
    state.last_scroll_emit = Some(now);
    if let (Some(app), Some(tid)) = (state.app.as_ref(), state.term_id) {
        let base_y = -history;
        emit_scroll(
            app,
            tid,
            ScrollEvt {
                viewport_y: -(display_offset as i64),
                base_y,
            },
        );
    }
}

/// P6a snap-to-bottom: typing while scrolled into history jumps the viewport
/// back to the live bottom BEFORE the byte reaches the PTY (standard
/// terminal behavior — alacritty/xterm both do this). Called from the
/// WM_CHAR / WM_KEYDOWN arms right before their `write_to_pty_sync`. Brief
/// Term lock; no-op when already at the bottom (the common case — one cheap
/// lock + compare per keystroke). On an actual snap we invalidate (offset
/// changed → FrameSnapshot dirties the next paint; no PTY echo is
/// guaranteed, so the repaint can't ride on the parser wake) and emit the
/// coalesced `scroll` so the JS jump-to-bottom button hides immediately.
unsafe fn snap_to_bottom_on_input(state: &mut ChildState, hwnd: HWND) {
    let term = match state.term.as_ref() {
        Some(t) => Arc::clone(t),
        None => return,
    };
    let snapped_history = {
        let mut t = term.lock().expect("term lock poisoned");
        if t.grid().display_offset() > 0 {
            t.scroll_display(Scroll::Bottom);
            Some(t.grid().history_size() as i64)
        } else {
            None
        }
    }; // Term lock released before invalidate/emit.
    if let Some(history) = snapped_history {
        let _ = InvalidateRect(hwnd, None, BOOL(0));
        emit_scroll_coalesced(state, hwnd, 0, history);
    }
}

/// P1b resize-commit: recompute cols/rows from the live client rect and cell
/// metrics, then commit them through the whole chain — alacritty grid →
/// renderer CellGrid → PTY → `resized` Tauri event. Fired from the
/// resize-settle timer (WM_TIMER / RESIZE_SETTLE_TIMER_ID) and once at the
/// end of `attach_pty`. Whole-chain no-op when the grid already matches, so
/// re-fires are cheap and attach-time drift correction is exact.
///
/// Locking discipline: the Term mutex is held ONLY for the compare +
/// `Term::resize` (idempotent — alacritty no-ops on unchanged dims) and is
/// released BEFORE the renderer rebuild, the PTY ioctl, and the Tauri emit,
/// so the parser worker is never blocked on a broadcast. NEVER touches the
/// registry mutex — everything it needs lives on ChildState mirrors.
unsafe fn commit_dims(state: &mut ChildState, hwnd: HWND) {
    // Guard: zero-area client (minimised / mid-teardown) or no attached term
    // → nothing to commit.
    let (client_w, client_h) = state.client_px;
    if client_w <= 0 || client_h <= 0 {
        return;
    }
    let term = match state.term.as_ref() {
        Some(t) => Arc::clone(t),
        None => return,
    };

    // Same formula + floors as `propose_dimensions`: physical client px ÷
    // physical cell metrics, floored to whole cells, min 20 cols
    // (narrow-pane guard) / 1 row.
    let cell_w = state.cell_w_px.max(0.001);
    let cell_h = state.cell_h_px.max(0.001);
    // Upper clamp guards the `as u16` PTY cast and Term allocation against a
    // degenerate cell metric (the 0.001 floor above).
    let cols = ((client_w as f32 / cell_w).floor() as usize).clamp(20, 4096);
    let rows = ((client_h as f32 / cell_h).floor() as usize).clamp(1, 4096);

    let changed = {
        let mut t = term.lock().expect("term lock poisoned");
        let grid = t.grid();
        if (grid.columns(), grid.screen_lines()) != (cols, rows) {
            t.resize(TermDims { columns: cols, screen_lines: rows });
            true
        } else {
            false
        }
    }; // Term mutex released here — before renderer / PTY / emit.
    if !changed {
        return;
    }

    if let Some(r) = state.renderer.as_mut() {
        r.resize_grid(cols, rows);
    }
    if let Some(pid) = state.pty_id {
        let _ = crate::pty::resize_pty_sync(pid, cols as u16, rows as u16);
    }
    if let (Some(app), Some(tid)) = (state.app.as_ref(), state.term_id) {
        emit_resized(
            app,
            tid,
            Resized {
                cols: cols as u32,
                rows: rows as u32,
                // Internal/settle-driven resize — no originating JS invoke.
                correlation_id: None,
            },
        );
    }
    let _ = InvalidateRect(hwnd, None, BOOL(0));
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
        // P4a/D2: CS_HREDRAW | CS_VREDRAW removed. They queued a redundant
        // full-invalidate WM_PAINT after every size change; the WM_SIZE arm
        // now repaints SYNCHRONOUSLY (D1) and validates, so the class-level
        // invalidation would only add a wasted paint dispatch per resize
        // tick (harmless — clean-frame early-out — but pure overhead).
        style: WNDCLASS_STYLES(0),
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
                // P3b: with the 16ms pump gone, a frame that did NOT present
                // has no guaranteed "next WM_PAINT" on an idle pane —
                // render_with_retry schedules a bounded retry via the
                // one-shot SURFACE_RETRY timer (P4a: logic shared with the
                // WM_SIZE synchronous repaint).
                render_with_retry(&mut *state_ptr, hwnd);
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
                // P1b resize-settle: (re-)arm the settle timer. SetTimer with
                // the same id RESETS the countdown, so a drag-resize keeps
                // pushing the deadline out and the commit fires exactly once,
                // RESIZE_SETTLE_MS after the last WM_SIZE (settle-after-quiet).
                SetTimer(hwnd, RESIZE_SETTLE_TIMER_ID, RESIZE_SETTLE_MS, None);
                // P4a/D1: SYNCHRONOUS repaint (what alacritty/WezTerm do).
                // WM_SIZE is delivered inside the SetWindowPos /
                // EndDeferWindowPos that moved us, so rendering HERE means
                // the surface is reconfigured AND presented at the new size
                // in the same pump turn as the move — the window never
                // composits a stretched/stale frame while an async
                // InvalidateRect → WM_PAINT round-trip catches up.
                // renderer.resize above already set force_render for w,h>0;
                // force_next_frame is belt-and-suspenders (explicit + covers
                // any future resize early-out changes). Zero-size guard
                // mirrors renderer.resize's own guard — never render into a
                // surface that skipped reconfigure.
                if w > 0 && h > 0 {
                    if let Some(r) = (*state_ptr).renderer.as_mut() {
                        r.force_next_frame();
                    }
                    // Same outcome handling as WM_PAINT: a frame that did
                    // not present arms the paced SURFACE_RETRY one-shot.
                    render_with_retry(&mut *state_ptr, hwnd);
                    // The move invalidated the newly-exposed client region
                    // (SWP_NOCOPYBITS invalidates the whole client area on
                    // size change). We just presented the full surface via
                    // wgpu, so validate to drop the queued redundant
                    // WM_PAINT. Nothing can be lost here: only this thread
                    // ever calls InvalidateRect on this HWND (the parser
                    // worker POSTS WM_APP_RENDER instead, whose own
                    // invalidation happens when it is dispatched later),
                    // and even a hypothetical miss is bounded by the 500ms
                    // watchdog. If Windows re-invalidates after WM_SIZE
                    // returns, the resulting WM_PAINT hits the clean-frame
                    // early-out — correct either way, just one wasted
                    // dispatch.
                    let _ = ValidateRect(hwnd, None);
                }
            }
            LRESULT(0)
        }
        WM_APP_RENDER => {
            // P3b event-driven wake from the parser worker. Clear `pending`
            // FIRST, then invalidate — this order closes the lost-wake
            // window: a batch landing after the clear posts a fresh message,
            // so the paint below can never miss it. (The reverse order would
            // let a batch slip in between InvalidateRect and the clear and
            // be silently swallowed.) A stale message from a detached wake
            // (state.wake already None / replaced) just invalidates — the
            // renderer's clean-frame early-out makes that free.
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ChildState;
            if !state_ptr.is_null() {
                if let Some(wake) = (*state_ptr).wake.as_ref() {
                    wake.pending.store(false, AtomicOrdering::Release);
                }
                let _ = InvalidateRect(hwnd, None, BOOL(0));
            }
            LRESULT(0)
        }
        WM_APP_FOCUS => {
            // P7b: keyboard-focus request posted by `focus_keyboard`
            // (native_term_focus_keyboard). We're on the HWND's owning
            // thread here, where SetFocus is always valid. Keyboard focus
            // moves WITHOUT activation (WS_EX_NOACTIVATE); WM_SETFOCUS then
            // fires → DECSET-1004 bytes + `focus_gained` emit exactly as on
            // the WM_LBUTTONDOWN click-to-focus path. The JS caller guards
            // hard (active pane + app focused + no webview input focused),
            // so this can never steal focus from composer/search/rename.
            let _ = SetFocus(hwnd);
            LRESULT(0)
        }
        WM_TIMER => {
            match wparam.0 {
                WATCHDOG_TIMER_ID => {
                    // P3b safety net for the event-driven scheduler: if
                    // batches landed whose wake never arrived (a missed-
                    // invalidation bug anywhere), repaint within 500ms
                    // instead of freezing. Cheap when idle (batch counter
                    // unchanged → no-op) and when the wake already painted
                    // (renderer clean-frame early-out).
                    let state_ptr =
                        GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ChildState;
                    if !state_ptr.is_null() {
                        if let Some(wake) = (*state_ptr).wake.as_ref() {
                            let batches = wake.batches.load(AtomicOrdering::Acquire);
                            if batches != (*state_ptr).last_seen_batches {
                                (*state_ptr).last_seen_batches = batches;
                                let _ = InvalidateRect(hwnd, None, BOOL(0));
                            }
                        }
                    }
                    LRESULT(0)
                }
                BLINK_TIMER_ID => {
                    // P2a cursor blink: flip the renderer's phase each
                    // half-period + repaint. The guard mirrors
                    // `update_blink_timer`'s FULL arm condition (renderer
                    // wants ticks + Term attached + window visible) — not
                    // just `focused` — because KillTimer does not remove a
                    // WM_TIMER already posted to the queue. A stale tick
                    // landing after ANY kill transition (focus loss, blink
                    // disabled via set_cursor_style, detach, hide) would
                    // otherwise call toggle_blink_phase and un-pin the
                    // phase that the kill path just pinned visible —
                    // stranding a focused non-blinking pane's cursor
                    // invisible with no timer left to flip it back.
                    let state_ptr =
                        GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ChildState;
                    if !state_ptr.is_null() && (*state_ptr).focused {
                        let attached = (*state_ptr).term.is_some();
                        let visible = IsWindowVisible(hwnd).as_bool();
                        let wants = (*state_ptr)
                            .renderer
                            .as_ref()
                            .map_or(false, |r| r.wants_blink_ticks());
                        if wants && attached && visible {
                            if let Some(r) = (*state_ptr).renderer.as_mut() {
                                r.toggle_blink_phase();
                            }
                            let _ = InvalidateRect(hwnd, None, BOOL(0));
                        }
                    }
                    LRESULT(0)
                }
                RESIZE_SETTLE_TIMER_ID => {
                    // Kill FIRST — SetTimer timers are periodic, and without
                    // this the settle commit would re-fire every 150ms forever.
                    let _ = KillTimer(hwnd, RESIZE_SETTLE_TIMER_ID);
                    let state_ptr =
                        GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ChildState;
                    if !state_ptr.is_null() {
                        commit_dims(&mut *state_ptr, hwnd);
                    }
                    LRESULT(0)
                }
                SURFACE_RETRY_TIMER_ID => {
                    // One-shot surface-loss retry: kill first (SetTimer
                    // timers are periodic), then invalidate so WM_PAINT
                    // re-runs render(). If the surface is STILL lost, the
                    // paint arm re-arms this timer — a paced ~16ms retry
                    // loop (the pre-P3b pump cadence) instead of an
                    // Invalidate busy-spin.
                    let _ = KillTimer(hwnd, SURFACE_RETRY_TIMER_ID);
                    let _ = InvalidateRect(hwnd, None, BOOL(0));
                    LRESULT(0)
                }
                SCROLL_EMIT_FLUSH_TIMER_ID => {
                    // P6a trailing-edge flush: kill first (one-shot), then
                    // re-read the LIVE offset and re-run the coalesced emit.
                    // By now the 50ms window has elapsed, so the suppressed
                    // final wheel notch of a flick lands on the JS bus; an
                    // offset that bounced back to the last-emitted value
                    // dedups to nothing. No Term (detached mid-flight) →
                    // no-op.
                    let _ = KillTimer(hwnd, SCROLL_EMIT_FLUSH_TIMER_ID);
                    let state_ptr =
                        GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ChildState;
                    if !state_ptr.is_null() {
                        let term = (*state_ptr).term.as_ref().map(Arc::clone);
                        if let Some(term) = term {
                            let (offset_now, history) = {
                                let t = term.lock().expect("term lock poisoned");
                                let grid = t.grid();
                                (grid.display_offset(), grid.history_size() as i64)
                            };
                            emit_scroll_coalesced(
                                &mut *state_ptr,
                                hwnd,
                                offset_now,
                                history,
                            );
                        }
                    }
                    LRESULT(0)
                }
                _ => DefWindowProcW(hwnd, msg, wparam, lparam),
            }
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
                let term = (*state_ptr).term.as_ref().map(Arc::clone);
                if let Some(term) = term {
                    // P6a: capture the post-scroll offset + history under the
                    // SAME lock so the emit below reflects exactly what the
                    // next frame renders.
                    let (offset_now, history) = {
                        let mut t = term.lock().expect("term lock poisoned");
                        t.scroll_display(Scroll::Delta(lines));
                        let grid = t.grid();
                        (grid.display_offset(), grid.history_size() as i64)
                    };
                    let _ = InvalidateRect(hwnd, None, BOOL(0));
                    // P6a: the parser worker only emits `scroll` on byte
                    // arrival — a wheel scroll during quiet output must emit
                    // from HERE or the jump-to-bottom UI never appears.
                    // Coalesced (50ms, parser-matched) in the helper.
                    emit_scroll_coalesced(&mut *state_ptr, hwnd, offset_now, history);
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
                // P6a snap-to-bottom: keystrokes headed for the PTY jump a
                // scrolled-back viewport to the live bottom first (standard
                // terminal behavior). Cheap no-op when already pinned.
                if !state_ptr.is_null() {
                    snap_to_bottom_on_input(&mut *state_ptr, hwnd);
                }
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
                    // P6a snap-to-bottom: mirror the WM_KEYDOWN forward path —
                    // any character reaching the PTY jumps a scrolled-back
                    // viewport to the live bottom first.
                    if !state_ptr.is_null() {
                        snap_to_bottom_on_input(&mut *state_ptr, hwnd);
                    }
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
                //
                // P6b wide chars: the bridge contract (CellHoverEvent in
                // native-term-bridge.ts) promises wide CJK chars report the
                // START col of the glyph — when the hovered cell is the
                // trailing WIDE_CHAR_SPACER half, normalize to col-1 (flags
                // read inside this same lock). The hyperlink is then read
                // from the normalized cell so both halves resolve the same
                // link.
                let (display_offset, hover_uri, col_norm) = if let Some(term) =
                    (*state_ptr).term.as_ref()
                {
                    let t = term.lock().expect("term lock poisoned");
                    let grid = t.grid();
                    let cols = grid.columns();
                    let rows = grid.screen_lines();
                    let display_offset_i = grid.display_offset() as i32;
                    let (uri, col_n) = if cols > 0
                        && rows > 0
                        && row_visible >= 0
                        && (row_visible as usize) < rows
                        && col_raw >= 0
                        && (col_raw as usize) < cols
                    {
                        let line = Line(row_visible - display_offset_i);
                        let mut c = col_raw as usize;
                        if c > 0
                            && grid[line][Column(c)]
                                .flags
                                .contains(CellFlags::WIDE_CHAR_SPACER)
                        {
                            c -= 1;
                        }
                        let cell = &grid[line][Column(c)];
                        (cell.hyperlink().map(|h| h.uri().to_owned()), c as i32)
                    } else {
                        (None, col_raw)
                    };
                    (display_offset_i, uri, col_n)
                } else {
                    (0, None, col_raw)
                };
                // Visible row 0 = top of screen; line = row - display_offset.
                // When user has scrolled back N lines, row 0 maps to Line(-N).
                let line_signed = row_visible as i64 - display_offset as i64;
                let col = col_norm.max(0) as u32;
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
            // P2a (additive — the DECSET-1004 bytes above are untouched):
            // tell the React layer the native HWND gained keyboard focus
            // (click-to-focus path) so it can mark this pane active and its
            // focus effect can call native_term_set_focused.
            if !state_ptr.is_null() {
                if let (Some(app), Some(tid)) =
                    ((*state_ptr).app.as_ref(), (*state_ptr).term_id)
                {
                    emit_focus_gained(app, tid);
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
            // P2b (additive — the DECSET-1004 bytes above are untouched):
            // tell the React layer the native HWND lost Win32 keyboard
            // focus. On Windows the tauri onFocusChanged event mirrors
            // WEBVIEW focus only, so when a native pane holds focus an
            // Alt-Tab away produces no JS blur at all — this event is the
            // store's only way to clear nativePaneFocused. Focus moving
            // pane→pane is fine: Windows delivers WM_KILLFOCUS (old pane)
            // before WM_SETFOCUS (new pane), so focus_lost → focus_gained
            // arrive in order and the store converges on focused=true.
            if !state_ptr.is_null() {
                if let (Some(app), Some(tid)) =
                    ((*state_ptr).app.as_ref(), (*state_ptr).term_id)
                {
                    emit_focus_lost(app, tid);
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
/// P6a scrollback: the renderer now honours display_offset (visible row y
/// shows grid line `y - offset`), so this fn subtracts the offset to hand
/// selection a TRUE grid line — negative while the click lands on history
/// rows. Matches the cell_hover / link-click math and the snapshot's
/// selection-containment convention, so selections anchor to content and
/// stay correct while scrolled.
unsafe fn mouse_to_point(state: &ChildState, x_px: i32, y_px: i32) -> Option<Point> {
    let term = state.term.as_ref()?;
    let cell_w = state.cell_w_px.max(0.001);
    let line_h = state.cell_h_px.max(0.001);
    let (cols, rows, display_offset) = {
        let t = term.lock().expect("term lock poisoned");
        let grid = t.grid();
        (grid.columns(), grid.screen_lines(), grid.display_offset() as i32)
    };
    if cols == 0 || rows == 0 {
        return None;
    }
    let col_raw = (x_px as f32 / cell_w).floor() as i32;
    let row_raw = (y_px as f32 / line_h).floor() as i32;
    let col = col_raw.clamp(0, (cols as i32).saturating_sub(1)) as usize;
    let row = row_raw.clamp(0, (rows as i32).saturating_sub(1));
    Some(Point::new(Line(row - display_offset), Column(col)))
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
