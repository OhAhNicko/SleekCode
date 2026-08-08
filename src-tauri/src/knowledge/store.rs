//! SQLite: connection lifecycle, migrations, and every statement in the module.
//!
//! The commit pipeline here is the whole point of the service. Two agents and a
//! human can write the same document, and the rule is that NOTHING is ever
//! silently discarded: a stale write either merges cleanly, is recognised as a
//! duplicate, or becomes a conflict record holding the losing side verbatim.
//! Last-writer-wins is the one outcome this file exists to prevent.
//!
//! Every mutation runs in one IMMEDIATE transaction covering the note, its
//! revision snapshot, its link diff and the event row, so a crash mid-commit
//! leaves the store on one side of the change or the other. Graph mutation and
//! the markdown projection happen AFTER that transaction commits — they are
//! caches of it, and rebuilding them is always possible.

use std::collections::HashMap;
use std::path::Path;

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};

use super::graph::{self, Graph, RelationMeta};
use super::merge;
use super::model::*;
use super::projector::{self, CORE_DOCS};
use super::schema;
use super::Inner;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

pub const POLICY_READ_ONLY: &str = "read-only";
pub const POLICY_ASK: &str = "ask";
pub const POLICY_TRUSTED: &str = "trusted";

pub const META_PROJECT_KEY: &str = "project_key";
pub const META_PROJECT_ROOT: &str = "project_root";
pub const META_CREATED_AT: &str = "created_at";
pub const META_POLICY: &str = "write_policy";
pub const META_REBUILT_AT: &str = "rebuilt_at";

pub const EV_NOTE_CREATED: &str = "note.created";
pub const EV_NOTE_UPDATED: &str = "note.updated";
pub const EV_NOTE_MERGED: &str = "note.merged";
pub const EV_NOTE_ARCHIVED: &str = "note.archived";
pub const EV_NOTE_RESTORED: &str = "note.restored";
pub const EV_NOTE_RENAMED: &str = "note.renamed";
pub const EV_CONFLICT_CREATED: &str = "conflict.created";
pub const EV_CONFLICT_RESOLVED: &str = "conflict.resolved";
pub const EV_HANDOFF_CREATED: &str = "handoff.created";
pub const EV_HANDOFF_CONSUMED: &str = "handoff.consumed";
pub const EV_TASK_CREATED: &str = "task.created";
pub const EV_TASK_UPDATED: &str = "task.updated";
pub const EV_IMPORT_ADOPTED: &str = "import.adopted";
pub const EV_IMPORT_MOVED: &str = "import.moved";
pub const EV_STORE_REBUILT: &str = "store.rebuilt";
pub const EV_CONTEXT_RESOLVED: &str = "context.resolved";
pub const EV_RELATION_ADDED: &str = "relation.added";

pub const STATUS_OK: &str = "ok";
pub const STATUS_MERGED: &str = "merged";
pub const STATUS_NOOP: &str = "noop";
pub const STATUS_CONFLICT: &str = "conflict";

pub const SOURCE_API: &str = "api";
pub const SOURCE_FILE: &str = "file";

/// Markers delimiting the part of TASKS.md this service owns. Everything
/// outside them is the user's and survives every regeneration.
pub const TASKS_BEGIN: &str = "<!-- made:tasks:begin -->";
pub const TASKS_END: &str = "<!-- made:tasks:end -->";

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

pub fn open_db(path: &Path, read_only: bool) -> Result<Connection, String> {
    let flags = if read_only {
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX
    } else {
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
    };
    let conn = Connection::open_with_flags(path, flags)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    apply_pragmas(&conn, read_only)?;
    Ok(conn)
}

fn apply_pragmas(conn: &Connection, read_only: bool) -> Result<(), String> {
    // WAL is what lets a second MADE instance read while this one writes.
    // synchronous=NORMAL is the documented safe pairing with WAL: a power loss
    // can lose the tail of the log, never the database.
    let mut sql = String::from(
        "PRAGMA busy_timeout=5000;\
         PRAGMA foreign_keys=ON;\
         PRAGMA cache_size=-8000;\
         PRAGMA temp_store=MEMORY;",
    );
    if !read_only {
        sql.push_str("PRAGMA journal_mode=WAL;PRAGMA synchronous=NORMAL;");
    }
    conn.execute_batch(&sql)
        .map_err(|e| format!("pragmas: {e}"))?;
    conn.set_prepared_statement_cache_capacity(64);
    Ok(())
}

/// Bring the database up to `CURRENT_SCHEMA_VERSION`, or report that it is
/// already past it.
pub fn run_migrations(conn: &Connection) -> Result<Option<i32>, String> {
    let version: i32 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| format!("read user_version: {e}"))?;
    if version > schema::CURRENT_SCHEMA_VERSION {
        return Ok(Some(version));
    }
    for (idx, ddl) in schema::MIGRATIONS
        .iter()
        .enumerate()
        .skip(version.max(0) as usize)
    {
        let target = idx as i32 + 1;
        conn.execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| format!("migration {target} begin: {e}"))?;
        let applied = conn
            .execute_batch(ddl)
            .and_then(|_| conn.execute_batch(&format!("PRAGMA user_version={target}")));
        match applied {
            Ok(()) => conn
                .execute_batch("COMMIT")
                .map_err(|e| format!("migration {target} commit: {e}"))?,
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(format!("migration {target}: {e}"));
            }
        }
    }
    Ok(None)
}

/// Cheap "is this file even a database" probe, run before we trust it.
pub fn integrity_ok(conn: &Connection) -> bool {
    conn.query_row("PRAGMA quick_check(1)", [], |r| r.get::<_, String>(0))
        .map(|s| s.eq_ignore_ascii_case("ok"))
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------

pub fn meta_get(conn: &Connection, key: &str) -> Option<String> {
    conn.prepare_cached("SELECT value FROM meta WHERE key=?1")
        .ok()?
        .query_row(params![key], |r| r.get::<_, String>(0))
        .optional()
        .ok()
        .flatten()
}

pub fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.prepare_cached("INSERT INTO meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .and_then(|mut s| s.execute(params![key, value]))
        .map(|_| ())
        .map_err(|e| format!("meta_set {key}: {e}"))
}

pub fn write_policy(conn: &Connection) -> String {
    meta_get(conn, META_POLICY).unwrap_or_else(|| POLICY_ASK.to_string())
}

/// The project's global knowledge revision: the last event seq. One counter,
/// crash-consistent with the data that produced it.
pub fn latest_seq(conn: &Connection) -> i64 {
    conn.query_row("SELECT COALESCE(MAX(seq),0) FROM events", [], |r| r.get(0))
        .unwrap_or(0)
}

pub fn open_conflict_count(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM conflicts WHERE status='open'",
        [],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

pub fn hydrate_graph(conn: &Connection) -> Result<Graph, String> {
    let mut g = Graph::default();
    // Both SELECTs read ONE snapshot. Run as two autocommit statements they
    // each took their own, so a writer committing a note plus its relations
    // between them handed the follower a relation whose source note was
    // missing — a phantom backlink and a wrong note count until some later
    // commit happened to re-hydrate.
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("hydrate begin: {e}"))?;
    {
        let mut stmt = tx
            .prepare(
                "SELECT id,type,title,slug,file_path,revision,content_hash,tags,\
                        created_at,updated_at,created_by,updated_by,archived,pinned_core \
                 FROM notes",
            )
            .map_err(|e| format!("hydrate notes: {e}"))?;
        let rows = stmt
            .query_map([], row_to_meta)
            .map_err(|e| format!("hydrate notes: {e}"))?;
        for meta in rows {
            g.upsert_note(meta.map_err(|e| format!("hydrate note row: {e}"))?);
        }
    }
    {
        let mut stmt = tx
            .prepare(
                "SELECT id,source_id,target_id,target_title,heading,rel_type,origin FROM relations",
            )
            .map_err(|e| format!("hydrate relations: {e}"))?;
        let rows = stmt
            .query_map([], |r| {
                Ok(RelationMeta {
                    id: r.get(0)?,
                    source_id: r.get(1)?,
                    target_id: r.get(2)?,
                    target_title: r.get(3)?,
                    heading: r.get(4)?,
                    rel_type: r.get(5)?,
                    origin: r.get(6)?,
                })
            })
            .map_err(|e| format!("hydrate relations: {e}"))?;
        for rel in rows {
            g.insert_relation(rel.map_err(|e| format!("hydrate relation row: {e}"))?);
        }
    }
    Ok(g)
}

fn row_to_meta(r: &rusqlite::Row<'_>) -> rusqlite::Result<NoteMeta> {
    let tags: String = r.get(7)?;
    Ok(NoteMeta {
        id: r.get(0)?,
        note_type: r.get(1)?,
        title: r.get(2)?,
        slug: r.get(3)?,
        file_path: r.get(4)?,
        revision: r.get(5)?,
        content_hash: r.get(6)?,
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        created_at: r.get(8)?,
        updated_at: r.get(9)?,
        created_by: r.get(10)?,
        updated_by: r.get(11)?,
        archived: r.get::<_, i64>(12)? != 0,
        pinned_core: r.get::<_, i64>(13)? != 0,
        // Conflict state lives in its own table; the commands that publish a
        // row to the UI fill this in with one batched lookup.
        conflict_id: None,
    })
}

pub fn note_content(conn: &Connection, id: &str) -> Result<String, String> {
    conn.prepare_cached("SELECT content FROM notes WHERE id=?1")
        .and_then(|mut s| s.query_row(params![id], |r| r.get::<_, String>(0)))
        .map_err(|_| format!("note {id} not found"))
}

// ---------------------------------------------------------------------------
// Commit pipeline
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct CreateNoteInput {
    pub title: String,
    pub content: String,
    pub note_type: Option<String>,
    pub tags: Vec<String>,
    /// Set only by the importer, which already knows the file it came from.
    pub file_path: Option<String>,
    /// Set only by adoption, to preserve an id a file already carries.
    pub preset_id: Option<String>,
    pub pinned_core: bool,
}

#[derive(Debug, Clone, Default)]
pub struct UpdateNoteInput {
    pub id: String,
    pub base_revision: i64,
    pub content: String,
    pub title: Option<String>,
    pub tags: Option<Vec<String>>,
    pub reason: Option<String>,
}

pub fn create_note(
    inner: &mut Inner,
    input: CreateNoteInput,
    actor: &Actor,
) -> Result<CommitResult, String> {
    let now = now_ms();
    let id = input
        .preset_id
        .clone()
        .unwrap_or_else(|| new_id(ID_NOTE));
    let note_type = input
        .note_type
        .clone()
        .or_else(|| input.file_path.as_deref().and_then(|p| {
            projector::core_type_for_file(p).map(|t| t.to_string())
        }))
        .unwrap_or_else(|| "note".to_string());

    let (file_path, slug) = match &input.file_path {
        Some(p) => {
            let p = p.replace('\\', "/");
            let stem = p
                .rsplit('/')
                .next()
                .and_then(|f| f.strip_suffix(".md"))
                .unwrap_or("note")
                .to_string();
            (p, stem)
        }
        None => {
            let base = projector::slugify(&input.title);
            let existing: std::collections::HashSet<String> = inner
                .graph
                .entities
                .values()
                .map(|n| n.slug.clone())
                .collect();
            let notes_dir = inner.memory_dir.join(projector::NOTES_DIR);
            let slug = projector::unique_slug(&base, &notes_dir, &|s| existing.contains(s));
            (format!("{}/{}.md", projector::NOTES_DIR, slug), slug)
        }
    };

    let byline = actor.byline();
    let content = input.content;
    let hash = hash_str(&content);
    let tags_json = serde_json::to_string(&input.tags).unwrap_or_else(|_| "[]".into());
    let meta = NoteMeta {
        id: id.clone(),
        note_type: note_type.clone(),
        title: input.title.clone(),
        slug,
        file_path: file_path.clone(),
        revision: 1,
        content_hash: hash.clone(),
        tags: input.tags.clone(),
        created_at: now,
        updated_at: now,
        created_by: byline.clone(),
        updated_by: byline.clone(),
        archived: false,
        pinned_core: input.pinned_core,
        conflict_id: None,
    };

    let links = plan_links(&inner.graph, &content, &id, actor, now);

    {
        let tx = inner
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| format!("begin: {e}"))?;
        tx.prepare_cached(
            "INSERT INTO notes(id,type,title,slug,content,tags,file_path,revision,content_hash,\
                               created_at,updated_at,created_by,updated_by,archived,pinned_core) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,1,?8,?9,?9,?10,?10,0,?11)",
        )
        .and_then(|mut s| {
            s.execute(params![
                meta.id,
                meta.note_type,
                meta.title,
                meta.slug,
                content,
                tags_json,
                meta.file_path,
                hash,
                now,
                byline,
                i64::from(meta.pinned_core)
            ])
        })
        .map_err(|e| format!("insert note: {e}"))?;

        insert_revision(&tx, &meta.id, 1, None, &hash, &content, &meta.title, actor, None, now)?;
        insert_relations(&tx, &links)?;
        insert_event(
            &tx,
            EV_NOTE_CREATED,
            Some(&meta.id),
            Some(1),
            actor,
            &format!("created {}", meta.title),
            now,
        )?;
        upsert_sync_state(&tx, &meta.file_path, Some(&meta.id))?;
        tx.commit().map_err(|e| format!("commit: {e}"))?;
    }

    inner.graph.upsert_note(meta.clone());
    for rel in links {
        inner.graph.insert_relation(rel);
    }
    // A note somebody linked to before it existed now resolves.
    let rebound = inner.graph.rebind_unresolved(&meta.title, &meta.id);
    rebind_rows(&inner.conn, &rebound, &meta.id)?;

    project(inner, &meta, &content)?;

    Ok(CommitResult {
        status: STATUS_OK.into(),
        id: meta.id,
        revision: 1,
        previous_revision: 0,
        file_path: meta.file_path,
        conflict: None,
    })
}

