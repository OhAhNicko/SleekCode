// Parser bridge: PTY bytes → alacritty_terminal::Term grid.
//
// One ParserBridge instance per native_term_id. It owns:
//   - a `Term<TermListener>` from alacritty_terminal 0.24
//   - a `Processor` from vte 0.13 (alacritty_terminal re-exports vte)
//   - a worker thread draining the crossbeam Receiver (from pty_route)
//
// API verified against `~/.cargo/registry/.../alacritty_terminal-0.24.2/`:
//   - `Term::new(config, &dims, listener)` — listener is `T: EventListener`.
//   - `Processor::new()` is in `alacritty_terminal::vte::ansi`.
//   - `processor.advance(&mut term, byte)` — byte-by-byte. Term<T:EventListener>
//     implements `vte::ansi::Handler`.
//   - `term.grid().cursor.point` for cursor (pub field).
//   - `Dimensions` is a trait — we use the in-crate `TermSize` shape (mirrored
//     locally since it's pub(crate) in alacritty's test module only).
//
// R1.a scope: stand the pipeline up, log per-batch progress via eprintln.
// No rendering yet — that's R1.b.

use crossbeam_channel::{Receiver, RecvTimeoutError};
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::vte::ansi::Processor;
use tauri::AppHandle;

use alacritty_terminal::term::TermMode;

use super::events::{
    emit_alt_screen, emit_cursor, emit_notify, emit_osc133, emit_progress, emit_scroll,
    emit_title, AltScreen, Cursor, Notify, Osc133, Progress, Scroll as ScrollEvt, TermTitle,
};

/// Minimal `Dimensions` impl for `Term::new`. Mirrors alacritty's internal
/// test `TermSize` since the public `Dimensions` trait is what `Term::new`
/// actually requires. `pub(crate)` so the win32 resize-commit path
/// (`commit_dims`) can reuse it for `Term::resize` instead of duplicating
/// the shape.
#[derive(Clone, Copy)]
pub(crate) struct TermDims {
    pub(crate) columns: usize,
    pub(crate) screen_lines: usize,
}

impl Dimensions for TermDims {
    fn total_lines(&self) -> usize {
        self.screen_lines
    }
    fn screen_lines(&self) -> usize {
        self.screen_lines
    }
    fn columns(&self) -> usize {
        self.columns
    }
}

/// EventListener impl that logs to stderr in R1.a and will route to Tauri
/// event channels in R3 (osc133, title changes, clipboard, etc.). Keeping it
/// `Clone` lets the listener live both on the Term and (later) in event
/// dispatch closures.
#[derive(Clone)]
pub struct TermListener {
    pub term_id: u32,
    /// Emits OSC 0/2 title changes. `None` in tests (no Tauri app).
    pub app: Option<AppHandle>,
}

impl EventListener for TermListener {
    fn send_event(&self, event: Event) {
        match event {
            Event::Title(s) => {
                // OSC 0 / OSC 2. Forwarded so a pane header can show what the
                // program is doing; empty string means "no title".
                if let Some(app) = self.app.as_ref() {
                    emit_title(app, self.term_id, TermTitle { title: s });
                }
            }
            Event::ResetTitle => {
                if let Some(app) = self.app.as_ref() {
                    emit_title(app, self.term_id, TermTitle { title: String::new() });
                }
            }
            Event::Bell => eprintln!("[native_term] term {} bell", self.term_id),
            Event::CursorBlinkingChange => {}
            Event::Wakeup => {} // far too noisy to log every parser tick
            Event::MouseCursorDirty => {}
            Event::ClipboardStore(_, _) => {} // R3
            Event::ClipboardLoad(_, _) => {}  // R3
            Event::ColorRequest(_, _) => {}   // R3
            Event::PtyWrite(_) => {}          // R2 — keyboard echo path
            Event::TextAreaSizeRequest(_) => {}
            Event::ChildExit(code) => {
                eprintln!("[native_term] term {} child exited code={}", self.term_id, code);
            }
            Event::Exit => {
                eprintln!("[native_term] term {} exit event", self.term_id);
            }
        }
    }
}

/// P3b event-driven render wake, shared between the parser worker (producer)
/// and the platform window (consumer). After each parsed batch the worker
/// calls [`RenderWake::notify`], which posts `WM_APP_RENDER` to the pane's
/// HWND via `PostMessageW` — the documented thread-safe cross-thread wake.
/// The `pending` AtomicBool bounds the message queue to ONE in-flight wake:
/// batches landing while a wake is pending only bump `batches` (the wnd_proc
/// arm clears `pending` BEFORE invalidating, so a batch landing after the
/// clear posts a fresh message — no lost-wake window).
///
/// SAFETY PROTOCOL: the worker thread is DETACHED (dropping the bridge does
/// NOT join it), so this handle can outlive the pane. The platform window
/// MUST store 0 into `hwnd` on detach/destroy BEFORE dropping the bridge /
/// destroying the window — `notify` treats hwnd == 0 as "pane gone" and
/// never posts.
pub(crate) struct RenderWake {
    /// Target HWND as isize; 0 = detached/destroyed (never post).
    pub(crate) hwnd: AtomicIsize,
    /// True while a WM_APP_RENDER is in flight. Cleared by the wnd_proc arm
    /// before it invalidates.
    pub(crate) pending: AtomicBool,
    /// Total batches parsed. The win32 watchdog timer compares this against
    /// its last-seen value to convert any missed-wake bug into a <=500ms
    /// hiccup instead of a frozen pane.
    pub(crate) batches: AtomicU64,
    /// P0 counter: wakes successfully posted (PostMessageW returned Ok).
    pub(crate) wakes_posted: AtomicU64,
    /// P0 counter: notifies skipped because a wake was already pending.
    pub(crate) wakes_coalesced: AtomicU64,
}

