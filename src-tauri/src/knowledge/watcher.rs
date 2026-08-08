//! Bringing external edits back in.
//!
//! An agent with MADE closed, a `git pull`, a human in Notepad — all of them
//! write straight to `.project-memory/`, and all of them have to end up as
//! revisions with an author rather than as mystery drift. The import pipeline
//! below is the path every one of those takes.
//!
//! The pipeline functions take `&mut Inner` and nothing else, so the whole of
//! it is unit-testable without notify, a watcher thread, or a running app. The
//! notify plumbing at the bottom only decides WHEN to call them.
//!
//! Watch conventions come from file_watch.rs and are load-bearing: watch the
//! parent DIRECTORY non-recursively (a watch on a file's inode dies at the
//! first atomic save), and drop `Access` events (they fire on our own reads).
//! What we add is a trailing debounce, because one save produces several events
//! and importing three times would mean three revisions.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::Duration;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use crate::debug_log::dlog;

use super::model::*;
use super::projector::{self, NOTES_DIR, SYSTEM_DIR};
use super::store::{self, CreateNoteInput, UpdateNoteInput};
use super::{norm_path, Inner, ProjectKnowledge};

/// Trailing debounce. One editor save fires Create + Modify + Modify; waiting
/// for quiet turns that into one import, and also makes "the file is gone"
/// reliable — mid-rename, the target briefly does not exist.
const DEBOUNCE_MS: u64 = 200;
/// The database's `-wal` changes far more often than we need to re-read it.
const FOLLOWER_DEBOUNCE_MS: u64 = 300;

#[derive(Debug, PartialEq, Eq)]
pub enum ImportOutcome {
    /// Not ours, unreadable, or our own write echoing back.
    Skipped,
    Unchanged,
    Committed(i64),
    Merged(i64),
    Conflict,
    Adopted(String),
    Archived,
    Failed(String),
}

impl ImportOutcome {
    fn counts(&self) -> bool {
        !matches!(self, ImportOutcome::Skipped | ImportOutcome::Unchanged)
    }
}

/// Keeps the OS watches alive. Dropping it stops both the watcher and, via the
/// closed channel, the debounce task.
pub struct WatchHandle {
    _watcher: Option<RecommendedWatcher>,
}

// ---------------------------------------------------------------------------
// Import pipeline (pure — no notify, no runtime)
// ---------------------------------------------------------------------------

/// Import one projection file, identified by its path relative to
/// `.project-memory/`.
pub fn import_path(inner: &mut Inner, rel_path: &str) -> ImportOutcome {
    if inner.read_only {
        return ImportOutcome::Skipped;
    }
    let rel = rel_path.replace('\\', "/");
    if !rel.to_ascii_lowercase().ends_with(".md") || rel.starts_with(SYSTEM_DIR) {
        return ImportOutcome::Skipped;
    }
    let abs = projector::note_path(&inner.memory_dir, &rel);

    let Some(bytes) = read_with_retry(&abs) else {
        // Absent. A deletion archives the entity — rows are never dropped, so
        // Restore can put the file back with its history intact.
        let existing = inner.graph.by_file_path(&rel).cloned();
        return match existing {
            Some(meta) if !meta.archived => {
                match store::archive_note(inner, &meta.id, &Actor::external(), false) {
                    Ok(_) => ImportOutcome::Archived,
                    Err(e) => ImportOutcome::Failed(e),
                }
            }
            _ => ImportOutcome::Skipped,
        };
    };

    let hash = fnv1a64(&bytes);
    let key = norm_path(&abs.to_string_lossy());
    if inner.ledger.check_and_consume(&key, &hash) {
        let _ = store::note_seen(&inner.conn, &rel, &hash, store::file_mtime(&abs), bytes.len() as i64);
        // Recreating a file with byte-identical content can match a ledger
        // entry we wrote before it was deleted. The bytes need no import, but
        // the entity does need to stop being archived — otherwise the note
        // stays invisible in the sidebar and in search while its file is right
        // there on disk.
        if let Some(meta) = inner.graph.by_file_path(&rel).cloned() {
            if meta.archived {
                match store::restore_note(inner, &meta.id, &Actor::external()) {
                    Ok(_) => {
                        dlog(&format!("[knowledge] {rel} reappeared unchanged — un-archived"));
                        return ImportOutcome::Committed(meta.revision + 1);
                    }
                    Err(e) => return ImportOutcome::Failed(e),
                }
            }
        }
        return ImportOutcome::Skipped;
    }

    // MADE's own editor announces its saves, so they are attributed to the user
    // instead of to an anonymous external writer. Everything else is external.
    let actor = if inner.own_edits.take(&key) {
        Actor::user()
    } else {
        Actor::external()
    };

    // STRICT decode. A lossy one turned every byte of a Windows-1252 or UTF-16
    // save into U+FFFD and then committed that as the note's content, rewriting
    // the user's own file with the mangled text — and a conflict recorded from
    // it stored "theirs" already corrupted, so the verbatim-preservation
    // promise did not hold. Refusing leaves their file untouched for them to
    // re-save as UTF-8.
    let Ok(text) = std::str::from_utf8(&bytes) else {
        let _ = store::note_seen(
            &inner.conn,
            &rel,
            &hash,
            store::file_mtime(&abs),
            bytes.len() as i64,
        );
        return ImportOutcome::Failed(format!(
            "{rel} is not valid UTF-8 — re-save it as UTF-8; it was not imported"
        ));
    };
    let (fm, body) = projector::parse_frontmatter(text);
    let fm_id = fm.as_ref().and_then(|f| f.id.clone());
    // A file that moved keeps its identity: rebind the path before importing,
    // so the note follows the file instead of being archived at the old path
    // and later re-projected there, leaving two files claiming one id.
    if let Some(id) = fm_id.as_deref() {
        rebind_if_moved(inner, id, &rel);
    }
    let outcome = match fm_id {
        Some(id) if inner.graph.note(&id).is_some() => {
            import_known(inner, &rel, &id, &body, fm.as_ref(), &actor)
        }
        Some(id) if is_valid_id(&id, ID_NOTE) => {
            // A project copied in from elsewhere, or a database we rebuilt:
            // keep the id the file carries so links and history line up.
            adopt(inner, &rel, &body, fm.as_ref(), Some(id), &actor)
        }
        // No usable id in the frontmatter. Before minting a new note, check
        // whether an entity already owns this PATH — stripping the frontmatter
        // block out of a file is a natural thing for someone to do, and it used
        // to make the file permanently unimportable (a core doc silently
        // Skipped, a normal note failing the file_path UNIQUE constraint) while
        // the next projection overwrote their edits.
        _ => match inner
            .graph
            .by_file_path(&rel)
            .filter(|m| !m.archived)
            .map(|m| m.id.clone())
        {
            Some(id) => import_known(inner, &rel, &id, &body, fm.as_ref(), &actor),
            None => adopt(inner, &rel, &body, fm.as_ref(), None, &actor),
        },
    };

    // A failed import must NOT be recorded as seen, or the mtime+size fast skip
    // makes `knowledge_rescan` — the designed recovery path — skip the very
    // file that needs retrying.
    if !matches!(outcome, ImportOutcome::Failed(_)) {
        let _ = store::note_seen(
            &inner.conn,
            &rel,
            &hash,
            store::file_mtime(&abs),
            bytes.len() as i64,
        );
    }
    outcome
}

