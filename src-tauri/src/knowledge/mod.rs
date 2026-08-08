//! NexusMind — the shared agent knowledge workspace (UI name; `knowledge` in
//! code).
//!
//! One instance per open project, each owning a SQLite store, an in-memory
//! graph over it, and a markdown projection under `<project>/.project-memory/`.
//! Claude Code, Codex and Gemini all read and write the same memory through the
//! MCP adapter, with attribution the model cannot forge.
//!
//! Three structural decisions worth knowing before reading further:
//!
//! 1. **The database lives in `app_local_data_dir`, not in the project.** A WAL
//!    SQLite file opened across the `\\wsl.localhost` SMB share reliably
//!    reports "database is locked" (lib.rs already documents this for Codex's
//!    state_5.sqlite). The markdown IS the portable, git-committable copy, and
//!    the database is rebuildable from it — which is also the project-move and
//!    corruption story.
//!
//! 2. **One logical writer per project, enforced by a lock file.** Running a
//!    dev build beside the installed one is a daily occurrence here, so the
//!    second instance opens read-only and follows the first rather than
//!    corrupting it.
//!
//! 3. **Every service operation is synchronous under `Inner`'s mutex, and that
//!    mutex is NEVER held across an `.await`** — the same invariant
//!    native_term/registry.rs states. Async commands call in inline; only the
//!    open-time directory walk goes through `spawn_blocking`.

pub mod commands;
pub mod events;
pub mod graph;
pub mod ipc;
pub mod lock;
pub mod mcp_config;
pub mod merge;
pub mod model;
pub mod projector;
pub mod schema;
pub mod search;
pub mod store;
pub mod watcher;

// Globs, not named lists: `#[tauri::command]` also emits a `__cmd__<name>`
// macro beside each function, and `generate_handler!` needs BOTH under the path
// it is given. Naming the functions alone compiles here and fails at the
// handler line.
pub use commands::*;
pub use mcp_config::*;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

use crate::debug_log::dlog;
use graph::Graph;
use model::{fnv1a64, KnowledgeStatus};
use projector::{OwnEditMarks, SelfWriteLedger};

/// Everything behind the per-project mutex.
pub struct Inner {
    pub conn: Connection,
    pub graph: Graph,
    pub ledger: SelfWriteLedger,
    pub own_edits: OwnEditMarks,
    pub memory_dir: PathBuf,
    pub project_key: String,
    pub project_path: String,
    pub db_file_name: String,
    pub read_only: bool,
    /// IPC connection ids that have already been granted write access for this
    /// project under the `ask` policy.
    pub granted: HashSet<u64>,
    pub writer_lock: Option<lock::WriterLock>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mode {
    ReadWrite,
    ReadOnly { holder_pid: u32, reason: String },
}

pub struct ProjectKnowledge {
    pub key: String,
    pub root: PathBuf,
    pub memory_dir: PathBuf,
    pub db_path: PathBuf,
    pub mode: Mode,
    inner: Mutex<Inner>,
    watcher: Mutex<Option<watcher::WatchHandle>>,
}

impl ProjectKnowledge {
    /// Run a synchronous operation under the project lock. The closure must not
    /// block on anything slow — everything inside is SQLite and small file
    /// writes.
    pub fn with_inner<T>(&self, f: impl FnOnce(&mut Inner) -> T) -> T {
        let mut guard = self.inner.lock().expect("knowledge inner poisoned");
        f(&mut guard)
    }

    pub fn read_only(&self) -> bool {
        !matches!(self.mode, Mode::ReadWrite)
    }

