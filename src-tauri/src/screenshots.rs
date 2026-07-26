//! Screenshot discovery, matching and deletion.
//!
//! MADE learns about screenshots two ways and they describe the SAME capture:
//!
//! 1. **Clipboard** — `poll_clipboard_image` re-encodes whatever is on the
//!    clipboard into `%TEMP%\made\clipboard-<ms>.png`.
//! 2. **The OS Screenshots folder** — Windows' Snipping Tool also writes the
//!    original to `Pictures\Screenshots` (Settings → "Automatically save
//!    screenshots"), and that copy is permanent where ours is not.
//!
//! Which means "delete this screenshot from my PC" has to remove two files, and
//! that the folder watcher must not surface a second entry for a snip the
//! clipboard already reported. Both need the same question answered — *are
//! these two files the same capture?* — so both go through `same_capture`:
//! identical pixel dimensions, and mtimes within a caller-supplied window.
//! Dimensions come out of the PNG/JPEG/BMP header, so nothing is ever decoded.
//!
//! ## Safety
//!
//! `screenshots_delete` is the only command in MADE that unlinks a file the
//! user did not name, so it refuses any path that is not a DIRECT child of one
//! of two roots: `%TEMP%\made` (and named `clipboard-*.png`), or the resolved
//! screenshots folder. Both sides are canonicalised before comparison, so `..`
//! cannot walk out. Widening this guard would hand the WebView an arbitrary
//! file-delete primitive — don't.

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

#[cfg(not(target_os = "linux"))]
use std::process::Command;

/// Extensions we treat as screenshots. Deliberately excludes anything we cannot
/// read dimensions out of — `same_capture` would silently degrade to a
/// timestamp-only match, which is not tight enough to delete on.
const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "bmp"];

/// Re-emit suppression window for the watcher. A single file write produces
/// several notify events; the frontend dedupes by path too, but not emitting is
/// cheaper than not rendering.
const REEMIT_SUPPRESS_MS: u64 = 5_000;

