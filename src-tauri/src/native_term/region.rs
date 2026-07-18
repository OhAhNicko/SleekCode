// Static-canvas clip region via Win32 SetWindowRgn. The child window is an
// oversized fixed canvas (sized to the parent client area at creation, grown
// only when a pane outgrows it); the VISIBLE pane is defined by the region:
// rect(0, 0, pane_w, pane_h) minus the overlay hole rects. Win32 regions clip
// BOTH painting and hit-testing, so everything outside the pane (the spare
// canvas) is invisible AND input-inert — clicks there fall through to the
// WebView2 sibling below. This is what lets splitter drags be pure window
// MOVEs + region updates with zero surface reconfigures (the drag-jitter
// rework: DWM never composits an old-size buffer into a new-size rect).
//
// Each hole rect (pane-local logical px) is scaled by DPR, expanded by 1
// physical pixel per side to swallow subpixel rendering on overlay edges
// (risk #5 — SetWindowRgn has no per-pixel alpha), then subtracted from the
// pane rect via CombineRgn(RGN_DIFF).
//
// Non-Windows: not implemented (Phase 4).

use super::window::Rect;

#[cfg(target_os = "windows")]
pub fn apply_region(hwnd: isize, pane_size_px: (i32, i32), holes: &[Rect], dpr: f32) -> Result<(), String> {
    use windows::Win32::Foundation::{BOOL, HWND};
    use windows::Win32::Graphics::Gdi::{
        CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, RGN_DIFF,
    };

    let hwnd = HWND(hwnd as *mut _);
    let (w_px, h_px) = pane_size_px;

    unsafe {
        // Base region = the PANE rect, not the window client rect — the
        // canvas is deliberately larger than the pane. Applied even with
        // ZERO holes: in the static-canvas model the pane region IS what
        // sizes the visible pane, so the old "no holes → NULL region"
        // shortcut would un-clip the whole oversized canvas and paint /
        // hit-test across the entire parent.
        let full = CreateRectRgn(0, 0, w_px, h_px);
        if full.is_invalid() {
            return Err("CreateRectRgn (full) failed".to_string());
        }

        for hole in holes {
            // Convert logical CSS px → physical px, then expand by 1 px per side.
            // floor() the top-left and ceil() the bottom-right BEFORE expansion
            // to guarantee we never undercut the overlay's intended footprint.
            let l = ((hole.x * dpr).floor() as i32) - 1;
            let t = ((hole.y * dpr).floor() as i32) - 1;
            let r = (((hole.x + hole.width) * dpr).ceil() as i32) + 1;
            let b = (((hole.y + hole.height) * dpr).ceil() as i32) + 1;

            let hole_rgn = CreateRectRgn(l, t, r, b);
            if hole_rgn.is_invalid() {
                let _ = DeleteObject(full);
                return Err("CreateRectRgn (hole) failed".to_string());
            }
            // RGN_DIFF: full = full - hole_rgn
            let res = CombineRgn(full, full, hole_rgn, RGN_DIFF);
            let _ = DeleteObject(hole_rgn);
            if res.0 == 0 {
                let _ = DeleteObject(full);
                return Err("CombineRgn failed".to_string());
            }
        }

        // SetWindowRgn takes ownership of the HRGN — do NOT DeleteObject it
        // after the call. Per MSDN: "After a successful call to SetWindowRgn,
        // the system owns the region specified by the region handle hRgn."
        if SetWindowRgn(hwnd, full, BOOL(1)) == 0 {
            // On failure ownership is NOT transferred — free the region.
            let _ = DeleteObject(full);
            return Err("SetWindowRgn failed".to_string());
        }
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn apply_region(_hwnd: isize, _pane_size_px: (i32, i32), _holes: &[Rect], _dpr: f32) -> Result<(), String> {
    Err("native_term::region: not implemented on this platform".to_string())
}
