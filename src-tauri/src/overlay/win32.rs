//! Win32 glue for the overlay window: ex-styles, post-hoc owner, geometry sync,
//! and click-through via a rounded `SetWindowRgn` clip.
//!
//! A windowed WebView2 (Chromium) runs its own input handling and ignores
//! `WS_EX_TRANSPARENT`, so the ONLY reliable way to pass a click through to the
//! panes below is to clip the host window with a region: inside a popup shape
//! the overlay is part of the window (hit-testable, the popup's DOM gets the
//! click); everywhere else the overlay is not part of the window at all, so the
//! click falls through to the pane. The region is a 1-BIT mask (no partial
//! alpha), which is why popups are flat — crisp rounded corners, but no soft
//! drop shadow (a shadow is partial-alpha pixels the mask cannot represent).

#[cfg(target_os = "windows")]
pub fn apply_ex_styles(hwnd: isize) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, GWL_STYLE,
        SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
        WS_CAPTION, WS_EX_NOACTIVATE, WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_POPUP, WS_SYSMENU,
        WS_THICKFRAME,
    };
    unsafe {
        let hwnd = HWND(hwnd as *mut _);
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        // NOACTIVATE: never steal focus from the React UI.
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | (WS_EX_NOACTIVATE.0 as isize));

        // Strip EVERY caption/frame style. Tauri's "frameless" windows keep
        // WS_CAPTION and merely suppress its rendering — but a window carrying a
        // SetWindowRgn region falls back to CLASSIC (non-DWM) non-client
        // painting, which paints the suppressed caption back as an old-style
        // "Tauri App" title bar the moment the region is applied. A pure
        // WS_POPUP window has no non-client area, so there is nothing for the
        // classic path to paint — and window origin == client origin, so the
        // region coordinates line up exactly.
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        let cleaned = (style
            & !(WS_CAPTION.0 as isize)
            & !(WS_THICKFRAME.0 as isize)
            & !(WS_SYSMENU.0 as isize)
            & !(WS_MINIMIZEBOX.0 as isize)
            & !(WS_MAXIMIZEBOX.0 as isize))
            | (WS_POPUP.0 as isize);
        if cleaned != style {
            SetWindowLongPtrW(hwnd, GWL_STYLE, cleaned);
            let _ = SetWindowPos(
                hwnd,
                HWND::default(),
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
    }
}

/// Make `owner_hwnd` the OWNER of the overlay window AFTER creation (see the
/// #12450 note in lib.rs): keeps owned-window z-order (above the owner and its
/// child HWNDs, i.e. the native panes) without breaking the transparency
/// established at build time.
#[cfg(target_os = "windows")]
pub fn set_owner(overlay_hwnd: isize, owner_hwnd: isize) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowLongPtrW, GWLP_HWNDPARENT};
    unsafe {
        SetWindowLongPtrW(HWND(overlay_hwnd as *mut _), GWLP_HWNDPARENT, owner_hwnd);
    }
}

/// Position/size the overlay to cover the MAIN window's CLIENT area, in screen
/// coordinates. Called on create and on every main-window move/resize/DPI change.
#[cfg(target_os = "windows")]
pub fn sync_geometry(main_hwnd: isize, overlay_hwnd: isize) {
    use windows::Win32::Foundation::{HWND, POINT, RECT};
    use windows::Win32::Graphics::Gdi::ClientToScreen;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClientRect, SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER,
    };
    unsafe {
        let main = HWND(main_hwnd as *mut _);
        let overlay = HWND(overlay_hwnd as *mut _);
        let mut rc = RECT::default();
        if GetClientRect(main, &mut rc).is_err() {
            return;
        }
        let mut tl = POINT { x: rc.left, y: rc.top };
        let _ = ClientToScreen(main, &mut tl);
        let w = rc.right - rc.left;
        let h = rc.bottom - rc.top;
        let _ = SetWindowPos(
            overlay,
            HWND::default(),
            tl.x,
            tl.y,
            w,
            h,
            SWP_NOACTIVATE | SWP_NOZORDER,
        );
    }
}

