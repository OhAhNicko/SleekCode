//! Live file watching for the text editor.
//!
//! The editor (`FileViewerPane`) calls `watch_file` for every file it has open
//! and `unwatch_file` when the tab closes. When something *else* rewrites the
//! file — another MADE instance, an AI agent in a terminal pane, `git checkout`,
//! an external editor — we emit `made:file-changed` with the exact path string
//! the frontend registered, and it re-reads and reconciles.
//!
//! Two deliberate design choices:
//!
//! 1. **We watch the parent DIRECTORY, not the file.** Almost every serious
//!    writer saves atomically (write `foo.md.tmp`, then rename over `foo.md`).
//!    A watch on the inode/handle of `foo.md` dies with the replaced file and
//!    goes permanently silent after the first save. A non-recursive directory
//!    watch survives, so we filter incoming events against the registered set.
//!
//! 2. **Everything is refcounted.** The same file can be open in several panes
//!    (and, in global-editor mode, in every project tab at once), and many files
//!    share one directory. Refcounts on both levels mean the last close actually
//!    releases the OS handle instead of leaking a watch per open.
//!
//! We do NOT debounce here. A single save typically produces several events;
//! the frontend coalesces them on a trailing timer and then compares the fresh
//! bytes against its own buffer, so duplicate wakeups are harmless but a dropped
//! *last* event would not be. Emitting more is the safe direction.

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

/// Canonical key for map lookups. `notify` hands back OS-native separators and,
/// on Windows, whatever casing the filesystem feels like — neither is guaranteed
/// to match the string the frontend passed in. Fold both away.
fn norm(p: &str) -> String {
    let slashed = p.replace('\\', "/");
    if cfg!(windows) {
        slashed.to_lowercase()
    } else {
        slashed
    }
}

#[derive(Clone, Serialize)]
struct FileChanged {
    /// The original path string as the frontend registered it, so the listener
    /// can match with `===` instead of re-normalizing.
    path: String,
}

struct Ctl {
    watcher: Option<RecommendedWatcher>,
    /// normalized parent directory -> number of watched files inside it
    dirs: HashMap<String, usize>,
    /// normalized file path -> number of open editors holding it
    refs: HashMap<String, usize>,
}

pub struct FileWatchState {
    ctl: Mutex<Ctl>,
    /// Shared with the notify callback thread. Kept in its own lock (rather
    /// than inside `Ctl`) so an event arriving while `watch_file` is mid-flight
    /// can never deadlock against the control path.
    files: Arc<Mutex<HashMap<String, String>>>,
}

impl Default for FileWatchState {
    fn default() -> Self {
        Self {
            ctl: Mutex::new(Ctl {
                watcher: None,
                dirs: HashMap::new(),
                refs: HashMap::new(),
            }),
            files: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[tauri::command]
pub fn watch_file(
    path: String,
    app: AppHandle,
    state: State<'_, FileWatchState>,
) -> Result<(), String> {
    let key = norm(&path);
    let parent = Path::new(&path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| format!("No parent directory for {path}"))?;
    let dir_key = norm(&parent);

    let mut ctl = state.ctl.lock().map_err(|e| e.to_string())?;

    // File-level refcount. Re-registering an already-watched file is a no-op
    // beyond the bump — the directory watch is already live.
    let file_entry = ctl.refs.entry(key.clone()).or_insert(0);
    *file_entry += 1;
    if *file_entry == 1 {
        state
            .files
            .lock()
            .map_err(|e| e.to_string())?
            .insert(key, path.clone());
    }

    // Directory-level refcount — only the first file in a directory installs
    // the OS watch.
    let dir_entry = ctl.dirs.entry(dir_key.clone()).or_insert(0);
    *dir_entry += 1;
    if *dir_entry > 1 {
        return Ok(());
    }

    if ctl.watcher.is_none() {
        let files = Arc::clone(&state.files);
        let app_handle = app.clone();
        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let Ok(event) = res else { return };
            // Access events fire on plain reads (including our own), which would
            // wake every editor for nothing. Everything else — Create, Modify,
            // Remove, and the catch-all `Any` some backends emit — is a real
            // candidate for "the bytes on disk may differ now".
            if matches!(event.kind, EventKind::Access(_)) {
                return;
            }
            let Ok(map) = files.lock() else { return };
            for p in &event.paths {
                if let Some(original) = map.get(&norm(&p.to_string_lossy())) {
                    let _ = app_handle.emit(
                        "made:file-changed",
                        FileChanged {
                            path: original.clone(),
                        },
                    );
                }
            }
        })
        .map_err(|e| format!("Failed to create file watcher: {e}"))?;
        ctl.watcher = Some(watcher);
    }

    if let Some(w) = ctl.watcher.as_mut() {
        if let Err(e) = w.watch(Path::new(&parent), RecursiveMode::NonRecursive) {
            // Roll the directory refcount back so a later retry re-attempts the
            // watch instead of believing one is already installed.
            ctl.dirs.remove(&dir_key);
            return Err(format!("Failed to watch {parent}: {e}"));
        }
    }

    Ok(())
}

#[tauri::command]
pub fn unwatch_file(path: String, state: State<'_, FileWatchState>) -> Result<(), String> {
    let key = norm(&path);
    let parent = Path::new(&path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| format!("No parent directory for {path}"))?;
    let dir_key = norm(&parent);

    let mut ctl = state.ctl.lock().map_err(|e| e.to_string())?;

    match ctl.refs.get_mut(&key) {
        Some(n) if *n > 1 => {
            *n -= 1;
            return Ok(());
        }
        Some(_) => {
            ctl.refs.remove(&key);
            state
                .files
                .lock()
                .map_err(|e| e.to_string())?
                .remove(&key);
        }
        // Unbalanced unwatch (double close, hot reload) — nothing to release.
        None => return Ok(()),
    }

    match ctl.dirs.get_mut(&dir_key) {
        Some(n) if *n > 1 => {
            *n -= 1;
        }
        Some(_) => {
            ctl.dirs.remove(&dir_key);
            if let Some(w) = ctl.watcher.as_mut() {
                let _ = w.unwatch(Path::new(&parent));
            }
        }
        None => {}
    }

    Ok(())
}
