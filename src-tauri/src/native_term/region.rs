// Hole-cutting via Win32 SetWindowRgn. Each hole rect (pane-local logical px)
// is scaled by DPR, expanded by 1 physical pixel per side to swallow subpixel
// rendering on overlay edges (risk #5 — SetWindowRgn has no per-pixel alpha),
// then subtracted from the full child-window rect via CombineRgn(RGN_DIFF).
//
// Non-Windows: not implemented (Phase 4).

use super::window::Rect;

#[cfg(target_os = "windows")]
pub fn apply_region(hwnd: isize, child_size_px: (i32, i32), holes: &[Rect], dpr: f32) -> Result<(), String> {
    use windows::Win32::Foundation::{BOOL, HWND};
    use windows::Win32::Graphics::Gdi::{
        CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, HRGN, RGN_DIFF,
    };

    let hwnd = HWND(hwnd as *mut _);

    if holes.is_empty() {
        // Canonical "no region" path — restores full-opaque rendering.
        // Pass NULL HRGN; Windows takes ownership semantics don't apply when null.
        unsafe {
            let _ = SetWindowRgn(hwnd, HRGN(std::ptr::null_mut()), BOOL(1));
        }
        return Ok(());
    }

    let (w_px, h_px) = child_size_px;

    unsafe {
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
pub fn apply_region(_hwnd: isize, _child_size_px: (i32, i32), _holes: &[Rect], _dpr: f32) -> Result<(), String> {
    Err("native_term::region: not implemented on this platform".to_string())
}
