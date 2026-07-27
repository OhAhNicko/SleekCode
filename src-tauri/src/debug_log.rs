//! Low-volume diagnostic log.
//!
//! `%TEMP%\made-logs\made-<profile>.log`, where <profile> is `debug` or
//! `release`.
//!
//! WHY THE FILENAME AND BANNER CARRY THE BUILD IDENTITY (2026-07-27): this began
//! as a debug-only logger writing to a single shared `jitter.log`. Once it was
//! enabled for release builds, BOTH a production install and a `tauri:dev`
//! instance appended to the same file, interleaved, with no way to tell which
//! wrote what — and the user was handed a log and asked to say whether it came
//! from production, which the file gave them no way to answer. A diagnostic log
//! that cannot identify its own source is not diagnostic.
//!
//! So: one file per profile, a banner per run naming version / profile / pid /
//! executable path / wall-clock time, and a pid on EVERY line so two instances
//! of the same profile stay separable.
//!
//! Safe to leave on in release: all call sites are one-off events (pane create
//! timing, font/GPU/atlas build, GPU uncaptured errors, surface loss). Nothing
//! here is per-frame. The file is truncated past MAX_BYTES so it cannot grow
//! without bound across runs.

/// Start a fresh file once it passes this, rather than appending forever.
const MAX_BYTES: u64 = 2 * 1024 * 1024;

/// `debug` or `release` — decided at compile time, printed in the banner AND
/// baked into the filename so the two builds can never be confused again.
const PROFILE: &str = if cfg!(debug_assertions) { "debug" } else { "release" };

/// `release v0.2.1` — build identity for callers that stamp it INSIDE their own
/// line rather than relying on the per-run banner.
///
/// The banner names the build once per run, which is enough when you read a log
/// top to bottom. It is not enough for lines that get grepped out and pasted
/// somewhere on their own — the frontend leak probe is exactly that, and the
/// whole point of the 2026-07-27 filename/banner work was that a diagnostic line
/// which cannot identify its own source is not diagnostic. Sourced from the same
/// compile-time constants as the banner so the two can never disagree.
pub fn build_tag() -> String {
    format!("{PROFILE} v{}", env!("CARGO_PKG_VERSION"))
}

/// `2026-07-27T10:31:36.189Z` from epoch millis.
///
/// Self-contained on purpose: this module is a leaf that native_term depends on,
/// and it must stay compilable (and testable) without the crate root. lib.rs has
/// a second-precision `iso8601_utc`; this one carries milliseconds, which is the
/// resolution the timings here are logged at.
///
/// UTC, and it says so with the trailing `Z`. A raw epoch number was what the log
/// used to print, and it defeated its own purpose — nobody can look at
/// `1785111096189` and tell whether it is from today.
fn iso_ms(ms: u128) -> String {
    let secs = (ms / 1000) as i64;
    let millis = (ms % 1000) as u32;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (hh, mi, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // days -> civil date (Howard Hinnant's algorithm), same as lib.rs.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mi:02}:{ss:02}.{millis:03}Z")
}

use std::io::Write;

static LOG: std::sync::Mutex<Option<std::fs::File>> = std::sync::Mutex::new(None);

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
        let dir = std::env::temp_dir().join("made-logs");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join(format!("made-{PROFILE}.log"));
        // Rotate rather than append forever — this now runs in release, across
        // every launch.
        let too_big = std::fs::metadata(&path)
            .map(|m| m.len() > MAX_BYTES)
            .unwrap_or(false);
        match std::fs::OpenOptions::new()
            .create(true)
            .append(!too_big)
            .write(true)
            .truncate(too_big)
            .open(&path)
        {
            Ok(mut f) => {
                // Everything needed to answer "which binary wrote this?" without
                // asking anyone: version, profile, pid, and the exe path — the
                // last one distinguishes an installed production MADE from a
                // `target\debug` one even if the profile were somehow ambiguous.
                let exe = std::env::current_exe()
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|_| "<unknown exe>".into());
                let _ = writeln!(
                    f,
                    "{stamp} [{pid}] ===== MADE {ver} ({PROFILE}) pid={pid} started =====",
                    stamp = iso_ms(now),
                    ver = env!("CARGO_PKG_VERSION"),
                    pid = std::process::id(),
                );
                let _ = writeln!(
                    f,
                    "{} [{}] exe={exe}",
                    iso_ms(now),
                    std::process::id()
                );
                *guard = Some(f);
            }
            Err(_) => return,
        }
    }
    if let Some(f) = guard.as_mut() {
        let _ = writeln!(f, "{} [{}] {line}", iso_ms(now), std::process::id());
        let _ = f.flush();
    }
}