/// Follow a file that moved. Only acts when the entity's recorded path no
/// longer exists, so a copy does not steal the original's identity.
fn rebind_if_moved(inner: &mut Inner, id: &str, rel: &str) {
    let Some(meta) = inner.graph.note(id).cloned() else {
        return;
    };
    if meta.file_path == rel || meta.pinned_core {
        return; // Core singletons have fixed paths.
    }
    if projector::note_path(&inner.memory_dir, &meta.file_path).exists() {
        return; // Both files exist — this is a copy, not a move.
    }
    match store::rebind_file_path(inner, id, rel) {
        Ok(_) => dlog(&format!(
            "[knowledge] {} moved to {rel}, rebound by frontmatter id",
            meta.file_path
        )),
        Err(e) => dlog(&format!("[knowledge] rebind {rel} failed: {e}")),
    }
}

/// A file we already know: commit its body against the revision the frontmatter
/// says the editor was looking at.
fn import_known(
    inner: &mut Inner,
    rel: &str,
    id: &str,
    body: &str,
    fm: Option<&projector::Frontmatter>,
    actor: &Actor,
) -> ImportOutcome {
    let Some(mut meta) = inner.graph.note(id).cloned() else {
        return ImportOutcome::Skipped;
    };

    // The file demonstrably exists — import_path only reaches here after a
    // successful read — so an archived entity has been resurrected. A safe-save
    // or sync tool that deletes and recreates a file more than one debounce
    // window apart archived the note on the first batch, and nothing on the
    // import side ever cleared the flag: the note stayed invisible in the
    // sidebar and in search while its file sat current on disk.
    if meta.archived {
        match store::restore_note(inner, id, actor) {
            Ok(_) => {
                dlog(&format!("[knowledge] {rel} reappeared — un-archived"));
                match inner.graph.note(id).cloned() {
                    Some(fresh) => meta = fresh,
                    None => return ImportOutcome::Skipped,
                }
            }
            Err(e) => return ImportOutcome::Failed(e),
        }
    }

    let is_tasks = meta.note_type == "tasks";

    if hash_str(body) == meta.content_hash {
        return ImportOutcome::Unchanged;
    }

    // The frontmatter revision is exactly what the external editor was looking
    // at when it started typing — that is what makes this an honest three-way
    // base rather than a guess.
    let base = fm.and_then(|f| f.revision).unwrap_or(meta.revision);
    let title = projector::title_from_body(body).unwrap_or_else(|| meta.title.clone());
    let tags = fm.map(|f| f.tags.clone()).unwrap_or_else(|| meta.tags.clone());

    let result = store::update_note(
        inner,
        UpdateNoteInput {
            id: id.to_string(),
            base_revision: base,
            content: body.to_string(),
            title: Some(title),
            tags: Some(tags),
            reason: Some("file edit".into()),
        },
        actor,
        store::SOURCE_FILE,
    );

    let outcome = match result {
        Ok(r) if r.status == store::STATUS_CONFLICT => ImportOutcome::Conflict,
        Ok(r) if r.status == store::STATUS_MERGED => ImportOutcome::Merged(r.revision),
        Ok(r) if r.status == store::STATUS_NOOP => ImportOutcome::Unchanged,
        Ok(r) => ImportOutcome::Committed(r.revision),
        Err(e) => ImportOutcome::Failed(e),
    };

    // Task rows are reconciled from the COMMITTED head, and only when the doc
    // commit was actually accepted.
    //
    // Doing it first, from the incoming body, meant a stale TASKS.md — a
    // `git checkout` of an older branch is the everyday way to get one — flipped
    // task statuses in the table with no revision check at all. The document
    // commit that followed then conflicted and was rejected, but the table had
    // already been rewritten, and the next task operation regenerated TASKS.md
    // from it: the conflict machinery refused the write and the write happened
    // anyway. Worse, when the stale file matched an older snapshot exactly the
    // commit was a noop and the reverted checkboxes were regenerated into the
    // doc immediately, with no conflict recorded at all.
    if is_tasks && matches!(outcome, ImportOutcome::Committed(_) | ImportOutcome::Merged(_)) {
        if let Ok(head) = store::note_content(&inner.conn, id) {
            let _ = store::import_task_lines(inner, &head, actor);
            let _ = store::regenerate_tasks_doc(inner, actor);
        }
    }
    outcome
}

