//! Phase 0 overlay-webview prototype.
//!
//! A transparent, owned, always-above second WebView2 into which floating
//! popups render as real DOM. The window itself is created in `lib.rs` setup
//! (`WebviewWindowBuilder::new(..).parent(&main)` — owner on Windows, so it
//! sits above the owner's child HWNDs, i.e. the native-term wgpu panes, per
//! MSDN owned-window rules). This module owns the Win32 glue + the one command
//! the overlay webview calls to drive click-through.
//!
//! Kept fully decoupled from `native_term`: it never touches pane z-order,
//! geometry, the wgpu renderer, or the main-window border subclass.

pub mod win32;

use serde::Deserialize;

/// A popup rect in LOGICAL CSS px, overlay-local. Because the overlay covers
/// the main window's client area, overlay-local == main-client-local == the
/// same viewport coordinates a popup's `getBoundingClientRect()` returns in the
/// main webview.
#[derive(Debug, Clone, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Set the overlay's paint/hit-test region to the UNION of `rects`. Empty vec
/// => empty region => the overlay is fully click-through (all clicks reach the
/// native panes below). Rects are converted logical->physical using the
/// overlay's scale factor (== the main window's monitor scale), with `floor` on
/// the top-left and `ceil` on the bottom-right so the region never undercuts a
/// popup's footprint — the same convention as `native_term::region`.
#[tauri::command]
pub fn overlay_set_region(app: tauri::AppHandle, rects: Vec<Rect>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;
        let overlay = app
            .get_webview_window("overlay")
            .ok_or_else(|| "overlay window not found".to_string())?;
        let hwnd = overlay.hwnd().map_err(|e| e.to_string())?.0 as isize;
        let scale = overlay.scale_factor().map_err(|e| e.to_string())?;
        let px: Vec<(i32, i32, i32, i32)> = rects
            .iter()
            .map(|r| {
                (
                    (r.x * scale).floor() as i32,
                    (r.y * scale).floor() as i32,
                    ((r.x + r.width) * scale).ceil() as i32,
                    ((r.y + r.height) * scale).ceil() as i32,
                )
            })
            .collect();
        win32::set_region(hwnd, &px)
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Overlay window is Windows-only for now; no-op elsewhere.
        let _ = (app, rects);
        Ok(())
    }
}
