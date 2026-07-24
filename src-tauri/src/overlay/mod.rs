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

/// The region tuples last applied via SetWindowRgn, or None while the window
/// is REGIONLESS (never regioned, or cleared for backdrop mode). Lets the
/// command skip identical re-applies (the ~750ms popup keepalives re-emit the
/// same rects) and know whether a clear is needed before backdrop mode.
#[cfg(target_os = "windows")]
static LAST_REGION: std::sync::Mutex<Option<Vec<(i32, i32, i32, i32, i32)>>> =
    std::sync::Mutex::new(None);

/// Drive the overlay's visibility + click-through for the currently-open
/// popups. THE hard rule (hardware-captured 2026-07-24): `SetWindowRgn` on a
/// VISIBLE window invalidates every window beneath the changed area, and the
/// main window + its WebView2/wgpu children then race the next DWM frame to
/// re-present — losing the race showed the whole app as bare #0d1117 for 1-2
/// frames (the menu open/close flicker, ~30% of transitions). So popup
/// open/close is expressed as SHOW/HIDE of the whole overlay window (a pure
/// DWM composition op that invalidates nothing beneath), and every region
/// change happens while the window is HIDDEN.
///
/// Modes:
/// - `backdrop: true` (dismiss-on-outside-click menus): REGIONLESS + shown.
///   Regionless = DWM-composed (no classic-NC fallback, real shadows) and
///   fully hit-testable, which a backdrop popup needs anyway (it must catch
///   the outside click). `rects` is ignored in this mode.
/// - non-empty `rects` (ambient popups): clip to the union of popup rects
///   (rounded to each popup's CSS radius; logical->physical via the scale
///   factor) + shown. Inside a popup the overlay is hit-testable; elsewhere
///   clicks fall through to the panes.
/// - empty `rects`: hidden. No region op at all on the close path; a stale
///   region stays on the hidden window and is corrected before the next show.
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
        let mut last = LAST_REGION
            .lock()
            .map_err(|_| "LAST_REGION poisoned".to_string())?;

        if backdrop.unwrap_or(false) {
            if last.is_some() {
                // A tight region is installed (an ambient popup was open).
                // Hide -> clear -> show: the SetWindowRgn lands on a hidden
                // window, so nothing beneath gets invalidated.
                win32::set_shown(hwnd, false);
                win32::clear_region(hwnd)?;
                *last = None;
            }
            win32::set_shown(hwnd, true);
            return Ok(());
        }

        if rects.is_empty() {
            win32::set_shown(hwnd, false);
            return Ok(());
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

        if last.as_ref() != Some(&px) {
            // Regionless->tight while visible would be a live SetWindowRgn on
            // a fully-composed window — hide across the change instead.
            // Tight->tight while visible stays LIVE: anchored popups stream
            // their rect while a pane moves, and hide/show per update would
            // strobe the popup itself; a tight->tight change only invalidates
            // the small popup-rect areas.
            if last.is_none() && win32::is_shown(hwnd) {
                win32::set_shown(hwnd, false);
            }
            win32::set_region(hwnd, &px)?;
            *last = Some(px);
        }
        win32::set_shown(hwnd, true);
        Ok(())
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