/// A file the store has never seen. Mint (or preserve) an id, write the
/// frontmatter back, and record it as a note — an agent that creates a bare
/// `.md` should not have to know about our metadata to be heard.
fn adopt(
    inner: &mut Inner,
    rel: &str,
    body: &str,
    fm: Option<&projector::Frontmatter>,
    preset_id: Option<String>,
    actor: &Actor,
) -> ImportOutcome {
    let file_name = rel.rsplit('/').next().unwrap_or(rel);
    let note_type = projector::core_type_for_file(rel)
        .map(|t| t.to_string())
        .or_else(|| fm.and_then(|f| f.note_type.clone()))
        .unwrap_or_else(|| "note".to_string());
    // A core document adopted from disk is still a singleton — if one already
    // exists this file cannot become a second one.
    if projector::core_type_for_file(rel).is_some() && inner.graph.by_type(&note_type).is_some() {
        return ImportOutcome::Skipped;
    }
    let title = projector::title_from_body(body)
        .unwrap_or_else(|| file_name.trim_end_matches(".md").replace(['-', '_'], " "));

    let result = store::create_note(
        inner,
        CreateNoteInput {
            title,
            content: body.to_string(),
            note_type: Some(note_type),
            tags: fm.map(|f| f.tags.clone()).unwrap_or_default(),
            file_path: Some(rel.to_string()),
            preset_id,
            pinned_core: projector::core_type_for_file(rel).is_some(),
        },
        actor,
    );
    match result {
        Ok(r) => {
            let _ = store::record_event(
                inner,
                store::EV_IMPORT_ADOPTED,
                Some(&r.id),
                actor,
                &format!("adopted {rel}"),
            );
            super::events::record(inner, store::EV_IMPORT_ADOPTED, Some(&r.id), actor);
            ImportOutcome::Adopted(r.id)
        }
        Err(e) => ImportOutcome::Failed(e),
    }
}

/// One retry on failure: a writer that has the file open for a moment is common
/// on Windows, and giving up would lose the edit until the next rescan.
fn read_with_retry(path: &Path) -> Option<Vec<u8>> {
    match std::fs::read(path) {
        Ok(b) => Some(b),
        Err(_) if path.exists() => {
            std::thread::sleep(Duration::from_millis(50));
            std::fs::read(path).ok()
        }
        Err(_) => None,
    }
}

/// Walk the whole projection and import anything that changed while we were not
/// watching. Also the `knowledge_rescan` body, which is the documented fallback
/// for `\\wsl.localhost` projects where notify may never fire.
pub fn reconcile_walk(inner: &mut Inner) -> usize {
    if inner.read_only {
        return 0;
    }
    let mut imported = 0usize;
    for rel in list_markdown(&inner.memory_dir) {
        let abs = projector::note_path(&inner.memory_dir, &rel);
        // Fast skip: unchanged size AND mtime means we already have this file.
        if let Some((mtime, size, _)) = store::sync_state_for(&inner.conn, &rel) {
            let meta = std::fs::metadata(&abs).ok();
            let cur_size = meta.as_ref().map(|m| m.len() as i64).unwrap_or(-1);
            if mtime != 0 && mtime == store::file_mtime(&abs) && size == cur_size {
                continue;
            }
        }
        if import_path(inner, &rel).counts() {
            imported += 1;
        }
    }

    // A note whose file is missing at OPEN time is either an incomplete
    // projection (fresh clone, interrupted write) or a deletion that happened
    // while MADE was closed. `sync_state` tells them apart: a file we have
    // actually observed on disk has a non-zero `last_seen_mtime`, whereas a
    // crash between the create transaction and the first write leaves it 0.
    //
    // Re-projecting unconditionally resurrected deliberately deleted files —
    // and in a shared repo it looped: one person archives a note and commits
    // the removal, the other pulls with MADE closed, and their next open
    // recreates the file and can commit it straight back.
    let missing: Vec<String> = inner
        .graph
        .list(false)
        .into_iter()
        .filter(|n| !projector::note_path(&inner.memory_dir, &n.file_path).exists())
        .map(|n| n.id)
        .collect();
    for id in missing {
        let Some(meta) = inner.graph.note(&id).cloned() else {
            continue;
        };
        let seen_before = store::sync_state_for(&inner.conn, &meta.file_path)
            .map(|(mtime, _, _)| mtime != 0)
            .unwrap_or(false);
        // Core singletons must always exist, and archive_note refuses them
        // anyway — repair those rather than archiving.
        if seen_before && !meta.pinned_core {
            if store::archive_note(inner, &id, &Actor::external(), false).is_ok() {
                dlog(&format!(
                    "[knowledge] {} was deleted while MADE was closed — archived",
                    meta.file_path
                ));
                imported += 1;
            }
            continue;
        }
        let Ok(body) = store::note_content(&inner.conn, &id) else {
            continue;
        };
        if store::project(inner, &meta, &body).is_ok() {
            imported += 1;
        }
    }
    imported
}

/// Every `.md` under `.project-memory/` and `.project-memory/notes/`, as paths
/// relative to the memory directory.
fn list_markdown(memory_dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut push_dir = |dir: PathBuf, prefix: &str| {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.to_ascii_lowercase().ends_with(".md") || name.starts_with('.') {
                continue;
            }
            if !entry.path().is_file() {
                continue;
            }
            out.push(format!("{prefix}{name}"));
        }
    };
    push_dir(memory_dir.to_path_buf(), "");
    push_dir(memory_dir.join(NOTES_DIR), &format!("{NOTES_DIR}/"));
    out.sort();
    out
}

// ---------------------------------------------------------------------------
// notify plumbing
// ---------------------------------------------------------------------------

