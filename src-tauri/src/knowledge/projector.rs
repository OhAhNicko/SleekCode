//! The markdown projection: `<project>/.project-memory/`.
//!
//! Every note is one file, and the file is the portable copy — readable in any
//! editor, diffable, committable, and enough on its own to rebuild the database
//! after a corruption or a project move. Frontmatter carries the identity
//! (`id`, `revision`) that makes that rebuild lossless.
//!
//! Frontmatter is hand-serialized and hand-parsed rather than pulled through a
//! YAML crate: the key set is fixed and tiny, and a full YAML parser would
//! accept documents we then could not faithfully re-emit. The known cost is
//! that unknown keys a user adds by hand are dropped on the next projection.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use super::model::{iso_ms, parse_iso, NoteMeta};

/// Debug and release builds live in fully separate worlds (rule 2026-08-07:
/// live and dev MADE may never share content), and the split starts here: a
/// debug build projects into its own folder, so its database, writer lock and
/// watcher can never collide with the installed build's. Half-splits are
/// UNSAFE — a shared folder with per-build databases means two writer locks
/// that cannot see each other. Mirrored by the adapter's
/// `identity::MEMORY_DIR` and served to the frontend via `knowledge_world`.
#[cfg(debug_assertions)]
pub const MEMORY_DIR: &str = ".project-memory-dev";
#[cfg(not(debug_assertions))]
pub const MEMORY_DIR: &str = ".project-memory";
pub const NOTES_DIR: &str = "notes";
pub const SYSTEM_DIR: &str = ".system";

/// How long a self-write stays suppressible, and how long a "MADE saved this"
/// marker keeps attributing the resulting import to the user. Long enough to
/// cover a slow SMB round trip, short enough that a genuine external edit
/// moments later is still recorded as external.
const LEDGER_TTL: Duration = Duration::from_secs(5);
const LEDGER_CAP: usize = 256;

/// The seven singleton documents, in the order the sidebar shows them.
/// `(file_path, type, title, starter body)`.
pub const CORE_DOCS: &[(&str, &str, &str, &str)] = &[
    (
        "PROJECT.md",
        "project",
        "Project",
        "# Project\n\nWhat this project is, who it is for, and the constraints that\nare not obvious from the code.\n",
    ),
    (
        "STATE.md",
        "state",
        "State",
        "# State\n\n## Current work\n\nNothing recorded yet.\n\n## Next\n\n-\n",
    ),
    (
        "ARCHITECTURE.md",
        "architecture",
        "Architecture",
        "# Architecture\n\nHow the pieces fit together, and why.\n",
    ),
    (
        "DECISIONS.md",
        "decisions",
        "Decisions",
        "# Decisions\n\nAppend-only. Each entry records what was decided and what it\nruled out.\n",
    ),
    (
        "LEARNINGS.md",
        "learnings",
        "Learnings",
        "# Learnings\n\nAppend-only. Things that cost time once and should not cost it\nagain.\n",
    ),
    (
        "TASKS.md",
        "tasks",
        "Tasks",
        "# Tasks\n",
    ),
    (
        "HANDOFFS.md",
        "handoffs",
        "Handoffs",
        "# Handoffs\n\nNewest first.\n",
    ),
];

/// The note type for a core filename, or None for an ordinary note.
pub fn core_type_for_file(file_path: &str) -> Option<&'static str> {
    let name = file_path.rsplit('/').next().unwrap_or(file_path);
    CORE_DOCS
        .iter()
        .find(|(f, _, _, _)| f.eq_ignore_ascii_case(name))
        .map(|(_, t, _, _)| *t)
}

// ---------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------

/// Filename stem for a title: lowercase, non-alphanumeric runs collapsed to a
/// single dash, capped at 64 characters.
///
/// Slugs are STABLE across a title change (identity lives in the frontmatter
/// id, exactly as Obsidian treats it) — renaming a note does not move its file
/// unless the caller explicitly asks for a re-slug.
pub fn slugify(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut pending_dash = false;
    for ch in title.trim().chars() {
        if ch.is_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.extend(ch.to_lowercase());
        } else {
            pending_dash = true;
        }
    }
    while out.chars().count() > 64 {
        out.pop();
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "note".to_string()
    } else {
        trimmed
    }
}

