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
        // SetWindowRgn takes ownership of the HRGN on success.
        if SetWindowRgn(hwnd, rgn, BOOL(1)) == 0 {
            let _ = DeleteObject(rgn);
            return Err("SetWindowRgn failed".to_string());
        }
    }
    Ok(())
}

/// Remove the window region entirely (backdrop popups). With NO region the
/// window is composed by DWM again — the classic-NC fallback that a region
/// forces can never run — and the whole overlay is hit-testable, which is
/// exactly what a backdrop popup wants (it must catch the outside click that
/// dismisses it). Transparency + real drop shadows render on this path.
#[cfg(target_os = "windows")]
pub fn clear_region(hwnd: isize) -> Result<(), String> {
    use windows::Win32::Foundation::{BOOL, HWND};
    use windows::Win32::Graphics::Gdi::{SetWindowRgn, HRGN};
    unsafe {
        if SetWindowRgn(HWND(hwnd as *mut _), HRGN::default(), BOOL(1)) == 0 {
            return Err("SetWindowRgn (clear) failed".to_string());
        }
    }
    Ok(())
}

// --- Non-Windows stubs (keep macOS/Linux CI compiling) -------------------

#[cfg(not(target_os = "windows"))]
pub fn apply_ex_styles(_hwnd: isize) {}

#[cfg(not(target_os = "windows"))]
pub fn clear_region(_hwnd: isize) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn set_owner(_overlay_hwnd: isize, _owner_hwnd: isize) {}

#[cfg(not(target_os = "windows"))]
pub fn sync_geometry(_main_hwnd: isize, _overlay_hwnd: isize) {}

#[cfg(not(target_os = "windows"))]
pub fn set_region(_hwnd: isize, _rects_px: &[(i32, i32, i32, i32, i32)]) -> Result<(), String> {
    Ok(())
}
