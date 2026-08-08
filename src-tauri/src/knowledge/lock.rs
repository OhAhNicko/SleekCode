//! Single-writer advisory lock, `<db>.lock` beside the database.
//!
//! Running a `target\debug` build beside the installed MADE is a daily
//! occurrence here, and both would otherwise open the same project read-write.
//! The loser does not fail — it opens read-only and follows along, which is why
//! this file only has to answer one question: is there a LIVE holder?
//!
//! On Windows the answer comes from the OS. The holder keeps the file open with
//! a share mode that denies write, so a second acquire fails with a sharing
//! violation while the holder lives, and succeeds the instant it dies — kill -9
//! included, with no stale-lock heuristics and no cleanup to forget. Unix has
//! no equivalent guarantee for a crashed process, so there the lock falls back
//! to a heartbeat: the holder touches the file, and a lock nobody has touched
//! in five minutes is taken over.

use std::path::{Path, PathBuf};
// The heartbeat exists only on the unix fallback; Windows lets the OS answer.
#[cfg(not(windows))]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(not(windows))]
use std::sync::Arc;

use super::model::now_ms;

/// How often the unix holder touches the lock file.
#[cfg(not(windows))]
const HEARTBEAT_SECS: u64 = 60;
/// How long since the last touch before a unix lock is considered abandoned.
/// Windows never consults this — the OS answers "is the holder alive" directly.
#[cfg(any(not(windows), test))]
const STALE_MS: i64 = 5 * 60 * 1000;

pub enum LockOutcome {
    Acquired(WriterLock),
    HeldBy { pid: u32 },
}

pub struct WriterLock {
    path: PathBuf,
    /// Windows: the open handle IS the lock. Held for its lifetime, never read.
    #[cfg(windows)]
    _handle: std::fs::File,
    #[cfg(not(windows))]
    stop: Arc<AtomicBool>,
}

impl Drop for WriterLock {
    fn drop(&mut self) {
        #[cfg(not(windows))]
        self.stop.store(true, Ordering::Relaxed);
        // Best effort: on Windows the handle closes first, and a leftover file
        // is harmless because acquisition never trusts its contents.
        let _ = std::fs::remove_file(&self.path);
    }
}

fn lock_path(db_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.lock", db_path.display()))
}

fn lock_body() -> String {
    serde_json::json!({
        "pid": std::process::id(),
        "startedAt": now_ms(),
        "exe": std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default(),
        "appVersion": env!("CARGO_PKG_VERSION"),
    })
    .to_string()
}

/// The pid recorded in a lock file, when it can be read.
fn holder_pid(text: &str) -> u32 {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|v| v.get("pid").and_then(|p| p.as_u64()))
        .unwrap_or(0) as u32
}

/// A unix lock older than `STALE_MS` has no live holder heartbeating it.
#[cfg(any(not(windows), test))]
fn is_stale(mtime_ms: i64, now: i64) -> bool {
    now.saturating_sub(mtime_ms) > STALE_MS
}

#[cfg(windows)]
pub fn acquire(db_path: &Path) -> LockOutcome {
    use std::io::Write;
    use std::os::windows::fs::OpenOptionsExt;

    // Others may READ (so a follower can learn our pid) but not write. A second
    // instance asking for write access is therefore refused while we live.
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_READ_WRITE: u32 = 0x0000_0003;

    let path = lock_path(db_path);
    match std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .share_mode(FILE_SHARE_READ)
        .open(&path)
    {
        Ok(mut file) => {
            let _ = file.write_all(lock_body().as_bytes());
            let _ = file.flush();
            LockOutcome::Acquired(WriterLock {
                path,
                _handle: file,
            })
        }
        Err(_) => {
            // Somebody has it open for writing. Read their pid for the notice —
            // sharing read+write here so the probe does not disturb them.
            let pid = std::fs::OpenOptions::new()
                .read(true)
                .share_mode(FILE_SHARE_READ_WRITE)
                .open(&path)
                .ok()
                .and_then(|mut f| {
                    use std::io::Read;
                    let mut s = String::new();
                    f.read_to_string(&mut s).ok().map(|_| holder_pid(&s))
                })
                .unwrap_or(0);
            LockOutcome::HeldBy { pid }
        }
    }
}