/// PNG file signature — the only format this module will write.
const PNG_MAGIC: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotEntry {
    pub path: String,
    pub modified_ms: u64,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteReport {
    /// Files actually unlinked.
    pub deleted: Vec<String>,
    /// Files we were asked about but left alone, with why.
    pub skipped: Vec<String>,
}

// ---------------------------------------------------------------------------
// Folder resolution
// ---------------------------------------------------------------------------

/// Expand `%NAME%` runs against the process environment. Registry shell-folder
/// values are `REG_EXPAND_SZ` and routinely come back as
/// `%USERPROFILE%\Pictures\Screenshots`.
#[cfg(windows)]
fn expand_env(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
                let name = &after[..end];
                match std::env::var(name) {
                    Ok(v) => out.push_str(&v),
                    // Unknown variable — keep it verbatim rather than silently
                    // producing a path that looks valid but isn't.
                    Err(_) => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push('%');
                out.push_str(after);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// Read one value out of HKCU User Shell Folders.
///
/// This key — not a hardcoded `%USERPROFILE%\Pictures` — is what OneDrive
/// rewrites when it takes over Pictures, and what a localised Windows install
/// points at a non-English folder name.
#[cfg(windows)]
fn query_shell_folder(value: &str) -> Option<String> {
    let out = Command::new("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders",
            "/v",
            value,
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix(value) else {
            continue;
        };
        let rest = rest.trim_start();
        let rest = rest
            .strip_prefix("REG_EXPAND_SZ")
            .or_else(|| rest.strip_prefix("REG_SZ"))?;
        let raw = rest.trim();
        if raw.is_empty() {
            return None;
        }
        return Some(expand_env(raw));
    }
    None
}

#[cfg(windows)]
fn detect_folder() -> Option<PathBuf> {
    // FOLDERID_Screenshots — the exact known folder, present on Win10/11.
    if let Some(p) = query_shell_folder("{b7bede81-df94-4682-a7d8-57a52620b86f}") {
        let pb = PathBuf::from(p);
        if pb.is_dir() {
            return Some(pb);
        }
    }
    // Pictures\Screenshots, via whatever Pictures currently resolves to.
    if let Some(p) = query_shell_folder("My Pictures") {
        let pb = PathBuf::from(p).join("Screenshots");
        if pb.is_dir() {
            return Some(pb);
        }
    }
    // Last resort: the literal default layout.
    let profile = std::env::var("USERPROFILE").ok()?;
    let pb = PathBuf::from(profile).join("Pictures").join("Screenshots");
    if pb.is_dir() {
        return Some(pb);
    }
    None
}

#[cfg(target_os = "macos")]
fn detect_folder() -> Option<PathBuf> {
    // `screencapture` writes wherever this default points; unset means Desktop.
    if let Ok(out) = Command::new("defaults")
        .args(["read", "com.apple.screencapture", "location"])
        .output()
    {
        if out.status.success() {
            let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !raw.is_empty() {
                let expanded = match raw.strip_prefix("~") {
                    Some(tail) => PathBuf::from(std::env::var("HOME").ok()?).join(tail.trim_start_matches('/')),
                    None => PathBuf::from(&raw),
                };
                if expanded.is_dir() {
                    return Some(expanded);
                }
            }
        }
    }
    let pb = PathBuf::from(std::env::var("HOME").ok()?).join("Desktop");
    if pb.is_dir() {
        return Some(pb);
    }
    None
}

#[cfg(target_os = "linux")]
fn detect_folder() -> Option<PathBuf> {
    let pb = PathBuf::from(std::env::var("HOME").ok()?)
        .join("Pictures")
        .join("Screenshots");
    if pb.is_dir() {
        return Some(pb);
    }
    None
}

/// Detection shells out — `reg query` on Windows, `defaults read` on macOS —
/// and `screenshots_delete` re-validates against the folder on EVERY call, so a
/// "Clear all" across 50 shots would otherwise spawn a hundred processes at
/// once. Cache the first hit; the OS screenshots folder does not move
/// mid-session. A FAILED probe is deliberately not cached, so creating the
/// folder later still starts working without a restart.
fn detect_folder_cached() -> Option<PathBuf> {
    static CACHE: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
    let cell = CACHE.get_or_init(|| Mutex::new(None));

    if let Ok(guard) = cell.lock() {
        if let Some(p) = guard.as_ref() {
            // Re-check: the folder can be deleted out from under a cached hit.
            if p.is_dir() {
                return Some(p.clone());
            }
        }
    }

    let found = detect_folder()?;
    if let Ok(mut guard) = cell.lock() {
        *guard = Some(found.clone());
    }
    Some(found)
}

/// Resolve the folder to use: caller override first, else OS detection.
fn resolve_folder(override_path: Option<String>) -> Result<PathBuf, String> {
    if let Some(raw) = override_path {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let pb = PathBuf::from(trimmed);
            if !pb.is_dir() {
                return Err(format!("Screenshots folder not found: {trimmed}"));
            }
            return Ok(pb);
        }
    }
    detect_folder_cached().ok_or_else(|| "Could not locate a Screenshots folder".to_string())
}

#[tauri::command]
pub fn screenshots_resolve_folder(folder: Option<String>) -> Result<String, String> {
    Ok(resolve_folder(folder)?.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// Header-only dimension reads
// ---------------------------------------------------------------------------

fn be_u32(b: &[u8]) -> u32 {
    u32::from_be_bytes([b[0], b[1], b[2], b[3]])
}

/// Pixel dimensions straight out of the file header. Returns `None` when the
/// header is absent, truncated (a file still being written), or unrecognised.
fn read_dimensions(path: &Path) -> Option<(u32, u32)> {
    let head = read_head(path, 64 * 1024)?;

    // PNG: 8-byte signature, then IHDR length+type (8 bytes), then w/h.
    if head.len() >= 24 && head.starts_with(PNG_MAGIC) {
        let w = be_u32(&head[16..20]);
        let h = be_u32(&head[20..24]);
        return (w > 0 && h > 0).then_some((w, h));
    }

    // BMP: BITMAPINFOHEADER width/height at 18/22, little-endian i32.
    if head.len() >= 26 && head.starts_with(b"BM") {
        let w = i32::from_le_bytes([head[18], head[19], head[20], head[21]]);
        let h = i32::from_le_bytes([head[22], head[23], head[24], head[25]]);
        return (w > 0 && h != 0).then_some((w as u32, h.unsigned_abs()));
    }

    // JPEG: walk segments to the first SOF that carries dimensions.
    if head.len() >= 4 && head[0] == 0xFF && head[1] == 0xD8 {
        let mut i = 2usize;
        while i + 9 < head.len() {
            if head[i] != 0xFF {
                i += 1;
                continue;
            }
            let marker = head[i + 1];
            // Standalone markers carry no length payload.
            if marker == 0xD8 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
                i += 2;
                continue;
            }
            let len = u16::from_be_bytes([head[i + 2], head[i + 3]]) as usize;
            let is_sof = matches!(marker, 0xC0..=0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF);
            if is_sof {
                let h = u16::from_be_bytes([head[i + 5], head[i + 6]]) as u32;
                let w = u16::from_be_bytes([head[i + 7], head[i + 8]]) as u32;
                return (w > 0 && h > 0).then_some((w, h));
            }
            if len < 2 {
                return None;
            }
            i += 2 + len;
        }
    }

    None
}

fn read_head(path: &Path, max: usize) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; max];
    let n = f.read(&mut buf).ok()?;
    buf.truncate(n);
    Some(buf)
}

fn modified_ms(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

fn has_image_ext(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| IMAGE_EXTS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

fn entry_for(path: &Path) -> Option<ScreenshotEntry> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() == 0 {
        return None;
    }
    let (width, height) = read_dimensions(path)?;
    Some(ScreenshotEntry {
        path: path.to_string_lossy().to_string(),
        modified_ms: meta
            .modified()
            .ok()?
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_millis() as u64,
        width,
        height,
        bytes: meta.len(),
    })
}

// ---------------------------------------------------------------------------
// Listing / matching
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn screenshots_list_recent(
    folder: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<ScreenshotEntry>, String> {
    let dir = resolve_folder(folder)?;
    let limit = limit.unwrap_or(12);

    let mut found: Vec<ScreenshotEntry> = std::fs::read_dir(&dir)
        .map_err(|e| format!("Failed to read {}: {e}", dir.display()))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| has_image_ext(p))
        .filter_map(|p| entry_for(&p))
        .collect();

    found.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    found.truncate(limit);
    Ok(found)
}

/// Are these two files the same capture? Same pixel dimensions AND mtimes
/// close enough that they cannot be separate snips.
fn same_capture(a: &Path, b: &Path, within_ms: u64) -> Option<u64> {
    let (aw, ah) = read_dimensions(a)?;
    let (bw, bh) = read_dimensions(b)?;
    if aw != bw || ah != bh {
        return None;
    }
    let am = modified_ms(a)?;
    let bm = modified_ms(b)?;
    let delta = am.abs_diff(bm);
    (delta <= within_ms).then_some(delta)
}

/// Find the `Pictures\Screenshots` original that corresponds to a temp copy.
/// Returns the CLOSEST match by time so two same-sized snips seconds apart
/// still resolve to the right file.
#[tauri::command]
pub fn screenshots_find_original(
    temp_path: String,
    folder: Option<String>,
    within_ms: Option<u64>,
) -> Result<Option<ScreenshotEntry>, String> {
    let temp = PathBuf::from(&temp_path);
    if !temp.is_file() {
        return Ok(None);
    }
    let dir = resolve_folder(folder)?;
    let within = within_ms.unwrap_or(15_000);

    let mut best: Option<(u64, ScreenshotEntry)> = None;
    for path in std::fs::read_dir(&dir)
        .map_err(|e| format!("Failed to read {}: {e}", dir.display()))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| has_image_ext(p))
    {
        let Some(delta) = same_capture(&temp, &path, within) else {
            continue;
        };
        let Some(entry) = entry_for(&path) else { continue };
        if best.as_ref().map(|(d, _)| delta < *d).unwrap_or(true) {
            best = Some((delta, entry));
        }
    }
    Ok(best.map(|(_, e)| e))
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

/// True when `file` is a DIRECT child of `dir`. Both sides are canonicalised;
/// `file` itself may not exist, so we canonicalise its parent instead.
fn is_direct_child(dir: &Path, file: &Path) -> bool {
    let Ok(dir_c) = dir.canonicalize() else {
        return false;
    };
    let Some(parent) = file.parent() else {
        return false;
    };
    let Ok(parent_c) = parent.canonicalize() else {
        return false;
    };
    parent_c == dir_c
}

/// Delete a screenshot's temp copy, its `Screenshots` original, or both.
///
/// Every path is validated against a root before it is touched — see the module
/// header. Anything that fails validation lands in `skipped`, never deleted.
#[tauri::command]
pub fn screenshots_delete(
    temp_path: Option<String>,
    original_path: Option<String>,
    folder: Option<String>,
) -> Result<DeleteReport, String> {
    let mut deleted = Vec::new();
    let mut skipped = Vec::new();

    if let Some(raw) = temp_path.filter(|s| !s.trim().is_empty()) {
        let path = PathBuf::from(&raw);
        let root = std::env::temp_dir().join("made");
        let name_ok = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with("clipboard-") && n.to_lowercase().ends_with(".png"))
            .unwrap_or(false);
        if name_ok && is_direct_child(&root, &path) {
            match std::fs::remove_file(&path) {
                Ok(()) => deleted.push(raw),
                // Already gone is the outcome the caller wanted.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => deleted.push(raw),
                Err(e) => skipped.push(format!("{raw}: {e}")),
            }
        } else {
            skipped.push(format!("{raw}: outside the MADE temp directory"));
        }
    }

    if let Some(raw) = original_path.filter(|s| !s.trim().is_empty()) {
        let path = PathBuf::from(&raw);
        match resolve_folder(folder) {
            Ok(root) if has_image_ext(&path) && is_direct_child(&root, &path) => {
                match std::fs::remove_file(&path) {
                    Ok(()) => deleted.push(raw),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => deleted.push(raw),
                    Err(e) => skipped.push(format!("{raw}: {e}")),
                }
            }
            Ok(_) => skipped.push(format!("{raw}: outside the Screenshots folder")),
            Err(e) => skipped.push(format!("{raw}: {e}")),
        }
    }

    Ok(DeleteReport { deleted, skipped })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverwriteReport {
    pub written: Vec<String>,
    pub skipped: Vec<String>,
}

/// Write marked-up bytes back over a screenshot's own files, in place.
///
/// This is the destructive counterpart to `save_annotated_image`: it replaces
/// the temp copy AND the `Pictures\Screenshots` original rather than producing
/// a new file, so the un-annotated picture is gone afterwards.
///
/// Same root guards as `screenshots_delete` — the WebView may only name files
/// inside `%TEMP%\made` (called `clipboard-*.png`) or inside the resolved
/// screenshots folder. Two additions on top of those:
///
/// - **PNG magic is validated before anything is opened.** Without it this is a
///   write-arbitrary-bytes-anywhere primitive.
/// - **The original is only overwritten when it is itself a `.png`.** The folder
///   guard admits jpg/bmp too, and writing PNG bytes into a `.jpg` would leave a
///   file whose contents contradict its name.
///
/// Each file is written to a sibling temporary and renamed over the target, so
/// a failure part-way cannot leave a half-written screenshot behind.
#[tauri::command]
pub fn screenshots_overwrite(
    base64_png: String,
    temp_path: Option<String>,
    original_path: Option<String>,
    folder: Option<String>,
) -> Result<OverwriteReport, String> {
    let bytes = STANDARD
        .decode(base64_png.as_bytes())
        .map_err(|e| format!("Not valid base64: {}", e))?;
    if !bytes.starts_with(PNG_MAGIC) {
        return Err("Not a PNG".to_string());
    }
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("Image too large (max 20MB)".to_string());
    }

    let mut written = Vec::new();
    let mut skipped = Vec::new();

    let write_atomic = |path: &Path, raw: &str, written: &mut Vec<String>, skipped: &mut Vec<String>| {
        let tmp = path.with_extension("made-tmp");
        match std::fs::write(&tmp, &bytes).and_then(|_| std::fs::rename(&tmp, path)) {
            Ok(()) => written.push(raw.to_string()),
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                skipped.push(format!("{raw}: {e}"));
            }
        }
    };

    if let Some(raw) = temp_path.filter(|s| !s.trim().is_empty()) {
        let path = PathBuf::from(&raw);
        let root = std::env::temp_dir().join("made");
        let name_ok = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with("clipboard-") && n.to_lowercase().ends_with(".png"))
            .unwrap_or(false);
        if name_ok && is_direct_child(&root, &path) {
            write_atomic(&path, &raw, &mut written, &mut skipped);
        } else {
            skipped.push(format!("{raw}: outside the MADE temp directory"));
        }
    }

    if let Some(raw) = original_path.filter(|s| !s.trim().is_empty()) {
        let path = PathBuf::from(&raw);
        let is_png = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("png"))
            .unwrap_or(false);
        match resolve_folder(folder) {
            Ok(root) if is_png && is_direct_child(&root, &path) => {
                write_atomic(&path, &raw, &mut written, &mut skipped);
            }
            Ok(_) if !is_png => {
                skipped.push(format!("{raw}: not a PNG, left untouched"))
            }
            Ok(_) => skipped.push(format!("{raw}: outside the Screenshots folder")),
            Err(e) => skipped.push(format!("{raw}: {e}")),
        }
    }

    Ok(OverwriteReport { written, skipped })
}

