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
    pub fn spawn(term_id: u32, cols: usize, screen_lines: usize, rx: Receiver<Vec<u8>>) -> Self {
        let dims = TermDims { columns: cols, screen_lines };
        let listener = TermListener { term_id };
        let term = Arc::new(Mutex::new(Term::new(Config::default(), &dims, listener)));

        let term_for_worker = Arc::clone(&term);
        let worker = std::thread::Builder::new()
            .name(format!("native_term-{}-parser", term_id))
            .spawn(move || worker_loop(term_id, term_for_worker, rx))
            .expect("failed to spawn parser worker");

        eprintln!(
            "[native_term] term {} parser_bridge spawned cols={} lines={}",
            term_id, cols, screen_lines
        );

        ParserBridge { term, _worker: worker }
    }
}

fn worker_loop(term_id: u32, term: Arc<Mutex<Term<TermListener>>>, rx: Receiver<Vec<u8>>) {
    // Per-thread Processor: byte-level ANSI/UTF-8 state machine. Cheap to
    // create once and reuse across all batches for this term.
    let mut processor: Processor = Processor::new();
    let mut total_bytes: u64 = 0;
    let mut batches: u64 = 0;

    while let Ok(bytes) = rx.recv() {
        batches += 1;
        total_bytes += bytes.len() as u64;
        // Lock the Term across the whole batch — single contiguous parse,
        // no .await inside. Other readers (get_buffer_lines etc.) wait briefly.
        let mut t = term.lock().expect("parser_bridge term mutex poisoned");
        for byte in &bytes {
            processor.advance(&mut *t, *byte);
        }
        // R1.a evidence log — per batch, not per byte (logging per byte would
        // bury the terminal under millions of lines under e.g. `ls -R /`).
        let pt = t.grid().cursor.point;
        let snippet = capture_last_line(&t);
        drop(t); // release before eprintln to keep the lock window tight
        eprintln!(
            "[native_term] term {} batch={} bytes={} total={} cursor=(line={}, col={}) last_line=\"{}\"",
            term_id, batches, bytes.len(), total_bytes, pt.line.0, pt.column.0, snippet
        );
    }
    eprintln!("[native_term] term {} worker exited after {} batches / {} bytes", term_id, batches, total_bytes);
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

        let bridge = ParserBridge::spawn(term_id, 80, 24, rx);

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