/// Clip the overlay to the UNION of popup shapes. Each tuple is
/// (left, top, right, bottom, corner_diameter) in physical px; diameter 0 => a
/// sharp rectangle, > 0 => a rounded rect matching the popup's CSS radius. An
/// empty slice => empty region => the overlay is fully click-through.
#[cfg(target_os = "windows")]
pub fn set_region(hwnd: isize, rects_px: &[(i32, i32, i32, i32, i32)]) -> Result<(), String> {
    use windows::Win32::Foundation::{BOOL, HWND};
    use windows::Win32::Graphics::Gdi::{
        CombineRgn, CreateRectRgn, CreateRoundRectRgn, DeleteObject, SetWindowRgn, RGN_OR,
    };
    unsafe {
        let hwnd = HWND(hwnd as *mut _);
        let rgn = CreateRectRgn(0, 0, 0, 0);
        if rgn.is_invalid() {
            return Err("CreateRectRgn (base) failed".to_string());
        }
        for &(l, t, r, b, diam) in rects_px {
            let piece = if diam > 0 {
                CreateRoundRectRgn(l, t, r, b, diam, diam)
            } else {
                CreateRectRgn(l, t, r, b)
            };
            if piece.is_invalid() {
                let _ = DeleteObject(rgn);
                return Err("CreateRectRgn (piece) failed".to_string());
            }
            let res = CombineRgn(rgn, rgn, piece, RGN_OR);
            let _ = DeleteObject(piece);
            if res.0 == 0 {
                let _ = DeleteObject(rgn);
                return Err("CombineRgn failed".to_string());
            }
        }
        // SetWindowRgn takes ownership of the HRGN on success. bRedraw=FALSE:
        // Chromium repaints the overlay continuously and DWM re-composites on
        // region change anyway — the forced invalidation only added a visible
        // flash over the whole app on popup open/close.
        if SetWindowRgn(hwnd, rgn, BOOL(0)) == 0 {
            let _ = DeleteObject(rgn);
            return Err("SetWindowRgn failed".to_string());
        }
    }
    Ok(())
}

/// Show/hide the overlay WITHOUT activating it. This replaced the old
/// empty-region<->full-region flips for popup open/close: `SetWindowRgn` on a
/// VISIBLE window invalidates the window AND every window underneath the
/// changed area (legacy GDI exposure), and the main window + its WebView2 /
/// wgpu children then race the next DWM frame to re-present — losing the race
/// painted the whole app in bare #0d1117 for 1-2 frames (the hardware-captured
/// "flicker when menus open/close" bug; ~30% of transitions). Show/hide of a
/// whole top-level window is a pure DWM composition op and invalidates
/// nothing beneath. Raw ShowWindow (not tauri's show/hide) so ordering with
/// the region calls in `overlay_set_region` is strictly synchronous.
#[cfg(target_os = "windows")]
pub fn set_shown(hwnd: isize, shown: bool) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE, SW_SHOWNA};
    unsafe {
        let _ = ShowWindow(HWND(hwnd as *mut _), if shown { SW_SHOWNA } else { SW_HIDE });
    }
}

/// Is the overlay currently shown? (WS_VISIBLE, ignoring owner minimize.)
#[cfg(target_os = "windows")]
pub fn is_shown(hwnd: isize) -> bool {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::IsWindowVisible;
    unsafe { IsWindowVisible(HWND(hwnd as *mut _)).as_bool() }
}