impl RenderWake {
    pub(crate) fn new(hwnd: isize) -> Self {
        RenderWake {
            hwnd: AtomicIsize::new(hwnd),
            pending: AtomicBool::new(false),
            batches: AtomicU64::new(0),
            wakes_posted: AtomicU64::new(0),
            wakes_coalesced: AtomicU64::new(0),
        }
    }

    /// Record a parsed batch and wake the render thread if no wake is
    /// already in flight. Called by the worker AFTER the Term lock for the
    /// batch has been released (never wake-while-locked — the paint path
    /// re-acquires the Term lock in sync_from_term).
    fn notify(&self) {
        self.batches.fetch_add(1, Ordering::AcqRel);
        if self.pending.swap(true, Ordering::AcqRel) {
            // A wake is already queued — the wnd_proc arm clears `pending`
            // before invalidating, so this batch is covered by that paint
            // (or by the fresh wake the next notify posts).
            self.wakes_coalesced.fetch_add(1, Ordering::Relaxed);
            return;
        }
        let h = self.hwnd.load(Ordering::Acquire);
        if h == 0 {
            // Detached/destroyed pane. `pending` stays latched true so this
            // dying handle never posts again — intentional terminal state.
            return;
        }
        #[cfg(target_os = "windows")]
        {
            use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
            use windows::Win32::UI::WindowsAndMessaging::PostMessageW;
            // SAFETY: PostMessageW is documented thread-safe; a stale (just
            // destroyed) HWND makes it fail harmlessly, and the hwnd-zeroing
            // protocol above prevents posts once teardown has begun.
            //
            // TOCTOU note: a worker that loaded a non-zero hwnd can race the
            // entire destroy() (zero → DestroyWindow) and post to a handle
            // the OS has already recycled. Accepted as benign: for another
            // native_term pane (same class) the WM_APP_RENDER arm just clears
            // that pane's own `pending` and invalidates — an early pending
            // clear only ever causes an extra post, never a lost wake. For a
            // foreign window WM_APP+1 is in the app-private message range and
            // well-behaved windows ignore unknown WM_APP messages.
            let posted = unsafe {
                PostMessageW(
                    HWND(h as *mut core::ffi::c_void),
                    super::window::WM_APP_RENDER,
                    WPARAM(0),
                    LPARAM(0),
                )
            }
            .is_ok();
            if posted {
                self.wakes_posted.fetch_add(1, Ordering::Relaxed);
            } else {
                // Post failed with a LIVE hwnd (e.g. the thread's 10k message
                // queue is full during an output storm). Release the latch so
                // the next batch retries the post — otherwise `pending` stays
                // true forever with no message in flight and the pane degrades
                // permanently to watchdog-only 500ms repaints. Worst case this
                // allows an extra wake message, which the protocol already
                // tolerates (the wnd_proc arm clears `pending` before
                // invalidating). The hwnd == 0 latch above stays terminal.
                self.pending.store(false, Ordering::Release);
            }
        }
        #[cfg(not(target_os = "windows"))]
        let _ = h;
    }
}

/// Public handle to the parser-bridge for a single native_term_id. Owns the
/// worker thread handle (the worker is DETACHED — dropping a JoinHandle does
/// not join; the worker exits when the crossbeam Sender side closes) and the
/// shared Term (held behind a mutex so `get_buffer_lines` /
/// `get_viewport_state` commands can snapshot it cheaply).
pub struct ParserBridge {
    pub term: Arc<Mutex<Term<TermListener>>>,
    _worker: JoinHandle<()>,
}

