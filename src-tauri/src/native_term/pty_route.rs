// PTY-to-native-terminal byte routing.
//
// `pty.rs::start_reader_thread` reads bytes from the PTY master and currently
// forwards them to JS via the existing Tauri Channel. In R1 we add a *side*
// channel: when a native-term-id is attached to a pty-id (via the public
// `link` function), pty.rs side-emits the byte slice into a bounded crossbeam
// channel. The native-term's parser_bridge worker thread drains it.
//
// **Bounded(64)** per migration plan risk #3 — we use `try_send` so a stalled
// consumer is dropped on the floor rather than back-pressuring the PTY reader.
// R1 keeps the JS branch authoritative; native route is observe-only. R1.c
// flips the source of truth once the production command surface lands.

use crossbeam_channel::{bounded, Receiver, Sender};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// Channel capacity (bytes-blocks, not bytes). One unit is a single
/// `Vec<u8>` matching what pty.rs reads in its 64KiB buffer.
const CHANNEL_CAPACITY: usize = 64;

/// Map: native_term_id → Sender. Set on `link(term_id, pty_id)`.
type SenderMap = HashMap<u32, Sender<Vec<u8>>>;
/// Map: pty_id → native_term_id. Reverse-lookup so pty.rs's reader can find
/// the term-id from the pty-id it already owns.
type PtyToTermMap = HashMap<u32, u32>;

fn senders() -> &'static Mutex<SenderMap> {
    static SENDERS: OnceLock<Mutex<SenderMap>> = OnceLock::new();
    SENDERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn pty_to_term() -> &'static Mutex<PtyToTermMap> {
    static MAP: OnceLock<Mutex<PtyToTermMap>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Create the crossbeam channel for `term_id` and return the consumer end.
/// Called by `parser_bridge::spawn(term_id)`. Idempotent — a second call for
/// the same term_id replaces the previous channel (drops any pending bytes).
pub fn create_channel(term_id: u32) -> Receiver<Vec<u8>> {
    let (tx, rx) = bounded(CHANNEL_CAPACITY);
    senders().lock().expect("pty_route senders poisoned").insert(term_id, tx);
    rx
}

/// Wire a pty_id to a term_id so pty.rs's reader side-emits into the term's
/// channel. Both maps updated atomically (sender map first to avoid a window
/// where pty.rs sees a link but the channel doesn't exist yet).
pub fn link(term_id: u32, pty_id: u32) {
    // Reverse map only — the sender side was already populated by
    // `create_channel`. If create wasn't called yet, we still link; the
    // sender_for() lookup will silently no-op until create_channel runs.
    pty_to_term()
        .lock()
        .expect("pty_route pty_to_term poisoned")
        .insert(pty_id, term_id);
}

/// Reverse of `link` — break the routing. Called when a native_term detaches
/// or is destroyed. Does NOT drop the channel itself (the parser_bridge
/// worker thread owns the Receiver and decides when to stop draining).
pub fn unlink(pty_id: u32) {
    pty_to_term()
        .lock()
        .expect("pty_route pty_to_term poisoned")
        .remove(&pty_id);
}

/// Drop the channel for `term_id`. Closes the Sender side; the worker
/// thread's `recv()` will return Err and it can exit cleanly.
pub fn close_channel(term_id: u32) {
    senders().lock().expect("pty_route senders poisoned").remove(&term_id);
}

/// Called from `pty.rs::start_reader_thread` on every read. Returns the
/// Sender corresponding to the term_id linked to `pty_id`, if any.
///
/// Cloning the Sender is cheap (Arc internally). We clone-and-return rather
/// than holding the mutex across the try_send so PTY reads don't serialize.
pub fn sender_for(pty_id: u32) -> Option<Sender<Vec<u8>>> {
    let term_id = pty_to_term()
        .lock()
        .expect("pty_route pty_to_term poisoned")
        .get(&pty_id)
        .copied()?;
    senders()
        .lock()
        .expect("pty_route senders poisoned")
        .get(&term_id)
        .cloned()
}

/// Test-only direct sender lookup by term_id, bypassing the pty→term map.
/// Used in parser_bridge's R1.a smoke test where there's no real PTY.
#[cfg(test)]
pub fn sender_for_test(term_id: u32) -> Option<Sender<Vec<u8>>> {
    senders()
        .lock()
        .expect("pty_route senders poisoned")
        .get(&term_id)
        .cloned()
}

/// Direct sender lookup by term_id — non-test variant for the
/// `native_term_debug_inject_bytes` command. Lets the spike feed synthetic
/// SGR sequences straight into the parser without going through a PTY.
/// Bypasses the pty→term map deliberately.
pub fn sender_for_term(term_id: u32) -> Option<Sender<Vec<u8>>> {
    senders()
        .lock()
        .expect("pty_route senders poisoned")
        .get(&term_id)
        .cloned()
}