/// The optimistic-concurrency gate. `source` distinguishes an API write from
/// one the watcher imported off disk — a file-sourced conflict additionally
/// rewrites the file to the database head so the projection never shows a
/// version the store has rejected.
pub fn update_note(
    inner: &mut Inner,
    input: UpdateNoteInput,
    actor: &Actor,
    source: &str,
) -> Result<CommitResult, String> {
    let current = inner
        .graph
        .note(&input.id)
        .cloned()
        .ok_or_else(|| format!("note {} not found", input.id))?;
    let current_content = note_content(&inner.conn, &input.id)?;
    let incoming_hash = hash_str(&input.content);

    // A file-sourced commit IS the import of what is on disk, so those bytes
    // are accounted for by definition. Claim them before any projection runs,
    // or the pre-projection guard sees an unrecognised file and files the edit
    // it is in the middle of importing as a conflict.
    if source == SOURCE_FILE {
        let path = projector::note_path(&inner.memory_dir, &current.file_path);
        if let Ok(bytes) = std::fs::read(&path) {
            let _ = note_seen(
                &inner.conn,
                &current.file_path,
                &fnv1a64(&bytes),
                file_mtime(&path),
                bytes.len() as i64,
            );
        }
    }

    if input.base_revision == current.revision {
        if incoming_hash == current.content_hash && input.title.is_none() && input.tags.is_none() {
            return Ok(noop_result(&current));
        }
        return commit_content(
            inner,
            &current,
            input.content,
            input.title.unwrap_or_else(|| current.title.clone()),
            input.tags.unwrap_or_else(|| current.tags.clone()),
            Some(input.base_revision),
            actor,
            input.reason.as_deref(),
            EV_NOTE_UPDATED,
        );
    }

    // Stale base. An identical retry is idempotent, not a conflict — but only
    // when it is asking for nothing else. A retry that also carries a rename
    // has a change to make, and answering "noop" would drop it silently.
    if incoming_hash == current.content_hash {
        if meta_unchanged(&input, &current) {
            return Ok(noop_result(&current));
        }
        return commit_content(
            inner,
            &current,
            input.content,
            input.title.unwrap_or_else(|| current.title.clone()),
            input.tags.unwrap_or_else(|| current.tags.clone()),
            Some(input.base_revision),
            actor,
            input.reason.as_deref(),
            EV_NOTE_UPDATED,
        );
    }

    let base_snapshot = revision_content(&inner.conn, &input.id, input.base_revision);
    if let Some(base) = base_snapshot {
        if let Some(merged) = merge::try_three_way_merge(&base, &current_content, &input.content) {
            if hash_str(&merged) == current.content_hash && meta_unchanged(&input, &current) {
                return Ok(noop_result(&current));
            }
            // Title and tags come from the MERGED result, never from the stale
            // side. Taking `input.title` here reverted a rename committed at
            // head — the merged body's H1 said one thing and the title column
            // another — and overwrote head tags with the stale file's set,
            // which `revisions` does not snapshot, so they were gone for good.
            // The H1 is where a title canonically lives, so deriving it from
            // the merged body makes the title inherit the content merge's
            // correctness in every direction.
            let merged_title = projector::title_from_body(&merged)
                .or_else(|| input.title.clone())
                .unwrap_or_else(|| current.title.clone());
            return commit_content(
                inner,
                &current,
                merged,
                merged_title,
                current.tags.clone(),
                Some(input.base_revision),
                actor,
                input.reason.as_deref().or(Some("auto-merged")),
                EV_NOTE_MERGED,
            );
        }
    }

    // One more honest attempt before recording a conflict — for FILE imports
    // only. An external editor that saves twice keeps a stale frontmatter
    // counter: the projection bumps `revision:` under it after every import,
    // so its second save declares a base that trails head even though its
    // buffer visibly CONTAINS everything at head (its own previous save IS
    // the head). Two appends at the same spot are an overlapping hunk the
    // three-way merge rightly refuses — but when the incoming text contains
    // the current head verbatim, the writer demonstrably had head's content,
    // and committing incoming on head loses nothing. Plain Notepad usage
    // (save, keep typing, save again) stops manufacturing conflicts (found at
    // runtime, step 5, 2026-08-08). True divergence — head's text absent from
    // the incoming file — still conflicts below. API/MCP writers are excluded
    // on purpose: their explicit baseRevision contract is how agents learn to
    // re-read.
    if source == SOURCE_FILE {
        let head = current_content.trim_end();
        if !head.is_empty() && input.content.contains(head) {
            let title = projector::title_from_body(&input.content)
                .or_else(|| input.title.clone())
                .unwrap_or_else(|| current.title.clone());
            return commit_content(
                inner,
                &current,
                input.content,
                title,
                input.tags.unwrap_or_else(|| current.tags.clone()),
                Some(input.base_revision),
                actor,
                input.reason.as_deref().or(Some("stale re-save, contains head")),
                EV_NOTE_UPDATED,
            );
        }
    }

    // Neither side wins. Record theirs verbatim and hand the caller everything
    // it needs to rebase.
    let now = now_ms();
    let conflict_id = new_id(ID_CONFLICT);
    {
        let tx = inner
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| format!("begin: {e}"))?;
        tx.prepare_cached(
            "INSERT INTO conflicts(id,entity_id,base_revision,current_revision,theirs_content,\
                                   theirs_title,actor_type,agent_kind,session_id,pane_id,source,\
                                   status,created_at) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'open',?12)",
        )
        .and_then(|mut s| {
            s.execute(params![
                conflict_id,
                current.id,
                input.base_revision,
                current.revision,
                input.content,
                input.title,
                actor.actor_type,
                actor.agent_kind,
                actor.session_id,
                actor.pane_id,
                source,
                now
            ])
        })
        .map_err(|e| format!("insert conflict: {e}"))?;
        insert_event(
            &tx,
            EV_CONFLICT_CREATED,
            Some(&current.id),
            Some(current.revision),
            actor,
            &format!("conflicting edit to {}", current.title),
            now,
        )?;
        tx.commit().map_err(|e| format!("commit: {e}"))?;
    }

    // The file on disk must never show a version the store rejected. Unguarded:
    // the bytes it is about to overwrite are exactly the `theirs` just recorded
    // above, so the guard would file them a second time.
    if source == SOURCE_FILE {
        project_unguarded(inner, &current, &current_content)?;
    }
    super::events::record(inner, EV_CONFLICT_CREATED, Some(&current.id), actor);

    Ok(CommitResult {
        status: STATUS_CONFLICT.into(),
        id: current.id.clone(),
        revision: current.revision,
        previous_revision: input.base_revision,
        file_path: current.file_path.clone(),
        conflict: Some(ConflictSummary {
            id: conflict_id,
            current_revision: current.revision,
            current_content,
            current_updated_by: current.updated_by.clone(),
            current_updated_at: current.updated_at,
        }),
    })
}

/// Point an entity at a new projection path, keeping its identity.
///
/// A file moved in Explorer must not become a new note or a lost one: the
/// frontmatter id is the identity and the path is only where it currently
/// lives. Returns the rebound meta.
pub fn rebind_file_path(inner: &mut Inner, id: &str, new_rel: &str) -> Result<NoteMeta, String> {
    let current = inner
        .graph
        .note(id)
        .cloned()
        .ok_or_else(|| format!("note {id} not found"))?;
    if current.file_path == new_rel {
        return Ok(current);
    }
    let slug = new_rel
        .rsplit('/')
        .next()
        .unwrap_or(new_rel)
        .trim_end_matches(".md")
        .to_string();
    inner
        .conn
        .prepare_cached("UPDATE notes SET slug=?2, file_path=?3 WHERE id=?1")
        .and_then(|mut s| s.execute(params![id, slug, new_rel]))
        .map_err(|e| format!("rebind path: {e}"))?;
    // The sync_state row is keyed by path; carry the entity binding across so
    // the old row cannot later be mistaken for a different note's projection.
    let _ = inner
        .conn
        .prepare_cached("DELETE FROM sync_state WHERE file_path=?1")
        .and_then(|mut s| s.execute(params![current.file_path]));
    let mut moved = current.clone();
    moved.slug = slug;
    moved.file_path = new_rel.to_string();
    inner.graph.upsert_note(moved.clone());
    record_event(
        inner,
        EV_IMPORT_MOVED,
        Some(id),
        &Actor::external(),
        &format!("{} moved to {new_rel}", current.file_path),
    )?;
    Ok(moved)
}

/// True when the caller is asking for no metadata change it has not already
/// got. Compared by VALUE, not by `is_none()`, so a byte-identical retry of an
/// already-applied rename stays a true noop.
fn meta_unchanged(input: &UpdateNoteInput, current: &NoteMeta) -> bool {
    input.title.as_deref().is_none_or(|t| t == current.title)
        && input.tags.as_ref().is_none_or(|t| *t == current.tags)
}

fn noop_result(current: &NoteMeta) -> CommitResult {
    CommitResult {
        status: STATUS_NOOP.into(),
        id: current.id.clone(),
        revision: current.revision,
        previous_revision: current.revision,
        file_path: current.file_path.clone(),
        conflict: None,
    }
}

/// Write revision N+1. The optimistic check has already passed by this point —
/// this function only performs the commit.
#[allow(clippy::too_many_arguments)]
fn commit_content(
    inner: &mut Inner,
    current: &NoteMeta,
    content: String,
    title: String,
    tags: Vec<String>,
    base_revision: Option<i64>,
    actor: &Actor,
    reason: Option<&str>,
    event_type: &str,
) -> Result<CommitResult, String> {
    let now = now_ms();
    let revision = current.revision + 1;
    let hash = hash_str(&content);
    let byline = actor.byline();
    let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".into());

    let links = plan_links(&inner.graph, &content, &current.id, actor, now);
    let stale: Vec<RelationMeta> = inner.graph.wiki_relations_of(&current.id);
    let (added, removed) = diff_links(&stale, &links);

    {
        let tx = inner
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| format!("begin: {e}"))?;
        tx.prepare_cached(
            "UPDATE notes SET content=?2, title=?3, tags=?4, revision=?5, content_hash=?6, \
                              updated_at=?7, updated_by=?8 WHERE id=?1",
        )
        .and_then(|mut s| {
            s.execute(params![
                current.id, content, title, tags_json, revision, hash, now, byline
            ])
        })
        .map_err(|e| format!("update note: {e}"))?;

        insert_revision(
            &tx,
            &current.id,
            revision,
            base_revision,
            &hash,
            &content,
            &title,
            actor,
            reason,
            now,
        )?;
        for rel in &removed {
            tx.prepare_cached("DELETE FROM relations WHERE id=?1")
                .and_then(|mut s| s.execute(params![rel]))
                .map_err(|e| format!("delete relation: {e}"))?;
        }
        insert_relations(&tx, &added)?;
        insert_event(
            &tx,
            event_type,
            Some(&current.id),
            Some(revision),
            actor,
            &format!("updated {title}"),
            now,
        )?;
        tx.commit().map_err(|e| format!("commit: {e}"))?;
    }

    let mut meta = current.clone();
    meta.revision = revision;
    meta.content_hash = hash;
    meta.title = title;
    meta.tags = tags;
    meta.updated_at = now;
    meta.updated_by = byline;

    for rel in &removed {
        inner.graph.remove_relation(rel);
    }
    for rel in added {
        inner.graph.insert_relation(rel);
    }
    let retitled = meta.title != current.title;
    inner.graph.upsert_note(meta.clone());
    if retitled {
        let rebound = inner.graph.rebind_unresolved(&meta.title, &meta.id);
        rebind_rows(&inner.conn, &rebound, &meta.id)?;
    }

    project(inner, &meta, &content)?;
    super::events::record(inner, event_type, Some(&meta.id), actor);

    Ok(CommitResult {
        status: if event_type == EV_NOTE_MERGED {
            STATUS_MERGED.into()
        } else {
            STATUS_OK.into()
        },
        id: meta.id,
        revision,
        previous_revision: current.revision,
        file_path: meta.file_path,
        conflict: None,
    })
}

/// Append a rendered section to the head of a singleton document.
///
/// Decisions and learnings never take a base revision: an append cannot
/// conflict with another append, so serializing them under the project lock is
/// the entire concurrency story (spec §9).
pub fn append_entry(
    inner: &mut Inner,
    note_type: &str,
    title: &str,
    body: &str,
    tags: &[String],
    actor: &Actor,
) -> Result<CommitResult, String> {
    let current = inner
        .graph
        .by_type(note_type)
        .cloned()
        .ok_or_else(|| format!("{note_type} document is missing"))?;
    let existing = note_content(&inner.conn, &current.id)?;
    let section = render_entry(title, body, tags, actor);
    let mut content = existing.trim_end().to_string();
    content.push_str("\n\n");
    content.push_str(&section);
    content.push('\n');

    commit_content(
        inner,
        &current,
        content,
        current.title.clone(),
        current.tags.clone(),
        Some(current.revision),
        actor,
        Some("append"),
        EV_NOTE_UPDATED,
    )
}