// ---------------------------------------------------------------------------
// Folder watching
// ---------------------------------------------------------------------------

pub struct ScreenshotWatchState {
    inner: Mutex<Inner>,
}

struct Inner {
    watcher: Option<RecommendedWatcher>,
    folder: Option<PathBuf>,
}

impl Default for ScreenshotWatchState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner {
                watcher: None,
                folder: None,
            }),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Wait for a file to finish being written, then emit it.
///
/// A screenshot is observed the moment the writer creates it, which is usually
/// before there is a parseable header — and often before there are any bytes at
/// all. Poll until the size stops changing AND the header parses, then emit.
/// Runs on its own thread so a slow write never stalls the notify callback.
fn settle_and_emit(app: AppHandle, path: PathBuf, seen: Arc<Mutex<HashMap<String, u64>>>) {
    std::thread::spawn(move || {
        let key = path.to_string_lossy().to_lowercase();
        let mut last_len: u64 = u64::MAX;

        for _ in 0..12 {
            std::thread::sleep(Duration::from_millis(100));
            let Ok(meta) = std::fs::metadata(&path) else {
                continue;
            };
            let len = meta.len();
            if len == 0 || len != last_len {
                last_len = len;
                continue;
            }
            let Some(entry) = entry_for(&path) else { continue };

            // Claim the emit slot only once we actually have something to send,
            // so a failed settle doesn't poison the path for REEMIT_SUPPRESS_MS.
            if let Ok(mut map) = seen.lock() {
                let now = now_ms();
                if let Some(prev) = map.get(&key) {
                    if now.saturating_sub(*prev) < REEMIT_SUPPRESS_MS {
                        return;
                    }
                }
                map.insert(key, now);
                // Bound the map — a long session in a busy folder shouldn't grow it forever.
                if map.len() > 256 {
                    map.retain(|_, t| now.saturating_sub(*t) < REEMIT_SUPPRESS_MS);
                }
            }

            let _ = app.emit("made:screenshot-added", entry);
            return;
        }
    });
}

