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
pub mod theme_parse;
pub mod window;

use serde::{Deserialize, Serialize};
use window::{CreateOpts, NativeTermWindow, PlatformWindow, Rect, TerminalTheme};

use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::vte::ansi::{ClearMode, Handler};

#[derive(Serialize, Debug, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct ProposedDimensions {
    pub cols: u32,
    pub rows: u32,
}

#[tauri::command]
pub fn native_term_create(app: tauri::AppHandle, opts: CreateOpts) -> Result<u32, String> {
    let parent = registry::parent_handle()
        .ok_or_else(|| "native_term: parent handle not captured yet".to_string())?;
    // R1.c keeps PlatformWindow::new minimal (rect+dpr only). theme/font/cursor
    // are no-op stubs in win32 set_theme/set_font/set_cursor_style — R1.d wires
    // them into the renderer. Apply them now so the values are recorded for
    // the eventual hot-swap call sites.
    let mut win = PlatformWindow::new(parent, opts.rect, opts.dpr)?;
    // O2-B: hand the AppHandle to PlatformWindow so the wnd_proc can emit
    // per-pane events (ime_composition, r_button, mouse_passthrough).
    win.set_app_handle(app);
    let _ = win.set_theme(&opts.theme);
    let _ = win.set_font(&opts.font.family, opts.font.size_px);
    let _ = win.set_cursor_style(&opts.cursor_style, opts.cursor_blink);
    let id = registry::alloc_id();
    win.set_term_id(id);
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

// ===========================================================================
// R3: buffer / scroll / search command surface.
//
// All commands acquire the Term Arc via `NativeTermWindow::term()` while
// holding the registry mutex, then drop the registry guard before locking
// the Term itself — keeps both lock windows short and avoids the
// registry-lock-while-term-locked deadlock direction.
// ===========================================================================

#[derive(Serialize, Debug, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct ViewportState {
    pub base_y: i64,
    pub viewport_y: i64,
    pub cursor_y: i64,
    pub length: i64,
    pub cols: u32,
    pub rows: u32,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchOpts {
    #[serde(default)]
    pub case_sensitive: Option<bool>,
    #[serde(default)]
    pub regex: Option<bool>,
    #[serde(default)]
    pub whole_word: Option<bool>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub total: u32,
    pub active_index: i32,
    pub rects: Vec<Rect>,
}

/// Read the Arc<Mutex<Term>> for this id, snapshotting only the Arc out of
/// the registry mutex so the caller can lock the Term independently. Returns
/// an error string if the id is unknown or no PTY is attached.
fn term_arc(
    id: u32,
) -> Result<std::sync::Arc<std::sync::Mutex<alacritty_terminal::term::Term<parser_bridge::TermListener>>>, String> {
    let mut out = None;
    registry::with_window(id, |w| {
        out = w.term();
        Ok(())
    })?;
    out.ok_or_else(|| format!("native_term: id {id} has no attached PTY"))
}

#[tauri::command]
pub fn native_term_get_buffer_lines(
    id: u32,
    start: i64,
    end: i64,
) -> Result<Vec<String>, String> {
    let term = term_arc(id)?;
    let t = term.lock().map_err(|_| "term mutex poisoned".to_string())?;
    let grid = t.grid();
    let cols = grid.columns();
    let history = grid.history_size() as i64;
    let screen = grid.screen_lines() as i64;
    // Valid alacritty Line range: [-history, screen). Clamp the request
    // rather than erroring — JS callers may speculatively read past the edge.
    let lo = start.max(-history);
    let hi = end.min(screen).max(lo);
    let mut out: Vec<String> = Vec::with_capacity((hi - lo).max(0) as usize);
    for line in lo..hi {
        let mut s = String::with_capacity(cols);
        let row = &grid[Line(line as i32)];
        for c in 0..cols {
            let cell = &row[Column(c)];
            // Replace NUL (uninitialised cells) with a space so trim_end
            // collapses them; non-printables stay as-is so the JS-side
            // search can find ANSI-stripped text consistently.
            let ch = cell.c;
            if ch == '\u{0}' {
                s.push(' ');
            } else {
                s.push(ch);
            }
        }
        let trimmed = s.trim_end_matches(|c: char| c == ' ' || c == '\u{0}');
        out.push(trimmed.to_string());
    }
    Ok(out)
}

#[tauri::command]
pub fn native_term_get_viewport_state(id: u32) -> Result<ViewportState, String> {
    let term = term_arc(id)?;
    let t = term.lock().map_err(|_| "term mutex poisoned".to_string())?;
    let grid = t.grid();
    let history = grid.history_size() as i64;
    let screen = grid.screen_lines() as i64;
    let display_offset = grid.display_offset() as i64;
    let base_y = -history;
    let viewport_y = base_y + display_offset;
    let cursor_y = grid.cursor.point.line.0 as i64;
    let length = history + screen;
    Ok(ViewportState {
        base_y,
        viewport_y,
        cursor_y,
        length,
        cols: grid.columns() as u32,
        rows: screen as u32,
    })
}

#[tauri::command]
pub fn native_term_get_selection(id: u32) -> Result<Option<String>, String> {
    let term = term_arc(id)?;
    let t = term.lock().map_err(|_| "term mutex poisoned".to_string())?;
    Ok(t.selection_to_string())
}

#[tauri::command]
pub fn native_term_scroll_to_bottom(id: u32) -> Result<(), String> {
    let term = term_arc(id)?;
    let mut t = term.lock().map_err(|_| "term mutex poisoned".to_string())?;
    t.scroll_display(Scroll::Bottom);
    Ok(())
}

#[tauri::command]
pub fn native_term_scroll_to_line(id: u32, abs_line: i64) -> Result<(), String> {
    let term = term_arc(id)?;
    let mut t = term.lock().map_err(|_| "term mutex poisoned".to_string())?;
    // abs_line uses the same coord space as ViewportState.viewportY:
    //   abs_line ∈ [-history, screen). Bottom of buffer is 0 (display_offset
    //   == 0). Older lines are negative. We translate the JS-side "scroll the
    //   viewport's top edge to this line" semantic into alacritty's
    //   Scroll::Delta(positive = older).
    let grid = t.grid();
    let history = grid.history_size() as i64;
    let current_offset = grid.display_offset() as i64;
    // target_offset = -abs_line. abs_line == -history → offset = history (top).
    // abs_line == 0 → offset = 0 (bottom).
    let target_offset = (-abs_line).clamp(0, history);
    let delta = (target_offset - current_offset) as i32;
    if delta != 0 {
        t.scroll_display(Scroll::Delta(delta));
    }
    Ok(())
}

#[tauri::command]
pub fn native_term_clear(id: u32) -> Result<(), String> {
    let term = term_arc(id)?;
    let mut t = term.lock().map_err(|_| "term mutex poisoned".to_string())?;
    // ed=3 semantic: clear the visible screen AND drop scrollback. alacritty's
    // Handler trait exposes both via clear_screen(All) + clear_screen(Saved);
    // calling both gives us the full "clear" UX.
    Handler::clear_screen(&mut *t, ClearMode::All);
    Handler::clear_screen(&mut *t, ClearMode::Saved);
    Ok(())
}

#[tauri::command]
pub fn native_term_reset(id: u32) -> Result<(), String> {
    let term = term_arc(id)?;
    let mut t = term.lock().map_err(|_| "term mutex poisoned".to_string())?;
    Handler::reset_state(&mut *t);
    Ok(())
}

/// Per-term search cursor. The (query + opts) fingerprint lets us detect
/// "same search as last time" → advance index; "new search" → recompute and
/// reset index.
#[derive(Debug, Clone)]
#[allow(dead_code)]
struct SearchState {
    query: String,
    case_sensitive: bool,
    regex: bool,
    whole_word: bool,
    /// Last active match index. -1 when there are no matches.
    active_index: i32,
    /// Cached total from the most recent scan; informational only — we
    /// recompute on every call so the live grid stays authoritative.
    total: u32,
}

static SEARCH_STATES: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<u32, SearchState>>> =
    std::sync::OnceLock::new();

fn search_states(
) -> &'static std::sync::Mutex<std::collections::HashMap<u32, SearchState>> {
    SEARCH_STATES.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// R3 search — visible-grid scan with regex, whole-word, and direction
/// support. Match storage and direction-aware activeIndex live in a
/// per-term [`SearchState`] held in the module-scoped [`SEARCH_STATES`]
/// map. The map entry is created on the first search call for a term and
/// cleared by `native_term_search_clear` or term destroy (best-effort —
/// the entry leaks until the next search if destroy is not wired through,
/// which is fine: it's a single SearchState per term).
#[tauri::command]
pub fn native_term_search(
    id: u32,
    query: String,
    opts: SearchOpts,
    direction: String,
) -> Result<SearchResult, String> {
    if query.is_empty() {
        // Empty query clears the saved cursor — next non-empty search
        // restarts from the top regardless of prior state.
        search_states().lock().map_err(|_| "search state poisoned".to_string())?.remove(&id);
        return Ok(SearchResult { total: 0, active_index: -1, rects: Vec::new() });
    }
    let case_sensitive = opts.case_sensitive.unwrap_or(false);
    let use_regex = opts.regex.unwrap_or(false);
    let whole_word = opts.whole_word.unwrap_or(false);
    let forward = !direction.eq_ignore_ascii_case("backward");

    // Cell metrics mirror the win32 hardcoded values. R3 freeze: when font
    // becomes hot-swappable we must read these from the renderer per-pane.
    const CELL_W: f32 = 8.4;
    const CELL_H: f32 = 17.0;

    // Build the regex matcher. In literal mode we still funnel through
    // `regex` (with `escape()`) so whole-word handling stays uniform. A
    // compile error in user-supplied regex returns an empty result rather
    // than propagating to JS — frontend treats empty as "no matches".
    let mut pattern = if use_regex { query.clone() } else { regex::escape(&query) };
    if whole_word {
        pattern = format!(r"\b(?:{})\b", pattern);
    }
    let re = match regex::RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .multi_line(false)
        .build()
    {
        Ok(r) => r,
        Err(_) => {
            // Invalid pattern — clear any saved cursor + return empty.
            search_states().lock().map_err(|_| "search state poisoned".to_string())?.remove(&id);
            return Ok(SearchResult { total: 0, active_index: -1, rects: Vec::new() });
        }
    };

    let term = term_arc(id)?;
    let t = term.lock().map_err(|_| "term mutex poisoned".to_string())?;
    let grid = t.grid();
    let cols = grid.columns();
    let screen = grid.screen_lines() as i32;
    let history = grid.history_size() as i32;
    let display_offset = grid.display_offset() as i32;

    let mut rects: Vec<Rect> = Vec::new();
    // Walk the full alacritty Line range — [-history, screen) — so scrollback
    // matches participate in `total` AND get rects emitted. Rects for rows
    // above the visible viewport have a NEGATIVE y (off-screen), which is
    // intentional: the pane-region driver clips them via its intersection
    // skip and the React layer can either drop them or render scrollback
    // indicators in the margin.
    //
    // y formula: visible_row = line + display_offset (current visible-row
    // code uses Line(visible_row - display_offset), inverted here). When
    // line + display_offset < 0 the rect sits above the viewport.
    for line_i in -history..screen {
        let row = &grid[Line(line_i)];
        let mut line_chars: Vec<char> = Vec::with_capacity(cols);
        for c in 0..cols {
            let ch = row[Column(c)].c;
            line_chars.push(if ch == '\u{0}' { ' ' } else { ch });
        }
        let line_str: String = line_chars.iter().collect();
        // Precompute byte→char index for non-ASCII paths.
        let line_ascii = line_str.is_ascii();
        let byte_to_col = |byte_idx: usize| -> usize {
            if line_ascii {
                byte_idx
            } else {
                line_str[..byte_idx].chars().count()
            }
        };
        let visible_row = line_i + display_offset;
        // Non-overlapping matches via find_iter (regex crate semantic).
        for m in re.find_iter(&line_str) {
            let col_start = byte_to_col(m.start());
            let match_str = m.as_str();
            // Skip zero-width matches (e.g. `^`, `$`, `\b`) — they would
            // emit zero-width rects and break the cursor advance math.
            if match_str.is_empty() {
                continue;
            }
            let match_chars = match_str.chars().count();
            let x = col_start as f32 * CELL_W;
            let y = visible_row as f32 * CELL_H;
            let w = match_chars as f32 * CELL_W;
            rects.push(Rect { x, y, width: w, height: CELL_H });
        }
    }
    drop(t);

    let total = rects.len() as u32;
    // Direction-aware activeIndex resolution:
    //   - same (query, opts) as last call → advance ±1 mod total
    //   - different → reset to 0 (forward) or total-1 (backward)
    let active_index = if total == 0 {
        -1
    } else {
        let mut map = search_states().lock().map_err(|_| "search state poisoned".to_string())?;
        let same = map.get(&id).map_or(false, |s| {
            s.query == query
                && s.case_sensitive == case_sensitive
                && s.regex == use_regex
                && s.whole_word == whole_word
        });
        let prev_idx = map.get(&id).map(|s| s.active_index).unwrap_or(-1);
        let next_idx: i32 = if !same || prev_idx < 0 {
            if forward { 0 } else { (total as i32) - 1 }
        } else {
            let n = total as i32;
            // Wrap on both ends.
            let step: i32 = if forward { 1 } else { -1 };
            (((prev_idx + step) % n) + n) % n
        };
        map.insert(
            id,
            SearchState {
                query: query.clone(),
                case_sensitive,
                regex: use_regex,
                whole_word,
                active_index: next_idx,
                total,
            },
        );
        next_idx
    };
    Ok(SearchResult { total, active_index, rects })
}

#[tauri::command]
pub fn native_term_search_clear(id: u32) -> Result<(), String> {
    // Drop the per-term search cursor so the next `native_term_search` call
    // starts fresh (no direction-advance). Rects are recomputed live on
    // every call; the renderer doesn't cache anything.
    if let Ok(mut map) = search_states().lock() {
        map.remove(&id);
    }
    // Also clear the renderer's overlay so previously-highlighted matches
    // disappear immediately. Best-effort: when the id is unknown the
    // registry helper Errs, which we swallow — JS routinely calls clear on
    // panes that may already be torn down.
    let _ = registry::with_window(id, |w| w.clear_search_highlights());
    Ok(())
}

/// Phase 3 search-highlight push. After `native_term_search` resolves, JS
/// calls this with the result rects so the renderer can draw the overlay
/// marks. Decoupling rect storage from the search command keeps the search
/// command pure (no renderer side effect) and lets JS skip the push when it
/// only needs the count (e.g. live regex preview before the user commits).
#[tauri::command]
pub fn native_term_set_search_highlights(id: u32, rects: Vec<Rect>) -> Result<(), String> {
    registry::with_window(id, move |w| w.set_search_highlights(rects))
}

// --- Phase 0 spike command aliases (kept for the `#native-spike` debug
// route and `TerminalPaneNative.tsx`'s current `invoke("native_term_spike_*")`
// call sites). Each just delegates to the production handler with default
// CreateOpts for theme/font/cursor — those are no-op stubs in R1.c anyway.
// J will flip JS to the production wrappers in a follow-up; until then these
// keep the debug route alive. Delete after the JS flip lands.

#[tauri::command]
pub fn native_term_spike_create(
    app: tauri::AppHandle,
    rect: Rect,
    dpr: f32,
) -> Result<u32, String> {
    let parent = registry::parent_handle()
        .ok_or_else(|| "native_term: parent handle not captured yet".to_string())?;
    let mut win = PlatformWindow::new(parent, rect, dpr)?;
    win.set_app_handle(app);
    let id = registry::alloc_id();
    win.set_term_id(id);
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
