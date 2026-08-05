use std::collections::HashMap;
use std::io::{Read as IoRead, Write as IoWrite};
use std::sync::{
    atomic::{AtomicU32, Ordering},
    Mutex, OnceLock,
};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::ipc::{Channel, InvokeResponseBody};

// --- Active PTY sessions ---

struct PtySession {
    writer: Box<dyn IoWrite + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    /// The child is an `ssh` client, so everything written here crosses a
    /// network before any program reads it. Gates `is_bare_motion_report`.
    is_ssh: bool,
}

/// True when `data` is EXACTLY one SGR mouse report for pointer motion with no
/// button held: `\e[<{btn};{col};{row}M` where bit 32 (motion) is set, the low
/// two bits are 3 (no button) and bit 64 (wheel) is clear — i.e. 35, 39, 43,
/// 47, 51, 55, 59, 63 once modifier bits are counted.
///
/// Any-motion mode (DECSET 1003) emits one of these per cell the pointer
/// crosses, which makes them by far the highest-rate thing MADE writes to a
/// PTY. Locally that is harmless — the reader drains them immediately. Over
/// SSH they share reads with the user's actual keystrokes on the far side, and
/// the CLIs we drive (all Ink-based) parse keypresses per read rather than
/// keeping parser state across them, so a chord that lands in the same read as
/// a motion report gets mangled and its tail is inserted into the composer as
/// literal text. Clicks, wheel and button-held drag reports are NOT dropped —
/// they are low-rate and programs act on them.
///
/// Exact-match only, deliberately: a paste whose text happens to contain these
/// bytes is left alone, and so is any chunk carrying a report plus real input.
fn is_bare_motion_report(data: &[u8]) -> bool {
    let Some(rest) = data.strip_prefix(b"\x1b[<") else {
        return false;
    };
    let Some(rest) = rest.strip_suffix(b"M") else {
        return false;
    };
    let mut parts = rest.split(|b| *b == b';');
    let (Some(btn), Some(col), Some(row), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    if col.is_empty()
        || row.is_empty()
        || !col.iter().all(u8::is_ascii_digit)
        || !row.iter().all(u8::is_ascii_digit)
    {
        return false;
    }
    match std::str::from_utf8(btn)
        .ok()
        .and_then(|s| s.parse::<u32>().ok())
    {
        Some(n) => n & 32 != 0 && n & 3 == 3 && n < 64,
        None => false,
    }
}

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

fn sessions() -> &'static Mutex<HashMap<u32, PtySession>> {
    static SESSIONS: OnceLock<Mutex<HashMap<u32, PtySession>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn start_reader_thread(
    id: u32,
    reader: Box<dyn IoRead + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<i32>,
) {
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut child = child;
        let mut buf = [0u8; 65536];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // Native-terminal side-channel: when a native_term is
                    // attached to this pty_id, mirror the byte slice into the
                    // parser bridge's crossbeam channel. Bounded(64) + try_send
                    // means a stalled consumer is dropped, not back-pressured.
                    // The JS branch below stays authoritative during rollout.
                    if let Some(tx) = crate::native_term::pty_route::sender_for(id) {
                        let _ = tx.try_send(buf[..n].to_vec());
                    }
                    // Raw body: delivered to JS as an ArrayBuffer. The default
                    // Serialize path turned each chunk into a JSON array of
                    // numbers (~4x the bytes) that the main webview then had to
                    // JSON.parse on its UI thread — under heavy output that
                    // backlog is what delayed every overlay popup (menus took
                    // seconds to appear).
                    if on_data
                        .send(InvokeResponseBody::Raw(buf[..n].to_vec()))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let code = match child.wait() {
            Ok(s) => {
                if s.success() {
                    0
                } else {
                    1
                }
            }
            Err(_) => -1,
        };
        let _ = on_exit.send(code);
        sessions().lock().unwrap().remove(&id);
    });
}

// --- Pre-warmed WSL pool ---

struct PooledWsl {
    writer: Box<dyn IoWrite + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    reader: Box<dyn IoRead + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

const WSL_POOL_MAX: usize = 16;

fn wsl_pool() -> &'static Mutex<Vec<PooledWsl>> {
    static POOL: OnceLock<Mutex<Vec<PooledWsl>>> = OnceLock::new();
    POOL.get_or_init(|| Mutex::new(Vec::new()))
}

/// Kill and drop every pre-warmed session. Must run after `wsl --shutdown`
/// (see wsl_health::wsl_shutdown): the pooled bash processes are corpses, and
/// `pty_spawn_pooled` handing one to the next fresh AI pane makes that pane
/// exit the moment it opens.
pub(crate) fn flush_wsl_pool() {
    let mut pool = wsl_pool().lock().unwrap();
    for mut p in pool.drain(..) {
        let _ = p.child.kill();
    }
}