/// Focus-handoff re-assert state (see `set_focusable`): number of retry
/// ticks left on the FOCUS_RETRY_TIMER. While > 0, the NC-guard's WM_TIMER
/// handler steals the foreground BACK to the overlay if a window of THIS
/// process (main webview / a pane) grabbed it during the handoff settle
/// window — Chromium's async click-focus in the main webview landed ~16-50ms
/// AFTER SetForegroundWindow(overlay) and killed the popup input's caret
/// (git dropdown "Search branches" steal, hardware-traced 2026-07-24).
/// Cross-process foreground changes (alt-tab) are never fought.
#[cfg(target_os = "windows")]
static FOCUS_RETRIES: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);
#[cfg(target_os = "windows")]
const FOCUS_RETRY_TIMER: usize = 0x4F52; // "OR" — Overlay foreground Re-assert
#[cfg(target_os = "windows")]
const FOCUS_RETRY_INTERVAL_MS: u32 = 60;
#[cfg(target_os = "windows")]
const FOCUS_RETRY_TICKS: i32 = 5; // ~300ms settle window

/// STRUCTURAL non-client kill for the overlay, same philosophy as the main
/// window's accent-border subclass: styles are a losing battle (tao rewrites
/// GWL_STYLE from its cached WindowFlags on show()/focus/etc., which is why the
/// one-shot strip in `apply_ex_styles` did NOT hold on hardware — the probe
/// showed WS_CAPTION|WS_SYSMENU back on the live window). A subclass is
/// persistent: WM_NCCALCSIZE hands the ENTIRE window rect to the client area,
/// so no matter which styles tao restores or which composition path is active
/// (DWM or the classic fallback a SetWindowRgn region forces), there is never
/// a non-client area to paint a caption into, and never an HTCAPTION strip to
/// pop the OS system menu from.
#[cfg(target_os = "windows")]
pub fn install_nc_guard(hwnd: isize) {
    use std::ffi::c_void;

    const WM_NCCALCSIZE: u32 = 0x0083;
    const WM_NCPAINT: u32 = 0x0085;
    const WM_NCACTIVATE: u32 = 0x0086;
    const WM_NCUAHDRAWCAPTION: u32 = 0x00AE;
    const WM_NCUAHDRAWFRAME: u32 = 0x00AF;
    const WM_NCRBUTTONDOWN: u32 = 0x00A4;
    const WM_NCRBUTTONUP: u32 = 0x00A5;
    const WM_CONTEXTMENU: u32 = 0x007B;
    const WM_NCDESTROY: u32 = 0x0082;
    const WM_ERASEBKGND: u32 = 0x0014;
    const WM_MOUSEACTIVATE: u32 = 0x0021;
    const MA_NOACTIVATE: isize = 3;
    const WM_TIMER: u32 = 0x0113;
    const SWP_FRAMECHANGED: u32 = 0x0020;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SUBCLASS_ID: usize = 0x4E43; // "NC"

    extern "system" {
        fn SetWindowSubclass(
            hwnd: *mut c_void,
            pfn_subclass: Option<
                unsafe extern "system" fn(*mut c_void, u32, usize, isize, usize, usize) -> isize,
            >,
            uid_subclass: usize,
            ref_data: usize,
        ) -> i32;
        fn RemoveWindowSubclass(
            hwnd: *mut c_void,
            pfn_subclass: Option<
                unsafe extern "system" fn(*mut c_void, u32, usize, isize, usize, usize) -> isize,
            >,
            uid_subclass: usize,
        ) -> i32;
        fn DefSubclassProc(hwnd: *mut c_void, msg: u32, wparam: usize, lparam: isize) -> isize;
        fn SetWindowPos(
            hwnd: *mut c_void,
            insert_after: *mut c_void,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
        fn KillTimer(hwnd: *mut c_void, id: usize) -> i32;
    }

    unsafe extern "system" fn nc_guard_proc(
        hwnd: *mut c_void,
        msg: u32,
        wparam: usize,
        lparam: isize,
        _uid: usize,
        _ref_data: usize,
    ) -> isize {
        match msg {
            // Client area == window rect. Returning 0 for both wparam cases
            // removes the NC area entirely — nothing can ever be drawn there.
            WM_NCCALCSIZE => 0,
            // No NC area should exist, but swallow every NC draw path anyway
            // (theme-engine UAH draws included) — belt and suspenders.
            WM_NCPAINT | WM_NCUAHDRAWCAPTION | WM_NCUAHDRAWFRAME => 0,
            // Claim "handled, keep looking active" without letting
            // DefWindowProc repaint a frame on activation changes.
            WM_NCACTIVATE => 1,
            // Never let a non-client right-click reach DefWindowProc (that is
            // the path that pops the OS system menu).
            WM_NCRBUTTONDOWN | WM_NCRBUTTONUP | WM_CONTEXTMENU => 0,
            // NEVER erase the background: region changes invalidate the host
            // window, and the default erase fills the WHOLE (now full-window)
            // region with the class brush for one frame before Chromium's next
            // present — the "entire app flashes when opening/closing a popup"
            // bug. Claim "erased" and let the transparent webview own every
            // pixel.
            WM_ERASEBKGND => 1,
            // Clicking a popup must NEVER move activation to the overlay:
            // WS_EX_NOACTIVATE alone doesn't stop the WebView2 CHILD from
            // stealing it, and the resulting deactivate/reactivate pair on
            // the MAIN window ran its WM_NCACTIVATE path on every backdrop
            // dismiss / item click (the flash race; same MA_NOACTIVATE
            // mechanic the wgpu pane windows use). Keyboard-needing popups
            // use the explicit overlay_set_focusable handoff instead.
            WM_MOUSEACTIVATE => MA_NOACTIVATE,
            // Focus-handoff settle guard: for ~300ms after set_focusable(true)
            // took the foreground, steal it back if OUR OWN process's main
            // window re-grabbed it (Chromium's async click-focus tail). See
            // FOCUS_RETRIES docs above.
            WM_TIMER if wparam == FOCUS_RETRY_TIMER => {
                use std::sync::atomic::Ordering;
                use windows::Win32::Foundation::HWND;
                use windows::Win32::UI::WindowsAndMessaging::{
                    GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
                };
                let left = FOCUS_RETRIES.fetch_sub(1, Ordering::SeqCst);
                if left <= 0 {
                    FOCUS_RETRIES.store(0, Ordering::SeqCst);
                    KillTimer(hwnd, FOCUS_RETRY_TIMER);
                    return 0;
                }
                let fg = GetForegroundWindow();
                if !fg.0.is_null() && fg.0 as isize != hwnd as isize {
                    let mut pid = 0u32;
                    let _ = GetWindowThreadProcessId(fg, Some(&mut pid));
                    if pid == std::process::id() {
                        let _ = SetForegroundWindow(HWND(hwnd as *mut _));
                    }
                }
                0
            }
            WM_NCDESTROY => {
                RemoveWindowSubclass(hwnd, Some(nc_guard_proc), SUBCLASS_ID);
                DefSubclassProc(hwnd, msg, wparam, lparam)
            }
            _ => DefSubclassProc(hwnd, msg, wparam, lparam),
        }
    }

    unsafe {
        let hwnd = hwnd as *mut c_void;
        if SetWindowSubclass(hwnd, Some(nc_guard_proc), SUBCLASS_ID, 0) != 0 {
            // Force an immediate WM_NCCALCSIZE pass so the NC area vanishes
            // now, not on the next incidental frame change.
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
    }
}

/// Focus handoff for text-input popups (pane search). The overlay is
/// WS_EX_NOACTIVATE so ordinary popups never steal focus — but an <input>
/// in the overlay can only receive keystrokes while the overlay window is
/// the foreground window. `focusable(true)` clears NOACTIVATE and brings the
/// overlay to the foreground; `focusable(false)` restores NOACTIVATE and
/// hands the foreground back to the main window (the caller then re-focuses
/// the pane HWND via the existing native_term_focus_keyboard path).
#[cfg(target_os = "windows")]
pub fn set_focusable(overlay_hwnd: isize, main_hwnd: isize, focusable: bool) {
    use std::sync::atomic::Ordering;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowLongPtrW, KillTimer, SetForegroundWindow,
        SetTimer, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE,
    };
    unsafe {
        let overlay = HWND(overlay_hwnd as *mut _);
        let ex = GetWindowLongPtrW(overlay, GWL_EXSTYLE);
        if focusable {
            SetWindowLongPtrW(overlay, GWL_EXSTYLE, ex & !(WS_EX_NOACTIVATE.0 as isize));
            // The overlay is hidden while no popup is open (see set_shown);
            // SetForegroundWindow needs a visible window. The popup's region
            // call shows it in the same commit, but ordering across the two
            // invokes isn't guaranteed — make shown-ness explicit here.
            set_shown(overlay_hwnd, true);
            let _ = SetForegroundWindow(overlay);
            // Settle guard: the opening click's async focus tail in the MAIN
            // webview can re-grab the foreground ~16-50ms from now and kill
            // the popup input's caret. Arm the NC-guard's re-assert timer
            // (see FOCUS_RETRIES) to steal it back for ~300ms.
            FOCUS_RETRIES.store(FOCUS_RETRY_TICKS, Ordering::SeqCst);
            let _ = SetTimer(overlay, FOCUS_RETRY_TIMER, FOCUS_RETRY_INTERVAL_MS, None);
        } else {
            FOCUS_RETRIES.store(0, Ordering::SeqCst);
            let _ = KillTimer(overlay, FOCUS_RETRY_TIMER);
            SetWindowLongPtrW(overlay, GWL_EXSTYLE, ex | (WS_EX_NOACTIVATE.0 as isize));
            // Only hand the foreground to main if WE still hold it — if the
            // user alt-tabbed away while the popup was open, yanking focus
            // from their current app would be hostile focus theft.
            if GetForegroundWindow() == overlay {
                let _ = SetForegroundWindow(HWND(main_hwnd as *mut _));
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn set_focusable(_overlay_hwnd: isize, _main_hwnd: isize, _focusable: bool) {}

/// Remove the window region entirely (backdrop popups). With NO region the
/// window is composed by DWM — the classic-NC fallback that a region forces
/// can never run — and the whole overlay is hit-testable, which is exactly
/// what a backdrop popup wants (it must catch the outside click that
/// dismisses it). Transparency + real drop shadows render on this path.
/// MUST only be called while the overlay is HIDDEN — see `set_shown`.
#[cfg(target_os = "windows")]
pub fn clear_region(hwnd: isize) -> Result<(), String> {
    use windows::Win32::Foundation::{BOOL, HWND};
    use windows::Win32::Graphics::Gdi::{SetWindowRgn, HRGN};
    unsafe {
        if SetWindowRgn(HWND(hwnd as *mut _), HRGN::default(), BOOL(0)) == 0 {
            return Err("SetWindowRgn (clear) failed".to_string());
        }
    }
    Ok(())
}

// --- Non-Windows stubs (keep macOS/Linux CI compiling) -------------------

#[cfg(not(target_os = "windows"))]
pub fn apply_ex_styles(_hwnd: isize) {}

#[cfg(not(target_os = "windows"))]
#[allow(dead_code)]
pub fn clear_region(_hwnd: isize) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[allow(dead_code)]
pub fn set_shown(_hwnd: isize, _shown: bool) {}

#[cfg(not(target_os = "windows"))]
#[allow(dead_code)]
pub fn is_shown(_hwnd: isize) -> bool {
    false
}

#[cfg(not(target_os = "windows"))]
pub fn install_nc_guard(_hwnd: isize) {}

#[cfg(not(target_os = "windows"))]
pub fn set_owner(_overlay_hwnd: isize, _owner_hwnd: isize) {}

#[cfg(not(target_os = "windows"))]
pub fn sync_geometry(_main_hwnd: isize, _overlay_hwnd: isize) {}

#[cfg(not(target_os = "windows"))]
pub fn set_region(_hwnd: isize, _rects_px: &[(i32, i32, i32, i32, i32)]) -> Result<(), String> {
    Ok(())
}
