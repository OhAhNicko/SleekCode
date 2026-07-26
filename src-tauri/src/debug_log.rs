//! TEMPORARY diagnostic logger for the "pointer vibrates after closing a
//! dropdown" investigation (2026-07-26). Debug builds only; appends
//! epoch-stamped lines to `%TEMP%\made-flicker\jitter.log` so the user can
//! reproduce on their own machine and the native-side ops can be read back on
//! ONE timeline. REMOVE once the root cause is fixed.

#[cfg(debug_assertions)]
use std::io::Write;

#[cfg(debug_assertions)]
static LOG: std::sync::Mutex<Option<std::fs::File>> = std::sync::Mutex::new(None);

#[cfg(debug_assertions)]
pub fn dlog(line: &str) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut guard = match LOG.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if guard.is_none() {
        let dir = std::env::temp_dir().join("made-flicker");
        let _ = std::fs::create_dir_all(&dir);
        match std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("jitter.log"))
        {
            Ok(f) => *guard = Some(f),
            Err(_) => return,
        }
    }
    if let Some(f) = guard.as_mut() {
        let _ = writeln!(f, "{now} {line}");
        let _ = f.flush();
    }
}

#[cfg(not(debug_assertions))]
pub fn dlog(_line: &str) {}