/// Stores the distro used for pooled sessions so auto-replenishment knows what to spawn.
fn pool_distro() -> &'static Mutex<Option<String>> {
    static DISTRO: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    DISTRO.get_or_init(|| Mutex::new(None))
}

fn spawn_one_wsl(distro: Option<String>) -> Result<PooledWsl, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new("wsl.exe");
    if let Some(ref d) = distro {
        cmd.args(["-d", d]);
    }
    // Bash waits silently for a command, then evals it.
    // stty -echo: don't echo the init command we send.
    // read -r: read one line (the init command) from PTY input.
    // After eval, exec replaces bash with the target CLI.
    cmd.args([
        "-e", "bash", "--norc", "--noprofile", "-c",
        // \x01 signals that stty -echo has run and read is waiting.
        // We drain this byte before pushing to pool so callers never race with echo.
        // No stty echo restore — the exec'd CLI sets its own terminal mode.
        "stty -echo 2>/dev/null; printf '\\001'; IFS= read -r cmd; eval \"$cmd\"",
    ]);

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    // Drain until the ready signal (\x01) — guarantees stty -echo is active before
    // this session is used. Running in a background thread so blocking read is fine.
    {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut buf = [0u8; 64];
        while std::time::Instant::now() < deadline {
            match reader.read(&mut buf) {
                Ok(n) if n > 0 => {
                    if buf[..n].contains(&1u8) { break; }
                }
                _ => break, // EOF or error — bash died, proceed anyway
            }
        }
    }

    Ok(PooledWsl {
        writer,
        master: pair.master,
        reader,
        child,
    })
}

// --- Commands ---

#[tauri::command]
pub async fn pty_spawn(
    command: String,
    args: Vec<String>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    env: HashMap<String, String>,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<i32>,
) -> Result<u32, String> {
    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&command);
    cmd.args(&args);
    if let Some(ref dir) = cwd {
        cmd.cwd(dir);
    }
    for (key, val) in &env {
        cmd.env(key, val);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    // Matches `ssh` and `ssh.exe`, bare or fully qualified — getSshCommand
    // (terminal-config.ts) is the only thing that spawns either.
    let is_ssh = std::path::Path::new(&command)
        .file_stem()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("ssh"));

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    sessions()
        .lock()
        .unwrap()
        .insert(id, PtySession { writer, master: pair.master, is_ssh });

    start_reader_thread(id, reader, child, on_data, on_exit);

    Ok(id)
}

/// Pre-warm the WSL pool with idle bash sessions (fire-and-forget).
/// Each session runs `wsl.exe -e bash` waiting for a command via `read`.
/// Returns the number of warm-up threads launched.
#[tauri::command]
pub async fn pty_pool_warm(count: u32, distro: Option<String>) -> Result<u32, String> {
    // Remember distro so auto-replenishment in pty_spawn_pooled knows what to spawn.
    // If it CHANGED (user picked another distro in Settings), the pooled bash
    // sessions are all inside the old distro — flush them or the next fresh AI
    // pane silently opens in the wrong distro.
    {
        let mut stored = pool_distro().lock().unwrap();
        if *stored != distro {
            *stored = distro.clone();
            drop(stored);
            flush_wsl_pool();
        }
    }

    let current_size = wsl_pool().lock().unwrap().len();
    let to_spawn = (count as usize).min(WSL_POOL_MAX.saturating_sub(current_size));

    for _ in 0..to_spawn {
        let d = distro.clone();
        std::thread::spawn(move || {
            match spawn_one_wsl(d) {
                Ok(pooled) => {
                    wsl_pool().lock().unwrap().push(pooled);
                }
                Err(e) => {
                    eprintln!("[pty-pool] Failed to warm WSL session: {}", e);
                }
            }
        });
    }

    Ok(to_spawn as u32)
}

/// Spawn a CLI inside a pre-warmed WSL session (near-instant).
/// Sends `init_command` to the waiting bash, which evals it.
/// Falls back with Err if pool is empty.
#[tauri::command]
pub async fn pty_spawn_pooled(
    init_command: String,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<i32>,
) -> Result<u32, String> {
    let pooled = wsl_pool().lock().unwrap().pop();
    let mut pooled = pooled.ok_or("WSL pool empty")?;

    // Resize to match actual pane dimensions
    pooled
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    // Send the init command to the waiting `read`.
    // Use \r (carriage return) — ConPTY treats this as Enter key press.
    // The terminal driver's icrnl setting translates \r → \n for bash's read.
    pooled
        .writer
        .write_all(format!("{}\r", init_command).as_bytes())
        .map_err(|e| e.to_string())?;

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    sessions().lock().unwrap().insert(
        id,
        PtySession {
            writer: pooled.writer,
            master: pooled.master,
            // The pool is local WSL bash only — never ssh.
            is_ssh: false,
        },
    );

    start_reader_thread(id, pooled.reader, pooled.child, on_data, on_exit);

    // Auto-replenish: queue a new session so the pool stays healthy after each use.
    let d = pool_distro().lock().unwrap().clone();
    std::thread::spawn(move || {
        if wsl_pool().lock().unwrap().len() < WSL_POOL_MAX {
            if let Ok(new_session) = spawn_one_wsl(d) {
                let mut pool = wsl_pool().lock().unwrap();
                if pool.len() < WSL_POOL_MAX {
                    pool.push(new_session);
                }
            }
        }
    });

    Ok(id)
}

