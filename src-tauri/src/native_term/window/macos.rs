// Phase 0: macOS native-terminal child-view stub.
// Real NSView/Metal implementation arrives in Phase 4 (per the migration plan).
// This stub exists so `npm run tauri:build` compiles cleanly on macOS CI
// even though the Phase-0 spike only exercises the Win32 path.

use super::{NativeTermWindow, Rect, TerminalTheme};

pub struct PlatformWindow;

impl PlatformWindow {
    pub fn new(_parent_hwnd: isize, _rect: Rect, _dpr: f32) -> Result<Self, String> {
        Err("native_term: macOS support not implemented (Phase 4)".to_string())
    }

    /// O2-B no-op stub for parity with the Win32 implementation.
    pub fn set_app_handle(&mut self, _app: tauri::AppHandle) {}

    /// O2-B no-op stub for parity with the Win32 implementation.
    pub fn set_term_id(&mut self, _id: u32) {}
}

impl NativeTermWindow for PlatformWindow {
    fn resize(&mut self, _rect: Rect, _dpr: f32) -> Result<(), String> {
        Err("native_term: macOS not implemented".to_string())
    }
    fn show(&mut self) -> Result<(), String> {
        Err("native_term: macOS not implemented".to_string())
    }
    fn hide(&mut self) -> Result<(), String> {
        Err("native_term: macOS not implemented".to_string())
    }
    fn set_region(&mut self, _holes: &[Rect], _dpr: f32) -> Result<(), String> {
        Err("native_term: macOS not implemented".to_string())
    }
    fn destroy(self: Box<Self>) -> Result<(), String> {
        Ok(())
    }
    fn attach_pty(&mut self, _term_id: u32, _pty_id: u32, _cols: usize, _rows: usize) -> Result<(), String> {
        Err("native_term: macOS not implemented".to_string())
    }
    fn detach_pty(&mut self) -> Result<(), String> {
        Err("native_term: macOS not implemented".to_string())
    }
    fn propose_dimensions(&self, _width_px: u32, _height_px: u32) -> (u32, u32) {
        (20, 1)
    }
    fn set_theme(&mut self, _theme: &TerminalTheme) -> Result<(), String> {
        Err("native_term: macOS not implemented".to_string())
    }
    fn set_font(&mut self, _family: &str, _size_px: f32) -> Result<(), String> {
        Err("native_term: macOS not implemented".to_string())
    }
    fn set_cursor_style(&mut self, _style: &str, _blink: bool) -> Result<(), String> {
        Err("native_term: macOS not implemented".to_string())
    }
}