#[cfg(not(windows))]
pub fn acquire(db_path: &Path) -> LockOutcome {
    let path = lock_path(db_path);
    let existing = std::fs::metadata(&path).ok();
    if let Some(meta) = existing {
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        if !is_stale(mtime, now_ms()) {
            let pid = std::fs::read_to_string(&path)
                .map(|s| holder_pid(&s))
                .unwrap_or(0);
            return LockOutcome::HeldBy { pid };
        }
        // Abandoned by a process that never got to clean up. Claim it by
        // RENAMING it aside rather than deleting: two processes can both judge
        // the same lock stale, and a plain remove lets the loser delete the
        // winner's freshly written lock. Exactly one rename can succeed.
        let taken = path.with_extension(format!("takeover.{}", std::process::id()));
        if std::fs::rename(&path, &taken).is_err() {
            // Somebody else got there first, and their lock is the live one.
            let pid = std::fs::read_to_string(&path)
                .map(|s| holder_pid(&s))
                .unwrap_or(0);
            return LockOutcome::HeldBy { pid };
        }
        let _ = std::fs::remove_file(&taken);
    }

    // create_new is O_CREAT|O_EXCL: exactly one racing process can win.
    // `std::fs::write` is create-or-TRUNCATE, so both sides of a simultaneous
    // launch used to "acquire" the same project — two writers on one SQLite
    // file, two watchers, and each importing the other's projections as
    // external edits until the revisions diverged.
    let created = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path);
    match created {
        Ok(mut file) => {
            use std::io::Write;
            if file.write_all(lock_body().as_bytes()).is_err() {
                let _ = std::fs::remove_file(&path);
                return LockOutcome::HeldBy { pid: 0 };
            }
        }
        Err(_) => {
            let pid = std::fs::read_to_string(&path)
                .map(|s| holder_pid(&s))
                .unwrap_or(0);
            return LockOutcome::HeldBy { pid };
        }
    }
    let stop = Arc::new(AtomicBool::new(false));
    let beat_path = path.clone();
    let beat_stop = stop.clone();
    std::thread::spawn(move || {
        while !beat_stop.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_secs(HEARTBEAT_SECS));
            if beat_stop.load(Ordering::Relaxed) {
                break;
            }
            let _ = std::fs::write(&beat_path, lock_body());
        }
    });
    LockOutcome::Acquired(WriterLock { path, stop })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::testutil::TestDir;

    #[test]
    fn holder_pid_is_parsed_and_survives_garbage() {
        assert_eq!(holder_pid(&lock_body()), std::process::id());
        assert_eq!(holder_pid("{\"pid\": 4242}"), 4242);
        assert_eq!(holder_pid("not json at all"), 0);
        assert_eq!(holder_pid("{}"), 0);
    }

    #[test]
    fn staleness_policy() {
        let now = 10_000_000i64;
        assert!(!is_stale(now, now), "a lock touched now is live");
        assert!(!is_stale(now - STALE_MS + 1, now));
        assert!(is_stale(now - STALE_MS - 1, now));
        // A clock that jumped backwards must not declare a live lock stale.
        assert!(!is_stale(now + 60_000, now));
    }

    #[test]
    fn acquire_then_release_lets_the_next_caller_in() {
        let dir = TestDir::new();
        let db = dir.path().join("k.db");
        let first = match acquire(&db) {
            LockOutcome::Acquired(g) => g,
            LockOutcome::HeldBy { .. } => panic!("nothing should hold a fresh lock"),
        };
        // A second acquire from this same process must be refused.
        assert!(matches!(acquire(&db), LockOutcome::HeldBy { .. }));
        drop(first);
        assert!(matches!(acquire(&db), LockOutcome::Acquired(_)));
    }

    /// The Unix path must claim the lock file EXCLUSIVELY.
    ///
    /// It used to finish with `std::fs::write`, which is create-or-truncate:
    /// two processes that both passed the "does it exist?" check each wrote the
    /// file and each returned Acquired, giving one project two writers. Only
    /// meaningful on non-Windows — Windows holds the file open with
    /// `share_mode(0)` instead, and this whole function is `cfg`-ed out there,
    /// so a Windows test run does not compile it at all.
    #[cfg(not(windows))]
    #[test]
    fn only_one_of_many_simultaneous_acquires_wins() {
        use std::sync::{Arc, Barrier};

        // Repeated because a lost race is probabilistic: the old
        // create-or-TRUNCATE write let every racer through whenever they all
        // cleared the "does it exist?" check before any write landed.
        for _ in 0..20 {
            let dir = TestDir::new();
            let db = dir.path().join("k.db");
            let barrier = Arc::new(Barrier::new(8));
            let winners = Arc::new(std::sync::atomic::AtomicUsize::new(0));

            let handles: Vec<_> = (0..8)
                .map(|_| {
                    let db = db.clone();
                    let barrier = barrier.clone();
                    let winners = winners.clone();
                    std::thread::spawn(move || {
                        barrier.wait();
                        if let LockOutcome::Acquired(guard) = acquire(&db) {
                            winners.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                            // Hold it: releasing would let a loser back in and
                            // hide the very overlap being tested.
                            std::thread::sleep(std::time::Duration::from_millis(50));
                            drop(guard);
                        }
                    })
                })
                .collect();
            for h in handles {
                h.join().expect("thread");
            }

            assert_eq!(
                winners.load(std::sync::atomic::Ordering::SeqCst),
                1,
                "a project must have exactly one writer"
            );
        }
    }
}
