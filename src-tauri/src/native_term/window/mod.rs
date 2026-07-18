use serde::{Deserialize, Serialize};

use std::sync::{Arc, Mutex};

use alacritty_terminal::term::Term;

use super::parser_bridge::TermListener;

#[derive(Deserialize, Serialize, Debug, Clone, Copy)]
#[serde(rename_all = "camelCase")]
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
    /// P2a: initial keyboard-focus state. `serde(default)` (false) for wire
    /// robustness against callers that omit it; the JS focus effect
    /// re-asserts the live value via `native_term_set_focused` on any change.
    #[serde(default)]
    pub focused: bool,
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

/// P0 perf-instrumentation snapshot returned by `native_term_debug_stats`.
/// Counter semantics live in `renderer/pipeline.rs` (plain measurement
/// fields); geometry/state fields mirror the platform window's cached state.
/// `Default` keeps the macOS/Linux stubs compiling untouched — their trait
/// impls inherit the zeroed default `debug_stats()` body below.
#[derive(Serialize, Debug, Clone, Copy, Default)]
#[serde(rename_all = "camelCase")]
pub struct DebugStats {
    pub frames_rendered: u64,
    pub frames_skipped_clean: u64,
    pub last_frame_cpu_ms: f32,
    pub frame_cpu_ms_ewma: f32,
    pub configures: u64,
    pub wakes_posted: u64,
    pub wakes_coalesced: u64,
    pub attached: bool,
    pub visible: bool,
    pub cell_w_px: f32,
    pub cell_h_px: f32,
    pub dpr: f32,
    pub surface_w: u32,
    pub surface_h: u32,
    /// Static-canvas: the VISIBLE pane size in physical px (`pane_px`).
    /// `surface_w`/`surface_h` report the oversized fixed canvas the wgpu
    /// surface actually spans; these report what the user sees.
    pub pane_w: u32,
    pub pane_h: u32,
}

pub trait NativeTermWindow: Send {
    fn resize(&mut self, rect: Rect, dpr: f32) -> Result<(), String>;

    /// P4a/D3: deferred-move variant of `resize` for the batched
    /// `native_term_frame_sync` command. `batch` is an opaque platform
    /// move-batch handle from `begin_move_batch` (Win32: an HDWP; 0 = no
    /// active batch). Contract: perform the same pre-move bookkeeping as
    /// `resize`, then either defer the window move into the batch and
    /// return the updated handle, or — when `batch` is 0 or deferring
    /// fails — apply the move immediately and return 0 so the caller's
    /// remaining entries flip to the immediate path. On Err the caller
    /// must treat the passed-in handle as DEAD (Win32: the impl only errs
    /// when its immediate fallback failed after a DeferWindowPos failure
    /// already invalidated the HDWP) — never commit or reuse it after an
    /// Err. Surface reconfigure +
    /// repaint happen in the platform size handler when the move actually
    /// lands (EndDeferWindowPos → WM_SIZE on Win32). Default: plain
    /// `resize` with the batch handle passed through untouched — the
    /// macOS/Linux stubs have no move batching.
    fn resize_deferred(&mut self, rect: Rect, dpr: f32, batch: isize) -> Result<isize, String> {
        self.resize(rect, dpr)?;
        Ok(batch)
    }

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

    /// Per-cell metrics `(cell_w, cell_h)` in PHYSICAL surface pixels —
    /// single source of truth is the renderer's measured glyph advance +
    /// line height (`Renderer::cell_metrics`). P5a: the font is rasterized
    /// at logical × dpr with an advance-quantized (integer) cell width, so
    /// these are true physical values, NOT logical CSS px. Default returns
    /// the Hack-14px dpr-1.0 baseline so the macOS/Linux stubs compile
    /// untouched — Win32 overrides with the live ChildState mirrors.
    fn cell_metrics(&self) -> (f32, f32) {
        (8.4, 17.0)
    }

    // R1.d hot-swap stubs — implemented but treat as no-ops for R1.c.
    fn set_theme(&mut self, theme: &TerminalTheme) -> Result<(), String>;
    fn set_font(&mut self, family: &str, size_px: f32) -> Result<(), String>;
    fn set_cursor_style(&mut self, style: &str, blink: bool) -> Result<(), String>;

    /// P2a focus flag: only the focused pane blinks its cursor (respecting
    /// the cursor_blink setting); unfocused panes render a static hollow
    /// outline cursor. Default no-op keeps the macOS/Linux stubs compiling —
    /// Win32 overrides with the blink-timer + renderer wiring.
    fn set_focused(&mut self, _focused: bool) -> Result<(), String> {
        Ok(())
    }

    /// N-b copy-on-select: mirror the JS `copyOnSelect` store flag. When true,
    /// a finalized text selection auto-copies to the clipboard on mouse-up
    /// (legacy default false — selection still emits, but does not copy).
    /// Explicit copy paths are unaffected. Default no-op keeps the macOS/Linux
    /// stubs compiling — Win32 overrides with the ChildState mirror.
    fn set_copy_on_select(&mut self, _on: bool) -> Result<(), String> {
        Ok(())
    }