/// Entries are tagged inline rather than on the containing document: the tags
/// belong to the decision, and DECISIONS.md holds hundreds of them.
fn render_entry(title: &str, body: &str, tags: &[String], actor: &Actor) -> String {
    let tag_line = if tags.is_empty() {
        String::new()
    } else {
        format!(
            "\n\n{}",
            tags.iter()
                .map(|t| format!("#{}", t.trim().replace(' ', "-")))
                .collect::<Vec<_>>()
                .join(" ")
        )
    };
    format!(
        "## {title}\n\n{}{tag_line}\n\n— {}, {}",
        body.trim(),
        actor.byline(),
        iso_ms(now_ms())
    )
}

pub fn archive_note(
    inner: &mut Inner,
    id: &str,
    actor: &Actor,
    delete_file: bool,
) -> Result<CommitResult, String> {
    let current = inner
        .graph
        .note(id)
        .cloned()
        .ok_or_else(|| format!("note {id} not found"))?;
    if current.pinned_core {
        return Err("core documents cannot be archived".into());
    }
    let now = now_ms();
    {
        let tx = inner
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| format!("begin: {e}"))?;
        tx.prepare_cached("UPDATE notes SET archived=1, updated_at=?2, updated_by=?3 WHERE id=?1")
            .and_then(|mut s| s.execute(params![id, now, actor.byline()]))
            .map_err(|e| format!("archive: {e}"))?;
        insert_event(
            &tx,
            EV_NOTE_ARCHIVED,
            Some(id),
            Some(current.revision),
            actor,
            &format!("archived {}", current.title),
            now,
        )?;
        tx.commit().map_err(|e| format!("commit: {e}"))?;
    }
    let mut meta = current.clone();
    meta.archived = true;
    meta.updated_at = now;
    inner.graph.upsert_note(meta.clone());

    // Archiving from the UI removes the projection; archiving BECAUSE the file
    // already vanished obviously must not try to delete it again.
    if delete_file {
        let path = projector::note_path(&inner.memory_dir, &meta.file_path);
        let _ = std::fs::remove_file(path);
    }
    super::events::record(inner, EV_NOTE_ARCHIVED, Some(id), actor);
    Ok(CommitResult {
        status: STATUS_OK.into(),
        id: meta.id,
        revision: meta.revision,
        previous_revision: meta.revision,
        file_path: meta.file_path,
        conflict: None,
    })
}

pub fn restore_note(inner: &mut Inner, id: &str, actor: &Actor) -> Result<CommitResult, String> {
    let current = inner
        .graph
        .note(id)
        .cloned()
        .ok_or_else(|| format!("note {id} not found"))?;
    let content = note_content(&inner.conn, id)?;
    let now = now_ms();
    {
        let tx = inner
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| format!("begin: {e}"))?;
        tx.prepare_cached("UPDATE notes SET archived=0, updated_at=?2, updated_by=?3 WHERE id=?1")
            .and_then(|mut s| s.execute(params![id, now, actor.byline()]))
            .map_err(|e| format!("restore: {e}"))?;
        insert_event(
            &tx,
            EV_NOTE_RESTORED,
            Some(id),
            Some(current.revision),
            actor,
            &format!("restored {}", current.title),
            now,
        )?;
        tx.commit().map_err(|e| format!("commit: {e}"))?;
    }
    let mut meta = current.clone();
    meta.archived = false;
    meta.updated_at = now;
    inner.graph.upsert_note(meta.clone());
    project(inner, &meta, &content)?;
    super::events::record(inner, EV_NOTE_RESTORED, Some(id), actor);
    Ok(CommitResult {
        status: STATUS_OK.into(),
        id: meta.id,
        revision: meta.revision,
        previous_revision: meta.revision,
        file_path: meta.file_path,
        conflict: None,
    })
}

/// Rename = a normal content commit whose body's H1 changed, so the title lives
/// in exactly one place. `reslug` additionally moves the file.
pub fn rename_note(
    inner: &mut Inner,
    id: &str,
    new_title: &str,
    base_revision: i64,
    reslug: bool,
    actor: &Actor,
) -> Result<CommitResult, String> {
    let current = inner
        .graph
        .note(id)
        .cloned()
        .ok_or_else(|| format!("note {id} not found"))?;
    if current.pinned_core {
        return Err("core documents cannot be renamed".into());
    }
    if base_revision != current.revision {
        return Err(format!(
            "stale base revision {base_revision} (current {})",
            current.revision
        ));
    }
    let body = note_content(&inner.conn, id)?;
    let renamed_body = projector::set_body_title(&body, new_title);

    if reslug {
        let existing: std::collections::HashSet<String> = inner
            .graph
            .entities
            .values()
            .filter(|n| n.id != current.id)
            .map(|n| n.slug.clone())
            .collect();
        let notes_dir = inner.memory_dir.join(projector::NOTES_DIR);
        let slug = projector::unique_slug(&projector::slugify(new_title), &notes_dir, &|s| {
            existing.contains(s)
        });
        let new_path = format!("{}/{}.md", projector::NOTES_DIR, slug);
        inner
            .conn
            .prepare_cached("UPDATE notes SET slug=?2, file_path=?3 WHERE id=?1")
            .and_then(|mut s| s.execute(params![id, slug, new_path]))
            .map_err(|e| format!("reslug: {e}"))?;
        let old_path = projector::note_path(&inner.memory_dir, &current.file_path);
        let _ = std::fs::remove_file(old_path);
        let mut moved = current.clone();
        moved.slug = slug;
        moved.file_path = new_path;
        inner.graph.upsert_note(moved);
    }

    let current = inner.graph.note(id).cloned().unwrap_or(current);
    commit_content(
        inner,
        &current,
        renamed_body,
        new_title.to_string(),
        current.tags.clone(),
        Some(base_revision),
        actor,
        Some("rename"),
        EV_NOTE_RENAMED,
    )
}

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

fn plan_links(
    g: &Graph,
    content: &str,
    source_id: &str,
    actor: &Actor,
    now: i64,
) -> Vec<RelationMeta> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for link in graph::parse_wiki_links(content) {
        let key = (graph::fold_title(&link.title), link.heading.clone());
        if !seen.insert(key) {
            continue;
        }
        let target_id = g.resolve_title(&link.title);
        if target_id.as_deref() == Some(source_id) {
            continue; // a note linking to itself adds nothing
        }
        out.push(RelationMeta {
            id: new_id(ID_RELATION),
            source_id: source_id.to_string(),
            target_id,
            target_title: Some(link.title),
            heading: link.heading,
            rel_type: graph::REL_LINKS_TO.to_string(),
            origin: graph::ORIGIN_WIKI.to_string(),
        });
        let _ = (actor, now);
    }
    out
}

/// Which of the freshly parsed links are new, and which stored ones are gone.
/// Matching is by (folded title, heading) so an unchanged link keeps its row
/// and its id across every commit.
fn diff_links(stale: &[RelationMeta], fresh: &[RelationMeta]) -> (Vec<RelationMeta>, Vec<String>) {
    let key = |r: &RelationMeta| {
        (
            r.target_title
                .as_deref()
                .map(graph::fold_title)
                .unwrap_or_default(),
            r.heading.clone(),
        )
    };
    let stale_keys: HashMap<_, _> = stale.iter().map(|r| (key(r), r.id.clone())).collect();
    let fresh_keys: std::collections::HashSet<_> = fresh.iter().map(key).collect();

    let added = fresh
        .iter()
        .filter(|r| !stale_keys.contains_key(&key(r)))
        .cloned()
        .collect();
    let removed = stale_keys
        .into_iter()
        .filter(|(k, _)| !fresh_keys.contains(k))
        .map(|(_, id)| id)
        .collect();
    (added, removed)
}

fn insert_relations(tx: &rusqlite::Transaction<'_>, rels: &[RelationMeta]) -> Result<(), String> {
    if rels.is_empty() {
        return Ok(());
    }
    let now = now_ms();
    let mut stmt = tx
        .prepare_cached(
            "INSERT INTO relations(id,source_id,target_id,target_title,heading,rel_type,origin,\
                                   created_at,created_by) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'system')",
        )
        .map_err(|e| format!("prepare relation insert: {e}"))?;
    for rel in rels {
        stmt.execute(params![
            rel.id,
            rel.source_id,
            rel.target_id,
            rel.target_title,
            rel.heading,
            rel.rel_type,
            rel.origin,
            now
        ])
        .map_err(|e| format!("insert relation: {e}"))?;
    }
    Ok(())
}

fn rebind_rows(conn: &Connection, rel_ids: &[String], target_id: &str) -> Result<(), String> {
    for rel_id in rel_ids {
        conn.prepare_cached("UPDATE relations SET target_id=?2 WHERE id=?1")
            .and_then(|mut s| s.execute(params![rel_id, target_id]))
            .map_err(|e| format!("rebind relation: {e}"))?;
    }
    Ok(())
}

pub fn link_entities(
    inner: &mut Inner,
    source_id: &str,
    target_id: &str,
    rel_type: &str,
    actor: &Actor,
) -> Result<String, String> {
    if inner.graph.note(source_id).is_none() {
        return Err(format!("note {source_id} not found"));
    }
    let target = inner
        .graph
        .note(target_id)
        .cloned()
        .ok_or_else(|| format!("note {target_id} not found"))?;
    let rel = RelationMeta {
        id: new_id(ID_RELATION),
        source_id: source_id.to_string(),
        target_id: Some(target_id.to_string()),
        target_title: Some(target.title.clone()),
        heading: None,
        rel_type: rel_type.to_string(),
        origin: graph::ORIGIN_EXPLICIT.to_string(),
    };
    let now = now_ms();
    {
        let tx = inner
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| format!("begin: {e}"))?;
        insert_relations(&tx, std::slice::from_ref(&rel))?;
        insert_event(
            &tx,
            EV_RELATION_ADDED,
            Some(source_id),
            None,
            actor,
            &format!("linked to {}", target.title),
            now,
        )?;
        tx.commit().map_err(|e| format!("commit: {e}"))?;
    }
    let id = rel.id.clone();
    inner.graph.insert_relation(rel);
    super::events::record(inner, EV_RELATION_ADDED, Some(source_id), actor);
    Ok(id)
}

pub fn backlinks(inner: &Inner, id: &str) -> Backlinks {
    let title_of = |rel: &RelationMeta, incoming: bool| -> Option<String> {
        let other = if incoming {
            Some(rel.source_id.clone())
        } else {
            rel.target_id.clone()
        };
        other
            .and_then(|o| inner.graph.note(&o).map(|n| n.title.clone()))
            .or_else(|| rel.target_title.clone())
    };
    let to_info = |rel: &RelationMeta, incoming: bool| RelationInfo {
        id: rel.id.clone(),
        source_id: rel.source_id.clone(),
        target_id: rel.target_id.clone(),
        target_title: rel.target_title.clone(),
        heading: rel.heading.clone(),
        rel_type: rel.rel_type.clone(),
        origin: rel.origin.clone(),
        peer_title: title_of(rel, incoming),
    };
    Backlinks {
        incoming: inner
            .graph
            .incoming_of(id)
            .into_iter()
            .map(|r| to_info(r, true))
            .collect(),
        outgoing: inner
            .graph
            .outgoing_of(id)
            .into_iter()
            .map(|r| to_info(r, false))
            .collect(),
    }
}

// ---------------------------------------------------------------------------
// Revisions, events, conflicts
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn insert_revision(
    tx: &rusqlite::Transaction<'_>,
    entity_id: &str,
    revision: i64,
    base_revision: Option<i64>,
    hash: &str,
    content: &str,
    title: &str,
    actor: &Actor,
    reason: Option<&str>,
    now: i64,
) -> Result<(), String> {
    tx.prepare_cached(
        "INSERT INTO revisions(entity_id,revision,base_revision,content_hash,kind,content,title,\
                               actor_type,agent_kind,session_id,pane_id,reason,created_at) \
         VALUES(?1,?2,?3,?4,'snapshot',?5,?6,?7,?8,?9,?10,?11,?12)",
    )
    .and_then(|mut s| {
        s.execute(params![
            entity_id,
            revision,
            base_revision,
            hash,
            content,
            title,
            actor.actor_type,
            actor.agent_kind,
            actor.session_id,
            actor.pane_id,
            reason,
            now
        ])
    })
    .map(|_| ())
    .map_err(|e| format!("insert revision: {e}"))
}

fn insert_event(
    tx: &rusqlite::Transaction<'_>,
    event_type: &str,
    entity_id: Option<&str>,
    revision: Option<i64>,
    actor: &Actor,
    summary: &str,
    now: i64,
) -> Result<(), String> {
    tx.prepare_cached(
        "INSERT INTO events(event_type,entity_id,revision,actor_type,agent_kind,session_id,\
                            pane_id,summary,created_at) \
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
    )
    .and_then(|mut s| {
        s.execute(params![
            event_type,
            entity_id,
            revision,
            actor.actor_type,
            actor.agent_kind,
            actor.session_id,
            actor.pane_id,
            summary,
            now
        ])
    })
    .map(|_| ())
    .map_err(|e| format!("insert event: {e}"))
}

