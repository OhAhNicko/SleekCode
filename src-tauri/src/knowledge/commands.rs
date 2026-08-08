//! The `knowledge_*` Tauri command surface.
//!
//! These are thin: canonicalize the project path, find the project, run one
//! synchronous service call under its lock, hand back serde. The only real
//! policy here is that **every command in this file acts as the user** — a
//! person editing their own notes in MADE's own UI is not something to ask
//! permission for, and no argument from JS can say otherwise. Agent identity
//! exists only on the IPC path, where it is built from the connection.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::model::*;
use super::search;
use super::store::{self, CreateNoteInput, UpdateNoteInput};
use super::{ipc, projector, store::POLICY_ASK, watcher, ProjectKnowledge};

const ERR_NOT_OPEN: &str = "NexusMind is not open for this project";

fn project(project_path: &str) -> Result<Arc<ProjectKnowledge>, String> {
    if super::is_remote_path(project_path) {
        return Err("remote projects are not supported".into());
    }
    super::get(&super::project_key(project_path)).ok_or_else(|| ERR_NOT_OPEN.to_string())
}

/// Same lookup, but refuses when this instance is only following another one.
fn writable(project_path: &str) -> Result<Arc<ProjectKnowledge>, String> {
    let p = project(project_path)?;
    if p.read_only() {
        return Err("this project's memory is open read-only in this window".into());
    }
    Ok(p)
}

fn default_true() -> bool {
    true
}

/// A note id arrives under either spelling.
///
/// The plan and the MCP wire call it `id`; the frontend's api.ts calls it
/// `entityId` throughout. Accepting both costs one `or` and means neither side
/// has to be declared wrong — a rename on either would otherwise turn every
/// call in this file into a runtime "missing required key" the type system
/// never sees.
fn one_id(id: Option<String>, entity_id: Option<String>) -> Result<String, String> {
    id.or(entity_id)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "a note id is required".to_string())
}

/// Stamp `conflictId` onto rows that have an open conflict, so the sidebar can
/// mark them. One query for the whole list rather than a join per row.
fn mark_conflicts(inner: &mut super::Inner, notes: &mut [NoteMeta]) {
    let Ok(open) = store::list_conflicts(inner) else {
        return;
    };
    if open.is_empty() {
        return;
    }
    for note in notes.iter_mut() {
        note.conflict_id = open
            .iter()
            .find(|c| c.entity_id == note.id)
            .map(|c| c.id.clone());
    }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn knowledge_status(project_path: String) -> Result<KnowledgeStatus, String> {
    let key = super::project_key(&project_path);
    if super::is_remote_path(&project_path) {
        let mut status = KnowledgeStatus::simple("remote-unsupported", &key, &project_path);
        status.readonly_reason = Some("remote projects are not supported yet".into());
        return Ok(status);
    }
    if let Some(p) = super::get(&key) {
        return Ok(p.status());
    }
    // Nothing is opened here — status must not write, so this is a pure probe.
    // A project that HAS a `.project-memory` but is not attached yet is
    // `loading`, not `ready`: saying ready before the store is open would put
    // the sidebar into a panel with nothing behind it.
    let exists = std::path::Path::new(&project_path)
        .join(projector::MEMORY_DIR)
        .is_dir();
    Ok(KnowledgeStatus::simple(
        if exists { "loading" } else { "uninitialized" },
        &key,
        &project_path,
    ))
}

/// Idempotent. `init: false` NEVER writes into the project — a project without
/// `.project-memory` comes back as `uninitialized` and nothing is created.
#[tauri::command]
pub async fn knowledge_open(project_path: String, init: bool) -> Result<KnowledgeStatus, String> {
    let key = super::project_key(&project_path);
    let path = project_path.clone();
    // The open-time reconcile walk reads every projection file; keep it off the
    // async workers.
    let opened = tauri::async_runtime::spawn_blocking(move || super::open_project(&path, init))
        .await
        .map_err(|e| format!("open task: {e}"))??;
    Ok(match opened {
        super::OpenResult::Uninitialized => {
            KnowledgeStatus::simple("uninitialized", &key, &project_path)
        }
        super::OpenResult::Opened(p) => p.status(),
    })
}

#[tauri::command]
pub async fn knowledge_close(project_path: String) -> Result<(), String> {
    super::close_project(&super::project_key(&project_path));
    Ok(())
}

/// The per-build world names the frontend must render — the folder created in
/// a repo and the MCP server name a CLI registers. Served by Rust rather than
/// mirrored as TS constants: debug and release builds spell them differently
/// (live/dev isolation), and a mirrored constant drifting silently is exactly
/// the class the payload tripwire exists for. Fetched once at boot by
/// `KnowledgeEngine`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeWorld {
    pub memory_dir_name: String,
    pub mcp_server_name: String,
}

/// The user's UTC offset, minutes EAST, pushed once at boot alongside the
/// world fetch. JS knows the timezone for free (`Date.getTimezoneOffset`);
/// Rust's std does not know it at all, and frontmatter timestamps rendered in
/// UTC read as "two hours behind my clock" to anyone east of Greenwich.
#[tauri::command]
pub async fn knowledge_set_timezone(offset_minutes: i32) {
    super::model::set_tz_offset_minutes(offset_minutes);
}

#[tauri::command]
pub async fn knowledge_world() -> KnowledgeWorld {
    KnowledgeWorld {
        memory_dir_name: projector::MEMORY_DIR.to_string(),
        mcp_server_name: super::mcp_config::SERVER_NAME.to_string(),
    }
}

/// Detach a project and move its knowledge — projection folder AND event
/// database — to the Recycle Bin. See `super::remove_project` for the ordering
/// contract. The frontend confirms before calling; deletion and trash I/O are
/// blocking, so they stay off the async workers.
#[tauri::command]
pub async fn knowledge_remove(project_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || super::remove_project(&project_path))
        .await
        .map_err(|e| format!("remove task: {e}"))?
}