impl ParserBridge {
    /// Spawn a bridge for `term_id`. Caller must have already called
    /// `pty_route::create_channel(term_id)` and own the corresponding
    /// `Receiver<Vec<u8>>`. The worker thread takes ownership of the receiver.
    ///
    /// `scrollback` is the maximum scrollback history in lines
    /// (CreateOpts.scrollback, wired through `PlatformWindow::attach_pty`) —
    /// it maps 1:1 onto alacritty's `Config::scrolling_history`; every other
    /// Config field keeps its default. `cell_metrics` is a shared
    /// `(cell_w, line_h)` pair — the renderer's
    /// per-cell logical-px metrics, used to translate the alacritty cursor
    /// grid position into pane-local pixel coords for the `cursor` Tauri
    /// event. The worker re-reads it per batch, so a font hot-swap (which
    /// updates the pair via `PlatformWindow::set_font`) propagates without
    /// respawning the bridge. `wake` is the P3b render-wake handle — the
    /// worker calls `notify()` after each batch (Term lock released) so the
    /// platform window repaints event-driven instead of on a timer pump;
    /// pass a wake with hwnd 0 to disable posting (tests / non-Windows).
    /// `app` is the AppHandle the worker emits with — `None` disables cursor
    /// emission (used by tests where no Tauri app is initialised).
    pub fn spawn(
        term_id: u32,
        cols: usize,
        screen_lines: usize,
        scrollback: usize,
        rx: Receiver<Vec<u8>>,
        cell_metrics: Arc<Mutex<(f32, f32)>>,
        wake: Arc<RenderWake>,
        app: Option<AppHandle>,
    ) -> Self {
        let dims = TermDims { columns: cols, screen_lines };
        let listener = TermListener { term_id, app: app.clone() };
        // P7a: CreateOpts.scrollback → alacritty scrolling_history (field
        // name verified against alacritty_terminal 0.24.2 term::Config).
        let config = Config { scrolling_history: scrollback, ..Config::default() };
        let term = Arc::new(Mutex::new(Term::new(config, &dims, listener)));

        let (cell_w, line_h) = *cell_metrics
            .lock()
            .expect("parser_bridge cell_metrics mutex poisoned");
        let term_for_worker = Arc::clone(&term);
        let worker = std::thread::Builder::new()
            .name(format!("native_term-{}-parser", term_id))
            .spawn(move || worker_loop(term_id, term_for_worker, rx, cell_metrics, wake, app))
            .expect("failed to spawn parser worker");

        eprintln!(
            "[native_term] term {} parser_bridge spawned cols={} lines={} cell={}x{}",
            term_id, cols, screen_lines, cell_w, line_h
        );

        ParserBridge { term, _worker: worker }
    }
}