/// Watch `.project-memory/` and `.project-memory/notes/`, non-recursively.
pub fn start(project: &Arc<ProjectKnowledge>) -> Result<WatchHandle, String> {
    let memory_dir = project.memory_dir.clone();
    let notes_dir = memory_dir.join(NOTES_DIR);
    let _ = std::fs::create_dir_all(&notes_dir);

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if matches!(event.kind, EventKind::Access(_)) {
            return;
        }
        for path in &event.paths {
            let _ = tx.send(path.to_string_lossy().to_string());
        }
    })
    .map_err(|e| format!("create watcher: {e}"))?;

    for dir in [&memory_dir, &notes_dir] {
        watcher
            .watch(dir, RecursiveMode::NonRecursive)
            .map_err(|e| format!("watch {}: {e}", dir.display()))?;
    }

    let weak: Weak<ProjectKnowledge> = Arc::downgrade(project);
    if let Some(handle) = super::runtime_handle() {
        handle.spawn(async move {
            while let Some(first) = rx.recv().await {
                let mut batch: HashSet<String> = HashSet::from([first]);
                // Trailing debounce: keep collecting until the writes stop.
                loop {
                    match tokio::time::timeout(Duration::from_millis(DEBOUNCE_MS), rx.recv()).await
                    {
                        Ok(Some(p)) => {
                            batch.insert(p);
                        }
                        Ok(None) => break,
                        Err(_) => break,
                    }
                }
                let Some(project) = weak.upgrade() else { break };
                let rels: Vec<String> = batch
                    .iter()
                    .filter_map(|p| relative_to(&project.memory_dir, p))
                    .collect();
                if rels.is_empty() {
                    continue;
                }
                project.with_inner(|inner| {
                    for rel in rels {
                        match import_path(inner, &rel) {
                            ImportOutcome::Failed(e) => {
                                dlog(&format!("[knowledge] import {rel} failed: {e}"))
                            }
                            ImportOutcome::Conflict => {
                                dlog(&format!("[knowledge] conflict importing {rel}"))
                            }
                            _ => {}
                        }
                    }
                });
            }
        });
    }

    // EVERY project gets a reconcile poll on top of notify. Notify is the
    // fast path (~1s via the debounce) where the OS actually delivers events
    // — but it provably never fires on WSL's 9P bridge (`\\wsl.localhost`,
    // the daily case here), and other path classes fail quietly in their own
    // ways (network shares, mapped drives). Rather than enumerate the broken
    // ones, external edits are absorbed on ALL paths (user rule 2026-08-08)
    // and the poll is the guaranteed floor. It is cheap: `note_seen`'s
    // mtime+size fast-skip means an unchanged project costs one directory
    // listing per tick. The task holds only a Weak and re-checks registry
    // membership, so it dies with the project and can never race
    // `knowledge_remove`'s teardown.
    {
        let weak: Weak<ProjectKnowledge> = Arc::downgrade(project);
        let key = project.key.clone();
        if let Some(handle) = super::runtime_handle() {
            handle.spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_millis(RECONCILE_POLL_MS)).await;
                    let Some(project) = weak.upgrade() else { break };
                    if super::get(&key).is_none() {
                        break; // closed or removed — stop before touching disk
                    }
                    if project.read_only() {
                        continue; // followers must not import
                    }
                    project.with_inner(|inner| {
                        let _ = reconcile_walk(inner);
                    });
                }
            });
        }
    }

    Ok(WatchHandle {
        _watcher: Some(watcher),
    })
}

/// The guaranteed ceiling on how long an external edit stays unimported, on
/// any path. Where notify works, the debounce lands changes in ~1s and the
/// poll finds nothing to do. A tick on an unchanged project is two directory
/// listings plus a stat per note (the `note_seen` mtime+size fast-skip), tens
/// of milliseconds even over 9P — which is why 2s is affordable. Below ~1s
/// the poll would just burn 9P round-trips to beat its own granularity.
const RECONCILE_POLL_MS: u64 = 2_000;

/// Read-only instances cannot import, but they still have to notice that the
/// owning instance committed something. Watching the database's `-wal` is the
/// cheapest signal for that.
pub fn start_follower(project: &Arc<ProjectKnowledge>) -> Result<WatchHandle, String> {
    let Some(dir) = super::knowledge_dir() else {
        return Ok(WatchHandle { _watcher: None });
    };
    let wal_name = format!(
        "{}-wal",
        project
            .db_path
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_default()
    );

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    // Cloned BEFORE the sender moves into the notify closure, so a failed
    // rehydrate can re-arm itself.
    let retry_tx = tx.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if matches!(event.kind, EventKind::Access(_)) {
            return;
        }
        if event.paths.iter().any(|p| {
            p.file_name()
                .map(|f| f.to_string_lossy() == wal_name)
                .unwrap_or(false)
        }) {
            let _ = tx.send(());
        }
    })
    .map_err(|e| format!("create follower watcher: {e}"))?;
    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| format!("watch {}: {e}", dir.display()))?;

    let weak: Weak<ProjectKnowledge> = Arc::downgrade(project);
    if let Some(handle) = super::runtime_handle() {
        handle.spawn(async move {
            while rx.recv().await.is_some() {
                loop {
                    match tokio::time::timeout(
                        Duration::from_millis(FOLLOWER_DEBOUNCE_MS),
                        rx.recv(),
                    )
                    .await
                    {
                        Ok(Some(())) => continue,
                        _ => break,
                    }
                }
                let Some(project) = weak.upgrade() else { break };
                let refreshed = project.with_inner(|inner| {
                    match store::hydrate_graph(&inner.conn) {
                        Ok(g) => {
                            inner.graph = g;
                            Some((
                                store::latest_seq(&inner.conn),
                                store::open_conflict_count(&inner.conn),
                            ))
                        }
                        // Never silently. A follower that fails to rehydrate
                        // shows stale memory until some unrelated commit
                        // happens to trigger the loop again, so say so and
                        // queue exactly one more attempt.
                        Err(e) => {
                            dlog(&format!("[knowledge] follower rehydrate failed: {e}"));
                            let _ = retry_tx.send(());
                            None
                        }
                    }
                });
                if let Some((revision, conflicts)) = refreshed {
                    super::events::emit_now(
                        &project.key,
                        &project.root.to_string_lossy(),
                        revision,
                        &["follower.refresh"],
                        conflicts,
                    );
                }
            }
        });
    }

    Ok(WatchHandle {
        _watcher: Some(watcher),
    })
}