/// Re-run the reconcile walk. This is the designed fallback for projects on
/// `\\wsl.localhost`, where notify may never fire at all.
#[tauri::command]
pub async fn knowledge_rescan(project_path: String) -> Result<KnowledgeStatus, String> {
    let p = writable(&project_path)?;
    let walked = p.clone();
    tauri::async_runtime::spawn_blocking(move || walked.with_inner(watcher::reconcile_walk))
        .await
        .map_err(|e| format!("rescan task: {e}"))?;
    Ok(p.status())
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListQuery {
    #[serde(default)]
    pub types: Option<Vec<String>>,
    #[serde(default)]
    pub include_archived: bool,
    #[serde(default)]
    pub tag: Option<String>,
}

/// The store keeps projection paths RELATIVE to the memory dir (the schema's
/// contract, and what the adapter's IPC wire carries); the frontend's contract
/// is the opposite — `filePath` is what "Open" hands the file viewer, so from
/// a Tauri command it must be ABSOLUTE. Every command that serializes a path
/// widens it here, at the boundary, and nowhere deeper. Found at first
/// runtime contact: rows shipped `STATE.md`, the viewer resolved it against
/// the exe's working directory and reported os error 2.
fn absolute_note_path(memory_dir: &std::path::Path, rel: &str) -> String {
    projector::note_path(memory_dir, rel)
        .to_string_lossy()
        .to_string()
}

fn absolutize_meta(memory_dir: &std::path::Path, meta: &mut NoteMeta) {
    meta.file_path = absolute_note_path(memory_dir, &meta.file_path);
}

fn absolutize_commit(memory_dir: &std::path::Path, mut r: CommitResult) -> CommitResult {
    r.file_path = absolute_note_path(memory_dir, &r.file_path);
    r
}

#[tauri::command]
pub async fn knowledge_list_notes(
    project_path: String,
    query: Option<ListQuery>,
) -> Result<Vec<NoteMeta>, String> {
    let q = query.unwrap_or_default();
    let p = project(&project_path)?;
    Ok(p.with_inner(|inner| {
        let mut notes: Vec<NoteMeta> = inner
            .graph
            .list(q.include_archived)
            .into_iter()
            .filter(|n| {
                q.types
                    .as_ref()
                    .map(|t| t.iter().any(|want| want == &n.note_type))
                    .unwrap_or(true)
            })
            .filter(|n| {
                q.tag
                    .as_ref()
                    .map(|tag| n.tags.iter().any(|t| t.eq_ignore_ascii_case(tag)))
                    .unwrap_or(true)
            })
            .collect();
        mark_conflicts(inner, &mut notes);
        for n in &mut notes {
            absolutize_meta(&inner.memory_dir, n);
        }
        notes
    }))
}

/// `knowledge_get_note`'s payload — the FLAT shape `KnowledgeNoteDetail`
/// reads: every meta field at top level (serde flatten), plus the body and
/// both link directions. NOT the adapter's nested `Note { meta, content }`:
/// returning that here left every flat read undefined and crashed the detail
/// panel on `detail.tags.length` the first time the feature ran for real.
/// The tripwire test pins this shape; `Note` stays as the IPC wire's own.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDetail {
    #[serde(flatten)]
    pub meta: NoteMeta,
    pub content: String,
    pub backlinks: Vec<LinkPeer>,
    pub outgoing_links: Vec<LinkPeer>,
}

/// One end of a link, as the panel renders it: the note a click selects and a
/// title to print. `id` absent = a broken outgoing link, kept visible — the
/// frontend's `KnowledgeLinkRef` contract.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkPeer {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub title: String,
}

fn note_detail(
    inner: &mut super::Inner,
    id: &str,
    revision: Option<i64>,
) -> Result<NoteDetail, String> {
    let mut meta = inner
        .graph
        .note(id)
        .cloned()
        .ok_or_else(|| format!("note {id} not found"))?;
    let content = match revision {
        Some(rev) if rev != meta.revision => store::get_revision(&inner.conn, id, rev)?,
        _ => store::note_content(&inner.conn, id)?,
    };
    mark_conflicts(inner, std::slice::from_mut(&mut meta));
    absolutize_meta(&inner.memory_dir, &mut meta);
    let links = store::backlinks(inner, id);
    let backlinks = links
        .incoming
        .iter()
        .map(|r| LinkPeer {
            id: Some(r.source_id.clone()),
            title: r.peer_title.clone().unwrap_or_else(|| r.source_id.clone()),
        })
        .collect();
    let outgoing_links = links
        .outgoing
        .iter()
        .map(|r| LinkPeer {
            id: r.target_id.clone(),
            title: r
                .peer_title
                .clone()
                .or_else(|| r.target_title.clone())
                .unwrap_or_else(|| "unresolved link".into()),
        })
        .collect();
    Ok(NoteDetail {
        meta,
        content,
        backlinks,
        outgoing_links,
    })
}

