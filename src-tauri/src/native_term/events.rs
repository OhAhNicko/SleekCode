// Per-pane Tauri event emission for the native terminal.
//
// Event channel naming (locked with J + O at R1 coordination):
//   `native_term:{id}:{kind}`
// e.g. `native_term:42:resized`, `native_term:42:osc133`.
//
// R1.a ships only the `Resized` stub. Other event kinds (osc133, cursor,
// link_hover, key_down_preview, ime_composition, data_rate, r_button,
// mouse_passthrough) land in R2/R3 per the migration plan.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
pub struct Resized {
    pub cols: u32,
    pub rows: u32,
    /// Echoes the optional correlation_id from the originating
    /// `native_term_resize` invoke. Null when the caller didn't supply one
    /// (e.g. an internal/synthetic resize from a DPR change). Locked with O
    /// for the coordinator's modal-close ordering — see her plan section O1.
    pub correlation_id: Option<u64>,
}

pub fn emit_resized(app: &AppHandle, term_id: u32, payload: Resized) {
    // Best-effort: drop on emit failure (no live subscribers, app shutting
    // down, etc). Event channel names are stringly-typed by design — Tauri's
    // event system is broadcast-only and has no per-pane handle.
    let _ = app.emit(&format!("native_term:{}:resized", term_id), payload);
}

// ---- O2-B: IME composition, right-click, splitter-edge mouse passthrough.
// All three structs use camelCase per the JS bridge contract
// (src/lib/native-term-bridge.ts:193+). Coalescing / suppression policy lives
// in the wnd_proc callers; these helpers are pure best-effort emit.

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImeComposition {
    pub text: String,
    pub cursor: u32,
    pub committed: bool,
}

pub fn emit_ime_composition(app: &AppHandle, term_id: u32, payload: ImeComposition) {
    let _ = app.emit(
        &format!("native_term:{}:ime_composition", term_id),
        payload,
    );
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RButton {
    /// Pane-local logical (CSS) px — already divided by DPR caller-side.
    pub x: f32,
    pub y: f32,
}

pub fn emit_r_button(app: &AppHandle, term_id: u32, payload: RButton) {
    let _ = app.emit(&format!("native_term:{}:r_button", term_id), payload);
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MousePassthrough {
    /// Pane-local logical (CSS) px — already divided by DPR caller-side.
    pub x: f32,
    pub y: f32,
}

pub fn emit_mouse_passthrough(app: &AppHandle, term_id: u32, payload: MousePassthrough) {
    let _ = app.emit(
        &format!("native_term:{}:mouse_passthrough", term_id),
        payload,
    );
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KeyEventDto {
    pub code: String,
    pub key: String,
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub meta: bool,
    pub repeat: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KeyDownPreview {
    pub ev: KeyEventDto,
}

pub fn emit_key_down_preview(app: &AppHandle, term_id: u32, payload: KeyDownPreview) {
    let _ = app.emit(
        &format!("native_term:{}:key_down_preview", term_id),
        payload,
    );
}

// ---- R3-mouse: cursor-position broadcast + selection text broadcast.

/// Pane-local logical-px cursor position. `h` is the cell line-height in
/// logical px — the React side uses it to align the IME popup's vertical
/// baseline with the terminal's cursor cell.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Cursor {
    pub x: f32,
    pub y: f32,
    pub h: f32,
}

pub fn emit_cursor(app: &AppHandle, term_id: u32, payload: Cursor) {
    let _ = app.emit(&format!("native_term:{}:cursor", term_id), payload);
}

/// Emitted on WM_LBUTTONUP when a non-empty selection finalises. Mirrors
/// `SelectionEvent` in src/lib/native-term-bridge.ts.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub text: String,
}

pub fn emit_selection(app: &AppHandle, term_id: u32, payload: Selection) {
    let _ = app.emit(&format!("native_term:{}:selection", term_id), payload);
}

// ---- R3: OSC 133 prompt markers, scroll, OSC 8 hyperlinks, cell-hover.

/// OSC 133 prompt-block marker. `kind` is the letter (A=prompt-start,
/// B=command-start, C=output-start, D=command-end). `exitCode` is only
/// meaningful for kind=D (rest serialise as null). `absLine` is the
/// absolute grid line at the moment the marker fires — the JS side maps
/// it back through ViewportState.baseY for command-block boundaries.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Osc133 {
    pub kind: &'static str, // "A" | "B" | "C" | "D"
    pub exit_code: Option<i32>,
    pub abs_line: i64,
}

pub fn emit_osc133(app: &AppHandle, term_id: u32, payload: Osc133) {
    let _ = app.emit(&format!("native_term:{}:osc133", term_id), payload);
}

/// Scrollback / viewport position change. Mirrors the JS-side ScrollEvent.
/// Coalesced ~50ms in parser_bridge so smooth wheel scrolling doesn't
/// flood the event bus.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Scroll {
    pub viewport_y: i64,
    pub base_y: i64,
}

pub fn emit_scroll(app: &AppHandle, term_id: u32, payload: Scroll) {
    let _ = app.emit(&format!("native_term:{}:scroll", term_id), payload);
}

/// OSC 8 hyperlink mouse-over. Rect is pane-local logical-px.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LinkHover {
    pub uri: String,
    pub rect: super::window::Rect,
}

pub fn emit_link_hover(app: &AppHandle, term_id: u32, payload: LinkHover) {
    let _ = app.emit(&format!("native_term:{}:link_hover", term_id), payload);
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KeyModifiers {
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub meta: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LinkClick {
    pub uri: String,
    pub line: i64,
    pub col: u32,
    pub modifiers: KeyModifiers,
}

pub fn emit_link_click(app: &AppHandle, term_id: u32, payload: LinkClick) {
    let _ = app.emit(&format!("native_term:{}:link_click", term_id), payload);
}

/// Mouse cursor moved to a different (line, col). Coalesced in win32.rs.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CellHover {
    pub line: i64,
    pub col: u32,
}

pub fn emit_cell_hover(app: &AppHandle, term_id: u32, payload: CellHover) {
    let _ = app.emit(&format!("native_term:{}:cell_hover", term_id), payload);
}

/// Mouse left the pane (WM_MOUSELEAVE). No payload.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CellHoverEnd {}

pub fn emit_cell_hover_end(app: &AppHandle, term_id: u32) {
    let _ = app.emit(
        &format!("native_term:{}:cell_hover_end", term_id),
        CellHoverEnd {},
    );
}