fn worker_loop(
    term_id: u32,
    term: Arc<Mutex<Term<TermListener>>>,
    rx: Receiver<Vec<u8>>,
    cell_metrics: Arc<Mutex<(f32, f32)>>,
    wake: Arc<RenderWake>,
    app: Option<AppHandle>,
) {
    // Per-thread Processor: byte-level ANSI/UTF-8 state machine. Cheap to
    // create once and reuse across all batches for this term.
    let mut processor: Processor = Processor::new();
    let mut total_bytes: u64 = 0;
    let mut batches: u64 = 0;
    // Coalesce cursor emissions by (rounded x, rounded y) so we don't flood
    // the JS bus on every keystroke when the cursor moves within the same
    // logical pixel (shouldn't happen but cheap to guard).
    let mut last_cursor: Option<(i32, i32)> = None;

    // R3 OSC 133 pre-scanner. alacritty_terminal 0.24.2 does NOT surface OSC
    // 133 prompt markers via the EventListener trait — it doesn't even keep
    // them in the grid. We pre-scan the raw PTY byte stream for the marker
    // sequences before passing the slice through alacritty. The grid still
    // sees every byte unchanged; we just emit Osc133 events on the side.
    //
    // Sequence shape:
    //   ESC ] 133 ; X [ ; ... ] (BEL | ESC \)
    //   where X ∈ {A,B,C,D}. For D the optional payload is the exit code:
    //   "133;D;<int>". A/B/C may also carry payload (e.g. "133;A;cl=m") but we
    //   only care about the kind for those.
    let mut osc_scanner = Osc133Scanner::new();
    // Notification / progress OSCs (9, 99, 777). Same pre-scan rationale as
    // Osc133Scanner: alacritty_terminal does not surface these to its listener.
    let mut notify_scanner = OscNotifyScanner::new();
    // Synchronized output (DECSET 2026). While a program holds an update open
    // we withhold the render wake so a frame split across PTY reads is never
    // presented half-drawn.
    let mut sync_scanner = SyncOutputScanner::new();
    let mut in_sync = false;
    let mut sync_since = std::time::Instant::now();

    // R3 scroll-coalescer. We cache the last emitted display_offset and rate-
    // limit emissions to ~50ms so smooth wheel scrolling doesn't flood the bus.
    let mut last_emitted_offset: Option<usize> = None;
    let mut last_scroll_emit = std::time::Instant::now();
    const SCROLL_COALESCE_MS: u128 = 50;

    // DECSET 1049 alt-screen tracking. A fullscreen TUI (Claude's `/tui
    // fullscreen`, vim, htop) swaps to the alternate buffer, which by
    // definition has no scrollback — so MADE's own scrollbar has nothing to
    // show there and the TUI's own scrolling takes over. JS uses this to swap
    // which scrollbar it renders. Emitted ONLY on transition (not per batch);
    // `None` forces the first real state to emit so JS never has to assume.
    let mut last_alt_screen: Option<(bool, bool)> = None;

    loop {
        // While a synchronized update is open we must be able to time out even
        // if the program sends NOTHING further: the wake is withheld during
        // sync, so the win32 watchdog (which compares batch counts) sees no
        // change either and cannot rescue a pane stuck mid-update. Waiting with
        // a deadline is what makes the DEC-mandated escape hatch actually fire.
        let bytes = if in_sync {
            match rx.recv_timeout(std::time::Duration::from_millis(SYNC_TIMEOUT_MS as u64)) {
                Ok(b) => b,
                Err(RecvTimeoutError::Timeout) => {
                    // Update never closed — release the frame we withheld.
                    in_sync = false;
                    wake.notify();
                    continue;
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        } else {
            match rx.recv() {
                Ok(b) => b,
                Err(_) => break,
            }
        };

        batches += 1;
        total_bytes += bytes.len() as u64;

        // 1) Pre-scan for OSC 133 markers. Done BEFORE the alacritty parse so
        //    a marker spanning two batches still resolves (state machine is
        //    persisted across batches via osc_scanner.state). Emits are
        //    deferred until after the Term lock is released — we don't want
        //    to block the parse on a Tauri broadcast.
        let osc_hits: Vec<(char, Option<i32>)> = osc_scanner.feed(&bytes);
        let notify_hits = notify_scanner.feed(&bytes);
        if let Some(begin) = sync_scanner.feed(&bytes) {
            if begin && !in_sync {
                sync_since = std::time::Instant::now();
            }
            in_sync = begin;
        }

        // 2) Lock the Term across the whole batch — single contiguous parse,
        //    no .await inside. Other readers (get_buffer_lines etc.) wait
        //    briefly. Keep this window TIGHT: no Tauri emits while held.
        let mut t = term.lock().expect("parser_bridge term mutex poisoned");
        for byte in &bytes {
            processor.advance(&mut *t, *byte);
        }
        let pt = t.grid().cursor.point;
        let snippet = capture_last_line(&t);
        // Snapshot what the post-parse OSC 133 events should reference.
        // `absLine` is the absolute grid line (relative to scrollback origin):
        // base_y = -history_size(); abs_line = base_y + cursor.line + history.
        // For prompt markers we report the line where the marker landed,
        // which is alacritty's cursor.line at the moment of the sequence.
        let history = t.grid().history_size() as i64;
        let cursor_line: i64 = pt.line.0 as i64;
        let abs_line = history + cursor_line;
        let display_offset_now = t.grid().display_offset();
        let alt_screen_now = t.mode().contains(TermMode::ALT_SCREEN);
        let mouse_reporting_now = t.mode().contains(TermMode::MOUSE_REPORT_CLICK)
            || t.mode().contains(TermMode::MOUSE_DRAG)
            || t.mode().contains(TermMode::MOUSE_MOTION);
        drop(t); // release before any eprintln / app.emit

        // P3b: wake the render thread for this batch — AFTER the Term lock
        // drop (the paint path re-locks the Term in sync_from_term) and
        // BEFORE the slow eprintln/emit tail so the repaint isn't delayed
        // behind console IO.
        //
        // Synchronized output: while a program holds an update open (DECSET
        // 2026) the wake is WITHHELD, so a repaint arriving across several PTY
        // reads is presented once, whole, rather than half-drawn. The timeout
        // is the spec's required escape hatch — a program that dies between
        // BSU and ESU must not freeze the pane.
        let sync_expired = sync_since.elapsed().as_millis() >= SYNC_TIMEOUT_MS;
        if in_sync && sync_expired {
            in_sync = false;
        }
        if !in_sync {
            wake.notify();
        }

        eprintln!(
            "[native_term] term {} batch={} bytes={} total={} cursor=(line={}, col={}) last_line=\"{}\"",
            term_id, batches, bytes.len(), total_bytes, pt.line.0, pt.column.0, snippet
        );

        // Emit `cursor` if the rounded logical-px position has moved. We use
        // the viewport-relative cursor line — alacritty's Line is signed and
        // represents the offset from the top of the screen area (scrollback
        // is negative). For the IME popup we only care when the cursor is in
        // the live area; values are still useful when scrolled back so we
        // don't gate on sign here.
        if let Some(app) = app.as_ref() {
            // Re-read the shared metrics per batch so a font hot-swap done on
            // the main thread (set_font → mirrors → this pair) is picked up
            // by the very next cursor emission. Uncontended in practice —
            // set_font writes are rare.
            let (cell_w, line_h) = *cell_metrics
                .lock()
                .expect("parser_bridge cell_metrics mutex poisoned");
            let x = pt.column.0 as f32 * cell_w;
            // P6a scrollback: the renderer shows grid line (y - offset) at
            // visual row y, so the cursor's RENDERED row is line + offset.
            // Using the offset captured under this batch's Term lock keeps
            // the IME popup glued to the visible cursor cell (it may land
            // below the pane while scrolled far back — the popup follows the
            // same convention as the renderer's cursor pass, which hides the
            // cursor once its visual row leaves the viewport).
            let y = (pt.line.0 + display_offset_now as i32) as f32 * line_h;
            let key = (x.round() as i32, y.round() as i32);
            if last_cursor != Some(key) {
                last_cursor = Some(key);
                emit_cursor(app, term_id, Cursor { x, y, h: line_h });
            }

            // OSC 133 emit fan-out. All hits in this batch reference the same
            // post-batch cursor line — close enough for the React prompt-block
            // detector. If we ever care about per-marker positions, we'd need
            // to snapshot cursor.line at the time each marker landed (which
            // requires interleaving the scanner with the parser; not worth
            // the complexity for v1).
            for (kind_char, exit_code) in osc_hits {
                let kind: &'static str = match kind_char {
                    'A' => "A",
                    'B' => "B",
                    'C' => "C",
                    'D' => "D",
                    _ => continue,
                };
                emit_osc133(
                    app,
                    term_id,
                    Osc133 { kind, exit_code, abs_line },
                );
            }

            for hit in notify_hits {
                match hit {
                    OscNotifyEvent::Notify(title, body) => {
                        emit_notify(app, term_id, Notify { title, body })
                    }
                    OscNotifyEvent::Progress(state, percent) => {
                        emit_progress(app, term_id, Progress { state, percent })
                    }
                }
            }

            // Alt-screen transitions. Not coalesced — these are rare (one per
            // fullscreen enter/exit) and JS swaps its scrollbar on them, so a
            // dropped or delayed edge is directly visible.
            let alt_state = (alt_screen_now, mouse_reporting_now);
            if last_alt_screen != Some(alt_state) {
                last_alt_screen = Some(alt_state);
                emit_alt_screen(
                    app,
                    term_id,
                    AltScreen {
                        active: alt_screen_now,
                        mouse_reporting: mouse_reporting_now,
                    },
                );
            }

            // Scroll: emit when display_offset has changed AND we're past the
            // 50ms coalesce window. P6a unified space (same as
            // ViewportState.viewportY and the win32 wheel-arm emit):
            // viewport_y = -display_offset — 0 pinned to the live bottom,
            // negative while scrolled into history, base_y (= -history) at
            // the very top. The previous `base_y + offset` formula inverted
            // the axis and broke the JS at-bottom check (viewportY >= -3).
            if last_emitted_offset != Some(display_offset_now) {
                let now = std::time::Instant::now();
                if now.duration_since(last_scroll_emit).as_millis()
                    >= SCROLL_COALESCE_MS
                {
                    last_emitted_offset = Some(display_offset_now);
                    last_scroll_emit = now;
                    let base_y = -(history);
                    let viewport_y = -(display_offset_now as i64);
                    emit_scroll(
                        app,
                        term_id,
                        ScrollEvt { viewport_y, base_y },
                    );
                }
            }
        }
    }
    eprintln!("[native_term] term {} worker exited after {} batches / {} bytes", term_id, batches, total_bytes);
}

/// State machine for finding OSC 133 prompt markers in the raw PTY byte
/// stream. Persists across `feed()` calls so a sequence split across two
/// batches still resolves. Emits one entry per fully-parsed marker:
/// `(kind_char, exit_code_for_D)`.
///
/// Stub limitations:
///   - Ignores any A/B/C payload beyond the kind letter.
///   - For D, parses a single trailing integer (the exit code). Other
///     semicolon-separated key=value fields are dropped.
///   - Stops parsing the payload on the first non-digit char after `;X;`
///     for kind=D — so e.g. `133;D;0;cwd=/tmp` correctly captures exit 0.
struct Osc133Scanner {
    state: ScannerState,
    /// Buffer for the kind letter + optional D-payload digits.
    payload: Vec<u8>,
}

enum ScannerState {
    /// Looking for ESC (0x1b).
    Idle,
    /// Saw ESC, expecting `]`.
    SawEsc,
    /// Saw `ESC ]`, accumulating the OSC prefix digits to check for `133;`.
    InOscPrefix { digits: Vec<u8> },
    /// Saw `ESC ] 133 ;` — next byte should be the kind letter.
    AwaitKind,
    /// Saw `ESC ] 133 ; X` — accumulate payload until BEL / ST.
    InPayload { kind: char },
    /// Saw `ESC` inside payload (potential ESC \ terminator).
    PayloadSawEsc { kind: char },
}

impl Osc133Scanner {
    fn new() -> Self {
        Self {
            state: ScannerState::Idle,
            payload: Vec::with_capacity(16),
        }
    }

    fn feed(&mut self, bytes: &[u8]) -> Vec<(char, Option<i32>)> {
        let mut out: Vec<(char, Option<i32>)> = Vec::new();
        for &b in bytes {
            // Use a temporary swap to bypass the borrow checker on self.state.
            let prev = std::mem::replace(&mut self.state, ScannerState::Idle);
            self.state = match prev {
                ScannerState::Idle => {
                    if b == 0x1b {
                        ScannerState::SawEsc
                    } else {
                        ScannerState::Idle
                    }
                }
                ScannerState::SawEsc => {
                    if b == b']' {
                        ScannerState::InOscPrefix { digits: Vec::with_capacity(3) }
                    } else if b == 0x1b {
                        ScannerState::SawEsc
                    } else {
                        ScannerState::Idle
                    }
                }
                ScannerState::InOscPrefix { mut digits } => {
                    if b.is_ascii_digit() && digits.len() < 4 {
                        digits.push(b);
                        ScannerState::InOscPrefix { digits }
                    } else if b == b';' && digits == b"133" {
                        ScannerState::AwaitKind
                    } else if b == 0x07 || b == 0x1b {
                        // Bail on non-133 OSC; back to idle (don't try to
                        // re-feed b — the parser already saw it via alacritty
                        // and we only care about the marker shape).
                        ScannerState::Idle
                    } else {
                        // Not a 133 OSC — give up on this sequence.
                        ScannerState::Idle
                    }
                }
                ScannerState::AwaitKind => {
                    match b {
                        b'A' | b'B' | b'C' | b'D' => {
                            self.payload.clear();
                            ScannerState::InPayload { kind: b as char }
                        }
                        _ => ScannerState::Idle,
                    }
                }
                ScannerState::InPayload { kind } => {
                    if b == 0x07 {
                        // BEL terminator → finalise.
                        out.push((kind, parse_d_exit(kind, &self.payload)));
                        self.payload.clear();
                        ScannerState::Idle
                    } else if b == 0x1b {
                        ScannerState::PayloadSawEsc { kind }
                    } else {
                        // Bound the payload to 64 bytes to defend against a
                        // pathological stream that never terminates a 133;X
                        // sequence.
                        if self.payload.len() < 64 {
                            self.payload.push(b);
                        }
                        ScannerState::InPayload { kind }
                    }
                }
                ScannerState::PayloadSawEsc { kind } => {
                    if b == b'\\' {
                        // ST terminator → finalise.
                        out.push((kind, parse_d_exit(kind, &self.payload)));
                        self.payload.clear();
                        ScannerState::Idle
                    } else {
                        // Stray ESC inside payload; abandon this marker.
                        self.payload.clear();
                        ScannerState::Idle
                    }
                }
            };
        }
        out
    }
}

/// Synchronized-output scanner (DECSET 2026, "BSU/ESU").
///
/// A program wraps a whole repaint in `CSI ? 2026 h` … `CSI ? 2026 l` to say
/// "do not paint until I am done" — without it a frame split across PTY reads
/// can be presented half-updated (tearing).
///
/// MADE must implement this itself: alacritty_terminal 0.24.2 explicitly
/// IGNORES the mode (`NamedPrivateMode::SyncUpdate => ()` in both its set and
/// unset handlers, and it reports the mode as Reset). Upstream alacritty does
/// the buffering in its event loop, which MADE does not use — it drives the
/// Term directly. So the Term carries no flag to read and the gate lives here.
///
/// This must land BEFORE MADE advertises a TERM_PROGRAM: Claude gates
/// `syncOutput` on recognising the terminal, so claiming an identity without
/// this would switch on exactly the tearing it prevents.
pub(crate) struct SyncOutputScanner {
    /// Bytes of `\x1b[?2026` matched so far.
    matched: usize,
}

/// The literal prefix shared by BSU and ESU; the next byte is 'h' or 'l'.
const SYNC_PREFIX: &[u8] = b"\x1b[?2026";

/// Longest a synchronized update may hold the screen. The DEC spec makes this
/// a required escape hatch: a program that crashes between BSU and ESU must not
/// freeze the pane forever.
pub(crate) const SYNC_TIMEOUT_MS: u128 = 150;

impl SyncOutputScanner {
    pub(crate) fn new() -> Self {
        Self { matched: 0 }
    }

    /// Returns the LAST begin/end transition seen in this batch, if any.
    /// `Some(true)` = ended inside a synchronized update, `Some(false)` = the
    /// update closed. Only the final transition matters: the caller's question
    /// is simply "may I paint now".
    pub(crate) fn feed(&mut self, bytes: &[u8]) -> Option<bool> {
        let mut last: Option<bool> = None;
        for &b in bytes {
            if self.matched == SYNC_PREFIX.len() {
                // Prefix complete — this byte selects begin vs end.
                match b {
                    b'h' => last = Some(true),
                    b'l' => last = Some(false),
                    _ => {}
                }
                self.matched = 0;
                continue;
            }
            if b == SYNC_PREFIX[self.matched] {
                self.matched += 1;
            } else {
                // Restart, but allow this byte to begin a fresh match so
                // "\x1b\x1b[?2026h" is not missed.
                self.matched = usize::from(b == SYNC_PREFIX[0]);
            }
        }
        last
    }
}

/// Desktop-notification + progress OSC scanner.
///
/// Claude Code can emit a notification when it wants attention; which sequence
/// depends on its `notifChannel` setting: iTerm2 (OSC 9), Kitty (OSC 99),
/// Ghostty (OSC 777), or the bell. It can also emit ConEmu progress (OSC 9;4)
/// when "Emit OSC 9;4 progress sequences during long operations" is on.
///
/// OSC 9 is OVERLOADED and the two meanings must not be confused:
///   OSC 9 ; <text>              -> notification, body = text
///   OSC 9 ; 4 ; <st> ; <pct>    -> progress (ConEmu), NOT a notification
/// so a payload beginning `4;` is routed to progress.
///
/// Runs as a pre-scan beside Osc133Scanner because alacritty_terminal does not
/// surface these OSCs to its EventListener.
pub(crate) struct OscNotifyScanner {
    state: NotifyState,
    digits: Vec<u8>,
    payload: Vec<u8>,
}

enum NotifyState {
    Idle,
    SawEsc,
    InPrefix,
    InPayload { osc: u16 },
    PayloadSawEsc { osc: u16 },
}

/// What a completed OSC resolved to.
pub(crate) enum OscNotifyEvent {
    /// Desktop notification: (title, body). Title may be empty.
    Notify(String, String),
    /// ConEmu progress: (state, percent). state 0 = clear, 1 = normal,
    /// 2 = error, 3 = indeterminate, 4 = paused/warning.
    Progress(u8, u8),
}

/// Payloads are bounded — a stream that never terminates an OSC must not grow
/// memory without limit.
const NOTIFY_PAYLOAD_CAP: usize = 2048;

impl OscNotifyScanner {
    pub(crate) fn new() -> Self {
        Self {
            state: NotifyState::Idle,
            digits: Vec::with_capacity(4),
            payload: Vec::with_capacity(64),
        }
    }

    pub(crate) fn feed(&mut self, bytes: &[u8]) -> Vec<OscNotifyEvent> {
        let mut out = Vec::new();
        for &b in bytes {
            let prev = std::mem::replace(&mut self.state, NotifyState::Idle);
            self.state = match prev {
                NotifyState::Idle => {
                    if b == 0x1b { NotifyState::SawEsc } else { NotifyState::Idle }
                }
                NotifyState::SawEsc => {
                    if b == b']' {
                        self.digits.clear();
                        NotifyState::InPrefix
                    } else if b == 0x1b {
                        NotifyState::SawEsc
                    } else {
                        NotifyState::Idle
                    }
                }
                NotifyState::InPrefix => {
                    if b.is_ascii_digit() && self.digits.len() < 4 {
                        self.digits.push(b);
                        NotifyState::InPrefix
                    } else if b == b';' {
                        let osc: u16 = std::str::from_utf8(&self.digits)
                            .ok()
                            .and_then(|d| d.parse().ok())
                            .unwrap_or(0);
                        if matches!(osc, 9 | 99 | 777) {
                            self.payload.clear();
                            NotifyState::InPayload { osc }
                        } else {
                            NotifyState::Idle
                        }
                    } else {
                        NotifyState::Idle
                    }
                }
                NotifyState::InPayload { osc } => {
                    if b == 0x07 {
                        if let Some(ev) = finish_notify(osc, &self.payload) { out.push(ev); }
                        self.payload.clear();
                        NotifyState::Idle
                    } else if b == 0x1b {
                        NotifyState::PayloadSawEsc { osc }
                    } else {
                        if self.payload.len() < NOTIFY_PAYLOAD_CAP { self.payload.push(b); }
                        NotifyState::InPayload { osc }
                    }
                }
                NotifyState::PayloadSawEsc { osc } => {
                    if b == b'\\' {
                        if let Some(ev) = finish_notify(osc, &self.payload) { out.push(ev); }
                        self.payload.clear();
                        NotifyState::Idle
                    } else {
                        self.payload.clear();
                        NotifyState::Idle
                    }
                }
            };
        }
        out
    }
}

/// Interpret a completed OSC payload for 9 / 99 / 777.
fn finish_notify(osc: u16, payload: &[u8]) -> Option<OscNotifyEvent> {
    let text = String::from_utf8_lossy(payload);
    match osc {
        9 => {
            // ConEmu progress is OSC 9;4;<state>;<pct> — the payload we hold
            // here already has the leading "9;" consumed, so it starts "4;".
            if let Some(rest) = text.strip_prefix("4;") {
                let mut it = rest.split(';');
                let st: u8 = it.next()?.trim().parse().ok()?;
                let pct: u8 = it.next().unwrap_or("0").trim().parse().unwrap_or(0);
                return Some(OscNotifyEvent::Progress(st, pct.min(100)));
            }
            let body = text.trim();
            if body.is_empty() { return None; }
            Some(OscNotifyEvent::Notify(String::new(), body.to_string()))
        }
        // urxvt/Ghostty: 777;notify;<title>;<body>
        777 => {
            let rest = text.strip_prefix("notify;")?;
            let (title, body) = match rest.split_once(';') {
                Some((t, b)) => (t.trim().to_string(), b.trim().to_string()),
                None => (String::new(), rest.trim().to_string()),
            };
            if title.is_empty() && body.is_empty() { return None; }
            Some(OscNotifyEvent::Notify(title, body))
        }
        // Kitty: 99;<metadata>;<payload>. Only the common single-chunk plain
        // text form is handled; chunked/encoded variants are ignored rather
        // than half-decoded into gibberish.
        99 => {
            let (_meta, body) = text.split_once(';')?;
            let body = body.trim();
            if body.is_empty() { return None; }
            Some(OscNotifyEvent::Notify(String::new(), body.to_string()))
        }
        _ => None,
    }
}

/// Extract the exit code from a D-marker payload. Payload shape is
/// ";<digits>[;...]" — we skip the leading ';' and parse digits until a
/// non-digit. Returns None for A/B/C (no exit code) or when D has no
/// numeric payload.
fn parse_d_exit(kind: char, payload: &[u8]) -> Option<i32> {
    if kind != 'D' {
        return None;
    }
    // Skip optional leading ';'.
    let mut i = 0usize;
    if payload.first() == Some(&b';') {
        i = 1;
    }
    // Allow leading '-' for negative exit codes.
    let mut sign = 1i32;
    if payload.get(i) == Some(&b'-') {
        sign = -1;
        i += 1;
    }
    let mut acc: i32 = 0;
    let mut any = false;
    while let Some(&b) = payload.get(i) {
        if !b.is_ascii_digit() {
            break;
        }
        acc = acc.saturating_mul(10).saturating_add((b - b'0') as i32);
        any = true;
        i += 1;
    }
    if any {
        Some(sign * acc)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    //! R1.a evidence test. Run with:
    //!   `cargo test --manifest-path src-tauri/Cargo.toml native_term::parser_bridge -- --nocapture`
    //! Demonstrates a synthetic PTY-byte stream driving the parser end-to-end,
    //! producing the per-batch eprintln evidence team-lead asked for.

    use super::*;
    use crate::native_term::pty_route;

    #[test]
    fn r1_a_smoke_two_batches() {
        let term_id: u32 = 9001; // arbitrary, distinct from any real session
        let rx = pty_route::create_channel(term_id);

        // Simulate the shape of pty.rs's side-channel emission: borrow the
        // Sender out of the registry and push two byte batches mimicking
        // what a real `ls\n` followed by a prompt redraw would look like.
        let tx = pty_route::sender_for_test(term_id).expect("sender registered");

        // Batch 1: "hello\r\n"
        tx.send(b"hello\r\n".to_vec()).unwrap();
        // Batch 2: "user@host:~$ " — a prompt line, includes a control char (CR
        // is the trickiest case because vte's state machine is byte-driven).
        tx.send(b"user@host:~$ ".to_vec()).unwrap();

        // Drop the sender so the worker's recv loop terminates cleanly after
        // both batches are drained. close_channel also drops the registry's
        // Sender, after which the worker's recv() returns Err.
        drop(tx);
        pty_route::close_channel(term_id);

        // P3b: hwnd 0 → the wake never posts (no HWND in a headless test);
        // batches still count, which is all the assertion path needs.
        let bridge = ParserBridge::spawn(
            term_id,
            80,
            24,
            10_000,
            rx,
            Arc::new(Mutex::new((9.0, 17.0))),
            Arc::new(RenderWake::new(0)),
            None,
        );

        // Join the worker by dropping the bridge after a brief settle. In a
        // real session the bridge lives for the term's lifetime.
        std::thread::sleep(std::time::Duration::from_millis(50));

        // Snapshot the post-parse cursor + last line so the test asserts
        // SOMETHING (not just "no panic"). After "hello\n" + "user@host:~$ "
        // the cursor should be on line 1 (0-indexed), column 13 (after the
        // prompt's trailing space).
        let t = bridge.term.lock().unwrap();
        let pt = t.grid().cursor.point;
        eprintln!(
            "[R1.a smoke] final cursor=(line={}, col={})",
            pt.line.0, pt.column.0
        );
        // Loose assertion: after two batches we expect to be past line 0.
        assert!(
            pt.line.0 >= 1,
            "expected cursor to advance past line 0 after \\r\\n; got line={}",
            pt.line.0
        );
    }
}

/// Pull the line containing the cursor, trimmed of trailing whitespace, max
/// 80 visible chars. R1.a-only diagnostic — R1.b will read the full grid.
fn capture_last_line(term: &Term<TermListener>) -> String {
    use alacritty_terminal::index::{Column, Line};
    let grid = term.grid();
    let line = grid.cursor.point.line;
    let cols = grid.columns();
    let mut s = String::with_capacity(80);
    for c in 0..cols {
        let cell = &grid[Line(line.0)][Column(c)];
        let ch = cell.c;
        if ch == '\u{0}' {
            break;
        }
        s.push(ch);
        if s.chars().count() >= 80 {
            s.push('…');
            break;
        }
    }
    let trimmed = s.trim_end().to_string();
    // escape for eprintln safety — replace control chars with their hex form
    trimmed
        .chars()
        .map(|c| if (c as u32) < 0x20 { format!("\\x{:02x}", c as u32) } else { c.to_string() })
        .collect()
}
