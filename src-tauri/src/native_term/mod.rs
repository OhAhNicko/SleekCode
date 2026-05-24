// R1.c: native-terminal production command surface.
//
// Replaces the Phase-0 `native_term_spike_*` set with the 12-command
// production interface locked between workstreams R/J/O. The JS bridge
// (`src/lib/native-term-bridge.ts`) wires these 1:1.
//
// Frame conventions (locked Phase 0):
//   - create/resize rect: WINDOW-CLIENT coords (raw getBoundingClientRect()).
//   - set_region holes:   PANE-LOCAL coords (overlay.x - pane.x, etc).
//   - dpr: window.devicePixelRatio at the call site.

pub mod events;
pub mod parser_bridge;
pub mod pty_route;
pub mod registry;
pub mod region;
pub mod renderer;
pub mod window;

use serde::Serialize;
use window::{CreateOpts, NativeTermWindow, PlatformWindow, Rect, TerminalTheme};

#[derive(Serialize, Debug, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct ProposedDimensions {
    pub cols: u32,
    pub rows: u32,
}

#[tauri::command]
pub fn native_term_create(opts: CreateOpts) -> Result<u32, String> {
    let parent = registry::parent_hwnd()
        .ok_or_else(|| "native_term: parent HWND not captured yet".to_string())?;
    // R1.c keeps PlatformWindow::new minimal (rect+dpr only). theme/font/cursor
    // are no-op stubs in win32 set_theme/set_font/set_cursor_style — R1.d wires
    // them into the renderer. Apply them now so the values are recorded for
    // the eventual hot-swap call sites.
    let mut win = PlatformWindow::new(parent, opts.rect, opts.dpr)?;
    let _ = win.set_theme(&opts.theme);
    let _ = win.set_font(&opts.font.family, opts.font.size_px);
    let _ = win.set_cursor_style(&opts.cursor_style, opts.cursor_blink);
    let id = registry::alloc_id();
    registry::insert(id, Box::new(win));
    Ok(id)
}

#[tauri::command]
pub fn native_term_destroy(id: u32) -> Result<(), String> {
    match registry::take(id) {
        Some(w) => w.destroy(),
        None => Err(format!("native_term: id {id} not found")),
    }
}

#[tauri::command]
pub fn native_term_show(id: u32) -> Result<(), String> {
    registry::with_window(id, |w| w.show())
}

#[tauri::command]
pub fn native_term_hide(id: u32) -> Result<(), String> {
    registry::with_window(id, |w| w.hide())
}

#[tauri::command]
pub fn native_term_resize(id: u32, rect: Rect, dpr: f32) -> Result<(), String> {
    registry::with_window(id, |w| w.resize(rect, dpr))
}

#[tauri::command]
pub fn native_term_set_region(id: u32, holes: Vec<Rect>) -> Result<(), String> {
    // DPR omitted from wire format (locked with O); win32 reads cached last_dpr.
    registry::with_window(id, |w| w.set_region(&holes, 0.0))
}

#[tauri::command]
pub fn native_term_attach_pty(
    id: u32,
    pty_id: u32,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    registry::with_window(id, |w| {
        w.attach_pty(id, pty_id, cols as usize, rows as usize)
    })
}

#[tauri::command]
pub fn native_term_detach_pty(id: u32) -> Result<(), String> {
    registry::with_window(id, |w| w.detach_pty())
}

#[tauri::command]
pub fn native_term_propose_dimensions(
    id: u32,
    width_px: u32,
    height_px: u32,
) -> Result<ProposedDimensions, String> {
    // The trait's propose_dimensions is &self (read-only); we can't use
    // with_window which gives &mut. Snapshot the lookup ourselves.
    let mut out = ProposedDimensions { cols: 20, rows: 1 };
    registry::with_window(id, |w| {
        let (cols, rows) = w.propose_dimensions(width_px, height_px);
        out = ProposedDimensions { cols, rows };
        Ok(())
    })?;
    Ok(out)
}

#[tauri::command]
pub fn native_term_set_theme(id: u32, theme: TerminalTheme) -> Result<(), String> {
    registry::with_window(id, |w| w.set_theme(&theme))
}

#[tauri::command]
pub fn native_term_set_font(
    id: u32,
    family: String,
    size_px: f32,
) -> Result<(), String> {
    registry::with_window(id, |w| w.set_font(&family, size_px))
}

#[tauri::command]
pub fn native_term_set_cursor_style(
    id: u32,
    style: String,
    blink: bool,
) -> Result<(), String> {
    registry::with_window(id, |w| w.set_cursor_style(&style, blink))
}

/// Debug-only: inject raw bytes directly into the parser bridge channel for
/// `id`, bypassing the PTY. Used by the `#native-spike` page to verify SGR
/// color rendering without depending on shell behavior (cmd.exe is monochrome
/// by default; PSReadLine may not be loaded). Bytes must contain valid VT
/// sequences for anything visible; the worker thread advances them through
/// alacritty's parser identically to PTY-sourced bytes.
#[tauri::command]
pub fn native_term_debug_inject_bytes(id: u32, bytes: Vec<u8>) -> Result<(), String> {
    let tx = pty_route::sender_for_term(id)
        .ok_or_else(|| format!("native_term: id {id} has no attached parser bridge"))?;
    tx.try_send(bytes)
        .map_err(|e| format!("inject_bytes try_send: {e}"))
}

// --- Phase 0 spike command aliases (kept for the `#native-spike` debug
// route and `TerminalPaneNative.tsx`'s current `invoke("native_term_spike_*")`
// call sites). Each just delegates to the production handler with default
// CreateOpts for theme/font/cursor — those are no-op stubs in R1.c anyway.
// J will flip JS to the production wrappers in a follow-up; until then these
// keep the debug route alive. Delete after the JS flip lands.

#[tauri::command]
pub fn native_term_spike_create(rect: Rect, dpr: f32) -> Result<u32, String> {
    let parent = registry::parent_hwnd()
        .ok_or_else(|| "native_term: parent HWND not captured yet".to_string())?;
    let win = PlatformWindow::new(parent, rect, dpr)?;
    let id = registry::alloc_id();
    registry::insert(id, Box::new(win));
    Ok(id)
}

#[tauri::command]
pub fn native_term_spike_resize(id: u32, rect: Rect, dpr: f32) -> Result<(), String> {
    native_term_resize(id, rect, dpr)
}

#[tauri::command]
pub fn native_term_spike_destroy(id: u32) -> Result<(), String> {
    native_term_destroy(id)
}

#[tauri::command]
pub fn native_term_spike_show(id: u32) -> Result<(), String> {
    native_term_show(id)
}

#[tauri::command]
pub fn native_term_spike_hide(id: u32) -> Result<(), String> {
    native_term_hide(id)
}

#[tauri::command]
pub fn native_term_spike_set_region(id: u32, holes: Vec<Rect>) -> Result<(), String> {
    native_term_set_region(id, holes)
}