    pub fn status(&self) -> KnowledgeStatus {
        let (revision, note_count, open_conflicts, policy) = self.with_inner(|inner| {
            (
                store::latest_seq(&inner.conn),
                inner.graph.list(false).len() as i64,
                store::open_conflict_count(&inner.conn),
                store::write_policy(&inner.conn),
            )
        });
        let (state, readonly_reason) = match &self.mode {
            Mode::ReadWrite => ("ready", None),
            Mode::ReadOnly { holder_pid, reason } => (
                "readonly",
                Some(if *holder_pid > 0 {
                    format!("{reason} (MADE pid {holder_pid})")
                } else {
                    reason.clone()
                }),
            ),
        };
        KnowledgeStatus {
            state: state.to_string(),
            project_key: self.key.clone(),
            project_path: self.root.to_string_lossy().to_string(),
            revision,
            note_count,
            open_conflicts,
            write_policy: policy,
            pending_approvals: ipc::pending_approval_count(&self.key),
            memory_dir: Some(self.memory_dir.to_string_lossy().to_string()),
            readonly_reason,
            error: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Process-wide state
// ---------------------------------------------------------------------------

static APP: OnceLock<AppHandle> = OnceLock::new();
static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<ProjectKnowledge>>>> = OnceLock::new();
static KNOWLEDGE_DIR: OnceLock<PathBuf> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<String, Arc<ProjectKnowledge>>> {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn app_handle() -> Option<AppHandle> {
    APP.get().cloned()
}

/// The module's own tokio runtime — IPC accept loop, watcher debounce, event
/// flushes. Two workers, matching preview_proxy's "made-proxy" shape.
pub fn runtime_handle() -> Option<tokio::runtime::Handle> {
    RUNTIME.get().map(|rt| rt.handle().clone())
}

/// Clone the Arc out and drop the registry lock immediately — the same rule
/// native_term/registry.rs states, and for the same reason: everything a caller
/// then does with it can be slow.
pub fn get(key: &str) -> Option<Arc<ProjectKnowledge>> {
    registry().lock().ok()?.get(key).cloned()
}

/// Where the databases and adapter endpoint files live.
pub fn knowledge_dir() -> Option<PathBuf> {
    KNOWLEDGE_DIR.get().cloned()
}

/// Called once from lib.rs setup(). Non-fatal: a failure here degrades the
/// feature, it must never stop the app from starting.
pub fn init(app: AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir: {e}"))?
        // Per-build world: debug databases and endpoint files live in their
        // own directory, so a dev adapter can only ever discover dev
        // instances and the writer locks of the two worlds never meet.
        .join(if cfg!(debug_assertions) { "knowledge-dev" } else { "knowledge" });
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let _ = KNOWLEDGE_DIR.set(dir.clone());
    let _ = APP.set(app);

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .worker_threads(2)
        .thread_name("made-knowledge")
        .build()
        .map_err(|e| format!("knowledge runtime: {e}"))?;
    let _ = RUNTIME.set(rt);

    ipc::sweep_stale_endpoints(&dir);
    match ipc::start(&dir) {
        Ok(info) => dlog(&format!(
            "[knowledge] ipc listening on 127.0.0.1:{}",
            info.port
        )),
        Err(e) => dlog(&format!("[knowledge] ipc failed to start: {e}")),
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Keys and paths
// ---------------------------------------------------------------------------

/// Byte-identical folding to `file_watch::norm` — backslashes to slashes, and
/// lowercase on Windows, because `notify` hands back whatever casing the
/// filesystem feels like.
pub fn norm_path(p: &str) -> String {
    let slashed = p.replace('\\', "/");
    if cfg!(windows) {
        slashed.to_lowercase()
    } else {
        slashed
    }
}

/// The canonical project key. There are already three drifted project-slug
/// encoders in this codebase and their divergence silently broke every remote
/// session reader — this is deliberately the SAME folding as file_watch plus a
/// trailing-slash trim, and it has exactly one TypeScript mirror.
pub fn project_key(path: &str) -> String {
    let normed = norm_path(path.trim());
    let trimmed = normed.trim_end_matches('/');
    if trimmed.is_empty() {
        normed
    } else {
        trimmed.to_string()
    }
}

/// `<leaf>-<fnv64>.db`. The leaf makes the directory browsable; the hash makes
/// two projects with the same folder name distinct.
pub fn db_file_name(key: &str) -> String {
    let leaf: String = key
        .rsplit('/')
        .find(|s| !s.is_empty())
        .unwrap_or("project")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let leaf = leaf.trim_matches('-');
    let leaf = if leaf.is_empty() { "project" } else { leaf };
    let short: String = leaf.chars().take(40).collect();
    format!("{short}-{}.db", fnv1a64(key.as_bytes()))
}

/// SSH-backed projects are out of MVP scope. The frontend only passes local
/// working directories, but a UNC or `user@host:` path reaching the store would
/// mean opening a database over a network share — guard here rather than trust.
///
/// `\\wsl.localhost\...` and `\\wsl$\...` are deliberately NOT remote: those are
/// ordinary local projects, and the whole reason the database lives outside the
/// project is to make them work.
pub fn is_remote_path(path: &str) -> bool {
    let p = path.trim();
    if p.contains("://") {
        return true;
    }
    let unc = p.starts_with("\\\\") || p.starts_with("//");
    if unc {
        let lower = norm_path(p);
        return !(lower.starts_with("//wsl.localhost/") || lower.starts_with("//wsl$/"));
    }
    // user@host:/path — but not a Windows drive letter (C:\...).
    match p.split_once('@') {
        Some((user, rest)) => {
            !user.is_empty()
                && !user.contains('/')
                && !user.contains('\\')
                && rest.contains(':')
        }
        None => false,
    }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

pub enum OpenResult {
    /// No `.project-memory` and `init` was false — nothing was written.
    Uninitialized,
    Opened(Arc<ProjectKnowledge>),
}

impl std::fmt::Debug for OpenResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Uninitialized => write!(f, "Uninitialized"),
            Self::Opened(p) => write!(f, "Opened({})", p.key),
        }
    }
}

/// Idempotent. With `init = false` this NEVER writes to the project: MADE
/// scaffolding a folder into someone's repository has to be an explicit act.
pub fn open_project(project_path: &str, init: bool) -> Result<OpenResult, String> {
    if is_remote_path(project_path) {
        return Err("remote projects are not supported".into());
    }
    let key = project_key(project_path);
    if let Some(existing) = get(&key) {
        if init {
            // "Initialize" on an already-open project scaffolds into it rather
            // than reopening — the sidebar's Connect and Initialize buttons can
            // both land here.
            ensure_scaffolded(&existing)?;
        }
        return Ok(OpenResult::Opened(existing));
    }

    let started = std::time::Instant::now();
    let root = PathBuf::from(project_path);
    if !root.is_dir() {
        return Err(format!("{project_path} is not a directory"));
    }
    let memory_dir = root.join(projector::MEMORY_DIR);
    if !memory_dir.exists() {
        if !init {
            return Ok(OpenResult::Uninitialized);
        }
        projector::ensure_dirs(&memory_dir)?;
    }

    let dir = knowledge_dir().ok_or("knowledge service is not initialized")?;
    let db_file_name = db_file_name(&key);
    let db_path = dir.join(&db_file_name);

    // Whoever holds the lock owns writing. A second instance follows along.
    let (writer_lock, mode) = match lock::acquire(&db_path) {
        lock::LockOutcome::Acquired(guard) => (Some(guard), Mode::ReadWrite),
        lock::LockOutcome::HeldBy { pid } => (
            None,
            Mode::ReadOnly {
                holder_pid: pid,
                reason: "another MADE instance owns this project".into(),
            },
        ),
    };
    let read_only = !matches!(mode, Mode::ReadWrite);

    let (conn, mode, rebuilt) = open_or_rebuild(&db_path, read_only, mode)?;
    let read_only = !matches!(mode, Mode::ReadWrite);
    let graph = store::hydrate_graph(&conn)?;

    let mut inner = Inner {
        conn,
        graph,
        ledger: SelfWriteLedger::default(),
        own_edits: OwnEditMarks::default(),
        memory_dir: memory_dir.clone(),
        project_key: key.clone(),
        project_path: project_path.to_string(),
        db_file_name: db_file_name.clone(),
        read_only,
        granted: HashSet::new(),
        writer_lock,
    };

    if rebuilt {
        // The reconcile walk below is what actually refills the store, and it
        // logs its own adoptions — this records WHY they are about to happen.
        let _ = store::record_event(
            &mut inner,
            store::EV_STORE_REBUILT,
            None,
            &model::Actor::system(),
            "the store was rebuilt from .project-memory",
        );
    }
    if !read_only {
        store::meta_set(&inner.conn, store::META_PROJECT_KEY, &key)?;
        store::meta_set(&inner.conn, store::META_PROJECT_ROOT, project_path)?;
        if store::meta_get(&inner.conn, store::META_CREATED_AT).is_none() {
            store::meta_set(
                &inner.conn,
                store::META_CREATED_AT,
                &model::now_ms().to_string(),
            )?;
        }
        if init && inner.graph.len() == 0 {
            store::scaffold(&mut inner)?;
            projector::write_manifest(&memory_dir, &key, model::now_ms())?;
        }
        // A crash mid-write leaves temp files behind; sweep before walking so
        // they are never mistaken for notes.
        projector::sweep_temp_files(&memory_dir, std::time::Duration::from_secs(3600));
        projector::sweep_temp_files(
            &memory_dir.join(projector::NOTES_DIR),
            std::time::Duration::from_secs(3600),
        );
        let imported = watcher::reconcile_walk(&mut inner);
        if imported > 0 {
            dlog(&format!(
                "[knowledge] reconcile imported {imported} file(s) for {key}"
            ));
        }
        if rebuilt {
            // Normal writes keep the index current through the trigger triple,
            // but this store was just refilled by a walk that followed a
            // corruption. Rebuilding the index outright is cheap here and
            // beats trusting that every trigger fired along the way.
            let _ = search::fts_rebuild(&inner.conn);
        }
    }

    let project = Arc::new(ProjectKnowledge {
        key: key.clone(),
        root,
        memory_dir,
        db_path,
        mode,
        inner: Mutex::new(inner),
        watcher: Mutex::new(None),
    });

    let handle = if project.read_only() {
        watcher::start_follower(&project)
    } else {
        watcher::start(&project)
    };
    match handle {
        Ok(h) => *project.watcher.lock().expect("watcher poisoned") = Some(h),
        Err(e) => dlog(&format!("[knowledge] watcher for {key} failed: {e}")),
    }

    registry()
        .lock()
        .map_err(|_| "registry poisoned".to_string())?
        .insert(key.clone(), project.clone());
    dlog(&format!(
        "[knowledge] opened {key} ({} notes, {}, {}ms)",
        project.with_inner(|i| i.graph.len()),
        if project.read_only() { "read-only" } else { "read-write" },
        started.elapsed().as_millis()
    ));
    Ok(OpenResult::Opened(project))
}

/// Open the database, or move a corrupt/unreadable one aside and start again —
/// the markdown is the source of truth for rebuilding it. The bool says whether
/// that second path was taken.
fn open_or_rebuild(
    db_path: &Path,
    read_only: bool,
    mode: Mode,
) -> Result<(Connection, Mode, bool), String> {
    let existed = db_path.exists();
    let attempt = store::open_db(db_path, read_only).and_then(|conn| {
        if existed && !store::integrity_ok(&conn) {
            return Err("integrity check failed".into());
        }
        match store::run_migrations(&conn) {
            Ok(None) => Ok((conn, mode.clone())),
            Ok(Some(v)) => Ok((
                conn,
                Mode::ReadOnly {
                    holder_pid: 0,
                    reason: format!("this database uses schema v{v}, newer than this build"),
                },
            )),
            Err(e) => Err(e),
        }
    });

    match attempt {
        Ok((conn, mode)) => Ok((conn, mode, false)),
        Err(e) if read_only => Err(e),
        Err(e) => {
            dlog(&format!(
                "[knowledge] {} unusable ({e}) — moving aside and rebuilding",
                db_path.display()
            ));
            let aside = db_path.with_extension(format!("corrupt-{}", model::now_ms()));
            let _ = std::fs::rename(db_path, &aside);
            for suffix in ["-wal", "-shm"] {
                let side = PathBuf::from(format!("{}{suffix}", db_path.display()));
                let _ = std::fs::remove_file(side);
            }
            let conn = store::open_db(db_path, false)?;
            store::run_migrations(&conn).map_err(|e| format!("rebuild migrate: {e}"))?;
            store::meta_set(&conn, store::META_REBUILT_AT, &model::now_ms().to_string())?;
            Ok((conn, Mode::ReadWrite, true))
        }
    }
}

fn ensure_scaffolded(project: &Arc<ProjectKnowledge>) -> Result<(), String> {
    if project.read_only() {
        return Err("this project is open read-only".into());
    }
    projector::ensure_dirs(&project.memory_dir)?;
    let key = project.key.clone();
    let memory_dir = project.memory_dir.clone();
    project.with_inner(|inner| -> Result<(), String> {
        if inner.graph.len() == 0 {
            store::scaffold(inner)?;
            projector::write_manifest(&memory_dir, &key, model::now_ms())?;
        }
        Ok(())
    })
}

pub fn close_project(key: &str) {
    let Some(project) = registry().lock().ok().and_then(|mut g| g.remove(key)) else {
        return;
    };
    // Drop the watcher first so nothing arrives mid-teardown.
    *project.watcher.lock().expect("watcher poisoned") = None;
    events::flush(key);
    events::discard(key);
    if let Ok(mut inner) = project.inner.lock() {
        inner.granted.clear();
        inner.writer_lock = None;
        let _ = inner.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
    }
    ipc::drop_project_connections(key);
    dlog(&format!("[knowledge] closed {key}"));
}

/// Remove a project's knowledge entirely: detach it, then move BOTH halves to
/// the Recycle Bin — the projection folder inside the repo AND the event
/// database in app data. The database half is not optional: it lives outside
/// the project, so left behind it silently resurrects every old note on the
/// next initialize, which is the opposite of the start-from-scratch this
/// exists for. Nothing here is a permanent delete.
///
/// The frontend confirms before calling. Ordering is the contract: close
/// first (Windows will not move open handles, and the close checkpoints the
/// WAL), folder second, database last — so a failure part-way can say exactly
/// what already went and what remains.
pub fn remove_project(project_path: &str) -> Result<(), String> {
    remove_project_with(project_path, knowledge_dir().as_deref(), &|p| {
        trash::delete(p)
            .map_err(|e| format!("could not move {} to the Recycle Bin: {e}", p.display()))
    })
}

/// The orchestration, with deletion injected — unit tests exercise ordering
/// and error wording without touching the real OS trash.
fn remove_project_with(
    project_path: &str,
    knowledge_dir: Option<&Path>,
    delete: &dyn Fn(&Path) -> Result<(), String>,
) -> Result<(), String> {
    if is_remote_path(project_path) {
        return Err("remote projects are not supported".into());
    }
    let key = project_key(project_path);
    close_project(&key);

    let memory_dir = PathBuf::from(project_path).join(projector::MEMORY_DIR);
    let mut folder_removed = false;
    if memory_dir.exists() {
        delete(&memory_dir)?;
        folder_removed = true;
    }

    let Some(dir) = knowledge_dir else {
        // The service never initialized, so no database was ever created.
        return Ok(());
    };
    let db = dir.join(db_file_name(&key));
    let sidecars = [
        PathBuf::from(format!("{}-wal", db.display())),
        PathBuf::from(format!("{}-shm", db.display())),
    ];
    for path in std::iter::once(db).chain(sidecars) {
        if !path.exists() {
            continue;
        }
        let mut result = delete(&path);
        if result.is_err() {
            // `close_project` removed the registry entry, but an in-flight
            // command can still hold the Arc for a moment, and Windows will
            // not move a database whose connection is open. One short retry
            // covers that window; a genuinely held file still errors.
            std::thread::sleep(std::time::Duration::from_millis(150));
            result = delete(&path);
        }
        result.map_err(|e| {
            if folder_removed {
                format!(
                    "{e}. The project folder is already in the Recycle Bin; until this \
                     database is removed too, re-initializing would restore the old notes."
                )
            } else {
                e
            }
        })?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Pane identity registry (fed by the frontend, consumed by the IPC handshake)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct PaneSessionInfo {
    pub project_key: String,
    pub agent_kind: String,
    pub session_id: Option<String>,
}

fn panes() -> &'static Mutex<HashMap<String, PaneSessionInfo>> {
    static PANES: OnceLock<Mutex<HashMap<String, PaneSessionInfo>>> = OnceLock::new();
    PANES.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn pane_upsert(pane_id: &str, info: PaneSessionInfo) {
    if let Ok(mut map) = panes().lock() {
        map.insert(pane_id.to_string(), info);
    }
}

pub fn pane_remove(pane_id: &str) {
    if let Ok(mut map) = panes().lock() {
        map.remove(pane_id);
    }
}

pub fn pane_info(pane_id: &str) -> Option<PaneSessionInfo> {
    panes().lock().ok()?.get(pane_id).cloned()
}

// ---------------------------------------------------------------------------
// Test support
// ---------------------------------------------------------------------------

#[cfg(test)]
pub mod testutil {
    use super::*;
    use crate::knowledge::model::{Actor, CommitResult};
    use crate::knowledge::store::{CreateNoteInput, UpdateNoteInput};

    /// A throwaway directory that cleans itself up. Hand-rolled rather than
    /// pulling in `tempfile` — one struct with a Drop is cheaper than a
    /// dependency the shipping binary would also carry.
    pub struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        pub fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "made-knowledge-test-{}",
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&path).expect("create test dir");
            Self { path }
        }

        pub fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    /// A live `Inner` over a real database and a real projection directory.
    ///
    /// Field order matters: `inner` is declared first so its Connection closes
    /// before `dir` tries to delete the file out from under it (Windows refuses
    /// to remove an open file).
    pub struct Fixture {
        pub inner: Inner,
        pub dir: TestDir,
    }

    impl Fixture {
        pub fn note(&mut self, title: &str, content: &str) -> CommitResult {
            store::create_note(
                &mut self.inner,
                CreateNoteInput {
                    title: title.into(),
                    content: content.into(),
                    ..Default::default()
                },
                &Actor::user(),
            )
            .expect("create note")
        }

        pub fn update(&mut self, id: &str, base: i64, content: &str) -> CommitResult {
            store::update_note(
                &mut self.inner,
                UpdateNoteInput {
                    id: id.into(),
                    base_revision: base,
                    content: content.into(),
                    ..Default::default()
                },
                &Actor::user(),
                store::SOURCE_API,
            )
            .expect("update note")
        }

        /// Absolute path of a projection file.
        pub fn file(&self, rel: &str) -> PathBuf {
            projector::note_path(&self.inner.memory_dir, rel)
        }
    }

    pub fn fixture() -> Fixture {
        let dir = TestDir::new();
        let memory_dir = dir.path().join(projector::MEMORY_DIR);
        projector::ensure_dirs(&memory_dir).expect("scaffold dirs");
        let conn = store::open_db(&dir.path().join("k.db"), false).expect("open db");
        store::run_migrations(&conn).expect("migrate");
        let graph = store::hydrate_graph(&conn).expect("hydrate");
        let project_path = dir.path().to_string_lossy().to_string();
        Fixture {
            inner: Inner {
                conn,
                graph,
                ledger: SelfWriteLedger::default(),
                own_edits: OwnEditMarks::default(),
                memory_dir,
                project_key: project_key(&project_path),
                project_path,
                db_file_name: "test.db".into(),
                read_only: false,
                granted: HashSet::new(),
                writer_lock: None,
            },
            dir,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_key_folds_like_file_watch() {
        let a = project_key("C:\\Users\\nikla\\proj\\");
        let b = project_key("C:/Users/nikla/proj");
        assert_eq!(a, b, "separator and trailing slash must fold away");
        if cfg!(windows) {
            assert_eq!(project_key("C:/Users/NIKLA/Proj"), b, "case must fold");
        }
        assert!(!project_key("/home/u/proj").is_empty());
    }

    #[test]
    fn db_file_name_is_readable_and_unique() {
        let a = db_file_name(&project_key("C:/code/alpha"));
        let b = db_file_name(&project_key("D:/other/alpha"));
        assert!(a.starts_with("alpha-"), "leaf missing from {a}");
        assert!(a.ends_with(".db"));
        assert_ne!(a, b, "same leaf in different roots must not collide");
        // Same project, either spelling, one file.
        assert_eq!(a, db_file_name(&project_key("C:\\code\\alpha\\")));
    }

    #[test]
    fn remote_paths_are_refused_but_wsl_shares_are_not() {
        assert!(is_remote_path("ssh://host/srv/code"));
        assert!(is_remote_path("user@host:/srv/code"));
        assert!(is_remote_path("\\\\fileserver\\share\\code"));
        assert!(!is_remote_path("\\\\wsl.localhost\\Ubuntu-24.04\\home\\u\\code"));
        assert!(!is_remote_path("\\\\wsl$\\Ubuntu\\home\\u\\code"));
        assert!(!is_remote_path("C:\\Users\\nikla\\code"));
        assert!(!is_remote_path("/home/u/code"));
    }

    #[test]
    fn opening_a_remote_project_fails_soft() {
        let err = open_project("user@host:/srv/code", false).unwrap_err();
        assert!(err.contains("remote"), "unexpected error: {err}");
    }

    #[test]
    fn removing_a_project_takes_the_folder_the_database_and_nothing_else() {
        let project = testutil::TestDir::new();
        let memory_dir = project.path().join(projector::MEMORY_DIR);
        projector::ensure_dirs(&memory_dir).expect("scaffold dirs");
        std::fs::write(project.path().join("keep.rs"), b"user code").expect("write");

        let key = project_key(&project.path().to_string_lossy());
        let app_data = testutil::TestDir::new();
        let db = app_data.path().join(db_file_name(&key));
        std::fs::write(&db, b"db").expect("write db");
        std::fs::write(format!("{}-wal", db.display()), b"wal").expect("write wal");
        std::fs::write(app_data.path().join("other-project.db"), b"other").expect("write other");

        let deleted = std::cell::RefCell::new(Vec::new());
        remove_project_with(
            &project.path().to_string_lossy(),
            Some(app_data.path()),
            &|p| {
                deleted.borrow_mut().push(p.to_path_buf());
                if p.is_dir() {
                    std::fs::remove_dir_all(p).map_err(|e| e.to_string())
                } else {
                    std::fs::remove_file(p).map_err(|e| e.to_string())
                }
            },
        )
        .expect("remove");

        assert!(!memory_dir.exists(), "projection folder must be gone");
        assert!(!db.exists(), "database must be gone");
        assert_eq!(deleted.borrow().len(), 3, "folder + db + wal, nothing more");
        assert!(
            project.path().join("keep.rs").exists(),
            "the user's own files are not MADE's to touch"
        );
        assert!(
            app_data.path().join("other-project.db").exists(),
            "another project's database must survive"
        );
        assert!(get(&key).is_none(), "nothing may stay attached");
    }

    #[test]
    fn a_database_left_behind_names_the_resurrection_consequence() {
        let project = testutil::TestDir::new();
        let memory_dir = project.path().join(projector::MEMORY_DIR);
        projector::ensure_dirs(&memory_dir).expect("scaffold dirs");

        let key = project_key(&project.path().to_string_lossy());
        let app_data = testutil::TestDir::new();
        let db = app_data.path().join(db_file_name(&key));
        std::fs::write(&db, b"db").expect("write db");

        let err = remove_project_with(
            &project.path().to_string_lossy(),
            Some(app_data.path()),
            &|p| {
                if p.is_dir() {
                    std::fs::remove_dir_all(p).map_err(|e| e.to_string())
                } else {
                    Err("held by another process".into())
                }
            },
        )
        .expect_err("db deletion failed, the call must too");
        assert!(
            err.contains("re-initializing would restore"),
            "the error must say WHY the leftover matters: {err}"
        );
        assert!(!memory_dir.exists(), "the folder half still went");
    }
}
