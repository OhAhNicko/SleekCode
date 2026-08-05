mod browser_view;
mod cli_install;
mod debug_log;
mod preview_proxy;
mod pty;
mod native_term;
mod overlay;
mod file_watch;
mod screenshots;
mod fs_ops;
mod wsl_health;

use std::process::{Child, Command};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::collections::HashMap;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

/// Registry of active `ssh -N -L` port-forward processes, one per remote dev
/// server. The frontend starts a forward when it detects a port and stops it
/// when the dev server exits or is removed, so the user never has to think
/// about Tailscale IPs or `--host` flags — `http://localhost:<port>` always
/// reaches the remote dev server.
#[derive(Default)]
pub struct SshForwardRegistry {
    next_id: AtomicU64,
    forwards: Mutex<HashMap<u64, Child>>,
}

#[derive(Serialize)]
pub struct SshForwardHandle {
    handle_id: u64,
    local_port: u16,
}

/// Spawn `wsl.exe` with `CREATE_NO_WINDOW` so no console window flashes.
#[cfg(target_os = "windows")]
pub(crate) fn wsl_command() -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut cmd = Command::new("wsl.exe");
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn wsl_command() -> Command {
    Command::new("wsl.exe")
}

/// `wsl_command()` targeting a specific distro when one is given (the user's
/// Settings override). None = wsl.exe's default distro.
pub(crate) fn wsl_command_in(distro: Option<&str>) -> Command {
    let mut cmd = wsl_command();
    if let Some(d) = distro {
        cmd.args(["-d", d]);
    }
    cmd
}

/// Remove all Windows 11 DWM borders including the 1px top non-client border.
#[cfg(target_os = "windows")]
mod win32_border {
    use std::ffi::c_void;

    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller;
    use windows_webview2::Win32::Foundation::{
        HWND as WebViewHwnd,
        RECT as WebViewRect,
    };

    const DWMWA_USE_IMMERSIVE_DARK_MODE: u32 = 20;
    const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
    const DWMWCP_DONOTROUND: u32 = 1;
    const DWMWCP_ROUND: u32 = 2;
    const DWMWA_BORDER_COLOR: u32 = 34;
    /// Special COLORREF telling DWM to draw NO window border at all (not just a
    /// matching color). This suppresses the Windows 11 accent border line on all
    /// four sides (border #1). The window is opaque and borderless with rounded
    /// corners (DWMWCP_ROUND) but has NO drop shadow: no WS_THICKFRAME is added
    /// and `shadow: false` in tauri.conf.json, so DWM composites no native shadow
    /// frame — which is what produced the intermittent 1px top line on resize
    /// (border #2). We use the top-line diagnosis from
    /// win-err/docs/frameless-no-border-with-shadow.md but NOT its transparent +
    /// CSS-shadow approach (transparency caused drag lag + a double edge here).
    const DWMWA_COLOR_NONE: u32 = 0xFFFFFFFE;
    const WM_NCCALCSIZE: u32 = 0x0083;
    const WM_NCPAINT: u32 = 0x0085;
    const WM_NCACTIVATE: u32 = 0x0086;
    const WM_SETTEXT: u32 = 0x000C;
    const WM_SETICON: u32 = 0x0080;
    /// Undocumented "user apphack" messages the theme engine sends to draw the
    /// themed caption/frame; classic borderless windows swallow them.
    const WM_NCUAHDRAWCAPTION: u32 = 0x00AE;
    const WM_NCUAHDRAWFRAME: u32 = 0x00AF;
    const WM_ERASEBKGND: u32 = 0x0014;
    const WM_SIZE: u32 = 0x0005;
    const WM_MOVE: u32 = 0x0003;
    const WM_ACTIVATE: u32 = 0x0006;
    const WM_SHOWWINDOW: u32 = 0x0018;
    const WM_DISPLAYCHANGE: u32 = 0x007E;
    const WM_NCDESTROY: u32 = 0x0082;
    const WM_WINDOWPOSCHANGED: u32 = 0x0047;
    const WM_SIZING: u32 = 0x0214;
    const WM_MOVING: u32 = 0x0216;
    const WM_ENTERSIZEMOVE: u32 = 0x0231;
    const WM_EXITSIZEMOVE: u32 = 0x0232;
    const WM_DPICHANGED: u32 = 0x02E0;
    const WM_DWMCOMPOSITIONCHANGED: u32 = 0x031E;
    const WM_DWMCOLORIZATIONCOLORCHANGED: u32 = 0x0320;
    const WM_APP: u32 = 0x8000;
    const WM_SYNC_WEBVIEW_BOUNDS: u32 = WM_APP + 0x4D;
    const WM_FORCE_NC_RECOMPOSITE: u32 = WM_APP + 0x4E;
    const SIZE_MINIMIZED: usize = 1;
    const SIZE_MAXIMIZED: usize = 2;
    const SIZE_RESTORED: usize = 0;
    const SWP_FRAMECHANGED: u32 = 0x0020;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_ASYNCWINDOWPOS: u32 = 0x4000;
    const MONITOR_DEFAULTTONEAREST: u32 = 2;
    const SUBCLASS_ID: usize = 1;
    const SM_CXSIZEFRAME: i32 = 32;
    const SM_CYSIZEFRAME: i32 = 33;
    const SM_CXPADDEDBORDER: i32 = 92;
    const GWL_STYLE: i32 = -16;
    const WS_VISIBLE: isize = 0x1000_0000;
    const FRAME_CLAMP_TOLERANCE_PX: i32 = 3;

    #[repr(C)]
    #[derive(Copy, Clone)]
    struct RECT {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[repr(C)]
    struct MONITORINFO {
        cb_size: u32,
        rc_monitor: RECT,
        rc_work: RECT,
        dw_flags: u32,
    }

    #[repr(C)]
    struct NCCALCSIZE_PARAMS {
        rgrc: [RECT; 3],
        lppos: *mut c_void,
    }

    struct BorderSubclassState {
        controller: ICoreWebView2Controller,
        /// For the `made:window-minimized` transition events — the wnd_proc is
        /// the only place that reliably sees SIZE_MINIMIZED (Tauri's
        /// onFocusChanged mirrors WEBVIEW focus, not OS window state).
        app: tauri::AppHandle,
        sync_pending: bool,
        recomposite_pending: bool,
        was_minimized: bool,
        was_maximized: bool,
        /// Client size (px) of the last bounds sync actually pushed to the
        /// WebView2 controller. `sync_webview_bounds` skips identical
        /// re-syncs — see its docs.
        last_synced_px: Option<(i32, i32)>,
    }

    extern "system" {
        fn DwmSetWindowAttribute(
            hwnd: *mut c_void,
            dw_attribute: u32,
            pv_attribute: *const c_void,
            cb_attribute: u32,
        ) -> i32;

        fn SetWindowSubclass(
            hwnd: *mut c_void,
            pfn_subclass: Option<unsafe extern "system" fn(
                *mut c_void, u32, usize, isize, usize, usize,
            ) -> isize>,
            uid_subclass: usize,
            ref_data: usize,
        ) -> i32;

        fn RemoveWindowSubclass(
            hwnd: *mut c_void,
            pfn_subclass: Option<unsafe extern "system" fn(
                *mut c_void, u32, usize, isize, usize, usize,
            ) -> isize>,
            uid_subclass: usize,
        ) -> i32;

        fn DefSubclassProc(
            hwnd: *mut c_void,
            msg: u32,
            wparam: usize,
            lparam: isize,
        ) -> isize;

        fn SetWindowPos(
            hwnd: *mut c_void,
            insert_after: *mut c_void,
            x: i32, y: i32, cx: i32, cy: i32,
            flags: u32,
        ) -> i32;
        fn GetClientRect(hwnd: *mut c_void, rect: *mut RECT) -> i32;
        fn GetWindowRect(hwnd: *mut c_void, rect: *mut RECT) -> i32;
        fn IsZoomed(hwnd: *mut c_void) -> i32;
        fn IsIconic(hwnd: *mut c_void) -> i32;
        fn GetForegroundWindow() -> *mut c_void;
        fn MonitorFromRect(rect: *const RECT, flags: u32) -> *mut c_void;
        fn GetMonitorInfoW(monitor: *mut c_void, info: *mut MONITORINFO) -> i32;
        fn GetDpiForWindow(hwnd: *mut c_void) -> u32;
        fn GetWindowLongPtrW(hwnd: *mut c_void, index: i32) -> isize;
        fn SetWindowLongPtrW(hwnd: *mut c_void, index: i32, value: isize) -> isize;
        fn GetSystemMetricsForDpi(index: i32, dpi: u32) -> i32;
        fn PostMessageW(hwnd: *mut c_void, msg: u32, wparam: usize, lparam: isize) -> i32;
        fn ShowWindow(hwnd: *mut c_void, cmd_show: i32) -> i32;
        fn SetTimer(
            hwnd: *mut c_void,
            id_event: usize,
            elapse: u32,
            timer_func: *const c_void,
        ) -> usize;
        fn KillTimer(hwnd: *mut c_void, id_event: usize) -> i32;
    }

    const WM_TIMER: u32 = 0x0113;

    const SW_MINIMIZE: i32 = 6;

    /// Minimize directly from maximized state without flashing the restored window.
    /// Windows preserves the prior state (maximized/normal) automatically —
    /// restoring from taskbar or Alt+Tab returns to the same state.
    pub fn minimize_to_normal(hwnd: *mut c_void) {
        unsafe {
            ShowWindow(hwnd, SW_MINIMIZE);
        }
    }

    /// Suppress the Windows 11 accent window border (border #1, all four sides).
    /// The window is opaque with no drop shadow (no native shadow, not
    /// transparent), so there is no shadow frame to preserve. Two DWM attributes:
    /// 1. `DWMWA_USE_IMMERSIVE_DARK_MODE = TRUE` — keep DWM in dark theme so any
    ///    transient non-client fill is dark, not a bright light-theme color.
    /// 2. `DWMWA_BORDER_COLOR = DWMWA_COLOR_NONE` — tell DWM to draw no border
    ///    line at all. Stable across drag-resize / maximize / snap / activate
    ///    transitions; re-applied on transitions defensively.
    #[inline]
    unsafe fn apply_border_suppression(hwnd: *mut c_void) {
        let dark_mode: i32 = 1;
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            &dark_mode as *const i32 as *const c_void,
            std::mem::size_of::<i32>() as u32,
        );

        let no_border: u32 = DWMWA_COLOR_NONE;
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR,
            &no_border as *const u32 as *const c_void,
            std::mem::size_of::<u32>() as u32,
        );
    }

    /// Chromium's ScopedRedrawLock (ui/views/win/hwnd_message_handler.cc):
    /// Windows paints default non-client chrome INSIDE the default handlers of
    /// certain messages (WM_NCACTIVATE, WM_SETTEXT, WM_SETICON, ...), which no
    /// amount of WM_NCPAINT blocking or DWM attributes can intercept. Clearing
    /// WS_VISIBLE via SetWindowLongPtr (which does NOT hide or repaint the
    /// window on screen) for the duration of the DefSubclassProc call makes GDI
    /// treat the window as invisible, so that internal paint can never reach
    /// the screen. The style is restored immediately afterwards.
    #[inline]
    unsafe fn def_subclass_proc_with_redraw_lock(
        hwnd: *mut c_void,
        msg: u32,
        wparam: usize,
        lparam: isize,
    ) -> isize {
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        let was_visible = style & WS_VISIBLE != 0;
        if was_visible {
            SetWindowLongPtrW(hwnd, GWL_STYLE, style & !WS_VISIBLE);
        }
        let result = DefSubclassProc(hwnd, msg, wparam, lparam);
        if was_visible {
            SetWindowLongPtrW(
                hwnd,
                GWL_STYLE,
                GetWindowLongPtrW(hwnd, GWL_STYLE) | WS_VISIBLE,
            );
        }
        result
    }

    #[inline]
    unsafe fn queue_webview_bounds_sync(hwnd: *mut c_void, state: &mut BorderSubclassState) {
        if state.sync_pending {
            return;
        }

        state.sync_pending = true;
        if PostMessageW(hwnd, WM_SYNC_WEBVIEW_BOUNDS, 0, 0) == 0 {
            state.sync_pending = false;
        }
    }

    /// Delayed accent-frame retry timers. The posted recomposite below runs
    /// right after the message burst — but a maximize→restore plays a DWM
    /// ANIMATION that outlasts the burst, and DWM composites the stale accent
    /// frame AFTER our nudge. Nothing retried, so the red line stuck until a
    /// manual resize. Two staggered retries (post-animation, then a settle
    /// margin) make the clear stick; the nudge is net-zero (+1/−1 px) and
    /// invisible, so re-running it is free.
    const NC_RETRY_TIMER_1: usize = 0x4E31; // 'N1'
    const NC_RETRY_TIMER_2: usize = 0x4E32; // 'N2'
    const NC_RETRY_1_MS: u32 = 450;
    const NC_RETRY_2_MS: u32 = 900;
    /// One-shot after a minimize→restore transition: Win+D ("show desktop"
    /// toggle) restores the window to the FOREGROUND without ever delivering
    /// keyboard focus to it — no WM_SETFOCUS reaches the webview, so the JS
    /// focus chain (GotFocus → appWindowFocused → pane focus routing) never
    /// starts and typing is dead until an Alt-Tab. The timer (not an inline
    /// call) lets the restore burst finish first; the handler re-checks
    /// foreground so a background restore can never steal focus.
    const FOCUS_KICK_TIMER: usize = 0x4643; // 'FC'
    const FOCUS_KICK_MS: u32 = 60;

    /// Queue a deferred non-client recomposite. Posted (not synchronous) so it
    /// runs AFTER the current transition's message burst settles — re-applying
    /// the DWM attributes synchronously inside WM_SIZE/WM_EXITSIZEMOVE is too
    /// early; DWM composites the accent frame afterward and overwrites it.
    /// One-shot guarded by `recomposite_pending` to collapse duplicate queues.
    /// Also arms the delayed retries (see NC_RETRY_TIMER_*): SetTimer with the
    /// same id resets the countdown, so a burst of queues collapses into one
    /// retry pair after the LAST transition.
    #[inline]
    unsafe fn queue_nc_recomposite(hwnd: *mut c_void, state: &mut BorderSubclassState) {
        SetTimer(hwnd, NC_RETRY_TIMER_1, NC_RETRY_1_MS, std::ptr::null());
        SetTimer(hwnd, NC_RETRY_TIMER_2, NC_RETRY_2_MS, std::ptr::null());
        if state.recomposite_pending {
            return;
        }

        state.recomposite_pending = true;
        if PostMessageW(hwnd, WM_FORCE_NC_RECOMPOSITE, 0, 0) == 0 {
            state.recomposite_pending = false;
        }
    }

    /// Force DWM to drop a stale accent non-client frame left behind by a
    /// maximize/restore, drag/resize, or DPI/monitor transition. Re-asserts the
    /// border suppression, then performs a net-zero +1/-1 width nudge: only a
    /// real geometry change forces DWM to recomposite the NC area (this is
    /// exactly why the user's manual "resize again" clears the border). The
    /// nudge's own WM_SIZE/WM_WINDOWPOSCHANGED never re-enters here because
    /// recomposites are only queued from settling edges, never from WM_SIZE.
    #[inline]
    unsafe fn force_nc_recomposite(hwnd: *mut c_void) {
        // There's no visible frame to fix while iconic.
        if IsIconic(hwnd) != 0 {
            return;
        }

        apply_border_suppression(hwnd);

        // Never nudge a maximized window — a size change would un-maximize it.
        // Instead, a pure frame-changed re-runs WM_NCCALCSIZE so the client rect
        // snaps back to the (now fresh) monitor work area after DPI / display /
        // work-area transitions; without this a stale overshooting client rect
        // sticks until the user re-maximizes (content clipped at screen edges).
        if IsZoomed(hwnd) != 0 {
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                0, 0, 0, 0,
                SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            );
            return;
        }

        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        if GetWindowRect(hwnd, &mut r) == 0 {
            return;
        }
        let x = r.left;
        let y = r.top;
        let w = r.right - r.left;
        let h = r.bottom - r.top;
        if w <= 1 || h <= 1 {
            return;
        }

        let flags = SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED;
        SetWindowPos(hwnd, std::ptr::null_mut(), x, y, w + 1, h, flags);
        SetWindowPos(hwnd, std::ptr::null_mut(), x, y, w, h, flags);
    }

    #[inline]
    unsafe fn sync_webview_bounds(hwnd: *mut c_void, state: &mut BorderSubclassState) {
        let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        if GetClientRect(hwnd, &mut rect) == 0 {
            return;
        }

        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if width <= 0 || height <= 0 {
            return;
        }

        // IDEMPOTENCE GUARD (2026-07-24). WM_WINDOWPOSCHANGED fires for pure
        // ACTIVATION / Z-ORDER changes too, not just geometry — and showing or
        // hiding the owned overlay window (every menu, dropdown and context
        // menu) produces exactly that on the owner. Hardware-logged: each menu
        // toggle drove TWO full bounds re-syncs at an unchanged 1902x825, i.e.
        // SetBounds + a SetWindowPos on the WebView2 child + a
        // NotifyParentWindowPositionChanged, each one re-laying-out Chromium
        // and re-painting main, for no geometry change at all.
        //
        // Re-syncing identical bounds can only cost frames: the whole class of
        // bug in this window (see docs/learnings/2026-07-24-overlay-region-
        // flicker.md) is "main loses its composed children for a frame when
        // something churns its child windows". Skip the no-op.
        //
        // Moves are unaffected: screen-position changes are notified from the
        // WM_MOVE / WM_MOVING arm, which calls
        // NotifyParentWindowPositionChanged directly. Real size changes
        // (resize, maximize/restore, DPI, display transitions, the +1/-1
        // recomposite nudge) all differ from the cache and sync as before.
        if state.last_synced_px == Some((width, height)) {
            return;
        }
        state.last_synced_px = Some((width, height));

        let bounds = WebViewRect {
            left: 0,
            top: 0,
            right: width,
            bottom: height,
        };
        let _ = state.controller.SetBounds(bounds);

        let mut webview_hwnd = WebViewHwnd::default();
        if state.controller.ParentWindow(&mut webview_hwnd).is_ok() && !webview_hwnd.0.is_null() {
            SetWindowPos(
                webview_hwnd.0,
                std::ptr::null_mut(),
                0,
                0,
                width,
                height,
                SWP_ASYNCWINDOWPOS | SWP_NOACTIVATE | SWP_NOZORDER,
            );
        }

        let _ = state.controller.NotifyParentWindowPositionChanged();
    }

    #[inline]
    unsafe fn frame_overshoot_limit(hwnd: *mut c_void) -> (i32, i32) {
        let dpi = GetDpiForWindow(hwnd).max(96);
        let fallback = ((8 * dpi as i32) + 95) / 96;

        let frame_x = GetSystemMetricsForDpi(SM_CXSIZEFRAME, dpi)
            + GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi);
        let frame_y = GetSystemMetricsForDpi(SM_CYSIZEFRAME, dpi)
            + GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi);

        (
            frame_x.max(fallback) + FRAME_CLAMP_TOLERANCE_PX,
            frame_y.max(fallback) + FRAME_CLAMP_TOLERANCE_PX,
        )
    }

    #[inline]
    fn clamp_small_frame_overshoot(r: &mut RECT, work: RECT, max_x: i32, max_y: i32) {
        let left_overshoot = work.left - r.left;
        if left_overshoot > 0 && left_overshoot <= max_x {
            r.left = work.left;
        }

        let right_overshoot = r.right - work.right;
        if right_overshoot > 0 && right_overshoot <= max_x {
            r.right = work.right;
        }

        let top_overshoot = work.top - r.top;
        if top_overshoot > 0 && top_overshoot <= max_y {
            r.top = work.top;
        }

        let bottom_overshoot = r.bottom - work.bottom;
        if bottom_overshoot > 0 && bottom_overshoot <= max_y {
            r.bottom = work.bottom;
        }
    }

    /// Window subclass proc that intercepts WM_NCCALCSIZE to remove the
    /// 1px top non-client border Windows draws on frameless windows.
    ///
    /// Only tiny resize-frame overshoots are clamped to the monitor work area.
    /// Large overshoots are left alone so a normal window can span monitors
    /// without shrinking the client rect and exposing native background.
    unsafe extern "system" fn subclass_proc(
        hwnd: *mut c_void,
        msg: u32,
        wparam: usize,
        lparam: isize,
        _uid_subclass: usize,
        ref_data: usize,
    ) -> isize {
        let state_ptr = ref_data as *mut BorderSubclassState;

        if msg == WM_NCDESTROY {
            RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID);
            if !state_ptr.is_null() {
                drop(Box::from_raw(state_ptr));
            }
            return DefSubclassProc(hwnd, msg, wparam, lparam);
        }

        // ---- Structural suppression of ALL default non-client rendering ----
        // (Chromium HWNDMessageHandler pattern — the mechanism VS Code/Discord
        // windows use; DWM border attributes alone are not what keeps their
        // accent border off.) The window draws 100% of its own frame, so no
        // default NC paint path may ever run:
        //
        // 1) WM_NCPAINT + the undocumented theme-engine draw messages are
        //    swallowed outright. There is no NC area (WM_NCCALCSIZE claims the
        //    full rect), so there is nothing legitimate for them to draw.
        //    Blocking WM_NCPAINT does NOT affect DWMWCP_ROUND corners —
        //    Chromium does both.
        if msg == WM_NCPAINT || msg == WM_NCUAHDRAWCAPTION || msg == WM_NCUAHDRAWFRAME {
            return 0;
        }
        //
        // 1b) WM_ERASEBKGND is swallowed: tao's handler FillRects the ENTIRE
        //    client rect with the configured backgroundColor (#131313), and the
        //    window has no WS_CLIPCHILDREN, so that fill wipes the WebView2 and
        //    wgpu pane children out of the redirection surface. Any external
        //    invalidation (the overlay window's SetWindowRgn on popup open/close
        //    is the hot one) then races the children's next present — losing the
        //    race showed 1-2 frames of bare #131313 over the whole app (the
        //    "flicker when menus open/close" bug; hardware-captured 2026-07-24).
        //    Claiming "erased" without painting keeps the previous surface
        //    content, which the children fully cover anyway. This subclass is
        //    installed AFTER webview creation, so the pre-webview startup frames
        //    still get tao's solid-color erase.
        if msg == WM_ERASEBKGND {
            return 1;
        }
        //
        // 2) WM_NCACTIVATE fires on every focus gain/loss and its DEFAULT
        //    handler paints system chrome ("can draw an incorrect title bar
        //    and cause visual corruption" — Chromium OnNCActivate). It must
        //    still reach tao's handler (it drives Tauri focus events), so the
        //    repaint is suppressed via the DOCUMENTED lParam=-1 form: "when
        //    lParam is -1, DefWindowProc does not repaint the nonclient area"
        //    (Chromium's DWM-frame path). It must NOT go through the
        //    WS_VISIBLE redraw lock: clearing WS_VISIBLE on the whole window
        //    — even for the microseconds of a DefSubclassProc call — races
        //    DWM's composition sampling, and losing dropped the WebView2 +
        //    wgpu children for 1-2 frames, flashing the entire app to bare
        //    #131313. Overlay-popup clicks deactivate/reactivate main within
        //    ~40ms (Chromium's child in the overlay steals activation), so
        //    this bracket ran on EVERY menu dismiss/item click and flashed
        //    ~25% of them (hardware-captured 2026-07-24; Chromium reserves
        //    the redraw lock for CLASSIC frames — a regioned window — which
        //    main never is).
        if msg == WM_NCACTIVATE {
            apply_border_suppression(hwnd);
            return DefSubclassProc(hwnd, msg, wparam, -1);
        }
        //    WM_SETTEXT/WM_SETICON default handlers likewise paint NC chrome
        //    internally and have no lParam=-1 escape; they keep the redraw
        //    lock. They only fire on title/icon changes (project switches),
        //    never on the popup hot path. (WM_NCLBUTTONDOWN is deliberately
        //    NOT locked: its default handling can enter a modal move loop,
        //    and with a zero NC area it never fires here.)
        if msg == WM_SETTEXT || msg == WM_SETICON {
            return def_subclass_proc_with_redraw_lock(hwnd, msg, wparam, lparam);
        }

        // Re-apply DWMWA_COLOR_NONE + immersive dark on every window state
        // change. Windows can reset DWMWA_BORDER_COLOR during transitions
        // (drag-resize, maximize, minimize, activate, snap, theme change), so
        // re-asserting "no border" defensively keeps the accent line away.
        if msg == WM_SIZE || msg == WM_ACTIVATE
           || msg == WM_SHOWWINDOW || msg == WM_WINDOWPOSCHANGED
           || msg == WM_MOVE || msg == WM_MOVING || msg == WM_SIZING
           || msg == WM_ENTERSIZEMOVE || msg == WM_EXITSIZEMOVE
           || msg == WM_DPICHANGED || msg == WM_DISPLAYCHANGE
           || msg == WM_NCCALCSIZE || msg == WM_DWMCOMPOSITIONCHANGED
           || msg == WM_DWMCOLORIZATIONCOLORCHANGED
        {
            apply_border_suppression(hwnd);
        }

        if !state_ptr.is_null() {
            let state = &mut *state_ptr;
            if msg == WM_SYNC_WEBVIEW_BOUNDS {
                state.sync_pending = false;
                sync_webview_bounds(hwnd, state);
                return 0;
            }

            if msg == WM_FORCE_NC_RECOMPOSITE {
                state.recomposite_pending = false;
                force_nc_recomposite(hwnd);
                return 0;
            }

            // Delayed accent-frame retries (see NC_RETRY_TIMER_* docs): DWM's
            // maximize→restore animation outlasts the posted recomposite, so
            // the stale accent frame forms AFTER the first clear. These fire
            // once each, after the animation has settled.
            if msg == WM_TIMER
                && (wparam == NC_RETRY_TIMER_1 || wparam == NC_RETRY_TIMER_2)
            {
                KillTimer(hwnd, wparam);
                force_nc_recomposite(hwnd);
                return 0;
            }

            if msg == WM_TIMER && wparam == FOCUS_KICK_TIMER {
                KillTimer(hwnd, wparam);
                // Foreground re-check: a restore that did NOT end with us in
                // the foreground (programmatic restore behind another app)
                // must not steal focus.
                if IsIconic(hwnd) == 0 && GetForegroundWindow() == hwnd {
                    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC;
                    let _ = state
                        .controller
                        .MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
                }
                return 0;
            }

            if msg == WM_MOVE || msg == WM_MOVING {
                let _ = state.controller.NotifyParentWindowPositionChanged();
            }

            if msg == WM_DPICHANGED || msg == WM_DISPLAYCHANGE
               || msg == WM_MOVE || msg == WM_MOVING || msg == WM_SIZING
               || msg == WM_EXITSIZEMOVE || msg == WM_WINDOWPOSCHANGED
               || msg == WM_SHOWWINDOW
            {
                queue_webview_bounds_sync(hwnd, state);
            }

            // Settling edges only — NOT WM_SIZE/WM_WINDOWPOSCHANGED (those fire
            // during the nudge and would risk a feedback loop). Each of these
            // leaves a stale accent NC frame that only a real geometry change
            // clears; defer a one-shot recomposite past the message burst.
            if msg == WM_EXITSIZEMOVE || msg == WM_DPICHANGED
               || msg == WM_DISPLAYCHANGE
            {
                queue_nc_recomposite(hwnd, state);
            }
        }

        if msg == WM_SIZE {
            if !state_ptr.is_null() {
                let state = &mut *state_ptr;
                if wparam == SIZE_MINIMIZED {
                    // Transition-only emit: WM_SIZE fires on every resize tick,
                    // so an unconditional emit would flood the event bus.
                    if !state.was_minimized {
                        use tauri::Emitter;
                        let _ = state.app.emit("made:window-minimized", true);
                        // Pane fan-out, Rust-to-Rust (no JS hop — the webview
                        // may already be throttled): minimize retains
                        // per-thread focus, so the focused pane's CLI never
                        // hears focus-out and a DECSET-1004 CLI (Claude)
                        // skips its notification escape while minimized.
                        crate::native_term::main_window_minimized();
                    }
                    state.was_minimized = true;
                } else {
                    if state.was_minimized {
                        use tauri::Emitter;
                        let _ = state.app.emit("made:window-minimized", false);
                        // See FOCUS_KICK_TIMER — Win+D restores foreground
                        // without keyboard focus; kick it into the webview
                        // once the restore burst settles.
                        SetTimer(hwnd, FOCUS_KICK_TIMER, FOCUS_KICK_MS, std::ptr::null());
                    }
                    state.was_minimized = false;
                    queue_webview_bounds_sync(hwnd, state);
                }
            }

            if wparam != SIZE_MINIMIZED {
                if wparam == SIZE_MAXIMIZED {
                    if !state_ptr.is_null() {
                        let state = &mut *state_ptr;
                        state.was_maximized = true;
                    }
                    let corner_pref = DWMWCP_DONOTROUND;
                    DwmSetWindowAttribute(
                        hwnd,
                        DWMWA_WINDOW_CORNER_PREFERENCE,
                        &corner_pref as *const u32 as *const c_void,
                        std::mem::size_of::<u32>() as u32,
                    );
                } else if wparam == SIZE_RESTORED {
                    let was_maximized = if state_ptr.is_null() {
                        false
                    } else {
                        let state = &mut *state_ptr;
                        std::mem::take(&mut state.was_maximized)
                    };
                    if was_maximized {
                        // Only re-apply rounded corners on the actual maximize ->
                        // restore edge, not on every drag tick.
                        let corner_pref = DWMWCP_ROUND;
                        DwmSetWindowAttribute(
                            hwnd,
                            DWMWA_WINDOW_CORNER_PREFERENCE,
                            &corner_pref as *const u32 as *const c_void,
                            std::mem::size_of::<u32>() as u32,
                        );
                        // A synchronous SWP_FRAMECHANGED with no size delta runs
                        // too early (inside the restore burst) and leaves DWM's
                        // stale accent frame. Defer a real recomposite instead.
                        if !state_ptr.is_null() {
                            let state = &mut *state_ptr;
                            queue_nc_recomposite(hwnd, state);
                        }
                    }
                }
            }
        }

        if msg == WM_NCCALCSIZE && wparam == 1 {
            let params = &mut *(lparam as *mut NCCALCSIZE_PARAMS);
            let r = &mut params.rgrc[0];
            // Resolve the monitor from the PROPOSED rect, not the current window
            // position — during maximize/display transitions they can disagree.
            let monitor = MonitorFromRect(r as *const RECT, MONITOR_DEFAULTTONEAREST);
            let mut mi = MONITORINFO {
                cb_size: std::mem::size_of::<MONITORINFO>() as u32,
                rc_monitor: RECT { left: 0, top: 0, right: 0, bottom: 0 },
                rc_work: RECT { left: 0, top: 0, right: 0, bottom: 0 },
                dw_flags: 0,
            };
            if GetMonitorInfoW(monitor, &mut mi) != 0 {
                if IsZoomed(hwnd) != 0 {
                    // Maximized: Windows sizes a WS_THICKFRAME window to the work
                    // area INFLATED by the frame width on every side. The client
                    // rect must be exactly the work area or content renders
                    // off-screen and clips at the edges (this is what tao's own
                    // NCCALCSIZE handler does; our subclass bypasses it).
                    *r = mi.rc_work;
                } else {
                    let (max_x, max_y) = frame_overshoot_limit(hwnd);
                    clamp_small_frame_overshoot(r, mi.rc_work, max_x, max_y);
                }
            }
            return 0;
        }
        // Default NC rendering is suppressed structurally above (WM_NCPAINT /
        // WM_NCACTIVATE / UAH messages); DWMWA_COLOR_NONE stays applied as the
        // documented belt-and-suspenders layer. DWMWCP_ROUND corners are a DWM
        // composition feature and are unaffected by any of it.
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    pub fn set_corner_preference(hwnd: *mut c_void, rounded: bool) {
        unsafe {
            let corner_pref = if rounded { DWMWCP_ROUND } else { DWMWCP_DONOTROUND };
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &corner_pref as *const u32 as *const c_void,
                std::mem::size_of::<u32>() as u32,
            );
        }
    }

    pub fn remove_border(hwnd: *mut c_void, controller: ICoreWebView2Controller, app: tauri::AppHandle) {
        unsafe {
            // 1) Suppress the all-sides accent border via DWMWA_COLOR_NONE +
            //    immersive dark. The window has no native shadow (no WS_THICKFRAME,
            //    shadow:false), so there is no DWM shadow frame and no intermittent
            //    top line on resize.
            apply_border_suppression(hwnd);

            // 2) Enable rounded corners (Windows 11+). DWM rounds the opaque
            //    borderless window; the opaque client (#131313) fills under the
            //    rounded mask, so no CSS corner work is needed.
            let corner_pref = DWMWCP_ROUND;
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &corner_pref as *const u32 as *const c_void,
                std::mem::size_of::<u32>() as u32,
            );

            // 3) Subclass the window to intercept WM_NCCALCSIZE (claim the full
            //    client rect so the frame is invisible) and re-apply border
            //    suppression on every state transition. It also owns a WebView2
            //    controller clone so drag-resize and cross-monitor DPI
            //    transitions can force the webview to the current client rect
            //    without resizing the parent window.
            let state = Box::new(BorderSubclassState {
                controller,
                app,
                sync_pending: false,
                recomposite_pending: false,
                was_minimized: false,
                was_maximized: false,
                last_synced_px: None,
            });
            SetWindowSubclass(
                hwnd,
                Some(subclass_proc),
                SUBCLASS_ID,
                Box::into_raw(state) as usize,
            );

            // 4) Align the initial WebView2 bounds with the new client rect.
            //    No WS_THICKFRAME is added: the native sizing frame is exactly
            //    what made DWM composite the (now-unwanted) native shadow and its
            //    intermittent 1px top line. Resizing is handled in JS via
            //    `startCustomWindowResize`, so the native frame is not needed.
            PostMessageW(hwnd, WM_SYNC_WEBVIEW_BOUNDS, 0, 0);
        }
    }
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn minimize_from_maximized(window: tauri::Window) {
    let hwnd = window.hwnd().expect("failed to get HWND");
    win32_border::minimize_to_normal(hwnd.0);
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn minimize_from_maximized() {
    // No-op on non-Windows — custom minimize only needed for Windows frameless windows
}

/// Register this app's AppUserModelID under HKCU so WinRT toast notifications
/// are deliverable (see the setup() call site for the full why). Idempotent —
/// `reg add /f` overwrites; runs off-thread so setup never waits on reg.exe.
/// The icon is embedded and re-written each launch: toasts resolve IconUri
/// lazily from disk, and app-local-data survives updates.
#[cfg(target_os = "windows")]
fn register_toast_aumid(app: &tauri::AppHandle) {
    use tauri::Manager;
    let identifier = app.config().identifier.clone();
    let display_name = app
        .config()
        .product_name
        .clone()
        .unwrap_or_else(|| "MADE".into());
    let icon_path = app
        .path()
        .app_local_data_dir()
        .ok()
        .map(|d| d.join("notif-icon.png"));
    std::thread::spawn(move || {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let key = format!(r"HKCU\Software\Classes\AppUserModelId\{identifier}");
        let reg_add = |value: &str, data: &str| {
            let _ = std::process::Command::new("reg")
                .args(["add", &key, "/v", value, "/t", "REG_SZ", "/d", data, "/f"])
                .creation_flags(CREATE_NO_WINDOW)
                .status();
        };
        reg_add("DisplayName", &display_name);
        if let Some(p) = icon_path {
            if let Some(dir) = p.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            if std::fs::write(&p, include_bytes!("../icons/128x128.png")).is_ok() {
                reg_add("IconUri", &p.to_string_lossy());
            }
        }
    });
}

#[tauri::command]
async fn ssh_ls(
    host: String,
    username: String,
    path: String,
    identity_file: Option<String>,
) -> Result<Vec<String>, String> {
    let user_host = format!("{}@{}", username, host);

    let mut cmd = Command::new("ssh");
    cmd.args(["-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5"]);

    if let Some(ref key) = identity_file {
        cmd.args(["-i", key]);
    }

    cmd.arg(&user_host);
    cmd.arg(format!(
        "ls -1pa {}",
        shell_escape(&path)
    ));

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run ssh: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("SSH ls failed: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let entries: Vec<String> = stdout
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect();

    Ok(entries)
}

#[tauri::command]
async fn ssh_mkdir(
    host: String,
    username: String,
    path: String,
    identity_file: Option<String>,
) -> Result<(), String> {
    let user_host = format!("{}@{}", username, host);

    let mut cmd = Command::new("ssh");
    cmd.args(["-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5"]);

    if let Some(ref key) = identity_file {
        cmd.args(["-i", key]);
    }

    cmd.arg(&user_host);
    // -p so it succeeds if the directory already exists; we still surface
    // errors like permission denied or invalid path.
    cmd.arg(format!("mkdir -p -- {}", shell_escape(&path)));

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run ssh: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("SSH mkdir failed: {}", stderr.trim()));
    }

    Ok(())
}

/// Pick a free local port for the tunnel. Try `preferred` first (so the URL
/// matches what the dev server printed); if it's taken, ask the OS for any
/// free loopback port.
fn pick_local_port(preferred: u16) -> Result<u16, String> {
    use std::net::TcpListener;
    if preferred != 0 {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", preferred)) {
            let port = listener.local_addr().map_err(|e| e.to_string())?.port();
            drop(listener);
            return Ok(port);
        }
    }
    let listener = TcpListener::bind(("127.0.0.1", 0u16))
        .map_err(|e| format!("Failed to allocate local port: {}", e))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    drop(listener);
    Ok(port)
}

/// Build a console-tool command that runs headlessly in the background.
/// On Windows we suppress the console window the same way `wsl_command` does.
pub(crate) fn hidden_command(program: &str) -> Command {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let mut cmd = Command::new(program);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new(program)
    }
}

/// Build an `ssh` command suitable for running headlessly in the background.
pub(crate) fn ssh_background_command() -> Command {
    #[cfg(target_os = "windows")]
    {
        hidden_command("ssh.exe")
    }
    #[cfg(not(target_os = "windows"))]
    {
        hidden_command("ssh")
    }
}

/// Expand a leading `~` to the user's home directory. The frontend hands us
/// `~/.ssh/...` paths, but `Command`/`std::fs` never go through a shell, so a
/// literal `~` would create a `~` folder relative to the process cwd.
pub(crate) fn expand_home(path: &str) -> Result<String, String> {
    if path == "~" || path.starts_with("~/") || path.starts_with("~\\") {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .map_err(|_| "Cannot determine home directory".to_string())?;
        if path == "~" {
            return Ok(home);
        }
        return Ok(format!("{}{}{}", home, std::path::MAIN_SEPARATOR, &path[2..]));
    }
    Ok(path.to_string())
}

/// Spawn `ssh -N -L <local>:localhost:<remote>` to forward a remote dev
/// server's port to the user's machine. Returns a handle id used by
/// `ssh_forward_port_stop` and the local port that was actually bound (may
/// differ from `preferred_local_port` if it was already in use).
#[tauri::command]
async fn ssh_forward_port_start(
    host: String,
    username: String,
    identity_file: Option<String>,
    remote_port: u16,
    preferred_local_port: Option<u16>,
    state: State<'_, SshForwardRegistry>,
) -> Result<SshForwardHandle, String> {
    if remote_port == 0 {
        return Err("remote_port must be > 0".into());
    }

    let local_port = pick_local_port(preferred_local_port.unwrap_or(remote_port))?;
    let user_host = format!("{}@{}", username, host);

    let mut cmd = ssh_background_command();
    cmd.args([
        "-N",
        "-o", "StrictHostKeyChecking=no",
        "-o", "ConnectTimeout=5",
        "-o", "ServerAliveInterval=30",
        "-o", "ServerAliveCountMax=3",
        "-o", "ExitOnForwardFailure=yes",
    ]);

    if let Some(ref key) = identity_file {
        cmd.args(["-i", key]);
    }

    cmd.args([
        "-L",
        &format!("127.0.0.1:{}:localhost:{}", local_port, remote_port),
        &user_host,
    ]);

    // Detach stdio so the child doesn't block on a pipe nobody is reading.
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start ssh tunnel: {}", e))?;

    let handle_id = state.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    state
        .forwards
        .lock()
        .map_err(|e| format!("forward registry poisoned: {}", e))?
        .insert(handle_id, child);

    Ok(SshForwardHandle { handle_id, local_port })
}

/// Kill a previously-started SSH port-forward. Idempotent — silently succeeds
/// if the handle is unknown (e.g. the tunnel already died on its own).
#[tauri::command]
async fn ssh_forward_port_stop(
    handle_id: u64,
    state: State<'_, SshForwardRegistry>,
) -> Result<(), String> {
    let mut child = {
        let mut map = state
            .forwards
            .lock()
            .map_err(|e| format!("forward registry poisoned: {}", e))?;
        match map.remove(&handle_id) {
            Some(c) => c,
            None => return Ok(()),
        }
    };
    let _ = child.kill();
    let _ = child.wait();
    Ok(())
}

#[tauri::command]
async fn ssh_test_connection(
    host: String,
    username: String,
    identity_file: Option<String>,
) -> Result<bool, String> {
    let user_host = format!("{}@{}", username, host);

    let mut cmd = ssh_background_command();
    cmd.args([
        "-o", "StrictHostKeyChecking=no",
        "-o", "ConnectTimeout=5",
        "-o", "BatchMode=yes",
    ]);

    if let Some(ref key) = identity_file {
        cmd.args(["-i", &expand_home(key)?]);
    }

    cmd.arg(&user_host);
    cmd.arg("echo ok");

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run ssh: {}", e))?;

    Ok(output.status.success())
}

/// Is anything listening on 127.0.0.1:<port>? The truthful "is this local dev
/// server still up" signal — the output-based stopped-detection watches for a
/// shell prompt at the end of the pane's buffer, and loses the race when the
/// dying server prints stragglers after the prompt. Async + spawn_blocking:
/// a sync command body runs inline on the WebView2 UI thread, and a connect
/// timeout there would freeze every command for its duration.
#[tauri::command]
async fn port_check(port: u16) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(600)).is_ok()
    })
    .await
    .unwrap_or(false)
}

/// Verify a macOS server's login-keychain password, unlocking the keychain for
/// THIS ssh session as a side effect.
///
/// The unlock itself is throwaway: every ssh login gets its own security
/// session, which is exactly why `getKeychainUnlockPreamble()` (src/lib/keychain.ts)
/// has to re-unlock inside each spawning pane. What this call buys is a VERDICT
/// — the frontend can prove a password before caching it, instead of finding out
/// it was wrong three failed tries later inside a pane that has already given up.
///
/// The password crosses on ssh's stdin, never in argv, so it never appears in the
/// remote `ps` output — the same guarantee the PTY preamble makes. It must never
/// be logged here either.
///
/// Returns "ok" (unlocked), "bad" (wrong password) or "nomac" (no `security`
/// binary, i.e. not a macOS server). `Err` means ssh itself failed.
#[tauri::command]
async fn ssh_unlock_keychain(
    host: String,
    username: String,
    identity_file: Option<String>,
    password: String,
) -> Result<String, String> {
    use std::io::Write;
    use std::process::Stdio;

    let user_host = format!("{}@{}", username, host);

    let mut cmd = ssh_background_command();
    cmd.args([
        "-o", "StrictHostKeyChecking=no",
        "-o", "ConnectTimeout=10",
        "-o", "BatchMode=yes",
    ]);
    if let Some(ref key) = identity_file {
        if !key.is_empty() {
            cmd.args(["-i", &expand_home(key)?]);
        }
    }
    cmd.arg(&user_host);
    // `read` takes the password off stdin; only sentinels ever reach stdout.
    // Same keychain path the PTY preamble unlocks.
    //
    // Wrapped in `sh -c` because ssh runs this through the user's LOGIN shell,
    // and `IFS= read -r` is not fish syntax — an unwrapped script would fail
    // parsing on a fish server and report an ssh error for a correct password.
    // Safe to single-quote: the script itself contains no single quotes.
    cmd.arg(concat!(
        "sh -c '",
        "if ! command -v security >/dev/null 2>&1; then echo NOMAC; exit 0; fi; ",
        "IFS= read -r MADE_PW; ",
        "if security unlock-keychain -p \"$MADE_PW\" ~/Library/Keychains/login.keychain-db >/dev/null 2>&1; ",
        "then echo OK; else echo BAD; fi",
        "'"
    ));
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn ssh: {}", e))?;

    {
        // Scoped so the handle drops here and the remote `read` sees EOF.
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "ssh stdin unavailable".to_string())?;
        stdin
            .write_all(format!("{}\n", password).as_bytes())
            .map_err(|e| format!("Failed to send password to ssh: {}", e))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for ssh: {}", e))?;

    match String::from_utf8_lossy(&output.stdout).trim() {
        "OK" => Ok("ok".to_string()),
        "BAD" => Ok("bad".to_string()),
        "NOMAC" => Ok("nomac".to_string()),
        _ => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stderr = stderr.trim();
            Err(if stderr.is_empty() {
                format!("Could not reach {} over SSH", host)
            } else {
                stderr.to_string()
            })
        }
    }
}

#[derive(Serialize)]
struct SshEnsureKeyResult {
    /// Absolute path to the private key (matches `ssh_list_keys` entries).
    key_path: String,
    public_key: String,
    created: bool,
}

/// Ensure an ed25519 keypair exists at `key_path` (a `~/…` path from the
/// frontend), generating it headlessly if missing. Idempotent.
#[tauri::command]
async fn ssh_ensure_key(key_path: String) -> Result<SshEnsureKeyResult, String> {
    let abs = expand_home(&key_path)?;
    let path = std::path::PathBuf::from(&abs);
    let pub_path = format!("{}.pub", abs);

    if path.exists() {
        let public_key = std::fs::read_to_string(&pub_path)
            .map_err(|e| format!("Key exists but public key is unreadable: {}", e))?;
        return Ok(SshEnsureKeyResult {
            key_path: abs,
            public_key: public_key.trim().to_string(),
            created: false,
        });
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create .ssh directory: {}", e))?;
    }

    let output = hidden_command("ssh-keygen")
        .args(["-t", "ed25519", "-f", &abs, "-N", ""])
        .output()
        .map_err(|e| format!("Failed to run ssh-keygen: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ssh-keygen failed: {}", stderr.trim()));
    }

    let public_key = std::fs::read_to_string(&pub_path)
        .map_err(|e| format!("Failed to read public key: {}", e))?;
    Ok(SshEnsureKeyResult {
        key_path: abs,
        public_key: public_key.trim().to_string(),
        created: true,
    })
}

/// Remove `host` from known_hosts (`ssh-keygen -R`). Used by the key-setup
/// wizard's "host key changed" recovery. A nonzero exit (host absent) is fine.
#[tauri::command]
async fn ssh_forget_host(host: String) -> Result<(), String> {
    hidden_command("ssh-keygen")
        .args(["-R", &host])
        .output()
        .map_err(|e| format!("Failed to run ssh-keygen -R: {}", e))?;
    Ok(())
}

#[derive(Serialize)]
struct SshKeyInfo {
    path: String,
    name: String,
    key_type: String,
    comment: String,
}

#[tauri::command]
async fn ssh_list_keys() -> Result<Vec<SshKeyInfo>, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "Cannot determine home directory".to_string())?;
    let ssh_dir = std::path::PathBuf::from(&home).join(".ssh");
    if !ssh_dir.exists() {
        return Ok(vec![]);
    }

    let mut keys = Vec::new();
    let entries = std::fs::read_dir(&ssh_dir)
        .map_err(|e| format!("Failed to read .ssh directory: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Read error: {}", e))?;
        let path = entry.path();
        if path.is_file() {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.ends_with(".pub") {
                    let private_name = &name[..name.len() - 4];
                    let private_path = ssh_dir.join(private_name);
                    if private_path.exists() && private_path.is_file() {
                        // Parse .pub file for type + comment
                        let (key_type, comment) = match std::fs::read_to_string(&path) {
                            Ok(content) => {
                                let parts: Vec<&str> = content.trim().splitn(3, ' ').collect();
                                let kt = parts.first()
                                    .map(|t| t.strip_prefix("ssh-").unwrap_or(t).to_string())
                                    .unwrap_or_default();
                                let cm = if parts.len() >= 3 {
                                    parts[2].trim().to_string()
                                } else {
                                    String::new()
                                };
                                (kt, cm)
                            }
                            Err(_) => (String::new(), String::new()),
                        };

                        keys.push(SshKeyInfo {
                            path: private_path.to_string_lossy().to_string(),
                            name: private_name.to_string(),
                            key_type,
                            comment,
                        });
                    }
                }
            }
        }
    }
    keys.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(keys)
}

#[tauri::command]
async fn ssh_read_file(
    host: String,
    username: String,
    path: String,
    identity_file: Option<String>,
) -> Result<String, String> {
    let user_host = format!("{}@{}", username, host);
    let mut cmd = Command::new("ssh");
    cmd.args(["-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5"]);
    if let Some(ref key) = identity_file {
        cmd.args(["-i", key]);
    }
    cmd.arg(&user_host);
    cmd.arg(format!("cat -- {}", shell_escape(&path)));

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run ssh: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("SSH read failed: {}", stderr.trim()));
    }

    String::from_utf8(output.stdout).map_err(|e| format!("File is not valid UTF-8: {}", e))
}

#[tauri::command]
async fn ssh_write_file(
    host: String,
    username: String,
    path: String,
    content: String,
    identity_file: Option<String>,
) -> Result<(), String> {
    use std::io::Write;
    use std::process::Stdio;

    let user_host = format!("{}@{}", username, host);
    let mut cmd = Command::new("ssh");
    cmd.args(["-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10"]);
    if let Some(ref key) = identity_file {
        cmd.args(["-i", key]);
    }
    cmd.arg(&user_host);
    // cat > <path> reads raw bytes from stdin until EOF — the remote shell never
    // interprets the content itself, only the path is shell-escaped.
    cmd.arg(format!("cat > {}", shell_escape(&path)));
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn ssh: {}", e))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(content.as_bytes())
            .map_err(|e| format!("Failed to stream content to ssh: {}", e))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for ssh: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("SSH write failed: {}", stderr.trim()));
    }

    Ok(())
}

/// Upload a local file to a remote SSH host as raw bytes.
/// Used for clipboard screenshots and drag-dropped files when the active
/// project is a remote SSH project — the local Windows path is meaningless
/// to the AI/CLI running on the remote host, so we copy the bytes over and
/// return the remote path for insertion into the terminal.
///
/// Enforces a 25 MB cap (config'd at the call site too) before touching ssh
/// to avoid silent slow uploads on large drag-dropped files.
#[tauri::command]
async fn ssh_upload_file_bytes(
    host: String,
    username: String,
    local_path: String,
    remote_path: String,
    identity_file: Option<String>,
) -> Result<String, String> {
    use std::io::Write;
    use std::process::Stdio;

    const MAX_BYTES: u64 = 25 * 1024 * 1024;

    let metadata = std::fs::metadata(&local_path)
        .map_err(|e| format!("Failed to stat local file: {}", e))?;
    let size = metadata.len();
    if size > MAX_BYTES {
        let mb = size as f64 / (1024.0 * 1024.0);
        return Err(format!(
            "File too large ({:.1} MB > 25 MB cap)",
            mb
        ));
    }

    let bytes = std::fs::read(&local_path)
        .map_err(|e| format!("Failed to read local file: {}", e))?;

    // Derive parent dir from remote_path so the remote shell can mkdir -p it.
    let remote_dir = match remote_path.rfind('/') {
        Some(0) => "/".to_string(),
        Some(i) => remote_path[..i].to_string(),
        None => ".".to_string(),
    };

    let user_host = format!("{}@{}", username, host);
    let mut cmd = Command::new("ssh");
    cmd.args(["-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10"]);
    if let Some(ref key) = identity_file {
        cmd.args(["-i", key]);
    }
    cmd.arg(&user_host);
    cmd.arg(format!(
        "mkdir -p {} && cat > {}",
        shell_escape(&remote_dir),
        shell_escape(&remote_path)
    ));
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn ssh: {}", e))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(&bytes)
            .map_err(|e| format!("Failed to stream bytes to ssh: {}", e))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for ssh: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("SSH upload failed: {}", stderr.trim()));
    }

    Ok(remote_path)
}

#[tauri::command]
async fn ssh_grep(
    host: String,
    username: String,
    directory: String,
    query: String,
    identity_file: Option<String>,
    max_results: Option<usize>,
) -> Result<Vec<SearchResult>, String> {
    let max = max_results.unwrap_or(100);
    let user_host = format!("{}@{}", username, host);
    let mut cmd = Command::new("ssh");
    cmd.args(["-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5"]);
    if let Some(ref key) = identity_file {
        cmd.args(["-i", key]);
    }
    cmd.arg(&user_host);
    // -r recursive, -n line numbers, -I skip binary, -H always-print-path, -F fixed-string.
    // 2>/dev/null to swallow "permission denied" noise. head caps output so a 1M-hit query
    // doesn't wedge the channel.
    cmd.arg(format!(
        "grep -rnIHF --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=target -- {} {} 2>/dev/null | head -n {}",
        shell_escape(&query),
        shell_escape(&directory),
        max
    ));

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run ssh: {}", e))?;

    // grep exits 1 when no matches — stdout empty, not an error.
    let stdout = String::from_utf8_lossy(&output.stdout);
    let results: Vec<SearchResult> = stdout
        .lines()
        .filter_map(|line| {
            // Format: /path/to/file:123:content (content may contain colons)
            let first_colon = line.find(':')?;
            let (file_path, rest) = line.split_at(first_colon);
            let rest = &rest[1..]; // drop the ':'
            let second_colon = rest.find(':')?;
            let (line_num_str, content) = rest.split_at(second_colon);
            let content = &content[1..]; // drop the ':'
            let line_number: usize = line_num_str.parse().ok()?;
            let file_name = file_path.rsplit('/').next().unwrap_or(file_path).to_string();
            Some(SearchResult {
                file_path: file_path.to_string(),
                file_name,
                line_number,
                line_content: content.to_string(),
            })
        })
        .collect();

    Ok(results)
}

#[tauri::command]
async fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e))
}

#[tauri::command]
async fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, &content).map_err(|e| format!("Failed to write file: {}", e))
}

/// Read a local image as a `data:` URI for the markdown preview.
///
/// Tauri's asset protocol is deliberately left disabled (enabling it would hand
/// the WebView a general read channel over the filesystem), and the CSP allows
/// `data:` for images already — so inlining is both the smaller change and the
/// tighter one. Reads stay behind this command, at the same trust level as
/// `read_file`.
#[tauri::command]
async fn read_image_data_uri(path: String) -> Result<String, String> {
    // Guard against inlining something enormous into the DOM. Markdown images
    // are screenshots and diagrams; anything past this is not a page asset.
    const MAX_BYTES: u64 = 16 * 1024 * 1024;

    let meta = std::fs::metadata(&path).map_err(|e| format!("Failed to read image: {}", e))?;
    if meta.len() > MAX_BYTES {
        return Err(format!("Image too large ({} bytes)", meta.len()));
    }

    let mime = match std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("bmp") => "image/bmp",
        Some("ico") => "image/x-icon",
        Some("avif") => "image/avif",
        _ => return Err("Unsupported image type".to_string()),
    };

    let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read image: {}", e))?;
    Ok(format!("data:{};base64,{}", mime, STANDARD.encode(&bytes)))
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum ScaffoldRole {
    Claude,
    Agents,
    Gemini,
    Custom,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScaffoldSpec {
    filename: String,
    source: Option<String>,
    role: ScaffoldRole,
}

fn pointer_stub(filename: &str) -> String {
    format!(
        "# {filename}\n\nThis project uses a single source of truth for AI agent instructions.\n\nSee [AGENTS.md](./AGENTS.md) for the canonical instructions.\n"
    )
}

fn is_safe_filename(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains(':')
        && !name.contains('*')
        && !name.contains('?')
        && !name.contains('"')
        && !name.contains('<')
        && !name.contains('>')
        && !name.contains('|')
        && name != "."
        && name != ".."
}

#[tauri::command]
async fn create_project(
    project_dir: String,
    scaffolds: Vec<ScaffoldSpec>,
    single_source_pointers: bool,
) -> Result<(), String> {
    std::fs::create_dir_all(&project_dir)
        .map_err(|e| format!("Failed to create directory: {}", e))?;

    let project_path = std::path::Path::new(&project_dir);

    let has_agents_with_source = scaffolds
        .iter()
        .any(|s| matches!(s.role, ScaffoldRole::Agents) && s.source.as_deref().map(|p| !p.is_empty()).unwrap_or(false));

    for scaffold in &scaffolds {
        if !is_safe_filename(&scaffold.filename) {
            return Err(format!("Invalid scaffold filename: {}", scaffold.filename));
        }
        let dest = project_path.join(&scaffold.filename);

        let is_agent = matches!(
            scaffold.role,
            ScaffoldRole::Claude | ScaffoldRole::Agents | ScaffoldRole::Gemini
        );

        // Pointer mode: write a stub for non-AGENTS agent files when AGENTS.md is canonical.
        if single_source_pointers
            && is_agent
            && !matches!(scaffold.role, ScaffoldRole::Agents)
            && has_agents_with_source
        {
            std::fs::write(&dest, pointer_stub(&scaffold.filename))
                .map_err(|e| format!("Failed to write pointer file {}: {}", scaffold.filename, e))?;
            continue;
        }

        // Normal path: copy template if source provided, else create empty file.
        match &scaffold.source {
            Some(src) if !src.is_empty() => {
                std::fs::copy(src, &dest)
                    .map_err(|e| format!("Failed to copy {}: {}", scaffold.filename, e))?;
            }
            _ => {
                std::fs::write(&dest, "")
                    .map_err(|e| format!("Failed to create {}: {}", scaffold.filename, e))?;
            }
        }
    }
    Ok(())
}

#[derive(Serialize)]
struct GitFileStatus {
    path: String,
    status: String,
    old_path: Option<String>,
}

#[derive(Serialize)]
struct GitBranchInfo {
    current: String,
    branches: Vec<String>,
}

#[derive(Serialize)]
struct FileEntry {
    name: String,
    path: String,
    is_directory: bool,
    size: u64,
}

#[derive(Serialize)]
struct SearchResult {
    file_path: String,
    file_name: String,
    line_number: usize,
    line_content: String,
}

#[tauri::command]
async fn list_dir(path: String) -> Result<Vec<FileEntry>, String> {
    let entries = std::fs::read_dir(&path)
        .map_err(|e| format!("Failed to read directory: {}", e))?;

    let mut dirs: Vec<FileEntry> = Vec::new();
    let mut files: Vec<FileEntry> = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files
        if name.starts_with('.') {
            continue;
        }

        let metadata = entry.metadata().map_err(|e| format!("Failed to read metadata: {}", e))?;
        let fe = FileEntry {
            name: name.clone(),
            path: entry.path().to_string_lossy().to_string(),
            is_directory: metadata.is_dir(),
            size: metadata.len(),
        };

        if metadata.is_dir() {
            dirs.push(fe);
        } else {
            files.push(fe);
        }
    }

    // Sort alphabetically within each group
    dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    // Dirs first, then files
    dirs.extend(files);
    Ok(dirs)
}

#[tauri::command]
async fn search_in_files(
    directory: String,
    query: String,
    max_results: Option<usize>,
) -> Result<Vec<SearchResult>, String> {
    let max = max_results.unwrap_or(100);
    let mut results: Vec<SearchResult> = Vec::new();
    let query_lower = query.to_lowercase();

    fn walk_dir(
        dir: &std::path::Path,
        query_lower: &str,
        results: &mut Vec<SearchResult>,
        max: usize,
    ) {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };

        for entry in entries {
            if results.len() >= max {
                return;
            }

            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };

            let name = entry.file_name().to_string_lossy().to_string();

            // Skip hidden and common ignored dirs
            if name.starts_with('.') {
                continue;
            }

            let path = entry.path();
            let metadata = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };

            if metadata.is_dir() {
                // Skip common large/irrelevant directories
                if matches!(name.as_str(), "node_modules" | "target" | "dist" | ".git" | "build" | "__pycache__") {
                    continue;
                }
                walk_dir(&path, query_lower, results, max);
            } else {
                // Skip binary/large files by extension
                let ext = path.extension()
                    .map(|e| e.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                if matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "ico" | "svg" | "woff" | "woff2" | "ttf" | "eot" | "mp3" | "mp4" | "zip" | "tar" | "gz" | "exe" | "dll" | "so" | "dylib" | "wasm" | "lock") {
                    continue;
                }

                // Skip large files (>1MB)
                if metadata.len() > 1_048_576 {
                    continue;
                }

                let content = match std::fs::read_to_string(&path) {
                    Ok(c) => c,
                    Err(_) => continue,
                };

                let file_name = name;
                let file_path = path.to_string_lossy().to_string();

                for (i, line) in content.lines().enumerate() {
                    if results.len() >= max {
                        return;
                    }
                    if line.to_lowercase().contains(query_lower) {
                        results.push(SearchResult {
                            file_path: file_path.clone(),
                            file_name: file_name.clone(),
                            line_number: i + 1,
                            line_content: line.trim().to_string(),
                        });
                    }
                }
            }
        }
    }

    let dir_path = std::path::Path::new(&directory);
    walk_dir(dir_path, &query_lower, &mut results, max);

    Ok(results)
}

/// Run a git command, routing through wsl.exe when the directory is a WSL UNC path
/// (e.g. `\\wsl.localhost\Ubuntu-24.04\home\...`). Windows git.exe can't use UNC
/// paths as current_dir, so we convert to a Linux path and run via wsl.exe.
fn run_git_owned(directory: &str, args: &[String]) -> Result<std::process::Output, String> {
    let strs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_git(directory, &strs)
}

/// Extract WSL distro and Linux path from a UNC path.
/// Returns None for non-WSL paths.
fn parse_wsl_path(directory: &str) -> Option<(String, String)> {
    let normalized = directory.replace('/', "\\");
    let is_wsl = normalized.starts_with("\\\\wsl.localhost\\") || normalized.starts_with("\\\\wsl$\\");
    if !is_wsl { return None; }
    let trimmed = normalized.trim_start_matches("\\\\wsl.localhost\\").trim_start_matches("\\\\wsl$\\");
    match trimmed.find('\\') {
        Some(pos) => Some((trimmed[..pos].to_string(), trimmed[pos..].replace('\\', "/"))),
        None => Some((trimmed.to_string(), "/".to_string())),
    }
}

/// Run a bash script in a directory, routing through WSL for UNC paths.
/// Pipes script through stdin (proven pattern — `bash -c` mangles multi-line args via wsl.exe).
fn run_bash_script(directory: &str, script: &str) -> Result<std::process::Output, String> {
    use std::io::Write;

    if let Some((distro, linux_path)) = parse_wsl_path(directory) {
        let full_script = format!("cd '{}' && {}", linux_path, script);
        let mut child = wsl_command()
            .args(["-d", &distro, "--", "bash"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn wsl: {}", e))?;

        if let Some(ref mut stdin) = child.stdin {
            let _ = stdin.write_all(full_script.as_bytes());
        }
        drop(child.stdin.take());

        child.wait_with_output()
            .map_err(|e| format!("Failed to wait for wsl: {}", e))
    } else {
        let mut child = Command::new("bash")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .current_dir(directory)
            .spawn()
            .map_err(|e| format!("Failed to spawn bash: {}", e))?;

        if let Some(ref mut stdin) = child.stdin {
            let _ = stdin.write_all(script.as_bytes());
        }
        drop(child.stdin.take());

        child.wait_with_output()
            .map_err(|e| format!("Failed to wait for bash: {}", e))
    }
}

fn run_git(directory: &str, args: &[&str]) -> Result<std::process::Output, String> {
    // Detect WSL UNC paths: \\wsl.localhost\Distro\... or \\wsl$\Distro\...
    let normalized = directory.replace('/', "\\");
    let is_wsl = normalized.starts_with("\\\\wsl.localhost\\") || normalized.starts_with("\\\\wsl$\\");

    if is_wsl {
        // Extract distro and convert to Linux path
        // \\wsl.localhost\Ubuntu-24.04\home\nicko\projects\nano → distro=Ubuntu-24.04, linux_path=/home/nicko/projects/nano
        let trimmed = normalized.trim_start_matches("\\\\wsl.localhost\\").trim_start_matches("\\\\wsl$\\");
        let (distro, linux_path) = match trimmed.find('\\') {
            Some(pos) => (&trimmed[..pos], trimmed[pos..].replace('\\', "/")),
            None => (trimmed, "/".to_string()),
        };

        // Use `cd <path> && git <args>` via bash — matches what the user
        // types in their shell exactly. `git -C` can behave subtly differently
        // (e.g. .gitignore resolution, submodule paths).
        let quoted_args: Vec<String> = args.iter()
            .map(|a| format!("'{}'", a.replace('\'', "'\\''")))
            .collect();
        let script = format!("cd '{}' && git {}", linux_path, quoted_args.join(" "));

        let mut child = wsl_command()
            .args(["-d", distro, "--", "bash", "-c", &script])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to run git via wsl: {}", e))?;

        child.wait_with_output()
            .map_err(|e| format!("Failed to wait for wsl git: {}", e))
    } else {
        Command::new("git")
            .args(args)
            .current_dir(directory)
            .output()
            .map_err(|e| format!("Failed to run git: {}", e))
    }
}

#[tauri::command]
async fn git_is_repo(directory: String) -> Result<bool, String> {
    let output = run_git(&directory, &["rev-parse", "--is-inside-work-tree"])?;
    Ok(output.status.success())
}

#[tauri::command]
async fn git_status(directory: String) -> Result<Vec<GitFileStatus>, String> {
    let output = run_git(&directory, &["status", "--porcelain", "-uall"])?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git status failed: {}", stderr.trim()));
    }

    // Parser lives in parse_status_porcelain (near the SSH commands) so the
    // local and remote paths cannot drift apart.
    Ok(parse_status_porcelain(&String::from_utf8_lossy(&output.stdout)))
}

#[tauri::command]
async fn git_diff(directory: String, file_path: Option<String>, compare_to: Option<String>) -> Result<String, String> {
    let mut combined = String::new();

    match &compare_to {
        Some(branch) => {
            // Compare against branch
            let mut args = vec!["diff".to_string(), format!("{}...HEAD", branch)];
            if let Some(ref fp) = file_path {
                args.push("--".to_string());
                args.push(fp.clone());
            }
            let output = run_git_owned(&directory, &args)?;
            combined = String::from_utf8_lossy(&output.stdout).to_string();
        }
        None => {
            // Unstaged changes
            let mut args1 = vec!["diff".to_string()];
            if let Some(ref fp) = file_path {
                args1.push("--".to_string());
                args1.push(fp.clone());
            }
            let output1 = run_git_owned(&directory, &args1)?;
            combined.push_str(&String::from_utf8_lossy(&output1.stdout));

            // Staged changes
            let mut args2 = vec!["diff".to_string(), "--cached".to_string()];
            if let Some(ref fp) = file_path {
                args2.push("--".to_string());
                args2.push(fp.clone());
            }
            let output2 = run_git_owned(&directory, &args2)?;
            combined.push_str(&String::from_utf8_lossy(&output2.stdout));
        }
    }

    Ok(combined)
}

#[tauri::command]
async fn git_branches(directory: String) -> Result<GitBranchInfo, String> {
    // Current branch — `git branch --show-current` (empty string in detached HEAD)
    let current_output = run_git(&directory, &["branch", "--show-current"])?;
    let current = String::from_utf8_lossy(&current_output.stdout).trim().to_string();
    let current = if current.is_empty() { "HEAD".to_string() } else { current };

    // Local branches only — remote branches can't be switched to directly.
    let branches_output = run_git(&directory, &["branch"])?;
    let branches: Vec<String> = String::from_utf8_lossy(&branches_output.stdout)
        .lines()
        .map(|l| l.trim().trim_start_matches("* ").trim_start_matches("remotes/").to_string())
        .filter(|l| !l.is_empty() && !l.contains("->"))
        .collect();

    Ok(GitBranchInfo { current, branches })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitDiffStats {
    files_changed: u32,
    insertions: u32,
    deletions: u32,
}

/// Parse a `git diff --shortstat` line like " 3 files changed, 156 insertions(+), 22 deletions(-)"
fn parse_shortstat(line: &str) -> (u32, u32, u32) {
    let mut files = 0u32;
    let mut ins = 0u32;
    let mut del = 0u32;
    for part in line.split(',') {
        let part = part.trim();
        if part.contains("file") {
            if let Some(n) = part.split_whitespace().next().and_then(|s| s.parse().ok()) {
                files = n;
            }
        } else if part.contains("insertion") {
            if let Some(n) = part.split_whitespace().next().and_then(|s| s.parse().ok()) {
                ins = n;
            }
        } else if part.contains("deletion") {
            if let Some(n) = part.split_whitespace().next().and_then(|s| s.parse().ok()) {
                del = n;
            }
        }
    }
    (files, ins, del)
}

#[tauri::command]
async fn git_diff_stats(directory: String) -> Result<GitDiffStats, String> {
    // Single bash script — one WSL process for all three values:
    //   files = git status --porcelain=v1 | wc -l
    //   add/del = git diff --numstat HEAD | awk sum
    let script = r#"
files=$(git status --porcelain=v1 | wc -l | tr -d ' ')
read add del <<<$(git diff --numstat HEAD 2>/dev/null | awk '{a+=$1; d+=$2} END {print a+0, d+0}')
echo "$files $add $del"
"#;

    let output = run_bash_script(&directory, script)?;
    let line = String::from_utf8_lossy(&output.stdout).trim().to_string();

    // Parse "files add del" e.g. "5 589 6"
    let parts: Vec<&str> = line.split_whitespace().collect();
    let files_changed = parts.first().and_then(|s| s.parse().ok()).unwrap_or(0);
    let insertions = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let deletions = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);

    Ok(GitDiffStats {
        files_changed,
        insertions,
        deletions,
    })
}

/// Create a new branch off `from_ref` (defaults to HEAD when empty). Validates
/// the name via `git check-ref-format` to reject whitespace / control chars /
/// special glob characters before they ever reach the working tree.
#[tauri::command]
async fn git_create_branch(
    directory: String,
    name: String,
    from_ref: Option<String>,
    switch: bool,
) -> Result<(), String> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Err("branch name is required".into());
    }

    // Canonical ref shape for branches.
    let full_ref = format!("refs/heads/{}", trimmed);
    let check = run_git(&directory, &["check-ref-format", &full_ref])?;
    if !check.status.success() {
        return Err(format!("Invalid branch name: {}", trimmed));
    }

    let from = from_ref.unwrap_or_default();
    let branch_args: Vec<&str> = if from.trim().is_empty() {
        vec!["branch", &trimmed]
    } else {
        vec!["branch", &trimmed, from.as_str()]
    };
    let out = run_git(&directory, &branch_args)?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }

    if switch {
        let sw = run_git(&directory, &["checkout", &trimmed])?;
        if !sw.status.success() {
            return Err(String::from_utf8_lossy(&sw.stderr).trim().to_string());
        }
    }
    Ok(())
}

#[tauri::command]
async fn git_switch_branch(directory: String, branch: String) -> Result<(), String> {
    let output = run_git(&directory, &["switch", &branch])?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.trim().to_string());
    }
    Ok(())
}

#[tauri::command]
async fn git_revert_hunk(directory: String, patch: String) -> Result<(), String> {
    let temp_dir = std::env::temp_dir();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp_path = temp_dir.join(format!("made-patch-{}-{}.patch", std::process::id(), nanos));

    std::fs::write(&temp_path, &patch)
        .map_err(|e| format!("Failed to write temp patch: {}", e))?;

    let output = Command::new("git")
        .args(["apply", "--reverse"])
        .arg(&temp_path)
        .current_dir(&directory)
        .output()
        .map_err(|e| format!("Failed to run git apply: {}", e))?;

    let _ = std::fs::remove_file(&temp_path);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git apply --reverse failed: {}", stderr.trim()));
    }

    Ok(())
}

#[tauri::command]
async fn git_discard_file(directory: String, file_path: String, is_untracked: bool) -> Result<(), String> {
    if is_untracked {
        let full_path = std::path::Path::new(&directory).join(&file_path);
        std::fs::remove_file(&full_path)
            .map_err(|e| format!("Failed to remove file: {}", e))?;
    } else {
        let output = run_git(&directory, &["checkout", "--", &file_path])?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git checkout failed: {}", stderr.trim()));
        }
    }
    Ok(())
}

#[tauri::command]
async fn git_add(directory: String, files: Vec<String>) -> Result<(), String> {
    if files.is_empty() { return Ok(()); }
    let mut args: Vec<String> = vec!["add".to_string(), "--".to_string()];
    args.extend(files);
    let output = run_git_owned(&directory, &args)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git add failed: {}", stderr.trim()));
    }
    Ok(())
}

#[tauri::command]
async fn git_reset_files(directory: String, files: Vec<String>) -> Result<(), String> {
    if files.is_empty() { return Ok(()); }
    let mut args: Vec<String> = vec!["reset".into(), "HEAD".into(), "--".into()];
    args.extend(files);
    let output = run_git_owned(&directory, &args)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git reset failed: {}", stderr.trim()));
    }
    Ok(())
}

#[tauri::command]
async fn git_commit(directory: String, message: String) -> Result<String, String> {
    let output = run_git(&directory, &["commit", "-m", &message])?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[tauri::command]
async fn git_push(directory: String, set_upstream: bool) -> Result<String, String> {
    let output = if set_upstream {
        run_git(&directory, &["push", "-u", "origin", "HEAD"])?
    } else {
        run_git(&directory, &["push"])?
    };
    // git push writes progress to stderr even on success
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        return Err(format!("{}\n{}", stdout.trim(), stderr.trim()).trim().to_string());
    }
    Ok(format!("{}\n{}", stdout.trim(), stderr.trim()).trim().to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitAheadBehind {
    ahead: u32,
    behind: u32,
    has_remote: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitPullResult {
    ok: bool,
    message: String,
    has_conflicts: bool,
    conflicts: Vec<String>,
}

/// Pull the current branch from origin. When `rebase` is true, uses
/// `git pull --rebase`. Conflict files are extracted from stderr when present.
#[tauri::command]
async fn git_pull(directory: String, rebase: bool) -> Result<GitPullResult, String> {
    let args: &[&str] = if rebase {
        &["pull", "--rebase"]
    } else {
        &["pull"]
    };
    let out = run_git(&directory, args)?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let combined = format!("{}\n{}", stdout, stderr).trim().to_string();

    if out.status.success() {
        return Ok(GitPullResult {
            ok: true,
            message: if combined.is_empty() {
                "Already up to date.".into()
            } else {
                combined
            },
            has_conflicts: false,
            conflicts: Vec::new(),
        });
    }

    // Detect conflicts. Git prints `CONFLICT (content): Merge conflict in <path>` or
    // `Merge conflict in <path>` lines.
    let mut conflicts: Vec<String> = Vec::new();
    for line in combined.lines() {
        if let Some(idx) = line.find("Merge conflict in ") {
            let path = line[idx + "Merge conflict in ".len()..].trim();
            if !path.is_empty() {
                conflicts.push(path.to_string());
            }
        }
    }
    let has_conflicts = !conflicts.is_empty();

    Ok(GitPullResult {
        ok: false,
        message: combined,
        has_conflicts,
        conflicts,
    })
}

/// Refresh origin's ref list without merging. Used to keep ahead/behind counts
/// honest without surprising the user with a merge.
#[tauri::command]
async fn git_fetch(directory: String) -> Result<String, String> {
    let out = run_git(&directory, &["fetch", "--prune"])?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let combined = format!("{}\n{}", stdout, stderr).trim().to_string();
    if !out.status.success() {
        return Err(combined);
    }
    Ok(if combined.is_empty() {
        "Fetched.".into()
    } else {
        combined
    })
}

#[tauri::command]
async fn git_ahead_behind(directory: String) -> Result<GitAheadBehind, String> {
    // Check if there's an upstream
    let upstream = run_git(&directory, &["rev-parse", "--abbrev-ref", "@{u}"]);
    match upstream {
        Ok(ref out) if out.status.success() => {},
        _ => return Ok(GitAheadBehind { ahead: 0, behind: 0, has_remote: false }),
    }
    // Count ahead/behind
    let output = run_git(&directory, &["rev-list", "--left-right", "--count", "HEAD...@{u}"])?;
    let line = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let parts: Vec<&str> = line.split('\t').collect();
    let ahead = parts.first().and_then(|s| s.parse().ok()).unwrap_or(0);
    let behind = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    Ok(GitAheadBehind { ahead, behind, has_remote: true })
}

// ── Git over SSH (READ-ONLY) ──────────────────────────────────────────────
//
// Every other git command in this file runs as a LOCAL process: `run_git` has a
// WSL branch for `\\wsl.localhost\…` UNC paths and a plain local spawn for
// everything else. Neither can reach another machine, so a remote project —
// whose `workingDir` is a path on the SSH host — had no git at all, and the
// status bar silently rendered nothing.
//
// These mirror the local commands as `ssh <user>@<host> "cd <dir> && git …"`,
// byte-for-byte the command the user would type in a shell pane on that box.
// What they report is therefore the remote repository's real state, not an
// approximation.
//
// READ-ONLY ON PURPOSE — nothing that mutates a repository is exposed here. A
// commit made over this path would be authored by the REMOTE machine's git
// identity and pushed with its credentials rather than the user's: a silent
// mis-attribution that is worse than the feature's absence. The user has a
// terminal on that host for writes.
//
// These deliberately do NOT refactor the local commands to share a backend.
// This crate only builds on Windows (the `windows` dependency is unconditional)
// and the machine this was authored on could not compile it, so touching six
// shipping commands would have meant shipping an unverifiable change to working
// code. Additive is the reversible choice. Only the status parser — the one
// piece big enough for a divergence to matter — is shared.

/// Parse `git status --porcelain` output. Shared by the local and SSH commands
/// so a fix to rename handling can never land in only one of them.
fn parse_status_porcelain(stdout: &str) -> Vec<GitFileStatus> {
    let mut files = Vec::new();

    for line in stdout.lines() {
        if line.len() < 3 { continue; }
        let status = line[..2].trim().to_string();
        let rest = &line[3..];

        // Handle renames: "R  old -> new"
        if status.starts_with('R') {
            if let Some(arrow_pos) = rest.find(" -> ") {
                files.push(GitFileStatus {
                    path: rest[arrow_pos + 4..].to_string(),
                    status,
                    old_path: Some(rest[..arrow_pos].to_string()),
                });
            } else {
                files.push(GitFileStatus { path: rest.to_string(), status, old_path: None });
            }
        } else {
            files.push(GitFileStatus { path: rest.to_string(), status, old_path: None });
        }
    }

    files
}

/// Run one command line on `user_host` and return its output.
///
/// `BatchMode=yes` is deliberate. These run on a 20-second poll, so a server
/// configured for password auth must fail FAST rather than leave an ssh process
/// parked on a prompt that nothing can answer — one stuck process per poll, for
/// as long as the tab is open.
fn run_ssh_remote(
    user_host: &str,
    identity_file: Option<&str>,
    remote_cmd: &str,
) -> Result<std::process::Output, String> {
    let mut cmd = Command::new("ssh");
    cmd.args([
        "-o", "StrictHostKeyChecking=no",
        "-o", "ConnectTimeout=5",
        "-o", "BatchMode=yes",
        "-o", "LogLevel=ERROR",
    ]);
    if let Some(key) = identity_file {
        cmd.args(["-i", key]);
    }
    cmd.arg(user_host);
    cmd.arg(remote_cmd);

    let output = cmd.output().map_err(|e| format!("Failed to run ssh: {}", e))?;

    // 255 is ssh's OWN failure code (refused, auth, host key) as distinct from
    // the remote command's exit status. Reporting it as an error is what keeps
    // "the server is unreachable" from being displayed as "not a git repository".
    if output.status.code() == Some(255) {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let detail = if err.is_empty() { "connection failed".to_string() } else { err };
        return Err(format!("ssh {}: {}", user_host, detail));
    }

    Ok(output)
}

/// `cd <directory> && git <args…>` on a remote host. Both the directory and
/// every argument are single-quoted for the REMOTE shell (`shell_escape`), so
/// paths with spaces — and branch names with anything else — survive intact.
fn run_git_ssh(
    host: &str,
    username: &str,
    identity_file: Option<&str>,
    directory: &str,
    args: &[&str],
) -> Result<std::process::Output, String> {
    let user_host = format!("{}@{}", username, host);
    let quoted: Vec<String> = args.iter().map(|a| shell_escape(a)).collect();
    let remote = format!("cd {} && git {}", shell_escape(directory), quoted.join(" "));
    run_ssh_remote(&user_host, identity_file, &remote)
}

#[tauri::command]
async fn git_is_repo_ssh(
    host: String,
    username: String,
    identity_file: Option<String>,
    directory: String,
) -> Result<bool, String> {
    let out = run_git_ssh(
        &host, &username, identity_file.as_deref(), &directory,
        &["rev-parse", "--is-inside-work-tree"],
    )?;
    Ok(out.status.success())
}

#[tauri::command]
async fn git_status_ssh(
    host: String,
    username: String,
    identity_file: Option<String>,
    directory: String,
) -> Result<Vec<GitFileStatus>, String> {
    let output = run_git_ssh(
        &host, &username, identity_file.as_deref(), &directory,
        &["status", "--porcelain", "-uall"],
    )?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git status failed: {}", stderr.trim()));
    }

    Ok(parse_status_porcelain(&String::from_utf8_lossy(&output.stdout)))
}

#[tauri::command]
async fn git_branches_ssh(
    host: String,
    username: String,
    identity_file: Option<String>,
    directory: String,
) -> Result<GitBranchInfo, String> {
    let current_output = run_git_ssh(
        &host, &username, identity_file.as_deref(), &directory,
        &["branch", "--show-current"],
    )?;
    let current = String::from_utf8_lossy(&current_output.stdout).trim().to_string();
    let current = if current.is_empty() { "HEAD".to_string() } else { current };

    let branches_output = run_git_ssh(
        &host, &username, identity_file.as_deref(), &directory,
        &["branch"],
    )?;
    let branches: Vec<String> = String::from_utf8_lossy(&branches_output.stdout)
        .lines()
        .map(|l| l.trim().trim_start_matches("* ").trim_start_matches("remotes/").to_string())
        .filter(|l| !l.is_empty() && !l.contains("->"))
        .collect();

    Ok(GitBranchInfo { current, branches })
}

#[tauri::command]
async fn git_diff_ssh(
    host: String,
    username: String,
    identity_file: Option<String>,
    directory: String,
    file_path: Option<String>,
    compare_to: Option<String>,
) -> Result<String, String> {
    let ident = identity_file.as_deref();
    let mut combined = String::new();

    match &compare_to {
        Some(branch) => {
            let range = format!("{}...HEAD", branch);
            let mut args: Vec<&str> = vec!["diff", &range];
            if let Some(ref fp) = file_path {
                args.push("--");
                args.push(fp.as_str());
            }
            let output = run_git_ssh(&host, &username, ident, &directory, &args)?;
            combined = String::from_utf8_lossy(&output.stdout).to_string();
        }
        None => {
            // Unstaged, then staged — same two-call shape as the local command,
            // so the parsed result is identical.
            let mut args1: Vec<&str> = vec!["diff"];
            if let Some(ref fp) = file_path {
                args1.push("--");
                args1.push(fp.as_str());
            }
            let out1 = run_git_ssh(&host, &username, ident, &directory, &args1)?;
            combined.push_str(&String::from_utf8_lossy(&out1.stdout));

            let mut args2: Vec<&str> = vec!["diff", "--cached"];
            if let Some(ref fp) = file_path {
                args2.push("--");
                args2.push(fp.as_str());
            }
            let out2 = run_git_ssh(&host, &username, ident, &directory, &args2)?;
            combined.push_str(&String::from_utf8_lossy(&out2.stdout));
        }
    }

    Ok(combined)
}

#[tauri::command]
async fn git_diff_stats_ssh(
    host: String,
    username: String,
    identity_file: Option<String>,
    directory: String,
) -> Result<GitDiffStats, String> {
    // POSIX only — no `<<<` herestring. The local twin runs under a bash we
    // control; the remote login shell may be dash, so a bashism would silently
    // produce zeros instead of an error. Output shape is identical: "files add del".
    let user_host = format!("{}@{}", username, host);
    let script = format!(
        "cd {} && files=$(git status --porcelain=v1 | wc -l | tr -d ' '); \
         nums=$(git diff --numstat HEAD 2>/dev/null | awk '{{a+=$1; d+=$2}} END {{print a+0, d+0}}'); \
         echo \"$files $nums\"",
        shell_escape(&directory)
    );

    let output = run_ssh_remote(&user_host, identity_file.as_deref(), &script)?;
    let line = String::from_utf8_lossy(&output.stdout).trim().to_string();

    let parts: Vec<&str> = line.split_whitespace().collect();
    let files_changed = parts.first().and_then(|s| s.parse().ok()).unwrap_or(0);
    let insertions = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let deletions = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);

    Ok(GitDiffStats { files_changed, insertions, deletions })
}

#[tauri::command]
async fn git_ahead_behind_ssh(
    host: String,
    username: String,
    identity_file: Option<String>,
    directory: String,
) -> Result<GitAheadBehind, String> {
    let ident = identity_file.as_deref();

    let upstream = run_git_ssh(
        &host, &username, ident, &directory,
        &["rev-parse", "--abbrev-ref", "@{u}"],
    );
    match upstream {
        Ok(ref out) if out.status.success() => {}
        // A missing upstream is not an error — it is the "no remote" answer. A
        // genuine ssh failure already returned Err from run_ssh_remote above.
        Ok(_) => return Ok(GitAheadBehind { ahead: 0, behind: 0, has_remote: false }),
        Err(e) => return Err(e),
    }

    let output = run_git_ssh(
        &host, &username, ident, &directory,
        &["rev-list", "--left-right", "--count", "HEAD...@{u}"],
    )?;
    let line = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let parts: Vec<&str> = line.split('\t').collect();
    let ahead = parts.first().and_then(|s| s.parse().ok()).unwrap_or(0);
    let behind = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    Ok(GitAheadBehind { ahead, behind, has_remote: true })
}

#[tauri::command]
async fn git_run_typecheck(directory: String) -> Result<String, String> {
    let script = r#"
if [ -f tsconfig.json ]; then
  npx tsc --noEmit 2>&1; echo "EXITCODE:$?"
elif [ -f Cargo.toml ]; then
  cargo check --all-targets 2>&1; echo "EXITCODE:$?"
elif ls *.csproj >/dev/null 2>&1 || ls *.sln >/dev/null 2>&1; then
  dotnet build --no-restore 2>&1; echo "EXITCODE:$?"
elif [ -f go.mod ]; then
  go vet ./... 2>&1; echo "EXITCODE:$?"
else
  echo "EXITCODE:SKIP"
fi
"#;
    let output = run_bash_script(&directory, script)?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if let Some(pos) = text.rfind("EXITCODE:") {
        let code_str = text[pos + 9..].trim();
        if code_str == "SKIP" {
            Ok("__SKIP__".to_string())
        } else {
            let code: i32 = code_str.parse().unwrap_or(-1);
            let errors = text[..pos].trim().to_string();
            if code == 0 {
                Ok(String::new())
            } else {
                Ok(errors)
            }
        }
    } else {
        Err(format!("Typecheck failed unexpectedly: {}", text))
    }
}

#[tauri::command]
async fn git_run_lint(directory: String) -> Result<String, String> {
    let script = r#"
if [ -f Makefile ] && grep -q '^lint:' Makefile 2>/dev/null; then
  make lint 2>&1; echo "EXITCODE:$?"
elif [ -f package.json ] && grep -q '"lint"' package.json 2>/dev/null; then
  PM="npm"
  [ -f pnpm-lock.yaml ] && PM="pnpm"
  [ -f yarn.lock ] && PM="yarn"
  $PM run lint 2>&1; echo "EXITCODE:$?"
elif [ -f pyproject.toml ] || [ -f ruff.toml ] || [ -f .ruff.toml ]; then
  if command -v ruff >/dev/null 2>&1; then
    ruff check . 2>&1; echo "EXITCODE:$?"
  elif command -v flake8 >/dev/null 2>&1; then
    flake8 . 2>&1; echo "EXITCODE:$?"
  else
    echo "EXITCODE:SKIP"
  fi
elif [ -f go.mod ]; then
  if command -v golangci-lint >/dev/null 2>&1; then
    golangci-lint run ./... 2>&1; echo "EXITCODE:$?"
  else
    echo "EXITCODE:SKIP"
  fi
elif [ -f Cargo.toml ]; then
  cargo clippy --all-targets --all-features 2>&1; echo "EXITCODE:$?"
elif [ -f pom.xml ]; then
  mvn checkstyle:check -q 2>&1; echo "EXITCODE:$?"
elif [ -f build.gradle ] || [ -f build.gradle.kts ]; then
  if [ -x ./gradlew ]; then
    ./gradlew check 2>&1; echo "EXITCODE:$?"
  elif command -v gradle >/dev/null 2>&1; then
    gradle check 2>&1; echo "EXITCODE:$?"
  else
    echo "EXITCODE:SKIP"
  fi
elif ls *.csproj >/dev/null 2>&1 || ls *.sln >/dev/null 2>&1; then
  dotnet format --verify-no-changes 2>&1; echo "EXITCODE:$?"
elif [ -f Gemfile ]; then
  if command -v rubocop >/dev/null 2>&1; then
    rubocop 2>&1; echo "EXITCODE:$?"
  else
    echo "EXITCODE:SKIP"
  fi
elif [ -f composer.json ]; then
  if command -v phpstan >/dev/null 2>&1; then
    phpstan analyse 2>&1; echo "EXITCODE:$?"
  elif command -v phpcs >/dev/null 2>&1; then
    phpcs . 2>&1; echo "EXITCODE:$?"
  else
    echo "EXITCODE:SKIP"
  fi
elif [ -f pubspec.yaml ]; then
  if command -v flutter >/dev/null 2>&1; then
    flutter analyze 2>&1; echo "EXITCODE:$?"
  elif command -v dart >/dev/null 2>&1; then
    dart analyze 2>&1; echo "EXITCODE:$?"
  else
    echo "EXITCODE:SKIP"
  fi
elif [ -f mix.exs ]; then
  if mix help credo >/dev/null 2>&1; then
    mix credo 2>&1; echo "EXITCODE:$?"
  else
    echo "EXITCODE:SKIP"
  fi
elif [ -f Package.swift ]; then
  if command -v swiftlint >/dev/null 2>&1; then
    swiftlint lint 2>&1; echo "EXITCODE:$?"
  else
    echo "EXITCODE:SKIP"
  fi
else
  echo "EXITCODE:SKIP"
fi
"#;
    let output = run_bash_script(&directory, script)?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if let Some(pos) = text.rfind("EXITCODE:") {
        let code_str = text[pos + 9..].trim();
        if code_str == "SKIP" {
            Ok("__SKIP__".to_string())
        } else {
            let code: i32 = code_str.parse().unwrap_or(-1);
            let errors = text[..pos].trim().to_string();
            if code == 0 {
                Ok(String::new())
            } else {
                Ok(errors)
            }
        }
    } else {
        Err(format!("Lint check failed unexpectedly: {}", text))
    }
}

#[tauri::command]
async fn git_run_tests(directory: String) -> Result<String, String> {
    let script = r#"
if [ -f Makefile ] && grep -q '^test:' Makefile 2>/dev/null; then
  make test 2>&1; echo "EXITCODE:$?"
elif [ -f package.json ] && grep -q '"test"' package.json 2>/dev/null; then
  PM="npm"
  [ -f pnpm-lock.yaml ] && PM="pnpm"
  [ -f yarn.lock ] && PM="yarn"
  CI=true $PM run test 2>&1; echo "EXITCODE:$?"
elif [ -f pyproject.toml ] || [ -f setup.py ] || [ -f setup.cfg ]; then
  if [ -d tests ] || [ -d test ] || grep -rq 'pytest' pyproject.toml 2>/dev/null || [ -f pytest.ini ] || [ -f conftest.py ]; then
    python3 -m pytest -q 2>&1; echo "EXITCODE:$?"
  else
    python3 -m unittest discover 2>&1; echo "EXITCODE:$?"
  fi
elif [ -f go.mod ]; then
  go test ./... 2>&1; echo "EXITCODE:$?"
elif [ -f Cargo.toml ]; then
  cargo test 2>&1; echo "EXITCODE:$?"
elif [ -f pom.xml ]; then
  mvn test -q 2>&1; echo "EXITCODE:$?"
elif [ -f build.gradle ] || [ -f build.gradle.kts ]; then
  if [ -x ./gradlew ]; then
    ./gradlew test 2>&1; echo "EXITCODE:$?"
  elif command -v gradle >/dev/null 2>&1; then
    gradle test 2>&1; echo "EXITCODE:$?"
  else
    echo "EXITCODE:SKIP"
  fi
elif ls *.csproj >/dev/null 2>&1 || ls *.sln >/dev/null 2>&1; then
  dotnet test 2>&1; echo "EXITCODE:$?"
elif [ -f Gemfile ]; then
  if [ -d spec ]; then
    bundle exec rspec 2>&1; echo "EXITCODE:$?"
  else
    bundle exec rake test 2>&1; echo "EXITCODE:$?"
  fi
elif [ -f composer.json ]; then
  if [ -x ./vendor/bin/phpunit ]; then
    ./vendor/bin/phpunit 2>&1; echo "EXITCODE:$?"
  else
    echo "EXITCODE:SKIP"
  fi
elif [ -f pubspec.yaml ]; then
  if command -v flutter >/dev/null 2>&1 && grep -q 'flutter' pubspec.yaml 2>/dev/null; then
    flutter test 2>&1; echo "EXITCODE:$?"
  elif command -v dart >/dev/null 2>&1; then
    dart test 2>&1; echo "EXITCODE:$?"
  else
    echo "EXITCODE:SKIP"
  fi
elif [ -f mix.exs ]; then
  mix test 2>&1; echo "EXITCODE:$?"
elif [ -f Package.swift ]; then
  swift test 2>&1; echo "EXITCODE:$?"
elif [ -f build.zig ]; then
  zig build test 2>&1; echo "EXITCODE:$?"
else
  echo "EXITCODE:SKIP"
fi
"#;
    let output = run_bash_script(&directory, script)?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if let Some(pos) = text.rfind("EXITCODE:") {
        let code_str = text[pos + 9..].trim();
        if code_str == "SKIP" {
            Ok("__SKIP__".to_string())
        } else {
            let code: i32 = code_str.parse().unwrap_or(-1);
            let errors = text[..pos].trim().to_string();
            if code == 0 {
                Ok(String::new())
            } else {
                Ok(errors)
            }
        }
    } else {
        Err(format!("Test check failed unexpectedly: {}", text))
    }
}

// ========================================================================
// GitHub CLI integration (gh)
// ========================================================================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GhStatus {
    installed: bool,
    authed: bool,
    user: Option<String>,
    /// "wsl" | "windows" | "macos" | "linux" — determines install guidance.
    platform: String,
}

/// Run `gh <args>` in `directory`, WSL-routing UNC paths (mirrors `run_git`).
fn run_gh(directory: &str, args: &[&str]) -> Result<std::process::Output, String> {
    if let Some((distro, linux_path)) = parse_wsl_path(directory) {
        let quoted_args: Vec<String> = args
            .iter()
            .map(|a| format!("'{}'", a.replace('\'', "'\\''")))
            .collect();
        let script = format!("cd '{}' && gh {}", linux_path, quoted_args.join(" "));

        let child = wsl_command()
            .args(["-d", &distro, "--", "bash", "-c", &script])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to run gh via wsl: {}", e))?;

        child
            .wait_with_output()
            .map_err(|e| format!("Failed to wait for wsl gh: {}", e))
    } else {
        Command::new("gh")
            .args(args)
            .current_dir(directory)
            .output()
            .map_err(|e| format!("Failed to run gh: {}", e))
    }
}

fn detect_repo_platform(directory: &str) -> String {
    if parse_wsl_path(directory).is_some() {
        "wsl".to_string()
    } else if cfg!(target_os = "windows") {
        "windows".to_string()
    } else if cfg!(target_os = "macos") {
        "macos".to_string()
    } else {
        "linux".to_string()
    }
}

#[tauri::command]
async fn gh_status(directory: String) -> Result<GhStatus, String> {
    let platform = detect_repo_platform(&directory);

    // `gh --version` doesn't need a repo — but we still route through the
    // directory so a WSL project probes gh-in-WSL, not gh-on-Windows.
    let installed = match run_gh(&directory, &["--version"]) {
        Ok(out) => out.status.success(),
        Err(_) => false,
    };

    if !installed {
        return Ok(GhStatus {
            installed: false,
            authed: false,
            user: None,
            platform,
        });
    }

    let auth_out = run_gh(&directory, &["auth", "status"])?;
    let authed = auth_out.status.success();

    // Combined stdout+stderr: gh writes auth status to stderr by design.
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&auth_out.stdout),
        String::from_utf8_lossy(&auth_out.stderr)
    );

    // Username lives on a line like "  ✓ Logged in to github.com account OhAhNicko (keyring)"
    let user = combined.lines().find_map(|line| {
        if let Some(tail) = line.split_once("account ").map(|(_, t)| t) {
            tail.split_whitespace().next().map(|s| s.to_string())
        } else if let Some(tail) = line.split_once(" as ").map(|(_, t)| t) {
            tail.split_whitespace()
                .next()
                .map(|s| s.trim_end_matches([',', '(', ')']).to_string())
        } else {
            None
        }
    });

    Ok(GhStatus {
        installed,
        authed,
        user,
        platform,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GhCreateRepoResult {
    url: String,
    output: String,
}

#[tauri::command]
async fn gh_create_repo(
    directory: String,
    name: String,
    visibility: String,
    description: Option<String>,
    push: bool,
) -> Result<GhCreateRepoResult, String> {
    let vis_flag = match visibility.as_str() {
        "public" => "--public",
        "private" => "--private",
        "internal" => "--internal",
        _ => return Err(format!("Invalid visibility: {}", visibility)),
    };

    // gh repo create supports `<owner>/<name>` or just `<name>` (uses default owner).
    // `--source=.` + `--remote=origin` adds origin in the current directory;
    // `--push` pushes HEAD afterwards.
    let mut args: Vec<String> = vec![
        "repo".into(),
        "create".into(),
        name.clone(),
        vis_flag.into(),
        "--source=.".into(),
        "--remote=origin".into(),
    ];
    if push {
        args.push("--push".into());
    }
    let desc_owned = description.unwrap_or_default();
    if !desc_owned.trim().is_empty() {
        args.push("--description".into());
        args.push(desc_owned);
    }

    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let output = run_gh(&directory, &arg_refs)?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}{}", stdout, stderr);

    if !output.status.success() {
        return Err(combined.trim().to_string());
    }

    // gh prints the repo URL in the output.
    let url = combined
        .split_whitespace()
        .find(|w| w.starts_with("https://github.com/"))
        .map(|s| s.trim_end_matches(['.', ',']).to_string())
        .unwrap_or_default();

    Ok(GhCreateRepoResult {
        url,
        output: combined.trim().to_string(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GhPrStatus {
    exists: bool,
    number: Option<i64>,
    url: Option<String>,
    state: Option<String>, // "OPEN" | "CLOSED" | "MERGED"
    title: Option<String>,
    is_draft: Option<bool>,
}

/// Look up whether the current branch already has a PR on origin. `gh pr view`
/// exits non-zero and prints to stderr when there is none — we swallow that
/// case and return exists=false.
#[tauri::command]
async fn gh_pr_status(directory: String) -> Result<GhPrStatus, String> {
    let out = run_gh(
        &directory,
        &["pr", "view", "--json", "number,url,state,title,isDraft"],
    )?;
    if !out.status.success() {
        return Ok(GhPrStatus {
            exists: false,
            number: None,
            url: None,
            state: None,
            title: None,
            is_draft: None,
        });
    }
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();

    // Minimal JSON parse — avoid pulling in serde_json machinery just for this.
    // The output is always a single object with the five fields above.
    fn extract_str(haystack: &str, key: &str) -> Option<String> {
        let pat = format!("\"{}\":", key);
        let start = haystack.find(&pat)? + pat.len();
        let rest = haystack[start..].trim_start();
        if rest.starts_with('"') {
            let inner = &rest[1..];
            inner.find('"').map(|end| inner[..end].to_string())
        } else {
            None
        }
    }
    fn extract_num(haystack: &str, key: &str) -> Option<i64> {
        let pat = format!("\"{}\":", key);
        let start = haystack.find(&pat)? + pat.len();
        let rest = haystack[start..].trim_start();
        let end = rest
            .find(|c: char| !c.is_ascii_digit() && c != '-')
            .unwrap_or(rest.len());
        rest[..end].parse().ok()
    }
    fn extract_bool(haystack: &str, key: &str) -> Option<bool> {
        let pat = format!("\"{}\":", key);
        let start = haystack.find(&pat)? + pat.len();
        let rest = haystack[start..].trim_start();
        if rest.starts_with("true") {
            Some(true)
        } else if rest.starts_with("false") {
            Some(false)
        } else {
            None
        }
    }

    Ok(GhPrStatus {
        exists: true,
        number: extract_num(&stdout, "number"),
        url: extract_str(&stdout, "url"),
        state: extract_str(&stdout, "state"),
        title: extract_str(&stdout, "title"),
        is_draft: extract_bool(&stdout, "isDraft"),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GhPrCreateResult {
    url: String,
    output: String,
}

/// Open a pull request for the current branch. The branch MUST already be
/// pushed to origin (caller handles that — typically via git_push).
#[tauri::command]
async fn gh_pr_create(
    directory: String,
    title: String,
    body: String,
    base: String,
    draft: bool,
) -> Result<GhPrCreateResult, String> {
    let mut args: Vec<&str> = vec!["pr", "create", "--title", &title, "--body", &body];
    if !base.is_empty() {
        args.push("--base");
        args.push(&base);
    }
    if draft {
        args.push("--draft");
    }
    let out = run_gh(&directory, &args)?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let combined = format!("{}{}", stdout, stderr);
    if !out.status.success() {
        return Err(combined.trim().to_string());
    }
    // gh pr create prints the PR URL on stdout (one line).
    let url = stdout
        .lines()
        .find(|l| l.contains("github.com") && l.contains("/pull/"))
        .map(|s| s.trim().to_string())
        .or_else(|| {
            stdout
                .split_whitespace()
                .find(|w| w.starts_with("https://github.com/"))
                .map(|s| s.to_string())
        })
        .unwrap_or_default();

    Ok(GhPrCreateResult {
        url,
        output: combined.trim().to_string(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GhReleaseResult {
    url: String,
    mode: String, // "created" | "edited"
    output: String,
}

/// Create a GitHub release with the given notes, or edit an existing one if
/// CI beat us to creating it. The tag must already exist on origin.
#[tauri::command]
async fn gh_release_create(
    directory: String,
    tag: String,
    title: String,
    body: String,
    draft: bool,
) -> Result<GhReleaseResult, String> {
    let mut create_args: Vec<&str> = vec![
        "release", "create", &tag, "--title", &title, "--notes", &body,
    ];
    if draft {
        create_args.push("--draft");
    }

    let create_out = run_gh(&directory, &create_args)?;
    let create_stdout = String::from_utf8_lossy(&create_out.stdout).to_string();
    let create_stderr = String::from_utf8_lossy(&create_out.stderr).to_string();
    let create_combined = format!("{}{}", create_stdout, create_stderr);

    if create_out.status.success() {
        let url = create_stdout
            .lines()
            .find(|l| l.contains("https://github.com/"))
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        return Ok(GhReleaseResult {
            url,
            mode: "created".into(),
            output: create_combined.trim().to_string(),
        });
    }

    // CI (tauri-action) may have created the release already. In that case
    // patch the existing draft with our generated notes.
    if create_combined.to_lowercase().contains("already exists") {
        let edit_args: Vec<&str> = vec![
            "release", "edit", &tag, "--title", &title, "--notes", &body,
        ];
        let edit_out = run_gh(&directory, &edit_args)?;
        let edit_stdout = String::from_utf8_lossy(&edit_out.stdout).to_string();
        let edit_stderr = String::from_utf8_lossy(&edit_out.stderr).to_string();
        let edit_combined = format!("{}{}", edit_stdout, edit_stderr);
        if edit_out.status.success() {
            let url = edit_stdout
                .lines()
                .find(|l| l.contains("https://github.com/"))
                .map(|s| s.trim().to_string())
                .unwrap_or_default();
            return Ok(GhReleaseResult {
                url,
                mode: "edited".into(),
                output: edit_combined.trim().to_string(),
            });
        }
        return Err(format!("gh release edit failed: {}", edit_combined.trim()));
    }

    Err(create_combined.trim().to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteInfo {
    url: String,
    owner: String,
    repo: String,
}

/// List commit subjects between `base..HEAD`. Used to prefill PR bodies.
/// Skips merges and the auto-generated `chore: bump version` commits.
#[tauri::command]
async fn git_commits_between(directory: String, base: String) -> Result<Vec<String>, String> {
    if base.trim().is_empty() {
        return Err("base is required".into());
    }
    let range = format!("{}..HEAD", base);
    let out = run_git(
        &directory,
        &["log", &range, "--no-merges", "--pretty=format:%s"],
    )?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let subjects: Vec<String> = text
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .filter(|l| !l.starts_with("chore: bump version"))
        .collect();
    Ok(subjects)
}

#[tauri::command]
async fn git_remote_info(directory: String) -> Result<RemoteInfo, String> {
    let out = run_git(&directory, &["remote", "get-url", "origin"])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let without_git = url.trim_end_matches(".git");

    let (owner, repo) = if let Some((_, tail)) = without_git.split_once("github.com") {
        let tail = tail.trim_start_matches(['/', ':']);
        match tail.split_once('/') {
            Some((o, r)) => (o.to_string(), r.to_string()),
            None => (String::new(), String::new()),
        }
    } else {
        (String::new(), String::new())
    };

    Ok(RemoteInfo {
        url: if owner.is_empty() || repo.is_empty() {
            url.clone()
        } else {
            format!("https://github.com/{}/{}", owner, repo)
        },
        owner,
        repo,
    })
}

// ========================================================================
// Release bump (mirrors the /release skill: bump project manifests → commit → tag → push)
// Works on any project. Detects which manifest files exist; the caller picks which
// ones to bump.
// ========================================================================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseStep {
    step: String,
    ok: bool,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestInfo {
    /// One of: "package.json", "Cargo.toml", "pyproject.toml", "tauri.conf.json"
    kind: String,
    /// Path relative to the project root.
    rel_path: String,
    /// Current version string read from the file.
    version: String,
}

fn read_text(path: &std::path::Path) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("read {}: {}", path.display(), e))
}

fn write_text(path: &std::path::Path, contents: &str) -> Result<(), String> {
    std::fs::write(path, contents).map_err(|e| format!("write {}: {}", path.display(), e))
}

/// Replace the first `"version": "<old>"` value with `new_version`, preserving
/// surrounding formatting. Works for both package.json and tauri.conf.json.
fn bump_json_version(contents: &str, new_version: &str) -> Result<String, String> {
    let key = "\"version\"";
    let key_at = contents
        .find(key)
        .ok_or("\"version\" field not found")?;
    let colon_rel = contents[key_at..]
        .find(':')
        .ok_or("malformed: no `:` after \"version\"")?;
    let after_colon = key_at + colon_rel + 1;
    let q1_rel = contents[after_colon..]
        .find('"')
        .ok_or("malformed: no opening quote on version value")?;
    let val_start = after_colon + q1_rel + 1;
    let q2_rel = contents[val_start..]
        .find('"')
        .ok_or("malformed: no closing quote on version value")?;
    let val_end = val_start + q2_rel;

    let mut out = String::with_capacity(contents.len());
    out.push_str(&contents[..val_start]);
    out.push_str(new_version);
    out.push_str(&contents[val_end..]);
    Ok(out)
}

/// Replace the first `version = "..."` under `[package]` in a Cargo.toml.
fn bump_cargo_version(contents: &str, new_version: &str) -> Result<String, String> {
    let pkg_at = contents
        .find("[package]")
        .ok_or("[package] section not found")?;
    let after_header = match contents[pkg_at..].find('\n') {
        Some(n) => pkg_at + n + 1,
        None => return Err("[package] section is empty".to_string()),
    };

    let mut cursor = after_header;
    let rest = &contents[after_header..];
    for line in rest.lines() {
        let line_len = line.len() + 1;
        let trimmed = line.trim_start();
        if trimmed.starts_with('[') {
            return Err("no `version = \"...\"` line under [package]".to_string());
        }
        if trimmed.starts_with("version") {
            // Find the quoted value on this line.
            let q1_rel = line
                .find('"')
                .ok_or("Cargo.toml version missing opening quote")?;
            let val_start_in_line = q1_rel + 1;
            let q2_rel = line[val_start_in_line..]
                .find('"')
                .ok_or("Cargo.toml version missing closing quote")?;

            let val_start = cursor + val_start_in_line;
            let val_end = val_start + q2_rel;

            let mut out = String::with_capacity(contents.len());
            out.push_str(&contents[..val_start]);
            out.push_str(new_version);
            out.push_str(&contents[val_end..]);
            return Ok(out);
        }
        cursor += line_len;
    }
    Err("no `version = \"...\"` line under [package]".to_string())
}

/// Read current version from package.json / tauri.conf.json.
fn read_json_version(contents: &str) -> Option<String> {
    let key = "\"version\"";
    let key_at = contents.find(key)?;
    let colon_rel = contents[key_at..].find(':')?;
    let after_colon = key_at + colon_rel + 1;
    let q1_rel = contents[after_colon..].find('"')?;
    let val_start = after_colon + q1_rel + 1;
    let q2_rel = contents[val_start..].find('"')?;
    Some(contents[val_start..val_start + q2_rel].to_string())
}

/// Read current version from a Cargo.toml [package] section.
fn read_cargo_version(contents: &str) -> Option<String> {
    let pkg_at = contents.find("[package]")?;
    let after_header = pkg_at + contents[pkg_at..].find('\n')? + 1;
    let rest = &contents[after_header..];
    for line in rest.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('[') {
            return None;
        }
        if trimmed.starts_with("version") {
            let q1 = line.find('"')?;
            let q2_rel = line[q1 + 1..].find('"')?;
            return Some(line[q1 + 1..q1 + 1 + q2_rel].to_string());
        }
    }
    None
}

/// Locate the `version = "..."` value in pyproject.toml under either
/// `[project]` or `[tool.poetry]`. Returns (value_start_offset, value_end_offset)
/// on match.
fn locate_pyproject_version(contents: &str) -> Option<(usize, usize)> {
    for header in ["[project]", "[tool.poetry]"] {
        let Some(h_at) = contents.find(header) else { continue };
        let after_header = h_at + contents[h_at..].find('\n')? + 1;
        let mut cursor = after_header;
        let rest = &contents[after_header..];
        for line in rest.lines() {
            let line_len = line.len() + 1;
            let trimmed = line.trim_start();
            if trimmed.starts_with('[') {
                break;
            }
            if trimmed.starts_with("version") {
                let q1 = line.find('"')?;
                let val_start_in_line = q1 + 1;
                let q2_rel = line[val_start_in_line..].find('"')?;
                let val_start = cursor + val_start_in_line;
                let val_end = val_start + q2_rel;
                return Some((val_start, val_end));
            }
            cursor += line_len;
        }
    }
    None
}

fn read_pyproject_version(contents: &str) -> Option<String> {
    let (val_start, val_end) = locate_pyproject_version(contents)?;
    Some(contents[val_start..val_end].to_string())
}

/// Replace `version = "..."` under `[project]` or `[tool.poetry]` in pyproject.toml.
fn bump_pyproject_version(contents: &str, new_version: &str) -> Result<String, String> {
    let (val_start, val_end) = locate_pyproject_version(contents)
        .ok_or("no `version = \"...\"` line under [project] or [tool.poetry]")?;
    let mut out = String::with_capacity(contents.len());
    out.push_str(&contents[..val_start]);
    out.push_str(new_version);
    out.push_str(&contents[val_end..]);
    Ok(out)
}

/// Scan the project root for known version-manifest files and return their
/// current versions. Checks both top-level and common nested locations
/// (e.g. `src-tauri/Cargo.toml` for Tauri projects).
#[tauri::command]
async fn detect_manifests(directory: String) -> Result<Vec<ManifestInfo>, String> {
    let dir = std::path::Path::new(&directory);
    // (kind, rel_path) — order determines display order in the UI.
    let candidates: &[(&str, &str)] = &[
        ("package.json", "package.json"),
        ("Cargo.toml", "Cargo.toml"),
        ("pyproject.toml", "pyproject.toml"),
        ("tauri.conf.json", "tauri.conf.json"),
        ("Cargo.toml", "src-tauri/Cargo.toml"),
        ("tauri.conf.json", "src-tauri/tauri.conf.json"),
    ];
    let mut out: Vec<ManifestInfo> = Vec::new();
    for (kind, rel) in candidates {
        let path = dir.join(rel);
        if !path.is_file() {
            continue;
        }
        let Ok(contents) = read_text(&path) else { continue };
        let version = match *kind {
            "package.json" | "tauri.conf.json" => read_json_version(&contents),
            "Cargo.toml" => read_cargo_version(&contents),
            "pyproject.toml" => read_pyproject_version(&contents),
            _ => None,
        };
        if let Some(v) = version {
            out.push(ManifestInfo {
                kind: (*kind).to_string(),
                rel_path: (*rel).to_string(),
                version: v,
            });
        }
    }
    Ok(out)
}

/// Returns true if `directory` looks like a Tauri project. The dev-server pane
/// uses this to auto-route the spawn into a Windows PowerShell pane: Tauri's
/// `npm run tauri:dev` compiles a native Windows app via the MSVC toolchain and
/// loads the `cli-win32-x64-msvc` NAPI binding, so running it inside WSL bash
/// fails with "Cannot find native binding" (the Linux binding isn't installed).
/// Checks the common Tauri v2 (`src-tauri/`) and v1 (top-level) manifest spots.
#[tauri::command]
fn is_tauri_project(directory: String) -> bool {
    let dir = std::path::Path::new(&directory);
    dir.join("src-tauri/tauri.conf.json").is_file()
        || dir.join("src-tauri/Cargo.toml").is_file()
        || dir.join("tauri.conf.json").is_file()
}

/// Build a markdown release-notes body from commits in `prev_tag..HEAD`.
/// Skips merge commits and the automated "chore: bump version …" commits so the
/// notes stay focused on real changes. Appends a GitHub compare link when an
/// origin URL is available.
fn generate_release_notes_body(directory: &str, prev_tag: &str, new_version: &str) -> String {
    let range = if prev_tag.is_empty() {
        String::from("HEAD")
    } else {
        format!("{}..HEAD", prev_tag)
    };
    let log_out = match run_git(directory, &["log", &range, "--no-merges", "--pretty=format:%s"]) {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => String::new(),
    };
    let bullets: Vec<String> = log_out
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .filter(|l| !l.starts_with("chore: bump version"))
        .map(|l| format!("- {}", l))
        .collect();
    let body_core = if bullets.is_empty() {
        String::from("- Maintenance release.")
    } else {
        bullets.join("\n")
    };
    let mut out = String::from("## What's changed\n\n");
    out.push_str(&body_core);

    if !prev_tag.is_empty() {
        if let Ok(remote_out) = run_git(directory, &["remote", "get-url", "origin"]) {
            if remote_out.status.success() {
                let raw = String::from_utf8_lossy(&remote_out.stdout).trim().to_string();
                let cleaned = raw.trim_end_matches(".git").to_string();
                let http_url = if cleaned.starts_with("git@") {
                    // git@github.com:owner/repo → https://github.com/owner/repo
                    cleaned
                        .replacen(":", "/", 1)
                        .replacen("git@", "https://", 1)
                } else {
                    cleaned
                };
                if http_url.contains("github.com") {
                    out.push_str(&format!(
                        "\n\n**Full changelog**: {}/compare/{}...v{}",
                        http_url, prev_tag, new_version
                    ));
                }
            }
        }
    }

    out
}

#[derive(Clone, serde::Serialize)]
struct VersionInstallProgress {
    downloaded: u64,
    total: Option<u64>,
}

/// Install a SPECIFIC released version — the Settings > Updates downgrade
/// path. Points the updater at that release tag's own latest.json (every
/// release publishes one, not just the latest) and accepts any version, so
/// it can go backwards. Signature verification against the app pubkey still
/// applies, same as a normal update. Must stay `async fn`: a sync command
/// would run this network round-trip inline on the WebView2 UI thread.
#[tauri::command]
async fn updater_install_version(
    app: tauri::AppHandle,
    version: String,
    on_progress: tauri::ipc::Channel<VersionInstallProgress>,
) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;

    // The tag goes into a URL — accept plain x.y.z semver only.
    if version.split('.').count() != 3
        || version
            .split('.')
            .any(|p| p.is_empty() || !p.chars().all(|c| c.is_ascii_digit()))
    {
        return Err(format!("invalid version: {version}"));
    }

    let url = format!(
        "https://github.com/OhAhNicko/SleekCode/releases/download/v{version}/latest.json"
    );

    let updater = app
        .updater_builder()
        .endpoints(vec![url
            .parse()
            .map_err(|e| format!("bad endpoint: {e}"))?])
        .map_err(|e| e.to_string())?
        .version_comparator(|_current, _remote| true) // allow downgrade / reinstall
        .build()
        .map_err(|e| e.to_string())?;

    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("release v{version} has no update manifest"))?;

    let mut downloaded: u64 = 0;
    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                let _ = on_progress.send(VersionInstallProgress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn release_bump(
    directory: String,
    new_version: String,
    manifest_paths: Vec<String>,
) -> Result<Vec<ReleaseStep>, String> {
    let mut steps: Vec<ReleaseStep> = Vec::new();
    let dir = std::path::Path::new(&directory);

    if manifest_paths.is_empty() {
        return Err("no manifests selected".into());
    }

    // Capture the previous tag BEFORE any commits land so the notes reflect
    // commits since the last release — not the upcoming version-bump commit.
    let prev_tag = match run_git(&directory, &["describe", "--tags", "--abbrev=0"]) {
        Ok(out) if out.status.success() => {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }
        _ => String::new(),
    };
    let notes_body = generate_release_notes_body(&directory, &prev_tag, &new_version);

    // --- Bump each selected manifest by file type.
    for rel in &manifest_paths {
        // Refuse absolute or ".."-bearing paths — caller must pass paths
        // relative to `directory`, otherwise an attacker-controlled frontend
        // could write to arbitrary filesystem locations (PathBuf::join
        // replaces the base when given an absolute path).
        let rel_trim = rel.trim_start_matches('/').trim_start_matches('\\');
        if std::path::Path::new(rel_trim).is_absolute() || rel_trim.contains("..") {
            steps.push(ReleaseStep {
                step: rel.clone(),
                ok: false,
                message: "manifest path must be relative and must not contain `..`".into(),
            });
            return Ok(steps);
        }
        let path = dir.join(rel_trim);
        // Derive bumper from the basename so nested paths (src-tauri/Cargo.toml) still work.
        let fname = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        let bump_result: Result<String, String> = read_text(&path).and_then(|c| match fname {
            "package.json" | "tauri.conf.json" => bump_json_version(&c, &new_version),
            "Cargo.toml" => bump_cargo_version(&c, &new_version),
            "pyproject.toml" => bump_pyproject_version(&c, &new_version),
            other => Err(format!("unsupported manifest: {}", other)),
        });
        match bump_result.and_then(|c| write_text(&path, &c)) {
            Ok(_) => steps.push(ReleaseStep {
                step: rel_trim.to_string(),
                ok: true,
                message: format!("version = {}", new_version),
            }),
            Err(e) => {
                steps.push(ReleaseStep {
                    step: rel_trim.to_string(),
                    ok: false,
                    message: e,
                });
                return Ok(steps);
            }
        }
    }

    // --- git add -A
    let add_out = run_git(&directory, &["add", "-A"])?;
    if !add_out.status.success() {
        steps.push(ReleaseStep {
            step: "git add -A".into(),
            ok: false,
            message: String::from_utf8_lossy(&add_out.stderr).trim().to_string(),
        });
        return Ok(steps);
    }
    steps.push(ReleaseStep {
        step: "git add -A".into(),
        ok: true,
        message: "staged".into(),
    });

    // --- git commit
    let commit_msg = format!("chore: bump version to {}", new_version);
    let commit_out = run_git(&directory, &["commit", "-m", &commit_msg])?;
    if !commit_out.status.success() {
        steps.push(ReleaseStep {
            step: "git commit".into(),
            ok: false,
            message: String::from_utf8_lossy(&commit_out.stderr).trim().to_string(),
        });
        return Ok(steps);
    }
    steps.push(ReleaseStep {
        step: "git commit".into(),
        ok: true,
        message: commit_msg,
    });

    // --- git tag vX.Y.Z
    let tag = format!("v{}", new_version);
    let tag_out = run_git(&directory, &["tag", &tag])?;
    if !tag_out.status.success() {
        steps.push(ReleaseStep {
            step: "git tag".into(),
            ok: false,
            message: String::from_utf8_lossy(&tag_out.stderr).trim().to_string(),
        });
        return Ok(steps);
    }
    steps.push(ReleaseStep {
        step: "git tag".into(),
        ok: true,
        message: tag,
    });

    // --- git push --follow-tags
    let push_out = run_git(&directory, &["push", "--follow-tags"])?;
    let push_msg = format!(
        "{}\n{}",
        String::from_utf8_lossy(&push_out.stdout).trim(),
        String::from_utf8_lossy(&push_out.stderr).trim()
    )
    .trim()
    .to_string();
    if !push_out.status.success() {
        steps.push(ReleaseStep {
            step: "git push --follow-tags".into(),
            ok: false,
            message: push_msg,
        });
        return Ok(steps);
    }
    steps.push(ReleaseStep {
        step: "git push --follow-tags".into(),
        ok: true,
        message: push_msg,
    });

    // Surface the generated notes to the frontend. The frontend picks this
    // step out by name and hands the body to `gh_release_create` — splitting
    // generation from upload lets the user edit before publishing.
    steps.push(ReleaseStep {
        step: "generate notes".into(),
        ok: true,
        message: notes_body,
    });

    Ok(steps)
}

#[derive(Serialize)]
struct ClipboardImageResult {
    path: String,
    data_uri: String,
}

#[derive(Serialize)]
struct ClipboardPollResult {
    seq: u32,
    image: Option<ClipboardImageResult>,
}

#[cfg(target_os = "windows")]
extern "system" {
    fn GetClipboardSequenceNumber() -> u32;
}

/// Fast clipboard poll: check if clipboard changed since `last_seq`.
/// Only reads the image (slow call) when the sequence number changes.
/// Returns the current sequence number and optionally the new image.
#[tauri::command]
async fn poll_clipboard_image(last_seq: u32) -> Result<ClipboardPollResult, String> {
    #[cfg(target_os = "windows")]
    {
        let seq = unsafe { GetClipboardSequenceNumber() };
        if seq == last_seq {
            return Ok(ClipboardPollResult { seq, image: None });
        }

        // Clipboard changed — try to read image
        match save_clipboard_image().await {
            Ok(result) => Ok(ClipboardPollResult {
                seq,
                image: Some(result),
            }),
            Err(_) => {
                // Clipboard changed but no image (e.g. text was copied)
                Ok(ClipboardPollResult { seq, image: None })
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        // macOS: use NSPasteboard changeCount (increments on each clipboard change)
        let output = Command::new("osascript")
            .args(["-e", "tell application \"System Events\" to return (the clipboard info)"])
            .output();
        // Simple hash of clipboard info as change counter
        let seq = match output {
            Ok(o) => {
                let s = String::from_utf8_lossy(&o.stdout);
                let mut hash: u32 = 0;
                for b in s.bytes() { hash = hash.wrapping_mul(31).wrapping_add(b as u32); }
                hash
            }
            Err(_) => 0,
        };

        if seq == last_seq {
            return Ok(ClipboardPollResult { seq, image: None });
        }

        match save_clipboard_image().await {
            Ok(result) => Ok(ClipboardPollResult { seq, image: Some(result) }),
            Err(_) => Ok(ClipboardPollResult { seq, image: None }),
        }
    }

    #[cfg(target_os = "linux")]
    {
        let _ = last_seq;
        Err("Clipboard polling not yet supported on Linux".to_string())
    }
}

/// Launch the screenshot tool (Snipping Tool on Windows, screencapture on macOS).
#[tauri::command]
async fn launch_snipping_tool() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // Start the Screen Sketch / Snip & Sketch overlay directly.
        // This opens the region-selection UI (same as Win+Shift+S).
        let _ = Command::new("cmd.exe")
            .args(["/C", "start", "ms-screenclip:"])
            .output();
    }
    #[cfg(target_os = "macos")]
    {
        // macOS interactive screenshot (region select, saves to clipboard)
        let _ = Command::new("screencapture")
            .args(["-i", "-c"])
            .output();
    }
    #[cfg(target_os = "linux")]
    {
        // Try common Linux screenshot tools
        let _ = Command::new("gnome-screenshot")
            .args(["-a", "-c"])
            .output()
            .or_else(|_| Command::new("xfce4-screenshooter")
                .args(["-r", "-c"])
                .output());
    }
    Ok(())
}

/// Copy an image file's pixel data to the system clipboard (not just the file
/// reference). On Windows uses PowerShell's WinForms clipboard API; on macOS
/// osascript with `«class PNGf»`; on Linux xclip.
#[tauri::command]
async fn copy_image_to_clipboard(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let script = format!(
            "Add-Type -AssemblyName System.Windows.Forms; \
             Add-Type -AssemblyName System.Drawing; \
             $img = [System.Drawing.Image]::FromFile('{}'); \
             [System.Windows.Forms.Clipboard]::SetImage($img); \
             $img.Dispose()",
            path.replace('\'', "''")
        );
        let out = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-STA", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("Failed to launch PowerShell: {}", e))?;
        if !out.status.success() {
            return Err(format!(
                "PowerShell exited {}: {}",
                out.status,
                String::from_utf8_lossy(&out.stderr)
            ));
        }
    }
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "set the clipboard to (read POSIX file \"{}\" as «class PNGf»)",
            path.replace('"', "\\\"")
        );
        let out = Command::new("osascript")
            .args(["-e", &script])
            .output()
            .map_err(|e| format!("Failed to launch osascript: {}", e))?;
        if !out.status.success() {
            return Err(format!(
                "osascript exited {}: {}",
                out.status,
                String::from_utf8_lossy(&out.stderr)
            ));
        }
    }
    #[cfg(target_os = "linux")]
    {
        use std::io::Write;
        let bytes = std::fs::read(&path).map_err(|e| format!("Read failed: {}", e))?;
        let mut child = Command::new("xclip")
            .args(["-selection", "clipboard", "-t", "image/png", "-i"])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to launch xclip: {}", e))?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(&bytes)
                .map_err(|e| format!("xclip write failed: {}", e))?;
        }
        let status = child
            .wait()
            .map_err(|e| format!("xclip wait failed: {}", e))?;
        if !status.success() {
            return Err(format!("xclip exited {}", status));
        }
    }
    Ok(())
}

/// Reveal a file in the platform's file manager (Explorer / Finder / xdg-open).
/// On Windows/macOS the file is selected in its parent folder.
#[tauri::command]
async fn reveal_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // Normalize forward slashes to backslashes for explorer.exe /select,
        let win_path = path.replace('/', "\\");
        let target = std::path::Path::new(&win_path);
        if target.exists() {
            // The path must be quoted ALONE, `/select,"C:\..."`. Passing the
            // whole token through .arg() makes std quote it in full
            // (`"/select,C:\..."`) whenever the path has spaces — which every
            // Snipping Tool original does — and explorer.exe fails that parse
            // by silently opening Documents instead.
            let _ = Command::new("explorer.exe")
                .raw_arg(format!("/select,\"{}\"", win_path))
                .spawn()
                .map_err(|e| format!("Failed to launch explorer: {}", e))?;
        } else if let Some(parent) = target.parent().filter(|p| p.exists()) {
            // File already deleted (temp sweep, manual cleanup) — its folder
            // is still a truthful answer, unlike the Documents fallback.
            let _ = Command::new("explorer.exe")
                .raw_arg(format!("\"{}\"", parent.display()))
                .spawn()
                .map_err(|e| format!("Failed to launch explorer: {}", e))?;
        } else {
            return Err(format!("File no longer exists: {}", win_path));
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("Failed to launch Finder: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| ".".to_string());
        let _ = Command::new("xdg-open")
            .arg(&parent)
            .spawn()
            .map_err(|e| format!("Failed to launch file manager: {}", e))?;
    }
    Ok(())
}

/// Open a DIRECTORY in the platform's file manager.
///
/// Distinct from `reveal_in_explorer`, which takes a FILE and selects it inside
/// its parent folder. Here the target itself is the folder to show, so no
/// `/select,` — that would open the parent with the folder highlighted instead.
/// The pane header's double-click-the-path action calls this; it had been
/// invoking a command that was never implemented, so it silently did nothing.
#[tauri::command]
async fn open_folder(path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("empty path".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        // explorer.exe wants backslashes; a forward-slash path opens "Documents".
        let win_path = path.replace('/', "\\");
        let _ = Command::new("explorer.exe")
            .arg(&win_path)
            .spawn()
            .map_err(|e| format!("Failed to launch explorer: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to launch Finder: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        let _ = Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to launch file manager: {}", e))?;
    }
    Ok(())
}

/// Read image from the clipboard and save as PNG.
/// Uses PowerShell on Windows, osascript/pngpaste on macOS.
/// Returns the file path and a data URI for thumbnail preview.
#[tauri::command]
async fn save_clipboard_image() -> Result<ClipboardImageResult, String> {
    let dir = std::env::temp_dir().join("made");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let filename = format!("clipboard-{}.png", timestamp);
    let path = dir.join(&filename);
    let path_str = path.to_string_lossy().to_string();

    #[cfg(target_os = "windows")]
    {
        // Use PowerShell to read image from Windows clipboard and save as PNG.
        let ps_path = path_str.replace('\'', "''");
        let script = format!(
            "Add-Type -AssemblyName System.Windows.Forms; \
             $img = [System.Windows.Forms.Clipboard]::GetImage(); \
             if ($img) {{ $img.Save('{}', [System.Drawing.Imaging.ImageFormat]::Png) }} \
             else {{ exit 1 }}",
            ps_path
        );

        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
            .map_err(|e| format!("Failed to run PowerShell: {}", e))?;

        if !output.status.success() || !path.exists() {
            return Err("No image in clipboard".to_string());
        }
    }

    #[cfg(target_os = "macos")]
    {
        // Try pngpaste first (brew install pngpaste), fall back to osascript
        let pngpaste = Command::new("pngpaste")
            .arg(&path_str)
            .output();

        if pngpaste.is_err() || !pngpaste.as_ref().unwrap().status.success() || !path.exists() {
            // Fallback: use osascript to save clipboard image
            let script = format!(
                "use framework \"AppKit\"\n\
                 set pb to current application's NSPasteboard's generalPasteboard()\n\
                 set imgData to pb's dataForType:(current application's NSPasteboardTypePNG)\n\
                 if imgData is missing value then error \"No image\"\n\
                 imgData's writeToFile:\"{}\" atomically:true",
                path_str.replace('"', "\\\"")
            );
            let output = Command::new("osascript")
                .args(["-l", "AppleScript", "-e", &script])
                .output()
                .map_err(|e| format!("Failed to run osascript: {}", e))?;

            if !output.status.success() || !path.exists() {
                return Err("No image in clipboard".to_string());
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        // Try xclip first, fall back to xsel
        let output = Command::new("xclip")
            .args(["-selection", "clipboard", "-t", "image/png", "-o"])
            .output();

        match output {
            Ok(o) if o.status.success() && !o.stdout.is_empty() => {
                std::fs::write(&path, &o.stdout)
                    .map_err(|e| format!("Failed to write clipboard image: {}", e))?;
            }
            _ => return Err("No image in clipboard".to_string()),
        }
    }

    // Read the saved PNG and encode as data URI for frontend thumbnail
    let png_bytes = std::fs::read(&path)
        .map_err(|e| format!("Failed to read saved image: {}", e))?;

    // Enforce 20MB limit
    if png_bytes.len() > 20 * 1024 * 1024 {
        let _ = std::fs::remove_file(&path);
        return Err("Image too large (max 20MB)".to_string());
    }

    let b64 = STANDARD.encode(&png_bytes);
    let data_uri = format!("data:image/png;base64,{}", b64);

    Ok(ClipboardImageResult {
        path: path_str,
        data_uri,
    })
}

/// Persist a marked-up screenshot the WebView composited on a canvas.
///
/// This is the ONLY path from renderer pixels to a file, and it exists because
/// nothing else in MADE can: `write_file` takes a `String`, there is no fs
/// plugin, and every consumer of a screenshot — `insertImagePath`, the prompt
/// composer's submit, `copy_image_to_clipboard` — needs a real path on disk.
///
/// Two invariants, both load-bearing:
///
/// 1. **PNG magic is validated before anything is written.** Without it this
///    command is an arbitrary-bytes-to-arbitrary-file primitive handed to the
///    WebView. The path is ours, so the only thing left to police is content.
/// 2. **The filename keeps the `clipboard-` prefix.** `screenshots_delete`
///    refuses temp paths that lack it, and `cleanup_clipboard_images` only
///    sweeps files that carry it — so any other naming scheme produces files
///    the user cannot delete and the app never collects.
#[tauri::command]
async fn save_annotated_image(base64_png: String) -> Result<ClipboardImageResult, String> {
    let bytes = STANDARD
        .decode(base64_png.as_bytes())
        .map_err(|e| format!("Not valid base64: {}", e))?;

    const PNG_MAGIC: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    if !bytes.starts_with(PNG_MAGIC) {
        return Err("Not a PNG".to_string());
    }
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("Image too large (max 20MB)".to_string());
    }

    let dir = std::env::temp_dir().join("made");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create temp dir: {}", e))?;

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let path = dir.join(format!("clipboard-{}.png", timestamp));

    std::fs::write(&path, &bytes).map_err(|e| format!("Failed to write image: {}", e))?;

    // Hand back the same data URI the caller already had rather than re-reading
    // and re-encoding several megabytes off disk.
    Ok(ClipboardImageResult {
        path: path.to_string_lossy().to_string(),
        data_uri: format!("data:image/png;base64,{}", base64_png),
    })
}

/// Clean up old clipboard images from the made temp directory.
#[tauri::command]
async fn cleanup_clipboard_images(max_age_secs: Option<u64>) -> Result<(), String> {
    let max_age = std::time::Duration::from_secs(max_age_secs.unwrap_or(86400));
    let dir = std::env::temp_dir().join("made");

    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(()), // Dir doesn't exist yet — nothing to clean
    };

    let now = std::time::SystemTime::now();

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("clipboard-") || !name.ends_with(".png") {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            if let Ok(modified) = meta.modified() {
                if let Ok(age) = now.duration_since(modified) {
                    if age > max_age {
                        let _ = std::fs::remove_file(entry.path());
                    }
                }
            }
        }
    }

    Ok(())
}

/// Simple shell escaping for paths (wraps in single quotes)
fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Resolve CLI paths and PATH inside WSL in one shot.
/// Returns a JSON-like map: { "PATH": "/usr/local/bin:...", "claude": "/home/.../.npm/bin/claude", ... }
///
/// NOTE: nvm can cause the exported PATH (seen by child processes) to differ from
/// bash's internal $PATH variable. Using `$()` subshells inherits the wrong PATH,
/// so `which` inside `$()` fails to find nvm-installed binaries. We avoid this by
/// running `which` as direct commands and using `env` to read the exported PATH.
#[tauri::command]
async fn wsl_resolve_cli_env(cli_names: Vec<String>, distro: Option<String>) -> Result<std::collections::BTreeMap<String, String>, String> {
    // Use a unique delimiter to parse multi-line output without $() subshells.
    // $() subshells inherit bash's internal $PATH which may lack nvm entries,
    // while direct child processes get the correct exported PATH.
    let delim = "___EZYDEV_DELIM___";
    let mut script_parts: Vec<String> = Vec::new();

    // Get the EXPORTED PATH via env (direct command, no $() subshell).
    // Using sed directly in pipeline avoids the subshell PATH problem.
    script_parts.push("env | sed -n 's/^PATH=/PATH=/p'".to_string());
    script_parts.push("echo \"DISTRO=$WSL_DISTRO_NAME\"".to_string());

    // Run each `which` as a direct command, separated by delimiters
    for name in &cli_names {
        script_parts.push(format!("echo \"{delim}{name}\""));
        script_parts.push(format!("which {} 2>/dev/null || true", name));
    }

    let script = script_parts.join("; ");

    let mut cmd = wsl_command();
    if let Some(ref d) = distro {
        cmd.args(["-d", d]);
    }
    let output = cmd
        .args(["--", "bash", "-lic", &script])
        .output()
        .map_err(|e| format!("Failed to run wsl: {}", e))?;

    if !output.status.success() {
        return Err("WSL command failed".to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut result = std::collections::BTreeMap::new();

    // Parse key=value lines (PATH, DISTRO)
    // Then parse delimited which output
    let mut current_cli: Option<String> = None;
    let mut resolved_any_cli = false;
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with(delim) {
            current_cli = Some(line[delim.len()..].to_string());
        } else if let Some(ref cli) = current_cli {
            // This line is the output of `which <cli>` — an absolute path
            if line.starts_with('/') {
                result.insert(cli.clone(), line.to_string());
                resolved_any_cli = true;
            }
            current_cli = None;
        } else if let Some((key, value)) = line.split_once('=') {
            let value = value.trim();
            if !value.is_empty() {
                result.insert(key.to_string(), value.to_string());
            }
        }
    }

    // Diagnostic seam (2026-07-30): resolvedPaths shipped {} on real hardware
    // for the app's entire storage history, while the identical script
    // resolved every CLI when run by hand (WSL-side, wsl.exe interop, and
    // PowerShell). The raw bytes the APP saw are the missing evidence — dump
    // them to the file log whenever zero CLIs resolve so the next startup
    // explains itself.
    if !resolved_any_cli && !cli_names.is_empty() {
        debug_log::dlog(&format!(
            "[wsl-resolve] 0 of {} CLIs resolved (distro={:?}); stdout={:?} stderr={:?}",
            cli_names.len(),
            distro,
            stdout,
            String::from_utf8_lossy(&output.stderr),
        ));
    }

    Ok(result)
}

/// List installed WSL distributions via `wsl.exe --list --quiet`.
///
/// UNLIKE every other wsl.exe use in this file, this runs a wsl.exe BUILT-IN
/// (no Linux process), and those print UTF-16LE — decoding as UTF-8 yields
/// N-U-L-interleaved garbage ("U\0b\0u\0..."). Decode u16 pairs explicitly.
#[tauri::command]
async fn wsl_list_distros() -> Result<Vec<String>, String> {
    let output = wsl_command()
        .args(["--list", "--quiet"])
        .output()
        .map_err(|e| format!("Failed to run wsl: {}", e))?;

    if !output.status.success() {
        return Err("wsl --list failed".to_string());
    }

    let units: Vec<u16> = output
        .stdout
        .chunks_exact(2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .collect();
    let text = String::from_utf16_lossy(&units);

    Ok(text
        .lines()
        .map(|l| l.trim_matches(['\r', '\0', ' ']).to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

/// Find the most recent Claude Code session ID for a given project.
/// Claude stores sessions at ~/.claude/projects/<encoded-path>/<uuid>.jsonl
/// where <encoded-path> replaces '/' with '-' in the absolute project path.
/// Case can vary (e.g. "Documents" vs "documents") on WSL with Windows paths.
#[tauri::command]
async fn get_claude_session_id(project_path: String, exclude_ids: Vec<String>, max_age_secs: Option<u64>, distro: Option<String>) -> Result<Option<String>, String> {
    let encoded = project_path.replace('/', "-");

    // Try exact match first, then case-insensitive glob for /mnt/ paths where
    // Windows case folding creates multiple folder variants (Documents vs documents).
    // When max_age_secs is set, use find -mmin to filter out stale sessions.
    let script = if let Some(age) = max_age_secs {
        let mmin_val = (age + 59) / 60; // ceiling division to minutes
        format!(
            "find ~/.claude/projects/{enc}/ -maxdepth 1 -name '*.jsonl' -mmin -{mmin} 2>/dev/null | xargs -r ls -1t 2>/dev/null | sed 's|.*/||;s|\\.jsonl$||'; \
             for d in ~/.claude/projects/*/; do \
               base=$(basename \"$d\"); \
               if [ \"$(echo \"$base\" | tr '[:upper:]' '[:lower:]')\" = \"$(echo '{enc}' | tr '[:upper:]' '[:lower:]')\" ] && [ \"$base\" != '{enc}' ]; then \
                 find \"$d\" -maxdepth 1 -name '*.jsonl' -mmin -{mmin} 2>/dev/null | xargs -r ls -1t 2>/dev/null | sed 's|.*/||;s|\\.jsonl$||'; \
               fi; \
             done",
            enc = encoded, mmin = mmin_val
        )
    } else {
        format!(
            "ls -1t ~/.claude/projects/{}/*.jsonl 2>/dev/null | sed 's|.*/||;s|\\.jsonl$||'; \
             for d in ~/.claude/projects/*/; do \
               base=$(basename \"$d\"); \
               if [ \"$(echo \"$base\" | tr '[:upper:]' '[:lower:]')\" = \"$(echo '{}' | tr '[:upper:]' '[:lower:]')\" ] && [ \"$base\" != '{}' ]; then \
                 ls -1t \"$d\"*.jsonl 2>/dev/null | sed 's|.*/||;s|\\.jsonl$||'; \
               fi; \
             done",
            encoded, encoded, encoded
        )
    };

    let output = wsl_command_in(distro.as_deref())
        .args(["--", "bash", "-lic", &script])
        .output()
        .map_err(|e| format!("Failed to query Claude sessions: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();

    if stdout.is_empty() {
        return Ok(None);
    }

    let is_valid_uuid = |s: &str| -> bool {
        s.len() == 36
            && s.split('-').count() == 5
            && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
    };

    // Return the first valid UUID that isn't in the exclude list
    // (exact-match results come first, then case-insensitive fallback)
    for line in stdout.lines() {
        let id = line.trim();
        if is_valid_uuid(id) && !exclude_ids.iter().any(|ex| ex == id) {
            return Ok(Some(id.to_string()));
        }
    }

    Ok(None)
}

/// Precise Claude session detection: scans ~/.claude/sessions/*.json
/// (pid-keyed sidecar files) for one that matches the given cwd and
/// started at/after `min_started_at_ms`. This is unambiguous — Claude CLI
/// writes one of these files per launch with pid/sessionId/cwd/startedAt.
#[tauri::command]
async fn get_claude_session_id_by_spawn(
    project_path: String,
    min_started_at_ms: u64,
    now_ms: u64,
    exclude_ids: Vec<String>,
    debug: bool,
    distro: Option<String>,
) -> Result<Option<String>, String> {
    let script = format!(
        r#"python3 -c "
import json, os, sys, glob, time
raw_cwd = (sys.argv[1] or '').rstrip('/')
cwd = raw_cwd.lower()
min_ms = int(sys.argv[2])
now_ms = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else 0
exclude = set(sys.argv[4].split(',')) if len(sys.argv) > 4 and sys.argv[4] else set()
debug = len(sys.argv) > 5 and sys.argv[5] == '1'
wsl_now = int(time.time() * 1000)
# startedAt is written by Claude INSIDE WSL, but min_ms/now_ms come from the
# Windows WebView clock. WSL2 clocks drift from Windows (esp. after sleep), so
# correct the floor into WSL time; otherwise a positive skew filters out the
# genuine just-spawned session and the resume is silently lost.
floor = min_ms + (wsl_now - now_ms) if now_ms > 0 else min_ms
# A sidecar's sessionId is PROVISIONAL: Claude rewrites it in place (same pid,
# same startedAt) and a third of all sidecars name a session that has no
# transcript. Adopting one of those hands the pane an id that --resume cannot
# find. Only ids with a transcript on disk are real, so resolve this project's
# transcript dir(s) up front — exact first, then the case-folded sibling that
# /mnt paths produce (Documents vs documents).
proj_root = os.path.expanduser('~/.claude/projects')
enc = raw_cwd.replace('/', '-')
tdirs = [os.path.join(proj_root, enc)]
try:
    for d in os.listdir(proj_root):
        if d.lower() == enc.lower() and d != enc:
            tdirs.append(os.path.join(proj_root, d))
except OSError:
    pass
def has_transcript(s):
    for d in tdirs:
        if os.path.exists(os.path.join(d, s + '.jsonl')):
            return True
    return False
best_id = None
best_started = -1
diag = []
for path in glob.glob(os.path.expanduser('~/.claude/sessions/*.json')):
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            v = json.load(f)
    except Exception:
        continue
    # Case- and trailing-slash-insensitive cwd compare: /mnt/c is case-folding so
    # the same project shows up as Documents/...2codeCC and documents/...2codecc.
    vcwd = (v.get('cwd') or '').rstrip('/').lower()
    if vcwd != cwd: continue
    started = v.get('startedAt', 0)
    if not isinstance(started, (int, float)): continue
    sid = v.get('sessionId', '')
    if not sid: continue
    if debug: diag.append('%s started=%d ok=%s excluded=%s transcript=%s' % (sid[:8], int(started), started >= floor, sid in exclude, has_transcript(sid)))
    if started < floor: continue
    if sid in exclude: continue
    if not has_transcript(sid): continue
    if started > best_started:
        best_started = started
        best_id = sid
if best_id: print(best_id)
if debug:
    sys.stderr.write('[by_spawn] cwd=%s floor=%d wsl_now=%d min_ms=%d now_ms=%d match=%s\n' % (cwd, floor, wsl_now, min_ms, now_ms, best_id))
    for d in diag: sys.stderr.write('  ' + d + '\n')
" '{cwd}' '{min_ms}' '{now_ms}' '{excl}' '{dbg}'"#,
        cwd = project_path.replace('\'', "'\\''"),
        min_ms = min_started_at_ms,
        now_ms = now_ms,
        excl = exclude_ids.join(","),
        dbg = if debug { "1" } else { "0" },
    );

    let output = wsl_command_in(distro.as_deref())
        .args(["--", "bash", "-lic", &script])
        .output()
        .map_err(|e| format!("Failed to query Claude session by spawn: {}", e))?;

    if debug {
        let se = String::from_utf8_lossy(&output.stderr);
        if !se.trim().is_empty() {
            eprintln!("[get_claude_session_id_by_spawn]\n{}", se.trim_end());
        }
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() { return Ok(None); }
    Ok(Some(stdout))
}

/// Native (macOS/Linux) variant of get_claude_session_id_by_spawn.
#[tauri::command]
async fn get_claude_session_id_by_spawn_native(
    project_path: String,
    min_started_at_ms: u64,
    now_ms: u64,
    exclude_ids: Vec<String>,
    debug: bool,
) -> Result<Option<String>, String> {
    let _ = now_ms; // native: session startedAt and the floor share one OS clock — no skew correction
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let sessions_dir = std::path::Path::new(&home).join(".claude").join("sessions");
    let transcript_dir = find_claude_project_dir(&home, &project_path, '/');
    scan_claude_sessions_dir(&sessions_dir, &project_path, min_started_at_ms, &exclude_ids, debug, transcript_dir.as_deref())
}

/// Windows variant of get_claude_session_id_by_spawn.
#[tauri::command]
async fn get_claude_session_id_by_spawn_windows(
    project_path: String,
    min_started_at_ms: u64,
    now_ms: u64,
    exclude_ids: Vec<String>,
    debug: bool,
) -> Result<Option<String>, String> {
    let _ = now_ms; // windows-native: same OS clock for startedAt and floor — no skew correction
    let home = std::env::var("USERPROFILE").map_err(|_| "USERPROFILE not set".to_string())?;
    let sessions_dir = std::path::Path::new(&home).join(".claude").join("sessions");
    let transcript_dir = find_claude_project_dir(&home, &project_path, '/');
    scan_claude_sessions_dir(&sessions_dir, &project_path, min_started_at_ms, &exclude_ids, debug, transcript_dir.as_deref())
}

/// Helper: scan a directory of pid-keyed session sidecars and return the
/// sessionId of the file with matching cwd, startedAt >= min_started_at_ms,
/// not in exclude_ids, with the greatest startedAt.
fn scan_claude_sessions_dir(
    sessions_dir: &std::path::Path,
    project_path: &str,
    min_started_at_ms: u64,
    exclude_ids: &[String],
    debug: bool,
    // Where this project's transcripts live. A sidecar's sessionId is
    // provisional (Claude rewrites it in place), so an id is only real once
    // `<transcript_dir>/<id>.jsonl` exists. `None` means Claude has never
    // written anything for this cwd — nothing here can be verified, so nothing
    // is returned rather than handing back an id --resume cannot find.
    transcript_dir: Option<&std::path::Path>,
) -> Result<Option<String>, String> {
    if !sessions_dir.is_dir() {
        return Ok(None);
    }
    let tdir = match transcript_dir {
        Some(d) => d,
        None => return Ok(None),
    };
    let entries = match std::fs::read_dir(sessions_dir) {
        Ok(e) => e,
        Err(_) => return Ok(None),
    };
    // Case- and trailing-slash-insensitive cwd compare. The same project can be
    // recorded with different casing (Documents vs documents) on Windows.
    let norm = |s: &str| s.trim_end_matches(|c| c == '/' || c == '\\').to_ascii_lowercase();
    let target = norm(project_path);
    let mut best: Option<(u64, String)> = None;
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.extension().map_or(false, |ext| ext == "json") { continue; }
        let data = match std::fs::read_to_string(&path) {
            Ok(d) => d,
            Err(_) => continue,
        };
        let v: serde_json::Value = match serde_json::from_str(&data) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let cwd = v.get("cwd").and_then(|c| c.as_str()).unwrap_or("");
        if norm(cwd) != target { continue; }
        let started = v.get("startedAt").and_then(|s| s.as_u64()).unwrap_or(0);
        let sid = v.get("sessionId").and_then(|s| s.as_str()).unwrap_or("");
        if debug {
            let short: String = sid.chars().take(8).collect();
            eprintln!(
                "[scan_claude_sessions_dir]   {} started={} ok={} excluded={}",
                short, started, started >= min_started_at_ms, exclude_ids.iter().any(|ex| ex == sid)
            );
        }
        if started < min_started_at_ms { continue; }
        if sid.is_empty() { continue; }
        if exclude_ids.iter().any(|ex| ex == sid) { continue; }
        if !tdir.join(format!("{}.jsonl", sid)).exists() { continue; }
        match &best {
            Some((b, _)) if *b >= started => {}
            _ => { best = Some((started, sid.to_string())); }
        }
    }
    if debug {
        eprintln!(
            "[scan_claude_sessions_dir] cwd={} floor={} match={:?}",
            target, min_started_at_ms, best.as_ref().map(|(_, s)| s)
        );
    }
    Ok(best.map(|(_, id)| id))
}

/// SQL predicate that keeps only threads the USER started.
///
/// Codex runs work of its own — the auto-approval reviewer, spawned sub-agents —
/// as separate rows in the same `threads` table, with the SAME `cwd` as the
/// pane that triggered them. They are touched after the user's own thread, so
/// an unfiltered "newest thread for this cwd" adopts the wrong one: the pane's
/// session id drifts onto a conversation nobody opened, its raw first message
/// becomes the pane title, and it is written into the project-session registry
/// permanently (nothing prunes Codex rows).
///
/// Matched with `lower(cwd)=lower(?)` at every call site, never `cwd=?`.
/// Codex STORES the cwd lowercased — a WSL pane in
/// `/mnt/c/Users/nikla/Documents/projects/CS 16` is filed under
/// `/mnt/c/users/nikla/documents/projects/cs 16` — and SQLite's `=` on TEXT is
/// case-sensitive, so the exact form matches nothing for any project whose path
/// contains a capital. There used to be a case-insensitive rescan guarded on
/// `path.startswith('/mnt/')`, which covered the WSL case by accident and left
/// macOS and Linux projects with capitals broken. Codex has already discarded
/// the original casing, so matching case-insensitively is the only thing that
/// can work.
///
/// Four independent markers, because Codex has not committed to one:
///   - `thread_spawn_edges.child_thread_id` — anything spawned BY another thread
///   - `agent_role` — non-null only on agent threads
///   - `thread_source` — 'user' on user threads; NULL on rows written before
///     the column existed, hence COALESCE rather than `= 'user'`
///   - `archived`
///
/// Every one of these is written by newer Codex versions only, so the query
/// MUST fall back to the unfiltered form when SQLite rejects this (see the
/// `except sqlite3.Error` in `codex_thread_query_py`) — an older
/// `state_5.sqlite` has no such column, and also has no agent threads to hide.
const CODEX_USER_THREAD_FILTER: &str = "AND COALESCE(archived,0)=0 \
     AND agent_role IS NULL \
     AND COALESCE(thread_source,'user')='user' \
     AND id NOT IN (SELECT child_thread_id FROM thread_spawn_edges)";

/// Python body shared by all three backends: print the newest non-excluded
/// USER thread for `argv[2]`, one id per line.
///
/// `argv[3]` is an optional `updated_at` FLOOR in host epoch ms and `argv[4]`
/// the host's clock when it was taken; `0` in either means "no floor" and is
/// what every caller but drift detection passes.
///
/// The floor exists because drift detection used to ask only "what is the
/// newest Codex thread in this cwd?". Claude's equivalent is anchored to the
/// pane's PTY spawn; Codex had no anchor at all, so a thread the user ran
/// OUTSIDE MADE in the same project — or a closed pane's thread touched more
/// recently — was adopted, written to the layout leaf, and resumed on the next
/// launch. A thread untouched since before this pane spawned cannot be the one
/// this pane is driving, which is exactly what the floor encodes.
///
/// It is spliced into `where`, never into the `%s` filter slot: `rows_for`
/// degrades on `sqlite3.Error` by re-running with the filter stripped, and the
/// floor has to survive that. `updated_at` (seconds) is used rather than the
/// newer `updated_at_ms` for the same reason — naming a column an older schema
/// lacks would trip that fallback and silently drop the user filter too.
///
/// The floor is translated into the CLOCK THAT WROTE `updated_at` before it is
/// compared. Codex writes it inside WSL, whose clock drifts from Windows (worst
/// after sleep), so comparing raw host ms would filter out the genuine session
/// — the same skew that broke `get_claude_session_id_by_spawn`. 5s of slack
/// absorbs the round trip.
///
/// `db_expr` is a Python expression evaluating to the `state_5.sqlite` path —
/// the WSL backend resolves `~` inside the guest, the other two are handed an
/// absolute host path. Keeping one body means the filter cannot drift between
/// backends, which is exactly how the three copies of this query diverged
/// before.
fn codex_thread_query_py(db_expr: &str) -> String {
    format!(
        r#"import sqlite3,os,sys,time
db={db_expr}
if not os.path.exists(db): sys.exit(0)
c=sqlite3.connect(db)
exclude=set(sys.argv[1].split(',')) if sys.argv[1] else set()
path=sys.argv[2]
def _int(i):
    try: return int(sys.argv[i]) if len(sys.argv)>i else 0
    except ValueError: return 0
min_ms=_int(3); now_ms=_int(4)
floor=0
if min_ms>0:
    floor=min_ms+((int(time.time()*1000)-now_ms) if now_ms>0 else 0)-5000
F="{filter}"
def rows_for(where,args):
    sql='SELECT id,cwd FROM threads WHERE '+where+' %s ORDER BY updated_at DESC LIMIT 50'
    try: return c.execute(sql%F,args).fetchall()
    except sqlite3.Error: return c.execute(sql%'',args).fetchall()
rows=rows_for('lower(cwd)=lower(?) AND COALESCE(updated_at,0)*1000 >= ?',(path,floor))
for r in rows:
    if r[0] not in exclude:
        print(r[0]); break
"#,
        db_expr = db_expr,
        filter = CODEX_USER_THREAD_FILTER,
    )
}

/// Python body: this project's Codex threads as a `SessionIndexEntry[]` JSON
/// array, newest first, capped at 30 — the same shape `build_sessions_list`
/// produces for Claude, so the session picker needs no per-CLI branch.
///
/// Degrades in tiers rather than failing: rich columns with the user filter,
/// rich without it, then id + `updated_at` only. An old `state_5.sqlite` has
/// neither the metadata columns nor any agent threads to hide, so the lean
/// tier is the honest answer there rather than an empty list.
fn codex_sessions_index_py(db_expr: &str) -> String {
    format!(
        r#"import sqlite3,os,sys,json,time
db={db_expr}
if not os.path.exists(db):
    print('[]'); sys.exit(0)
c=sqlite3.connect(db)
path=sys.argv[1]
F="{filter}"
RICH="id,COALESCE(title,''),COALESCE(first_user_message,''),COALESCE(updated_at,0),COALESCE(created_at,0),COALESCE(git_branch,'')"
LEAN="id,'','',COALESCE(updated_at,0),0,''"
def q(cols,filt,where,args):
    return c.execute('SELECT '+cols+' FROM threads WHERE '+where+' '+filt+' ORDER BY updated_at DESC LIMIT 30',args).fetchall()
def rows_for(where,args):
    for cols,filt in ((RICH,F),(RICH,''),(LEAN,F),(LEAN,'')):
        try: return q(cols,filt,where,args)
        except sqlite3.Error: continue
    return []
rows=rows_for('lower(cwd)=lower(?)',(path,))
def iso(s):
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(s)) if s else ''
print(json.dumps([{{
  "sessionId": r[0], "summary": r[1][:100], "customTitle": "",
  "firstPrompt": r[2][:100], "messageCount": 0,
  "created": iso(r[4]), "modified": iso(r[3]),
  "gitBranch": r[5], "isSidechain": False,
}} for r in rows]))
"#,
        db_expr = db_expr,
        filter = CODEX_USER_THREAD_FILTER,
    )
}

/// Newest Codex rollout whose `session_meta` names `project_path` as its cwd.
///
/// The `__latest__` read — what a pane uses before it has locked a session id —
/// used to take the newest rollout on the machine, unfiltered. A fresh pane
/// therefore showed a DIFFERENT project's model, context percentage and session
/// name for the first few seconds, which is worse than showing nothing.
fn find_codex_rollout_for_cwd(
    sessions_dir: &std::path::Path,
    project_path: &str,
) -> Option<std::path::PathBuf> {
    let mut files: Vec<(std::path::PathBuf, std::time::SystemTime)> = Vec::new();
    walk_jsonl(sessions_dir, &mut files);
    files.sort_by(|a, b| b.1.cmp(&a.1));
    for (path, _) in files.iter().take(60) {
        use std::io::BufRead;
        let Ok(file) = std::fs::File::open(path) else { continue };
        let Some(Ok(first)) = std::io::BufReader::new(file).lines().next() else { continue };
        if rollout_line_has_cwd(&first, project_path) && rollout_line_is_user_thread(&first) {
            return Some(path.clone());
        }
    }
    None
}

/// Collect every `*.jsonl` under `dir`, recursively, with its mtime.
/// Codex shards rollouts into `sessions/YYYY/MM/DD/`, so this cannot be flat.
fn walk_jsonl(dir: &std::path::Path, out: &mut Vec<(std::path::PathBuf, std::time::SystemTime)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_dir() {
            walk_jsonl(&path, out);
        } else if path.extension().map_or(false, |ext| ext == "jsonl") {
            if let Ok(m) = entry.metadata() {
                if let Ok(t) = m.modified() { out.push((path, t)); }
            }
        }
    }
}

/// Is this rollout's `session_meta` line a thread the USER started?
///
/// The SQLite path excludes Codex's own work — the auto-approval reviewer and
/// spawned sub-agents — via `CODEX_USER_THREAD_FILTER`. Every JSONL scanner
/// lacked the equivalent, so whenever SQLite yielded nothing they returned a
/// sub-agent id and the pane resumed a conversation nobody opened. The rollout
/// carries the same marker on its own first line:
///
///     "thread_source":"subagent","source":{"subagent":{"other":"guardian"}}
///
/// An ABSENT marker means a Codex old enough to have had no sub-agents to hide,
/// which is a user thread by construction — so absence must read as "user", not
/// as "unknown", or every pre-0.113 rollout becomes unresumable.
fn rollout_line_is_user_thread(first_line: &str) -> bool {
    !first_line.contains("\"thread_source\":\"subagent\"")
        && !first_line.contains("\"thread_source\": \"subagent\"")
}

/// Does this rollout's `session_meta` line name `project_path` as its cwd?
///
/// Case-insensitive on purpose. Codex lowercases the cwd it records for some
/// rollouts — a pane in `/mnt/c/Users/nikla/Documents/projects/CS 16` is filed
/// under `/mnt/c/users/nikla/documents/projects/cs 16` — so an exact compare
/// silently misses them. `aa73e00` fixed this for the SQLite queries and left
/// the file scanners behind.
fn rollout_line_has_cwd(first_line: &str, project_path: &str) -> bool {
    let line = first_line.to_ascii_lowercase();
    let p = project_path.to_ascii_lowercase();
    line.contains(&format!("\"cwd\":\"{}\"", p)) || line.contains(&format!("\"cwd\": \"{}\"", p))
}

// ── Gemini session files ──────────────────────────────────────────────────
//
// Gemini keeps chats at `~/.gemini/tmp/<project-dir>/chats/*.json`, where
// `<project-dir>` is derived from the project's BASENAME — so `~/a/web` and
// `~/b/web` land in the same or adjacent directories and cannot be told apart
// by path alone.
//
// The answer is to stop asking the directory. For a pane that has locked a
// session, the session ID is the authority: find the file that CONTAINS it and
// the directory layout stops mattering. Only the two cwd-scoped questions —
// "which sessions belong to this project" and "which is newest here" — still
// consult directory names, and those prefer an exact match before the
// `<basename>-…` prefix form.

/// Candidate `~/.gemini/tmp/<dir>` directories for a project, EXACT basename
/// match first, then the `<basename>-…` suffixed forms.
fn gemini_project_dirs(home: &str, project_path: &str) -> Vec<std::path::PathBuf> {
    let tmp_dir = std::path::Path::new(home).join(".gemini").join("tmp");
    let basename = project_path
        .replace('\\', "/")
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_lowercase();
    let mut exact = Vec::new();
    let mut prefixed = Vec::new();
    let Ok(entries) = std::fs::read_dir(&tmp_dir) else { return exact };
    for e in entries.filter_map(|e| e.ok()) {
        let name = e.file_name().to_string_lossy().to_lowercase();
        if basename.is_empty() {
            prefixed.push(e.path());
        } else if name == basename {
            exact.push(e.path());
        } else if name.starts_with(&format!("{}-", basename)) {
            prefixed.push(e.path());
        }
    }
    exact.extend(prefixed);
    exact
}

/// `<dir>/chats/*.json` under each of `dirs`, newest first.
fn gemini_chat_files(dirs: &[std::path::PathBuf]) -> Vec<std::path::PathBuf> {
    let mut files: Vec<(std::path::PathBuf, std::time::SystemTime)> = Vec::new();
    for d in dirs {
        let chats = d.join("chats");
        let Ok(entries) = std::fs::read_dir(&chats) else { continue };
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.extension().map_or(false, |ext| ext == "json") {
                if let Ok(m) = entry.metadata() {
                    if let Ok(t) = m.modified() { files.push((path, t)); }
                }
            }
        }
    }
    files.sort_by(|a, b| b.1.cmp(&a.1));
    files.into_iter().map(|(p, _)| p).collect()
}

/// The chat file whose `sessionId` is `session_id`, searched across EVERY
/// project directory.
///
/// Deliberately not scoped to the project: the id is unique and is the thing we
/// are sure of, whereas the directory is exactly what we cannot trust. This is
/// what the WSL backend has always done (`grep -rl "$SID"`); the native and
/// Windows ports dropped it and read whichever chat file was touched last on
/// the machine, so every Gemini pane on those backends showed the same — often
/// wrong — session.
fn find_gemini_chat_by_id(home: &str, session_id: &str) -> Option<std::path::PathBuf> {
    // Resolved paths are cached: the context poll asks every 5 seconds per
    // Gemini pane, and the search below reads whole conversation files until it
    // finds a match. The WSL script has always cached this for the same reason
    // (`/tmp/made-sessionpath-$SID`); this is the in-process equivalent.
    //
    // A session id names one file forever, so the only staleness worth handling
    // is deletion — hence the `exists()` re-check before trusting a hit.
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, std::path::PathBuf>>,
    > = std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));

    if let Ok(map) = cache.lock() {
        if let Some(hit) = map.get(session_id) {
            if hit.exists() { return Some(hit.clone()); }
        }
    }

    let tmp_dir = std::path::Path::new(home).join(".gemini").join("tmp");
    let all: Vec<std::path::PathBuf> = std::fs::read_dir(&tmp_dir)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .collect();
    for path in gemini_chat_files(&all) {
        let Ok(content) = std::fs::read_to_string(&path) else { continue };
        // Cheap reject before parsing — these files hold whole conversations.
        if !content.contains(session_id) { continue; }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) else { continue };
        if v.get("sessionId").and_then(|s| s.as_str()) == Some(session_id) {
            if let Ok(mut map) = cache.lock() {
                map.insert(session_id.to_string(), path.clone());
            }
            return Some(path);
        }
    }
    // Deliberately NOT cached as a miss: a pane locks its session id moments
    // before Gemini writes the file, so "not found" is routinely temporary.
    None
}

/// This project's Gemini chats as a `SessionIndexEntry[]` JSON array.
///
/// `firstPrompt` is left empty on purpose. The only fields this codebase has
/// ever confirmed in a Gemini chat file are `sessionId`, `summary`, and
/// `messages[].{model,tokens}` — there is no verified user-text field, and
/// guessing one would put fabricated names in the picker. `summary` plus the
/// modified time is what can be stated truthfully.
fn gemini_sessions_list(home: &str, project_path: &str) -> Result<String, String> {
    let dirs = gemini_project_dirs(home, project_path);
    let mut items: Vec<serde_json::Value> = Vec::new();
    for path in gemini_chat_files(&dirs).into_iter().take(30) {
        let Ok(content) = std::fs::read_to_string(&path) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) else { continue };
        let Some(sid) = v.get("sessionId").and_then(|s| s.as_str()) else { continue };
        let mtime = iso8601_utc(file_mtime_ms(&path));
        let summary: String = v
            .get("summary")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .chars()
            .take(100)
            .collect();
        items.push(serde_json::json!({
            "sessionId": sid,
            "summary": summary,
            "customTitle": "",
            "firstPrompt": "",
            "messageCount": 0,
            "created": mtime,
            "modified": mtime,
            "gitBranch": "",
            "isSidechain": false,
        }));
    }
    serde_json::to_string(&items).map_err(|e| e.to_string())
}

/// Find the most recent Codex session ID for a given project.
/// Codex ≥0.113 stores sessions in ~/.codex/state_5.sqlite `threads` table.
/// Falls back to JSONL file scanning for older versions.
#[tauri::command]
async fn get_codex_session_id(
    project_path: String,
    exclude_ids: Vec<String>,
    distro: Option<String>,
    min_updated_at_ms: Option<u64>,
    now_ms: Option<u64>,
) -> Result<Option<String>, String> {
    let is_valid_uuid = |s: &str| -> bool {
        s.len() == 36
            && s.split('-').count() == 5
            && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
    };

    // Primary: query SQLite threads table (Codex ≥0.113), matched with
    // `lower(cwd)=lower(?)` — see CODEX_USER_THREAD_FILTER for why.
    //
    // The body arrives over a QUOTED heredoc (`<<'PY'`), not inside a
    // double-quoted `python3 -c "…"` as it used to: the shared query uses both
    // quote characters, and the old form would have been terminated early by
    // the first `"` in it. A quoted delimiter also disables every shell
    // expansion, so nothing in the script needs escaping.
    let exclude_csv = exclude_ids.join(",");
    let script = format!(
        "python3 - '{}' '{}' '{}' '{}' <<'MADE_CODEX_PY'\n{}MADE_CODEX_PY\n",
        exclude_csv.replace('\'', "'\\''"),
        project_path.replace('\'', "'\\''"),
        min_updated_at_ms.unwrap_or(0),
        now_ms.unwrap_or(0),
        codex_thread_query_py("os.path.expanduser('~/.codex/state_5.sqlite')"),
    );

    let output = wsl_command_in(distro.as_deref())
        .args(["--", "bash", "-lic", &script])
        .output()
        .map_err(|e| format!("Failed to query Codex sessions: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stdout.is_empty() {
        for line in stdout.lines() {
            let id = line.trim();
            if is_valid_uuid(id) {
                return Ok(Some(id.to_string()));
            }
        }
    }

    // A floor was requested and SQLite did not answer above it. The JSONL
    // fallback ranks by file mtime and cannot honour the floor, so running it
    // here would hand back exactly the unanchored "newest thread in this cwd"
    // the floor exists to reject. No answer is the correct answer.
    if min_updated_at_ms.unwrap_or(0) > 0 {
        return Ok(None);
    }

    // Fallback: scan JSONL files (Codex <0.113). `grep -v` drops Codex's own
    // sub-agent rollouts, which the SQLite path excludes via
    // CODEX_USER_THREAD_FILTER and this pipeline used to return happily.
    let fallback_script = format!(
        "find ~/.codex/sessions -name '*.jsonl' -type f 2>/dev/null | xargs ls -1t 2>/dev/null | head -20 | xargs -I{{}} head -1 {{}} 2>/dev/null | grep -i '\"cwd\":\"{}\"' | grep -v '\"thread_source\":\"subagent\"' | grep -oE '\"id\":\"[0-9a-f]{{8}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{12}}\"' | sed 's/\"id\":\"//;s/\"//'",
        project_path.replace('\'', "'\\''")
    );

    let output = wsl_command_in(distro.as_deref())
        .args(["--", "bash", "-lic", &fallback_script])
        .output()
        .map_err(|e| format!("Failed to query Codex sessions (fallback): {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    for line in stdout.lines() {
        let id = line.trim();
        if is_valid_uuid(id) && !exclude_ids.iter().any(|ex| ex == id) {
            return Ok(Some(id.to_string()));
        }
    }

    Ok(None)
}

/// Find the most recent Gemini session ID for a given project.
/// Gemini stores sessions at ~/.gemini/tmp/<project_name>/chats/session-<ts>-<partial_uuid>.json
/// where <project_name> is the lowercased directory basename (with optional -N suffix for collisions).
/// The JSON is pretty-printed; "sessionId" is on line 2.
#[tauri::command]
async fn get_gemini_session_id(project_path: String, exclude_ids: Vec<String>, distro: Option<String>) -> Result<Option<String>, String> {
    // Extract the basename of the project path and lowercase it to match Gemini's folder naming.
    let basename = project_path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_lowercase();

    // Search matching project folders (exact + suffixed variants like "project-1", "project-2").
    // Falls back to all projects if basename is empty.
    let script = if basename.is_empty() {
        "ls -1t ~/.gemini/tmp/*/chats/*.json 2>/dev/null | head -20 | xargs grep -h sessionId 2>/dev/null | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'".to_string()
    } else {
        format!(
            "ls -1t ~/.gemini/tmp/{{{},{}-[0-9]*}}/chats/*.json 2>/dev/null | head -20 | xargs grep -h sessionId 2>/dev/null | grep -oE '[0-9a-f]{{8}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{12}}'",
            basename, basename
        )
    };

    let output = wsl_command_in(distro.as_deref())
        .args(["--", "bash", "-lic", &script])
        .output()
        .map_err(|e| format!("Failed to query Gemini sessions: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        return Ok(None);
    }

    let is_valid_uuid = |s: &str| -> bool {
        s.len() == 36
            && s.split('-').count() == 5
            && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
    };

    for line in stdout.lines() {
        let id = line.trim();
        if is_valid_uuid(id) && !exclude_ids.iter().any(|ex| ex == id) {
            return Ok(Some(id.to_string()));
        }
    }

    Ok(None)
}

/// Resolve CLI paths on native Windows using `where.exe`.
/// Returns a BTreeMap<String, String> with cli_name → resolved_path entries.
#[tauri::command]
async fn windows_resolve_cli_env(cli_names: Vec<String>) -> Result<std::collections::BTreeMap<String, String>, String> {
    let mut result = std::collections::BTreeMap::new();

    for name in &cli_names {
        // where.exe finds executables on the Windows PATH
        let output = Command::new("where.exe")
            .arg(name)
            .output()
            .map_err(|e| format!("Failed to run where.exe for {}: {}", name, e))?;

        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            // where.exe may return multiple lines — take the first match
            if let Some(first_line) = stdout.lines().next() {
                let path = first_line.trim();
                if !path.is_empty() {
                    result.insert(name.clone(), path.to_string());
                }
            }
        }
    }

    Ok(result)
}

/// Find the most recent Claude session ID on native Windows.
/// Claude stores sessions at %USERPROFILE%\.claude\projects\<encoded-path>\<uuid>.jsonl
#[tauri::command]
async fn get_claude_session_id_windows(project_path: String, exclude_ids: Vec<String>, max_age_secs: Option<u64>) -> Result<Option<String>, String> {
    let home = std::env::var("USERPROFILE").map_err(|_| "USERPROFILE not set".to_string())?;
    let encoded = project_path.replace('\\', "-").replace('/', "-");
    // Strip leading dash if present (from paths starting with C:\)
    let encoded = encoded.trim_start_matches('-').to_string();
    let session_dir = std::path::Path::new(&home).join(".claude").join("projects").join(&encoded);

    if !session_dir.exists() {
        return Ok(None);
    }

    let is_valid_uuid = |s: &str| -> bool {
        s.len() == 36
            && s.split('-').count() == 5
            && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
    };

    let now = std::time::SystemTime::now();

    // Read directory entries sorted by modification time (newest first)
    let mut entries: Vec<_> = std::fs::read_dir(&session_dir)
        .map_err(|e| format!("Failed to read session dir: {}", e))?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map_or(false, |ext| ext == "jsonl"))
        .filter_map(|e| {
            let mtime = e.metadata().ok()?.modified().ok()?;
            // Apply recency filter: skip files older than max_age_secs
            if let Some(max_age) = max_age_secs {
                if let Ok(age) = now.duration_since(mtime) {
                    if age.as_secs() > max_age {
                        return None;
                    }
                }
            }
            Some((e, mtime))
        })
        .collect();
    entries.sort_by(|a, b| b.1.cmp(&a.1));

    for (entry, _) in entries {
        if let Some(stem) = entry.path().file_stem().and_then(|s| s.to_str()) {
            if is_valid_uuid(stem) && !exclude_ids.iter().any(|ex| ex == stem) {
                return Ok(Some(stem.to_string()));
            }
        }
    }

    Ok(None)
}

/// Find the most recent Codex session ID on native Windows.
/// Codex ≥0.113 stores sessions in %USERPROFILE%\.codex\state_5.sqlite `threads` table.
/// Falls back to JSONL file scanning for older versions.
#[tauri::command]
async fn get_codex_session_id_windows(
    project_path: String,
    exclude_ids: Vec<String>,
    min_updated_at_ms: Option<u64>,
    now_ms: Option<u64>,
) -> Result<Option<String>, String> {
    let home = std::env::var("USERPROFILE").map_err(|_| "USERPROFILE not set".to_string())?;
    let codex_dir = std::path::Path::new(&home).join(".codex");

    let is_valid_uuid = |s: &str| -> bool {
        s.len() == 36
            && s.split('-').count() == 5
            && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
    };

    // Primary: query SQLite threads table (Codex ≥0.113)
    let db_path = codex_dir.join("state_5.sqlite");
    if db_path.exists() {
        let exclude_csv = exclude_ids.join(",");
        let py_script = codex_thread_query_py(&format!("r'{}'", db_path.display()));
        let floor = min_updated_at_ms.unwrap_or(0).to_string();
        let now = now_ms.unwrap_or(0).to_string();
        // Try python3 first, then python (Windows often has "python" not "python3")
        let output = Command::new("python3")
            .args(["-c", &py_script, &exclude_csv, &project_path, &floor, &now])
            .output()
            .or_else(|_| Command::new("python")
                .args(["-c", &py_script, &exclude_csv, &project_path, &floor, &now])
                .output()
            );
        if let Ok(o) = output {
            let stdout = String::from_utf8_lossy(&o.stdout).trim().to_string();
            for line in stdout.lines() {
                let id = line.trim();
                if is_valid_uuid(id) {
                    return Ok(Some(id.to_string()));
                }
            }
        }
    }

    // The mtime-ranked fallback cannot honour an updated_at floor — see the WSL
    // twin. With a floor requested, no answer beats an unanchored one.
    if min_updated_at_ms.unwrap_or(0) > 0 {
        return Ok(None);
    }

    // Fallback: scan JSONL files (Codex <0.113)
    let sessions_dir = codex_dir.join("sessions");
    if !sessions_dir.exists() {
        return Ok(None);
    }

    let mut files: Vec<(std::path::PathBuf, std::time::SystemTime)> = Vec::new();
    fn walk_dir(dir: &std::path::Path, files: &mut Vec<(std::path::PathBuf, std::time::SystemTime)>) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let path = entry.path();
                if path.is_dir() {
                    walk_dir(&path, files);
                } else if path.extension().map_or(false, |ext| ext == "jsonl") {
                    if let Ok(meta) = entry.metadata() {
                        if let Ok(mtime) = meta.modified() {
                            files.push((path, mtime));
                        }
                    }
                }
            }
        }
    }
    walk_dir(&sessions_dir, &mut files);
    files.sort_by(|a, b| b.1.cmp(&a.1));

    for (path, _) in files.iter().take(20) {
        if let Ok(file) = std::fs::File::open(path) {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(file);
            if let Some(Ok(first_line)) = reader.lines().next() {
                let cwd_match = format!("\"cwd\":\"{}\"", project_path);
                let cwd_match_spaced = format!("\"cwd\": \"{}\"", project_path);
                if !first_line.contains(&cwd_match) && !first_line.contains(&cwd_match_spaced) {
                    continue;
                }
                // Codex's own sub-agent rollouts carry the pane's cwd too.
                if !rollout_line_is_user_thread(&first_line) {
                    continue;
                }
                if let Some(id_start) = first_line.find("\"id\":\"").or_else(|| first_line.find("\"id\": \"")) {
                    let after = &first_line[id_start..];
                    if let Some(uuid_start) = after.find('"').and_then(|i| after[i+1..].find('"').map(|j| i + 1 + j + 1)) {
                        let remaining = &after[uuid_start..];
                        if let Some(end) = remaining.find('"') {
                            let id = &remaining[..end];
                            if is_valid_uuid(id) && !exclude_ids.iter().any(|ex| ex == id) {
                                return Ok(Some(id.to_string()));
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(None)
}

/// Find the most recent Gemini session ID on native Windows.
/// Gemini stores sessions at %USERPROFILE%\.gemini\tmp\<project>\chats\session-*.json
#[tauri::command]
async fn get_gemini_session_id_windows(project_path: String, exclude_ids: Vec<String>) -> Result<Option<String>, String> {
    let home = std::env::var("USERPROFILE").map_err(|_| "USERPROFILE not set".to_string())?;
    let tmp_dir = std::path::Path::new(&home).join(".gemini").join("tmp");

    if !tmp_dir.exists() {
        return Ok(None);
    }

    // Extract the basename and lowercase it to match Gemini's folder naming
    let basename = project_path
        .trim_end_matches('\\')
        .trim_end_matches('/')
        .rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or("")
        .to_lowercase();

    let is_valid_uuid = |s: &str| -> bool {
        s.len() == 36
            && s.split('-').count() == 5
            && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
    };

    // Find session JSON files only in matching project subdirs (exact + suffixed)
    let mut files: Vec<(std::path::PathBuf, std::time::SystemTime)> = Vec::new();
    if let Ok(projects) = std::fs::read_dir(&tmp_dir) {
        for proj in projects.filter_map(|e| e.ok()) {
            // Filter by project name — match exact basename or basename-N variants
            if !basename.is_empty() {
                let dir_name = proj.file_name().to_string_lossy().to_lowercase();
                if dir_name != basename && !dir_name.starts_with(&format!("{}-", basename)) {
                    continue;
                }
            }
            let chats_dir = proj.path().join("chats");
            if chats_dir.is_dir() {
                if let Ok(entries) = std::fs::read_dir(&chats_dir) {
                    for entry in entries.filter_map(|e| e.ok()) {
                        let path = entry.path();
                        if path.extension().map_or(false, |ext| ext == "json") {
                            if let Ok(meta) = entry.metadata() {
                                if let Ok(mtime) = meta.modified() {
                                    files.push((path, mtime));
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    files.sort_by(|a, b| b.1.cmp(&a.1));

    // Read sessionId from each file (line 2 in pretty-printed JSON)
    for (path, _) in files.iter().take(20) {
        if let Ok(content) = std::fs::read_to_string(path) {
            // Search for sessionId in the content
            if let Some(idx) = content.find("\"sessionId\"") {
                let after = &content[idx..];
                // Extract UUID after the colon
                let uuid_re_like = |s: &str| -> Option<String> {
                    // Find first UUID-like pattern
                    let chars: Vec<char> = s.chars().collect();
                    let mut i = 0;
                    while i < chars.len() {
                        if chars[i] == '"' {
                            let start = i + 1;
                            if let Some(end_pos) = s[start..].find('"') {
                                let candidate = &s[start..start + end_pos];
                                if is_valid_uuid(candidate) {
                                    return Some(candidate.to_string());
                                }
                            }
                        }
                        i += 1;
                    }
                    None
                };
                if let Some(id) = uuid_re_like(after) {
                    if !exclude_ids.iter().any(|ex| *ex == id) {
                        return Ok(Some(id));
                    }
                }
            }
        }
    }

    Ok(None)
}

/// Read context info from CLI session files on native Windows.
/// Uses Rust-native JSON parsing (no jq dependency).
#[tauri::command]
async fn read_session_context_windows(
    terminal_type: String,
    session_id: String,
    project_path: String,
) -> Result<String, String> {
    if session_id.is_empty() {
        return Ok(String::new());
    }
    let home = std::env::var("USERPROFILE").map_err(|_| "USERPROFILE not set".to_string())?;
    let is_latest = session_id == "__latest__";

    match terminal_type.as_str() {
        "claude" => {
            // Read statusline JSON if available
            let sl_path = std::path::Path::new(&home).join(".made").join("claude-statusline.json");
            let mut sl_window: Option<u64> = None;
            let mut sl_model: Option<String> = None;
            let mut sl_used_pct: Option<u64> = None;
            let mut sl_cost: Option<f64> = None;
            let mut sl_duration: Option<u64> = None;
            let mut sl_version: Option<String> = None;
            let mut sl_session_id: Option<String> = None;
            if let Ok(content) = std::fs::read_to_string(&sl_path) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                    sl_window = v.pointer("/context_window/context_window_size").and_then(|v| v.as_u64());
                    sl_model = v.pointer("/model/display_name").and_then(|v| v.as_str()).map(|s| s.to_string());
                    sl_used_pct = v.pointer("/context_window/used_percentage").and_then(|v| v.as_u64());
                    sl_cost = v.pointer("/cost/total_cost_usd").and_then(|v| v.as_f64());
                    sl_duration = v.pointer("/cost/total_duration_ms").and_then(|v| v.as_u64());
                    sl_version = v.pointer("/version").and_then(|v| v.as_str()).map(|s| s.to_string());
                    sl_session_id = v.pointer("/session_id").and_then(|v| v.as_str()).map(|s| s.to_string());
                    // Cache per-session cost from statusline
                    if let (Some(ref sid), Some(cost)) = (&sl_session_id, sl_cost) {
                        let cache_path = std::env::temp_dir().join(format!("made-claude-cost-{}.txt", sid));
                        let dur_str = sl_duration.map(|d| d.to_string()).unwrap_or_default();
                        let _ = std::fs::write(&cache_path, format!("{:.6}|{}", cost, dur_str));
                    }
                }
            }

            let used_pct_str = sl_used_pct.map(|v| v.to_string()).unwrap_or_default();
            let ver_str = sl_version.unwrap_or_default();

            // Read effortLevel from ~/.claude/settings.json
            let effort_level: String = {
                let settings_path = std::path::Path::new(&home).join(".claude").join("settings.json");
                std::fs::read_to_string(&settings_path).ok()
                    .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
                    .and_then(|v| v.get("effortLevel").and_then(|v| v.as_str()).map(|s| s.to_string()))
                    .unwrap_or_default()
            };

            if is_latest {
                // 0|window|model|used_pct|||version|||||effort
                if let Some(w) = sl_window {
                    return Ok(format!("0|{}|{}|{}|||{}|||||{}", w, sl_model.as_deref().unwrap_or(""), used_pct_str, ver_str, effort_level));
                }
                return Ok(String::new());
            }

            // Find session file
            let claude_dir = std::path::Path::new(&home).join(".claude").join("projects");
            let mut session_file: Option<std::path::PathBuf> = None;
            if claude_dir.exists() {
                // Walk project dirs to find <uuid>.jsonl
                if let Ok(projects) = std::fs::read_dir(&claude_dir) {
                    for proj in projects.filter_map(|e| e.ok()) {
                        let candidate = proj.path().join(format!("{}.jsonl", session_id));
                        if candidate.exists() {
                            session_file = Some(candidate);
                            break;
                        }
                    }
                }
            }

            let f = match session_file {
                Some(f) => f,
                None => return Ok(String::new()),
            };

            // Read last usage line + extract service_tier/speed
            let content = std::fs::read_to_string(&f).map_err(|e| e.to_string())?;
            let mut total: u64 = 0;
            let mut service_tier = String::new();
            let mut speed = String::new();
            for line in content.lines().rev() {
                if line.contains("\"message\"") && line.contains("\"usage\"") {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                        if let Some(usage) = v.pointer("/message/usage") {
                            let input = usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                            let cache_create = usage.get("cache_creation_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                            let cache_read = usage.get("cache_read_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                            let output = usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                            total = input + cache_create + cache_read + output;
                            if let Some(st) = usage.get("service_tier").and_then(|v| v.as_str()) {
                                service_tier = st.to_string();
                            }
                            if let Some(sp) = usage.get("speed").and_then(|v| v.as_str()) {
                                speed = sp.to_string();
                            }
                            break;
                        }
                    }
                }
            }

            // Count context compactions + extract custom title
            let compact_count = content.lines().filter(|l| l.contains("compact_boundary")).count();
            let mut custom_title = String::new();
            for line in content.lines().rev() {
                if line.contains("\"custom-title\"") {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                        if let Some(t) = v.get("customTitle").and_then(|v| v.as_str()) {
                            custom_title = t.to_string();
                            break;
                        }
                    }
                }
            }
            // Fallback: read session name from ~/.claude/sessions/*.json (Claude CLI v2.1+)
            if custom_title.is_empty() {
                let sessions_dir = std::path::Path::new(&home).join(".claude").join("sessions");
                if sessions_dir.is_dir() {
                    if let Ok(entries) = std::fs::read_dir(&sessions_dir) {
                        for entry in entries.filter_map(|e| e.ok()) {
                            let path = entry.path();
                            if path.extension().map_or(false, |ext| ext == "json") {
                                if let Ok(data) = std::fs::read_to_string(&path) {
                                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) {
                                        if v.get("sessionId").and_then(|v| v.as_str()) == Some(&session_id) {
                                            if let Some(n) = v.get("name").and_then(|v| v.as_str()) {
                                                if !n.is_empty() {
                                                    custom_title = n.to_string();
                                                    break;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Per-session cost: use statusline if session matches, else cached
            let (sess_cost, sess_duration): (Option<f64>, Option<u64>) =
                if sl_session_id.as_deref() == Some(&session_id) {
                    (sl_cost, sl_duration)
                } else {
                    let cache_path = std::env::temp_dir().join(format!("made-claude-cost-{}.txt", session_id));
                    if let Ok(cached) = std::fs::read_to_string(&cache_path) {
                        let parts: Vec<&str> = cached.trim().split('|').collect();
                        let c = parts.first().and_then(|s| s.parse::<f64>().ok());
                        let d = parts.get(1).and_then(|s| s.parse::<u64>().ok());
                        (c, d)
                    } else {
                        (None, None)
                    }
                };

            // Project cost: sum all cached session costs in the project directory
            let proj_cost: Option<f64> = {
                let proj_dir = f.parent();
                if let Some(dir) = proj_dir {
                    let mut total_cost: f64 = 0.0;
                    let mut found_any = false;
                    if let Ok(entries) = std::fs::read_dir(dir) {
                        for entry in entries.filter_map(|e| e.ok()) {
                            let path = entry.path();
                            if path.extension().map_or(true, |ext| ext != "jsonl") { continue; }
                            let sid = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                            let sc = if sl_session_id.as_deref() == Some(&sid) {
                                sl_cost
                            } else {
                                let cp = std::env::temp_dir().join(format!("made-claude-cost-{}.txt", sid));
                                std::fs::read_to_string(&cp).ok()
                                    .and_then(|c| c.trim().split('|').next().and_then(|s| s.parse::<f64>().ok()))
                            };
                            if let Some(c) = sc { total_cost += c; found_any = true; }
                        }
                    }
                    if found_any { Some(total_cost) } else { None }
                } else { None }
            };

            let cost_str = sess_cost.map(|c| format!("{:.6}", c)).unwrap_or_default();
            let dur_str = sess_duration.map(|d| d.to_string()).unwrap_or_default();
            let proj_str = proj_cost.map(|c| format!("{:.6}", c)).unwrap_or_default();

            if total == 0 {
                if let Some(w) = sl_window {
                    // 0|window|model|used_pct|cost|dur|version|||compact|proj|effort|custom_title
                    return Ok(format!("0|{}|{}|{}|{}|{}|{}|||{}|{}|{}|{}", w, sl_model.as_deref().unwrap_or(""), used_pct_str, cost_str, dur_str, ver_str, compact_count, proj_str, effort_level, custom_title));
                }
                return Ok(String::new());
            }

            let window = sl_window.unwrap_or(200000);
            let model_str = sl_model.unwrap_or_default();
            // total|window|model|used_pct|cost|dur|version|tier|speed|compact|proj|effort|custom_title
            Ok(format!("{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}", total, window, model_str, used_pct_str, cost_str, dur_str, ver_str, service_tier, speed, compact_count, proj_str, effort_level, custom_title))
        },
        "codex" => {
            let sessions_dir = std::path::Path::new(&home).join(".codex").join("sessions");
            if !sessions_dir.exists() {
                return Ok(String::new());
            }

            // Find session file
            let target_file: Option<std::path::PathBuf>;
            if is_latest {
                // Scoped to THIS project — see find_codex_rollout_for_cwd.
                target_file = find_codex_rollout_for_cwd(&sessions_dir, &project_path);
            } else {
                // Search for file containing the session UUID
                fn walk2(dir: &std::path::Path, uuid: &str) -> Option<std::path::PathBuf> {
                    if let Ok(entries) = std::fs::read_dir(dir) {
                        for entry in entries.filter_map(|e| e.ok()) {
                            let path = entry.path();
                            if path.is_dir() {
                                if let Some(found) = walk2(&path, uuid) { return Some(found); }
                            } else if path.file_name().map_or(false, |n| n.to_string_lossy().contains(uuid)) {
                                return Some(path);
                            }
                        }
                    }
                    None
                }
                target_file = walk2(&sessions_dir, &session_id);
            }

            let f = match target_file {
                Some(f) => f,
                None => return Ok(String::new()),
            };

            let content = std::fs::read_to_string(&f).map_err(|e| e.to_string())?;
            let mut used: Option<u64> = None;
            let mut window: Option<u64> = None;
            let mut model: String = String::new();
            let mut effort: String = String::new();
            let mut collab_mode: String = String::new();

            for line in content.lines().rev() {
                if window.is_some() && (used.is_some() || is_latest) { break; }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                    if window.is_none() {
                        if let Some(w) = v.pointer("/payload/info/model_context_window").and_then(|v| v.as_u64()) {
                            if w > 0 { window = Some(w); }
                        }
                        if used.is_none() && !is_latest {
                            if let Some(u) = v.pointer("/payload/info/last_token_usage/total_tokens").and_then(|v| v.as_u64()) {
                                if u > 0 { used = Some(u); }
                            }
                        }
                    }
                    if model.is_empty() {
                        if let Some(m) = v.pointer("/payload/model").and_then(|v| v.as_str()) {
                            model = m.to_string();
                        }
                    }
                    if effort.is_empty() {
                        if let Some(e) = v.pointer("/payload/effort").and_then(|v| v.as_str()) {
                            effort = e.to_string();
                        }
                    }
                    if collab_mode.is_empty() {
                        if let Some(cm) = v.pointer("/payload/collaboration_mode/mode").and_then(|v| v.as_str()) {
                            collab_mode = cm.to_string();
                        }
                    }
                }
            }

            if is_latest { used = None; }
            let used_val = used.unwrap_or(0);
            let window_val = match window {
                Some(w) => w,
                None => return Ok(String::new()),
            };

            // Rate limits: account-level — search all sessions (newest first)
            let mut rl5h: Option<f64> = None;
            let mut rlweek: Option<f64> = None;
            {
                // Collect all session files sorted by mtime (newest first)
                let mut all_files: Vec<(std::path::PathBuf, std::time::SystemTime)> = Vec::new();
                fn walk_rl(dir: &std::path::Path, files: &mut Vec<(std::path::PathBuf, std::time::SystemTime)>) {
                    if let Ok(entries) = std::fs::read_dir(dir) {
                        for entry in entries.filter_map(|e| e.ok()) {
                            let path = entry.path();
                            if path.is_dir() { walk_rl(&path, files); }
                            else if path.extension().map_or(false, |ext| ext == "jsonl") {
                                if let Ok(m) = entry.metadata() {
                                    if let Ok(t) = m.modified() { files.push((path, t)); }
                                }
                            }
                        }
                    }
                }
                walk_rl(&sessions_dir, &mut all_files);
                all_files.sort_by(|a, b| b.1.cmp(&a.1));
                for (rf, _) in all_files.iter().take(15) {
                    if let Ok(rc) = std::fs::read_to_string(rf) {
                        for line in rc.lines().rev() {
                            if !line.contains("\"rate_limits\"") || line.contains("\"rate_limits\":null") { continue; }
                            if !line.contains("\"used_percent\"") { continue; }
                            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                                rl5h = v.pointer("/payload/rate_limits/primary/used_percent").and_then(|v| v.as_f64());
                                rlweek = v.pointer("/payload/rate_limits/secondary/used_percent").and_then(|v| v.as_f64());
                                break;
                            }
                        }
                    }
                    if rl5h.is_some() { break; }
                }
            }
            let rl5h_str = rl5h.map(|v| format!("{:.2}", v)).unwrap_or_default();
            let rlweek_str = rlweek.map(|v| format!("{:.2}", v)).unwrap_or_default();

            // Read session title from SQLite
            let mut title = String::new();
            if !is_latest {
                let db_path = std::path::Path::new(&home).join(".codex").join("state_5.sqlite");
                if db_path.exists() {
                    let py = format!(
                        r#"import sqlite3,sys;c=sqlite3.connect(r'{}');r=c.execute('SELECT title FROM threads WHERE id=?',(sys.argv[1],)).fetchone();print(r[0] if r else '')"#,
                        db_path.display()
                    );
                    if let Ok(out) = std::process::Command::new("python3").args(["-c", &py, &session_id]).output() {
                        title = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    }
                }
            }

            Ok(format!("{}|{}|{}|{}|{}|{}|{}|{}", used_val, window_val, model, rl5h_str, rlweek_str, effort, collab_mode, title))
        },
        "gemini" => {
            let tmp_dir = std::path::Path::new(&home).join(".gemini").join("tmp");
            if !tmp_dir.exists() {
                return Ok(String::new());
            }

            // The session ID is the authority when the pane has one: find the
            // chat file that CONTAINS it, wherever Gemini filed it. This branch
            // used to ignore `session_id` outright and read whichever chat file
            // on the machine was touched last, so every Gemini pane displayed
            // the same — usually wrong — session. Only `__latest__` still asks
            // the directory, and then only THIS project's.
            let f = if is_latest {
                match gemini_chat_files(&gemini_project_dirs(&home, &project_path)).into_iter().next() {
                    Some(p) => p,
                    None => return Ok(String::new()),
                }
            } else {
                match find_gemini_chat_by_id(&home, &session_id) {
                    Some(p) => p,
                    None => return Ok(String::new()),
                }
            };

            let content = std::fs::read_to_string(&f).map_err(|e| e.to_string())?;
            let v: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;

            // Last message input tokens
            let inp = v.pointer("/messages")
                .and_then(|m| m.as_array())
                .map(|msgs| msgs.iter().rev().find_map(|m| m.pointer("/tokens/input").and_then(|v| v.as_u64())).unwrap_or(0))
                .unwrap_or(0);
            if inp == 0 { return Ok(String::new()); }

            // Last model
            let model = v.pointer("/messages")
                .and_then(|m| m.as_array())
                .map(|msgs| msgs.iter().rev().find_map(|m| m.get("model").and_then(|v| v.as_str())).unwrap_or(""))
                .unwrap_or("");

            // Summary
            let summary = v.get("summary").and_then(|v| v.as_str()).unwrap_or("");

            // Last thinking tokens
            let thoughts = v.pointer("/messages")
                .and_then(|m| m.as_array())
                .map(|msgs| msgs.iter().rev().find_map(|m| m.pointer("/tokens/thoughts").and_then(|v| v.as_u64())).unwrap_or(0))
                .unwrap_or(0);

            Ok(format!("{}|1000000|{}||{}|{}|", inp, model, summary, thoughts))
        },
        _ => Ok(String::new()),
    }
}

/// HICON plumbing for the runtime app-icon picker.
///
/// tao's `set_window_icon` forwards ONE fixed-size icon (as ICON_SMALL only),
/// and Windows shell surfaces (taskbar, Alt-Tab) CROP a WM_SETICON icon whose
/// pixel size doesn't match the slot instead of scaling it — a 512px master
/// showed up as a zoomed-in centre crop. The compiled .ico never hits this
/// because it carries real 16/24/32/48 entries. So: downscale the master to
/// the exact system-metric sizes and set ICON_SMALL and ICON_BIG ourselves.
#[cfg(target_os = "windows")]
mod app_icon_win {
    use std::sync::atomic::{AtomicIsize, Ordering};

    // Previous icons WE created, destroyed on replacement. The handle a
    // WM_SETICON returns on the first call belongs to tao (it destroys its
    // WindowIcon itself) and must NOT be destroyed here.
    static PREV_SMALL: AtomicIsize = AtomicIsize::new(0);
    static PREV_BIG: AtomicIsize = AtomicIsize::new(0);

    /// Area-average `src` (sw×sh RGBA) down to dw×dh. Colour is alpha-weighted
    /// so fully transparent source pixels never darken edge colours.
    fn downscale_rgba(src: &[u8], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u8> {
        let mut out = vec![0u8; dw * dh * 4];
        for dy in 0..dh {
            let y0 = dy * sh / dh;
            let y1 = ((dy + 1) * sh).div_ceil(dh);
            for dx in 0..dw {
                let x0 = dx * sw / dw;
                let x1 = ((dx + 1) * sw).div_ceil(dw);
                let (mut r, mut g, mut b, mut a, mut n) = (0u64, 0u64, 0u64, 0u64, 0u64);
                for y in y0..y1 {
                    for x in x0..x1 {
                        let i = (y * sw + x) * 4;
                        let al = src[i + 3] as u64;
                        r += src[i] as u64 * al;
                        g += src[i + 1] as u64 * al;
                        b += src[i + 2] as u64 * al;
                        a += al;
                        n += 1;
                    }
                }
                let o = (dy * dw + dx) * 4;
                if a > 0 {
                    out[o] = (r / a) as u8;
                    out[o + 1] = (g / a) as u8;
                    out[o + 2] = (b / a) as u8;
                }
                out[o + 3] = (a / n.max(1)) as u8;
            }
        }
        out
    }

    /// Build a size×size 32bpp HICON (straight alpha) from RGBA pixels.
    fn create_icon(rgba: &[u8], size: usize) -> Result<isize, String> {
        use windows::Win32::Foundation::{HANDLE, HWND};
        use windows::Win32::Graphics::Gdi::{
            CreateBitmap, CreateDIBSection, DeleteObject, GetDC, ReleaseDC, BITMAPINFO,
            BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        };
        use windows::Win32::UI::WindowsAndMessaging::{CreateIconIndirect, ICONINFO};
        unsafe {
            let bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: size as i32,
                    biHeight: -(size as i32), // top-down
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let screen_dc = GetDC(HWND(std::ptr::null_mut()));
            let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
            let color = CreateDIBSection(screen_dc, &bmi, DIB_RGB_COLORS, &mut bits, HANDLE::default(), 0);
            ReleaseDC(HWND(std::ptr::null_mut()), screen_dc);
            let color = color.map_err(|e| format!("CreateDIBSection: {e}"))?;
            if bits.is_null() {
                let _ = DeleteObject(color);
                return Err("CreateDIBSection returned null bits".into());
            }
            let dst = std::slice::from_raw_parts_mut(bits as *mut u8, size * size * 4);
            for (d, s) in dst.chunks_exact_mut(4).zip(rgba.chunks_exact(4)) {
                d[0] = s[2]; // RGBA -> BGRA
                d[1] = s[1];
                d[2] = s[0];
                d[3] = s[3];
            }
            let mask = CreateBitmap(size as i32, size as i32, 1, 1, None);
            let info = ICONINFO {
                fIcon: true.into(),
                xHotspot: 0,
                yHotspot: 0,
                hbmMask: mask,
                hbmColor: color,
            };
            let hicon = CreateIconIndirect(&info);
            let _ = DeleteObject(color);
            let _ = DeleteObject(mask);
            let hicon = hicon.map_err(|e| format!("CreateIconIndirect: {e}"))?;
            Ok(hicon.0 as isize)
        }
    }

    /// Downscale + WM_SETICON for both slots. `rgba` is the square master.
    pub fn apply(hwnd: isize, rgba: &[u8], master: usize) -> Result<(), String> {
        use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{
            DestroyIcon, GetSystemMetrics, SendMessageW, HICON, ICON_BIG, ICON_SMALL,
            SM_CXICON, SM_CXSMICON, WM_SETICON,
        };
        let small = unsafe { GetSystemMetrics(SM_CXSMICON) }.clamp(16, 256) as usize;
        let big = unsafe { GetSystemMetrics(SM_CXICON) }.clamp(24, 256) as usize;
        for (size, slot, prev) in [
            (small, ICON_SMALL as usize, &PREV_SMALL),
            (big, ICON_BIG as usize, &PREV_BIG),
        ] {
            let scaled = downscale_rgba(rgba, master, master, size, size);
            let hicon = create_icon(&scaled, size)?;
            unsafe {
                SendMessageW(HWND(hwnd as *mut _), WM_SETICON, WPARAM(slot), LPARAM(hicon));
            }
            let old = prev.swap(hicon, Ordering::SeqCst);
            if old != 0 {
                unsafe {
                    let _ = DestroyIcon(HICON(old as *mut _));
                }
            }
        }
        Ok(())
    }
}

/// Apply one of the bundled app-icon variants (Settings > Appearance >
/// App icon) to the OS window — title bar, taskbar and Alt-Tab. Runtime-only:
/// the exe/installer/shortcut icon stays whatever icons/icon.ico was at build
/// time. `async` so the PNG decode + downscale never run inline on the
/// WebView2 UI thread. The win32 NC guard already redraw-locks WM_SETICON,
/// so no border flash.
#[tauri::command]
async fn set_app_icon_variant(window: tauri::WebviewWindow, variant: String) -> Result<(), String> {
    let bytes: &[u8] = match variant.as_str() {
        "a" => include_bytes!("../icons/variants/icon-a.png"),
        "b" => include_bytes!("../icons/variants/icon-b.png"),
        "c" => include_bytes!("../icons/variants/icon-c.png"),
        "d" => include_bytes!("../icons/variants/icon-d.png"),
        _ => return Err(format!("unknown app icon variant: {variant}")),
    };
    let icon = tauri::image::Image::from_bytes(bytes).map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    {
        let master = icon.width() as usize;
        if icon.height() as usize != master {
            return Err("app icon master must be square".into());
        }
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        return app_icon_win::apply(hwnd.0 as isize, icon.rgba(), master);
    }
    #[cfg(not(target_os = "windows"))]
    {
        window.set_icon(icon).map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn set_window_corners(window: tauri::WebviewWindow, rounded: bool) -> Result<(), String> {
    let _ = (&window, rounded);
    #[cfg(target_os = "windows")]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        win32_border::set_corner_preference(hwnd.0, rounded);
    }
    Ok(())
}

/// The MADE statusline wrapper — ONE copy, shared verbatim by the local and
/// the SSH installer. They used to hold separate literals of "the same" script,
/// the SSH one carrying a comment asking that they stay identical: exactly the
/// arrangement in which two copies of a file drift apart.
///
/// Claude pipes its statusline JSON here on every render. We keep copies for
/// the header poll to read, then chain to whatever statusline the user already
/// had so theirs keeps working.
///
/// Three outputs, and the last two are new:
///   • /tmp/made-claude-statusline.json       — newest render from ANY session
///   • /tmp/made-claude-statusline-<sid>.json — per session, so two panes on
///     one host stop overwriting each other's model / window / cost
///   • /tmp/made-claude-cost-<sid>.txt        — `cost|duration`, the only
///     record of a session's spend once it is no longer the active one. The
///     header's project-cost total is the sum of these across a project dir.
///
/// `sed`, not `jq`: this runs on EVERY statusline render, so it must not depend
/// on a tool the host may not have. The session id is pattern-checked before it
/// is allowed near a path — it arrives as JSON written by another process and
/// is about to become a filename.
const STATUSLINE_WRAPPER: &str = r#"#!/bin/bash
input=$(cat)
# Save raw statusline JSON for MADE to read
echo "$input" > /tmp/made-claude-statusline.json 2>/dev/null
# Per-session copies, so sibling panes on one host don't clobber each other.
_sid=$(printf '%s' "$input" | sed -n 's/.*"session_id"[ ]*:[ ]*"\([^"]*\)".*/\1/p')
case "$_sid" in
  ""|*[!0-9a-fA-F-]*) ;;
  *)
    echo "$input" > "/tmp/made-claude-statusline-$_sid.json" 2>/dev/null
    _cost=$(printf '%s' "$input" | sed -n 's/.*"total_cost_usd"[ ]*:[ ]*\([0-9.eE+-]*\).*/\1/p')
    _dur=$(printf '%s' "$input" | sed -n 's/.*"total_duration_ms"[ ]*:[ ]*\([0-9]*\).*/\1/p')
    [ -n "$_cost" ] && printf '%s|%s' "$_cost" "$_dur" > "/tmp/made-claude-cost-$_sid.txt" 2>/dev/null
    ;;
esac
# Chain to original statusline command (e.g. cc-statusline)
_chain="$(cat "$HOME/.made/statusline-chain" 2>/dev/null)"
# Guard: never chain to ourselves (prevents infinite recursion / fork bomb)
case "$_chain" in *statusline-wrapper*) _chain="" ;; esac
if [ -n "$_chain" ] && [ -x "$_chain" ]; then
  echo "$input" | "$_chain"
else
  # No user statusline configured — emit a minimal one-liner instead of the
  # raw JSON (Claude Code renders this directly in the prompt area, so dumping
  # the JSON would leak {"session_id":...,"cwd":...} into the user's view).
  cwd=$(printf '%s' "$input" | sed -n 's/.*"cwd"[ ]*:[ ]*"\([^"]*\)".*/\1/p')
  base="${cwd##*/}"
  if [ -n "$base" ]; then
    printf '%s' "$base"
  fi
fi
"#;

/// Bumped whenever STATUSLINE_WRAPPER changes; both installers compare it with
/// ~/.made/statusline-wrapper.version to decide whether to rewrite.
const STATUSLINE_WRAPPER_VERSION: u32 = 4;

/// The installer, also shared by both paths.
///
/// Placeholders are `__B64__` / `__VER__` and substitution is `replace()`, NOT
/// `format!`: the script is dense with `{`/`}` (shell groups, a JSON literal)
/// and every one of them would need doubling, which is a silent-corruption
/// hazard in a string no compiler checks.
///
/// Two defects fixed here, both of which made the install a silent no-op that
/// still reported success:
///   • It only wrote `statusLine` into an EXISTING settings.json. On a host
///     where Claude had never written that file, the wrapper was installed and
///     nothing ever invoked it — and the script printed INSTALLED anyway.
///   • The SSH variant short-circuited on a matching version file alone, so it
///     never re-checked that settings.json still pointed at the wrapper. Once
///     anything rewrote that file the header stayed dead until the version
///     constant changed.
/// A missing `jq` on a host that HAS a settings.json is now reported as
/// ERR_NO_JQ rather than silently skipped — we cannot merge JSON safely
/// without it, and pretending otherwise is what hid this for so long.
const STATUSLINE_INSTALL_TEMPLATE: &str = r#"
WRAPPER="$HOME/.made/statusline-wrapper.sh"
VERSION_FILE="$HOME/.made/statusline-wrapper.version"
CHAIN_FILE="$HOME/.made/statusline-chain"
SETTINGS="$HOME/.claude/settings.json"

# What settings.json points at NOW. Read before any short-circuit: the version
# file alone is not evidence that Claude is actually invoking the wrapper.
CURRENT=""
if [ -f "$SETTINGS" ]; then
  if command -v jq >/dev/null 2>&1; then
    CURRENT=$(jq -r '.statusLine.command // ""' "$SETTINGS" 2>/dev/null || true)
  else
    CURRENT=$(sed -n 's/.*"command"[ ]*:[ ]*"\([^"]*statusline-wrapper[^"]*\)".*/\1/p' "$SETTINGS" 2>/dev/null | head -1)
  fi
fi
POINTED=""
case "$CURRENT" in *"/.made/statusline-wrapper"*) POINTED=1 ;; esac

if [ -n "$POINTED" ] && [ -x "$WRAPPER" ] && [ "$(cat "$VERSION_FILE" 2>/dev/null)" = "__VER__" ]; then
  echo "ALREADY_INSTALLED"
  exit 0
fi

mkdir -p "$HOME/.made" 2>/dev/null
echo "__B64__" | base64 -d > "$WRAPPER"
chmod +x "$WRAPPER" 2>/dev/null || true
echo "__VER__" > "$VERSION_FILE"

# Preserve the user's own statusline as the chain target, migrating one left by
# a previous app identity (~/.ezydev, before the MADE rename). Never record a
# wrapper as its own chain target: the fork-bomb guard would blank it and the
# user's original statusline would be lost.
case "$CURRENT" in
  *"/.made/statusline-wrapper"*)
    ;;
  *statusline-wrapper*)
    OLDEXP=$(eval echo "$CURRENT" 2>/dev/null || echo "$CURRENT")
    OLDDIR=$(dirname "$OLDEXP")
    if [ -f "$OLDDIR/statusline-chain" ]; then
      OLDCHAIN=$(cat "$OLDDIR/statusline-chain" 2>/dev/null)
      case "$OLDCHAIN" in
        *statusline-wrapper*) ;;
        *) [ -n "$OLDCHAIN" ] && echo "$OLDCHAIN" > "$CHAIN_FILE" ;;
      esac
    fi
    ;;
  *)
    if [ -n "$CURRENT" ]; then
      EXPANDED=$(eval echo "$CURRENT" 2>/dev/null || echo "$CURRENT")
      echo "$EXPANDED" > "$CHAIN_FILE"
    fi
    ;;
esac

if [ ! -f "$SETTINGS" ]; then
  mkdir -p "$HOME/.claude" 2>/dev/null
  printf '%s\n' '{"statusLine":{"type":"command","command":"~/.made/statusline-wrapper.sh"}}' > "$SETTINGS" 2>/dev/null || { echo "ERR_SETTINGS_CREATE"; exit 1; }
  echo "INSTALLED"
  exit 0
fi

if command -v jq >/dev/null 2>&1; then
  TMP=$(mktemp)
  if jq '.statusLine = {"type": "command", "command": "~/.made/statusline-wrapper.sh"}' "$SETTINGS" > "$TMP" 2>/dev/null; then
    mv "$TMP" "$SETTINGS"
  else
    rm -f "$TMP"
    echo "ERR_JQ_UPDATE"
    exit 1
  fi
else
  echo "ERR_NO_JQ"
  exit 1
fi

echo "INSTALLED"
"#;

/// Fill the install template. See STATUSLINE_INSTALL_TEMPLATE for why this is
/// `replace()` and not `format!`.
fn statusline_install_script(wrapper_b64: &str) -> String {
    STATUSLINE_INSTALL_TEMPLATE
        .replace("__B64__", wrapper_b64)
        .replace("__VER__", &STATUSLINE_WRAPPER_VERSION.to_string())
}

/// Base64 of the wrapper — avoids heredoc/expansion issues when the installer
/// is itself delivered through `bash -lic` or `ssh host '<script>'`.
fn statusline_wrapper_b64() -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(STATUSLINE_WRAPPER.trim())
}

/// Install the MADE statusline wrapper in WSL.
/// Creates ~/.made/statusline-wrapper.sh that saves the raw statusline JSON
/// to /tmp/made-claude-statusline.json and chains to the user's existing
/// statusline command (e.g. cc-statusline) so it keeps working.
#[tauri::command]
async fn install_statusline_wrapper(distro: Option<String>) -> Result<String, String> {
    let b64 = statusline_wrapper_b64();

    // Single bash script: check if installed, create dir, write wrapper, save chain, update settings
    let script = statusline_install_script(&b64);

    // On macOS/Linux (no distro param), run bash directly.
    // On Windows (with or without distro), pipe through wsl.exe.
    #[cfg(not(target_os = "windows"))]
    let mut child = {
        let _ = &distro; // unused on non-Windows
        Command::new("bash")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn bash: {}", e))?
    };

    #[cfg(target_os = "windows")]
    let mut child = {
        let mut args = Vec::new();
        if let Some(ref d) = distro {
            args.push("-d".to_string());
            args.push(d.clone());
        }
        args.extend(["--".to_string(), "bash".to_string()]);
        wsl_command()
            .args(&args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn wsl: {}", e))?
    };

    if let Some(ref mut stdin) = child.stdin {
        use std::io::Write;
        let _ = stdin.write_all(script.as_bytes());
    }
    drop(child.stdin.take()); // Close stdin to signal EOF

    let output = child.wait_with_output()
        .map_err(|e| format!("Failed to wait for shell: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if stdout.is_empty() && !stderr.is_empty() {
        return Ok(format!("ERR: {}", stderr));
    }
    if stdout.is_empty() {
        return Ok(format!("ERR_EMPTY (exit={})", output.status.code().unwrap_or(-1)));
    }
    Ok(stdout)
}

/// Read context percentage from CLI session JSONL files.
/// Supports Claude (usage per message) and Codex (token_count events).
/// Returns the percentage remaining as a string ("0"-"100"), or empty string if not available.
///
/// Uses a temp-file cache (/tmp/made-sessionpath-{session_id}) to avoid repeated `find` calls.
/// The shell script that reads a CLI's session context — shared by EVERY
/// backend: WSL, native, Windows, and (since the header showed nothing at all
/// on a remote pane) SSH.
///
/// The SSH reader used to be a separate Rust re-implementation that fetched a
/// few files and parsed a subset of the fields. In the claude arm alone it was
/// missing the model fallback from the transcript, the session-name fallback,
/// the per-session cost cache and the entire project-cost total — and every
/// one of those gaps was invisible unless someone diffed the two by hand.
/// Running the SAME script makes parity structural instead of aspirational.
///
/// None for a terminal type that has no context to read.
/// `project_path` scopes the `__latest__` reads. Without it, a pane that had
/// not yet locked a session showed whichever session was touched last ANYWHERE
/// on the machine — another project's model, context percentage and name.
fn context_script(terminal_type: &str, session_id: &str, project_path: &str) -> Option<String> {
    Some(match terminal_type {
        "claude" => format!(
            r#"
command -v jq >/dev/null 2>&1 || exit 0

# tac is GNU-only; macOS/BSD spells it `tail -r`. These scripts now run on
# remote hosts too, where either may be the case.
_rev() {{ tac "$1" 2>/dev/null || tail -r "$1" 2>/dev/null; }}

# Read effortLevel from ~/.claude/settings.json
effort_level=""
SETTINGS="$HOME/.claude/settings.json"
if [ -f "$SETTINGS" ]; then
  effort_level=$(jq -r '.effortLevel // empty' "$SETTINGS" 2>/dev/null)
fi

# Read statusline JSON (if available). Prefer THIS session's own copy: the
# global file holds whichever session rendered last, so two panes sharing a
# host would otherwise read each other's model, window and cost.
SID='{session_id}'
SL="/tmp/made-claude-statusline.json"
if [ "$SID" != "__latest__" ] && [ -f "/tmp/made-claude-statusline-$SID.json" ]; then
  SL="/tmp/made-claude-statusline-$SID.json"
fi
sl_window=""
sl_model=""
sl_used_pct=""
sl_cost=""
sl_duration=""
sl_version=""
sl_session_id=""
if [ -f "$SL" ]; then
  sl_window=$(jq -r '.context_window.context_window_size // empty' "$SL" 2>/dev/null)
  sl_model=$(jq -r '.model.display_name // empty' "$SL" 2>/dev/null)
  sl_used_pct=$(jq -r '.context_window.used_percentage // empty' "$SL" 2>/dev/null)
  sl_cost=$(jq -r '.cost.total_cost_usd // empty' "$SL" 2>/dev/null)
  sl_duration=$(jq -r '.cost.total_duration_ms // empty' "$SL" 2>/dev/null)
  sl_version=$(jq -r '.version // empty' "$SL" 2>/dev/null)
  sl_session_id=$(jq -r '.session_id // empty' "$SL" 2>/dev/null)
  # Cache per-session cost from statusline
  if [ -n "$sl_session_id" ] && [ -n "$sl_cost" ]; then
    echo "$sl_cost|$sl_duration" > "/tmp/made-claude-cost-$sl_session_id.txt"
  fi
fi

# Read precise token counts from JSONL session file
SID='{session_id}'
if [ "$SID" = "__latest__" ]; then
  # No specific session (new pane) — no per-session cost yet.
  if [ -n "$sl_window" ]; then
    echo "0|$sl_window|$sl_model|$sl_used_pct|||$sl_version|||||$effort_level"
  fi
  exit 0
else
  CACHE="/tmp/made-sessionpath-$SID"
  if [ -f "$CACHE" ]; then
    f=$(cat "$CACHE")
    [ ! -f "$f" ] && rm -f "$CACHE" && f=""
  fi
  if [ -z "$f" ]; then
    f=$(find ~/.claude/projects/ -name "$SID.jsonl" -type f 2>/dev/null | head -1)
    [ -n "$f" ] && echo "$f" > "$CACHE"
  fi
fi
[ -z "$f" ] && exit 0

# Per-session cost: use statusline if session matches, else cached
sess_cost=""
sess_duration=""
if [ -n "$sl_session_id" ] && [ "$sl_session_id" = "$SID" ]; then
  sess_cost="$sl_cost"
  sess_duration="$sl_duration"
elif [ -f "/tmp/made-claude-cost-$SID.txt" ]; then
  IFS='|' read sess_cost sess_duration < "/tmp/made-claude-cost-$SID.txt"
fi

# Project cost: sum all cached session costs in the project directory
proj_cost=""
proj_dir=$(dirname "$f")
if [ -d "$proj_dir" ]; then
  proj_cost=0
  for sf in "$proj_dir"/*.jsonl; do
    [ ! -f "$sf" ] && continue
    sid=$(basename "$sf" .jsonl)
    sc=""
    if [ -n "$sl_session_id" ] && [ "$sid" = "$sl_session_id" ] && [ -n "$sl_cost" ]; then
      sc="$sl_cost"
    elif [ -f "/tmp/made-claude-cost-$sid.txt" ]; then
      sc=$(cut -d'|' -f1 "/tmp/made-claude-cost-$sid.txt")
    fi
    [ -n "$sc" ] && proj_cost=$(awk "BEGIN{{printf \"%.6f\", $proj_cost + $sc}}")
  done
fi

# Extract custom title (from /rename command)
custom_title=$(_rev "$f" 2>/dev/null | grep '"custom-title"' | head -1 | jq -r '.customTitle // empty' 2>/dev/null)
# Fallback: read session name from ~/.claude/sessions/*.json (Claude CLI v2.1+)
if [ -z "$custom_title" ]; then
  for sf in "$HOME/.claude/sessions"/*.json; do
    [ -f "$sf" ] || continue
    sn=$(jq -r "select(.sessionId == \"$SID\") | .name // empty" "$sf" 2>/dev/null)
    if [ -n "$sn" ]; then custom_title="$sn"; break; fi
  done
fi

line=$(_rev "$f" 2>/dev/null | grep '"message"' | grep '"usage"' | head -1)
if [ -z "$line" ]; then
  if [ -n "$sl_window" ]; then
    echo "0|$sl_window|$sl_model|$sl_used_pct|$sess_cost|$sess_duration|$sl_version|||0|$proj_cost|$effort_level|$custom_title"
  fi
  exit 0
fi
total=$(echo "$line" | jq '((.message.usage.input_tokens // 0) + (.message.usage.cache_creation_input_tokens // 0) + (.message.usage.cache_read_input_tokens // 0) + (.message.usage.output_tokens // 0))' 2>/dev/null)
[ -z "$total" ] || [ "$total" = "null" ] || [ "$total" = "0" ] && exit 0
service_tier=$(echo "$line" | jq -r '.message.usage.service_tier // empty' 2>/dev/null)
speed=$(echo "$line" | jq -r '.message.usage.speed // empty' 2>/dev/null)
window="${{sl_window:-200000}}"
model="${{sl_model:-$(echo "$line" | jq -r '.message.model // empty' 2>/dev/null)}}"
compact_count=$(grep -c 'compact_boundary' "$f" 2>/dev/null || echo 0)
echo "$total|$window|$model|$sl_used_pct|$sess_cost|$sess_duration|$sl_version|$service_tier|$speed|$compact_count|$proj_cost|$effort_level|$custom_title"
"#,
            session_id = session_id
        ),
        "codex" => format!(
            r#"
command -v jq >/dev/null 2>&1 || exit 0

# tac is GNU-only; macOS/BSD spells it `tail -r`. These scripts now run on
# remote hosts too, where either may be the case.
_rev() {{ tac "$1" 2>/dev/null || tail -r "$1" 2>/dev/null; }}
SID='{session_id}'
PROJDIR={project_dir}
if [ "$SID" = "__latest__" ]; then
  # No specific session — newest rollout FOR THIS PROJECT. Scoped by the cwd
  # recorded in each rollout's session_meta first line; taking the newest file
  # outright showed another project's context in a pane that had just opened.
  f=""
  # -i because Codex lowercases the cwd it records for some rollouts, and skip
  # its own sub-agent rollouts — they carry the pane's cwd too, so an unfiltered
  # match shows the header a conversation nobody opened.
  for rf in $(find ~/.codex/sessions/ -name '*.jsonl' -type f 2>/dev/null | xargs ls -1t 2>/dev/null | head -60); do
    _l=$(head -1 "$rf" 2>/dev/null)
    printf '%s' "$_l" | grep -qiF "\"cwd\":\"$PROJDIR\"" || continue
    printf '%s' "$_l" | grep -qF '"thread_source":"subagent"' && continue
    f="$rf" && break
  done
else
  CACHE="/tmp/made-sessionpath-$SID"
  if [ -f "$CACHE" ]; then
    f=$(cat "$CACHE")
    [ ! -f "$f" ] && rm -f "$CACHE" && f=""
  fi
  if [ -z "$f" ]; then
    f=$(find ~/.codex/sessions/ -name "*$SID*.jsonl" -type f 2>/dev/null | head -1)
    [ -n "$f" ] && echo "$f" > "$CACHE"
  fi
fi
[ -z "$f" ] && exit 0

# Try current session first for token data
line=$(_rev "$f" 2>/dev/null | grep '"model_context_window"' | head -1)
used=""
window=""
model=""
if [ -n "$line" ]; then
  used=$(echo "$line" | jq '.payload.info.last_token_usage.total_tokens // 0' 2>/dev/null)
  window=$(echo "$line" | jq '.payload.info.model_context_window // 0' 2>/dev/null)
  [ "$used" = "null" ] || [ "$used" = "0" ] && used=""
  [ "$window" = "null" ] || [ "$window" = "0" ] && window=""
fi
tc_line=$(_rev "$f" 2>/dev/null | grep -m1 'turn_context')
model=$(echo "$tc_line" | jq -r '.payload.model // empty' 2>/dev/null)
effort=$(echo "$tc_line" | jq -r '.payload.effort // empty' 2>/dev/null)
collab_mode=$(echo "$tc_line" | jq -r '.payload.collaboration_mode.mode // empty' 2>/dev/null)

# __latest__ mode = new pane — never use another session's token count.
[ "$SID" = "__latest__" ] && used=""

# Fallback: if current session has no window/model, get from recent sessions.
# NEVER use another session's 'used' — context % is session-specific.
if [ -z "$window" ]; then
  for rf in $(find ~/.codex/sessions/ -name '*.jsonl' -type f 2>/dev/null | xargs ls -1t 2>/dev/null | head -10); do
    [ "$rf" = "$f" ] && continue
    fb_line=$(_rev "$rf" 2>/dev/null | grep '"model_context_window"' | head -1)
    [ -z "$fb_line" ] && continue
    fb_window=$(echo "$fb_line" | jq '.payload.info.model_context_window // 0' 2>/dev/null)
    [ -z "$fb_window" ] || [ "$fb_window" = "null" ] || [ "$fb_window" = "0" ] && continue
    window="$fb_window"
    if [ -z "$model" ]; then
      fb_tc=$(_rev "$rf" 2>/dev/null | grep -m1 'turn_context')
      model=$(echo "$fb_tc" | jq -r '.payload.model // empty' 2>/dev/null)
      [ -z "$effort" ] && effort=$(echo "$fb_tc" | jq -r '.payload.effort // empty' 2>/dev/null)
      [ -z "$collab_mode" ] && collab_mode=$(echo "$fb_tc" | jq -r '.payload.collaboration_mode.mode // empty' 2>/dev/null)
    fi
    break
  done
fi

# New session with no token data yet = 0 used (100% remaining)
[ -z "$used" ] && used=0
[ -z "$window" ] && exit 0

# Rate limits: account-level — always search all sessions (newest file first)
rl_line=""
for rf in $(find ~/.codex/sessions/ -name '*.jsonl' -type f 2>/dev/null | xargs ls -1t 2>/dev/null | head -15); do
  rl_line=$(_rev "$rf" 2>/dev/null | grep '"rate_limits"' | grep -v '"rate_limits":null' | grep -m1 '"used_percent"')
  [ -n "$rl_line" ] && break
done
rl5h=""
rlweek=""
if [ -n "$rl_line" ]; then
  rl5h=$(echo "$rl_line" | jq -r '.payload.rate_limits.primary.used_percent // empty' 2>/dev/null)
  rlweek=$(echo "$rl_line" | jq -r '.payload.rate_limits.secondary.used_percent // empty' 2>/dev/null)
fi
# Read session title from SQLite
title=""
if [ "$SID" != "__latest__" ]; then
  db="$HOME/.codex/state_5.sqlite"
  [ -f "$db" ] && title=$(python3 -c "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);r=c.execute('SELECT title FROM threads WHERE id=?',(sys.argv[2],)).fetchone();print(r[0] if r else '')" "$db" "$SID" 2>/dev/null)
fi
echo "$used|$window|$model|$rl5h|$rlweek|$effort|$collab_mode|$title"
"#,
            session_id = session_id,
            project_dir = shell_escape(project_path)
        ),
        "gemini" => format!(
            r#"
command -v jq >/dev/null 2>&1 || exit 0

# --- Gemini quota (requests per day) via cached API call ---
gemini_quota_used() {{
  local model_name="$1"
  local QC="/tmp/made-gemini-quota.json"
  command -v curl >/dev/null 2>&1 || return
  # Refresh cache if stale (> 60 seconds)
  local now=$(date +%s)
  # GNU spells this `stat -c %Y`, macOS/BSD `stat -f %m` — try both, or the
  # cache always reads as stale on a Mac and re-curls on every render.
  local mtime=$(stat -c %Y "$QC" 2>/dev/null || stat -f %m "$QC" 2>/dev/null || echo 0)
  if [ ! -f "$QC" ] || [ $(( now - mtime )) -gt 60 ]; then
    local CREDS="$HOME/.gemini/oauth_creds.json"
    [ ! -f "$CREDS" ] && return
    local TOKEN=$(jq -r '.access_token // empty' "$CREDS" 2>/dev/null)
    [ -z "$TOKEN" ] && return
    local resp
    resp=$(curl -s -m 5 -X POST \
      'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota' \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d '{{}}' 2>/dev/null)
    # If token expired (401), refresh it
    if echo "$resp" | jq -e '.error.code == 401' >/dev/null 2>&1; then
      local REFRESH=$(jq -r '.refresh_token // empty' "$CREDS" 2>/dev/null)
      if [ -n "$REFRESH" ]; then
        TOKEN=$(curl -s -m 5 -X POST 'https://oauth2.googleapis.com/token' \
          -d "client_id=681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com" \
          -d "client_secret=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" \
          -d "refresh_token=$REFRESH" \
          -d "grant_type=refresh_token" 2>/dev/null | jq -r '.access_token // empty')
        [ -z "$TOKEN" ] && return
        resp=$(curl -s -m 5 -X POST \
          'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota' \
          -H "Authorization: Bearer $TOKEN" \
          -H "Content-Type: application/json" \
          -d '{{}}' 2>/dev/null)
      fi
    fi
    if echo "$resp" | jq -e '.buckets' >/dev/null 2>&1; then
      echo "$resp" > "$QC"
    fi
  fi
  # Read cached quota — match model by prefix (strip -preview, -001)
  [ ! -f "$QC" ] && return
  local base=$(echo "$model_name" | sed 's/-preview$//' | sed 's/-[0-9]*$//')
  # Try exact prefix match, then progressively shorter prefixes
  local frac=""
  frac=$(jq -r --arg m "$base" '[.buckets[] | select(.modelId == $m) | .remainingFraction] | first // empty' "$QC" 2>/dev/null)
  if [ -z "$frac" ]; then
    frac=$(jq -r --arg m "$base" '[.buckets[] | select(.modelId | startswith($m)) | .remainingFraction] | first // empty' "$QC" 2>/dev/null)
  fi
  if [ -n "$frac" ] && [ "$frac" != "null" ]; then
    echo "$frac" | awk '{{printf "%.2f", (1-$1)*100}}'
  fi
}}

SID='{session_id}'
PROJDIR={project_dir}
if [ "$SID" = "__latest__" ]; then
  # New pane — get model from most recent session, used=0 (100% remaining).
  # Scoped to THIS project's chat directories. Gemini keys them by the
  # project BASENAME, either exactly or as "<basename>-…", so both forms are
  # searched; an unscoped `ls -1t ~/.gemini/tmp/*/chats/*.json` reported
  # whatever Gemini chat was touched last anywhere on the machine.
  BASE=$(basename "$PROJDIR" | tr '[:upper:]' '[:lower:]')
  f=$(ls -1t ~/.gemini/tmp/"$BASE"/chats/*.json ~/.gemini/tmp/"$BASE"-*/chats/*.json 2>/dev/null | head -1)
  model=""
  if [ -n "$f" ]; then
    model=$(jq -r '[.messages[] | select(.model) | .model] | last // empty' "$f" 2>/dev/null)
  fi
  rpd=""
  reset_time=""
  [ -n "$model" ] && rpd=$(gemini_quota_used "$model")
  QC="/tmp/made-gemini-quota.json"
  if [ -f "$QC" ] && [ -n "$model" ]; then
    base=$(echo "$model" | sed 's/-preview$//' | sed 's/-[0-9]*$//')
    reset_time=$(jq -r --arg m "$base" '[.buckets[] | select(.modelId == $m or (.modelId | startswith($m))) | .resetTime] | first // empty' "$QC" 2>/dev/null)
  fi
  echo "0|1000000|$model|$rpd|||$reset_time"
  exit 0
fi
CACHE="/tmp/made-sessionpath-$SID"
if [ -f "$CACHE" ]; then
  f=$(cat "$CACHE")
  [ ! -f "$f" ] && rm -f "$CACHE" && f=""
fi
if [ -z "$f" ]; then
  f=$(grep -rl "$SID" ~/.gemini/tmp/*/chats/*.json 2>/dev/null | head -1)
  [ -n "$f" ] && echo "$f" > "$CACHE"
fi
[ -z "$f" ] && exit 0
inp=$(jq '[.messages[] | select(.tokens) | .tokens.input] | last // 0' "$f" 2>/dev/null)
[ -z "$inp" ] || [ "$inp" = "null" ] || [ "$inp" = "0" ] && exit 0
model=$(jq -r '[.messages[] | select(.model) | .model] | last // empty' "$f" 2>/dev/null)
case "$model" in
  gemini-2.5-pro*)   window=1000000 ;;
  gemini-2.5-flash*) window=1000000 ;;
  gemini-3-pro*)     window=1000000 ;;
  gemini-3-flash*)   window=1000000 ;;
  *)                 window=1000000 ;;
esac
rpd=""
[ -n "$model" ] && rpd=$(gemini_quota_used "$model")
# Extract summary, last thinking tokens, and quota reset time
summary=$(jq -r '.summary // empty' "$f" 2>/dev/null)
thoughts=$(jq '[.messages[] | select(.tokens.thoughts) | .tokens.thoughts] | last // 0' "$f" 2>/dev/null)
[ "$thoughts" = "null" ] && thoughts=0
QC="/tmp/made-gemini-quota.json"
reset_time=""
if [ -f "$QC" ] && [ -n "$model" ]; then
  base=$(echo "$model" | sed 's/-preview$//' | sed 's/-[0-9]*$//')
  reset_time=$(jq -r --arg m "$base" '[.buckets[] | select(.modelId == $m or (.modelId | startswith($m))) | .resetTime] | first // empty' "$QC" 2>/dev/null)
fi
echo "$inp|$window|$model|$rpd|$summary|$thoughts|$reset_time"
"#,
            session_id = session_id,
            project_dir = shell_escape(project_path)
        ),
        _ => return None,
    })
}

#[tauri::command]
async fn read_session_context(
    terminal_type: String,
    session_id: String,
    project_path: String,
    distro: Option<String>,
) -> Result<String, String> {
    if session_id.is_empty() {
        return Ok(String::new());
    }

    // Build a bash script that:
    // 1. Locates the session file (cached after first lookup)
    // 2. Reads the last usage/token_count entry
    // 3. Calculates remaining context percentage
    // ("__latest__" = no specific session yet; the script handles that itself.)
    let script = match context_script(&terminal_type, &session_id, &project_path) {
        Some(s) => s,
        None => return Ok(String::new()),
    };

    let mut args = Vec::new();
    if let Some(ref d) = distro {
        args.push("-d".to_string());
        args.push(d.clone());
    }
    args.extend(["--".to_string(), "bash".to_string()]);

    let mut child = wsl_command()
        .args(&args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to spawn wsl: {}", e))?;

    if let Some(ref mut stdin) = child.stdin {
        use std::io::Write;
        let _ = stdin.write_all(script.as_bytes());
    }
    drop(child.stdin.take());

    let output = child.wait_with_output()
        .map_err(|e| format!("Failed to wait for wsl: {}", e))?;

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

// =====================================================================
// Native (macOS / Linux) commands — direct filesystem access, no WSL
// =====================================================================

/// Resolve CLI paths on macOS/Linux using `which`.
/// Returns a BTreeMap<String, String> with cli_name → resolved_path entries.
#[tauri::command]
async fn native_resolve_cli_env(cli_names: Vec<String>) -> Result<std::collections::BTreeMap<String, String>, String> {
    let mut result = std::collections::BTreeMap::new();

    for name in &cli_names {
        let output = Command::new("which")
            .arg(name)
            .output();

        if let Ok(o) = output {
            if o.status.success() {
                let stdout = String::from_utf8_lossy(&o.stdout);
                if let Some(first_line) = stdout.lines().next() {
                    let path = first_line.trim();
                    if !path.is_empty() {
                        result.insert(name.clone(), path.to_string());
                    }
                }
            }
        }
    }

    Ok(result)
}

/// Find the most recent Claude session ID on macOS/Linux (native filesystem).
/// Claude stores sessions at $HOME/.claude/projects/<encoded-path>/<uuid>.jsonl
#[tauri::command]
async fn get_claude_session_id_native(project_path: String, exclude_ids: Vec<String>, max_age_secs: Option<u64>) -> Result<Option<String>, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let encoded = project_path.replace('/', "-");
    let encoded = encoded.trim_start_matches('-').to_string();
    let session_dir = std::path::Path::new(&home).join(".claude").join("projects").join(&encoded);

    if !session_dir.exists() {
        // Try case-insensitive match
        let projects_dir = std::path::Path::new(&home).join(".claude").join("projects");
        if !projects_dir.exists() { return Ok(None); }
        let encoded_lower = encoded.to_lowercase();
        let mut found_dir: Option<std::path::PathBuf> = None;
        if let Ok(entries) = std::fs::read_dir(&projects_dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                if entry.file_name().to_string_lossy().to_lowercase() == encoded_lower {
                    found_dir = Some(entry.path());
                    break;
                }
            }
        }
        if found_dir.is_none() { return Ok(None); }
        return find_newest_uuid_jsonl(&found_dir.unwrap(), &exclude_ids, max_age_secs);
    }

    find_newest_uuid_jsonl(&session_dir, &exclude_ids, max_age_secs)
}

/// Helper: find the newest UUID.jsonl in a directory, excluding given IDs.
/// If `max_age_secs` is provided, only consider files modified within the last N seconds.
fn find_newest_uuid_jsonl(dir: &std::path::Path, exclude_ids: &[String], max_age_secs: Option<u64>) -> Result<Option<String>, String> {
    let is_valid_uuid = |s: &str| -> bool {
        s.len() == 36
            && s.split('-').count() == 5
            && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
    };

    let now = std::time::SystemTime::now();

    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| format!("Failed to read session dir: {}", e))?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map_or(false, |ext| ext == "jsonl"))
        .filter_map(|e| {
            let mtime = e.metadata().ok()?.modified().ok()?;
            // Apply recency filter: skip files older than max_age_secs
            if let Some(max_age) = max_age_secs {
                if let Ok(age) = now.duration_since(mtime) {
                    if age.as_secs() > max_age {
                        return None;
                    }
                }
            }
            Some((e, mtime))
        })
        .collect();
    entries.sort_by(|a, b| b.1.cmp(&a.1));

    for (entry, _) in entries {
        if let Some(stem) = entry.path().file_stem().and_then(|s| s.to_str()) {
            if is_valid_uuid(stem) && !exclude_ids.iter().any(|ex| ex == stem) {
                return Ok(Some(stem.to_string()));
            }
        }
    }

    Ok(None)
}

/// Find the most recent Codex session ID on macOS/Linux (native filesystem).
#[tauri::command]
async fn get_codex_session_id_native(
    project_path: String,
    exclude_ids: Vec<String>,
    min_updated_at_ms: Option<u64>,
    now_ms: Option<u64>,
) -> Result<Option<String>, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let codex_dir = std::path::Path::new(&home).join(".codex");

    let is_valid_uuid = |s: &str| -> bool {
        s.len() == 36
            && s.split('-').count() == 5
            && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
    };

    // Primary: query SQLite via python3
    let db_path = codex_dir.join("state_5.sqlite");
    if db_path.exists() {
        let exclude_csv = exclude_ids.join(",");
        let py_script = codex_thread_query_py(&format!("r'{}'", db_path.display()));
        let floor = min_updated_at_ms.unwrap_or(0).to_string();
        let now = now_ms.unwrap_or(0).to_string();
        let output = Command::new("python3")
            .args(["-c", &py_script, &exclude_csv, &project_path, &floor, &now])
            .output();
        if let Ok(o) = output {
            let stdout = String::from_utf8_lossy(&o.stdout).trim().to_string();
            for line in stdout.lines() {
                let id = line.trim();
                if is_valid_uuid(id) {
                    return Ok(Some(id.to_string()));
                }
            }
        }
    }

    // The mtime-ranked fallback cannot honour an updated_at floor — see the WSL
    // twin. With a floor requested, no answer beats an unanchored one.
    if min_updated_at_ms.unwrap_or(0) > 0 {
        return Ok(None);
    }

    // Fallback: scan JSONL files
    let sessions_dir = codex_dir.join("sessions");
    if !sessions_dir.exists() {
        return Ok(None);
    }

    let mut files: Vec<(std::path::PathBuf, std::time::SystemTime)> = Vec::new();
    fn walk_native(dir: &std::path::Path, files: &mut Vec<(std::path::PathBuf, std::time::SystemTime)>) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let path = entry.path();
                if path.is_dir() { walk_native(&path, files); }
                else if path.extension().map_or(false, |ext| ext == "jsonl") {
                    if let Ok(m) = entry.metadata() {
                        if let Ok(t) = m.modified() { files.push((path, t)); }
                    }
                }
            }
        }
    }
    walk_native(&sessions_dir, &mut files);
    files.sort_by(|a, b| b.1.cmp(&a.1));

    for (path, _) in files.iter().take(20) {
        if let Ok(file) = std::fs::File::open(path) {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(file);
            if let Some(Ok(first_line)) = reader.lines().next() {
                let cwd_match = format!("\"cwd\":\"{}\"", project_path);
                let cwd_match_spaced = format!("\"cwd\": \"{}\"", project_path);
                if !first_line.contains(&cwd_match) && !first_line.contains(&cwd_match_spaced) {
                    continue;
                }
                // Codex's own sub-agent rollouts carry the pane's cwd too.
                if !rollout_line_is_user_thread(&first_line) {
                    continue;
                }
                // Extract UUID from "id":"<uuid>" in the line
                if let Some(id_start) = first_line.find("\"id\":\"").or_else(|| first_line.find("\"id\": \"")) {
                    let after = &first_line[id_start..];
                    // Skip past "id":" to find the UUID
                    let colon_quote = after.find(':').unwrap_or(0);
                    let remaining = &after[colon_quote+1..];
                    let remaining = remaining.trim().trim_start_matches('"');
                    if let Some(end) = remaining.find('"') {
                        let id = &remaining[..end];
                        if is_valid_uuid(id) && !exclude_ids.iter().any(|ex| ex == id) {
                            return Ok(Some(id.to_string()));
                        }
                    }
                }
            }
        }
    }

    Ok(None)
}

/// Find the most recent Gemini session ID on macOS/Linux (native filesystem).
#[tauri::command]
async fn get_gemini_session_id_native(project_path: String, exclude_ids: Vec<String>) -> Result<Option<String>, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let tmp_dir = std::path::Path::new(&home).join(".gemini").join("tmp");

    if !tmp_dir.exists() {
        return Ok(None);
    }

    let basename = project_path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_lowercase();

    let is_valid_uuid = |s: &str| -> bool {
        s.len() == 36
            && s.split('-').count() == 5
            && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
    };

    // Collect matching project dirs
    let mut session_files: Vec<(std::path::PathBuf, std::time::SystemTime)> = Vec::new();
    if let Ok(projects) = std::fs::read_dir(&tmp_dir) {
        for proj in projects.filter_map(|e| e.ok()) {
            let name = proj.file_name().to_string_lossy().to_lowercase();
            if !basename.is_empty() && name != basename && !name.starts_with(&format!("{}-", basename)) {
                continue;
            }
            let chats = proj.path().join("chats");
            if chats.is_dir() {
                if let Ok(entries) = std::fs::read_dir(&chats) {
                    for entry in entries.filter_map(|e| e.ok()) {
                        let path = entry.path();
                        if path.extension().map_or(false, |ext| ext == "json") {
                            if let Ok(m) = entry.metadata() {
                                if let Ok(t) = m.modified() { session_files.push((path, t)); }
                            }
                        }
                    }
                }
            }
        }
    }
    session_files.sort_by(|a, b| b.1.cmp(&a.1));

    for (path, _) in session_files.iter().take(20) {
        if let Ok(content) = std::fs::read_to_string(path) {
            // Look for "sessionId" in JSON
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(sid) = v.get("sessionId").and_then(|v| v.as_str()) {
                    if is_valid_uuid(sid) && !exclude_ids.iter().any(|ex| ex == sid) {
                        return Ok(Some(sid.to_string()));
                    }
                }
            }
        }
    }

    Ok(None)
}

/// Read session context on macOS/Linux (native filesystem).
/// Same logic as read_session_context_windows but uses $HOME instead of %USERPROFILE%.
#[tauri::command]
async fn read_session_context_native(
    terminal_type: String,
    session_id: String,
    project_path: String,
) -> Result<String, String> {
    if session_id.is_empty() {
        return Ok(String::new());
    }
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;

    // Delegate to the same logic as Windows, just using $HOME
    // We reuse the read_session_context_windows logic by setting USERPROFILE temporarily
    // Actually, let's just inline the same pattern with $HOME

    let is_latest = session_id == "__latest__";

    match terminal_type.as_str() {
        "claude" => {
            // Read statusline JSON if available
            let sl_path = std::path::Path::new(&home).join(".made").join("claude-statusline.json");
            let mut sl_window: Option<u64> = None;
            let mut sl_model: Option<String> = None;
            let mut sl_used_pct: Option<u64> = None;
            let mut sl_cost: Option<f64> = None;
            let mut sl_duration: Option<u64> = None;
            let mut sl_version: Option<String> = None;
            let mut sl_session_id: Option<String> = None;
            if let Ok(content) = std::fs::read_to_string(&sl_path) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                    sl_window = v.pointer("/context_window/context_window_size").and_then(|v| v.as_u64());
                    sl_model = v.pointer("/model/display_name").and_then(|v| v.as_str()).map(|s| s.to_string());
                    sl_used_pct = v.pointer("/context_window/used_percentage").and_then(|v| v.as_u64());
                    sl_cost = v.pointer("/cost/total_cost_usd").and_then(|v| v.as_f64());
                    sl_duration = v.pointer("/cost/total_duration_ms").and_then(|v| v.as_u64());
                    sl_version = v.pointer("/version").and_then(|v| v.as_str()).map(|s| s.to_string());
                    sl_session_id = v.pointer("/session_id").and_then(|v| v.as_str()).map(|s| s.to_string());
                    if let (Some(ref sid), Some(cost)) = (&sl_session_id, sl_cost) {
                        let cache_path = std::env::temp_dir().join(format!("made-claude-cost-{}.txt", sid));
                        let dur_str = sl_duration.map(|d| d.to_string()).unwrap_or_default();
                        let _ = std::fs::write(&cache_path, format!("{:.6}|{}", cost, dur_str));
                    }
                }
            }

            let used_pct_str = sl_used_pct.map(|v| v.to_string()).unwrap_or_default();
            let ver_str = sl_version.unwrap_or_default();

            // Read effortLevel from ~/.claude/settings.json
            let effort_level: String = {
                let settings_path = std::path::Path::new(&home).join(".claude").join("settings.json");
                std::fs::read_to_string(&settings_path).ok()
                    .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
                    .and_then(|v| v.get("effortLevel").and_then(|v| v.as_str()).map(|s| s.to_string()))
                    .unwrap_or_default()
            };

            if is_latest {
                if let Some(w) = sl_window {
                    return Ok(format!("0|{}|{}|{}|||{}|||||{}", w, sl_model.as_deref().unwrap_or(""), used_pct_str, ver_str, effort_level));
                }
                return Ok(String::new());
            }

            // Find session file
            let claude_dir = std::path::Path::new(&home).join(".claude").join("projects");
            let mut session_file: Option<std::path::PathBuf> = None;
            if claude_dir.exists() {
                if let Ok(projects) = std::fs::read_dir(&claude_dir) {
                    for proj in projects.filter_map(|e| e.ok()) {
                        let candidate = proj.path().join(format!("{}.jsonl", session_id));
                        if candidate.exists() {
                            session_file = Some(candidate);
                            break;
                        }
                    }
                }
            }

            let f = match session_file {
                Some(f) => f,
                None => return Ok(String::new()),
            };

            // Read last usage line + extract service_tier/speed
            let content = std::fs::read_to_string(&f).map_err(|e| e.to_string())?;
            let mut total: u64 = 0;
            let mut service_tier = String::new();
            let mut speed = String::new();
            for line in content.lines().rev() {
                if line.contains("\"message\"") && line.contains("\"usage\"") {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                        if let Some(usage) = v.pointer("/message/usage") {
                            let input = usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                            let cache_create = usage.get("cache_creation_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                            let cache_read = usage.get("cache_read_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                            let output = usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                            total = input + cache_create + cache_read + output;
                            if let Some(st) = usage.get("service_tier").and_then(|v| v.as_str()) {
                                service_tier = st.to_string();
                            }
                            if let Some(sp) = usage.get("speed").and_then(|v| v.as_str()) {
                                speed = sp.to_string();
                            }
                            break;
                        }
                    }
                }
            }

            // Count context compactions + extract custom title
            let compact_count = content.lines().filter(|l| l.contains("compact_boundary")).count();
            let mut custom_title = String::new();
            for line in content.lines().rev() {
                if line.contains("\"custom-title\"") {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                        if let Some(t) = v.get("customTitle").and_then(|v| v.as_str()) {
                            custom_title = t.to_string();
                            break;
                        }
                    }
                }
            }
            // Fallback: read session name from ~/.claude/sessions/*.json (Claude CLI v2.1+)
            if custom_title.is_empty() {
                let sessions_dir = std::path::Path::new(&home).join(".claude").join("sessions");
                if sessions_dir.is_dir() {
                    if let Ok(entries) = std::fs::read_dir(&sessions_dir) {
                        for entry in entries.filter_map(|e| e.ok()) {
                            let path = entry.path();
                            if path.extension().map_or(false, |ext| ext == "json") {
                                if let Ok(data) = std::fs::read_to_string(&path) {
                                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) {
                                        if v.get("sessionId").and_then(|v| v.as_str()) == Some(&session_id) {
                                            if let Some(n) = v.get("name").and_then(|v| v.as_str()) {
                                                if !n.is_empty() {
                                                    custom_title = n.to_string();
                                                    break;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            let (sess_cost, sess_duration): (Option<f64>, Option<u64>) =
                if sl_session_id.as_deref() == Some(&session_id) {
                    (sl_cost, sl_duration)
                } else {
                    let cache_path = std::env::temp_dir().join(format!("made-claude-cost-{}.txt", session_id));
                    if let Ok(cached) = std::fs::read_to_string(&cache_path) {
                        let parts: Vec<&str> = cached.trim().split('|').collect();
                        let c = parts.first().and_then(|s| s.parse::<f64>().ok());
                        let d = parts.get(1).and_then(|s| s.parse::<u64>().ok());
                        (c, d)
                    } else {
                        (None, None)
                    }
                };

            let proj_cost: Option<f64> = {
                let proj_dir = f.parent();
                if let Some(dir) = proj_dir {
                    let mut total_cost: f64 = 0.0;
                    let mut found_any = false;
                    if let Ok(entries) = std::fs::read_dir(dir) {
                        for entry in entries.filter_map(|e| e.ok()) {
                            let path = entry.path();
                            if path.extension().map_or(true, |ext| ext != "jsonl") { continue; }
                            let sid = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                            let sc = if sl_session_id.as_deref() == Some(&sid) {
                                sl_cost
                            } else {
                                let cp = std::env::temp_dir().join(format!("made-claude-cost-{}.txt", sid));
                                std::fs::read_to_string(&cp).ok()
                                    .and_then(|c| c.trim().split('|').next().and_then(|s| s.parse::<f64>().ok()))
                            };
                            if let Some(c) = sc { total_cost += c; found_any = true; }
                        }
                    }
                    if found_any { Some(total_cost) } else { None }
                } else { None }
            };

            let cost_str = sess_cost.map(|c| format!("{:.6}", c)).unwrap_or_default();
            let dur_str = sess_duration.map(|d| d.to_string()).unwrap_or_default();
            let proj_str = proj_cost.map(|c| format!("{:.6}", c)).unwrap_or_default();

            if total == 0 {
                if let Some(w) = sl_window {
                    // 0|window|model|used_pct|cost|dur|version|||compact|proj|effort|custom_title
                    return Ok(format!("0|{}|{}|{}|{}|{}|{}|||{}|{}|{}|{}", w, sl_model.as_deref().unwrap_or(""), used_pct_str, cost_str, dur_str, ver_str, compact_count, proj_str, effort_level, custom_title));
                }
                return Ok(String::new());
            }

            let window = sl_window.unwrap_or(200000);
            let model_str = sl_model.unwrap_or_default();
            // total|window|model|used_pct|cost|dur|version|tier|speed|compact|proj|effort|custom_title
            Ok(format!("{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}", total, window, model_str, used_pct_str, cost_str, dur_str, ver_str, service_tier, speed, compact_count, proj_str, effort_level, custom_title))
        },
        "codex" => {
            let sessions_dir = std::path::Path::new(&home).join(".codex").join("sessions");
            if !sessions_dir.exists() {
                return Ok(String::new());
            }

            let target_file: Option<std::path::PathBuf>;
            if is_latest {
                // Scoped to THIS project. Taking the newest rollout on the
                // machine meant a pane that had not yet locked a session showed
                // another project's model, context percentage and session name.
                target_file = find_codex_rollout_for_cwd(&sessions_dir, &project_path);
            } else {
                fn walk_n2(dir: &std::path::Path, uuid: &str) -> Option<std::path::PathBuf> {
                    if let Ok(entries) = std::fs::read_dir(dir) {
                        for entry in entries.filter_map(|e| e.ok()) {
                            let path = entry.path();
                            if path.is_dir() {
                                if let Some(found) = walk_n2(&path, uuid) { return Some(found); }
                            } else if path.file_name().map_or(false, |n| n.to_string_lossy().contains(uuid)) {
                                return Some(path);
                            }
                        }
                    }
                    None
                }
                target_file = walk_n2(&sessions_dir, &session_id);
            }

            let f = match target_file {
                Some(f) => f,
                None => return Ok(String::new()),
            };

            let content = std::fs::read_to_string(&f).map_err(|e| e.to_string())?;
            let mut used: Option<u64> = None;
            let mut window: Option<u64> = None;
            let mut model = String::new();
            let mut effort = String::new();
            let mut collab_mode = String::new();

            for line in content.lines().rev() {
                if window.is_some() && (used.is_some() || is_latest) { break; }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                    if window.is_none() {
                        if let Some(w) = v.pointer("/payload/info/model_context_window").and_then(|v| v.as_u64()) {
                            if w > 0 { window = Some(w); }
                        }
                        if used.is_none() && !is_latest {
                            if let Some(u) = v.pointer("/payload/info/last_token_usage/total_tokens").and_then(|v| v.as_u64()) {
                                if u > 0 { used = Some(u); }
                            }
                        }
                    }
                    if model.is_empty() {
                        if let Some(m) = v.pointer("/payload/model").and_then(|v| v.as_str()) {
                            model = m.to_string();
                        }
                    }
                    if effort.is_empty() {
                        if let Some(e) = v.pointer("/payload/effort").and_then(|v| v.as_str()) {
                            effort = e.to_string();
                        }
                    }
                    if collab_mode.is_empty() {
                        if let Some(cm) = v.pointer("/payload/collaboration_mode/mode").and_then(|v| v.as_str()) {
                            collab_mode = cm.to_string();
                        }
                    }
                }
            }

            if is_latest { used = None; }
            let used_val = used.unwrap_or(0);
            let window_val = match window {
                Some(w) => w,
                None => return Ok(String::new()),
            };

            let mut rl5h: Option<f64> = None;
            let mut rlweek: Option<f64> = None;
            {
                let mut all_files: Vec<(std::path::PathBuf, std::time::SystemTime)> = Vec::new();
                fn walk_nrl(dir: &std::path::Path, files: &mut Vec<(std::path::PathBuf, std::time::SystemTime)>) {
                    if let Ok(entries) = std::fs::read_dir(dir) {
                        for entry in entries.filter_map(|e| e.ok()) {
                            let path = entry.path();
                            if path.is_dir() { walk_nrl(&path, files); }
                            else if path.extension().map_or(false, |ext| ext == "jsonl") {
                                if let Ok(m) = entry.metadata() {
                                    if let Ok(t) = m.modified() { files.push((path, t)); }
                                }
                            }
                        }
                    }
                }
                walk_nrl(&sessions_dir, &mut all_files);
                all_files.sort_by(|a, b| b.1.cmp(&a.1));
                for (rf, _) in all_files.iter().take(15) {
                    if let Ok(rc) = std::fs::read_to_string(rf) {
                        for line in rc.lines().rev() {
                            if !line.contains("\"rate_limits\"") || line.contains("\"rate_limits\":null") { continue; }
                            if !line.contains("\"used_percent\"") { continue; }
                            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                                rl5h = v.pointer("/payload/rate_limits/primary/used_percent").and_then(|v| v.as_f64());
                                rlweek = v.pointer("/payload/rate_limits/secondary/used_percent").and_then(|v| v.as_f64());
                                break;
                            }
                        }
                    }
                    if rl5h.is_some() { break; }
                }
            }
            let rl5h_str = rl5h.map(|v| format!("{:.2}", v)).unwrap_or_default();
            let rlweek_str = rlweek.map(|v| format!("{:.2}", v)).unwrap_or_default();

            // Read session title from SQLite
            let mut title = String::new();
            if !is_latest {
                let db_path = std::path::Path::new(&home).join(".codex").join("state_5.sqlite");
                if db_path.exists() {
                    let py = format!(
                        r#"import sqlite3,sys;c=sqlite3.connect(r'{}');r=c.execute('SELECT title FROM threads WHERE id=?',(sys.argv[1],)).fetchone();print(r[0] if r else '')"#,
                        db_path.display()
                    );
                    if let Ok(out) = std::process::Command::new("python3").args(["-c", &py, &session_id]).output() {
                        title = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    }
                }
            }

            Ok(format!("{}|{}|{}|{}|{}|{}|{}|{}", used_val, window_val, model, rl5h_str, rlweek_str, effort, collab_mode, title))
        },
        "gemini" => {
            let tmp_dir = std::path::Path::new(&home).join(".gemini").join("tmp");
            if !tmp_dir.exists() {
                return Ok(String::new());
            }

            // The session ID is the authority when the pane has one: find the
            // chat file that CONTAINS it, wherever Gemini filed it. This branch
            // used to ignore `session_id` outright and read whichever chat file
            // on the machine was touched last, so every Gemini pane displayed
            // the same — usually wrong — session. Only `__latest__` still asks
            // the directory, and then only THIS project's.
            let f = if is_latest {
                match gemini_chat_files(&gemini_project_dirs(&home, &project_path)).into_iter().next() {
                    Some(p) => p,
                    None => return Ok(String::new()),
                }
            } else {
                match find_gemini_chat_by_id(&home, &session_id) {
                    Some(p) => p,
                    None => return Ok(String::new()),
                }
            };

            let content = std::fs::read_to_string(&f).map_err(|e| e.to_string())?;
            let v: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;

            let inp = v.pointer("/messages")
                .and_then(|m| m.as_array())
                .map(|msgs| msgs.iter().rev().find_map(|m| m.pointer("/tokens/input").and_then(|v| v.as_u64())).unwrap_or(0))
                .unwrap_or(0);
            if inp == 0 { return Ok(String::new()); }

            let model = v.pointer("/messages")
                .and_then(|m| m.as_array())
                .map(|msgs| msgs.iter().rev().find_map(|m| m.get("model").and_then(|v| v.as_str())).unwrap_or(""))
                .unwrap_or("");

            let summary = v.get("summary").and_then(|v| v.as_str()).unwrap_or("");

            let thoughts = v.pointer("/messages")
                .and_then(|m| m.as_array())
                .map(|msgs| msgs.iter().rev().find_map(|m| m.pointer("/tokens/thoughts").and_then(|v| v.as_u64())).unwrap_or(0))
                .unwrap_or(0);

            Ok(format!("{}|1000000|{}||{}|{}|", inp, model, summary, thoughts))
        },
        _ => Ok(String::new()),
    }
}

/// Shared helper: find a project's sessions directory with case-insensitive fallback.
fn find_claude_project_dir(home: &str, project_path: &str, separator: char) -> Option<std::path::PathBuf> {
    let encoded = project_path.replace('\\', "-").replace(separator, "-");
    let encoded = encoded.trim_start_matches('-').to_string();
    let projects_dir = std::path::Path::new(home).join(".claude").join("projects");
    let exact = projects_dir.join(&encoded);
    if exact.exists() { return Some(exact); }
    // Case-insensitive fallback
    let lower = encoded.to_lowercase();
    std::fs::read_dir(&projects_dir).ok()?
        .filter_map(|e| e.ok())
        .find(|e| e.file_name().to_string_lossy().to_lowercase() == lower)
        .map(|e| e.path())
}

/// Parse sessions-index.json and return a JSON array of entries.
/// Format epoch millis as an ISO-8601 UTC string (`2026-07-25T19:06:25Z`).
///
/// Hand-rolled because this crate has no date dependency. Uses Howard
/// Hinnant's civil_from_days; verified against 20k timestamps.
fn iso8601_utc(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, m, d, hh, mm, ss)
}

fn file_mtime_ms(path: &std::path::Path) -> u64 {
    path.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The session list for one Claude project directory.
///
/// The transcripts ARE the inventory. `sessions-index.json` is Claude's own
/// cache and it stopped being written in early 2026 — it survives in a handful
/// of stale project dirs and is absent everywhere else, which is why the
/// session dropdown had been permanently empty (and why `sessionStillExists`,
/// which used to read it, never once blocked a bad resume). So enumerate
/// `<dir>/*.jsonl` and treat any surviving index entry as enrichment only
/// (summary / customTitle / gitBranch / messageCount) — never as the authority
/// on whether a session exists.
fn is_uuid_stem(s: &str) -> bool {
    s.len() == 36
        && s.split('-').count() == 5
        && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// EVERY session id this project has a transcript for — uncapped, no file
/// reads, just the directory listing.
///
/// Separate from build_sessions_list because that one truncates to the 30 most
/// recent for display. Using a truncated list to decide what is dead would
/// delete real sessions from the registry: this machine has a project with 59
/// transcripts, so 29 live sessions would have looked absent.
fn list_session_ids(dir: &std::path::Path) -> Vec<String> {
    let read_dir = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    read_dir
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map_or(false, |ext| ext == "jsonl"))
        .filter_map(|p| p.file_stem().and_then(|s| s.to_str()).map(|s| s.to_string()))
        .filter(|s| is_uuid_stem(s))
        .collect()
}

/// Complete session-id list for a project (WSL).
#[tauri::command]
async fn claude_session_ids(project_path: String, distro: Option<String>) -> Result<Vec<String>, String> {
    Ok(resolve_wsl_project_dir(&project_path, distro.as_deref())
        .map(|d| list_session_ids(&d))
        .unwrap_or_default())
}

/// Complete session-id list for a project (native Windows).
#[tauri::command]
async fn claude_session_ids_windows(project_path: String) -> Result<Vec<String>, String> {
    let home = match std::env::var("USERPROFILE") { Ok(h) => h, Err(_) => return Ok(Vec::new()) };
    Ok(find_claude_project_dir(&home, &project_path, '/')
        .map(|d| list_session_ids(&d))
        .unwrap_or_default())
}

/// Complete session-id list for a project (macOS/Linux).
#[tauri::command]
async fn claude_session_ids_native(project_path: String) -> Result<Vec<String>, String> {
    let home = match std::env::var("HOME") { Ok(h) => h, Err(_) => return Ok(Vec::new()) };
    Ok(find_claude_project_dir(&home, &project_path, '/')
        .map(|d| list_session_ids(&d))
        .unwrap_or_default())
}

fn build_sessions_list(dir: &std::path::Path) -> Result<String, String> {
    let is_valid_uuid = is_uuid_stem;

    // Surviving index entries, keyed by session id. Absent on nearly every
    // project — that is expected, not an error.
    let mut meta: std::collections::HashMap<String, serde_json::Value> = std::collections::HashMap::new();
    if let Ok(content) = std::fs::read_to_string(dir.join("sessions-index.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(arr) = v.get("entries").and_then(|e| e.as_array()) {
                for e in arr {
                    if let Some(sid) = e.get("sessionId").and_then(|s| s.as_str()) {
                        meta.insert(sid.to_string(), e.clone());
                    }
                }
            }
        }
    }

    let read_dir = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return Ok("[]".to_string()),
    };

    let mut rows: Vec<(u64, serde_json::Value)> = Vec::new();
    for entry in read_dir.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.extension().map_or(true, |ext| ext != "jsonl") { continue; }
        let sid = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) if is_valid_uuid(s) => s.to_string(),
            _ => continue,
        };
        let e = meta.get(&sid);
        if e.and_then(|e| e.get("isSidechain")).and_then(|b| b.as_bool()).unwrap_or(false) { continue; }

        let mtime_ms = file_mtime_ms(&path);
        // Prefer the index's firstPrompt (already extracted) and only fall back
        // to reading the transcript, which early-exits at the first user turn.
        let first_prompt = e
            .and_then(|e| e.get("firstPrompt"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| read_first_user_prompt_from_jsonl(&path))
            .unwrap_or_default();
        let truncated: String = first_prompt.chars().take(100).collect();
        // mtime is ground truth for "last worked in"; the index's own timestamps
        // are only used for `created`, which mtime cannot tell us.
        let created = e
            .and_then(|e| e.get("created"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| iso8601_utc(mtime_ms));

        rows.push((mtime_ms, serde_json::json!({
            "sessionId": sid,
            "summary": e.and_then(|e| e.get("summary")).and_then(|v| v.as_str()).unwrap_or(""),
            "customTitle": e.and_then(|e| e.get("customTitle")).and_then(|v| v.as_str()).unwrap_or(""),
            "firstPrompt": truncated,
            "messageCount": e.and_then(|e| e.get("messageCount")).and_then(|v| v.as_u64()).unwrap_or(0),
            "created": created,
            "modified": iso8601_utc(mtime_ms),
            "gitBranch": e.and_then(|e| e.get("gitBranch")).and_then(|v| v.as_str()).unwrap_or(""),
            "isSidechain": false,
        })));
    }

    rows.sort_by(|a, b| b.0.cmp(&a.0));
    rows.truncate(30);
    let items: Vec<serde_json::Value> = rows.into_iter().map(|(_, v)| v).collect();
    serde_json::to_string(&items).map_err(|e| e.to_string())
}

/// Parse a `sessions-index.json` payload already loaded into memory.
///
/// SSH-only. Local backends use build_sessions_list, which enumerates the
/// transcripts themselves; over SSH we cannot cheaply stat a directory and read
/// each file's first prompt, so remote projects still depend on the index and
/// will list nothing when the remote Claude no longer writes one.
fn parse_sessions_index_from_content(content: &str) -> Result<String, String> {
    if content.trim().is_empty() {
        return Ok("[]".to_string());
    }
    let v: serde_json::Value = serde_json::from_str(content).map_err(|e| e.to_string())?;
    let entries = match v.get("entries").and_then(|e| e.as_array()) {
        Some(arr) => arr,
        None => return Ok("[]".to_string()),
    };

    let mut items: Vec<serde_json::Value> = entries.iter()
        .filter(|e| !e.get("isSidechain").and_then(|v| v.as_bool()).unwrap_or(false))
        .map(|e| {
            let first_prompt = e.get("firstPrompt").and_then(|v| v.as_str()).unwrap_or("");
            let truncated: String = first_prompt.chars().take(100).collect();
            serde_json::json!({
                "sessionId": e.get("sessionId").and_then(|v| v.as_str()).unwrap_or(""),
                "summary": e.get("summary").and_then(|v| v.as_str()).unwrap_or(""),
                "customTitle": e.get("customTitle").and_then(|v| v.as_str()).unwrap_or(""),
                "firstPrompt": truncated,
                "messageCount": e.get("messageCount").and_then(|v| v.as_u64()).unwrap_or(0),
                "created": e.get("created").and_then(|v| v.as_str()).unwrap_or(""),
                "modified": e.get("modified").and_then(|v| v.as_str()).unwrap_or(""),
                "gitBranch": e.get("gitBranch").and_then(|v| v.as_str()).unwrap_or(""),
                "isSidechain": false,
            })
        })
        .collect();

    // Sort by modified desc, limit to 30
    items.sort_by(|a, b| {
        let ma = a.get("modified").and_then(|v| v.as_str()).unwrap_or("");
        let mb = b.get("modified").and_then(|v| v.as_str()).unwrap_or("");
        mb.cmp(ma)
    });
    items.truncate(30);

    serde_json::to_string(&items).map_err(|e| e.to_string())
}

/// List a project's Claude sessions on native Windows via %USERPROFILE%.
#[tauri::command]
async fn read_sessions_index_windows(project_path: String) -> Result<String, String> {
    let home = std::env::var("USERPROFILE").map_err(|_| "USERPROFILE not set".to_string())?;
    let dir = match find_claude_project_dir(&home, &project_path, '/') {
        Some(d) => d,
        None => return Ok("[]".to_string()),
    };
    build_sessions_list(&dir)
}

/// List a project's Claude sessions on macOS/Linux via $HOME.
#[tauri::command]
async fn read_sessions_index_native(project_path: String) -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let dir = match find_claude_project_dir(&home, &project_path, '/') {
        Some(d) => d,
        None => return Ok("[]".to_string()),
    };
    build_sessions_list(&dir)
}

/// List a project's Claude sessions (WSL).
///
/// Implemented natively in Rust over the `\\wsl.localhost` UNC share — same
/// approach as read_session_first_prompt. No bash, no python, no wsl.exe
/// round-trip, which matters because the session dropdown polls this every 30s.
/// The old bash script bailed at `[ -f "$FILE" ] || exit 0`, so once Claude
/// stopped writing sessions-index.json it returned nothing, forever.
#[tauri::command]
async fn read_sessions_index(project_path: String, distro: Option<String>) -> Result<String, String> {
    match resolve_wsl_project_dir(&project_path, distro.as_deref()) {
        Some(dir) => build_sessions_list(&dir),
        None => Ok("[]".to_string()),
    }
}

/// Read the first user prompt from JSONL content (already loaded into memory).
/// Used by SSH variants that fetch the file contents over the network.
fn read_first_user_prompt_from_content(content: &str) -> Option<String> {
    for line in content.lines() {
        if !line.contains("\"type\":\"user\"") { continue; }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("isSidechain").and_then(|b| b.as_bool()).unwrap_or(false) { continue; }
        if v.get("type").and_then(|t| t.as_str()) != Some("user") { continue; }
        let content_v = v.get("message").and_then(|m| m.get("content"))?;
        let text = if let Some(s) = content_v.as_str() {
            s.to_string()
        } else if let Some(arr) = content_v.as_array() {
            arr.iter()
                .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join(" ")
        } else {
            continue;
        };
        if text.trim().is_empty() { continue; }
        if text.starts_with('/') || text.starts_with("<") || text.starts_with("[Request") { continue; }
        let truncated: String = text.chars().take(200).collect();
        return Some(truncated);
    }
    None
}

/// Read the first user prompt from a session JSONL file (streaming).
/// Skips sidechain entries. Returns truncated text (max 200 chars) or None.
fn read_first_user_prompt_from_jsonl(path: &std::path::Path) -> Option<String> {
    use std::io::{BufRead, BufReader};
    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    for line in reader.lines().filter_map(|l| l.ok()) {
        if !line.contains("\"type\":\"user\"") { continue; }
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("isSidechain").and_then(|b| b.as_bool()).unwrap_or(false) { continue; }
        if v.get("type").and_then(|t| t.as_str()) != Some("user") { continue; }
        let content = v.get("message").and_then(|m| m.get("content"))?;
        let text = if let Some(s) = content.as_str() {
            s.to_string()
        } else if let Some(arr) = content.as_array() {
            arr.iter()
                .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join(" ")
        } else {
            continue;
        };
        if text.trim().is_empty() { continue; }
        // Skip command invocations and system messages
        if text.starts_with('/') || text.starts_with("<") || text.starts_with("[Request") { continue; }
        let truncated: String = text.chars().take(200).collect();
        return Some(truncated);
    }
    None
}

/// Every user prompt in a Claude session JSONL, oldest first.
///
/// Same filtering as `read_first_user_prompt_from_jsonl` (skip sidechains,
/// slash-commands, `<tags>`, `[Request…]`) — this is the list-returning twin of
/// it. The pane scrollbar matches Claude's on-screen "sticky prompt" against
/// this list to derive an EXACT position ("message 7 of 20") instead of
/// dead-reckoning wheel notches, which cannot be exact because Claude
/// accelerates the wheel and one notch is not a fixed number of lines.
///
/// Each entry is truncated to 200 chars: only a prefix is ever needed, since
/// the sticky row itself is truncated to the pane width.
fn read_user_prompts_from_jsonl(path: &std::path::Path) -> Vec<String> {
    use std::io::{BufRead, BufReader};
    let Ok(file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let reader = BufReader::new(file);
    let mut out: Vec<String> = Vec::new();
    for line in reader.lines().filter_map(|l| l.ok()) {
        if !line.contains("\"type\":\"user\"") { continue; }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        if v.get("isSidechain").and_then(|b| b.as_bool()).unwrap_or(false) { continue; }
        if v.get("type").and_then(|t| t.as_str()) != Some("user") { continue; }
        let Some(content) = v.get("message").and_then(|m| m.get("content")) else { continue };
        let text = if let Some(s) = content.as_str() {
            s.to_string()
        } else if let Some(arr) = content.as_array() {
            arr.iter()
                .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join(" ")
        } else {
            continue;
        };
        let trimmed = text.trim();
        if trimmed.is_empty() { continue; }
        if trimmed.starts_with('/') || trimmed.starts_with('<') || trimmed.starts_with("[Request") {
            continue;
        }
        out.push(trimmed.chars().take(200).collect());
    }
    out
}

/// Last assistant reply text in a session JSONL, read from a bounded tail
/// window. Transcripts routinely hit tens of MB and this runs on every
/// finished-turn notification, so it must not stream the whole file the way
/// the first-prompt readers above do. 256 KB from the end covers dozens of
/// messages; if the last text reply is older than that the pane notification
/// falls back to the OSC status text, which is acceptable.
fn read_last_assistant_text_from_jsonl(path: &std::path::Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    const TAIL_BYTES: u64 = 262_144;
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut raw = Vec::with_capacity(TAIL_BYTES.min(len) as usize);
    file.read_to_end(&mut raw).ok()?;
    // Lossy: seeking to an arbitrary byte offset can land mid-UTF8; the first
    // (partial) line is discarded below anyway, but from_utf8 would refuse the
    // whole buffer.
    let buf = String::from_utf8_lossy(&raw);
    let mut lines: Vec<&str> = buf.lines().collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    for line in lines.iter().rev() {
        if !line.contains("\"type\":\"assistant\"") { continue; }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if v.get("isSidechain").and_then(|b| b.as_bool()).unwrap_or(false) { continue; }
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") { continue; }
        let Some(content) = v.get("message").and_then(|m| m.get("content")) else { continue };
        let text = if let Some(s) = content.as_str() {
            s.to_string()
        } else if let Some(arr) = content.as_array() {
            // Text blocks only — assistant turns also carry thinking/tool_use
            // blocks, which must not leak into the notification.
            arr.iter()
                .filter(|item| item.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join(" ")
        } else {
            continue;
        };
        let trimmed = text.trim();
        if trimmed.is_empty() { continue; }
        return Some(trimmed.chars().take(300).collect());
    }
    None
}

/// Resolve a Claude session JSONL inside WSL via the \\wsl.localhost UNC path.
/// Extracted so the first-prompt and all-prompts commands cannot drift apart —
/// this is the only backend whose path resolution is non-trivial (unknown
/// distro, unknown linux user).
pub(crate) fn resolve_wsl_session_jsonl(
    project_path: &str,
    session_id: &str,
    distro: Option<&str>,
) -> Option<std::path::PathBuf> {
    let encoded = project_path.replace('/', "-");
    let distro_name = distro.unwrap_or("").trim().to_string();
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    let mut try_distro = |d: &str, candidates: &mut Vec<std::path::PathBuf>| {
        if d.is_empty() { return; }
        for prefix in ["\\\\wsl.localhost", "\\\\wsl$"] {
            let base = std::path::PathBuf::from(format!("{}\\{}\\home", prefix, d));
            if base.is_dir() {
                if let Ok(users) = std::fs::read_dir(&base) {
                    for u in users.filter_map(|e| e.ok()) {
                        let projects = u.path().join(".claude").join("projects");
                        let p = projects.join(&encoded).join(format!("{}.jsonl", session_id));
                        if p.exists() {
                            candidates.push(p);
                            continue;
                        }
                        // CASE-INSENSITIVE fallback. The encoded key comes from
                        // a WINDOWS path, but WSL's filesystem is case-
                        // SENSITIVE, so `…-Documents-…` and `…-documents-…` are
                        // two different directories — and both exist on real
                        // machines (one holding every session, the other
                        // empty). Landing in the empty one made every session
                        // read return nothing, which is what silently broke
                        // auto-naming: readSessionFirstPrompt returned "" and
                        // the retry loop never set a name. The Windows/native
                        // paths already handled this via find_claude_project_dir.
                        let want = encoded.to_lowercase();
                        if let Ok(dirs) = std::fs::read_dir(&projects) {
                            for d in dirs.filter_map(|e| e.ok()) {
                                if d.file_name().to_string_lossy().to_lowercase() == want {
                                    let p = d.path().join(format!("{}.jsonl", session_id));
                                    if p.exists() { candidates.push(p); }
                                }
                            }
                        }
                    }
                }
            }
        }
    };
    try_distro(&distro_name, &mut candidates);
    if candidates.is_empty() {
        for d in ["Ubuntu-24.04", "Ubuntu-22.04", "Ubuntu", "Debian"] {
            try_distro(d, &mut candidates);
            if !candidates.is_empty() { break; }
        }
    }
    if candidates.is_empty() {
        if let Ok(home) = std::env::var("HOME") {
            let p = std::path::PathBuf::from(&home)
                .join(".claude").join("projects").join(&encoded)
                .join(format!("{}.jsonl", session_id));
            if p.exists() { candidates.push(p); }
        }
    }
    candidates.into_iter().next()
}

/// Result of "can this session id actually be resumed?".
///
/// Two booleans, not one, because "no transcript" and "I could not look" must
/// never collapse into the same answer. `checked = false` means the project
/// directory itself was unreachable (WSL UNC down, HOME unset, project never
/// opened by Claude) — the caller then fails OPEN and resumes anyway rather
/// than discarding a real conversation on a failed lookup.
#[derive(Serialize)]
struct SessionFileCheck {
    exists: bool,
    checked: bool,
}

/// Locate the Claude project DIRECTORY for a WSL project path.
///
/// Mirrors resolve_wsl_session_jsonl's distro/UNC/HOME walk exactly, but stops
/// at the directory so callers can distinguish "directory found, file absent"
/// from "directory not found". Kept adjacent to it so the two cannot drift.
fn resolve_wsl_project_dir(project_path: &str, distro: Option<&str>) -> Option<std::path::PathBuf> {
    let encoded = project_path.replace('/', "-");
    let want = encoded.to_lowercase();
    let mut found: Option<std::path::PathBuf> = None;

    let try_distro = |d: &str, found: &mut Option<std::path::PathBuf>| {
        if d.is_empty() || found.is_some() { return; }
        for prefix in ["\\\\wsl.localhost", "\\\\wsl$"] {
            let base = std::path::PathBuf::from(format!("{}\\{}\\home", prefix, d));
            if !base.is_dir() { continue; }
            let users = match std::fs::read_dir(&base) { Ok(u) => u, Err(_) => continue };
            for u in users.filter_map(|e| e.ok()) {
                let projects = u.path().join(".claude").join("projects");
                let exact = projects.join(&encoded);
                if exact.is_dir() { *found = Some(exact); return; }
                // Case-insensitive fallback: the encoded key comes from a
                // Windows path but WSL's filesystem is case-sensitive, so
                // `…-Documents-…` and `…-documents-…` are different dirs and
                // both exist on real machines.
                if let Ok(dirs) = std::fs::read_dir(&projects) {
                    for d in dirs.filter_map(|e| e.ok()) {
                        if d.file_name().to_string_lossy().to_lowercase() == want {
                            *found = Some(d.path());
                            return;
                        }
                    }
                }
            }
        }
    };

    try_distro(distro.unwrap_or("").trim(), &mut found);
    if found.is_none() {
        for d in ["Ubuntu-24.04", "Ubuntu-22.04", "Ubuntu", "Debian"] {
            try_distro(d, &mut found);
            if found.is_some() { break; }
        }
    }
    if found.is_none() {
        if let Ok(home) = std::env::var("HOME") {
            let p = std::path::PathBuf::from(&home).join(".claude").join("projects").join(&encoded);
            if p.is_dir() { found = Some(p); }
        }
    }
    found
}

/// The guest's home directory as a Windows UNC path, e.g.
/// `\\wsl.localhost\Ubuntu-24.04\home\nicko`.
///
/// Same distro probing order as `resolve_wsl_project_dir` — the caller-supplied
/// distro first, then the common images. Returns every home found rather than
/// the first, because a distro can have several users and only one of them owns
/// the CLI's dot-directory.
///
/// Lets the Gemini helpers run unchanged against WSL: they take a home path and
/// do plain file reads, which work fine over the UNC share. NOT used for Codex —
/// its state lives in a SQLite database with a WAL, and opening that across SMB
/// is a good way to get a spurious "database is locked". Codex runs its query
/// inside the guest instead.
fn wsl_home_dirs(distro: Option<&str>) -> Vec<std::path::PathBuf> {
    let mut homes = Vec::new();
    let mut probe = |d: &str, homes: &mut Vec<std::path::PathBuf>| {
        if d.is_empty() { return; }
        for prefix in ["\\\\wsl.localhost", "\\\\wsl$"] {
            let base = std::path::PathBuf::from(format!("{}\\{}\\home", prefix, d));
            if !base.is_dir() { continue; }
            let Ok(users) = std::fs::read_dir(&base) else { continue };
            for u in users.filter_map(|e| e.ok()) {
                if u.path().is_dir() { homes.push(u.path()); }
            }
            if !homes.is_empty() { return; }
        }
    };
    probe(distro.unwrap_or("").trim(), &mut homes);
    if homes.is_empty() {
        for d in ["Ubuntu-24.04", "Ubuntu-22.04", "Ubuntu", "Debian"] {
            probe(d, &mut homes);
            if !homes.is_empty() { break; }
        }
    }
    homes
}

/// A project's sessions for a NON-Claude CLI, as the same
/// `SessionIndexEntry[]` JSON the Claude path returns (macOS/Linux).
///
/// Claude's list has always come from disk; Codex and Gemini had no equivalent,
/// so their session picker could only show what MADE itself had registered — a
/// session started in a terminal outside MADE was invisible and unresumable.
#[tauri::command]
async fn read_cli_sessions_index_native(
    terminal_type: String,
    project_path: String,
) -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    match terminal_type.as_str() {
        "codex" => {
            let db = std::path::Path::new(&home).join(".codex").join("state_5.sqlite");
            if !db.exists() { return Ok("[]".to_string()); }
            let py = codex_sessions_index_py(&format!("r'{}'", db.display()));
            let out = Command::new("python3").args(["-c", &py, &project_path]).output();
            Ok(codex_index_stdout(out))
        }
        "gemini" => gemini_sessions_list(&home, &project_path),
        _ => Ok("[]".to_string()),
    }
}

/// Windows-native variant of read_cli_sessions_index_native.
#[tauri::command]
async fn read_cli_sessions_index_windows(
    terminal_type: String,
    project_path: String,
) -> Result<String, String> {
    let home = std::env::var("USERPROFILE").map_err(|_| "USERPROFILE not set".to_string())?;
    match terminal_type.as_str() {
        "codex" => {
            let db = std::path::Path::new(&home).join(".codex").join("state_5.sqlite");
            if !db.exists() { return Ok("[]".to_string()); }
            let py = codex_sessions_index_py(&format!("r'{}'", db.display()));
            // Windows often ships `python` without `python3`.
            let out = Command::new("python3")
                .args(["-c", &py, &project_path])
                .output()
                .or_else(|_| Command::new("python").args(["-c", &py, &project_path]).output());
            Ok(codex_index_stdout(out))
        }
        "gemini" => gemini_sessions_list(&home, &project_path),
        _ => Ok("[]".to_string()),
    }
}

/// WSL variant of read_cli_sessions_index_native.
#[tauri::command]
async fn read_cli_sessions_index(
    terminal_type: String,
    project_path: String,
    distro: Option<String>,
) -> Result<String, String> {
    match terminal_type.as_str() {
        "codex" => {
            // Quoted heredoc: the body carries both quote characters, and a
            // quoted delimiter disables every shell expansion (same contract as
            // get_codex_session_id).
            let script = format!(
                "python3 - '{}' <<'MADE_CODEX_PY'\n{}MADE_CODEX_PY\n",
                project_path.replace('\'', "'\\''"),
                codex_sessions_index_py("os.path.expanduser('~/.codex/state_5.sqlite')"),
            );
            let out = wsl_command_in(distro.as_deref())
                .args(["--", "bash", "-lic", &script])
                .output();
            Ok(codex_index_stdout(out))
        }
        "gemini" => {
            for home in wsl_home_dirs(distro.as_deref()) {
                let list = gemini_sessions_list(&home.to_string_lossy(), &project_path)?;
                if list != "[]" { return Ok(list); }
            }
            Ok("[]".to_string())
        }
        _ => Ok("[]".to_string()),
    }
}

/// Python body: print `1` if `argv[1]` is a resumable Codex session, `0` if it
/// is definitely gone, and NOTHING if the question could not be answered.
///
/// Two sources, and a hit in EITHER counts. The threads table is authoritative
/// for Codex ≥0.113, but a rollout written by an older version has no row there
/// while `codex resume` still finds it by file — answering from SQLite alone
/// reports a live session as deleted, and the caller's response to "deleted" is
/// to discard the id and start fresh. That is real work lost, so the file check
/// is not optional.
///
/// `argv[2]` is the cwd the caller EXPECTS this session to belong to, or empty
/// to skip that half of the question.
///
/// This used to be deliberately unfiltered, on the reasoning that an agent
/// thread still exists and the question was only "will `codex resume <id>` find
/// something". That let ids adopted by the old unanchored drift check survive
/// forever: nothing prunes Codex rows, so a pane pointed at a sub-agent thread
/// — or at another project's — resumed it on every launch. A positively
/// identified sub-agent, or a thread whose recorded cwd is a different project,
/// is now answered `0` so the caller drops it and starts fresh.
///
/// Everything else keeps the fail-open contract intact. A rollout that exists
/// on disk with NO threads row still answers `1` (an older Codex wrote it and
/// `codex resume` still finds it by file), and "could not look" still prints
/// nothing so it can never collapse into "definitely absent".
fn codex_session_exists_py(db_expr: &str, sessions_expr: &str) -> String {
    format!(
        r#"import sqlite3,os,sys
sid=sys.argv[1]
def _norm(p): return (p or '').replace('\\','/').rstrip('/').lower()
want=_norm(sys.argv[2] if len(sys.argv)>2 else '')
db={db_expr}
sessions={sessions_expr}
looked=False
if os.path.exists(db):
    try:
        c=sqlite3.connect(db)
        try:
            row=c.execute('SELECT cwd,thread_source,agent_role FROM threads WHERE id=?',(sid,)).fetchone()
        except sqlite3.Error:
            row=c.execute('SELECT NULL,NULL,NULL FROM threads WHERE id=?',(sid,)).fetchone()
        if row:
            if (row[1] is not None and row[1]!='user') or row[2] is not None:
                print(0); sys.exit(0)
            if want and _norm(row[0]) and _norm(row[0])!=want:
                print(0); sys.exit(0)
            print(1); sys.exit(0)
        looked=True
    except sqlite3.Error:
        pass
if os.path.isdir(sessions):
    for root,_dirs,files in os.walk(sessions):
        for n in files:
            if sid in n and n.endswith('.jsonl'):
                try:
                    with open(os.path.join(root,n),encoding='utf-8',errors='replace') as fh:
                        first=fh.readline()
                except OSError:
                    first=''
                print(0 if '"thread_source":"subagent"' in first else 1); sys.exit(0)
    looked=True
print(0 if looked else '')
"#,
        db_expr = db_expr,
        sessions_expr = sessions_expr,
    )
}

/// Is a Codex/Gemini session still resumable? (macOS/Linux)
///
/// `checked: false` means "could not look", which the caller treats as "keep
/// the id" — the same fail-open contract as `claude_session_file_exists`.
/// Before this existed, `sessionStillExists` returned true unconditionally for
/// these two CLIs, so MADE would spawn `codex resume <id>` against a thread that
/// had been deleted and the pane came up on the CLI's error message.
#[tauri::command]
async fn cli_session_exists_native(
    terminal_type: String,
    session_id: String,
    project_path: Option<String>,
) -> Result<SessionFileCheck, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    Ok(cli_session_exists_local(&home, &terminal_type, &session_id, project_path.as_deref().unwrap_or(""), false))
}

/// Windows-native variant of cli_session_exists_native.
#[tauri::command]
async fn cli_session_exists_windows(
    terminal_type: String,
    session_id: String,
    project_path: Option<String>,
) -> Result<SessionFileCheck, String> {
    let home = std::env::var("USERPROFILE").map_err(|_| "USERPROFILE not set".to_string())?;
    Ok(cli_session_exists_local(&home, &terminal_type, &session_id, project_path.as_deref().unwrap_or(""), true))
}

/// WSL variant. Codex asks inside the guest (SQLite over SMB is not worth the
/// risk); Gemini reads the guest's files over the UNC share.
#[tauri::command]
async fn cli_session_exists(
    terminal_type: String,
    session_id: String,
    distro: Option<String>,
    project_path: Option<String>,
) -> Result<SessionFileCheck, String> {
    match terminal_type.as_str() {
        "codex" => {
            let script = format!(
                "python3 - '{}' '{}' <<'MADE_CODEX_PY'\n{}MADE_CODEX_PY\n",
                session_id.replace('\'', "'\\''"),
                project_path.unwrap_or_default().replace('\'', "'\\''"),
                codex_session_exists_py(
                    "os.path.expanduser('~/.codex/state_5.sqlite')",
                    "os.path.expanduser('~/.codex/sessions')",
                ),
            );
            let out = wsl_command_in(distro.as_deref())
                .args(["--", "bash", "-lic", &script])
                .output();
            let Ok(o) = out else {
                return Ok(SessionFileCheck { exists: false, checked: false });
            };
            let text = String::from_utf8_lossy(&o.stdout);
            match text.lines().map(|l| l.trim()).find(|l| *l == "0" || *l == "1") {
                Some("1") => Ok(SessionFileCheck { exists: true, checked: true }),
                Some("0") => Ok(SessionFileCheck { exists: false, checked: true }),
                // No verdict line at all: python missing, or the DB is absent.
                _ => Ok(SessionFileCheck { exists: false, checked: false }),
            }
        }
        "gemini" => {
            for home in wsl_home_dirs(distro.as_deref()) {
                let h = home.to_string_lossy().to_string();
                if !std::path::Path::new(&h).join(".gemini").join("tmp").is_dir() { continue; }
                let exists = find_gemini_chat_by_id(&h, &session_id).is_some();
                if exists { return Ok(SessionFileCheck { exists: true, checked: true }); }
                return Ok(SessionFileCheck { exists: false, checked: true });
            }
            Ok(SessionFileCheck { exists: false, checked: false })
        }
        _ => Ok(SessionFileCheck { exists: false, checked: false }),
    }
}

/// Shared body of the two local `cli_session_exists_*` commands.
fn cli_session_exists_local(
    home: &str,
    terminal_type: &str,
    session_id: &str,
    expected_cwd: &str,
    try_python_alias: bool,
) -> SessionFileCheck {
    match terminal_type {
        "codex" => {
            let codex_dir = std::path::Path::new(home).join(".codex");
            let db = codex_dir.join("state_5.sqlite");
            if db.exists() {
                let py = codex_session_exists_py(
                    &format!("r'{}'", db.display()),
                    &format!("r'{}'", codex_dir.join("sessions").display()),
                );
                let out = Command::new("python3").args(["-c", &py, session_id, expected_cwd]).output();
                let out = if try_python_alias {
                    out.or_else(|_| Command::new("python").args(["-c", &py, session_id, expected_cwd]).output())
                } else {
                    out
                };
                if let Ok(o) = out {
                    let text = String::from_utf8_lossy(&o.stdout);
                    match text.lines().map(|l| l.trim()).find(|l| *l == "0" || *l == "1") {
                        Some("1") => return SessionFileCheck { exists: true, checked: true },
                        // The python consulted BOTH the threads table and the
                        // rollout files before answering, so 0 is final here.
                        Some("0") => return SessionFileCheck { exists: false, checked: true },
                        _ => {}
                    }
                }
            }
            // No database, or python could not answer — fall back to the files.
            let sessions_dir = codex_dir.join("sessions");
            if !sessions_dir.is_dir() {
                return SessionFileCheck { exists: false, checked: false };
            }
            SessionFileCheck { exists: codex_rollout_exists(&codex_dir, session_id), checked: true }
        }
        "gemini" => {
            if !std::path::Path::new(home).join(".gemini").join("tmp").is_dir() {
                return SessionFileCheck { exists: false, checked: false };
            }
            SessionFileCheck {
                exists: find_gemini_chat_by_id(home, session_id).is_some(),
                checked: true,
            }
        }
        _ => SessionFileCheck { exists: false, checked: false },
    }
}

/// Is there a rollout file whose NAME carries this session id? Codex names them
/// `rollout-<timestamp>-<uuid>.jsonl`, so the id is in the filename.
fn codex_rollout_exists(codex_dir: &std::path::Path, session_id: &str) -> bool {
    let mut files: Vec<(std::path::PathBuf, std::time::SystemTime)> = Vec::new();
    walk_jsonl(&codex_dir.join("sessions"), &mut files);
    files
        .iter()
        .any(|(p, _)| p.file_name().map_or(false, |n| n.to_string_lossy().contains(session_id)))
}

/// Keep only a JSON array from the helper's stdout. Anything else — a python
/// traceback, a `bash -lic` login-shell banner — becomes an empty list, so a
/// broken environment shows no sessions rather than propagating a parse error
/// into the picker.
fn codex_index_stdout(out: std::io::Result<std::process::Output>) -> String {
    let Ok(o) = out else { return "[]".to_string() };
    let text = String::from_utf8_lossy(&o.stdout);
    text.lines()
        .map(|l| l.trim())
        .find(|l| l.starts_with('[') && l.ends_with(']'))
        .unwrap_or("[]")
        .to_string()
}

/// Does `<project-dir>/<session_id>.jsonl` exist? (WSL)
///
/// This is the ONLY thing `claude --resume <id>` actually requires. MADE used
/// to answer this question from `sessions-index.json`, which Claude stopped
/// writing in early 2026 — so the check silently passed every id, including
/// ids no session ever wrote, and the CLI answered "No conversation found with
/// session ID: …".
#[tauri::command]
async fn claude_session_file_exists(
    project_path: String,
    session_id: String,
    distro: Option<String>,
) -> Result<SessionFileCheck, String> {
    let dir = match resolve_wsl_project_dir(&project_path, distro.as_deref()) {
        Some(d) => d,
        None => return Ok(SessionFileCheck { exists: false, checked: false }),
    };
    let exists = dir.join(format!("{}.jsonl", session_id)).exists();
    Ok(SessionFileCheck { exists, checked: true })
}

/// Windows-native variant of claude_session_file_exists.
#[tauri::command]
async fn claude_session_file_exists_windows(
    project_path: String,
    session_id: String,
) -> Result<SessionFileCheck, String> {
    let home = match std::env::var("USERPROFILE") {
        Ok(h) => h,
        Err(_) => return Ok(SessionFileCheck { exists: false, checked: false }),
    };
    let dir = match find_claude_project_dir(&home, &project_path, '/') {
        Some(d) => d,
        None => return Ok(SessionFileCheck { exists: false, checked: false }),
    };
    let exists = dir.join(format!("{}.jsonl", session_id)).exists();
    Ok(SessionFileCheck { exists, checked: true })
}

/// macOS/Linux-native variant of claude_session_file_exists.
#[tauri::command]
async fn claude_session_file_exists_native(
    project_path: String,
    session_id: String,
) -> Result<SessionFileCheck, String> {
    let home = match std::env::var("HOME") {
        Ok(h) => h,
        Err(_) => return Ok(SessionFileCheck { exists: false, checked: false }),
    };
    let dir = match find_claude_project_dir(&home, &project_path, '/') {
        Some(d) => d,
        None => return Ok(SessionFileCheck { exists: false, checked: false }),
    };
    let exists = dir.join(format!("{}.jsonl", session_id)).exists();
    Ok(SessionFileCheck { exists, checked: true })
}

/// Merge a single key into Claude's `settings.json`, preserving everything
/// else. Creates the file (and its directory) when absent.
///
/// A read-modify-write on the USER's config file, so it is deliberately
/// conservative: unparseable JSON is left completely alone rather than
/// overwritten, because clobbering a hand-edited config to set one preference
/// would be a far worse outcome than the preference not applying.
fn merge_claude_setting(path: &std::path::Path, key: &str, value: serde_json::Value) -> Result<(), String> {
    let mut root: serde_json::Value = match std::fs::read_to_string(path) {
        Ok(raw) if !raw.trim().is_empty() => match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => return Err(format!("settings.json is not valid JSON, leaving it untouched: {e}")),
        },
        _ => serde_json::json!({}),
    };
    let Some(obj) = root.as_object_mut() else {
        return Err("settings.json is not a JSON object, leaving it untouched".to_string());
    };
    obj.insert(key.to_string(), value);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(path, pretty).map_err(|e| format!("write {}: {e}", path.display()))
}

/// Locate `~/.claude/settings.json` inside WSL over the \\wsl.localhost UNC
/// path. Mirrors `resolve_wsl_session_jsonl`: the distro and the linux user are
/// both unknown, so candidates are enumerated.
fn resolve_wsl_claude_settings(distro: Option<&str>) -> Option<std::path::PathBuf> {
    let distro_name = distro.unwrap_or("").trim().to_string();
    let mut found: Option<std::path::PathBuf> = None;
    let mut try_distro = |d: &str, found: &mut Option<std::path::PathBuf>| {
        if d.is_empty() || found.is_some() { return; }
        for prefix in ["\\\\wsl.localhost", "\\\\wsl$"] {
            let base = std::path::PathBuf::from(format!("{}\\{}\\home", prefix, d));
            if let Ok(users) = std::fs::read_dir(&base) {
                for u in users.filter_map(|e| e.ok()) {
                    let dir = u.path().join(".claude");
                    if dir.is_dir() {
                        *found = Some(dir.join("settings.json"));
                        return;
                    }
                }
            }
        }
    };
    try_distro(&distro_name, &mut found);
    if found.is_none() {
        for d in ["Ubuntu-24.04", "Ubuntu-22.04", "Ubuntu", "Debian"] {
            try_distro(d, &mut found);
            if found.is_some() { break; }
        }
    }
    if found.is_none() {
        if let Ok(home) = std::env::var("HOME") {
            let dir = std::path::PathBuf::from(&home).join(".claude");
            if dir.is_dir() { found = Some(dir.join("settings.json")); }
        }
    }
    found
}

/* ------------------------------------------------------------------ */
/*  Jira (Atlassian) MCP server                                        */
/* ------------------------------------------------------------------ */

/// The Atlassian Rovo MCP endpoint, Streamable HTTP.
///
/// NOT the older `https://mcp.atlassian.com/v1/sse`: Atlassian stopped
/// supporting that SSE endpoint on 30 June 2026, so anything written against it
/// now fails to connect. Most setup guides still found online show the dead one.
const ATLASSIAN_MCP_URL: &str = "https://mcp.atlassian.com/v1/mcp/authv2";
const ATLASSIAN_MCP_NAME: &str = "atlassian";

#[derive(Serialize)]
pub struct JiraMcpStatus {
    /// An Atlassian MCP server is configured somewhere Claude will read.
    configured: bool,
    /// Where it was found: "user", "local" (this project) or "project" (.mcp.json).
    scope: String,
    /// The configured server name, so the UI can say which one it found.
    name: String,
    /// False when we could not look at all (no reachable config file) — the UI
    /// must not claim "not set up" on the strength of a failed lookup.
    checked: bool,
}

/// Locate Claude Code's `~/.claude.json` for a given home directory.
fn claude_json_at(home: &std::path::Path) -> std::path::PathBuf {
    home.join(".claude.json")
}

/// Which CLI's MCP configuration a Jira request concerns. All three speak MCP
/// and all three can reach the same Atlassian endpoint — they just keep their
/// config in different places, in different formats.
#[derive(Clone, Copy, PartialEq, Eq)]
enum JiraCli {
    Claude,
    Codex,
    Gemini,
}

impl JiraCli {
    /// Unknown/absent means Claude: that is what every caller meant before the
    /// parameter existed, so an old caller keeps its old behaviour.
    fn parse(raw: Option<&str>) -> Self {
        match raw.unwrap_or("claude").trim().to_ascii_lowercase().as_str() {
            "codex" => JiraCli::Codex,
            "gemini" => JiraCli::Gemini,
            _ => JiraCli::Claude,
        }
    }

    fn binary(self) -> &'static str {
        match self {
            JiraCli::Claude => "claude",
            JiraCli::Codex => "codex",
            JiraCli::Gemini => "gemini",
        }
    }
}

/// Does this server entry point at Atlassian? Matches on the name OR the URL, so
/// a server the user called something else is still recognised.
fn is_atlassian_entry(name: &str, value: &serde_json::Value) -> bool {
    if name.to_ascii_lowercase().contains("atlassian")
        || name.to_ascii_lowercase().contains("jira")
    {
        return true;
    }
    let blob = value.to_string().to_ascii_lowercase();
    blob.contains("atlassian.com")
}

/// Scan a parsed `~/.claude.json` for an Atlassian MCP server, checking the
/// user scope first and then this project's local scope.
fn find_atlassian_in_claude_json(
    doc: &serde_json::Value,
    project_path: Option<&str>,
) -> Option<(String, String)> {
    if let Some(servers) = doc.get("mcpServers").and_then(|v| v.as_object()) {
        for (name, value) in servers {
            if is_atlassian_entry(name, value) {
                return Some((name.clone(), "user".to_string()));
            }
        }
    }
    let projects = doc.get("projects").and_then(|v| v.as_object())?;
    // Claude keys projects by absolute path; compare loosely so a Windows path
    // and its WSL twin, or a trailing slash, still match.
    let wanted = project_path?.replace('\\', "/").trim_end_matches('/').to_ascii_lowercase();
    for (key, entry) in projects {
        let k = key.replace('\\', "/").trim_end_matches('/').to_ascii_lowercase();
        if k != wanted {
            continue;
        }
        if let Some(servers) = entry.get("mcpServers").and_then(|v| v.as_object()) {
            for (name, value) in servers {
                if is_atlassian_entry(name, value) {
                    return Some((name.clone(), "local".to_string()));
                }
            }
        }
    }
    None
}

/// An Atlassian entry in a doc's TOP-LEVEL `mcpServers` (the `.mcp.json`
/// shape). Split out so the local and SSH paths share one notion of a match —
/// two implementations of "is this Atlassian" would eventually disagree.
fn find_atlassian_in_mcp_servers(doc: &serde_json::Value) -> Option<String> {
    let servers = doc.get("mcpServers").and_then(|v| v.as_object())?;
    servers
        .iter()
        .find(|(name, value)| is_atlassian_entry(name, value))
        .map(|(name, _)| name.clone())
}

/// `.mcp.json` committed in the project itself (scope "project").
fn find_atlassian_in_project_file(project_path: Option<&str>) -> Option<String> {
    let dir = project_path?;
    let raw = std::fs::read_to_string(std::path::Path::new(dir).join(".mcp.json")).ok()?;
    find_atlassian_in_mcp_servers(&serde_json::from_str(&raw).ok()?)
}

/// Server name of a `[mcp_servers.<name>]` TOML header, or None for any other
/// section. Sub-tables (`[mcp_servers.<name>.env]`) report the same server, and
/// a quoted name (`[mcp_servers."my server"]`) is unquoted.
fn codex_mcp_section_name(header: &str) -> Option<String> {
    let inner = header.trim().strip_prefix('[')?.strip_suffix(']')?.trim();
    let rest = inner.strip_prefix("mcp_servers.")?;
    let seg = match rest.strip_prefix('"') {
        Some(quoted) => quoted.split('"').next()?.to_string(),
        None => rest.split('.').next()?.trim().to_string(),
    };
    if seg.is_empty() { None } else { Some(seg) }
}

/// Scan Codex's `~/.codex/config.toml` for an Atlassian MCP server.
///
/// Deliberately a line scanner rather than a TOML parse: pulling in a TOML
/// dependency to answer one yes/no question is not worth it, and the question
/// is loose anyway — `is_atlassian_entry` matches on the server name OR any
/// atlassian.com URL in its body, which survives whatever else the table holds.
fn find_atlassian_in_codex_toml(raw: &str) -> Option<String> {
    let mut current: Option<String> = None;
    let mut body = String::new();
    let matches = |name: &Option<String>, body: &str| -> Option<String> {
        let name = name.as_ref()?;
        is_atlassian_entry(name, &serde_json::Value::String(body.to_string()))
            .then(|| name.clone())
    };
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            if let Some(found) = matches(&current, &body) {
                return Some(found);
            }
            body.clear();
            current = codex_mcp_section_name(trimmed);
        } else if current.is_some() {
            body.push_str(trimmed);
            body.push('\n');
        }
    }
    matches(&current, &body)
}

/// Find an Atlassian entry under ANY `mcpServers` object in a Gemini settings
/// document. Gemini has reshuffled its settings schema more than once (0.49
/// nests `security`/`general`/`model`); `mcpServers` is top-level today, and
/// walking the tree means a future move reports the truth instead of silently
/// claiming "not set up".
fn find_atlassian_in_gemini_settings(doc: &serde_json::Value) -> Option<String> {
    let map = doc.as_object()?;
    if let Some(servers) = map.get("mcpServers").and_then(|v| v.as_object()) {
        for (name, value) in servers {
            if is_atlassian_entry(name, value) {
                return Some(name.clone());
            }
        }
    }
    map.values().find_map(find_atlassian_in_gemini_settings)
}

fn jira_mcp_status_for_home(
    cli: JiraCli,
    home: Option<std::path::PathBuf>,
    project_path: Option<String>,
) -> JiraMcpStatus {
    let not_checked = JiraMcpStatus {
        configured: false,
        scope: String::new(),
        name: String::new(),
        checked: false,
    };
    let found = |name: String, scope: &str| JiraMcpStatus {
        configured: true,
        scope: scope.to_string(),
        name,
        checked: true,
    };
    let absent = JiraMcpStatus {
        configured: false,
        scope: String::new(),
        name: String::new(),
        checked: true,
    };

    match cli {
        JiraCli::Claude => {
            // A `.mcp.json` in the project counts regardless of where home is.
            if let Some(name) = find_atlassian_in_project_file(project_path.as_deref()) {
                return found(name, "project");
            }
            let Some(home) = home else { return not_checked };
            let Ok(raw) = std::fs::read_to_string(claude_json_at(&home)) else { return not_checked };
            let Ok(doc) = serde_json::from_str::<serde_json::Value>(&raw) else { return not_checked };
            match find_atlassian_in_claude_json(&doc, project_path.as_deref()) {
                Some((name, scope)) => found(name, &scope),
                None => absent,
            }
        }
        JiraCli::Codex => {
            // Codex keeps one global config — no project or local scope exists.
            let Some(home) = home else { return not_checked };
            let path = home.join(".codex").join("config.toml");
            let Ok(raw) = std::fs::read_to_string(&path) else {
                // No config file at all is a real answer for Codex: it writes
                // one on first `mcp add`, so "missing" means "none configured".
                return if home.join(".codex").is_dir() { absent } else { not_checked };
            };
            match find_atlassian_in_codex_toml(&raw) {
                Some(name) => found(name, "user"),
                None => absent,
            }
        }
        JiraCli::Gemini => {
            // Project scope first — `gemini mcp add -s project` writes here and
            // it wins for panes opened in that folder.
            if let Some(dir) = project_path.as_deref() {
                let path = std::path::Path::new(dir).join(".gemini").join("settings.json");
                if let Ok(raw) = std::fs::read_to_string(&path) {
                    if let Some(name) = serde_json::from_str::<serde_json::Value>(&raw)
                        .ok()
                        .as_ref()
                        .and_then(find_atlassian_in_gemini_settings)
                    {
                        return found(name, "project");
                    }
                }
            }
            let Some(home) = home else { return not_checked };
            let path = home.join(".gemini").join("settings.json");
            let Ok(raw) = std::fs::read_to_string(&path) else {
                return if home.join(".gemini").is_dir() { absent } else { not_checked };
            };
            let Ok(doc) = serde_json::from_str::<serde_json::Value>(&raw) else { return not_checked };
            match find_atlassian_in_gemini_settings(&doc) {
                Some(name) => found(name, "user"),
                None => absent,
            }
        }
    }
}

/// WSL home directory for a given CLI, reached over the `\\wsl.localhost` share.
///
/// The marker directory is the CLI's OWN config dir, tried first: keying every
/// lookup off `.claude/` (as this did while Claude was the only CLI) reports
/// "unknown" forever for someone who runs Codex in WSL and Claude nowhere. The
/// other CLIs' markers are the fallback, so a distro with exactly one user
/// still resolves whichever CLI is asked about.
fn resolve_wsl_home_for(cli: JiraCli, distro: Option<&str>) -> Option<std::path::PathBuf> {
    let own = match cli {
        JiraCli::Claude => ".claude",
        JiraCli::Codex => ".codex",
        JiraCli::Gemini => ".gemini",
    };
    let markers: [&str; 3] = match cli {
        JiraCli::Claude => [own, ".codex", ".gemini"],
        JiraCli::Codex => [own, ".claude", ".gemini"],
        JiraCli::Gemini => [own, ".claude", ".codex"],
    };

    let mut distros: Vec<&str> = Vec::new();
    if let Some(d) = distro.map(str::trim).filter(|d| !d.is_empty()) {
        distros.push(d);
    }
    distros.extend(["Ubuntu-24.04", "Ubuntu-22.04", "Ubuntu", "Debian"]);

    for d in distros {
        for prefix in ["\\\\wsl.localhost", "\\\\wsl$"] {
            let base = std::path::PathBuf::from(format!("{}\\{}\\home", prefix, d));
            let Ok(entries) = std::fs::read_dir(&base) else { continue };
            let users: Vec<std::path::PathBuf> =
                entries.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_dir()).collect();
            if users.is_empty() {
                continue;
            }
            for marker in markers {
                if let Some(hit) = users.iter().find(|u| u.join(marker).is_dir()) {
                    return Some(hit.clone());
                }
            }
            // A reachable distro whose single user has none of the three: still
            // the right home, and the caller reports "not set up" from there.
            if users.len() == 1 {
                return Some(users[0].clone());
            }
        }
    }

    // Non-Windows dev builds have no WSL share; the real home is the answer.
    let home = std::env::var("HOME").ok().map(std::path::PathBuf::from)?;
    home.join(own).is_dir().then_some(home)
}

/* --- SSH: the same question, asked of a remote host ------------------- */

/// Sentinels framing the probe's sections. Chosen to be impossible in a config
/// file, and matched on whole lines so a value containing one cannot spoof a
/// section boundary.
const SSH_PROBE_EXISTS: &str = "@@MADE-JIRA-EXISTS@@";
const SSH_PROBE_USER: &str = "@@MADE-JIRA-USER@@";
const SSH_PROBE_PROJECT: &str = "@@MADE-JIRA-PROJECT@@";

/// Where a CLI keeps its config on a POSIX host: (user file, the path whose
/// existence proves the CLI has ever run here).
fn jira_cli_remote_paths(cli: JiraCli) -> (&'static str, &'static str) {
    match cli {
        JiraCli::Claude => ("$HOME/.claude.json", "$HOME/.claude.json"),
        JiraCli::Codex => ("$HOME/.codex/config.toml", "$HOME/.codex"),
        JiraCli::Gemini => ("$HOME/.gemini/settings.json", "$HOME/.gemini"),
    }
}

/// One round trip that returns everything the local parsers need. Always exits
/// 0: a missing file is an answer, not a failure, and `ssh_exec_internal`
/// treats a non-zero exit as a transport error.
fn jira_mcp_probe_script(cli: JiraCli, project_path: Option<&str>) -> String {
    let (user_file, marker) = jira_cli_remote_paths(cli);
    // Codex has no project scope at all; the others each have their own file.
    let project_file = project_path
        .map(|p| p.trim_end_matches('/'))
        .filter(|p| !p.is_empty())
        .and_then(|p| match cli {
            JiraCli::Claude => Some(format!("{p}/.mcp.json")),
            JiraCli::Gemini => Some(format!("{p}/.gemini/settings.json")),
            JiraCli::Codex => None,
        });
    let mut script = format!(
        "echo {SSH_PROBE_EXISTS}; [ -e \"{marker}\" ] && echo 1 || echo 0; \
         echo {SSH_PROBE_USER}; cat \"{user_file}\" 2>/dev/null; echo; \
         echo {SSH_PROBE_PROJECT}; "
    );
    if let Some(p) = project_file {
        // The only caller-supplied value in the whole script.
        script.push_str(&format!("cat {} 2>/dev/null; ", shell_escape(&p)));
    }
    script.push_str("exit 0");
    script
}

/// Split probe output into (marker exists, user blob, project blob).
fn split_jira_probe(out: &str) -> (bool, String, String) {
    let mut section = 0;
    let (mut exists, mut user, mut project) = (false, String::new(), String::new());
    for line in out.lines() {
        match line.trim_end() {
            SSH_PROBE_EXISTS => section = 1,
            SSH_PROBE_USER => section = 2,
            SSH_PROBE_PROJECT => section = 3,
            _ => match section {
                1 => exists = line.trim() == "1",
                2 => {
                    user.push_str(line);
                    user.push('\n');
                }
                3 => {
                    project.push_str(line);
                    project.push('\n');
                }
                _ => {}
            },
        }
    }
    (exists, user, project)
}

/// Is the Atlassian MCP server configured? — a remote host over SSH.
///
/// A Jira project can live on a server (`tab.serverId`), and then the ticket
/// pane runs the CLI THERE, so the only config that matters is the remote one.
/// Reporting the local machine's answer for a remote project would be a
/// confidently wrong "Connected".
///
/// The remote blobs are parsed by the SAME functions as the local paths — only
/// the transport differs.
#[tauri::command]
async fn jira_mcp_status_ssh(
    host: String,
    username: String,
    identity_file: Option<String>,
    project_path: Option<String>,
    cli: Option<String>,
) -> Result<JiraMcpStatus, String> {
    let kind = JiraCli::parse(cli.as_deref());
    let not_checked = JiraMcpStatus {
        configured: false,
        scope: String::new(),
        name: String::new(),
        checked: false,
    };
    let script = jira_mcp_probe_script(kind, project_path.as_deref());
    // Unreachable host, refused key, password-only auth → "unknown", never
    // "not set up". Same contract as every other path.
    let Ok(out) = ssh_exec_internal(&host, &username, identity_file.as_deref(), &script).await
    else {
        return Ok(not_checked);
    };
    let (exists, user_blob, project_blob) = split_jira_probe(&out);

    // Project scope first — it wins for panes opened in that folder.
    if !project_blob.trim().is_empty() {
        if let Ok(doc) = serde_json::from_str::<serde_json::Value>(&project_blob) {
            let hit = match kind {
                JiraCli::Gemini => find_atlassian_in_gemini_settings(&doc),
                _ => find_atlassian_in_mcp_servers(&doc),
            };
            if let Some(name) = hit {
                return Ok(JiraMcpStatus {
                    configured: true,
                    scope: "project".into(),
                    name,
                    checked: true,
                });
            }
        }
    }

    if user_blob.trim().is_empty() {
        // No config to read: only claim "not set up" when the CLI has clearly
        // run here (its dir/file exists) — otherwise it may not be installed.
        return Ok(if exists {
            JiraMcpStatus { configured: false, scope: String::new(), name: String::new(), checked: true }
        } else {
            not_checked
        });
    }

    let found = match kind {
        JiraCli::Claude => serde_json::from_str::<serde_json::Value>(&user_blob)
            .ok()
            .and_then(|doc| find_atlassian_in_claude_json(&doc, project_path.as_deref())),
        JiraCli::Codex => find_atlassian_in_codex_toml(&user_blob).map(|n| (n, "user".to_string())),
        JiraCli::Gemini => serde_json::from_str::<serde_json::Value>(&user_blob)
            .ok()
            .and_then(|doc| find_atlassian_in_gemini_settings(&doc))
            .map(|n| (n, "user".to_string())),
    };
    Ok(match found {
        Some((name, scope)) => JiraMcpStatus { configured: true, scope, name, checked: true },
        None => JiraMcpStatus {
            configured: false,
            scope: String::new(),
            name: String::new(),
            checked: true,
        },
    })
}

/// Only a shell NAME or absolute path, never an argument list — this value
/// reaches a remote command line. Anything else falls back to bash.
fn safe_remote_shell(shell: Option<&str>) -> String {
    let ok = shell
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .filter(|s| s.chars().all(|c| c.is_ascii_alphanumeric() || "/_-.".contains(c)));
    ok.unwrap_or("bash").to_string()
}

/// Register the Atlassian MCP server on a remote host.
///
/// Bounded from THIS side rather than with a remote `timeout`: macOS ships no
/// such binary (it is `gtimeout` from coreutils), and a Mac is exactly the kind
/// of box these servers are. Killing the local ssh client closes the channel,
/// and sshd hangs up the remote command with it.
///
/// The CLI is invoked through the shell that was probed to resolve it
/// (`pickExecShell`): `ssh host "claude …"` runs a NON-interactive login shell,
/// where PATH additions from .zshrc are absent and the bare name often fails.
#[tauri::command]
async fn jira_mcp_install_ssh(
    host: String,
    username: String,
    identity_file: Option<String>,
    cli: Option<String>,
    shell: Option<String>,
) -> Result<String, String> {
    let kind = JiraCli::parse(cli.as_deref());
    let Some(key) = identity_file.filter(|k| !k.trim().is_empty()) else {
        return Err("SSH-key auth required to configure a remote host.".to_string());
    };
    let key = expand_home(&key)?;
    let remote = format!(
        "{} -lic {} 2>&1",
        safe_remote_shell(shell.as_deref()),
        shell_escape(&jira_mcp_add_call(kind)),
    );
    let child = ssh_background_command()
        .args([
            "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=no",
            "-o", "ConnectTimeout=10",
            "-i", &key,
            &format!("{username}@{host}"),
            &remote,
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn ssh: {e}"))?;

    let deadline = std::time::Duration::from_secs(mcp_add_deadline_secs(kind));
    let Some(out) = wait_for_mcp_add(child, deadline)? else {
        return if kind == JiraCli::Codex {
            // Codex starts its OAuth flow here too, and over SSH it cannot
            // finish at all — see CODEX_MCP_SSH_AUTH.
            Ok(CODEX_MCP_ADD_PENDING_AUTH.to_string())
        } else {
            Err(mcp_add_timeout_error(kind))
        };
    };
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if out.status.success() {
        Ok(if text.is_empty() { err } else { text })
    } else {
        Err(if text.is_empty() && err.is_empty() {
            format!("{} mcp add failed on {host}", kind.binary())
        } else if err.is_empty() {
            text
        } else {
            err
        })
    }
}

/// Is the Atlassian MCP server configured? — WSL.
#[tauri::command]
async fn jira_mcp_status(
    project_path: Option<String>,
    distro: Option<String>,
    cli: Option<String>,
) -> Result<JiraMcpStatus, String> {
    let cli = JiraCli::parse(cli.as_deref());
    Ok(jira_mcp_status_for_home(cli, resolve_wsl_home_for(cli, distro.as_deref()), project_path))
}

/// Is the Atlassian MCP server configured? — Windows native.
#[tauri::command]
async fn jira_mcp_status_windows(
    project_path: Option<String>,
    cli: Option<String>,
) -> Result<JiraMcpStatus, String> {
    let home = std::env::var("USERPROFILE").ok().map(std::path::PathBuf::from);
    Ok(jira_mcp_status_for_home(JiraCli::parse(cli.as_deref()), home, project_path))
}

/// Is the Atlassian MCP server configured? — macOS/Linux native.
#[tauri::command]
async fn jira_mcp_status_native(
    project_path: Option<String>,
    cli: Option<String>,
) -> Result<JiraMcpStatus, String> {
    let home = std::env::var("HOME").ok().map(std::path::PathBuf::from);
    Ok(jira_mcp_status_for_home(JiraCli::parse(cli.as_deref()), home, project_path))
}

/// The `mcp add` invocation that registers Atlassian with a given CLI.
///
/// Every CLI writes its own config rather than MADE editing the file: the shape
/// is theirs to own, and each ships the documented, version-correct writer.
/// Scope is `user`/global everywhere it exists, because a support ticket can
/// concern any repo — note Gemini defaults to PROJECT scope, so `-s user` is
/// load-bearing, and Codex has no scope flag at all (one global config.toml).
///
/// Returns argv, joined for the WSL shell path and split for the direct path.
fn jira_mcp_add_args(cli: JiraCli) -> Vec<String> {
    let owned = |parts: &[&str]| parts.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    match cli {
        JiraCli::Claude => owned(&[
            "mcp", "add", "--transport", "http",
            ATLASSIAN_MCP_NAME, ATLASSIAN_MCP_URL, "--scope", "user",
        ]),
        JiraCli::Codex => owned(&["mcp", "add", ATLASSIAN_MCP_NAME, "--url", ATLASSIAN_MCP_URL]),
        JiraCli::Gemini => owned(&[
            "mcp", "add", "--transport", "http", "--scope", "user",
            ATLASSIAN_MCP_NAME, ATLASSIAN_MCP_URL,
        ]),
    }
}

/// How long an `mcp add` may run before it is killed.
///
/// EVERY CLI gets a deadline, not just the one that misbehaves. The button
/// behind this has exactly one failure mode a user cannot recover from — a
/// spinner that never stops — and any of these calls can block for reasons that
/// have nothing to do with the CLI: a wedged WSL VM, a `bash -lic` login script
/// that waits on input, a network stall. A wrong answer in 45 seconds can be
/// read and acted on; "Setting up…" forever cannot.
///
/// Codex's is short and expected (see `jira_mcp_add_command`); the other two
/// are generous — Gemini's add measures ~2s — so hitting them means something
/// is genuinely stuck, and that is reported as the error it is.
const fn mcp_add_deadline_secs(cli: JiraCli) -> u64 {
    match cli {
        JiraCli::Codex => 8,
        _ => 45,
    }
}

/// What a killed Codex add reports. NOT an error: the entry is already written.
const CODEX_MCP_ADD_PENDING_AUTH: &str =
    "Added. Run `codex mcp login atlassian` in a Codex pane to sign in.";

/// What a killed Claude/Gemini add reports. Their adds do not block on purpose,
/// so this IS an error — and it names the usual culprit rather than the CLI,
/// because a stuck `wsl.exe` is far likelier than a stuck `mcp add`.
fn mcp_add_timeout_error(cli: JiraCli) -> String {
    format!(
        "{} mcp add did not finish in {}s — is WSL responding? Nothing was changed.",
        cli.binary(),
        mcp_add_deadline_secs(cli),
    )
}

/// Same call as a shell command line, for the WSL `bash -lic` path.
///
/// Codex needs a deadline. Alone among the three, it ties OAuth INTO `mcp add`:
/// it writes the config entry, prints "Added global MCP server 'atlassian'",
/// and then starts a browser OAuth flow that blocks on a localhost callback
/// which can never arrive from a headless spawn — so `.output()` waits forever
/// and the Settings button spins for the rest of the session. There is no flag
/// to skip it (`codex mcp add --help` offers only --oauth-client-id and
/// --oauth-resource). Claude and Gemini both write and exit.
///
/// Killing it loses nothing, because the write happens BEFORE the flow starts,
/// and signing in stays what it always was: a deliberate, visible step in a
/// pane where a browser can actually open.
///
/// The bound is applied INSIDE the distro rather than by killing the wsl.exe
/// relay from the Windows side, which would not reliably reap the `codex`
/// process it started.
fn jira_mcp_add_call(cli: JiraCli) -> String {
    // Every argument here is a compile-time constant (binary name, flags, the
    // Atlassian URL) — nothing user-supplied reaches this string.
    format!("{} {}", cli.binary(), jira_mcp_add_args(cli).join(" "))
}

fn jira_mcp_add_command(cli: JiraCli) -> String {
    format!("timeout {} {}", mcp_add_deadline_secs(cli), jira_mcp_add_call(cli))
}

/// Poll `try_wait` until exit or deadline, killing at the deadline. `Ok(None)`
/// means the deadline fired. Mirrors `wsl_health::wait_with_deadline`; kept
/// separate because there a timeout is a failure, and here it is the expected
/// outcome of a command that deliberately never returns.
///
/// Output is a few hundred bytes (a "server added" line and an OAuth URL), far
/// below the pipe buffer, so polling without draining stdout cannot deadlock.
fn wait_for_mcp_add(
    mut child: Child,
    deadline: std::time::Duration,
) -> Result<Option<std::process::Output>, String> {
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child.wait_with_output().map(Some).map_err(|e| e.to_string());
            }
            Ok(None) => {
                if start.elapsed() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Ok(None);
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// Register the Atlassian MCP server with a CLI — WSL.
///
/// This does NOT authenticate. The OAuth handoff is interactive (it opens a
/// browser), so it stays where the user can see it: `/mcp` in a Claude or
/// Gemini pane, `codex mcp login atlassian` for Codex.
#[cfg(target_os = "windows")]
#[tauri::command]
async fn jira_mcp_install(distro: Option<String>, cli: Option<String>) -> Result<String, String> {
    let kind = JiraCli::parse(cli.as_deref());
    let script = format!("{} 2>&1", jira_mcp_add_command(kind));
    let mut cmd = wsl_command();
    if let Some(d) = distro.as_deref().filter(|d| !d.trim().is_empty()) {
        cmd.arg("-d").arg(d);
    }
    let out = cmd
        .arg("--")
        .arg("bash")
        .arg("-lic")
        .arg(&script)
        .output()
        .map_err(|e| format!("could not run wsl.exe: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() {
        Ok(text)
    } else if out.status.code() == Some(124) {
        // 124 is `timeout`'s "I killed it". For Codex that is the OAuth wait,
        // which only starts AFTER the entry is written (see
        // jira_mcp_add_command) — success. For the others it means stuck.
        if kind == JiraCli::Codex {
            Ok(CODEX_MCP_ADD_PENDING_AUTH.to_string())
        } else {
            Err(mcp_add_timeout_error(kind))
        }
    } else {
        // The CLI's own words when it has any — "command not found" and
        // "unknown flag" are both far more useful than anything invented here.
        Err(if text.is_empty() { format!("{} mcp add failed", kind.binary()) } else { text })
    }
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
async fn jira_mcp_install(_distro: Option<String>, _cli: Option<String>) -> Result<String, String> {
    Err("WSL is only available on Windows".to_string())
}

/// Register the Atlassian MCP server — Windows native / macOS / Linux, where
/// the CLI binary runs directly rather than through WSL.
#[tauri::command]
async fn jira_mcp_install_direct(
    cli_path: Option<String>,
    cli: Option<String>,
) -> Result<String, String> {
    let kind = JiraCli::parse(cli.as_deref());
    let program = cli_path
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| kind.binary().to_string());
    // Deadline for ALL three, not just the one that blocks on purpose: there is
    // no `timeout` binary to lean on here (this path also runs on Windows), so
    // the bound is applied to the child directly. See mcp_add_deadline_secs.
    let child = Command::new(&program)
        .args(jira_mcp_add_args(kind))
        // Null stdin, so a CLI that decides to prompt gets EOF and exits rather
        // than waiting forever on a terminal that does not exist here.
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run {program}: {e}"))?;
    let deadline = std::time::Duration::from_secs(mcp_add_deadline_secs(kind));
    let Some(out) = wait_for_mcp_add(child, deadline)? else {
        return if kind == JiraCli::Codex {
            Ok(CODEX_MCP_ADD_PENDING_AUTH.to_string())
        } else {
            Err(mcp_add_timeout_error(kind))
        };
    };
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if out.status.success() {
        Ok(if text.is_empty() { err } else { text })
    } else {
        Err(if err.is_empty() { format!("{program} mcp add failed") } else { err })
    }
}

/// Set Claude's notification channel (`notifChannel`) — WSL.
/// Values: auto | iterm2 | bell | kitty | ghostty | iterm2+bell | none.
#[tauri::command]
async fn set_claude_notif_channel(channel: String, distro: Option<String>) -> Result<String, String> {
    let Some(path) = resolve_wsl_claude_settings(distro.as_deref()) else {
        return Err("could not locate ~/.claude/settings.json in WSL".to_string());
    };
    merge_claude_setting(&path, "notifChannel", serde_json::Value::String(channel))?;
    Ok(path.display().to_string())
}

/// Set Claude's notification channel — Windows native.
#[tauri::command]
async fn set_claude_notif_channel_windows(channel: String) -> Result<String, String> {
    let home = std::env::var("USERPROFILE").map_err(|_| "USERPROFILE not set".to_string())?;
    let path = std::path::PathBuf::from(home).join(".claude").join("settings.json");
    merge_claude_setting(&path, "notifChannel", serde_json::Value::String(channel))?;
    Ok(path.display().to_string())
}

/// Set Claude's notification channel — macOS/Linux native.
#[tauri::command]
async fn set_claude_notif_channel_native(channel: String) -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let path = std::path::PathBuf::from(home).join(".claude").join("settings.json");
    merge_claude_setting(&path, "notifChannel", serde_json::Value::String(channel))?;
    Ok(path.display().to_string())
}

/// All user prompts for a session (Windows native).
#[tauri::command]
async fn read_session_prompts_windows(project_path: String, session_id: String) -> Result<Vec<String>, String> {
    let home = std::env::var("USERPROFILE").map_err(|_| "USERPROFILE not set".to_string())?;
    let Some(dir) = find_claude_project_dir(&home, &project_path, '/') else {
        return Ok(Vec::new());
    };
    Ok(read_user_prompts_from_jsonl(&dir.join(format!("{}.jsonl", session_id))))
}

/// All user prompts for a session (macOS/Linux native).
#[tauri::command]
async fn read_session_prompts_native(project_path: String, session_id: String) -> Result<Vec<String>, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let Some(dir) = find_claude_project_dir(&home, &project_path, '/') else {
        return Ok(Vec::new());
    };
    Ok(read_user_prompts_from_jsonl(&dir.join(format!("{}.jsonl", session_id))))
}

/// All user prompts for a session (WSL).
#[tauri::command]
async fn read_session_prompts(project_path: String, session_id: String, distro: Option<String>) -> Result<Vec<String>, String> {
    match resolve_wsl_session_jsonl(&project_path, &session_id, distro.as_deref()) {
        Some(path) => Ok(read_user_prompts_from_jsonl(&path)),
        None => Ok(Vec::new()),
    }
}

/// Last assistant reply text for a session (Windows native). Fail-soft: empty
/// string when the transcript is missing — the pane notification falls back to
/// the OSC status text.
#[tauri::command]
async fn read_session_last_assistant_text_windows(project_path: String, session_id: String) -> Result<String, String> {
    let home = std::env::var("USERPROFILE").map_err(|_| "USERPROFILE not set".to_string())?;
    let Some(dir) = find_claude_project_dir(&home, &project_path, '/') else {
        return Ok(String::new());
    };
    Ok(read_last_assistant_text_from_jsonl(&dir.join(format!("{}.jsonl", session_id))).unwrap_or_default())
}

/// Last assistant reply text for a session (macOS/Linux native).
#[tauri::command]
async fn read_session_last_assistant_text_native(project_path: String, session_id: String) -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let Some(dir) = find_claude_project_dir(&home, &project_path, '/') else {
        return Ok(String::new());
    };
    Ok(read_last_assistant_text_from_jsonl(&dir.join(format!("{}.jsonl", session_id))).unwrap_or_default())
}

/// Last assistant reply text for a session (WSL).
#[tauri::command]
async fn read_session_last_assistant_text(project_path: String, session_id: String, distro: Option<String>) -> Result<String, String> {
    match resolve_wsl_session_jsonl(&project_path, &session_id, distro.as_deref()) {
        Some(path) => Ok(read_last_assistant_text_from_jsonl(&path).unwrap_or_default()),
        None => Ok(String::new()),
    }
}

/// Read first user prompt from a Claude session JSONL (Windows native).
#[tauri::command]
async fn read_session_first_prompt_windows(project_path: String, session_id: String) -> Result<String, String> {
    let home = std::env::var("USERPROFILE").map_err(|_| "USERPROFILE not set".to_string())?;
    let dir = match find_claude_project_dir(&home, &project_path, '/') {
        Some(d) => d,
        None => return Ok(String::new()),
    };
    let path = dir.join(format!("{}.jsonl", session_id));
    Ok(read_first_user_prompt_from_jsonl(&path).unwrap_or_default())
}

/// Read first user prompt from a Claude session JSONL (macOS/Linux native).
#[tauri::command]
async fn read_session_first_prompt_native(project_path: String, session_id: String) -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let dir = match find_claude_project_dir(&home, &project_path, '/') {
        Some(d) => d,
        None => return Ok(String::new()),
    };
    let path = dir.join(format!("{}.jsonl", session_id));
    Ok(read_first_user_prompt_from_jsonl(&path).unwrap_or_default())
}

/// Read first user prompt from a Claude session JSONL (WSL).
/// Implemented natively in Rust — accesses WSL's filesystem via \\wsl.localhost UNC.
/// No bash, no python, no wsl.exe round-trip.
#[tauri::command]
async fn read_session_first_prompt(project_path: String, session_id: String, distro: Option<String>) -> Result<String, String> {
    // Shares resolve_wsl_session_jsonl with the all-prompts command so the two
    // cannot drift — and so both inherit the case-insensitive fallback below.
    match resolve_wsl_session_jsonl(&project_path, &session_id, distro.as_deref()) {
        Some(path) => Ok(read_first_user_prompt_from_jsonl(&path).unwrap_or_default()),
        None => Ok(String::new()),
    }
}

// ─── SSH session lookups ──────────────────────────────────────────────────
// These mirror the local read_session_*/get_*_session_id_* commands but read
// the remote host's filesystem over SSH. Required by the SSH backend in
// src/lib/context-parser.ts, src/lib/sessions-index.ts, etc.
//
// All commands require ssh-key auth (identity_file). Password auth is
// rejected up front because the existing SSH primitives use BatchMode,
// which blocks password prompts.

/// Run an arbitrary command on a remote host over SSH and return stdout.
/// Used by the read_*_ssh / get_*_ssh / install_*_ssh commands below.
/// Hard-requires ssh-key auth; returns Err if identity_file is None.
async fn ssh_exec_internal(
    host: &str,
    username: &str,
    identity_file: Option<&str>,
    command: &str,
) -> Result<String, String> {
    let key = match identity_file {
        Some(k) if !k.is_empty() => k,
        _ => return Err("SSH-key auth required (no identity file)".to_string()),
    };
    let user_host = format!("{}@{}", username, host);
    let key = expand_home(key)?;
    let mut cmd = ssh_background_command();
    cmd.args([
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=no",
        "-o", "ConnectTimeout=10",
        "-i", &key,
        &user_host,
        command,
    ]);
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to spawn ssh: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ssh exec failed: {}", stderr.trim()));
    }
    String::from_utf8(output.stdout).map_err(|e| format!("ssh stdout not UTF-8: {}", e))
}

/// Probe a remote host for its login shell, which shells exist, and which of
/// them can resolve each AI CLI in interactive-login mode (`<shell> -lic`).
/// One SSH round-trip; parsed in src/lib/remote-cli-shells.ts. Needed because
/// `ssh host "exec claude"` runs the login shell NON-interactively — PATH
/// additions from .zshrc/.zprofile are absent and the bare CLI name fails
/// even though it works in an interactive SSH session. `command -v` under
/// `-lic` also catches function/alias wrappers (nvm lazy-loading).
#[tauri::command]
async fn ssh_detect_cli_shells(
    host: String,
    username: String,
    identity_file: Option<String>,
) -> Result<String, String> {
    let script = concat!(
        "echo \"SHELL:$SHELL\"; ",
        "for s in zsh bash fish; do command -v \"$s\" >/dev/null 2>&1 && echo \"HAVE:$s\"; done; ",
        "for s in zsh bash; do command -v \"$s\" >/dev/null 2>&1 || continue; ",
        "for c in claude codex gemini; do ",
        "\"$s\" -lic \"command -v $c >/dev/null 2>&1\" 2>/dev/null && echo \"CLI:$s:$c\"; ",
        "done; done; true",
    );
    ssh_exec_internal(&host, &username, identity_file.as_deref(), script).await
}

/// Encode a remote project path the way Claude names its transcript
/// directory under `~/.claude/projects/`: EVERY non-alphanumeric character
/// becomes `-`, including the leading `/` — `/home/user/foo` →
/// `-home-user-foo` (leading dash and all; spaces, dots and parens become
/// dashes too). Verified against real `~/.claude/projects` layouts.
///
/// The previous version trimmed the leading dash and kept spaces/dots, so
/// every `_ssh` session reader scanned a directory Claude never writes —
/// remote id detection, session context and first-prompt reads all came back
/// empty on servers where the sessions plainly existed.
fn encode_remote_project_key(path: &str) -> String {
    path.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Allowlist for values interpolated into the shell command body sent to
/// `ssh user@host <body>`. Allows ASCII alnum + `.`, `_`, `-`, ` ` (the
/// chars that legitimately appear in encoded Claude project keys, e.g.
/// `home-user-My Project`). Rejects every shell metacharacter that could
/// break out of a double-quoted string — `$` (var/cmd subst), backtick
/// (cmd subst), `\` (escapes), `"` (closes quote), plus the obvious
/// uglies (`;`, `&`, `|`, `<`, `>`, parens, braces, glob chars, control
/// chars, NUL).
fn is_safe_shell_identifier(s: &str) -> bool {
    if s.is_empty() || s.len() > 256 { return false; }
    s.bytes().all(|b| {
        // Allow: alnum, dot, underscore, dash, space, colon, comma, equals, plus
        b.is_ascii_alphanumeric()
            || matches!(b, b'.' | b'_' | b'-' | b' ' | b':' | b',' | b'=' | b'+')
    })
}

/// Shell snippet printing `file`'s mtime in epoch seconds, portable across
/// remote hosts. `file` must already be a quoted shell word, e.g. `"\"$f\""`.
///
/// GNU coreutils spells this `stat -c %Y`; macOS/BSD spells it `stat -f %m` and
/// REJECTS `-c` outright ("stat: illegal option -- c"). Remote servers are a
/// mix, so every remote mtime read has to try both.
///
/// A `-c`-only form does not merely degrade on macOS — paired with the
/// customary `2>/dev/null` it yields an EMPTY string, which parses as mtime 0,
/// which every `max_age_secs` filter downstream then rejects. That is exactly
/// why Claude session resume never worked against a macOS server:
/// `get_claude_session_id_ssh` discarded every candidate file it found and
/// always returned None, so the pane never learned its session id and the next
/// launch had nothing to `--resume`.
fn remote_mtime(file: &str) -> String {
    format!("stat -c %Y {f} 2>/dev/null || stat -f %m {f} 2>/dev/null", f = file)
}

/// True iff `s` is `__latest__` or a UUID like `8-4-4-4-12` hex.
fn is_uuid_or_latest(s: &str) -> bool {
    if s == "__latest__" { return true; }
    if s.len() != 36 { return false; }
    let b = s.as_bytes();
    let is_hex = |c: u8| c.is_ascii_hexdigit();
    b[8] == b'-' && b[13] == b'-' && b[18] == b'-' && b[23] == b'-'
        && b[..8].iter().all(|&c| is_hex(c))
        && b[9..13].iter().all(|&c| is_hex(c))
        && b[14..18].iter().all(|&c| is_hex(c))
        && b[19..23].iter().all(|&c| is_hex(c))
        && b[24..36].iter().all(|&c| is_hex(c))
}

/// Extract a UUID-like substring (8-4-4-4-12 hex) from a path. Used by the
/// SSH session-id lookups in lieu of a regex dependency.
fn extract_uuid_from_path(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    let n = bytes.len();
    if n < 36 { return None; }
    fn is_hex(c: u8) -> bool { matches!(c, b'0'..=b'9' | b'a'..=b'f' | b'A'..=b'F') }
    // Slide a 36-char window
    for start in 0..=(n - 36) {
        let w = &bytes[start..start + 36];
        if w[8] == b'-' && w[13] == b'-' && w[18] == b'-' && w[23] == b'-'
            && w[..8].iter().all(|&c| is_hex(c))
            && w[9..13].iter().all(|&c| is_hex(c))
            && w[14..18].iter().all(|&c| is_hex(c))
            && w[19..23].iter().all(|&c| is_hex(c))
            && w[24..36].iter().all(|&c| is_hex(c))
        {
            return Some(String::from_utf8_lossy(w).to_lowercase());
        }
    }
    None
}

/// Read context info for a Claude/Codex/Gemini session over SSH.
///
/// Runs the SAME script as every other backend (`context_script`), so the
/// remote header shows the same fields as a local one and cannot silently fall
/// behind it again. This used to be a parallel Rust re-implementation that
/// documented its own gaps — project-wide cost, the `~/.claude/sessions/`
/// name fallback, codex rate limits and title — as deliberate omissions "for
/// marginal UX gain". They are all present now, and they cost no extra
/// round-trips: it was always one `ssh` invocation, and it still is.
#[tauri::command]
async fn read_session_context_ssh(
    host: String,
    username: String,
    identity_file: Option<String>,
    terminal_type: String,
    remote_project_path: String,
    session_id: String,
) -> Result<String, String> {
    // `remote_project_path` is the pane's cwd ON THE REMOTE HOST. Claude does
    // not need it — the shared script locates the transcript by session id
    // (`find ~/.claude/projects -name "$SID.jsonl"`), which also sidesteps the
    // encoded-project-key case-sensitivity problem the old bespoke reader had.
    // Codex and Gemini DO need it: it scopes their `__latest__` read to this
    // project instead of the newest session anywhere on that host.
    if session_id.is_empty() {
        return Ok(String::new());
    }
    if !is_uuid_or_latest(&session_id) {
        return Err("invalid session_id (not UUID or __latest__)".to_string());
    }
    let script = match context_script(&terminal_type, &session_id, &remote_project_path) {
        Some(s) => s,
        None => return Ok(String::new()),
    };
    // Best-effort: a host that is asleep or mid-reboot must leave the header
    // showing its last value, not surface an error every 5s.
    Ok(ssh_exec_internal(&host, &username, identity_file.as_deref(), &script)
        .await
        .unwrap_or_default())
}

/// Fetch sessions-index.json from a remote host and parse it.
/// Returns the same JSON array shape as `read_sessions_index_native`.
#[tauri::command]
async fn read_sessions_index_ssh(
    host: String,
    username: String,
    identity_file: Option<String>,
    remote_project_path: String,
) -> Result<String, String> {
    let key = encode_remote_project_key(&remote_project_path);
    if !is_safe_shell_identifier(&key) {
        return Err("invalid remote_project_path".to_string());
    }
    // Fetch with case-insensitive directory fallback. `key` is pre-validated.
    let cmd = format!(
        r#"DIR="$HOME/.claude/projects/{key}"; if [ ! -d "$DIR" ]; then enc_lower=$(echo '{key}' | tr '[:upper:]' '[:lower:]'); for d in $HOME/.claude/projects/*/; do base=$(basename "$d"); if [ "$(echo "$base" | tr '[:upper:]' '[:lower:]')" = "$enc_lower" ]; then DIR="$d"; break; fi; done; fi; cat "$DIR/sessions-index.json" 2>/dev/null || true"#,
        key = key
    );
    let raw = ssh_exec_internal(&host, &username, identity_file.as_deref(), &cmd).await?;
    parse_sessions_index_from_content(&raw)
}

/// Fetch a single session JSONL from a remote host and extract the first user prompt.
#[tauri::command]
async fn read_session_first_prompt_ssh(
    host: String,
    username: String,
    identity_file: Option<String>,
    remote_project_path: String,
    session_id: String,
) -> Result<String, String> {
    let key = encode_remote_project_key(&remote_project_path);
    if !is_safe_shell_identifier(&key) {
        return Err("invalid remote_project_path".to_string());
    }
    if !is_uuid_or_latest(&session_id) || session_id == "__latest__" {
        return Err("invalid session_id (must be UUID)".to_string());
    }
    // Both key and session_id are pre-validated against an allowlist.
    let cmd = format!(
        "cat \"$HOME/.claude/projects/{}/{}.jsonl\" 2>/dev/null || true",
        key, session_id
    );
    let raw = ssh_exec_internal(&host, &username, identity_file.as_deref(), &cmd).await?;
    Ok(read_first_user_prompt_from_content(&raw).unwrap_or_default())
}

/// Find the newest Claude session UUID on a remote host for a given project.
/// Mirrors `find_newest_uuid_jsonl` but over SSH.
#[tauri::command]
async fn get_claude_session_id_ssh(
    host: String,
    username: String,
    identity_file: Option<String>,
    remote_project_path: String,
    exclude_ids: Vec<String>,
    max_age_secs: Option<u64>,
) -> Result<Option<String>, String> {
    let key = encode_remote_project_key(&remote_project_path);
    if !is_safe_shell_identifier(&key) {
        return Err("invalid remote_project_path".to_string());
    }
    // List jsonl files newest-first, with mtime in epoch seconds.
    // `key` is pre-validated against an allowlist.
    let cmd = format!(
        "ls -t \"$HOME/.claude/projects/{key}\"/*.jsonl 2>/dev/null | head -50 | while read -r f; do mt=$({mt}); printf '%s %s\\n' \"${{mt:-0}}\" \"$f\"; done",
        key = key,
        mt = remote_mtime("\"$f\"")
    );
    let raw = ssh_exec_internal(&host, &username, identity_file.as_deref(), &cmd).await.unwrap_or_default();
    if raw.trim().is_empty() {
        return Ok(None);
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs()).unwrap_or(0);
    for line in raw.lines() {
        let mut parts = line.splitn(2, ' ');
        let mtime = parts.next().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        let path = parts.next().unwrap_or("");
        if let Some(max) = max_age_secs {
            if now.saturating_sub(mtime) > max { continue; }
        }
        if let Some(id) = extract_uuid_from_path(path) {
            if exclude_ids.contains(&id) { continue; }
            return Ok(Some(id));
        }
    }
    Ok(None)
}

/// Find the newest Codex session ID on a remote host for a given project.
/// Falls back to scanning JSONL files (no SQLite over SSH).
#[tauri::command]
async fn get_codex_session_id_ssh(
    host: String,
    username: String,
    identity_file: Option<String>,
    remote_project_path: String,
    exclude_ids: Vec<String>,
    max_age_secs: Option<u64>,
) -> Result<Option<String>, String> {
    let cwd = remote_project_path.replace('\'', "");
    // Walk ~/.codex/sessions/, sort by mtime, read first line of each, match cwd.
    let cmd = format!(
        r#"find $HOME/.codex/sessions -type f -name '*.jsonl' 2>/dev/null | while read -r f; do mt=$({mt}); printf '%s %s\n' "${{mt:-0}}" "$f"; done | sort -rn | head -30 | while read -r mt path; do first=$(head -1 "$path" 2>/dev/null); echo "$mt|$first"; done"#,
        mt = remote_mtime("\"$f\"")
    );
    let raw = ssh_exec_internal(&host, &username, identity_file.as_deref(), &cmd).await.unwrap_or_default();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs()).unwrap_or(0);
    for line in raw.lines() {
        let mut parts = line.splitn(2, '|');
        let mtime = parts.next().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        let json_line = parts.next().unwrap_or("");
        if let Some(max) = max_age_secs {
            if now.saturating_sub(mtime) > max { continue; }
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(json_line) {
            let session_cwd = v.pointer("/payload/cwd").and_then(|v| v.as_str()).unwrap_or("");
            if session_cwd != cwd { continue; }
            // Codex's own sub-agent rollouts carry the pane's cwd too — the
            // SQLite path drops them via CODEX_USER_THREAD_FILTER, and there is
            // no SQLite over SSH, so this is the only place it can happen here.
            if v.pointer("/payload/thread_source").and_then(|v| v.as_str()) == Some("subagent") {
                continue;
            }
            if let Some(id) = v.get("id").and_then(|v| v.as_str()) {
                if exclude_ids.iter().any(|e| e == id) { continue; }
                return Ok(Some(id.to_string()));
            }
        }
    }
    Ok(None)
}

/// Find the newest Gemini session ID on a remote host for a given project.
#[tauri::command]
async fn get_gemini_session_id_ssh(
    host: String,
    username: String,
    identity_file: Option<String>,
    remote_project_path: String,
    exclude_ids: Vec<String>,
    max_age_secs: Option<u64>,
) -> Result<Option<String>, String> {
    let basename = std::path::Path::new(&remote_project_path)
        .file_name()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if basename.is_empty() {
        return Ok(None);
    }
    if !is_safe_shell_identifier(&basename) {
        return Err("invalid remote_project_path basename (unsafe characters)".to_string());
    }
    // `basename` is pre-validated against an allowlist.
    let cmd = format!(
        r#"for d in "$HOME/.gemini/tmp/{base}"*/chats; do [ -d "$d" ] || continue; ls -t "$d"/*.json 2>/dev/null | head -20 | while read -r f; do mt=$({mt}); printf '%s %s\n' "${{mt:-0}}" "$f"; done; done"#,
        base = basename,
        mt = remote_mtime("\"$f\"")
    );
    let raw = ssh_exec_internal(&host, &username, identity_file.as_deref(), &cmd).await.unwrap_or_default();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs()).unwrap_or(0);
    for line in raw.lines() {
        let mut parts = line.splitn(2, ' ');
        let mtime = parts.next().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        let path = parts.next().unwrap_or("");
        if let Some(max) = max_age_secs {
            if now.saturating_sub(mtime) > max { continue; }
        }
        if let Some(id) = extract_uuid_from_path(path) {
            if exclude_ids.contains(&id) { continue; }
            return Ok(Some(id));
        }
    }
    Ok(None)
}

/// Install the MADE statusline wrapper on a remote SSH host.
///
/// Uses the SAME wrapper and the SAME installer as the local path — the two
/// used to be separate literals kept in sync by a comment. Idempotent: returns
/// "ALREADY_INSTALLED" when the version matches AND settings.json actually
/// points at the wrapper (the version alone used to be enough, which is how a
/// host whose settings.json never got the statusLine entry stayed broken
/// forever while reporting success).
#[tauri::command]
async fn install_statusline_wrapper_ssh(
    host: String,
    username: String,
    identity_file: Option<String>,
) -> Result<String, String> {
    let script = statusline_install_script(&statusline_wrapper_b64());
    ssh_exec_internal(&host, &username, identity_file.as_deref(), &script).await
}

#[tauri::command]
fn preview_proxy_port(state: State<'_, preview_proxy::ProxyHandle>) -> u16 {
    state.port()
}

#[tauri::command]
fn preview_proxy_set_target(
    url: String,
    state: State<'_, preview_proxy::ProxyHandle>,
) -> Result<(), String> {
    state.set_target(&url)
}

/// Open the WebView DevTools for the calling window. Callable from the
/// frontend right-click menu so we always have an inspector handy in both
/// debug and release builds (gated by the `devtools` Cargo feature).
///
/// ASYNC, AND HOPS TO THE MAIN THREAD — both deliberate, and neither is
/// cosmetic (2026-07-27):
///
///   - `async` puts this on tauri's ASYNC runtime instead of its blocking
///     command threadpool. This command's whole job is to be reachable when
///     something has gone wrong, and the thing most likely to have gone wrong
///     is that pool: every `native_term_*` command is synchronous and each one
///     holds the process-wide registry mutex across a blocking GPU present. A
///     sync `open_devtools` queues behind exactly that jam, so the one tool you
///     need in order to diagnose the jam is the one tool the jam disables. The
///     user-visible symptom was "DevTools does nothing" — no error, because
///     `runCommand("app.devtools")` swallows the rejection.
///   - `open_devtools()` reaches WebView2, which is apartment-bound to the
///     thread that created it. Called from a pool thread it is a no-op at best.
///     `run_on_main_thread` POSTS the closure (it does not block waiting for
///     it), so this stays off the critical path.
#[tauri::command]
async fn open_devtools(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    app.run_on_main_thread(move || {
        window.open_devtools();
    })
    .map_err(|e| format!("open_devtools: {e}"))
}

/// Frontend diagnostic line, written into the same `%TEMP%\made-logs\made-<profile>.log`
/// the Rust side uses, so a repro produces ONE interleaved timeline instead of
/// two half-stories that have to be correlated by eye.
///
/// Async for the same reason as `open_devtools` above: the leak probe exists to
/// measure a suspected stall in the blocking-command pool, so it must not run
/// ON that pool — a probe that stops reporting exactly when the thing it is
/// measuring goes wrong reports nothing about the only moment that matters.
///
/// The build tag is prepended HERE rather than passed up from JS: this is the
/// binary actually executing, so it cannot drift from whatever version the
/// frontend bundle thinks it is.
#[tauri::command]
async fn debug_log_line(line: String) {
    debug_log::dlog(&format!("[{}] {line}", debug_log::build_tag()));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        // The overlay is positioned programmatically (sync_geometry covers the
        // main window's client area) — window-state must never save/restore it.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_denylist(&["overlay"])
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![ssh_ls, ssh_mkdir, ssh_forward_port_start, ssh_forward_port_stop, ssh_test_connection, ssh_unlock_keychain, ssh_ensure_key, ssh_forget_host, ssh_detect_cli_shells, ssh_list_keys, ssh_read_file, ssh_write_file, ssh_upload_file_bytes, ssh_grep, read_file, write_file, read_image_data_uri, create_project, list_dir, search_in_files, git_is_repo, git_status, git_diff, git_branches, git_diff_stats, git_switch_branch, git_create_branch, git_revert_hunk, git_discard_file, git_add, git_reset_files, git_commit, git_push, git_pull, git_fetch, git_ahead_behind, git_is_repo_ssh, git_status_ssh, git_branches_ssh, git_diff_ssh, git_diff_stats_ssh, git_ahead_behind_ssh, git_run_typecheck, git_run_lint, git_run_tests, gh_status, gh_create_repo, gh_release_create, gh_pr_status, gh_pr_create, git_commits_between, git_remote_info, detect_manifests, is_tauri_project, release_bump, updater_install_version, wsl_resolve_cli_env, wsl_list_distros, windows_resolve_cli_env, native_resolve_cli_env, cli_install::cli_probe, cli_install::cli_install_start, cli_install::cli_install_cancel, get_claude_session_id, get_codex_session_id, get_gemini_session_id, get_claude_session_id_windows, get_codex_session_id_windows, get_gemini_session_id_windows, get_claude_session_id_native, get_codex_session_id_native, get_gemini_session_id_native, get_claude_session_id_by_spawn, get_claude_session_id_by_spawn_windows, get_claude_session_id_by_spawn_native, read_session_context_windows, read_session_context_native, save_clipboard_image, save_annotated_image, cleanup_clipboard_images, poll_clipboard_image, launch_snipping_tool, reveal_in_explorer, open_folder, copy_image_to_clipboard, set_window_corners, set_app_icon_variant, install_statusline_wrapper, read_session_context, read_sessions_index, read_sessions_index_windows, read_sessions_index_native, read_cli_sessions_index, read_cli_sessions_index_windows, read_cli_sessions_index_native, cli_session_exists, cli_session_exists_windows, cli_session_exists_native, read_session_first_prompt, read_session_first_prompt_windows, read_session_first_prompt_native, claude_session_file_exists, claude_session_file_exists_windows, claude_session_file_exists_native, claude_session_ids, claude_session_ids_windows, claude_session_ids_native, read_session_prompts, read_session_prompts_windows, read_session_prompts_native, read_session_last_assistant_text, read_session_last_assistant_text_windows, read_session_last_assistant_text_native, set_claude_notif_channel, set_claude_notif_channel_windows, set_claude_notif_channel_native, jira_mcp_status, jira_mcp_status_windows, jira_mcp_status_native, jira_mcp_status_ssh, jira_mcp_install, jira_mcp_install_direct, jira_mcp_install_ssh, read_session_context_ssh, read_sessions_index_ssh, read_session_first_prompt_ssh, get_claude_session_id_ssh, get_codex_session_id_ssh, get_gemini_session_id_ssh, install_statusline_wrapper_ssh, minimize_from_maximized, port_check, preview_proxy_port, preview_proxy_set_target, open_devtools, debug_log_line, pty::pty_spawn, pty::pty_spawn_pooled, pty::pty_pool_warm, pty::pty_write, pty::pty_resize, pty::pty_kill, native_term::native_term_create, native_term::native_term_destroy, native_term::native_term_reap_all, native_term::native_term_gpu_info, native_term::native_term_show, native_term::native_term_hide, native_term::native_term_resize, native_term::native_term_set_region, native_term::native_term_frame_sync, native_term::native_term_attach_pty, native_term::native_term_detach_pty, native_term::native_term_propose_dimensions, native_term::native_term_set_theme, native_term::native_term_set_font, native_term::native_term_set_render_opts, native_term::native_term_list_mono_fonts, native_term::native_term_set_cursor_style, native_term::native_term_set_focused, native_term::native_term_set_hover_link, native_term::native_term_get_metrics, native_term::native_term_set_copy_on_select, native_term::native_term_copy_selection, native_term::native_term_paste_clipboard, native_term::native_term_focus_keyboard, native_term::native_term_debug_inject_bytes, native_term::native_term_debug_stats, native_term::native_term_get_buffer_lines, native_term::native_term_get_viewport_state, native_term::native_term_get_selection, native_term::native_term_scroll_to_bottom, native_term::native_term_scroll_to_line, native_term::native_term_clear, native_term::native_term_reset, native_term::native_term_search, native_term::native_term_search_clear, native_term::native_term_set_search_highlights, native_term::native_term_tui_scroll, native_term::native_term_set_wheel_acceleration, native_term::native_term_set_prompt_nav, native_term::native_term_set_prompt_jump, browser_view::browser_view_create, browser_view::browser_view_destroy, browser_view::browser_view_reap_all, browser_view::browser_view_show, browser_view::browser_view_hide, browser_view::browser_view_set_bounds, browser_view::browser_view_navigate, browser_view::browser_view_back, browser_view::browser_view_forward, browser_view::browser_view_reload, browser_view::browser_view_hard_reload, browser_view::browser_view_focus, browser_view::browser_view_url, browser_view::browser_view_eval, browser_view::browser_view_enable_devtools, browser_view::browser_view_allow_download, browser_view::browser_view_deny_download, browser_view::browser_view_set_prompt_downloads, overlay::overlay_set_region, overlay::overlay_set_focusable, file_watch::watch_file, file_watch::unwatch_file, screenshots::screenshots_resolve_folder, screenshots::screenshots_list_recent, screenshots::screenshots_find_original, screenshots::screenshots_delete, screenshots::screenshots_watch_start, screenshots::screenshots_watch_stop, screenshots::screenshots_overwrite, fs_ops::fs_rename, fs_ops::fs_delete_to_trash, fs_ops::fs_create_file, fs_ops::fs_create_dir, wsl_health::wsl_ensure_memory_reclaim, wsl_health::wsl_pane_activity, wsl_health::claude_session_activity_mtime, wsl_health::wsl_shutdown])
        .setup(|app| {
            // A3: build the shared wgpu Instance+Adapter on a background thread
            // NOW, so the one-time driver/DXGI enumeration (~534ms measured on
            // the first pane) overlaps the webview load instead of landing on
            // the first pane the user opens. Non-fatal if it fails — pane
            // creation just builds them on demand as before.
            native_term::renderer::gpu::prewarm();

            // Windows drops WinRT toasts whose AppUserModelID nobody
            // registered, and the notification plugin posts installed-app
            // toasts under AUMID = the config identifier. The NSIS Start-Menu
            // shortcut is the usual carrier of that registration; this
            // machine-independent HKCU registration covers shortcut-less
            // installs too (without it, every toast vanished silently and
            // MADE never appeared under Windows notification settings).
            #[cfg(target_os = "windows")]
            register_toast_aumid(app.handle());

            // Registry of active `ssh -N -L` port-forward processes for remote
            // dev servers (commands: ssh_forward_port_start / _stop).
            app.manage(SshForwardRegistry::default());

            // Refcounted directory watches backing the text editor's live
            // reload (commands: watch_file / unwatch_file, event:
            // made:file-changed).
            app.manage(file_watch::FileWatchState::default());

            // Single non-recursive watch on the OS Screenshots folder, so snips
            // that never reach the clipboard still appear (commands:
            // screenshots_watch_start / _stop, event: made:screenshot-added).
            app.manage(screenshots::ScreenshotWatchState::default());

            // Start the local preview proxy. The browser pane forwards iframe
            // requests through this so it can inject the devtools script and
            // strip framing/CSP headers — works in dev AND prod.
            match preview_proxy::start() {
                Ok(handle) => {
                    eprintln!("[made] preview proxy listening on 127.0.0.1:{}", handle.port());
                    app.manage(handle);
                }
                Err(e) => eprintln!("[made] preview proxy failed to start: {e}"),
            }

            // Auto-open DevTools in debug builds so the diagnostic logs from
            // the dev-server restore (and any frontend errors) are visible
            // without an extra click. Production builds are unaffected.
            #[cfg(debug_assertions)]
            {
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                    // Dev builds identify themselves in the title bar / taskbar /
                    // Get-Process MainWindowTitle, so a debug instance is never
                    // mistaken for the installed production app (which may hold
                    // live work — never kill it by name).
                    let _ = window.set_title("MADE_debug");
                }
            }


            #[cfg(target_os = "windows")]
            {
                // Allocate a hidden console so child processes (wsl.exe) don't
                // create visible console windows. GUI apps have no console by
                // default — any console app spawned as a child creates a new
                // visible console window. Pre-allocating a hidden one makes all
                // children inherit it invisibly.
                {
                    extern "system" {
                        fn AllocConsole() -> i32;
                        fn GetConsoleWindow() -> *mut std::ffi::c_void;
                        fn ShowWindow(hwnd: *mut std::ffi::c_void, cmd: i32) -> i32;
                    }
                    unsafe {
                        AllocConsole();
                        let hwnd = GetConsoleWindow();
                        if !hwnd.is_null() {
                            ShowWindow(hwnd, 0); // SW_HIDE
                        }
                    }
                }

                let window = app.get_webview_window("main").expect("main window not found");
                let hwnd = window.hwnd().expect("failed to get HWND");
                native_term::registry::set_parent_hwnd(hwnd.0 as isize);
                // The browser pane hosts its wry webview in a child HWND of the
                // same main window (see browser_view/host.rs).
                browser_view::set_parent_hwnd(hwnd.0 as isize);
                let hwnd_raw = hwnd.0 as isize;
                let border_app_handle = app.handle().clone();
                window
                    .with_webview(move |webview| {
                        win32_border::remove_border(hwnd_raw as *mut _, webview.controller(), border_app_handle);
                    })
                    .expect("failed to configure Windows frameless window");

                // --- Overlay webview (Phase 0 de-risk prototype) ----------
                // A transparent, OWNED, always-above second WebView2 for
                // floating popups. `parent(&window)` sets `window` as the OWNER
                // on Windows, so the overlay is always above the owner AND its
                // child HWNDs (the native-term wgpu panes) in z-order (MSDN
                // owned-window rules) — we never fight the pane z-order. It does
                // NOT get win32_border (that is main-window-specific).
                //
                // Transparency: build #1 uses `.transparent(true)` alone. Tauri
                // 2.10.x is far newer than the #12450 (transparent + parent =>
                // black) report; if it renders black on hardware, the next
                // iteration adds the WebView2 controller DefaultBackgroundColor
                // fix. Overlay-creation failure must NOT take down the app, so
                // we log and continue.
                // #12450 workaround: creating the overlay transparent WITH a
                // parent/owner breaks WebView2 transparency on Windows — the
                // transparent areas composite to BLACK (so a popup's rounded /
                // shadowed edges render square + dark). wry's transparency path
                // works fine on a plain top-level window, so we build it
                // parent-LESS, then set `main` as the OWNER post-hoc via
                // GWLP_HWNDPARENT — restoring owned-window z-order (always above
                // the owner AND its child HWNDs, i.e. the native panes) without
                // re-breaking the transparency established at creation.
                let overlay_res = tauri::WebviewWindowBuilder::new(
                    app,
                    "overlay",
                    tauri::WebviewUrl::App("overlay.html".into()),
                )
                // Never let the default "Tauri App" title leak anywhere
                // (it showed in the classic-NC caption bug).
                .title("MADE")
                .transparent(true)
                .decorations(false)
                .shadow(false)
                .resizable(false)
                .skip_taskbar(true)
                .focused(false)
                .visible(false)
                .inner_size(1.0, 1.0)
                .build();
                match overlay_res {
                    Ok(overlay) => {
                        let overlay_hwnd = overlay.hwnd().map(|h| h.0 as isize).unwrap_or(0);
                        if overlay_hwnd != 0 {
                            // Owner FIRST (z-order above the panes), then
                            // ex-styles, then cover main's client area BEFORE
                            // showing so the overlay never flashes at (0,0)/1x1.
                            overlay::win32::set_owner(overlay_hwnd, hwnd_raw);
                            overlay::win32::apply_ex_styles(overlay_hwnd);
                            // Persistent subclass — the style strip above does
                            // NOT survive tao's own GWL_STYLE rewrites; this
                            // removes the NC area structurally instead.
                            overlay::win32::install_nc_guard(overlay_hwnd);
                            overlay::win32::sync_geometry(hwnd_raw, overlay_hwnd);
                        }
                        // DefaultBackgroundColor: READ-ONLY on purpose.
                        //
                        // The 2026-08-04 black-scrollbar learnings doc proposed
                        // SETTING this to 0x00000000 here as the root-cause fix.
                        // It is already set, twice, before we could: our
                        // `.transparent(true)` reaches wry as
                        // `WebViewAttributes::transparent`, which makes it pass
                        // `Some((0,0,0,0))` into `create_controller`
                        // (wry-0.54.2 webview2/mod.rs:126-130 ->
                        // ICoreWebView2ControllerOptions3 at :390-400) AND call
                        // `set_background_color(controller, (0,0,0,0))` again
                        // after creation (:448-451). Re-setting it would be a
                        // no-op that reads like a fix — the exact cargo-cult a
                        // 2026-07-21 note already warned against ("wry already
                        // sets SetDefaultBackgroundColor(A:0); don't re-add it").
                        //
                        // The black came from GDI, not from WebView2: see the
                        // WM_PAINT arm in overlay::win32::install_nc_guard. This
                        // probe stays as one startup line of evidence so the
                        // next session can rule the controller out in seconds
                        // instead of re-deriving it from three crates' sources.
                        {
                            use webview2_com::Microsoft::Web::WebView2::Win32::{
                                COREWEBVIEW2_COLOR, ICoreWebView2Controller2,
                            };
                            use windows_webview2::core::Interface;
                            let _ = overlay.with_webview(|webview| unsafe {
                                match webview.controller().cast::<ICoreWebView2Controller2>() {
                                    Ok(c2) => {
                                        let mut c = COREWEBVIEW2_COLOR::default();
                                        let read = c2.DefaultBackgroundColor(&mut c);
                                        debug_log::dlog(&format!(
                                            "[overlay.bgcolor] read={} A={} R={} G={} B={} (expect A=0: wry set it)",
                                            read.is_ok(), c.A, c.R, c.G, c.B
                                        ));
                                    }
                                    Err(e) => debug_log::dlog(&format!(
                                        "[overlay.bgcolor] ICoreWebView2Controller2 cast failed: {e}"
                                    )),
                                }
                            });
                        }

                        let _ = overlay.show();

                        // Keep the overlay covering main's CLIENT area on every
                        // move / resize / maximize / DPI change. Capture only
                        // isize HWNDs (Copy + Send).
                        let main_isize = hwnd_raw;
                        let ov_isize = overlay_hwnd;
                        window.on_window_event(move |ev| {
                            if ov_isize == 0 {
                                return;
                            }
                            match ev {
                                tauri::WindowEvent::Moved(_)
                                | tauri::WindowEvent::Resized(_)
                                | tauri::WindowEvent::ScaleFactorChanged { .. } => {
                                    overlay::win32::sync_geometry(main_isize, ov_isize);
                                }
                                _ => {}
                            }
                        });
                    }
                    Err(e) => {
                        eprintln!("[made] overlay window creation failed: {e}");
                    }
                }

                // Keep a persistent WSL process alive — boots the WSL VM and
                // keeps it warm so subsequent wsl.exe calls are fast.
                // Uses /bin/cat which blocks on stdin indefinitely.
                // The child process is killed when the app exits (handle dropped).
                std::thread::spawn(|| {
                    let _ = wsl_command()
                        .args(["-e", "/bin/cat"])
                        .stdin(std::process::Stdio::piped())
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .spawn();
                });
            }

            // macOS: no special window setup needed — using native decorations
            // via tauri.macos.conf.json overlay. No WSL VM to warm.
            #[cfg(target_os = "macos")]
            {
                let _ = app; // suppress unused warning
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod jira_mcp_tests {
    use super::*;

    /// The real shape `codex mcp add` writes, alongside an unrelated stdio
    /// server with a sub-table — the sub-table is what a naive "scan until the
    /// next header" parser gets wrong.
    const CODEX_CONFIG: &str = r#"
[projects."/home/u/p"]
trust_level = "trusted"

[mcp_servers.blender]
command = "uvx"
args = ["blender-mcp"]

[mcp_servers.blender.env]
BLENDER_HOST = "127.0.0.1"

[mcp_servers.atlassian]
url = "https://mcp.atlassian.com/v1/mcp/authv2"
"#;

    #[test]
    fn codex_finds_atlassian_by_name() {
        assert_eq!(find_atlassian_in_codex_toml(CODEX_CONFIG).as_deref(), Some("atlassian"));
    }

    #[test]
    fn codex_finds_a_renamed_server_by_url() {
        let renamed = "[mcp_servers.support]\nurl = \"https://mcp.atlassian.com/v1/mcp/authv2\"\n";
        assert_eq!(find_atlassian_in_codex_toml(renamed).as_deref(), Some("support"));
    }

    #[test]
    fn codex_reports_none_without_it() {
        let only_blender = "[mcp_servers.blender]\ncommand = \"uvx\"\n";
        assert!(find_atlassian_in_codex_toml(only_blender).is_none());
        assert!(find_atlassian_in_codex_toml("").is_none());
        // A `projects` table naming an atlassian PATH is not an MCP server.
        assert!(find_atlassian_in_codex_toml("[projects.\"/home/u/atlassian\"]\n").is_none());
    }

    #[test]
    fn codex_section_names_ignore_sub_tables_and_quotes() {
        assert_eq!(codex_mcp_section_name("[mcp_servers.a.env]").as_deref(), Some("a"));
        assert_eq!(codex_mcp_section_name("[mcp_servers.\"my server\"]").as_deref(), Some("my server"));
        assert_eq!(codex_mcp_section_name("[tui]"), None);
    }

    #[test]
    fn gemini_finds_atlassian_at_any_depth() {
        // Today's shape: top-level `mcpServers`.
        let top: serde_json::Value = serde_json::from_str(
            r#"{"model":{"name":"x"},"mcpServers":{"atlassian":{"url":"https://mcp.atlassian.com/v1/mcp/authv2","type":"http"}}}"#,
        )
        .unwrap();
        assert_eq!(find_atlassian_in_gemini_settings(&top).as_deref(), Some("atlassian"));

        // Nested, in case the settings schema moves again — the whole reason
        // this walks the tree instead of reading one fixed key.
        let nested: serde_json::Value =
            serde_json::from_str(r#"{"mcp":{"mcpServers":{"jira-things":{"httpUrl":"https://example.test"}}}}"#)
                .unwrap();
        assert_eq!(find_atlassian_in_gemini_settings(&nested).as_deref(), Some("jira-things"));

        let empty: serde_json::Value = serde_json::from_str(r#"{"mcpServers":{}}"#).unwrap();
        assert!(find_atlassian_in_gemini_settings(&empty).is_none());
    }

    /// EVERY add is wrapped in a deadline — an unbounded one leaves the
    /// Settings button spinning with no way back. Codex's is the short,
    /// expected one; Gemini's `--scope user` must survive edits, because its
    /// own default is project scope.
    #[test]
    fn every_add_command_is_bounded_and_shaped_per_cli() {
        assert_eq!(
            jira_mcp_add_command(JiraCli::Codex),
            format!("timeout 8 codex mcp add atlassian --url {ATLASSIAN_MCP_URL}"),
        );
        assert_eq!(
            jira_mcp_add_command(JiraCli::Gemini),
            format!("timeout 45 gemini mcp add --transport http --scope user atlassian {ATLASSIAN_MCP_URL}"),
        );
        for cli in [JiraCli::Claude, JiraCli::Codex, JiraCli::Gemini] {
            assert!(jira_mcp_add_command(cli).starts_with("timeout "), "{} unbounded", cli.binary());
        }
        assert!(jira_mcp_add_command(JiraCli::Claude).contains("--scope user"));
    }

    /// The remote shell reaches an ssh command line, so anything that is not a
    /// plain shell name or path must be dropped rather than passed through.
    #[test]
    fn remote_shell_is_sanitised() {
        assert_eq!(safe_remote_shell(Some("/bin/zsh")), "/bin/zsh");
        assert_eq!(safe_remote_shell(Some("fish")), "fish");
        assert_eq!(safe_remote_shell(None), "bash");
        assert_eq!(safe_remote_shell(Some("   ")), "bash");
        for hostile in ["bash; rm -rf ~", "bash && curl evil", "bash $(id)", "bash|tee x", "b'a"] {
            assert_eq!(safe_remote_shell(Some(hostile)), "bash", "let through: {hostile}");
        }
    }

    /// The one caller-supplied value in the probe is the project path.
    #[test]
    fn probe_script_quotes_the_project_path() {
        let nasty = "/srv/it's here; rm -rf ~";
        let script = jira_mcp_probe_script(JiraCli::Claude, Some(nasty));
        assert!(script.contains(r#"'/srv/it'\''s here; rm -rf ~/.mcp.json'"#), "{script}");
        // Codex has no project scope, so it never cats a project file at all.
        assert!(!jira_mcp_probe_script(JiraCli::Codex, Some(nasty)).contains("rm -rf"));
        assert!(jira_mcp_probe_script(JiraCli::Gemini, Some("/p")).contains("/p/.gemini/settings.json"));
        // No project → no second cat, and still a well-formed script.
        assert!(jira_mcp_probe_script(JiraCli::Claude, None).ends_with("exit 0"));
    }

    #[test]
    fn probe_output_splits_into_sections() {
        let out = format!(
            "{SSH_PROBE_EXISTS}\n1\n{SSH_PROBE_USER}\n{{\"a\":1}}\n\n{SSH_PROBE_PROJECT}\n{{\"b\":2}}\n"
        );
        let (exists, user, project) = split_jira_probe(&out);
        assert!(exists);
        assert_eq!(user.trim(), "{\"a\":1}");
        assert_eq!(project.trim(), "{\"b\":2}");

        // Missing config: marker says the CLI has run here, user blob empty.
        let bare = format!("{SSH_PROBE_EXISTS}\n0\n{SSH_PROBE_USER}\n\n{SSH_PROBE_PROJECT}\n");
        let (exists, user, project) = split_jira_probe(&bare);
        assert!(!exists);
        assert!(user.trim().is_empty() && project.trim().is_empty());
    }
}
