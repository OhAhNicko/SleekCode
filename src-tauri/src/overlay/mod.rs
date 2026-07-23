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
    /// Corner radius (logical px) for the rounded clip region. 0 = sharp.
    #[serde(default)]
    pub radius: f64,
}

/// Clip the overlay to the union of currently-open popup rects (rounded to each
/// popup's corner radius). Inside a popup the overlay is hit-testable so the
/// DOM gets the click; everywhere else the overlay is not part of the window and
/// the click falls through to the native pane. Empty vec => fully click-through.
/// Rects convert logical->physical via the overlay's scale factor (rounded to
/// the nearest physical px so the clip tracks the popup's opaque edge).
///
/// `backdrop: true` (dismiss-on-outside-click popups) REMOVES the region
/// instead: a regionless window is DWM-composed (no classic-NC fallback, real
/// shadows) and fully hit-testable — every click lands in the overlay, which
/// is what a backdrop popup needs. `rects` is ignored in that mode.
#[tauri::command]
pub fn overlay_set_region(
    app: tauri::AppHandle,
    rects: Vec<Rect>,
    backdrop: Option<bool>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;
        let overlay = app
            .get_webview_window("overlay")
            .ok_or_else(|| "overlay window not found".to_string())?;
        let hwnd = overlay.hwnd().map_err(|e| e.to_string())?.0 as isize;
        if backdrop.unwrap_or(false) {
            // Full-window REGION, not region-removal — see set_full_region's
            // note on the DWM/classic composition-flip flicker.
            return win32::set_full_region(hwnd);
        }
        let scale = overlay.scale_factor().map_err(|e| e.to_string())?;
        let px: Vec<(i32, i32, i32, i32, i32)> = rects
            .iter()
            .map(|r| {
                let diam = if r.radius > 0.0 {
                    ((r.radius * scale).round() as i32 * 2).max(2)
                } else {
                    0
                };
                (
                    (r.x * scale).round() as i32,
                    (r.y * scale).round() as i32,
                    ((r.x + r.width) * scale).round() as i32,
                    ((r.y + r.height) * scale).round() as i32,
                    diam,
                )
            })
            .collect();
        win32::set_region(hwnd, &px)
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Overlay window is Windows-only for now; no-op elsewhere.
        let _ = (app, rects, backdrop);
        Ok(())
    }
}

/// Focus handoff for text-input popups (pane search): while `focusable` the
/// overlay may take the foreground so its <input> receives keystrokes; off
/// restores WS_EX_NOACTIVATE and returns the foreground to the main window.
#[tauri::command]
pub fn overlay_set_focusable(app: tauri::AppHandle, focusable: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;
        let overlay = app
            .get_webview_window("overlay")
            .ok_or_else(|| "overlay window not found".to_string())?;
        let main = app
            .get_webview_window("main")
            .ok_or_else(|| "main window not found".to_string())?;
        let overlay_hwnd = overlay.hwnd().map_err(|e| e.to_string())?.0 as isize;
        let main_hwnd = main.hwnd().map_err(|e| e.to_string())?.0 as isize;
        win32::set_focusable(overlay_hwnd, main_hwnd, focusable);
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, focusable);
        Ok(())
    }
}
