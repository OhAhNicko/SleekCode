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

use crossbeam_channel::Receiver;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::vte::ansi::Processor;
use tauri::AppHandle;

use super::events::{emit_cursor, emit_osc133, emit_scroll, Cursor, Osc133, Scroll as ScrollEvt};

/// Minimal `Dimensions` impl for `Term::new`. Mirrors alacritty's internal
/// test `TermSize` since the public `Dimensions` trait is what `Term::new`
/// actually requires.
#[derive(Clone, Copy)]
struct TermDims {
    columns: usize,
    screen_lines: usize,
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
}

impl EventListener for TermListener {
    fn send_event(&self, event: Event) {
        match event {
            Event::Title(s) => eprintln!("[native_term] term {} title='{}'", self.term_id, s),
            Event::ResetTitle => eprintln!("[native_term] term {} title reset", self.term_id),
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

/// Public handle to the parser-bridge for a single native_term_id. Owns the
/// worker thread (joined on Drop) and the shared Term (held behind a mutex
/// so future `get_buffer_lines` / `get_viewport_state` commands can snapshot
/// it cheaply).
pub struct ParserBridge {
    pub term: Arc<Mutex<Term<TermListener>>>,
    _worker: JoinHandle<()>,
}

impl ParserBridge {
    /// Spawn a bridge for `term_id`. Caller must have already called
    /// `pty_route::create_channel(term_id)` and own the corresponding
    /// `Receiver<Vec<u8>>`. The worker thread takes ownership of the receiver.
    ///
    /// `cell_w`/`line_h` are the renderer's per-cell logical-px metrics, used
    /// to translate the alacritty cursor grid position into pane-local pixel
    /// coords for the `cursor` Tauri event. `app` is the AppHandle the worker
    /// emits with — `None` disables cursor emission (used by tests where no
    /// Tauri app is initialised).
    pub fn spawn(
        term_id: u32,
        cols: usize,
        screen_lines: usize,
        rx: Receiver<Vec<u8>>,
        cell_w: f32,
        line_h: f32,
        app: Option<AppHandle>,
    ) -> Self {
        let dims = TermDims { columns: cols, screen_lines };
        let listener = TermListener { term_id };
        let term = Arc::new(Mutex::new(Term::new(Config::default(), &dims, listener)));

        let term_for_worker = Arc::clone(&term);
        let worker = std::thread::Builder::new()
            .name(format!("native_term-{}-parser", term_id))
            .spawn(move || worker_loop(term_id, term_for_worker, rx, cell_w, line_h, app))
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
    cell_w: f32,
    line_h: f32,
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

    // R3 scroll-coalescer. We cache the last emitted display_offset and rate-
    // limit emissions to ~50ms so smooth wheel scrolling doesn't flood the bus.
    let mut last_emitted_offset: Option<usize> = None;
    let mut last_scroll_emit = std::time::Instant::now();
    const SCROLL_COALESCE_MS: u128 = 50;

    while let Ok(bytes) = rx.recv() {
        batches += 1;
        total_bytes += bytes.len() as u64;

        // 1) Pre-scan for OSC 133 markers. Done BEFORE the alacritty parse so
        //    a marker spanning two batches still resolves (state machine is
        //    persisted across batches via osc_scanner.state). Each hit
        //    carries its end_offset into `bytes` so we can split the parse
        //    at that boundary and snapshot the cursor per-marker.
        let osc_hits: Vec<Osc133Hit> = osc_scanner.feed(&bytes);

        // 2) Lock the Term across the whole batch — single contiguous parse,
        //    no .await inside. Other readers (get_buffer_lines etc.) wait
        //    briefly. Keep this window TIGHT: no Tauri emits while held.
        //
        //    We split the parse at each OSC 133 boundary so the cursor line
        //    we snapshot for each marker reflects what was on screen WHEN
        //    the marker landed — not the post-batch cursor. Without this,
        //    a `prompt;output` pair in the same batch would attribute both
        //    markers to the output's final line.
        let mut t = term.lock().expect("parser_bridge term mutex poisoned");
        let mut marker_snapshots: Vec<(char, Option<i32>, i64)> =
            Vec::with_capacity(osc_hits.len());
        let mut last_offset = 0usize;
        for hit in &osc_hits {
            for byte in &bytes[last_offset..hit.end_offset] {
                processor.advance(&mut *t, *byte);
            }
            let history_at_marker = t.grid().history_size() as i64;
            let cursor_line_at_marker: i64 = t.grid().cursor.point.line.0 as i64;
            marker_snapshots.push((
                hit.kind,
                hit.exit_code,
                history_at_marker + cursor_line_at_marker,
            ));
            last_offset = hit.end_offset;
        }
        // Drive any remaining post-final-marker tail through the parser.
        for byte in &bytes[last_offset..] {
            processor.advance(&mut *t, *byte);
        }
        let pt = t.grid().cursor.point;
        let snippet = capture_last_line(&t);
        let history = t.grid().history_size() as i64;
        let display_offset_now = t.grid().display_offset();
        drop(t); // release before any eprintln / app.emit

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
            let x = pt.column.0 as f32 * cell_w;
            let y = pt.line.0 as f32 * line_h;
            let key = (x.round() as i32, y.round() as i32);
            if last_cursor != Some(key) {
                last_cursor = Some(key);
                emit_cursor(app, term_id, Cursor { x, y, h: line_h });
            }

            // OSC 133 emit fan-out. Each marker now carries its own
            // abs_line snapshot taken at the moment the marker terminator
            // landed in the parser — see the marker_snapshots loop above.
            // Mixed prompt+output batches now attribute the two markers
            // to their actual on-screen lines.
            for (kind_char, exit_code, abs_line_at_marker) in marker_snapshots {
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
                    Osc133 { kind, exit_code, abs_line: abs_line_at_marker },
                );
            }

            // Scroll: emit when display_offset has changed AND we're past the
            // 50ms coalesce window. base_y = -history_size; viewport_y =
            // base_y + display_offset → mirrors the JS ViewportState math.
            if last_emitted_offset != Some(display_offset_now) {
                let now = std::time::Instant::now();
                if now.duration_since(last_scroll_emit).as_millis()
                    >= SCROLL_COALESCE_MS
                {
                    last_emitted_offset = Some(display_offset_now);
                    last_scroll_emit = now;
                    let base_y = -(history);
                    let viewport_y = base_y + display_offset_now as i64;
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

/// One fully-parsed OSC 133 marker hit. `end_offset` is the byte index INTO
/// the batch slice the scanner was fed where the marker's terminator ends —
/// in other words, the start of the post-marker tail. The worker loop splits
/// its alacritty parse at these boundaries so each marker's emitted
/// `abs_line` reflects the cursor at the moment the marker landed (not the
/// post-batch cursor).
struct Osc133Hit {
    kind: char,
    exit_code: Option<i32>,
    end_offset: usize,
}

/// State machine for finding OSC 133 prompt markers in the raw PTY byte
/// stream. Persists across `feed()` calls so a sequence split across two
/// batches still resolves. Each `feed()` call returns one `Osc133Hit` per
/// fully-parsed marker.
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

    /// Drive the state machine across one batch of bytes. For each fully
    /// terminated `ESC ] 133 ; X ... (BEL|ST)` sequence, append a hit
    /// describing the marker. `end_offset` is the index INTO `bytes` of the
    /// byte immediately AFTER the terminator — so `bytes[..end_offset]`
    /// contains the marker. The worker_loop uses this to split the alacritty
    /// parse at each marker boundary and snapshot the live cursor line
    /// per-marker (mirrors what xterm-aware shells expect).
    fn feed(&mut self, bytes: &[u8]) -> Vec<Osc133Hit> {
        let mut out: Vec<Osc133Hit> = Vec::new();
        for (i, &b) in bytes.iter().enumerate() {
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
                        // BEL terminator → finalise. end_offset is i+1: the
                        // terminator is part of the marker, and the next
                        // post-marker byte begins at i+1.
                        out.push(Osc133Hit {
                            kind,
                            exit_code: parse_d_exit(kind, &self.payload),
                            end_offset: i + 1,
                        });
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
                        // ST terminator → finalise. The full terminator is
                        // two bytes (ESC \), both of which precede position
                        // i+1; the start of the post-marker tail is i+1.
                        out.push(Osc133Hit {
                            kind,
                            exit_code: parse_d_exit(kind, &self.payload),
                            end_offset: i + 1,
                        });
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

        let bridge = ParserBridge::spawn(term_id, 80, 24, rx, 9.0, 17.0, None);

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
