//! Win32 glue for the overlay window: ex-styles, click-through region, and
//! geometry sync to the main window's client area. All real code is
//! `#[cfg(target_os = "windows")]`; non-Windows builds get inert stubs so the
//! macOS/Linux CI builds still compile (same convention as
//! `native_term::region`).
//!
//! This module is deliberately decoupled from `native_term` — it never touches
//! pane z-order, geometry, or the wgpu renderer. The click-through primitive is
//! the SAME `SetWindowRgn` that `native_term::region` uses, but here the region
//! is the UNION of currently-open popup rects (empty region => fully
//! click-through) instead of pane-rect-minus-holes.

/// OR `WS_EX_NOACTIVATE` into the overlay's extended style so clicking a popup
/// never steals foreground/keyboard focus from the main React UI (mirrors the
/// native-term focus model). `SetWindowRgn` alone provides click-through;
/// `WS_EX_TRANSPARENT` / `WS_EX_LAYERED` are intentionally NOT used (we want
/// SELECTIVE click-through driven by the region, not whole-window).
#[cfg(target_os = "windows")]
pub fn apply_ex_styles(hwnd: isize) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE,
    };
    unsafe {
        let hwnd = HWND(hwnd as *mut _);
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | (WS_EX_NOACTIVATE.0 as isize));
    }
}

/// Set the overlay window region to the UNION of `rects_px` (PHYSICAL px).
/// Win32 regions clip BOTH painting and hit-testing, so where the region is
/// empty the overlay is invisible AND input-inert — clicks there fall through
/// to the native panes below. Empty slice => empty region => fully
/// click-through everywhere.
#[cfg(target_os = "windows")]
pub fn set_region(hwnd: isize, rects_px: &[(i32, i32, i32, i32)]) -> Result<(), String> {
    use windows::Win32::Foundation::{BOOL, HWND};
    use windows::Win32::Graphics::Gdi::{
        CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, RGN_OR,
    };
    unsafe {
        let hwnd = HWND(hwnd as *mut _);
        // Empty base region; union each popup rect in with RGN_OR.
        let rgn = CreateRectRgn(0, 0, 0, 0);
        if rgn.is_invalid() {
            return Err("CreateRectRgn (base) failed".to_string());
        }
        for &(l, t, r, b) in rects_px {
            let piece = CreateRectRgn(l, t, r, b);
            if piece.is_invalid() {
                let _ = DeleteObject(rgn);
                return Err("CreateRectRgn (piece) failed".to_string());
            }
            // rgn = rgn ∪ piece
            let res = CombineRgn(rgn, rgn, piece, RGN_OR);
            let _ = DeleteObject(piece);
            if res.0 == 0 {
                let _ = DeleteObject(rgn);
                return Err("CombineRgn failed".to_string());
            }
        }
        // SetWindowRgn takes ownership of the HRGN on success — do NOT free it
        // after. On failure ownership is NOT transferred, so free it then.
        if SetWindowRgn(hwnd, rgn, BOOL(1)) == 0 {
            let _ = DeleteObject(rgn);
            return Err("SetWindowRgn failed".to_string());
        }
    }
    Ok(())
}

/// Position/size the overlay to cover the MAIN window's CLIENT area, in screen
/// coordinates (the overlay is a separate top-level owned window, so it lives
/// in desktop space). Called on create and on every main-window
/// move / resize / maximize / DPI change. Using the client rect (not the outer
/// rect) is correct even though main is `decorations:false` — it robustly
/// excludes any residual NC/DWM area.
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
        // SWP_NOZORDER preserves owned-above-owner z-order; SWP_NOACTIVATE keeps
        // input focus on the React UI.
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

// --- Non-Windows stubs (keep macOS/Linux CI compiling) -------------------

#[cfg(not(target_os = "windows"))]
pub fn apply_ex_styles(_hwnd: isize) {}

#[cfg(not(target_os = "windows"))]
pub fn set_region(_hwnd: isize, _rects_px: &[(i32, i32, i32, i32)]) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn sync_geometry(_main_hwnd: isize, _overlay_hwnd: isize) {}