#[tauri::command]
pub async fn pty_write(pty_id: u32, data: String) -> Result<(), String> {
    let mut map = sessions().lock().unwrap();
    let session = map.get_mut(&pty_id).ok_or("PTY not found")?;
    if session.is_ssh && is_bare_motion_report(data.as_bytes()) {
        return Ok(());
    }
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())
}

/// Synchronous byte-level write to a PTY. Used by native_term's win32 wnd_proc
/// to forward keyboard input directly without an async round-trip. Returns
/// true on success, false if the PTY doesn't exist or the write failed —
/// silent failure is the right policy from a window message handler.
pub fn write_to_pty_sync(pty_id: u32, data: &[u8]) -> bool {
    let mut map = match sessions().lock() {
        Ok(m) => m,
        Err(_) => return false,
    };
    match map.get_mut(&pty_id) {
        // Dropped on purpose — report success so the caller doesn't retry.
        Some(s) if s.is_ssh && is_bare_motion_report(data) => true,
        Some(s) => s.writer.write_all(data).is_ok(),
        None => false,
    }
}

/// Synchronous PTY resize. Used by native_term's win32 resize-settle path
/// (`commit_dims`) so the grid → PTY commit happens in one synchronous chain
/// without an async round-trip. Returns true on success, false if the PTY
/// doesn't exist or the resize failed — silent failure is the right policy
/// from a window message handler, mirroring `write_to_pty_sync`.
pub fn resize_pty_sync(pty_id: u32, cols: u16, rows: u16) -> bool {
    let map = match sessions().lock() {
        Ok(m) => m,
        Err(_) => return false,
    };
    match map.get(&pty_id) {
        Some(s) => s
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .is_ok(),
        None => false,
    }
}

#[tauri::command]
pub async fn pty_resize(pty_id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let map = sessions().lock().unwrap();
    let session = map.get(&pty_id).ok_or("PTY not found")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pty_kill(pty_id: u32) -> Result<(), String> {
    sessions().lock().unwrap().remove(&pty_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::is_bare_motion_report;

    #[test]
    fn drops_button_less_motion_including_modifiers() {
        // 35 = motion, no button. +4 shift, +8 meta, +16 ctrl and combinations.
        for btn in [35, 39, 43, 47, 51, 55, 59, 63] {
            let s = format!("\x1b[<{btn};71;35M");
            assert!(is_bare_motion_report(s.as_bytes()), "should drop {btn}");
        }
    }

    #[test]
    fn keeps_clicks_drags_and_wheel() {
        for seq in [
            "\x1b[<0;71;35M",  // left press
            "\x1b[<0;71;35m",  // left release (final byte 'm', not 'M')
            "\x1b[<2;71;35M",  // right press
            "\x1b[<32;71;35M", // motion WITH left held (drag) — programs act on it
            "\x1b[<34;71;35M", // motion with right held
            "\x1b[<64;71;35M", // wheel up
            "\x1b[<65;71;35M", // wheel down
            "\x1b[<67;71;35M", // wheel byte with low bits 3 — bit 64 set, keep
        ] {
            assert!(!is_bare_motion_report(seq.as_bytes()), "should keep {seq:?}");
        }
    }

    #[test]
    fn only_an_exact_whole_report_matches() {
        for seq in [
            "",
            "\x1b[<35;71;35",             // unterminated
            "\x1b[<35;71;35M\x1b[1;5A",   // report + a real chord
            "\x1b[<35;71;35Mx",           // report + a keystroke
            "x\x1b[<35;71;35M",           // keystroke + report
            "\x1b[<35;71;35;9M",          // four params
            "\x1b[<35;71M",               // two params
            "\x1b[<35;;35M",              // empty param
            "\x1b[<;71;35M",              // empty button
            "\x1b[<35;7a;35M",            // non-digit coordinate
            "\x1b[<999999999999;71;35M",  // button overflows u32
            "\x1b[M\x03\x47\x23",         // legacy X10 encoding, not SGR
        ] {
            assert!(!is_bare_motion_report(seq.as_bytes()), "should keep {seq:?}");
        }
    }
}
