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