    /// P7b: route platform KEYBOARD focus to this pane's native window —
    /// parity with the xterm pane calling `term.focus()` when it becomes the
    /// active pane. Distinct from `set_focused` (the JS-authoritative cursor
    /// VISUAL flag): this moves actual Win32 keyboard focus so WM_KEYDOWN /
    /// WM_CHAR arrive without an extra click. Win32 overrides by posting
    /// WM_APP_FOCUS to its own wnd_proc (SetFocus is only valid on the
    /// HWND's owning thread — a direct call from a command context is
    /// unreliable). Default no-op keeps the macOS/Linux stubs compiling.
    fn focus_keyboard(&mut self) -> Result<(), String> {
        Ok(())
    }

    /// Phase 3 search-highlight overlay. Replace the pane's current set of
    /// highlight rects (coord space: pane-local pixels matching the
    /// `native_term_search` result). Pass an empty slice — or call
    /// `clear_search_highlights` — to remove all highlights. Default impl
    /// is a no-op so non-Windows platform stubs compile.
    fn set_search_highlights(&mut self, _rects: Vec<Rect>) -> Result<(), String> {
        Ok(())
    }

    /// Clear the pane's search-highlight overlay. Called by
    /// `native_term_search_clear` so JS doesn't need to send an empty rects
    /// list separately.
    fn clear_search_highlights(&mut self) -> Result<(), String> {
        Ok(())
    }

    /// R3: accessor for the underlying alacritty Term, used by the
    /// buffer-read / scroll / search command handlers. Returns None when no
    /// PTY is attached. Default impl returns None for platform stubs
    /// (macOS/Linux) that don't have a parser bridge yet — Win32 overrides.
    fn term(&self) -> Option<Arc<Mutex<Term<TermListener>>>> {
        None
    }

    /// P3b: schedule a repaint of the pane. With the 16ms render pump gone,
    /// EVERY visual mutation must be followed by an explicit invalidation —
    /// this is the hook for the mod.rs command handlers that mutate the Term
    /// directly via `term()` (scroll_to_bottom / scroll_to_line / clear /
    /// reset) instead of going through a PlatformWindow mutator. Callers
    /// must drop the Term lock BEFORE re-entering the registry to reach this
    /// (locked ordering: registry → term, never the reverse). Default no-op
    /// keeps the macOS/Linux stubs compiling — Win32 overrides with
    /// InvalidateRect.
    fn request_redraw(&mut self) -> Result<(), String> {
        Ok(())
    }

    /// P0 perf instrumentation: snapshot the pane's render counters + cached
    /// geometry for `native_term_debug_stats`. Default returns zeroed stats
    /// so the macOS/Linux stubs compile untouched — Win32 overrides with
    /// live values from ChildState + Renderer.
    fn debug_stats(&self) -> DebugStats {
        DebugStats::default()
    }

    /// D-review: emit the coalesced `scroll` Tauri event reflecting the
    /// Term's CURRENT display_offset/history. Companion to `request_redraw`
    /// for the mod.rs handlers that mutate the viewport directly
    /// (`scroll_to_bottom` / `scroll_to_line`) — the parser worker only
    /// emits `scroll` on byte arrival and the JS `isAtBottom` state is
    /// driven exclusively by scroll events, so a command-driven scroll on a
    /// quiet PTY would otherwise leave the jump-to-bottom button stale.
    /// Win32 locks the Term briefly (registry → term order — the allowed
    /// direction, same as `attach_pty`) and funnels through the SAME
    /// coalesced emitter as the wheel arm, keeping the local dedup cache
    /// coherent. Default no-op keeps the macOS/Linux stubs compiling.
    fn emit_scroll_state(&mut self) -> Result<(), String> {
        Ok(())
    }
}

/// P4a/D3: open a platform window-move batch sized for `count` moves.
/// Returns an opaque handle threaded through
/// `NativeTermWindow::resize_deferred` and committed by `end_move_batch`.
/// 0 means "no batch available" (allocation failed, or the platform has no
/// move batching) — callers fall back to plain per-window `resize`.
#[cfg(target_os = "windows")]
pub fn begin_move_batch(count: usize) -> isize {
    win32::begin_move_batch(count)
}
#[cfg(not(target_os = "windows"))]
pub fn begin_move_batch(_count: usize) -> isize {
    0
}

/// P4a/D3: commit a window-move batch — every deferred move applies in one
/// atomic transaction (Win32 EndDeferWindowPos; each moved window's WM_SIZE
/// runs inside this call). `batch == 0` is a no-op Ok on every platform.
#[cfg(target_os = "windows")]
pub fn end_move_batch(batch: isize) -> Result<(), String> {
    win32::end_move_batch(batch)
}
#[cfg(not(target_os = "windows"))]
pub fn end_move_batch(_batch: isize) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
mod win32;
#[cfg(target_os = "windows")]
pub use win32::PlatformWindow;
/// P3b: re-exported so `parser_bridge::RenderWake::notify` (which lives
/// outside the window module) can post the wake message without reaching
/// into the private `win32` module.
#[cfg(target_os = "windows")]
pub(crate) use win32::WM_APP_RENDER;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::PlatformWindow;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::PlatformWindow;
