use serde::Deserialize;

#[derive(Deserialize, Debug, Clone, Copy)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// `CreateOpts` payload from `native_term_create`. Mirrors the JS-side
/// `CreateOpts` locked with workstream J.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CreateOpts {
    pub rect: Rect,
    pub dpr: f32,
    pub theme: TerminalTheme,
    pub font: FontSpec,
    pub cursor_style: String,    // "bar" | "block" | "underline"
    pub cursor_blink: bool,
    pub scrollback: u32,
}

/// xterm.js-compatible theme. 16 ANSI + cursor/selection/bg/fg colors.
#[derive(Deserialize, Debug, Clone)]
pub struct TerminalTheme {
    pub background: String,
    pub foreground: String,
    pub cursor: String,
    #[serde(rename = "cursorAccent")]
    pub cursor_accent: String,
    pub selection: String,
    pub ansi0: String,
    pub ansi1: String,
    pub ansi2: String,
    pub ansi3: String,
    pub ansi4: String,
    pub ansi5: String,
    pub ansi6: String,
    pub ansi7: String,
    pub ansi8: String,
    pub ansi9: String,
    pub ansi10: String,
    pub ansi11: String,
    pub ansi12: String,
    pub ansi13: String,
    pub ansi14: String,
    pub ansi15: String,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FontSpec {
    pub family: String,
    pub size_px: f32,
}

pub trait NativeTermWindow: Send {
    fn resize(&mut self, rect: Rect, dpr: f32) -> Result<(), String>;
    fn show(&mut self) -> Result<(), String>;
    fn hide(&mut self) -> Result<(), String>;
    fn set_region(&mut self, holes: &[Rect], dpr: f32) -> Result<(), String>;
    fn destroy(self: Box<Self>) -> Result<(), String>;

    /// Wire a PTY into the parser bridge. Creates the crossbeam channel via
    /// `pty_route::create_channel`, spawns a `ParserBridge`, registers the
    /// pty→term link, and hands the bridge's Term Arc to the renderer.
    fn attach_pty(&mut self, term_id: u32, pty_id: u32, cols: usize, rows: usize) -> Result<(), String>;

    /// Tear down the parser bridge and detach from the renderer.
    fn detach_pty(&mut self) -> Result<(), String>;

    /// Compute (cols, rows) from the current pane pixel dimensions and font
    /// metrics. Honors the `cols < 20` narrow guard by capping (does NOT Err).
    fn propose_dimensions(&self, width_px: u32, height_px: u32) -> (u32, u32);

    // R1.d hot-swap stubs — implemented but treat as no-ops for R1.c.
    fn set_theme(&mut self, theme: &TerminalTheme) -> Result<(), String>;
    fn set_font(&mut self, family: &str, size_px: f32) -> Result<(), String>;
    fn set_cursor_style(&mut self, style: &str, blink: bool) -> Result<(), String>;
}

#[cfg(target_os = "windows")]
mod win32;
#[cfg(target_os = "windows")]
pub use win32::PlatformWindow;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::PlatformWindow;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::PlatformWindow;