/// A watched path as a memory-dir-relative key, or None when it is not ours.
fn relative_to(memory_dir: &Path, path: &str) -> Option<String> {
    let base = norm_path(&memory_dir.to_string_lossy());
    let candidate = norm_path(path);
    let rest = candidate.strip_prefix(&base)?.trim_start_matches('/');
    if rest.is_empty() || rest.starts_with(SYSTEM_DIR) {
        return None;
    }
    // Only the two directories we watch — never a deeper nesting.
    let depth = rest.matches('/').count();
    if depth > 1 || (depth == 1 && !rest.starts_with(&format!("{NOTES_DIR}/"))) {
        return None;
    }
    // Recover the on-disk spelling: the graph and sync_state key off the
    // relative path as we wrote it, and Windows may hand back other casing.
    let actual = Path::new(path)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())?;
    Some(if depth == 1 {
        format!("{NOTES_DIR}/{actual}")
    } else {
        actual
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::testutil::{fixture, Fixture};
    use crate::knowledge::{graph, projector::render_file};

    /// What an external editor holds after opening the file: the frontmatter as
    /// it was at that moment, revision included.
    fn open_in_editor(f: &Fixture, rel: &str) -> NoteMeta {
        let text = std::fs::read_to_string(f.file(rel)).expect("read projection");
        let (fm, _) = projector::parse_frontmatter(&text);
        let fm = fm.expect("projected files carry frontmatter");
        let mut meta = f
            .inner
            .graph
            .note(fm.id.as_deref().expect("frontmatter id"))
            .expect("known note")
            .clone();
        meta.revision = fm.revision.unwrap_or(meta.revision);
        meta
    }

    /// Save from that editor's buffer. The frontmatter still carries the
    /// revision it opened at, which is exactly what makes a stale save stale —
    /// the store may have moved on in the meantime.
    fn save_from_editor(f: &Fixture, rel: &str, opened: &NoteMeta, new_body: &str) {
        std::fs::write(f.file(rel), render_file(opened, new_body)).expect("write");
    }

    /// Open and save with nothing happening in between.
    fn external_edit(f: &Fixture, rel: &str, new_body: &str) {
        let opened = open_in_editor(f, rel);
        save_from_editor(f, rel, &opened, new_body);
    }

    #[test]
    fn external_edit_commits_a_new_revision() {
        let mut f = fixture();
        let note = f.note("Doc", "# Doc\n\noriginal\n");
        external_edit(&f, &note.file_path, "# Doc\n\nedited by hand\n");

        let outcome = import_path(&mut f.inner, &note.file_path);
        assert_eq!(outcome, ImportOutcome::Committed(2));
        let meta = f.inner.graph.note(&note.id).unwrap();
        assert_eq!(meta.revision, 2);
        assert_eq!(meta.updated_by, "external");
        assert!(store::note_content(&f.inner.conn, &note.id)
            .unwrap()
            .contains("edited by hand"));
        // The re-projection refreshed the frontmatter revision.
        let text = std::fs::read_to_string(f.file(&note.file_path)).unwrap();
        assert!(text.contains("revision: 2"));
    }

    #[test]
    fn own_edit_marks_attribute_the_save_to_the_user() {
        let mut f = fixture();
        let note = f.note("Doc", "# Doc\n\noriginal\n");
        external_edit(&f, &note.file_path, "# Doc\n\nsaved in MADE\n");

        let key = norm_path(&f.file(&note.file_path).to_string_lossy());
        f.inner.own_edits.mark(key);
        assert_eq!(import_path(&mut f.inner, &note.file_path), ImportOutcome::Committed(2));
        assert_eq!(f.inner.graph.note(&note.id).unwrap().updated_by, "user");
    }

    #[test]
    fn self_write_is_suppressed() {
        let mut f = fixture();
        let note = f.note("Doc", "# Doc\n\nbody\n");
        // The projection just happened, so the ledger holds these exact bytes.
        assert_eq!(import_path(&mut f.inner, &note.file_path), ImportOutcome::Skipped);
        assert_eq!(f.inner.graph.note(&note.id).unwrap().revision, 1);
        // Consumed — a genuine later event for an unchanged file reads as
        // unchanged, still without a revision.
        assert_eq!(import_path(&mut f.inner, &note.file_path), ImportOutcome::Unchanged);
        assert_eq!(f.inner.graph.note(&note.id).unwrap().revision, 1);
    }

    #[test]
    fn external_conflicting_edit_records_theirs_and_rewrites_the_file() {
        let mut f = fixture();
        let note = f.note("Doc", "# Doc\n\nline one\nline two\nline three\n");
        // Someone opens the file at revision 1...
        let opened = open_in_editor(&f, &note.file_path);
        // ...the store moves on in the same region while they type...
        f.update(&note.id, 1, "# Doc\n\nline one\nOUR EDIT\nline three\n");
        // ...and only then do they save.
        save_from_editor(
            &f,
            &note.file_path,
            &opened,
            "# Doc\n\nline one\nTHEIR EDIT\nline three\n",
        );

        assert_eq!(import_path(&mut f.inner, &note.file_path), ImportOutcome::Conflict);

        // Head stands, their version is preserved verbatim...
        let conflicts = store::list_conflicts(&f.inner).unwrap();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].source, store::SOURCE_FILE);
        assert!(conflicts[0].theirs_content.contains("THEIR EDIT"));
        // ...and the file shows the authoritative head, not the rejected edit.
        let on_disk = std::fs::read_to_string(f.file(&note.file_path)).unwrap();
        assert!(on_disk.contains("OUR EDIT"));
        assert!(!on_disk.contains("THEIR EDIT"));
    }

    #[test]
    fn external_edit_far_from_ours_merges() {
        let mut f = fixture();
        let note = f.note(
            "Doc",
            "# Doc\n\nalpha\n\nbeta\n\ngamma\n\ndelta\n\nepsilon\n",
        );
        let opened = open_in_editor(&f, &note.file_path);
        // The store edits the top while the editor's buffer edits the bottom.
        f.update(
            &note.id,
            1,
            "# Doc\n\nALPHA\n\nbeta\n\ngamma\n\ndelta\n\nepsilon\n",
        );
        save_from_editor(
            &f,
            &note.file_path,
            &opened,
            "# Doc\n\nalpha\n\nbeta\n\ngamma\n\ndelta\n\nEPSILON\n",
        );

        assert_eq!(import_path(&mut f.inner, &note.file_path), ImportOutcome::Merged(3));
        let body = store::note_content(&f.inner.conn, &note.id).unwrap();
        assert!(body.contains("ALPHA") && body.contains("EPSILON"));
        assert!(store::list_conflicts(&f.inner).unwrap().is_empty());
    }

    #[test]
    fn frontmatterless_file_is_adopted() {
        let mut f = fixture();
        let path = f.inner.memory_dir.join("notes/scratch.md");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "# Scratch\n\nwritten by an agent\n").unwrap();

        let outcome = import_path(&mut f.inner, "notes/scratch.md");
        let ImportOutcome::Adopted(id) = outcome else {
            panic!("expected adoption, got {outcome:?}");
        };
        let meta = f.inner.graph.note(&id).unwrap().clone();
        assert_eq!(meta.title, "Scratch");
        assert_eq!(meta.file_path, "notes/scratch.md");
        assert_eq!(meta.updated_by, "external");

        // The file gained frontmatter, in place.
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("---\nid: "));
        assert!(text.contains("written by an agent"));
        // Adoption is recorded as its own event, not just a creation.
        let (events, _) = store::recent_events(&f.inner.conn, None, 20).unwrap();
        assert!(events.iter().any(|e| e.event_type == store::EV_IMPORT_ADOPTED));
        // Re-importing is a no-op.
        assert_eq!(import_path(&mut f.inner, "notes/scratch.md"), ImportOutcome::Skipped);
    }

    #[test]
    fn unknown_but_valid_id_is_adopted_keeping_the_id() {
        let mut f = fixture();
        let id = new_id(ID_NOTE);
        let body = "# Carried Over\n\nfrom another machine\n";
        let text = format!(
            "---\nid: {id}\ntype: note\nrevision: 7\ncreated_by: claude\nupdated_by: claude\n\
             created_at: 2026-01-01T00:00:00Z\nupdated_at: 2026-01-02T00:00:00Z\ntags:\n  - moved\n---\n{body}"
        );
        let path = f.inner.memory_dir.join("notes/carried.md");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, text).unwrap();

        let outcome = import_path(&mut f.inner, "notes/carried.md");
        assert_eq!(outcome, ImportOutcome::Adopted(id.clone()));
        let meta = f.inner.graph.note(&id).unwrap();
        assert_eq!(meta.title, "Carried Over");
        assert_eq!(meta.tags, vec!["moved".to_string()]);
        // History restarts at 1 — we have no snapshots for the old revisions.
        assert_eq!(meta.revision, 1);
    }

    #[test]
    fn deleted_file_archives_and_restore_puts_it_back() {
        let mut f = fixture();
        let note = f.note("Temp", "# Temp\n\nbody\n");
        std::fs::remove_file(f.file(&note.file_path)).unwrap();

        assert_eq!(import_path(&mut f.inner, &note.file_path), ImportOutcome::Archived);
        assert!(f.inner.graph.note(&note.id).unwrap().archived);
        // The row survived, so restore re-projects it.
        store::restore_note(&mut f.inner, &note.id, &Actor::user()).unwrap();
        assert!(f.file(&note.file_path).exists());
        // A second event for a still-absent, already-archived note is inert.
        std::fs::remove_file(f.file(&note.file_path)).unwrap();
        assert_eq!(import_path(&mut f.inner, &note.file_path), ImportOutcome::Archived);
        assert_eq!(import_path(&mut f.inner, &note.file_path), ImportOutcome::Skipped);
    }

    #[test]
    fn non_markdown_and_system_paths_are_ignored() {
        let mut f = fixture();
        assert_eq!(import_path(&mut f.inner, "notes/image.png"), ImportOutcome::Skipped);
        assert_eq!(
            import_path(&mut f.inner, ".system/manifest.json"),
            ImportOutcome::Skipped
        );
    }

    #[test]
    fn reconcile_walk_imports_offline_edits_and_repairs_missing_files() {
        let mut f = fixture();
        store::scaffold(&mut f.inner).expect("scaffold");
        let note = f.note("Doc", "# Doc\n\nbody\n");

        // An edit that happened while MADE was closed.
        external_edit(&f, &note.file_path, "# Doc\n\nedited offline\n");
        // ...and a file that went missing entirely.
        std::fs::remove_file(f.file("STATE.md")).unwrap();

        let imported = reconcile_walk(&mut f.inner);
        assert!(imported >= 2, "expected both repairs, got {imported}");
        assert_eq!(f.inner.graph.note(&note.id).unwrap().revision, 2);
        assert!(
            f.file("STATE.md").exists(),
            "a missing file at open time is re-projected, not archived"
        );
        // Second walk has nothing to do.
        assert_eq!(reconcile_walk(&mut f.inner), 0);
    }

    #[test]
    fn rebuild_from_markdown_round_trip() {
        // The project-move and corruption story: throw the database away and
        // rebuild everything from the files alone.
        let mut f = fixture();
        store::scaffold(&mut f.inner).expect("scaffold");
        let alpha = f.note("Alpha", "# Alpha\n\nlinks to [[Beta]]\n");
        let beta = f.note("Beta", "# Beta\n\nbody\n");
        f.update(&alpha.id, 1, "# Alpha\n\nstill links to [[Beta]]\n");

        let memory_dir = f.inner.memory_dir.clone();
        let project_path = f.inner.project_path.clone();
        let fresh_db = f.dir.path().join("rebuilt.db");
        let conn = store::open_db(&fresh_db, false).unwrap();
        store::run_migrations(&conn).unwrap();
        let mut rebuilt = Inner {
            conn,
            graph: store::hydrate_graph(&f.inner.conn).map(|_| Default::default()).unwrap(),
            ledger: Default::default(),
            own_edits: Default::default(),
            memory_dir,
            project_key: f.inner.project_key.clone(),
            project_path,
            db_file_name: "rebuilt.db".into(),
            read_only: false,
            granted: Default::default(),
            writer_lock: None,
        };
        reconcile_walk(&mut rebuilt);

        // Same ids, same titles, same content, same links.
        assert_eq!(rebuilt.graph.len(), f.inner.graph.len());
        for original in f.inner.graph.list(true) {
            let copy = rebuilt
                .graph
                .note(&original.id)
                .unwrap_or_else(|| panic!("{} missing after rebuild", original.title));
            assert_eq!(copy.title, original.title);
            assert_eq!(copy.file_path, original.file_path);
            assert_eq!(
                store::note_content(&rebuilt.conn, &copy.id).unwrap(),
                store::note_content(&f.inner.conn, &original.id).unwrap()
            );
        }
        assert_eq!(rebuilt.graph.incoming_of(&beta.id).len(), 1);
        assert_eq!(
            rebuilt.graph.resolve_title("Alpha").as_deref(),
            Some(alpha.id.as_str())
        );
        let _ = graph::fold_title("");
    }

    #[test]
    fn relative_to_accepts_only_the_two_watched_directories() {
        let base = Path::new("C:/proj/.project-memory");
        assert_eq!(
            relative_to(base, "C:\\proj\\.project-memory\\STATE.md").as_deref(),
            Some("STATE.md")
        );
        assert_eq!(
            relative_to(base, "C:/proj/.project-memory/notes/a.md").as_deref(),
            Some("notes/a.md")
        );
        assert_eq!(relative_to(base, "C:/proj/.project-memory/.system/x.json"), None);
        assert_eq!(relative_to(base, "C:/proj/.project-memory/deep/dir/a.md"), None);
        assert_eq!(relative_to(base, "C:/elsewhere/a.md"), None);
    }

    /// A file renamed in Explorer keeps its identity and follows the file.
    ///
    /// Both halves of a rename land as separate events; whichever order they
    /// arrive in, the note must end up bound to the NEW path, un-archived, and
    /// must never be re-projected back to the old one.
    #[test]
    fn an_external_rename_rebinds_instead_of_archiving() {
        for old_first in [true, false] {
            let mut f = fixture();
            let note = f.note("Idea", "# Idea\n\nbody\n");
            let old_rel = note.file_path.clone();
            let new_rel = "notes/better-name.md";
            std::fs::rename(f.file(&old_rel), f.file(new_rel)).expect("rename");

            let order: [&str; 2] = if old_first {
                [&old_rel, new_rel]
            } else {
                [new_rel, &old_rel]
            };
            for rel in order {
                import_path(&mut f.inner, rel);
            }

            let meta = f.inner.graph.note(&note.id).cloned().expect("note survives");
            assert!(!meta.archived, "rename archived the note (old_first={old_first})");
            assert_eq!(
                meta.file_path, new_rel,
                "file_path was not rebound (old_first={old_first})"
            );
            assert!(
                !f.file(&old_rel).exists(),
                "the old path was resurrected (old_first={old_first})"
            );

            // A later edit must land on the new path only.
            external_edit(&f, new_rel, "# Idea\n\nedited after the move\n");
            import_path(&mut f.inner, new_rel);
            assert!(!f.file(&old_rel).exists(), "an edit re-created the old file");
            let body = store::note_content(&f.inner.conn, &note.id).expect("body");
            assert!(body.contains("edited after the move"));
        }
    }

    /// Delete-then-recreate split across two debounce batches must not leave
    /// the note archived and invisible while its file sits current on disk.
    #[test]
    fn a_recreated_file_un_archives_its_note() {
        let mut f = fixture();
        let note = f.note("Doc", "# Doc\n\nbody\n");
        let rel = note.file_path.clone();
        let saved = std::fs::read_to_string(f.file(&rel)).expect("read");

        std::fs::remove_file(f.file(&rel)).expect("remove");
        assert_eq!(import_path(&mut f.inner, &rel), ImportOutcome::Archived);
        assert!(f.inner.graph.note(&note.id).unwrap().archived);

        // The editor writes it straight back in the next batch.
        std::fs::write(f.file(&rel), &saved).expect("recreate");
        import_path(&mut f.inner, &rel);
        assert!(
            !f.inner.graph.note(&note.id).unwrap().archived,
            "the note stayed archived while its file exists"
        );
        assert_eq!(f.inner.graph.list(false).len(), 1, "it is visible again");
    }

    /// Stripping the frontmatter out of a file must not make it unimportable.
    #[test]
    fn a_frontmatter_stripped_file_still_imports_against_its_note() {
        // A core singleton: this used to be silently Skipped forever.
        let mut f = fixture();
        store::scaffold(&mut f.inner).expect("scaffold");
        let state = f.inner.graph.by_type("state").cloned().expect("state");
        std::fs::write(f.file(&state.file_path), "# State\n\nhand written, no frontmatter\n")
            .expect("strip");

        let outcome = import_path(&mut f.inner, &state.file_path);
        assert!(
            matches!(outcome, ImportOutcome::Committed(_) | ImportOutcome::Merged(_)),
            "core doc edit was dropped: {outcome:?}"
        );
        let body = store::note_content(&f.inner.conn, &state.id).expect("body");
        assert!(body.contains("hand written, no frontmatter"));
        // The commit re-projects, so the frontmatter heals itself.
        let on_disk = std::fs::read_to_string(f.file(&state.file_path)).expect("read");
        let (fm, _) = projector::parse_frontmatter(&on_disk);
        assert_eq!(
            fm.and_then(|f| f.id).as_deref(),
            Some(state.id.as_str()),
            "frontmatter was not restored"
        );

        // A normal note: this used to fail the file_path UNIQUE constraint.
        let note = f.note("Scratch", "# Scratch\n\noriginal\n");
        std::fs::write(f.file(&note.file_path), "# Scratch\n\nstripped and edited\n")
            .expect("strip");
        let outcome = import_path(&mut f.inner, &note.file_path);
        assert!(
            matches!(outcome, ImportOutcome::Committed(_) | ImportOutcome::Merged(_)),
            "note edit was dropped: {outcome:?}"
        );
        assert_eq!(f.inner.graph.list(false).len(), 8, "a duplicate note was minted");
    }

    /// A stale TASKS.md must not rewrite the task table before the document
    /// commit has been accepted.
    #[test]
    fn a_stale_tasks_file_cannot_flip_a_done_task() {
        let mut f = fixture();
        store::scaffold(&mut f.inner).expect("scaffold");
        let doc = f.inner.graph.by_type("tasks").cloned().expect("tasks doc");

        let task = store::create_task(&mut f.inner, "Ship v2", None, &Actor::user()).expect("task");
        store::update_task(
            &mut f.inner,
            &task.id,
            Some("done".into()),
            None,
            None,
            None,
            &Actor::user(),
        )
        .expect("mark done");

        // Somebody checks out an older branch: TASKS.md comes back with the box
        // unticked and stale frontmatter.
        let stale_body = format!(
            "# Tasks\n\n<!-- made:tasks:begin -->\n- [ ] Ship v2 <!--task:{}-->\n<!-- made:tasks:end -->\n",
            task.id
        );
        let mut stale_meta = doc.clone();
        stale_meta.revision = 1;
        std::fs::write(f.file(&doc.file_path), render_file(&stale_meta, &stale_body))
            .expect("write stale");

        let outcome = import_path(&mut f.inner, &doc.file_path);
        let after = store::get_task(&f.inner.conn, &task.id).expect("task");
        assert_eq!(
            after.status, "done",
            "a stale file reverted a done task (outcome {outcome:?})"
        );
    }

    /// An anchored line for an archived task is recognised, not minted again.
    #[test]
    fn an_archived_task_is_not_duplicated_by_its_anchor() {
        let mut f = fixture();
        store::scaffold(&mut f.inner).expect("scaffold");
        let task = store::create_task(&mut f.inner, "Old work", None, &Actor::user()).expect("task");
        store::update_task(
            &mut f.inner,
            &task.id,
            Some("archived".into()),
            None,
            None,
            None,
            &Actor::user(),
        )
        .expect("archive");

        let line = format!("- [ ] Old work <!--task:{}-->\n", task.id);
        store::import_task_lines(&mut f.inner, &line, &Actor::external()).expect("import");
        store::import_task_lines(&mut f.inner, &line, &Actor::external()).expect("import again");

        assert!(
            store::list_tasks(&f.inner.conn, true).expect("tasks").is_empty(),
            "an archived task was resurrected or duplicated"
        );
        assert_eq!(
            store::get_task(&f.inner.conn, &task.id).expect("still there").status,
            "archived"
        );
    }

    /// A file deleted while MADE was closed stays deleted.
    #[test]
    fn a_file_deleted_while_closed_is_archived_not_resurrected() {
        let mut f = fixture();
        let note = f.note("Junk", "# Junk\n\nbody\n");
        let rel = note.file_path.clone();
        // The projection has been observed on disk, which is what distinguishes
        // a deletion from a projection that never completed.
        assert!(f.file(&rel).exists());
        std::fs::remove_file(f.file(&rel)).expect("delete while closed");

        reconcile_walk(&mut f.inner);

        assert!(
            !f.file(&rel).exists(),
            "a deliberately deleted file was recreated"
        );
        assert!(
            f.inner.graph.note(&note.id).unwrap().archived,
            "the deletion was not recorded as an archive"
        );
    }

    /// ...but a core doc whose file is missing is still repaired, and so is a
    /// note whose first projection never landed.
    #[test]
    fn a_missing_core_doc_is_still_repaired() {
        let mut f = fixture();
        store::scaffold(&mut f.inner).expect("scaffold");
        let state = f.inner.graph.by_type("state").cloned().expect("state");
        std::fs::remove_file(f.file(&state.file_path)).expect("remove");

        reconcile_walk(&mut f.inner);

        assert!(f.file(&state.file_path).exists(), "core doc was not repaired");
        assert!(!f.inner.graph.note(&state.id).unwrap().archived);
    }

    /// Non-UTF-8 bytes are refused, not mangled into U+FFFD and committed.
    #[test]
    fn a_non_utf8_save_is_refused_and_leaves_the_file_alone() {
        let mut f = fixture();
        let note = f.note("Cafe", "# Cafe\n\ncafé au lait\n");
        let rel = note.file_path.clone();

        // Windows-1252: 0xE9 for 'é' is not valid UTF-8.
        let mut ansi: Vec<u8> = b"---\nid: ".to_vec();
        ansi.extend_from_slice(note.id.as_bytes());
        ansi.extend_from_slice(b"\ntype: note\nrevision: 1\n---\n\n# Cafe\n\ncaf\xE9 au lait!\n");
        std::fs::write(f.file(&rel), &ansi).expect("write ansi");

        let outcome = import_path(&mut f.inner, &rel);
        assert!(
            matches!(outcome, ImportOutcome::Failed(_)),
            "mangled bytes were imported: {outcome:?}"
        );
        // The head is untouched and the user's own bytes are still on disk for
        // them to re-save.
        assert_eq!(f.inner.graph.note(&note.id).unwrap().revision, 1);
        assert_eq!(std::fs::read(f.file(&rel)).expect("read"), ansi);
        let body = store::note_content(&f.inner.conn, &note.id).expect("body");
        assert!(!body.contains('\u{FFFD}'), "replacement chars reached the store");
    }
}
