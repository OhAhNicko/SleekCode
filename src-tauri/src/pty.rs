use std::collections::HashMap;
use std::io::{Read as IoRead, Write as IoWrite};
use std::sync::{
    atomic::{AtomicU32, Ordering},
    Mutex, OnceLock,
};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::ipc::Channel;

// --- Active PTY sessions ---

struct PtySession {
    writer: Box<dyn IoWrite + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
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
    on_data: Channel<Vec<u8>>,
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
                    if on_data.send(buf[..n].to_vec()).is_err() {
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
    on_data: Channel<Vec<u8>>,
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

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    sessions()
        .lock()
        .unwrap()
        .insert(id, PtySession { writer, master: pair.master });

    start_reader_thread(id, reader, child, on_data, on_exit);

    Ok(id)
}

/// Pre-warm the WSL pool with idle bash sessions (fire-and-forget).
/// Each session runs `wsl.exe -e bash` waiting for a command via `read`.
/// Returns the number of warm-up threads launched.
#[tauri::command]
pub async fn pty_pool_warm(count: u32, distro: Option<String>) -> Result<u32, String> {
    // Remember distro so auto-replenishment in pty_spawn_pooled knows what to spawn.
    *pool_distro().lock().unwrap() = distro.clone();

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
    on_data: Channel<Vec<u8>>,
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
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())
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