#[tauri::command]
pub async fn knowledge_get_note(
    project_path: String,
    id: Option<String>,
    entity_id: Option<String>,
    revision: Option<i64>,
) -> Result<NoteDetail, String> {
    let id = one_id(id, entity_id)?;
    let p = project(&project_path)?;
    p.with_inner(|inner| note_detail(inner, &id, revision))
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewNote {
    pub title: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub note_type: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// Takes either `{input: {...}}` or the fields flat — the sidebar's "New note"
/// sends nothing but a title.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn knowledge_create_note(
    project_path: String,
    input: Option<NewNote>,
    title: Option<String>,
    content: Option<String>,
    note_type: Option<String>,
    tags: Option<Vec<String>>,
) -> Result<CommitResult, String> {
    let input = match input {
        Some(i) => i,
        None => NewNote {
            title: title.ok_or("a title is required")?,
            content: content.unwrap_or_default(),
            note_type,
            tags: tags.unwrap_or_default(),
        },
    };
    let p = writable(&project_path)?;
    p.with_inner(|inner| {
        store::create_note(
            inner,
            CreateNoteInput {
                title: input.title,
                content: input.content,
                note_type: input.note_type,
                tags: input.tags,
                ..Default::default()
            },
            &Actor::user(),
        )
    })
    .map(|r| absolutize_commit(&p.memory_dir, r))
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteEdit {
    pub id: String,
    pub base_revision: i64,
    pub content: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub reason: Option<String>,
}

#[tauri::command]
pub async fn knowledge_update_note(
    project_path: String,
    input: NoteEdit,
) -> Result<CommitResult, String> {
    let p = writable(&project_path)?;
    p.with_inner(|inner| {
        store::update_note(
            inner,
            UpdateNoteInput {
                id: input.id,
                base_revision: input.base_revision,
                content: input.content,
                title: input.title,
                tags: input.tags,
                reason: input.reason,
            },
            &Actor::user(),
            store::SOURCE_API,
        )
    })
    .map(|r| absolutize_commit(&p.memory_dir, r))
}

/// Archive, never delete. The row and its whole revision history survive, so
/// Restore can put the file back exactly as it was.
#[tauri::command]
pub async fn knowledge_archive_note(
    project_path: String,
    id: Option<String>,
    entity_id: Option<String>,
    // Accepted and ignored: archiving is not a content commit, so it cannot go
    // stale the way an edit can. The UI sends the revision it was looking at.
    #[allow(unused_variables)] base_revision: Option<i64>,
) -> Result<CommitResult, String> {
    let id = one_id(id, entity_id)?;
    let p = writable(&project_path)?;
    p.with_inner(|inner| store::archive_note(inner, &id, &Actor::user(), true))
    .map(|r| absolutize_commit(&p.memory_dir, r))
}

#[tauri::command]
pub async fn knowledge_restore_note(
    project_path: String,
    id: Option<String>,
    entity_id: Option<String>,
) -> Result<CommitResult, String> {
    let id = one_id(id, entity_id)?;
    let p = writable(&project_path)?;
    p.with_inner(|inner| store::restore_note(inner, &id, &Actor::user()))
    .map(|r| absolutize_commit(&p.memory_dir, r))
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameInput {
    pub id: String,
    pub new_title: String,
    pub base_revision: i64,
    #[serde(default)]
    pub reslug: bool,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn knowledge_rename_note(
    project_path: String,
    input: Option<RenameInput>,
    id: Option<String>,
    entity_id: Option<String>,
    title: Option<String>,
    new_title: Option<String>,
    base_revision: Option<i64>,
    reslug: Option<bool>,
) -> Result<CommitResult, String> {
    let input = match input {
        Some(i) => i,
        None => RenameInput {
            id: one_id(id, entity_id)?,
            new_title: new_title
                .or(title)
                .ok_or("a new title is required")?,
            base_revision: base_revision.unwrap_or(0),
            reslug: reslug.unwrap_or(false),
        },
    };
    let p = writable(&project_path)?;
    p.with_inner(|inner| {
        store::rename_note(
            inner,
            &input.id,
            &input.new_title,
            input.base_revision,
            input.reslug,
            &Actor::user(),
        )
    })
    .map(|r| absolutize_commit(&p.memory_dir, r))
}

// ---------------------------------------------------------------------------
// Search and references
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn knowledge_search(
    project_path: String,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<SearchHit>, String> {
    let p = project(&project_path)?;
    p.with_inner(|inner| search::search(&inner.conn, &query, limit.unwrap_or(20)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveOpts {
    /// The composer's live preview passes false and leaves no trace; an actual
    /// send passes true and is audited.
    #[serde(default = "default_true")]
    pub record: bool,
    #[serde(default)]
    pub budget_tokens: Option<i64>,
    #[serde(default)]
    pub terminal_id: Option<String>,
    #[serde(default)]
    pub agent_kind: Option<String>,
}

impl Default for ResolveOpts {
    fn default() -> Self {
        Self {
            record: true,
            budget_tokens: None,
            terminal_id: None,
            agent_kind: None,
        }
    }
}

/// Options arrive nested (`opts`) or flat — the composer sends them flat.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn knowledge_resolve_refs(
    project_path: String,
    refs: Vec<String>,
    opts: Option<ResolveOpts>,
    record: Option<bool>,
    budget_tokens: Option<i64>,
    terminal_id: Option<String>,
    agent_kind: Option<String>,
) -> Result<ContextPackage, String> {
    let opts = opts.unwrap_or(ResolveOpts {
        record: record.unwrap_or(true),
        budget_tokens,
        terminal_id,
        agent_kind,
    });
    let p = project(&project_path)?;
    // Still the user acting — but record which pane it was aimed at, so the
    // audit trail can say what context reached which agent.
    let actor = Actor {
        actor_type: ACTOR_USER.to_string(),
        agent_kind: opts.agent_kind,
        session_id: None,
        pane_id: opts.terminal_id,
    };
    p.with_inner(|inner| {
        search::resolve_refs(
            inner,
            &refs,
            opts.budget_tokens.unwrap_or(search::DEFAULT_BUDGET_TOKENS),
            opts.record,
            &actor,
        )
    })
}

/// One entity, at the revision that actually reached an agent.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityRev {
    #[serde(alias = "id")]
    pub entity_id: String,
    pub revision: i64,
}

/// Log that context was DELIVERED, after the fact.
///
/// `knowledge_resolve_refs(record: true)` writes its audit entry when the
/// package is BUILT, which is not the moment the prompt is sent — the composer
/// can time out, fall back to sending the text as typed, or reuse an earlier
/// preview. Every one of those makes the audit claim an agent was told
/// something it never received. So the composer resolves with `record: false`
/// and calls this once the prompt has actually gone to the pane, which is the
/// only point at which the claim is true.
///
/// The parameters are FLAT to match the shipped caller
/// (`{projectPath, entityIds, terminalId?, agentKind?}`); Tauri maps each
/// snake_case parameter from its camelCase key.
///
/// Records exactly one event and does nothing else — no revision, no
/// projection, no graph change. Unknown entity ids are recorded as CLAIMED
/// rather than rejected: this describes what was sent to a CLI, which may
/// legitimately name an entity archived milliseconds earlier, and an audit that
/// silently drops those rows would misrepresent the very thing it exists to
/// record.
#[tauri::command]
pub async fn knowledge_record_context(
    project_path: String,
    entity_ids: Vec<EntityRev>,
    terminal_id: Option<String>,
    agent_kind: Option<String>,
) -> Result<(), String> {
    if entity_ids.is_empty() {
        return Ok(());
    }
    let p = writable(&project_path)?;
    let actor = Actor {
        actor_type: ACTOR_USER.to_string(),
        agent_kind,
        session_id: None,
        pane_id: terminal_id,
    };
    p.with_inner(|inner| {
        let summary = entity_ids
            .iter()
            .map(|e| {
                // The file path when we know it, because that is what a person
                // reading the audit recognises; the raw id when we do not, so
                // the claim is still on the record.
                let label = inner
                    .graph
                    .note(&e.entity_id)
                    .map(|m| m.file_path.clone())
                    .unwrap_or_else(|| e.entity_id.clone());
                format!("{label}@{}", e.revision)
            })
            .collect::<Vec<_>>()
            .join(", ");
        store::record_event(
            inner,
            store::EV_CONTEXT_RESOLVED,
            None,
            &actor,
            &format!("context delivered: {summary}"),
        )
        .map(|_| ())
    })
}

// ---------------------------------------------------------------------------
// History and conflicts
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn knowledge_history(
    project_path: String,
    id: Option<String>,
    entity_id: Option<String>,
    limit: Option<i64>,
    before_revision: Option<i64>,
) -> Result<Vec<RevisionMeta>, String> {
    let id = one_id(id, entity_id)?;
    let p = project(&project_path)?;
    p.with_inner(|inner| store::history(&inner.conn, &id, limit.unwrap_or(50), before_revision))
}

/// One historical revision, content AND the metadata that says who wrote it.
///
/// The revision modal renders an actor and a timestamp beside the snapshot, so
/// returning a bare string would make it show a body with no provenance.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionSnapshot {
    pub entity_id: String,
    pub revision: i64,
    pub content: String,
    pub actor: Actor,
    pub created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[tauri::command]
pub async fn knowledge_get_revision(
    project_path: String,
    id: Option<String>,
    entity_id: Option<String>,
    revision: i64,
) -> Result<RevisionSnapshot, String> {
    let id = one_id(id, entity_id)?;
    let p = project(&project_path)?;
    p.with_inner(|inner| {
        let content = store::get_revision(&inner.conn, &id, revision)?;
        // `history` selects `revision < before`, so asking for one row before
        // `revision + 1` is exactly this revision's own metadata.
        let meta = store::history(&inner.conn, &id, 1, Some(revision + 1))?
            .into_iter()
            .next()
            .filter(|m| m.revision == revision);
        Ok(RevisionSnapshot {
            entity_id: id.clone(),
            revision,
            content,
            actor: meta
                .as_ref()
                .map(|m| m.actor.clone())
                .unwrap_or_else(Actor::system),
            created_at: meta.as_ref().map(|m| m.created_at).unwrap_or(0),
            reason: meta.and_then(|m| m.reason),
        })
    })
}

/// Restoring never rewrites history — it commits the old content forward as a
/// new revision, so the version you restored FROM is still there afterwards.
#[tauri::command]
pub async fn knowledge_restore_revision(
    project_path: String,
    id: Option<String>,
    entity_id: Option<String>,
    revision: i64,
) -> Result<CommitResult, String> {
    let id = one_id(id, entity_id)?;
    let p = writable(&project_path)?;
    p.with_inner(|inner| store::restore_revision(inner, &id, revision, &Actor::user()))
    .map(|r| absolutize_commit(&p.memory_dir, r))
}

#[tauri::command]
pub async fn knowledge_list_conflicts(project_path: String) -> Result<Vec<ConflictInfo>, String> {
    let p = project(&project_path)?;
    p.with_inner(|inner| store::list_conflicts(inner))
}

/// One conflict with both sides in full.
///
/// `knowledge_list_conflicts` already inlines the texts, so the modal usually
/// opens without coming back here — this exists for the case where it has an id
/// and no row, and so a caller never has to page a whole list to read one.
#[tauri::command]
pub async fn knowledge_get_conflict(
    project_path: String,
    conflict_id: Option<String>,
    id: Option<String>,
) -> Result<ConflictInfo, String> {
    let wanted = conflict_id
        .or(id)
        .filter(|s| !s.trim().is_empty())
        .ok_or("a conflict id is required")?;
    let p = project(&project_path)?;
    p.with_inner(|inner| {
        store::list_conflicts(inner)?
            .into_iter()
            .find(|c| c.id == wanted)
            .ok_or_else(|| format!("conflict {wanted} not found"))
    })
}

/// `expectedHeadRevision` is optional but strongly recommended: pass the
/// `headRevision` the conflict row carried when the view was built, and a
/// resolution decided against a head that has since moved comes back as
/// `status: "conflict"` with the fresh content instead of overwriting whoever
/// moved it. Without it, only the `merged` arm can self-check.
#[tauri::command]
pub async fn knowledge_resolve_conflict(
    project_path: String,
    conflict_id: String,
    resolution: String,
    merged_content: Option<String>,
    expected_head_revision: Option<i64>,
) -> Result<CommitResult, String> {
    let p = writable(&project_path)?;
    p.with_inner(|inner| {
        store::resolve_conflict(
            inner,
            &conflict_id,
            &resolution,
            merged_content,
            expected_head_revision,
            &Actor::user(),
        )
    })
    .map(|r| absolutize_commit(&p.memory_dir, r))
}

// ---------------------------------------------------------------------------
// Structured documents
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateEdit {
    pub content: String,
    pub base_revision: i64,
    #[serde(default)]
    pub reason: Option<String>,
}

#[tauri::command]
pub async fn knowledge_update_state(
    project_path: String,
    input: StateEdit,
) -> Result<CommitResult, String> {
    let p = writable(&project_path)?;
    p.with_inner(|inner| {
        let doc = inner
            .graph
            .by_type("state")
            .cloned()
            .ok_or("no state document")?;
        store::update_note(
            inner,
            UpdateNoteInput {
                id: doc.id,
                base_revision: input.base_revision,
                content: input.content,
                reason: input.reason,
                ..Default::default()
            },
            &Actor::user(),
            store::SOURCE_API,
        )
    })
    .map(|r| absolutize_commit(&p.memory_dir, r))
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryInput {
    pub title: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// An append can never conflict with another append, so these take no base
/// revision — serializing them under the project lock is the whole story.
#[tauri::command]
pub async fn knowledge_add_decision(
    project_path: String,
    input: EntryInput,
) -> Result<CommitResult, String> {
    let p = writable(&project_path)?;
    p.with_inner(|inner| {
        store::append_entry(
            inner,
            "decisions",
            &input.title,
            &input.content,
            &input.tags,
            &Actor::user(),
        )
    })
    .map(|r| absolutize_commit(&p.memory_dir, r))
}

#[tauri::command]
pub async fn knowledge_add_learning(
    project_path: String,
    input: EntryInput,
) -> Result<CommitResult, String> {
    let p = writable(&project_path)?;
    p.with_inner(|inner| {
        store::append_entry(
            inner,
            "learnings",
            &input.title,
            &input.content,
            &input.tags,
            &Actor::user(),
        )
    })
    .map(|r| absolutize_commit(&p.memory_dir, r))
}

/// The sidebar's "Create handoff" sends only a summary line; the MCP tool sends
/// the whole structured record.
#[tauri::command]
pub async fn knowledge_create_handoff(
    project_path: String,
    input: Option<HandoffInput>,
    summary: Option<String>,
) -> Result<Handoff, String> {
    let input = match input {
        Some(i) => i,
        None => HandoffInput {
            task: summary
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "Handoff".to_string()),
            ..Default::default()
        },
    };
    let p = writable(&project_path)?;
    p.with_inner(|inner| store::create_handoff(inner, input, &Actor::user()))
}

#[tauri::command]
pub async fn knowledge_list_handoffs(
    project_path: String,
    limit: Option<i64>,
) -> Result<Vec<Handoff>, String> {
    let p = project(&project_path)?;
    p.with_inner(|inner| store::list_handoffs(&inner.conn, limit.unwrap_or(20)))
}

#[tauri::command]
pub async fn knowledge_latest_handoff(project_path: String) -> Result<Option<Handoff>, String> {
    let p = project(&project_path)?;
    p.with_inner(|inner| store::latest_handoff(&inner.conn))
}

#[tauri::command]
pub async fn knowledge_consume_handoff(project_path: String, id: String) -> Result<(), String> {
    let p = writable(&project_path)?;
    p.with_inner(|inner| store::consume_handoff(inner, &id, &Actor::user()))
}

#[tauri::command]
pub async fn knowledge_list_tasks(
    project_path: String,
    include_done: Option<bool>,
) -> Result<Vec<Task>, String> {
    let p = project(&project_path)?;
    p.with_inner(|inner| store::list_tasks(&inner.conn, include_done.unwrap_or(false)))
}

#[tauri::command]
pub async fn knowledge_create_task(
    project_path: String,
    title: String,
    detail: Option<String>,
) -> Result<Task, String> {
    let p = writable(&project_path)?;
    p.with_inner(|inner| store::create_task(inner, &title, detail, &Actor::user()))
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEdit {
    pub id: String,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub assignee: Option<String>,
}

#[tauri::command]
pub async fn knowledge_update_task(
    project_path: String,
    input: TaskEdit,
) -> Result<Task, String> {
    let p = writable(&project_path)?;
    p.with_inner(|inner| {
        store::update_task(
            inner,
            &input.id,
            input.status,
            input.title,
            input.detail,
            input.assignee,
            &Actor::user(),
        )
    })
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn knowledge_backlinks(project_path: String, id: String) -> Result<Backlinks, String> {
    let p = project(&project_path)?;
    Ok(p.with_inner(|inner| store::backlinks(inner, &id)))
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkInput {
    pub source_id: String,
    pub target_id: String,
    #[serde(default)]
    pub rel_type: Option<String>,
}

#[tauri::command]
pub async fn knowledge_link_entities(
    project_path: String,
    input: LinkInput,
) -> Result<String, String> {
    let p = writable(&project_path)?;
    p.with_inner(|inner| {
        store::link_entities(
            inner,
            &input.source_id,
            &input.target_id,
            input.rel_type.as_deref().unwrap_or("relates-to"),
            &Actor::user(),
        )
    })
}

// ---------------------------------------------------------------------------
// Diagnostics, policy, identity
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentChanges {
    pub events: Vec<EventInfo>,
    pub latest_seq: i64,
}

#[tauri::command]
pub async fn knowledge_recent_changes(
    project_path: String,
    since_seq: Option<i64>,
    limit: Option<i64>,
) -> Result<RecentChanges, String> {
    let p = project(&project_path)?;
    let (events, latest_seq) =
        p.with_inner(|inner| store::recent_events(&inner.conn, since_seq, limit.unwrap_or(50)))?;
    Ok(RecentChanges { events, latest_seq })
}

#[tauri::command]
pub async fn knowledge_set_policy(
    project_path: String,
    policy: String,
) -> Result<KnowledgeStatus, String> {
    if !matches!(
        policy.as_str(),
        store::POLICY_READ_ONLY | POLICY_ASK | store::POLICY_TRUSTED
    ) {
        return Err(format!("unknown write policy '{policy}'"));
    }
    let p = writable(&project_path)?;
    p.with_inner(|inner| store::meta_set(&inner.conn, store::META_POLICY, &policy))?;
    Ok(p.status())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitignoreResult {
    pub added: bool,
    pub already_present: bool,
    pub path: String,
}

/// Append-only, and only if absent. A .gitignore is the user's file; we add one
/// line to it and never reorder, rewrite or remove anything.
#[tauri::command]
pub async fn knowledge_append_gitignore(project_path: String) -> Result<GitignoreResult, String> {
    if super::is_remote_path(&project_path) {
        return Err("remote projects are not supported".into());
    }
    let path = std::path::Path::new(&project_path).join(".gitignore");
    let entry = format!("{}/", projector::MEMORY_DIR);
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let already = existing.lines().any(|line| {
        let t = line.trim().trim_start_matches('/').trim_end_matches('/');
        t == projector::MEMORY_DIR
    });
    if already {
        return Ok(GitignoreResult {
            added: false,
            already_present: true,
            path: path.to_string_lossy().to_string(),
        });
    }
    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(&format!("\n# MADE NexusMind project memory\n{entry}\n"));
    std::fs::write(&path, next).map_err(|e| format!("write .gitignore: {e}"))?;
    Ok(GitignoreResult {
        added: true,
        already_present: false,
        path: path.to_string_lossy().to_string(),
    })
}

/// MADE's own editor calls this immediately before saving a `.project-memory`
/// file, so the import it triggers is attributed to the user.
///
/// Deliberately NOT the same mechanism as the self-write ledger: the ledger
/// suppresses an import entirely, which is right for our own projection but
/// would mean a user's edits never produced a revision at all.
#[tauri::command]
pub async fn knowledge_mark_own_edit(
    project_path: String,
    file_path: String,
) -> Result<(), String> {
    let p = project(&project_path)?;
    p.with_inner(|inner| inner.own_edits.mark(super::norm_path(&file_path)));
    Ok(())
}

#[tauri::command]
pub async fn knowledge_pane_update(
    pane_id: String,
    project_path: Option<String>,
    agent_kind: Option<String>,
    session_id: Option<String>,
    status: String,
) -> Result<(), String> {
    if status == "closed" {
        super::pane_remove(&pane_id);
        return Ok(());
    }
    super::pane_upsert(
        &pane_id,
        super::PaneSessionInfo {
            project_key: project_path
                .as_deref()
                .map(super::project_key)
                .unwrap_or_default(),
            agent_kind: agent_kind.unwrap_or_default(),
            session_id,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn knowledge_mcp_connections() -> Result<Vec<McpConnectionInfo>, String> {
    Ok(ipc::connections_snapshot())
}

#[tauri::command]
pub async fn knowledge_respond_approval(
    request_id: String,
    verdict: String,
) -> Result<(), String> {
    if !matches!(verdict.as_str(), "approve" | "always" | "deny") {
        return Err(format!("unknown verdict '{verdict}'"));
    }
    ipc::respond_approval(&request_id, &verdict)
}

/// Where THIS build's MCP adapter executable lives, or `null` when it is not
/// there.
///
/// A bare string rather than a `{path, exists}` pair, because `exists` was never
/// a second fact: `mcp.ts` reads the result as `string | null` and uses it only
/// to explain a path mismatch — "registered to X, this MADE is at Y". A path
/// that does not exist would make that sentence false, so the absent case IS
/// null.
#[tauri::command]
pub async fn knowledge_adapter_path() -> Result<Option<String>, String> {
    Ok(super::mcp_config::adapter_exe_path().map(|p| p.to_string_lossy().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn commands_refuse_remote_projects_by_name() {
        let status = knowledge_status("user@host:/srv/code".into()).await.unwrap();
        assert_eq!(status.state, "remote-unsupported");
        assert!(status.readonly_reason.is_some());
        assert!(knowledge_open("user@host:/srv/code".into(), false)
            .await
            .is_err_and(|e| e.contains("remote")));
        assert!(knowledge_append_gitignore("ssh://host/code".into())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn status_reports_uninitialized_without_writing_anything() {
        let dir = crate::knowledge::testutil::TestDir::new();
        let path = dir.path().to_string_lossy().to_string();
        let status = knowledge_status(path.clone()).await.unwrap();
        assert_eq!(status.state, "uninitialized");
        // The whole point: probing must not create the folder.
        assert!(!dir.path().join(projector::MEMORY_DIR).exists());
        assert!(std::fs::read_dir(dir.path()).unwrap().next().is_none());
    }

    #[tokio::test]
    async fn commands_on_an_unopened_project_fail_soft() {
        let dir = crate::knowledge::testutil::TestDir::new();
        let path = dir.path().to_string_lossy().to_string();
        assert!(knowledge_list_notes(path.clone(), None)
            .await
            .is_err_and(|e| e.contains("not open")));
        assert!(knowledge_search(path, "x".into(), None).await.is_err());
    }

    #[tokio::test]
    async fn gitignore_append_is_idempotent_and_preserves_the_file() {
        let dir = crate::knowledge::testutil::TestDir::new();
        let path = dir.path().to_string_lossy().to_string();
        std::fs::write(dir.path().join(".gitignore"), "node_modules\ndist\n").unwrap();

        let first = knowledge_append_gitignore(path.clone()).await.unwrap();
        assert!(first.added && !first.already_present);
        let text = std::fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        assert!(text.starts_with("node_modules\ndist\n"), "existing rules were disturbed");
        assert!(text.contains(&format!("{}/", projector::MEMORY_DIR)));

        let second = knowledge_append_gitignore(path.clone()).await.unwrap();
        assert!(!second.added && second.already_present);
        assert_eq!(
            std::fs::read_to_string(dir.path().join(".gitignore")).unwrap(),
            text,
            "a second call must not append again"
        );

        // A pre-existing entry in any of its spellings counts as present.
        std::fs::write(
            dir.path().join(".gitignore"),
            format!("/{}\n", projector::MEMORY_DIR),
        )
        .unwrap();
        assert!(knowledge_append_gitignore(path).await.unwrap().already_present);
    }

    #[tokio::test]
    async fn policy_and_verdict_values_are_validated() {
        assert!(knowledge_set_policy("C:/nope".into(), "banana".into())
            .await
            .is_err_and(|e| e.contains("unknown write policy")));
        assert!(knowledge_respond_approval("apr_x".into(), "maybe".into())
            .await
            .is_err_and(|e| e.contains("unknown verdict")));
        // A valid verdict for an approval nobody is waiting on is a clean error.
        assert!(knowledge_respond_approval("apr_missing".into(), "approve".into())
            .await
            .is_err_and(|e| e.contains("no longer waiting")));
    }

    #[tokio::test]
    async fn pane_registry_round_trips() {
        knowledge_pane_update(
            "term-test-1".into(),
            Some("C:/code/alpha".into()),
            Some("codex".into()),
            Some("sess-42".into()),
            "active".into(),
        )
        .await
        .unwrap();
        let info = super::super::pane_info("term-test-1").expect("registered");
        assert_eq!(info.agent_kind, "codex");
        assert_eq!(info.session_id.as_deref(), Some("sess-42"));

        knowledge_pane_update("term-test-1".into(), None, None, None, "closed".into())
            .await
            .unwrap();
        assert!(super::super::pane_info("term-test-1").is_none());
    }

    /// Under `cargo test` the running executable is the test harness, which has
    /// no adapter beside it — so this asserts the CONTRACT rather than a value:
    /// whatever comes back is either absent, or a path that is really there.
    /// Reporting a path that does not exist is the one answer that would make
    /// the Settings mismatch warning lie.
    #[tokio::test]
    async fn adapter_path_is_a_real_file_or_nothing() {
        match knowledge_adapter_path().await.unwrap() {
            None => {}
            Some(path) => {
                assert!(std::path::Path::new(&path).is_file(), "{path} is not there");
                assert!(path.contains("made-knowledge-mcp"), "{path}");
            }
        }
    }

    /// The payload keys `src/lib/knowledge/types.ts` reads, asserted against
    /// real serialized JSON.
    ///
    /// This test exists because the Rust field names and the TypeScript ones
    /// drifted apart once already and nothing caught it: every mismatch is a
    /// silently-undefined property in a render, not a compile error on either
    /// side. Renaming a field here without updating types.ts must fail loudly.
    #[test]
    fn published_payloads_use_the_field_names_the_frontend_reads() {
        use crate::knowledge::testutil::fixture;

        let keys = |v: &serde_json::Value| -> Vec<String> {
            v.as_object()
                .expect("object")
                .keys()
                .cloned()
                .collect::<Vec<_>>()
        };
        let has = |v: &serde_json::Value, k: &str| {
            assert!(
                v.get(k).is_some(),
                "missing `{k}` — the frontend reads it. Present: {:?}",
                keys(v)
            );
        };

        let mut f = fixture();
        let created = f.note("Rotating tokens", "# Rotating tokens\n\nbody\n");

        // Actor: the plan fixes this shape as {kind, agentKind?}.
        let actor = serde_json::to_value(Actor::agent("codex", None, None)).unwrap();
        assert_eq!(actor.get("kind").and_then(|v| v.as_str()), Some("agent"));
        assert_eq!(
            actor.get("agentKind").and_then(|v| v.as_str()),
            Some("codex")
        );
        assert!(
            actor.get("actorType").is_none(),
            "actorType is the old spelling and must not come back"
        );

        // NoteMeta -> KnowledgeNoteMeta.
        let meta = f.inner.graph.note(&created.id).cloned().expect("note");
        let meta_json = serde_json::to_value(&meta).unwrap();
        for k in [
            "id", "type", "title", "slug", "tags", "revision", "updatedAt", "updatedBy", "filePath",
            "archived",
        ] {
            has(&meta_json, k);
        }
        assert_eq!(meta_json["type"].as_str(), Some("note"));
        // updatedBy is an actor OBJECT, not the stored byline string.
        assert_eq!(meta_json["updatedBy"]["kind"].as_str(), Some("user"));
        // ...and it survives the round trip back into the byline column.
        let back: NoteMeta = serde_json::from_value(meta_json.clone()).unwrap();
        assert_eq!(back.updated_by, "user");
        // A bare string still deserializes, so older payloads keep working.
        let mut legacy = meta_json.clone();
        legacy["updatedBy"] = serde_json::json!("codex");
        let legacy: NoteMeta = serde_json::from_value(legacy).unwrap();
        assert_eq!(legacy.updated_by, "codex");

        // note_detail -> KnowledgeNoteDetail: FLAT meta fields plus content and
        // both link directions. `knowledge_get_note` originally returned the
        // adapter's nested `Note { meta, content }`, which left every flat read
        // undefined and crashed the sidebar's detail panel on
        // `detail.tags.length` — found by the FIRST runtime session, after four
        // static review waves missed it (2026-08-07). The nested shape stays
        // legal on the adapter IPC wire; the Tauri command's payload is flat.
        let detail = note_detail(&mut f.inner, &created.id, None).expect("detail");
        let detail = serde_json::to_value(detail).unwrap();
        for k in [
            "id",
            "type",
            "title",
            "slug",
            "tags",
            "revision",
            "updatedAt",
            "updatedBy",
            "filePath",
            "archived",
            "content",
            "backlinks",
            "outgoingLinks",
        ] {
            has(&detail, k);
        }
        assert!(
            detail.get("meta").is_none(),
            "nested {{meta, content}} is the drift that crashed the panel"
        );
        assert!(detail["tags"].is_array(), "tags must be an array, the panel reads .length");
        assert!(detail["backlinks"].is_array());
        assert!(detail["outgoingLinks"].is_array());
        assert_eq!(detail["content"].as_str(), Some("# Rotating tokens\n\nbody\n"));
        // ABSOLUTE, not the store's relative form: the viewer opens this
        // as-is, and a bare `notes/x.md` resolves against the exe's CWD (the
        // second defect the first runtime session found — os error 2).
        let abs = detail["filePath"].as_str().expect("filePath");
        assert!(
            abs.starts_with(&*f.inner.memory_dir.to_string_lossy()),
            "filePath must be absolute under the memory dir: {abs}"
        );

        // ApprovalRequest -> the ask-policy approval toast
        // (KnowledgeApprovalHost). This seam shipped with an emitter and a
        // responder but NO listener; now that one exists, its keys are pinned.
        let approval = serde_json::to_value(ApprovalRequest {
            request_id: "apr_1".into(),
            project_key: "k".into(),
            project_path: "C:/p".into(),
            agent_kind: "claude".into(),
            pane_id: None,
            method: "add_decision".into(),
            created_at: 0,
        })
        .unwrap();
        for k in ["requestId", "projectPath", "agentKind", "method"] {
            has(&approval, k);
        }

        // KnowledgeWorld -> the boot-time world fetch (keys.ts applies it).
        let world = serde_json::to_value(KnowledgeWorld {
            memory_dir_name: projector::MEMORY_DIR.into(),
            mcp_server_name: crate::knowledge::mcp_config::SERVER_NAME.into(),
        })
        .unwrap();
        has(&world, "memoryDirName");
        has(&world, "mcpServerName");

        // SearchHit -> KnowledgeSearchResult.
        let hits = search::search(&f.inner.conn, "rotating", 10).expect("search");
        let hit = serde_json::to_value(hits.first().expect("a hit")).unwrap();
        for k in ["entityId", "title", "type", "snippet", "filePath"] {
            has(&hit, k);
        }

        // ContextPackage -> ContextPackage.
        let pkg = search::resolve_refs(
            &mut f.inner,
            &["@state".to_string()],
            search::DEFAULT_BUDGET_TOKENS,
            false,
            &Actor::user(),
        )
        .expect("resolve");
        let pkg = serde_json::to_value(pkg).unwrap();
        for k in [
            "projectId",
            "generatedAt",
            "knowledgeRevision",
            "tokenEstimate",
            "sources",
            "renderedPromptContext",
            "truncated",
        ] {
            has(&pkg, k);
        }

        // Handoff -> KnowledgeHandoff.
        let handoff = store::create_handoff(
            &mut f.inner,
            HandoffInput {
                task: "Finish the store".into(),
                ..Default::default()
            },
            &Actor::user(),
        )
        .expect("handoff");
        let handoff = serde_json::to_value(handoff).unwrap();
        for k in ["id", "title", "createdAt", "createdBy", "renderedMarkdown"] {
            has(&handoff, k);
        }
        assert_eq!(handoff["title"].as_str(), Some("Finish the store"));

        // KnowledgeStatus -> KnowledgeProjectStatus.
        let status = serde_json::to_value(KnowledgeStatus::simple(
            "ready",
            &f.inner.project_key,
            &f.inner.project_path,
        ))
        .unwrap();
        for k in [
            "state",
            "revision",
            "noteCount",
            "conflictCount",
            "policy",
            "pendingApprovals",
        ] {
            has(&status, k);
        }

        // ConflictInfo -> KnowledgeConflict. `headRevision` is what a caller
        // passes back to resolve_conflict to prove its view was current.
        let conflict = serde_json::to_value(ConflictInfo {
            id: "cfl_1".into(),
            entity_id: created.id.clone(),
            title: "Rotating tokens".into(),
            file_path: "notes/rotating-tokens.md".into(),
            base_revision: 1,
            current_revision: 2,
            head_revision: 3,
            theirs_content: "theirs".into(),
            current_content: "current".into(),
            actor: Actor::external(),
            current_actor: Actor::user(),
            source: "file".into(),
            status: "open".into(),
            created_at: 0,
            merged_preview: Some("merged".into()),
        })
        .unwrap();
        for k in [
            "id",
            "entityId",
            "yours",
            "current",
            "merged",
            "yoursActor",
            "currentActor",
            "headRevision",
            "createdAt",
            "source",
        ] {
            has(&conflict, k);
        }

        // INPUT shapes are contracts too. `knowledge_record_context` takes its
        // params FLAT — Tauri maps each snake_case parameter from the caller's
        // camelCase key — so the only nested shape to pin is the entity row.
        let sent = serde_json::json!({ "entityId": "kn_abc", "revision": 7 });
        let parsed: EntityRev = serde_json::from_value(sent).expect(
            "the shipped caller sends {entityId, revision}; changing that field \
             name silently breaks the delivery audit",
        );
        assert_eq!(parsed.entity_id, "kn_abc");
        assert_eq!(parsed.revision, 7);
        // The whole argument list as the caller sends it.
        let args = serde_json::json!({
            "projectPath": "C:/code/alpha",
            "entityIds": [{ "entityId": "kn_abc", "revision": 7 }],
            "terminalId": "term-1",
            "agentKind": "claude",
        });
        let rows: Vec<EntityRev> =
            serde_json::from_value(args["entityIds"].clone()).expect("entityIds");
        assert_eq!(rows.len(), 1);
    }

    /// Every state string the service publishes has to be one the sidebar
    /// routes on. An unknown value falls back to `ready` there, which would
    /// render a remote or still-loading project as a working one.
    #[tokio::test]
    async fn every_published_state_is_one_the_sidebar_knows() {
        const KNOWN: [&str; 6] = [
            "loading",
            "uninitialized",
            "ready",
            "readonly",
            "unavailable",
            "remote-unsupported",
        ];
        let dir = crate::knowledge::testutil::TestDir::new();
        let path = dir.path().to_string_lossy().to_string();

        let mut seen = vec![knowledge_status(path.clone()).await.unwrap().state];
        seen.push(
            knowledge_status("user@host:/srv/code".into())
                .await
                .unwrap()
                .state,
        );
        // A project with a .project-memory but nothing attached yet.
        std::fs::create_dir_all(dir.path().join(projector::MEMORY_DIR)).unwrap();
        seen.push(knowledge_status(path).await.unwrap().state);

        for state in seen {
            assert!(KNOWN.contains(&state.as_str()), "unknown state `{state}`");
        }
    }

    /// The delivery audit records what actually reached the pane, including
    /// entities the store can no longer resolve.
    #[tokio::test]
    async fn record_context_logs_the_supplied_entities() {
        use crate::knowledge::testutil::fixture;
        let mut f = fixture();
        let note = f.note("Doc", "# Doc\n\nbody\n");

        let before = store::recent_events(&f.inner.conn, None, 50)
            .expect("events")
            .0
            .len();
        let actor = Actor {
            actor_type: ACTOR_USER.to_string(),
            agent_kind: Some("codex".into()),
            session_id: None,
            pane_id: Some("term-3".into()),
        };
        let supplied = [
            EntityRev {
                entity_id: note.id.clone(),
                revision: 1,
            },
            // Claimed but unknown — an entity archived milliseconds after the
            // prompt was built. The audit describes what was SENT, so this has
            // to survive rather than be filtered out.
            EntityRev {
                entity_id: "kn_ffffffffffffffffffffffffffffffff".into(),
                revision: 9,
            },
        ];
        let summary = supplied
            .iter()
            .map(|e| {
                let label = f
                    .inner
                    .graph
                    .note(&e.entity_id)
                    .map(|m| m.file_path.clone())
                    .unwrap_or_else(|| e.entity_id.clone());
                format!("{label}@{}", e.revision)
            })
            .collect::<Vec<_>>()
            .join(", ");
        store::record_event(
            &mut f.inner,
            store::EV_CONTEXT_RESOLVED,
            None,
            &actor,
            &format!("context delivered: {summary}"),
        )
        .expect("record");

        let (events, _) = store::recent_events(&f.inner.conn, None, 50).expect("events");
        assert!(events.len() > before);
        let logged = events
            .iter()
            .find(|e| e.event_type == store::EV_CONTEXT_RESOLVED)
            .expect("a context event was recorded");
        assert!(logged.summary.contains("delivered"));
        assert!(logged.summary.contains(&note.file_path));
        assert!(
            logged.summary.contains("kn_ffffffffffffffffffffffffffffffff@9"),
            "an unresolvable id was dropped from the audit: {}",
            logged.summary
        );
        assert_eq!(logged.actor.agent_kind.as_deref(), Some("codex"));
        assert_eq!(logged.actor.pane_id.as_deref(), Some("term-3"));

        // Nothing else happened: no revision, no conflict.
        assert_eq!(f.inner.graph.note(&note.id).unwrap().revision, 1);
        assert!(store::list_conflicts(&mut f.inner).expect("conflicts").is_empty());
    }

    /// An empty list is a no-op, not an error — the composer calls this
    /// unconditionally after every send.
    #[tokio::test]
    async fn record_context_with_no_entities_is_a_no_op() {
        let dir = crate::knowledge::testutil::TestDir::new();
        let path = dir.path().to_string_lossy().to_string();
        // Reaches the empty check before the project lookup, so it succeeds
        // even with nothing open.
        knowledge_record_context(path, Vec::new(), None, None)
            .await
            .expect("empty must not error");
    }

    /// Both id spellings reach the same note.
    #[tokio::test]
    async fn note_commands_accept_id_and_entity_id() {
        assert_eq!(one_id(Some("kn_a".into()), None).unwrap(), "kn_a");
        assert_eq!(one_id(None, Some("kn_b".into())).unwrap(), "kn_b");
        // An empty string is not an id — it would otherwise look up "" and
        // report "not found" instead of the real problem.
        assert!(one_id(Some("  ".into()), None).is_err());
        assert!(one_id(None, None).is_err());
    }
}