#[tauri::command]
pub fn screenshots_watch_start(
    folder: Option<String>,
    app: AppHandle,
    state: State<'_, ScreenshotWatchState>,
) -> Result<String, String> {
    let dir = resolve_folder(folder)?;
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;

    // Already watching exactly this folder — re-registering is a no-op.
    if inner.watcher.is_some() && inner.folder.as_deref() == Some(dir.as_path()) {
        return Ok(dir.to_string_lossy().to_string());
    }

    // Folder changed: release the old watch before installing the new one.
    let old_folder = inner.folder.clone();
    if let (Some(w), Some(old)) = (inner.watcher.as_mut(), old_folder) {
        let _ = w.unwatch(&old);
    }
    inner.watcher = None;
    inner.folder = None;

    let seen: Arc<Mutex<HashMap<String, u64>>> = Arc::new(Mutex::new(HashMap::new()));
    let app_handle = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        // Access events fire on plain reads (including our own settle polls).
        // Removals tell us nothing we can render.
        if matches!(event.kind, EventKind::Access(_) | EventKind::Remove(_)) {
            return;
        }
        for p in event.paths {
            if !has_image_ext(&p) {
                continue;
            }
            settle_and_emit(app_handle.clone(), p, Arc::clone(&seen));
        }
    })
    .map_err(|e| format!("Failed to create screenshot watcher: {e}"))?;

    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| format!("Failed to watch {}: {e}", dir.display()))?;

    inner.watcher = Some(watcher);
    inner.folder = Some(dir.clone());
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn screenshots_watch_stop(state: State<'_, ScreenshotWatchState>) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    let watched = inner.folder.clone();
    if let (Some(w), Some(dir)) = (inner.watcher.as_mut(), watched) {
        let _ = w.unwatch(&dir);
    }
    inner.watcher = None;
    inner.folder = None;
    Ok(())
}
