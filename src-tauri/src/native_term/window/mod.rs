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
    /// Search-highlight rects ONLY: this rect is the CURRENTLY SELECTED match,
    /// so the renderer paints it in `searchMatchActive` instead of the ordinary
    /// match color. `serde(default)` (false) everywhere else — the same struct
    /// carries create/resize geometry and hole regions, which never set it, and
    /// `native_term_search` emits rects the JS side flips one of before sending
    /// them back through `native_term_set_search_highlights`.
    #[serde(default)]
    pub active: bool,
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
    /// Opt in to the process-wide Device/Queue (Settings toggle). Travels per
    /// pane so flipping the toggle affects only panes created afterwards —
    /// existing panes keep the device they were built with.
    #[serde(default)]
    pub shared_gpu: bool,
    /// Rendering tunables, applied at create through the SAME mutator the
    /// `native_term_set_render_opts` hot-swap uses (see the create comment) so
    /// the two can never drift. All-`None` = the pre-settings defaults.
    #[serde(default)]
    pub render_opts: RenderOpts,
}

/// User-tunable rendering knobs. EVERY field is `Option` and every `None`
/// means "exactly what the renderer did before this struct existed", so a
/// caller that omits the whole object (or any single key) gets the historical
/// behaviour. Resolved + clamped into `renderer::RenderTuning` before it
/// reaches the renderer — see `RenderTuning::resolve`.
#[derive(Deserialize, Debug, Clone, Copy, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RenderOpts {
    /// Bold text on an ANSI 0..=7 foreground draws in the matching bright
    /// slot (i + 8), xterm's `boldIsBright`. The bold FONT WEIGHT is applied
    /// either way — this is the color half only.
    pub bold_uses_bright: Option<bool>,
    /// Minimum WCAG contrast ratio between resolved fg and bg. `<= 1.0` (or
    /// `None`) disables the pass entirely.
    pub min_contrast: Option<f32>,
    /// How far SGR 2 (dim) fades the foreground toward the background.
    /// `None` = 0.5, the historical fixed halfway blend.
    pub dim_strength: Option<f32>,
    /// Alpha of the focused block cursor. `None` = 0.30, the historical
    /// translucent overlay. `>= 0.999` switches to a true inverse block (see
    /// the cursor pass in `renderer/pipeline.rs`).
    pub cursor_block_alpha: Option<f32>,
    /// Multiplier on the font-derived line height. `None` = 1.0. Changing it
    /// re-derives the cell metrics and reflows the grid exactly like a font
    /// size change — rows/cols move, so the PTY resize chain must run.
    pub line_height_scale: Option<f32>,
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
    /// Optional replacement for xterm indices 16..=255 (240 entries, in order).
    ///
    /// Light themes need this: the 256-color cube is a fixed set of constants
    /// chosen for dark canvases, so on paper backgrounds CLI output renders at
    /// ~1.2:1 and is effectively invisible. The JS side sends a palette adapted
    /// to the canvas; `None` keeps the standard xterm cube.
    #[serde(default, rename = "extendedAnsi")]
    pub extended_ansi: Option<Vec<String>>,
    /// User color-preset extras (all optional — `None` keeps each renderer
    /// behavior exactly as before the preset feature existed).
    /// Repaints selected text; without it selection recolors only the cell bg.
    #[serde(default, rename = "selectionForeground")]
    pub selection_foreground: Option<String>,
    /// Recolors detected/OSC 8 link text + underline.
    #[serde(default)]
    pub link: Option<String>,
    /// Search-match highlight quad; `None` = the built-in translucent white.
    #[serde(default, rename = "searchMatch")]
    pub search_match: Option<String>,
    /// Highlight quad for the CURRENTLY SELECTED match (the rects flagged
    /// `active`); `None` = the built-in green.
    #[serde(default, rename = "searchMatchActive")]
    pub search_match_active: Option<String>,
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

    /// Hot-swap the rendering tunables (bold-is-bright, dim strength, minimum
    /// contrast, block-cursor alpha, line-height scale). Implementations must
    /// treat a line-height change like a font-size change — re-derive the cell
    /// metrics, then run the propose/commit/PTY-resize chain, because the row
    /// and column counts move. Default no-op keeps the macOS/Linux stubs
    /// compiling.
    fn set_render_opts(&mut self, _opts: RenderOpts) -> Result<(), String> {
        Ok(())
    }

    /// P2a focus flag: only the focused pane blinks its cursor (respecting
    /// the cursor_blink setting); unfocused panes render a static hollow
    /// outline cursor. Default no-op keeps the macOS/Linux stubs compiling —
    /// Win32 overrides with the blink-timer + renderer wiring.
    fn set_focused(&mut self, _focused: bool) -> Result<(), String> {
        Ok(())
    }

    /// Real glyph-grid cell metrics in LOGICAL px (cell_w, cell_h). Pull
    /// variant of the `resized` event's cellW/cellH — the pane's FIRST
    /// resize fires before the JS listener attaches, so subscribers can
    /// miss it; grid-positioned popups query this once at hookup instead.
    /// Default zeros keep the macOS/Linux stubs compiling.
    fn metrics(&mut self) -> Result<(f32, f32), String> {
        Ok((0.0, 0.0))
    }

    /// S12/S13 hand-cursor affordance: JS mirrors "a regex link is under the
    /// cursor"; Win32's WM_SETCURSOR shows IDC_HAND while Ctrl is held.
    /// Default no-op keeps the macOS/Linux stubs compiling.
    fn set_hover_link(&mut self, _active: bool) -> Result<(), String> {
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

    /// Main OS window minimized: if this pane holds real keyboard focus and
    /// its CLI enabled DECSET 1004, deliver `\e[O`. Minimize RETAINS per-thread
    /// focus — no WM_KILLFOCUS ever reaches the focused child — so without an
    /// explicit report the CLI keeps believing the terminal is focused and
    /// (Claude Code) skips its finish/permission notification escape entirely.
    /// No restore twin: the border subclass kicks focus through the webview on
    /// restore, and the real KILLFOCUS/SETFOCUS pair replays the 1004 state.
    /// Default no-op keeps the macOS/Linux stubs compiling.
    fn main_window_minimized(&mut self) -> Result<(), String> {
        Ok(())
    }

    /// Opt this pane into the readline key translations (Ctrl+Backspace,
    /// Ctrl+Left/Right, Ctrl+Z) and Shift+Enter-as-newline. Off by default so
    /// shell, Codex, Gemini and Claude's non-fullscreen mode keep stock
    /// behaviour — those bindings are specific to Claude's fullscreen input
    /// layer, which reads readline tokens.
    fn set_prompt_nav(&mut self, _on: bool) -> Result<(), String> {
        Ok(())
    }

    /// Opt this pane into MADE claiming Ctrl+Up/Ctrl+Down (and PgUp/PgDn on the
    /// alternate screen) for message navigation.
    ///
    /// SEPARATE from `set_prompt_nav` on purpose. That flag used to gate both,
    /// so extending message navigation to Codex and Gemini would have dragged
    /// Claude's readline translations along with it and changed what those CLIs
    /// receive for Ctrl+Backspace and Shift+Enter.
    fn set_prompt_jump(&mut self, _on: bool) -> Result<(), String> {
        Ok(())
    }

    /// Context-menu Copy: put the pane's current selection on the OS
    /// clipboard, clear the highlight and the JS selection mirror. Rust-side
    /// because the webview may not own OS focus while a native pane does,
    /// making navigator.clipboard unusable there. Default no-op keeps the
    /// macOS/Linux stubs compiling.
    fn copy_selection(&mut self) -> Result<(), String> {
        Ok(())
    }

    /// Context-menu Paste: read clipboard text and write it to the PTY with
    /// the pane's real bracketed-paste state. Same focus rationale as
    /// copy_selection. Default no-op for the stubs.
    fn paste_clipboard(&mut self) -> Result<(), String> {
        Ok(())
    }

    /// Enable/disable velocity acceleration for MADE's OWN scrollback wheel
    /// scrolling (Warp-style: fast flicks travel further per notch). Does not
    /// affect wheel events forwarded to a mouse-reporting TUI — those stay raw,
    /// since the TUI may run its own ramp. Default no-op for mac/linux stubs.
    fn set_wheel_acceleration(&mut self, _on: bool) -> Result<(), String> {
        Ok(())
    }

    /// Drive a fullscreen TUI's own scroller by synthesizing wheel events into
    /// the PTY (`notches` signed; positive = up/older). Used by the pane
    /// scrollbar so dragging it scrolls exactly as smoothly as the real wheel.
    /// Returns false when the TUI has not enabled mouse reporting, so the
    /// caller can fall back to page keys. Default no-op keeps the mac/linux
    /// stubs compiling.
    fn tui_scroll(&mut self, _notches: i32) -> Result<bool, String> {
        Ok(false)
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