/// A standalone event with no note behind it (context resolution, rebuilds).
pub fn record_event(
    inner: &mut Inner,
    event_type: &str,
    entity_id: Option<&str>,
    actor: &Actor,
    summary: &str,
) -> Result<(), String> {
    let now = now_ms();
    let tx = inner
        .conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("begin: {e}"))?;
    insert_event(&tx, event_type, entity_id, None, actor, summary, now)?;
    tx.commit().map_err(|e| format!("commit: {e}"))
}

fn revision_content(conn: &Connection, id: &str, revision: i64) -> Option<String> {
    conn.prepare_cached("SELECT content FROM revisions WHERE entity_id=?1 AND revision=?2")
        .ok()?
        .query_row(params![id, revision], |r| r.get::<_, String>(0))
        .optional()
        .ok()
        .flatten()
}

pub fn history(
    conn: &Connection,
    id: &str,
    limit: i64,
    before_revision: Option<i64>,
) -> Result<Vec<RevisionMeta>, String> {
    let before = before_revision.unwrap_or(i64::MAX);
    let mut stmt = conn
        .prepare_cached(
            "SELECT entity_id,revision,base_revision,title,content_hash,actor_type,agent_kind,\
                    session_id,pane_id,reason,created_at \
             FROM revisions WHERE entity_id=?1 AND revision<?2 ORDER BY revision DESC LIMIT ?3",
        )
        .map_err(|e| format!("history: {e}"))?;
    let rows = stmt
        .query_map(params![id, before, limit.clamp(1, 500)], |r| {
            Ok(RevisionMeta {
                entity_id: r.get(0)?,
                revision: r.get(1)?,
                base_revision: r.get(2)?,
                title: r.get(3)?,
                content_hash: r.get(4)?,
                actor: Actor {
                    actor_type: r.get(5)?,
                    agent_kind: r.get(6)?,
                    session_id: r.get(7)?,
                    pane_id: r.get(8)?,
                },
                reason: r.get(9)?,
                created_at: r.get(10)?,
            })
        })
        .map_err(|e| format!("history: {e}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("history row: {e}"))
}

pub fn get_revision(conn: &Connection, id: &str, revision: i64) -> Result<String, String> {
    revision_content(conn, id, revision)
        .ok_or_else(|| format!("revision {revision} of {id} not found"))
}

/// Restoring is a forward commit, never a rewrite of history — the revision you
/// restored from stays exactly where it was.
pub fn restore_revision(
    inner: &mut Inner,
    id: &str,
    revision: i64,
    actor: &Actor,
) -> Result<CommitResult, String> {
    let content = get_revision(&inner.conn, id, revision)?;
    let current = inner
        .graph
        .note(id)
        .cloned()
        .ok_or_else(|| format!("note {id} not found"))?;
    commit_content(
        inner,
        &current,
        content,
        current.title.clone(),
        current.tags.clone(),
        Some(current.revision),
        actor,
        Some(&format!("restored revision {revision}")),
        EV_NOTE_UPDATED,
    )
}

pub fn recent_events(
    conn: &Connection,
    since_seq: Option<i64>,
    limit: i64,
) -> Result<(Vec<EventInfo>, i64), String> {
    let since = since_seq.unwrap_or(0);
    let mut stmt = conn
        .prepare_cached(
            "SELECT seq,event_type,entity_id,revision,actor_type,agent_kind,session_id,pane_id,\
                    summary,created_at \
             FROM events WHERE seq>?1 ORDER BY seq DESC LIMIT ?2",
        )
        .map_err(|e| format!("recent_events: {e}"))?;
    let rows = stmt
        .query_map(params![since, limit.clamp(1, 500)], |r| {
            Ok(EventInfo {
                seq: r.get(0)?,
                event_type: r.get(1)?,
                entity_id: r.get(2)?,
                revision: r.get(3)?,
                actor: Actor {
                    actor_type: r.get(4)?,
                    agent_kind: r.get(5)?,
                    session_id: r.get(6)?,
                    pane_id: r.get(7)?,
                },
                summary: r.get(8)?,
                created_at: r.get(9)?,
            })
        })
        .map_err(|e| format!("recent_events: {e}"))?;
    let events = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("event row: {e}"))?;
    Ok((events, latest_seq(conn)))
}

pub fn list_conflicts(inner: &Inner) -> Result<Vec<ConflictInfo>, String> {
    let mut stmt = inner
        .conn
        .prepare_cached(
            "SELECT id,entity_id,base_revision,current_revision,theirs_content,actor_type,\
                    agent_kind,session_id,pane_id,source,status,created_at \
             FROM conflicts WHERE status='open' ORDER BY created_at DESC",
        )
        .map_err(|e| format!("list_conflicts: {e}"))?;
    let raw = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, String>(4)?,
                Actor {
                    actor_type: r.get(5)?,
                    agent_kind: r.get(6)?,
                    session_id: r.get(7)?,
                    pane_id: r.get(8)?,
                },
                r.get::<_, String>(9)?,
                r.get::<_, String>(10)?,
                r.get::<_, i64>(11)?,
            ))
        })
        .map_err(|e| format!("list_conflicts: {e}"))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("conflict row: {e}"))?;

    let mut out = Vec::with_capacity(raw.len());
    for (id, entity_id, base_rev, cur_rev, theirs, actor, source, status, created_at) in raw {
        let meta = inner.graph.note(&entity_id);
        let current_content = note_content(&inner.conn, &entity_id).unwrap_or_default();
        // Offer the auto-merge if one exists now — the head may have moved
        // since the conflict was recorded, so this is computed fresh.
        let merged_preview = revision_content(&inner.conn, &entity_id, base_rev)
            .and_then(|base| merge::try_three_way_merge(&base, &current_content, &theirs));
        out.push(ConflictInfo {
            id,
            entity_id: entity_id.clone(),
            title: meta.map(|m| m.title.clone()).unwrap_or_default(),
            file_path: meta.map(|m| m.file_path.clone()).unwrap_or_default(),
            base_revision: base_rev,
            current_revision: cur_rev,
            head_revision: meta.map(|m| m.revision).unwrap_or(cur_rev),
            theirs_content: theirs,
            current_content,
            actor,
            // Who owns the head the losing write collided with — read from the
            // note's own byline rather than the conflict row, because the head
            // may have moved on since.
            current_actor: meta
                .map(|m| Actor::from_byline(&m.updated_by))
                .unwrap_or_else(Actor::system),
            source,
            status,
            created_at,
            merged_preview,
        });
    }
    Ok(out)
}