/// `slug`, `slug-2`, `slug-3`, … — the first form not already taken by another
/// note and not already on disk.
pub fn unique_slug(base: &str, notes_dir: &Path, taken: &dyn Fn(&str) -> bool) -> String {
    let mut candidate = base.to_string();
    let mut n = 1u32;
    while taken(&candidate) || notes_dir.join(format!("{candidate}.md")).exists() {
        n += 1;
        candidate = format!("{base}-{n}");
        if n > 9999 {
            break;
        }
    }
    candidate
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Frontmatter {
    pub id: Option<String>,
    pub note_type: Option<String>,
    pub revision: Option<i64>,
    pub created_by: Option<String>,
    pub updated_by: Option<String>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub tags: Vec<String>,
}

/// The full file: frontmatter block followed by the body verbatim.
pub fn render_file(meta: &NoteMeta, body: &str) -> String {
    let mut out = String::with_capacity(body.len() + 256);
    out.push_str("---\n");
    out.push_str(&format!("id: {}\n", meta.id));
    out.push_str(&format!("type: {}\n", meta.note_type));
    out.push_str(&format!("revision: {}\n", meta.revision));
    out.push_str(&format!("created_by: {}\n", meta.created_by));
    out.push_str(&format!("updated_by: {}\n", meta.updated_by));
    out.push_str(&format!("created_at: {}\n", iso_ms(meta.created_at)));
    out.push_str(&format!("updated_at: {}\n", iso_ms(meta.updated_at)));
    if meta.tags.is_empty() {
        out.push_str("tags: []\n");
    } else {
        out.push_str("tags:\n");
        for tag in &meta.tags {
            out.push_str(&format!("  - {tag}\n"));
        }
    }
    out.push_str("---\n");
    out.push_str(body);
    out
}

/// Split a file into its frontmatter and its body. A file with no frontmatter
/// returns `(None, whole_text)` — that is the adoption path, not an error.
pub fn parse_frontmatter(text: &str) -> (Option<Frontmatter>, String) {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let Some(rest) = strip_delimiter(text) else {
        return (None, text.to_string());
    };

    let mut fm = Frontmatter::default();
    let mut in_tags = false;
    let mut consumed = 0usize;
    let mut closed = false;

    for line in rest.split_inclusive('\n') {
        consumed += line.len();
        let trimmed = line.trim_end_matches(['\n', '\r']);
        if trimmed.trim_end() == "---" {
            closed = true;
            break;
        }
        if in_tags {
            let t = trimmed.trim_start();
            if let Some(tag) = t.strip_prefix("- ") {
                let tag = tag.trim();
                if !tag.is_empty() {
                    fm.tags.push(tag.to_string());
                }
                continue;
            }
            if t.starts_with('-') && t.len() == 1 {
                continue;
            }
            in_tags = false;
        }
        let Some((key, value)) = trimmed.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        match key {
            "id" => fm.id = non_empty(value),
            "type" => fm.note_type = non_empty(value),
            "revision" => fm.revision = value.parse::<i64>().ok(),
            "created_by" => fm.created_by = non_empty(value),
            "updated_by" => fm.updated_by = non_empty(value),
            "created_at" => fm.created_at = parse_iso(value),
            "updated_at" => fm.updated_at = parse_iso(value),
            "tags" => {
                if value.is_empty() {
                    in_tags = true;
                } else if let Some(inner) = value.strip_prefix('[').and_then(|v| v.strip_suffix(']'))
                {
                    fm.tags = inner
                        .split(',')
                        .map(|s| s.trim().trim_matches(['"', '\'']).to_string())
                        .filter(|s| !s.is_empty())
                        .collect();
                }
            }
            // Unknown keys are tolerated on read and dropped on the next write.
            _ => {}
        }
    }

    if !closed {
        // An opening `---` with no closing one is not frontmatter; treat the
        // whole file as body so nothing is silently swallowed.
        return (None, text.to_string());
    }
    (Some(fm), rest[consumed..].to_string())
}

fn strip_delimiter(text: &str) -> Option<&str> {
    for delim in ["---\n", "---\r\n"] {
        if let Some(rest) = text.strip_prefix(delim) {
            return Some(rest);
        }
    }
    None
}

fn non_empty(s: &str) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

/// The body's first `# H1`, which is where a note's title lives — frontmatter
/// deliberately carries no title so renaming in an editor works the obvious way.
pub fn title_from_body(body: &str) -> Option<String> {
    for line in body.split('\n').take(40) {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("# ") {
            let title = rest.trim();
            if !title.is_empty() {
                return Some(title.to_string());
            }
        }
    }
    None
}

/// Replace (or insert) the body's first H1 so a rename shows up where a reader
/// looks for it.
pub fn set_body_title(body: &str, title: &str) -> String {
    let mut lines: Vec<String> = body.split('\n').map(|s| s.to_string()).collect();
    for line in lines.iter_mut().take(40) {
        if line.trim_start().starts_with("# ") {
            *line = format!("# {title}");
            return lines.join("\n");
        }
    }
    format!("# {title}\n\n{body}")
}

// ---------------------------------------------------------------------------
// Atomic writes + the self-write ledger
// ---------------------------------------------------------------------------

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Write via a temp file in the same directory then rename over the target.
///
/// The rename is what makes a half-written file impossible for a reader — and
/// it is also why the watcher watches directories rather than files (a watch on
/// the replaced inode goes permanently silent, per file_watch.rs).
pub fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "path has no parent")
    })?;
    std::fs::create_dir_all(dir)?;
    let n = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!(
        ".{}.tmp-{}-{}",
        path.file_name().and_then(|f| f.to_str()).unwrap_or("note"),
        std::process::id(),
        n
    ));
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.flush()?;
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// Sweep leftover `.tmp-*` files from a crash mid-write.
pub fn sweep_temp_files(dir: &Path, older_than: Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.contains(".tmp-") {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .and_then(|m| now.duration_since(m).map_err(std::io::Error::other))
            .map(|age| age > older_than)
            .unwrap_or(false);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Paths this process just wrote, so the watcher can tell its own echo from a
/// real external edit.
///
/// Keyed by hash as well as path: if something else overwrites the file in the
/// same instant, the hash will not match and the edit is correctly treated as
/// external instead of being swallowed.
#[derive(Default)]
pub struct SelfWriteLedger {
    map: HashMap<String, (String, Instant)>,
}

impl SelfWriteLedger {
    pub fn record(&mut self, key: String, hash: String) {
        self.map.insert(key, (hash, Instant::now()));
        // Prune AFTER inserting, or the cap is off by one every time.
        self.prune();
    }

    /// Same question without consuming the entry.
    ///
    /// The pre-projection guard has to ask "are these bytes ours?" without
    /// spending the one suppression the watcher event still needs.
    pub fn contains(&self, key: &str, hash: &str) -> bool {
        matches!(self.map.get(key), Some((h, at)) if h == hash && at.elapsed() <= LEDGER_TTL)
    }

    /// True when `hash` is what we just wrote to `key`. Consumes the entry —
    /// one write produces one suppressible event.
    pub fn check_and_consume(&mut self, key: &str, hash: &str) -> bool {
        self.prune();
        match self.map.get(key) {
            Some((h, _)) if h == hash => {
                self.map.remove(key);
                true
            }
            _ => false,
        }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.map.len()
    }

    fn prune(&mut self) {
        let now = Instant::now();
        self.map
            .retain(|_, (_, at)| now.duration_since(*at) < LEDGER_TTL);
        if self.map.len() > LEDGER_CAP {
            // Cheap bound: drop the oldest until we fit. This map only grows
            // under a burst of projections, and losing the oldest entry costs
            // at worst one spurious "externally edited" import.
            let mut by_age: Vec<(String, Instant)> =
                self.map.iter().map(|(k, (_, t))| (k.clone(), *t)).collect();
            by_age.sort_by_key(|(_, t)| *t);
            for (k, _) in by_age.iter().take(self.map.len() - LEDGER_CAP) {
                self.map.remove(k);
            }
        }
    }
}

/// Paths MADE's own editor is about to save, so the resulting import is
/// attributed to the user rather than to an anonymous external writer.
///
/// Separate from the ledger on purpose: the ledger SUPPRESSES an import, this
/// one lets it through and only changes who gets credit. Collapsing them would
/// mean the user's own edits never produced a revision.
#[derive(Default)]
pub struct OwnEditMarks {
    map: HashMap<String, Instant>,
}

impl OwnEditMarks {
    pub fn mark(&mut self, key: String) {
        self.prune();
        self.map.insert(key, Instant::now());
    }

    pub fn take(&mut self, key: &str) -> bool {
        self.prune();
        self.map.remove(key).is_some()
    }

    fn prune(&mut self) {
        let now = Instant::now();
        self.map.retain(|_, at| now.duration_since(*at) < LEDGER_TTL);
        if self.map.len() > LEDGER_CAP {
            self.map.clear();
        }
    }
}

// ---------------------------------------------------------------------------
// Scaffold
// ---------------------------------------------------------------------------

/// Create `.project-memory/`, `notes/` and `.system/`. Called ONLY from the
/// explicit initialize path — opening an uninitialized project must not write
/// anything into a user's repository.
pub fn ensure_dirs(memory_dir: &Path) -> Result<(), String> {
    for dir in [
        memory_dir.to_path_buf(),
        memory_dir.join(NOTES_DIR),
        memory_dir.join(SYSTEM_DIR),
    ] {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("create {}: {e}", dir.display()))?;
    }
    Ok(())
}

pub fn write_manifest(memory_dir: &Path, project_key: &str, created_at: i64) -> Result<(), String> {
    let body = serde_json::json!({
        "version": 1,
        "projectKey": project_key,
        "createdAt": iso_ms(created_at),
        "appVersion": env!("CARGO_PKG_VERSION"),
        "generator": "MADE NexusMind",
    });
    let text = serde_json::to_string_pretty(&body).unwrap_or_default();
    atomic_write(&memory_dir.join(SYSTEM_DIR).join("manifest.json"), text.as_bytes())
        .map_err(|e| format!("write manifest: {e}"))
}

/// A tiny anchor used on open to notice that a `.project-memory` carries more
/// history than the database beside it — the project-move story.
pub fn write_sync_state_json(
    memory_dir: &Path,
    revision: i64,
    db_file_name: &str,
) -> Result<(), String> {
    let body = serde_json::json!({
        "lastKnowledgeRevision": revision,
        "lastExportAt": iso_ms(super::model::now_ms()),
        "dbFileName": db_file_name,
    });
    let text = serde_json::to_string_pretty(&body).unwrap_or_default();
    atomic_write(
        &memory_dir.join(SYSTEM_DIR).join("sync-state.json"),
        text.as_bytes(),
    )
    .map_err(|e| format!("write sync-state: {e}"))
}

/// Absolute path of a note's projection file.
pub fn note_path(memory_dir: &Path, file_path: &str) -> PathBuf {
    let mut p = memory_dir.to_path_buf();
    for part in file_path.split('/') {
        p.push(part);
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::testutil::TestDir;

    fn sample_meta() -> NoteMeta {
        NoteMeta {
            id: "kn_0123456789abcdef0123456789abcdef".into(),
            note_type: "note".into(),
            title: "Auth Design".into(),
            slug: "auth-design".into(),
            file_path: "notes/auth-design.md".into(),
            revision: 12,
            content_hash: "deadbeef".into(),
            tags: vec!["authentication".into(), "security".into()],
            created_at: 1_785_442_320_000,
            updated_at: 1_785_445_980_000,
            created_by: "claude".into(),
            updated_by: "codex".into(),
            archived: false,
            pinned_core: false,
            conflict_id: None,
        }
    }

    #[test]
    fn frontmatter_round_trip() {
        let meta = sample_meta();
        let body = "# Auth Design\n\nBody text with a [[Link]].\n";
        let file = render_file(&meta, body);
        assert!(file.starts_with("---\nid: kn_0123456789abcdef0123456789abcdef\n"));

        let (fm, parsed_body) = parse_frontmatter(&file);
        let fm = fm.expect("frontmatter parses");
        assert_eq!(fm.id.as_deref(), Some(meta.id.as_str()));
        assert_eq!(fm.note_type.as_deref(), Some("note"));
        assert_eq!(fm.revision, Some(12));
        assert_eq!(fm.created_by.as_deref(), Some("claude"));
        assert_eq!(fm.updated_by.as_deref(), Some("codex"));
        assert_eq!(fm.created_at, Some(meta.created_at));
        assert_eq!(fm.updated_at, Some(meta.updated_at));
        assert_eq!(fm.tags, vec!["authentication", "security"]);
        assert_eq!(parsed_body, body);
        assert_eq!(title_from_body(&parsed_body).as_deref(), Some("Auth Design"));
    }

    #[test]
    fn empty_tags_round_trip_and_inline_form_parses() {
        let mut meta = sample_meta();
        meta.tags.clear();
        let file = render_file(&meta, "# T\n");
        assert!(file.contains("tags: []\n"));
        let (fm, _) = parse_frontmatter(&file);
        assert!(fm.expect("parses").tags.is_empty());

        let inline = "---\nid: kn_x\ntags: [a, \"b\"]\n---\nbody";
        let (fm, body) = parse_frontmatter(inline);
        assert_eq!(fm.expect("parses").tags, vec!["a", "b"]);
        assert_eq!(body, "body");
    }

    #[test]
    fn file_without_frontmatter_is_all_body() {
        let src = "# Bare note\n\ntext";
        let (fm, body) = parse_frontmatter(src);
        assert!(fm.is_none());
        assert_eq!(body, src);

        // An unterminated block is body too — never silently swallowed.
        let unterminated = "---\nid: kn_x\nno closing delimiter\n";
        let (fm, body) = parse_frontmatter(unterminated);
        assert!(fm.is_none());
        assert_eq!(body, unterminated);
    }

    #[test]
    fn slugify_collapses_and_caps() {
        assert_eq!(slugify("Auth Design"), "auth-design");
        assert_eq!(slugify("  Hello,   World!! "), "hello-world");
        assert_eq!(slugify("***"), "note");
        assert_eq!(slugify("Ärende Nr 5"), "ärende-nr-5");
        assert!(slugify(&"x".repeat(200)).chars().count() <= 64);
    }

    #[test]
    fn slug_collision_appends_suffix() {
        let dir = TestDir::new();
        let notes = dir.path().join("notes");
        std::fs::create_dir_all(&notes).unwrap();
        std::fs::write(notes.join("auth-design.md"), "x").unwrap();

        let taken = |_: &str| false;
        assert_eq!(unique_slug("auth-design", &notes, &taken), "auth-design-2");

        // Taken in the graph but not on disk counts too.
        let taken2 = |s: &str| s == "other";
        assert_eq!(unique_slug("other", &notes, &taken2), "other-2");
    }

    #[test]
    fn atomic_write_leaves_no_temp_behind() {
        let dir = TestDir::new();
        let target = dir.path().join("nested").join("STATE.md");
        atomic_write(&target, b"hello").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "hello");
        let leftovers: Vec<_> = std::fs::read_dir(target.parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "temp file survived the rename");

        // Overwrites in place.
        atomic_write(&target, b"world").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "world");
    }

    #[test]
    fn ledger_matches_hash_once_then_forgets() {
        let mut ledger = SelfWriteLedger::default();
        ledger.record("c:/p/state.md".into(), "abc".into());
        assert!(!ledger.check_and_consume("c:/p/state.md", "different"));
        assert!(ledger.check_and_consume("c:/p/state.md", "abc"));
        // Consumed — a second event for the same write is a real one.
        assert!(!ledger.check_and_consume("c:/p/state.md", "abc"));
    }

    #[test]
    fn ledger_stays_bounded() {
        let mut ledger = SelfWriteLedger::default();
        for i in 0..(LEDGER_CAP + 50) {
            ledger.record(format!("path-{i}"), format!("hash-{i}"));
        }
        assert!(ledger.len() <= LEDGER_CAP, "ledger grew to {}", ledger.len());
    }

    #[test]
    fn own_edit_marks_are_single_use() {
        let mut marks = OwnEditMarks::default();
        marks.mark("c:/p/state.md".into());
        assert!(marks.take("c:/p/state.md"));
        assert!(!marks.take("c:/p/state.md"));
    }

    #[test]
    fn core_doc_map_recognises_the_singletons() {
        assert_eq!(core_type_for_file("STATE.md"), Some("state"));
        assert_eq!(core_type_for_file("notes/STATE.md"), Some("state"));
        assert_eq!(core_type_for_file("notes/other.md"), None);
        assert_eq!(core_type_for_file("HANDOFFS.md"), Some("handoffs"));
        assert_eq!(CORE_DOCS.len(), 7);
    }

    #[test]
    fn set_body_title_replaces_or_prepends() {
        assert_eq!(set_body_title("# Old\n\nbody", "New"), "# New\n\nbody");
        assert!(set_body_title("no heading", "New").starts_with("# New\n"));
    }
}