/// Resolve an open conflict.
///
/// `expected_head_revision` is the head the caller's view was built against.
/// When supplied and the head has since moved, nothing is committed and the
/// record stays open — the same rebase-and-retry contract `update_note` gives
/// every other writer. Resolving used to commit whatever the caller sent with
/// `base = current.revision`, which is the head by construction and therefore
/// a check that can never fail: an agent committing while the modal was open
/// was silently dropped from the head with status "ok".
pub fn resolve_conflict(
    inner: &mut Inner,
    conflict_id: &str,
    resolution: &str,
    merged_content: Option<String>,
    expected_head_revision: Option<i64>,
    actor: &Actor,
) -> Result<CommitResult, String> {
    let (entity_id, theirs, status, base_rev): (String, String, String, i64) = inner
        .conn
        .prepare_cached(
            "SELECT entity_id,theirs_content,status,base_revision FROM conflicts WHERE id=?1",
        )
        .and_then(|mut s| {
            s.query_row(params![conflict_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
        })
        .map_err(|_| format!("conflict {conflict_id} not found"))?;
    if status != "open" {
        return Err(format!("conflict {conflict_id} is already {status}"));
    }

    let new_status = match resolution {
        "mine" => "resolved-mine",
        "theirs" => "resolved-theirs",
        "merged" => "resolved-merged",
        other => return Err(format!("unknown resolution '{other}'")),
    };

    // Staleness is checked BEFORE the record is closed, so a refused resolve
    // does not burn the conflict.
    if resolution != "mine" {
        let current = inner
            .graph
            .note(&entity_id)
            .cloned()
            .ok_or_else(|| format!("note {entity_id} not found"))?;
        let stale_view = expected_head_revision.is_some_and(|seen| seen != current.revision);
        // With no expected revision to check, the merged arm can still verify
        // itself: recompute the auto-merge against the LIVE head and refuse a
        // payload that does not match, since that payload was necessarily
        // computed against a head that has since moved.
        let stale_merge = expected_head_revision.is_none()
            && resolution == "merged"
            && merged_content.as_deref().is_some_and(|sent| {
                let current_content = note_content(&inner.conn, &entity_id).unwrap_or_default();
                match revision_content(&inner.conn, &entity_id, base_rev)
                    .and_then(|base| merge::try_three_way_merge(&base, &current_content, &theirs))
                {
                    Some(fresh) => fresh != sent,
                    // No auto-merge against the live head any more, so the
                    // caller's merged text cannot have come from one.
                    None => true,
                }
            });
        if stale_view || stale_merge {
            let current_content = note_content(&inner.conn, &entity_id).unwrap_or_default();
            return Ok(CommitResult {
                status: STATUS_CONFLICT.into(),
                id: current.id.clone(),
                revision: current.revision,
                previous_revision: expected_head_revision.unwrap_or(current.revision),
                file_path: current.file_path.clone(),
                conflict: Some(ConflictSummary {
                    id: conflict_id.to_string(),
                    current_revision: current.revision,
                    current_content,
                    current_updated_by: current.updated_by.clone(),
                    current_updated_at: current.updated_at,
                }),
            });
        }
    }

    let now = now_ms();

    // Close the record: whatever happens to the commit below, the conflict must
    // not be offered twice.
    inner
        .conn
        .prepare_cached("UPDATE conflicts SET status=?2, resolved_at=?3, resolved_by=?4 WHERE id=?1")
        .and_then(|mut s| s.execute(params![conflict_id, new_status, now, actor.byline()]))
        .map_err(|e| format!("resolve conflict: {e}"))?;
    record_event(
        inner,
        EV_CONFLICT_RESOLVED,
        Some(&entity_id),
        actor,
        &format!("conflict resolved ({resolution})"),
    )?;

    let result = match resolution {
        // Head already holds "mine" — nothing to commit.
        "mine" => {
            let meta = inner
                .graph
                .note(&entity_id)
                .cloned()
                .ok_or_else(|| format!("note {entity_id} not found"))?;
            noop_result(&meta)
        }
        _ => {
            let content = if resolution == "theirs" {
                theirs
            } else {
                merged_content.ok_or("merged resolution requires mergedContent")?
            };
            let current = inner
                .graph
                .note(&entity_id)
                .cloned()
                .ok_or_else(|| format!("note {entity_id} not found"))?;
            commit_content(
                inner,
                &current,
                content,
                current.title.clone(),
                current.tags.clone(),
                Some(current.revision),
                actor,
                Some(&format!("conflict resolved ({resolution})")),
                EV_NOTE_UPDATED,
            )?
        }
    };
    super::events::record(inner, EV_CONFLICT_RESOLVED, Some(&entity_id), actor);
    Ok(result)
}

// ---------------------------------------------------------------------------
// Projection + sync state
// ---------------------------------------------------------------------------

/// Write a note's markdown, preserving any external edit the projection is
/// about to destroy, and remember the exact bytes so the watcher event this
/// causes is recognised as our own.
///
/// The preservation step is not optional. A projection is an unconditional
/// `rename` over the file, and a human's save can be sitting on disk
/// undebounced (200ms) or unwatched entirely (`\\wsl.localhost`, where notify
/// may never fire and rescan is the designed fallback). Overwriting it there
/// left those bytes nowhere at all: the import that followed read OUR bytes,
/// matched the self-write ledger and returned Skipped, so the edit vanished
/// with no revision, no conflict and no event — worse than last-writer-wins,
/// because the EARLIER writer is the one who loses.
pub fn project(inner: &mut Inner, meta: &NoteMeta, body: &str) -> Result<(), String> {
    if inner.read_only {
        return Ok(());
    }
    preserve_foreign_edit(inner, meta, body);
    project_unguarded(inner, meta, body)
}

/// Project without the pre-write guard — for the one caller that has ALREADY
/// preserved what is on disk (the file-sourced conflict arm of `update_note`,
/// which records theirs verbatim and then rewrites the file to head). Running
/// the guard there would record the same edit a second time.
fn project_unguarded(inner: &mut Inner, meta: &NoteMeta, body: &str) -> Result<(), String> {
    if inner.read_only {
        return Ok(());
    }
    let path = projector::note_path(&inner.memory_dir, &meta.file_path);
    let text = projector::render_file(meta, body);
    let bytes = text.as_bytes();
    let hash = fnv1a64(bytes);
    projector::atomic_write(&path, bytes).map_err(|e| format!("project {}: {e}", path.display()))?;
    inner
        .ledger
        .record(super::norm_path(&path.to_string_lossy()), hash.clone());
    let mtime = file_mtime(&path);
    let size = bytes.len() as i64;
    inner
        .conn
        .prepare_cached(
            "INSERT INTO sync_state(file_path,entity_id,last_projected_hash,last_projected_at,\
                                    last_seen_mtime,last_seen_size) \
             VALUES(?1,?2,?3,?4,?5,?6) \
             ON CONFLICT(file_path) DO UPDATE SET entity_id=excluded.entity_id, \
               last_projected_hash=excluded.last_projected_hash, \
               last_projected_at=excluded.last_projected_at, \
               last_seen_mtime=excluded.last_seen_mtime, last_seen_size=excluded.last_seen_size",
        )
        .and_then(|mut s| {
            s.execute(params![meta.file_path, meta.id, hash, now_ms(), mtime, size])
        })
        .map_err(|e| format!("sync_state: {e}"))?;
    Ok(())
}

/// If the file about to be overwritten holds bytes we never imported, record
/// them as a conflict first.
///
/// Deliberately silent on every failure: this runs inside the commit path, and
/// a projection that cannot read the old file must still write the new one.
/// The cost on the clean path is one read and one hash.
fn preserve_foreign_edit(inner: &mut Inner, meta: &NoteMeta, next_body: &str) {
    let path = projector::note_path(&inner.memory_dir, &meta.file_path);
    let Ok(bytes) = std::fs::read(&path) else {
        return; // No file yet — nothing can be lost.
    };
    let disk_hash = fnv1a64(&bytes);

    // Bytes this process just wrote. Peek rather than consume: the watcher
    // still owes us that suppression.
    if inner
        .ledger
        .contains(&super::norm_path(&path.to_string_lossy()), &disk_hash)
    {
        return;
    }

    let (projected, imported) = projected_and_imported_hashes(&inner.conn, &meta.file_path);
    if disk_hash == projected || disk_hash == imported {
        return; // Already accounted for.
    }
    if projected.is_empty() && imported.is_empty() {
        // We have never projected or imported this path, so there is no prior
        // state to lose — this is the first write (create, or adopting a file
        // whose own content we are writing back).
        return;
    }

    let text = String::from_utf8_lossy(&bytes).to_string();
    let (fm, disk_body) = projector::parse_frontmatter(&text);
    if disk_body == next_body {
        return; // Same content, different frontmatter — nothing is lost.
    }

    let now = now_ms();
    let conflict_id = new_id(ID_CONFLICT);
    let actor = Actor::external();
    let base_revision = fm.as_ref().and_then(|f| f.revision).unwrap_or(meta.revision);
    let recorded = inner
        .conn
        .prepare_cached(
            "INSERT INTO conflicts(id,entity_id,base_revision,current_revision,theirs_content,\
                                   theirs_title,actor_type,agent_kind,session_id,pane_id,source,\
                                   status,created_at) \
             VALUES(?1,?2,?3,?4,?5,NULL,?6,NULL,NULL,NULL,?7,'open',?8)",
        )
        .and_then(|mut s| {
            s.execute(params![
                conflict_id,
                meta.id,
                base_revision,
                meta.revision,
                disk_body,
                actor.actor_type,
                SOURCE_FILE,
                now
            ])
        })
        .is_ok();
    if !recorded {
        return;
    }
    let _ = record_event(
        inner,
        EV_CONFLICT_CREATED,
        Some(&meta.id),
        &actor,
        &format!(
            "an unimported edit to {} was preserved before it was overwritten",
            meta.file_path
        ),
    );
    super::events::record(inner, EV_CONFLICT_CREATED, Some(&meta.id), &actor);
    crate::debug_log::dlog(&format!(
        "[knowledge] preserved an unimported external edit to {} as conflict {}",
        meta.file_path, conflict_id
    ));
}

/// `(last_projected_hash, last_imported_hash)` — both empty when the path has
/// no sync_state row.
fn projected_and_imported_hashes(conn: &Connection, file_path: &str) -> (String, String) {
    conn.prepare_cached(
        "SELECT COALESCE(last_projected_hash,''),COALESCE(last_imported_hash,'') \
         FROM sync_state WHERE file_path=?1",
    )
    .ok()
    .and_then(|mut s| {
        s.query_row(params![file_path], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .ok()
            .flatten()
    })
    .unwrap_or_default()
}

pub fn file_mtime(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn upsert_sync_state(
    tx: &rusqlite::Transaction<'_>,
    file_path: &str,
    entity_id: Option<&str>,
) -> Result<(), String> {
    tx.prepare_cached(
        "INSERT INTO sync_state(file_path,entity_id) VALUES(?1,?2) \
         ON CONFLICT(file_path) DO UPDATE SET entity_id=excluded.entity_id",
    )
    .and_then(|mut s| s.execute(params![file_path, entity_id]))
    .map(|_| ())
    .map_err(|e| format!("sync_state: {e}"))
}

pub fn sync_state_for(conn: &Connection, file_path: &str) -> Option<(i64, i64, String)> {
    conn.prepare_cached(
        "SELECT COALESCE(last_seen_mtime,0),COALESCE(last_seen_size,0),\
                COALESCE(last_projected_hash,'') FROM sync_state WHERE file_path=?1",
    )
    .ok()?
    .query_row(params![file_path], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
    .optional()
    .ok()
    .flatten()
}

pub fn note_seen(
    conn: &Connection,
    file_path: &str,
    hash: &str,
    mtime: i64,
    size: i64,
) -> Result<(), String> {
    conn.prepare_cached(
        "INSERT INTO sync_state(file_path,last_imported_hash,last_seen_mtime,last_seen_size) \
         VALUES(?1,?2,?3,?4) \
         ON CONFLICT(file_path) DO UPDATE SET last_imported_hash=excluded.last_imported_hash, \
           last_seen_mtime=excluded.last_seen_mtime, last_seen_size=excluded.last_seen_size",
    )
    .and_then(|mut s| s.execute(params![file_path, hash, mtime, size]))
    .map(|_| ())
    .map_err(|e| format!("sync_state: {e}"))
}

// ---------------------------------------------------------------------------
// Scaffold
// ---------------------------------------------------------------------------

/// Create the seven singleton documents. Runs only behind an explicit
/// initialize — MADE does not write into a user's project uninvited.
pub fn scaffold(inner: &mut Inner) -> Result<(), String> {
    let actor = Actor::system();
    for (file, note_type, title, starter) in CORE_DOCS {
        if inner.graph.by_type(note_type).is_some() {
            continue;
        }
        create_note(
            inner,
            CreateNoteInput {
                title: (*title).to_string(),
                content: (*starter).to_string(),
                note_type: Some((*note_type).to_string()),
                tags: Vec::new(),
                file_path: Some((*file).to_string()),
                preset_id: None,
                pinned_core: true,
            },
            &actor,
        )?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Handoffs
// ---------------------------------------------------------------------------

pub fn create_handoff(
    inner: &mut Inner,
    input: HandoffInput,
    actor: &Actor,
) -> Result<Handoff, String> {
    if input.task.trim().is_empty() {
        return Err("a handoff needs a task description".into());
    }
    let now = now_ms();
    let id = new_id(ID_HANDOFF);
    let handoff = Handoff {
        id: id.clone(),
        task: input.task,
        completed: input.completed,
        current_work: input.current_work,
        remaining: input.remaining,
        files_changed: input.files_changed,
        decisions: input.decisions,
        known_issues: input.known_issues,
        next_action: input.next_action,
        status: "open".into(),
        actor: actor.clone(),
        created_at: now,
        consumed_at: None,
        consumed_by: None,
        rendered_markdown: None,
    };
    let rendered = render_handoff(&handoff);

    {
        let tx = inner
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| format!("begin: {e}"))?;
        tx.prepare_cached(
            "INSERT INTO handoffs(id,task,completed,current_work,remaining,files_changed,decisions,\
                                  known_issues,next_action,status,rendered,actor_type,agent_kind,\
                                  session_id,pane_id,created_at) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'open',?10,?11,?12,?13,?14,?15)",
        )
        .and_then(|mut s| {
            s.execute(params![
                handoff.id,
                handoff.task,
                json_list(&handoff.completed),
                handoff.current_work,
                json_list(&handoff.remaining),
                json_list(&handoff.files_changed),
                json_list(&handoff.decisions),
                json_list(&handoff.known_issues),
                handoff.next_action,
                rendered,
                actor.actor_type,
                actor.agent_kind,
                actor.session_id,
                actor.pane_id,
                now
            ])
        })
        .map_err(|e| format!("insert handoff: {e}"))?;
        insert_event(
            &tx,
            EV_HANDOFF_CREATED,
            Some(&handoff.id),
            None,
            actor,
            &format!("handoff: {}", handoff.task),
            now,
        )?;
        tx.commit().map_err(|e| format!("commit: {e}"))?;
    }

    // Prepend to HANDOFFS.md through the normal commit path — an append, not a
    // regeneration, so anything a human added to that file survives.
    if let Some(doc) = inner.graph.by_type("handoffs").cloned() {
        let existing = note_content(&inner.conn, &doc.id)?;
        let (head, rest) = split_after_h1(&existing);
        let content = format!("{head}\n{rendered}\n{rest}");
        commit_content(
            inner,
            &doc,
            content,
            doc.title.clone(),
            doc.tags.clone(),
            Some(doc.revision),
            actor,
            Some("handoff"),
            EV_NOTE_UPDATED,
        )?;
    }
    super::events::record(inner, EV_HANDOFF_CREATED, Some(&id), actor);

    Ok(Handoff {
        rendered_markdown: Some(rendered),
        ..handoff
    })
}

/// Split a document just after its first H1 so a section can be prepended
/// without displacing the title.
fn split_after_h1(text: &str) -> (String, String) {
    let mut lines = text.split('\n');
    let mut head = String::new();
    for line in lines.by_ref() {
        head.push_str(line);
        head.push('\n');
        if line.trim_start().starts_with("# ") {
            break;
        }
    }
    if head.is_empty() {
        return (String::new(), text.to_string());
    }
    let rest: Vec<&str> = lines.collect();
    (head, rest.join("\n"))
}

pub fn render_handoff(h: &Handoff) -> String {
    let mut out = String::new();
    let short = h.id.trim_start_matches("ho_").chars().take(8).collect::<String>();
    out.push_str(&format!(
        "## Handoff {short} — {} ({}, {})\n\n",
        h.task,
        h.actor.byline(),
        iso_ms(h.created_at)
    ));
    let section = |out: &mut String, label: &str, items: &[String]| {
        if items.is_empty() {
            return;
        }
        out.push_str(&format!("**{label}**\n\n"));
        for item in items {
            out.push_str(&format!("- {item}\n"));
        }
        out.push('\n');
    };
    if let Some(cur) = &h.current_work {
        if !cur.trim().is_empty() {
            out.push_str(&format!("**Current work**\n\n{}\n\n", cur.trim()));
        }
    }
    section(&mut out, "Completed", &h.completed);
    section(&mut out, "Remaining", &h.remaining);
    section(&mut out, "Files changed", &h.files_changed);
    section(&mut out, "Decisions", &h.decisions);
    section(&mut out, "Known issues", &h.known_issues);
    if let Some(next) = &h.next_action {
        if !next.trim().is_empty() {
            out.push_str(&format!("**Next action**\n\n{}\n", next.trim()));
        }
    }
    out
}

pub fn list_handoffs(conn: &Connection, limit: i64) -> Result<Vec<Handoff>, String> {
    let mut stmt = conn
        .prepare_cached(
            "SELECT id,task,completed,current_work,remaining,files_changed,decisions,known_issues,\
                    next_action,status,rendered,actor_type,agent_kind,session_id,pane_id,\
                    created_at,consumed_at,consumed_by \
             FROM handoffs ORDER BY created_at DESC LIMIT ?1",
        )
        .map_err(|e| format!("list_handoffs: {e}"))?;
    let rows = stmt
        .query_map(params![limit.clamp(1, 200)], |r| {
            Ok(Handoff {
                id: r.get(0)?,
                task: r.get(1)?,
                completed: parse_list(&r.get::<_, String>(2)?),
                current_work: r.get(3)?,
                remaining: parse_list(&r.get::<_, String>(4)?),
                files_changed: parse_list(&r.get::<_, String>(5)?),
                decisions: parse_list(&r.get::<_, String>(6)?),
                known_issues: parse_list(&r.get::<_, String>(7)?),
                next_action: r.get(8)?,
                status: r.get(9)?,
                rendered_markdown: Some(r.get::<_, String>(10)?),
                actor: Actor {
                    actor_type: r.get(11)?,
                    agent_kind: r.get(12)?,
                    session_id: r.get(13)?,
                    pane_id: r.get(14)?,
                },
                created_at: r.get(15)?,
                consumed_at: r.get(16)?,
                consumed_by: r.get(17)?,
            })
        })
        .map_err(|e| format!("list_handoffs: {e}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("handoff row: {e}"))
}

pub fn latest_handoff(conn: &Connection) -> Result<Option<Handoff>, String> {
    Ok(list_handoffs(conn, 1)?.into_iter().next())
}

pub fn consume_handoff(inner: &mut Inner, id: &str, actor: &Actor) -> Result<(), String> {
    let now = now_ms();
    let changed = inner
        .conn
        .prepare_cached(
            "UPDATE handoffs SET status='consumed', consumed_at=?2, consumed_by=?3 \
             WHERE id=?1 AND status='open'",
        )
        .and_then(|mut s| s.execute(params![id, now, actor.byline()]))
        .map_err(|e| format!("consume handoff: {e}"))?;
    if changed == 0 {
        return Err(format!("handoff {id} is not open"));
    }
    record_event(inner, EV_HANDOFF_CONSUMED, Some(id), actor, "handoff consumed")?;
    super::events::record(inner, EV_HANDOFF_CONSUMED, Some(id), actor);
    Ok(())
}

fn json_list(items: &[String]) -> String {
    serde_json::to_string(items).unwrap_or_else(|_| "[]".into())
}

fn parse_list(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Tasks + the TASKS.md managed region
// ---------------------------------------------------------------------------

/// Every task row, archived included — the id map the TASKS.md import matches
/// against, so an archived task is recognised rather than re-minted.
fn all_tasks(conn: &Connection) -> Result<Vec<Task>, String> {
    let mut stmt = conn
        .prepare_cached(
            "SELECT id,title,detail,status,assignee,created_at,created_by,updated_at,updated_by \
             FROM tasks ORDER BY created_at",
        )
        .map_err(|e| format!("all_tasks: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Task {
                id: r.get(0)?,
                title: r.get(1)?,
                detail: r.get(2)?,
                status: r.get(3)?,
                assignee: r.get(4)?,
                created_at: r.get(5)?,
                created_by: r.get(6)?,
                updated_at: r.get(7)?,
                updated_by: r.get(8)?,
            })
        })
        .map_err(|e| format!("all_tasks: {e}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("task row: {e}"))
}

pub fn list_tasks(conn: &Connection, include_done: bool) -> Result<Vec<Task>, String> {
    let sql = if include_done {
        "SELECT id,title,detail,status,assignee,created_at,created_by,updated_at,updated_by \
         FROM tasks WHERE status!='archived' ORDER BY created_at"
    } else {
        "SELECT id,title,detail,status,assignee,created_at,created_by,updated_at,updated_by \
         FROM tasks WHERE status IN ('open','in-progress') ORDER BY created_at"
    };
    let mut stmt = conn.prepare_cached(sql).map_err(|e| format!("list_tasks: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Task {
                id: r.get(0)?,
                title: r.get(1)?,
                detail: r.get(2)?,
                status: r.get(3)?,
                assignee: r.get(4)?,
                created_at: r.get(5)?,
                created_by: r.get(6)?,
                updated_at: r.get(7)?,
                updated_by: r.get(8)?,
            })
        })
        .map_err(|e| format!("list_tasks: {e}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("task row: {e}"))
}

pub fn create_task(
    inner: &mut Inner,
    title: &str,
    detail: Option<String>,
    actor: &Actor,
) -> Result<Task, String> {
    if title.trim().is_empty() {
        return Err("a task needs a title".into());
    }
    let now = now_ms();
    let task = Task {
        id: new_id(ID_TASK),
        title: title.trim().to_string(),
        detail,
        status: "open".into(),
        assignee: None,
        created_at: now,
        created_by: actor.byline(),
        updated_at: now,
        updated_by: actor.byline(),
    };
    insert_task_row(&inner.conn, &task)?;
    record_event(inner, EV_TASK_CREATED, Some(&task.id), actor, &format!("task: {}", task.title))?;
    regenerate_tasks_doc(inner, actor)?;
    super::events::record(inner, EV_TASK_CREATED, Some(&task.id), actor);
    Ok(task)
}

fn insert_task_row(conn: &Connection, task: &Task) -> Result<(), String> {
    conn.prepare_cached(
        "INSERT INTO tasks(id,title,detail,status,assignee,created_at,created_by,updated_at,\
                           updated_by) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
    )
    .and_then(|mut s| {
        s.execute(params![
            task.id,
            task.title,
            task.detail,
            task.status,
            task.assignee,
            task.created_at,
            task.created_by,
            task.updated_at,
            task.updated_by
        ])
    })
    .map(|_| ())
    .map_err(|e| format!("insert task: {e}"))
}

pub fn update_task(
    inner: &mut Inner,
    id: &str,
    status: Option<String>,
    title: Option<String>,
    detail: Option<String>,
    assignee: Option<String>,
    actor: &Actor,
) -> Result<Task, String> {
    let now = now_ms();
    let changed = inner
        .conn
        .prepare_cached(
            "UPDATE tasks SET status=COALESCE(?2,status), title=COALESCE(?3,title), \
                              detail=COALESCE(?4,detail), assignee=COALESCE(?5,assignee), \
                              updated_at=?6, updated_by=?7 WHERE id=?1",
        )
        .and_then(|mut s| {
            s.execute(params![id, status, title, detail, assignee, now, actor.byline()])
        })
        .map_err(|e| format!("update task: {e}"))?;
    if changed == 0 {
        return Err(format!("task {id} not found"));
    }
    record_event(inner, EV_TASK_UPDATED, Some(id), actor, "task updated")?;
    regenerate_tasks_doc(inner, actor)?;
    super::events::record(inner, EV_TASK_UPDATED, Some(id), actor);
    get_task(&inner.conn, id)
}

pub fn get_task(conn: &Connection, id: &str) -> Result<Task, String> {
    conn.prepare_cached(
        "SELECT id,title,detail,status,assignee,created_at,created_by,updated_at,updated_by \
         FROM tasks WHERE id=?1",
    )
    .and_then(|mut s| {
        s.query_row(params![id], |r| {
            Ok(Task {
                id: r.get(0)?,
                title: r.get(1)?,
                detail: r.get(2)?,
                status: r.get(3)?,
                assignee: r.get(4)?,
                created_at: r.get(5)?,
                created_by: r.get(6)?,
                updated_at: r.get(7)?,
                updated_by: r.get(8)?,
            })
        })
    })
    .map_err(|_| format!("task {id} not found"))
}

/// Rewrite the marked region of TASKS.md from the tasks table, leaving every
/// line outside the markers exactly as the user wrote it.
pub fn regenerate_tasks_doc(inner: &mut Inner, actor: &Actor) -> Result<(), String> {
    let Some(doc) = inner.graph.by_type("tasks").cloned() else {
        return Ok(());
    };
    let existing = note_content(&inner.conn, &doc.id)?;
    let tasks = list_tasks(&inner.conn, true)?;
    let region = render_tasks_region(&tasks);
    let updated = replace_managed_region(&existing, &region);
    if hash_str(&updated) == doc.content_hash {
        return Ok(());
    }
    commit_content(
        inner,
        &doc,
        updated,
        doc.title.clone(),
        doc.tags.clone(),
        Some(doc.revision),
        actor,
        Some("tasks"),
        EV_NOTE_UPDATED,
    )?;
    Ok(())
}

pub fn render_tasks_region(tasks: &[Task]) -> String {
    let mut out = String::new();
    let open: Vec<&Task> = tasks.iter().filter(|t| t.status != "done").collect();
    let done: Vec<&Task> = tasks.iter().filter(|t| t.status == "done").collect();
    out.push_str("## Open\n\n");
    if open.is_empty() {
        out.push_str("_none_\n");
    }
    for t in open {
        let mark = if t.status == "in-progress" { "-" } else { " " };
        out.push_str(&format!("- [{mark}] {} <!--task:{}-->\n", t.title, t.id));
    }
    if !done.is_empty() {
        out.push_str("\n## Done\n\n");
        for t in done {
            out.push_str(&format!("- [x] {} <!--task:{}-->\n", t.title, t.id));
        }
    }
    out
}

fn replace_managed_region(existing: &str, region: &str) -> String {
    let block = format!("{TASKS_BEGIN}\n\n{}\n{TASKS_END}", region.trim_end());
    match (existing.find(TASKS_BEGIN), existing.find(TASKS_END)) {
        (Some(start), Some(end)) if end > start => {
            let mut out = String::with_capacity(existing.len() + block.len());
            out.push_str(&existing[..start]);
            out.push_str(&block);
            out.push_str(&existing[end + TASKS_END.len()..]);
            out
        }
        _ => {
            let mut out = existing.trim_end().to_string();
            out.push_str("\n\n");
            out.push_str(&block);
            out.push('\n');
            out
        }
    }
}

/// A `- [x] Title <!--task:tk_x-->` line, parsed back out of the managed region.
pub struct ParsedTaskLine {
    pub id: Option<String>,
    pub title: String,
    pub done: bool,
}

pub fn parse_task_lines(text: &str) -> Vec<ParsedTaskLine> {
    let Some(start) = text.find(TASKS_BEGIN) else {
        return Vec::new();
    };
    let end = text.find(TASKS_END).unwrap_or(text.len());
    if end < start {
        return Vec::new();
    }
    let mut out = Vec::new();
    for line in text[start..end].split('\n') {
        let t = line.trim();
        let Some(rest) = t.strip_prefix("- [") else {
            continue;
        };
        let Some((mark, body)) = rest.split_once(']') else {
            continue;
        };
        let done = mark.trim().eq_ignore_ascii_case("x");
        let body = body.trim();
        let (title, id) = match body.split_once("<!--task:") {
            Some((title, tail)) => (
                title.trim().to_string(),
                tail.strip_suffix("-->").map(|s| s.trim().to_string()),
            ),
            None => (body.to_string(), None),
        };
        if title.is_empty() {
            continue;
        }
        out.push(ParsedTaskLine { id, title, done });
    }
    out
}

/// Reconcile the tasks table with what a human just typed into TASKS.md:
/// checkbox flips update status, an unanchored line becomes a new task.
pub fn import_task_lines(inner: &mut Inner, text: &str, actor: &Actor) -> Result<bool, String> {
    let mut changed = false;
    // Keyed by id over ALL rows INCLUDING archived ones. Built from the
    // archived-excluding list, an anchored line for a task somebody archived
    // matched nothing and was minted as a fresh duplicate on every import.
    let known: HashMap<String, Task> = all_tasks(&inner.conn)?
        .into_iter()
        .map(|t| (t.id.clone(), t))
        .collect();
    let now = now_ms();
    for line in parse_task_lines(text) {
        // Anchored lines match by id. A line someone typed by hand has no
        // anchor yet, so fall back to matching its title — otherwise importing
        // the same file twice (a rescan, a conflict that skipped regeneration)
        // would mint a second copy of the same task every time.
        let existing = line
            .id
            .as_deref()
            .and_then(|id| known.get(id))
            .or_else(|| {
                known
                    .values()
                    .find(|t| t.title == line.title && t.status != "archived")
            });
        match existing {
            // An anchored line for an archived task is matched and IGNORED —
            // never resurrected by a checkbox and never minted again.
            Some(task) if task.status == "archived" => {}
            Some(task) => {
                let want = if line.done { "done" } else { "open" };
                if (task.status == "done") != line.done {
                    inner
                        .conn
                        .prepare_cached(
                            "UPDATE tasks SET status=?2, updated_at=?3, updated_by=?4 WHERE id=?1",
                        )
                        .and_then(|mut s| {
                            s.execute(params![task.id, want, now, actor.byline()])
                        })
                        .map_err(|e| format!("import task status: {e}"))?;
                    changed = true;
                }
            }
            None => {
                let task = Task {
                    id: new_id(ID_TASK),
                    title: line.title.clone(),
                    detail: None,
                    status: if line.done { "done".into() } else { "open".into() },
                    assignee: None,
                    created_at: now,
                    created_by: actor.byline(),
                    updated_at: now,
                    updated_by: actor.byline(),
                };
                insert_task_row(&inner.conn, &task)?;
                changed = true;
            }
        }
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::testutil::{fixture, TestDir};

    #[test]
    fn a_stale_file_resave_that_contains_head_commits_instead_of_conflicting() {
        // The Notepad flow: save (imported, head moves, projection bumps the
        // frontmatter under the still-open editor), keep typing, save again —
        // the second save declares the stale base but its text contains the
        // whole head. That must land as the next revision, not a conflict.
        let mut f = fixture();
        let created = f.note("Doc", "# Doc\n\nline one\n");
        let head = update_note(
            &mut f.inner,
            UpdateNoteInput {
                id: created.id.clone(),
                base_revision: created.revision,
                content: "# Doc\n\nline one\nline two\n".into(),
                ..Default::default()
            },
            &Actor::external(),
            SOURCE_FILE,
        )
        .expect("head moves");
        assert_eq!(head.status, STATUS_OK);

        let resave = update_note(
            &mut f.inner,
            UpdateNoteInput {
                id: created.id.clone(),
                // Stale on purpose: the editor never saw the bumped counter.
                base_revision: created.revision,
                content: "# Doc\n\nline one\nline two\nline three\n".into(),
                ..Default::default()
            },
            &Actor::external(),
            SOURCE_FILE,
        )
        .expect("stale resave");
        assert_eq!(resave.status, STATUS_OK, "contains-head resave must commit");
        assert_eq!(resave.revision, head.revision + 1);
        assert!(list_conflicts(&mut f.inner).expect("list").is_empty());

        // True divergence still conflicts: head's text is NOT in the incoming
        // file, so nothing proves the writer ever saw it.
        let diverged = update_note(
            &mut f.inner,
            UpdateNoteInput {
                id: created.id.clone(),
                base_revision: created.revision,
                content: "# Doc\n\nsomething else entirely\n".into(),
                ..Default::default()
            },
            &Actor::external(),
            SOURCE_FILE,
        )
        .expect("diverged resave");
        assert_eq!(diverged.status, STATUS_CONFLICT);
        assert_eq!(list_conflicts(&mut f.inner).expect("list").len(), 1);
    }

    #[test]
    fn fts5_available() {
        // The gate the whole search design rests on: `bundled` rusqlite must
        // ship FTS5. Proven end to end rather than by asking for a version —
        // FTS5 exposes `fts5_source_id()`, never `fts5_version()`, and a probe
        // that asks the wrong question would fail on a perfectly good build.
        let dir = TestDir::new();
        let conn = open_db(&dir.path().join("k.db"), false).expect("open");
        conn.execute_batch(
            "CREATE VIRTUAL TABLE probe USING fts5(body);\
             INSERT INTO probe(body) VALUES('rotating refresh tokens');",
        )
        .expect("bundled SQLite must include FTS5");
        let hits: i64 = conn
            .query_row("SELECT count(*) FROM probe WHERE probe MATCH 'refresh'", [], |r| {
                r.get(0)
            })
            .expect("FTS5 MATCH must work");
        assert_eq!(hits, 1);
        // bm25 and snippet are what search.rs actually ranks and renders with.
        let snippet: String = conn
            .query_row(
                "SELECT snippet(probe,0,'[',']','…',5) FROM probe WHERE probe MATCH 'refresh' \
                 ORDER BY bm25(probe)",
                [],
                |r| r.get(0),
            )
            .expect("bm25 + snippet must be available");
        assert!(snippet.contains("[refresh]"), "snippet was {snippet:?}");
    }

    #[test]
    fn migrations_reach_current_version_and_are_idempotent() {
        let dir = TestDir::new();
        let path = dir.path().join("k.db");
        {
            let conn = open_db(&path, false).expect("open");
            assert_eq!(run_migrations(&conn).expect("migrate"), None);
            let v: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
            assert_eq!(v, schema::CURRENT_SCHEMA_VERSION);
            assert!(integrity_ok(&conn));
        }
        // Reopening applies nothing and must not error on existing tables.
        let conn = open_db(&path, false).expect("reopen");
        assert_eq!(run_migrations(&conn).expect("migrate again"), None);
        let v: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, schema::CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn newer_schema_is_reported_not_guessed_at() {
        let dir = TestDir::new();
        let conn = open_db(&dir.path().join("k.db"), false).expect("open");
        conn.execute_batch("PRAGMA user_version=99").unwrap();
        assert_eq!(run_migrations(&conn).expect("probe"), Some(99));
    }

    #[test]
    fn note_crud_revision_increments() {
        let mut f = fixture();
        let created = create_note(
            &mut f.inner,
            CreateNoteInput {
                title: "Auth Design".into(),
                content: "# Auth Design\n\nfirst\n".into(),
                ..Default::default()
            },
            &Actor::user(),
        )
        .expect("create");
        assert_eq!(created.status, STATUS_OK);
        assert_eq!(created.revision, 1);
        assert_eq!(created.file_path, "notes/auth-design.md");

        let updated = update_note(
            &mut f.inner,
            UpdateNoteInput {
                id: created.id.clone(),
                base_revision: 1,
                content: "# Auth Design\n\nsecond\n".into(),
                ..Default::default()
            },
            &Actor::agent("codex", None, None),
            SOURCE_API,
        )
        .expect("update");
        assert_eq!(updated.status, STATUS_OK);
        assert_eq!(updated.revision, 2);
        assert_eq!(updated.previous_revision, 1);

        // Both revisions survive as full snapshots, with their actors.
        let hist = history(&f.inner.conn, &created.id, 10, None).expect("history");
        assert_eq!(hist.len(), 2);
        assert_eq!(hist[0].revision, 2);
        assert_eq!(hist[0].actor.byline(), "codex");
        assert_eq!(hist[1].actor.byline(), "user");
        assert_eq!(
            get_revision(&f.inner.conn, &created.id, 1).unwrap(),
            "# Auth Design\n\nfirst\n"
        );
        assert!(latest_seq(&f.inner.conn) >= 2);

        // And the projection tracks the head.
        let on_disk =
            std::fs::read_to_string(f.inner.memory_dir.join("notes/auth-design.md")).unwrap();
        assert!(on_disk.contains("revision: 2"));
        assert!(on_disk.contains("second"));
    }

    #[test]
    fn stale_base_with_same_content_is_a_noop() {
        let mut f = fixture();
        let created = f.note("Thing", "# Thing\n\nbody\n");
        let again = update_note(
            &mut f.inner,
            UpdateNoteInput {
                id: created.id.clone(),
                base_revision: 0, // hopelessly stale
                content: "# Thing\n\nbody\n".into(),
                ..Default::default()
            },
            &Actor::user(),
            SOURCE_API,
        )
        .expect("retry");
        assert_eq!(again.status, STATUS_NOOP);
        assert_eq!(again.revision, 1);
    }

    #[test]
    fn stale_base_conflict_keeps_head_and_preserves_theirs() {
        let mut f = fixture();
        let created = f.note("Doc", "# Doc\n\nline\n");
        update_note(
            &mut f.inner,
            UpdateNoteInput {
                id: created.id.clone(),
                base_revision: 1,
                content: "# Doc\n\nmine\n".into(),
                ..Default::default()
            },
            &Actor::user(),
            SOURCE_API,
        )
        .expect("head commit");

        let clash = update_note(
            &mut f.inner,
            UpdateNoteInput {
                id: created.id.clone(),
                base_revision: 1,
                content: "# Doc\n\ntheirs\n".into(),
                ..Default::default()
            },
            &Actor::agent("claude", None, None),
            SOURCE_API,
        )
        .expect("conflicting commit");

        assert_eq!(clash.status, STATUS_CONFLICT);
        let summary = clash.conflict.expect("conflict summary");
        assert_eq!(summary.current_revision, 2);
        assert!(summary.current_content.contains("mine"));

        // Head is untouched and the losing side is recoverable verbatim.
        assert_eq!(f.inner.graph.note(&created.id).unwrap().revision, 2);
        let open = list_conflicts(&f.inner).expect("conflicts");
        assert_eq!(open.len(), 1);
        assert!(open[0].theirs_content.contains("theirs"));
        assert_eq!(open[0].source, SOURCE_API);
        assert_eq!(open_conflict_count(&f.inner.conn), 1);
    }

    #[test]
    fn resolve_conflict_theirs_commits_a_new_head() {
        let mut f = fixture();
        let created = f.note("Doc", "# Doc\n\nline\n");
        f.update(&created.id, 1, "# Doc\n\nmine\n");
        let clash = update_note(
            &mut f.inner,
            UpdateNoteInput {
                id: created.id.clone(),
                base_revision: 1,
                content: "# Doc\n\ntheirs\n".into(),
                ..Default::default()
            },
            &Actor::user(),
            SOURCE_API,
        )
        .unwrap();
        let conflict_id = clash.conflict.unwrap().id;

        let resolved =
            resolve_conflict(&mut f.inner, &conflict_id, "theirs", None, None, &Actor::user())
                .expect("resolve");
        assert_eq!(resolved.revision, 3);
        assert!(note_content(&f.inner.conn, &created.id).unwrap().contains("theirs"));
        assert_eq!(open_conflict_count(&f.inner.conn), 0);
        // Resolving twice is refused rather than committing again.
        assert!(resolve_conflict(&mut f.inner, &conflict_id, "mine", None, None, &Actor::user()).is_err());
        // The losing side is still in history.
        let hist = history(&f.inner.conn, &created.id, 10, None).unwrap();
        assert!(hist.iter().any(|r| r.revision == 2));
    }

    #[test]
    fn add_decision_appends_without_a_base() {
        let mut f = fixture();
        scaffold(&mut f.inner).expect("scaffold");
        append_entry(
            &mut f.inner,
            "decisions",
            "Use SQLite",
            "WAL over SMB fails.",
            &["storage".to_string()],
            &Actor::user(),
        )
        .expect("first");
        append_entry(
            &mut f.inner,
            "decisions",
            "Use FNV",
            "Change detection only.",
            &[],
            &Actor::agent("codex", None, None),
        )
        .expect("second");

        let doc = f.inner.graph.by_type("decisions").cloned().unwrap();
        let body = note_content(&f.inner.conn, &doc.id).unwrap();
        let first = body.find("Use SQLite").expect("first entry present");
        let second = body.find("Use FNV").expect("second entry present");
        assert!(first < second, "appends must keep their order");
        assert_eq!(doc.revision, 3);
        // Tags belong to the entry, not to the document that collects them.
        assert!(body.contains("#storage"));
        assert!(doc.tags.is_empty());
    }

    #[test]
    fn scaffold_creates_seven_singletons_once() {
        let mut f = fixture();
        scaffold(&mut f.inner).expect("scaffold");
        assert_eq!(f.inner.graph.len(), CORE_DOCS.len());
        // Idempotent — a second call adds nothing.
        scaffold(&mut f.inner).expect("scaffold again");
        assert_eq!(f.inner.graph.len(), CORE_DOCS.len());
        for (file, _, _, _) in CORE_DOCS {
            assert!(
                f.inner.memory_dir.join(file).exists(),
                "{file} was not projected"
            );
        }
        assert!(f.inner.graph.by_type("state").unwrap().pinned_core);
    }

    #[test]
    fn core_documents_refuse_rename_and_archive() {
        let mut f = fixture();
        scaffold(&mut f.inner).expect("scaffold");
        let state = f.inner.graph.by_type("state").cloned().unwrap();
        assert!(rename_note(&mut f.inner, &state.id, "Nope", state.revision, false, &Actor::user()).is_err());
        assert!(archive_note(&mut f.inner, &state.id, &Actor::user(), true).is_err());
    }

    #[test]
    fn wiki_relations_diff_across_commits() {
        let mut f = fixture();
        let target = f.note("Beta", "# Beta\n");
        let source = f.note("Alpha", "# Alpha\n\nsee [[Beta]] and [[Ghost]]\n");

        let links = backlinks(&f.inner, &source.id);
        assert_eq!(links.outgoing.len(), 2);
        assert_eq!(backlinks(&f.inner, &target.id).incoming.len(), 1);
        // The dangling one is kept, deliberately, with a null target.
        assert!(links.outgoing.iter().any(|r| r.target_id.is_none()));

        // Dropping a link removes exactly that relation.
        f.update(&source.id, 1, "# Alpha\n\nsee [[Beta]] only\n");
        assert_eq!(backlinks(&f.inner, &source.id).outgoing.len(), 1);

        // Creating the missing note rebinds the dangling link, in the row too.
        f.update(&source.id, 2, "# Alpha\n\nsee [[Beta]] and [[Ghost]]\n");
        let ghost = f.note("Ghost", "# Ghost\n");
        assert_eq!(backlinks(&f.inner, &ghost.id).incoming.len(), 1);
        let regraph = hydrate_graph(&f.inner.conn).expect("rehydrate");
        assert_eq!(regraph.incoming_of(&ghost.id).len(), 1);
    }

    #[test]
    fn archive_and_restore_round_trip() {
        let mut f = fixture();
        let note = f.note("Temp", "# Temp\n\nbody\n");
        let path = f.inner.memory_dir.join(&note.file_path);
        assert!(path.exists());

        archive_note(&mut f.inner, &note.id, &Actor::user(), true).expect("archive");
        assert!(f.inner.graph.note(&note.id).unwrap().archived);
        assert!(!path.exists(), "archiving removes the projection");
        assert!(f.inner.graph.list(false).iter().all(|n| n.id != note.id));

        restore_note(&mut f.inner, &note.id, &Actor::user()).expect("restore");
        assert!(!f.inner.graph.note(&note.id).unwrap().archived);
        assert!(path.exists(), "restore re-projects the file");
    }

    #[test]
    fn rename_moves_the_title_and_optionally_the_file() {
        let mut f = fixture();
        let note = f.note("Old Title", "# Old Title\n\nbody\n");
        rename_note(&mut f.inner, &note.id, "New Title", 1, false, &Actor::user())
            .expect("rename");
        let meta = f.inner.graph.note(&note.id).unwrap().clone();
        assert_eq!(meta.title, "New Title");
        assert_eq!(meta.file_path, "notes/old-title.md", "slug is stable");
        assert!(note_content(&f.inner.conn, &note.id).unwrap().starts_with("# New Title"));

        rename_note(&mut f.inner, &note.id, "Third Title", meta.revision, true, &Actor::user())
            .expect("reslug");
        let meta = f.inner.graph.note(&note.id).unwrap().clone();
        assert_eq!(meta.file_path, "notes/third-title.md");
        assert!(f.inner.memory_dir.join("notes/third-title.md").exists());
        assert!(!f.inner.memory_dir.join("notes/old-title.md").exists());
    }

    #[test]
    fn restore_revision_moves_forward() {
        let mut f = fixture();
        let note = f.note("Doc", "# Doc\n\nv1\n");
        f.update(&note.id, 1, "# Doc\n\nv2\n");
        let restored = restore_revision(&mut f.inner, &note.id, 1, &Actor::user()).expect("restore");
        assert_eq!(restored.revision, 3, "restore is a new revision, not a rewind");
        assert!(note_content(&f.inner.conn, &note.id).unwrap().contains("v1"));
    }

    #[test]
    fn explicit_links_survive_a_content_commit() {
        let mut f = fixture();
        let a = f.note("A", "# A\n");
        let b = f.note("B", "# B\n");
        link_entities(&mut f.inner, &a.id, &b.id, "depends-on", &Actor::user()).expect("link");
        f.update(&a.id, 1, "# A\n\nunrelated edit\n");
        let out = backlinks(&f.inner, &a.id).outgoing;
        assert_eq!(out.len(), 1, "the wiki diff must not touch explicit links");
        assert_eq!(out[0].rel_type, "depends-on");
        assert_eq!(out[0].peer_title.as_deref(), Some("B"));
    }

    #[test]
    fn handoff_create_latest_and_consume() {
        let mut f = fixture();
        scaffold(&mut f.inner).expect("scaffold");
        let handoff = create_handoff(
            &mut f.inner,
            HandoffInput {
                task: "Ship the store".into(),
                completed: vec!["schema".into()],
                remaining: vec!["ipc".into()],
                next_action: Some("wire commands".into()),
                ..Default::default()
            },
            &Actor::agent("claude", None, None),
        )
        .expect("create handoff");
        assert!(handoff.rendered_markdown.as_deref().unwrap().contains("Ship the store"));

        let latest = latest_handoff(&f.inner.conn).expect("latest").expect("some");
        assert_eq!(latest.id, handoff.id);
        assert_eq!(latest.remaining, vec!["ipc".to_string()]);
        assert!(latest.rendered_markdown.is_some());

        // The projection gained a section under the H1, keeping the title first.
        let doc = f.inner.graph.by_type("handoffs").unwrap().clone();
        let body = note_content(&f.inner.conn, &doc.id).unwrap();
        assert!(body.starts_with("# Handoffs"));
        assert!(body.contains("Ship the store"));

        consume_handoff(&mut f.inner, &handoff.id, &Actor::user()).expect("consume");
        let after = latest_handoff(&f.inner.conn).unwrap().unwrap();
        assert_eq!(after.status, "consumed");
        assert_eq!(after.consumed_by.as_deref(), Some("user"));
        assert!(consume_handoff(&mut f.inner, &handoff.id, &Actor::user()).is_err());
    }

    #[test]
    fn tasks_managed_region_preserves_surrounding_text() {
        let mut f = fixture();
        scaffold(&mut f.inner).expect("scaffold");
        let doc = f.inner.graph.by_type("tasks").cloned().unwrap();
        // A human writes their own prose into TASKS.md.
        f.update(&doc.id, doc.revision, "# Tasks\n\nMy own notes stay here.\n");

        let task = create_task(&mut f.inner, "Wire the IPC", None, &Actor::user()).expect("create");
        let body = note_content(&f.inner.conn, &doc.id).unwrap();
        assert!(body.contains("My own notes stay here."));
        assert!(body.contains(TASKS_BEGIN) && body.contains(TASKS_END));
        assert!(body.contains(&format!("<!--task:{}-->", task.id)));

        update_task(&mut f.inner, &task.id, Some("done".into()), None, None, None, &Actor::user())
            .expect("update");
        let body = note_content(&f.inner.conn, &doc.id).unwrap();
        assert!(body.contains("## Done"));
        assert!(body.contains("My own notes stay here."), "regeneration ate user text");
    }

    #[test]
    fn checkbox_import_toggles_and_adopts() {
        let mut f = fixture();
        scaffold(&mut f.inner).expect("scaffold");
        let task = create_task(&mut f.inner, "Existing", None, &Actor::user()).expect("create");
        let doc = f.inner.graph.by_type("tasks").cloned().unwrap();
        let body = note_content(&f.inner.conn, &doc.id).unwrap();

        // A human ticks the box and types a new line by hand.
        let edited = body
            .replace(
                &format!("- [ ] Existing <!--task:{}-->", task.id),
                &format!("- [x] Existing <!--task:{}-->\n- [ ] Typed by hand", task.id),
            );
        assert!(import_task_lines(&mut f.inner, &edited, &Actor::external()).expect("import"));

        let tasks = list_tasks(&f.inner.conn, true).expect("list");
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks.iter().find(|t| t.id == task.id).unwrap().status, "done");
        assert!(tasks.iter().any(|t| t.title == "Typed by hand" && t.status == "open"));
        // Re-importing the same text changes nothing.
        assert!(!import_task_lines(&mut f.inner, &edited, &Actor::external()).expect("reimport"));
    }

    #[test]
    fn write_policy_defaults_to_ask_and_persists() {
        let f = fixture();
        assert_eq!(write_policy(&f.inner.conn), POLICY_ASK);
        meta_set(&f.inner.conn, META_POLICY, POLICY_TRUSTED).unwrap();
        assert_eq!(write_policy(&f.inner.conn), POLICY_TRUSTED);
    }

    /// A merge must not carry the stale side's title and tags to head.
    ///
    /// The content merged correctly but `commit_content` was handed the stale
    /// file's title, reverting a rename committed at head while the merged
    /// body's H1 still said the new name. Tags were worse: `revisions` does
    /// not snapshot them, so head tags overwritten by a stale set were gone
    /// permanently.
    #[test]
    fn a_merge_keeps_the_head_title_and_tags() {
        let mut f = fixture();
        let note = f.note("Auth Design", "# Auth Design\n\nalpha\n\nbeta\n\ngamma\n");

        // Head renames and retags.
        rename_note(
            &mut f.inner,
            &note.id,
            "Auth Design v2",
            1,
            false,
            &Actor::user(),
        )
        .expect("rename");
        update_note(
            &mut f.inner,
            UpdateNoteInput {
                id: note.id.clone(),
                base_revision: 2,
                content: "# Auth Design v2\n\nalpha\n\nbeta\n\ngamma\n".into(),
                tags: Some(vec!["security".into()]),
                ..Default::default()
            },
            &Actor::user(),
            SOURCE_API,
        )
        .expect("retag");

        // A stale editor appends at the bottom, still carrying the old title
        // and no tags.
        let merged = update_note(
            &mut f.inner,
            UpdateNoteInput {
                id: note.id.clone(),
                base_revision: 1,
                content: "# Auth Design\n\nalpha\n\nbeta\n\ngamma\n\ndelta\n".into(),
                title: Some("Auth Design".into()),
                tags: Some(Vec::new()),
                ..Default::default()
            },
            &Actor::external(),
            SOURCE_API,
        )
        .expect("merge");
        assert_eq!(merged.status, STATUS_MERGED);

        let head = f.inner.graph.note(&note.id).cloned().expect("head");
        assert_eq!(head.title, "Auth Design v2", "the head rename was reverted");
        assert_eq!(head.tags, vec!["security".to_string()], "head tags were lost");
        let body = note_content(&f.inner.conn, &note.id).expect("body");
        assert!(body.contains("delta"), "the append was dropped");
        assert!(
            body.starts_with("# Auth Design v2"),
            "title and body disagree: {body:?}"
        );
    }

    /// A stale retry that also carries a rename must not be answered "noop".
    #[test]
    fn a_stale_noop_still_applies_a_pending_rename() {
        let mut f = fixture();
        let note = f.note("Doc", "# Doc\n\nbody\n");
        f.update(&note.id, 1, "# Doc\n\nsecond\n");

        // Content already matches head, base is stale, but a rename is pending.
        let out = update_note(
            &mut f.inner,
            UpdateNoteInput {
                id: note.id.clone(),
                base_revision: 1,
                content: "# Doc\n\nsecond\n".into(),
                title: Some("Renamed".into()),
                tags: Some(vec!["t".into()]),
                ..Default::default()
            },
            &Actor::user(),
            SOURCE_API,
        )
        .expect("update");
        assert_eq!(out.status, STATUS_OK, "the rename was silently dropped");
        let head = f.inner.graph.note(&note.id).cloned().expect("head");
        assert_eq!(head.title, "Renamed");
        assert_eq!(head.tags, vec!["t".to_string()]);

        // A genuine byte-identical retry is still a noop.
        let again = update_note(
            &mut f.inner,
            UpdateNoteInput {
                id: note.id.clone(),
                base_revision: 1,
                content: "# Doc\n\nsecond\n".into(),
                title: Some("Renamed".into()),
                tags: Some(vec!["t".into()]),
                ..Default::default()
            },
            &Actor::user(),
            SOURCE_API,
        )
        .expect("retry");
        assert_eq!(again.status, STATUS_NOOP);
    }

    /// Resolving against a head that moved while the modal was open must not
    /// commit — the interleaved revision would be silently dropped.
    #[test]
    fn resolving_a_conflict_against_a_moved_head_is_refused() {
        let mut f = fixture();
        let note = f.note("Doc", "# Doc\n\nline\n");
        f.update(&note.id, 1, "# Doc\n\nmine\n");
        // A stale write conflicts.
        let conflict = f.update(&note.id, 1, "# Doc\n\ntheirs\n");
        assert_eq!(conflict.status, STATUS_CONFLICT);
        let open = list_conflicts(&mut f.inner).expect("conflicts");
        let cid = open[0].id.clone();
        let seen_head = open[0].head_revision;

        // An agent commits while the user is deciding.
        f.update(&note.id, 2, "# Doc\n\nthe agent's later work\n");

        let refused = resolve_conflict(
            &mut f.inner,
            &cid,
            "theirs",
            None,
            Some(seen_head),
            &Actor::user(),
        )
        .expect("resolve");
        assert_eq!(
            refused.status, STATUS_CONFLICT,
            "a stale resolve committed over the moved head"
        );
        let body = note_content(&f.inner.conn, &note.id).expect("body");
        assert!(
            body.contains("the agent's later work"),
            "the agent's revision was dropped: {body:?}"
        );
        // Refusing must not burn the record — it is still resolvable.
        let still_open = list_conflicts(&mut f.inner).expect("conflicts");
        assert_eq!(still_open.len(), 1, "the conflict was closed by a refusal");

        // Retrying against the fresh head works.
        let ok = resolve_conflict(
            &mut f.inner,
            &cid,
            "theirs",
            None,
            Some(still_open[0].head_revision),
            &Actor::user(),
        )
        .expect("resolve");
        assert_eq!(ok.status, STATUS_OK);
        assert!(list_conflicts(&mut f.inner).expect("conflicts").is_empty());
    }

    /// An API commit must not silently destroy an edit sitting unimported on
    /// disk.
    ///
    /// The window is the debounce (200ms) and, on `\\wsl.localhost` where
    /// notify may never fire at all, unbounded. Before the guard, the human's
    /// bytes were renamed over and the import that followed read OUR bytes,
    /// matched the ledger, and returned Skipped — the edit existed nowhere.
    #[test]
    fn an_unimported_external_edit_is_preserved_before_projection() {
        let mut f = fixture();
        let note = f.note("Doc", "# Doc\n\noriginal\n");
        let path = f.file(&note.file_path);
        assert!(path.exists(), "the create should have projected");

        // A human saves through an editor; the watcher has not run yet.
        let human = "---\nid: {id}\ntype: note\nrevision: 1\n---\n\n# Doc\n\nthe human's paragraph\n"
            .replace("{id}", &note.id);
        std::fs::write(&path, &human).unwrap();

        // An agent commits at head in the same window.
        let result = f.update(&note.id, 1, "# Doc\n\nthe agent's paragraph\n");
        assert_eq!(result.status, STATUS_OK, "the agent's write is at head");

        // The human's text survives as an open conflict rather than vanishing.
        let conflicts = list_conflicts(&mut f.inner).expect("conflicts");
        assert_eq!(conflicts.len(), 1, "the human's edit was not preserved");
        assert!(
            conflicts[0].theirs_content.contains("the human's paragraph"),
            "theirs was not preserved verbatim: {:?}",
            conflicts[0].theirs_content
        );
        assert_eq!(conflicts[0].source, SOURCE_FILE);
        assert_eq!(conflicts[0].entity_id, note.id);
        // ...and the head is the agent's, projected to disk as usual.
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(on_disk.contains("the agent's paragraph"));
    }

    /// The guard must stay quiet on every ordinary commit, or the conflict list
    /// fills up with noise and the feature is unusable.
    #[test]
    fn the_projection_guard_does_not_fire_on_ordinary_commits() {
        let mut f = fixture();
        let note = f.note("Doc", "# Doc\n\none\n");
        f.update(&note.id, 1, "# Doc\n\ntwo\n");
        f.update(&note.id, 2, "# Doc\n\nthree\n");
        let renamed = rename_note(
            &mut f.inner,
            &note.id,
            "Renamed",
            3,
            false,
            &Actor::user(),
        )
        .expect("rename");
        assert_eq!(renamed.status, STATUS_OK);
        archive_note(&mut f.inner, &note.id, &Actor::user(), true).expect("archive");
        restore_note(&mut f.inner, &note.id, &Actor::user()).expect("restore");

        assert!(
            list_conflicts(&mut f.inner).expect("conflicts").is_empty(),
            "a normal commit sequence must not manufacture conflicts"
        );
    }

    /// Adopting a file writes that file's own content back — there is nothing
    /// to preserve, and the guard must not invent a conflict for it.
    #[test]
    fn adopting_a_file_does_not_trip_the_projection_guard() {
        let mut f = fixture();
        let rel = "notes/adopted.md";
        let path = projector::note_path(&f.inner.memory_dir, rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "# Adopted\n\nwritten by hand\n").unwrap();

        let created = create_note(
            &mut f.inner,
            CreateNoteInput {
                title: "Adopted".into(),
                content: "# Adopted\n\nwritten by hand\n".into(),
                file_path: Some(rel.into()),
                ..Default::default()
            },
            &Actor::external(),
        )
        .expect("adopt");
        assert_eq!(created.status, STATUS_OK);
        assert!(list_conflicts(&mut f.inner).expect("conflicts").is_empty());
    }
}
