//! The single Tauri event this module emits, and the coalescer in front of it.
//!
//! `app.emit` in this codebase is an unfiltered broadcast — every payload is
//! delivered to and deserialized by the main, overlay AND toast webviews. A
//! per-entity change stream would therefore tax two webviews that will never
//! render a note, which is exactly the main-thread JSON.parse backlog that once
//! made overlay popups take seconds to appear (pty.rs).
//!
//! So: one static event name, one small payload per project per ~150ms, and no
//! content in it. The frontend re-queries what it actually needs.

use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::Emitter;

use super::model::Actor;
use super::store;
use super::Inner;

pub const CHANGE_EVENT: &str = "made:knowledge-changed";

const FLUSH_MS: u64 = 150;
/// Past this many entities the payload says "and more" instead of growing. A
/// sidebar refresh costs the same either way.
const MAX_ENTITY_IDS: usize = 32;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangePayload {
    pub project_key: String,
    pub project_path: String,
    pub revision: i64,
    pub kinds: Vec<String>,
    pub entity_ids: Vec<String>,
    pub truncated: bool,
    pub open_conflicts: i64,
    /// Who caused this batch, when it was all one actor. Absent for a mixed
    /// batch — the toast rules need to know "this was your own save", and a
    /// half-true answer there is worse than none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor: Option<Actor>,
}

#[derive(Default)]
struct Pending {
    project_path: String,
    memory_dir: PathBuf,
    db_file_name: String,
    kinds: BTreeSet<String>,
    entity_ids: Vec<String>,
    truncated: bool,
    revision: i64,
    open_conflicts: i64,
    actor: Option<Actor>,
    actor_mixed: bool,
    flush_scheduled: bool,
}

fn pending() -> &'static Mutex<HashMap<String, Pending>> {
    static PENDING: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Note a change and make sure a flush is coming. Cheap enough to call from
/// inside a commit — it takes one short lock and never touches the filesystem.
pub fn record(inner: &mut Inner, kind: &str, entity_id: Option<&str>, actor: &Actor) {
    let revision = store::latest_seq(&inner.conn);
    let open_conflicts = store::open_conflict_count(&inner.conn);
    let schedule = accumulate(
        &inner.project_key,
        &inner.project_path,
        &inner.memory_dir,
        &inner.db_file_name,
        kind,
        entity_id,
        actor,
        revision,
        open_conflicts,
    );
    if schedule {
        schedule_flush(inner.project_key.clone());
    }
}

/// Merge one change into the pending batch. Returns true when the caller owes
/// us a flush task (i.e. this change opened a new batch).
#[allow(clippy::too_many_arguments)]
fn accumulate(
    project_key: &str,
    project_path: &str,
    memory_dir: &std::path::Path,
    db_file_name: &str,
    kind: &str,
    entity_id: Option<&str>,
    actor: &Actor,
    revision: i64,
    open_conflicts: i64,
) -> bool {
    let Ok(mut map) = pending().lock() else {
        return false;
    };
    let entry = map.entry(project_key.to_string()).or_default();
    entry.project_path = project_path.to_string();
    entry.memory_dir = memory_dir.to_path_buf();
    entry.db_file_name = db_file_name.to_string();
    entry.kinds.insert(kind.to_string());
    entry.revision = revision;
    entry.open_conflicts = open_conflicts;

    match (&entry.actor, entry.actor_mixed) {
        (_, true) => {}
        (None, _) => entry.actor = Some(actor.clone()),
        (Some(existing), _) if existing != actor => {
            entry.actor = None;
            entry.actor_mixed = true;
        }
        _ => {}
    }

    if let Some(id) = entity_id {
        if !entry.entity_ids.iter().any(|e| e == id) {
            if entry.entity_ids.len() < MAX_ENTITY_IDS {
                entry.entity_ids.push(id.to_string());
            } else {
                entry.truncated = true;
            }
        }
    }

    if entry.flush_scheduled {
        false
    } else {
        entry.flush_scheduled = true;
        true
    }
}

fn schedule_flush(project_key: String) {
    let Some(handle) = super::runtime_handle() else {
        // No runtime (unit tests, or init() never ran) — the batch stays
        // pending and merges into the next real flush rather than being lost.
        return;
    };
    handle.spawn(async move {
        tokio::time::sleep(Duration::from_millis(FLUSH_MS)).await;
        flush(&project_key);
    });
}

/// Drain one project's batch and emit it.
pub fn flush(project_key: &str) {
    let Some(payload) = take(project_key) else {
        return;
    };
    if let Some(app) = super::app_handle() {
        // Emit failures are swallowed everywhere in this codebase: a webview
        // that has gone away is not an error worth propagating into a commit.
        let _ = app.emit(CHANGE_EVENT, payload.0.clone());
    }
    // Piggy-backed on the flush so a burst of commits writes this once.
    let _ = super::projector::write_sync_state_json(
        &payload.1,
        payload.0.revision,
        &payload.2,
    );
}

/// Remove and render the pending batch, with the paths the flush needs.
fn take(project_key: &str) -> Option<(ChangePayload, PathBuf, String)> {
    let mut map = pending().lock().ok()?;
    let entry = map.remove(project_key)?;
    Some((
        ChangePayload {
            project_key: project_key.to_string(),
            project_path: entry.project_path,
            revision: entry.revision,
            kinds: entry.kinds.into_iter().collect(),
            entity_ids: entry.entity_ids,
            truncated: entry.truncated,
            open_conflicts: entry.open_conflicts,
            actor: entry.actor,
        },
        entry.memory_dir,
        entry.db_file_name,
    ))
}

/// Emit immediately, without waiting for the timer. Used by follower mode,
/// which has no local commit to hang a batch off, and on close.
pub fn emit_now(
    project_key: &str,
    project_path: &str,
    revision: i64,
    kinds: &[&str],
    open_conflicts: i64,
) {
    let Some(app) = super::app_handle() else {
        return;
    };
    let _ = app.emit(
        CHANGE_EVENT,
        ChangePayload {
            project_key: project_key.to_string(),
            project_path: project_path.to_string(),
            revision,
            kinds: kinds.iter().map(|k| (*k).to_string()).collect(),
            entity_ids: Vec::new(),
            truncated: false,
            open_conflicts,
            actor: None,
        },
    );
}

/// Drop a project's pending batch — it is closing and nobody will render it.
pub fn discard(project_key: &str) {
    if let Ok(mut map) = pending().lock() {
        map.remove(project_key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record_one(key: &str, kind: &str, entity: Option<&str>, actor: &Actor) -> bool {
        let memory_dir = format!("C:/proj/{}", crate::knowledge::projector::MEMORY_DIR);
        accumulate(
            key,
            "C:/proj",
            std::path::Path::new(&memory_dir),
            "proj-abc.db",
            kind,
            entity,
            actor,
            7,
            1,
        )
    }

    #[test]
    fn coalescer_batches_into_one_payload() {
        let key = "test-coalesce-batch";
        discard(key);
        // Only the first change schedules a flush; the rest join that batch.
        assert!(record_one(key, "note.updated", Some("kn_1"), &Actor::user()));
        for i in 2..=5 {
            assert!(!record_one(
                key,
                "note.updated",
                Some(&format!("kn_{i}")),
                &Actor::user()
            ));
        }
        record_one(key, "conflict.created", Some("kn_1"), &Actor::user());

        let (payload, dir, db) = take(key).expect("one batch");
        assert_eq!(payload.kinds, vec!["conflict.created", "note.updated"]);
        assert_eq!(payload.entity_ids.len(), 5, "duplicate id must not repeat");
        assert!(!payload.truncated);
        assert_eq!(payload.revision, 7);
        assert_eq!(payload.open_conflicts, 1);
        assert_eq!(payload.actor.as_ref().map(|a| a.byline()), Some("user".into()));
        assert_eq!(db, "proj-abc.db");
        assert!(dir.ends_with(crate::knowledge::projector::MEMORY_DIR));

        // Draining leaves nothing, and the next change opens a fresh batch.
        assert!(take(key).is_none());
        assert!(record_one(key, "note.updated", Some("kn_9"), &Actor::user()));
        discard(key);
    }

    #[test]
    fn entity_ids_are_capped_and_flagged() {
        let key = "test-coalesce-cap";
        discard(key);
        for i in 0..(MAX_ENTITY_IDS + 10) {
            record_one(key, "note.updated", Some(&format!("kn_{i}")), &Actor::user());
        }
        let (payload, _, _) = take(key).expect("batch");
        assert_eq!(payload.entity_ids.len(), MAX_ENTITY_IDS);
        assert!(payload.truncated);
    }

    #[test]
    fn mixed_actors_drop_the_attribution() {
        let key = "test-coalesce-actors";
        discard(key);
        record_one(key, "note.updated", Some("kn_1"), &Actor::user());
        record_one(
            key,
            "note.updated",
            Some("kn_2"),
            &Actor::agent("codex", None, None),
        );
        let (payload, _, _) = take(key).expect("batch");
        assert!(
            payload.actor.is_none(),
            "a mixed batch must not claim a single author"
        );
    }

    #[test]
    fn same_actor_repeated_keeps_the_attribution() {
        let key = "test-coalesce-same-actor";
        discard(key);
        let codex = Actor::agent("codex", Some("s1".into()), None);
        record_one(key, "note.updated", Some("kn_1"), &codex);
        record_one(key, "note.updated", Some("kn_2"), &codex);
        let (payload, _, _) = take(key).expect("batch");
        assert_eq!(payload.actor, Some(codex));
    }

    #[test]
    fn projects_batch_independently() {
        discard("proj-a");
        discard("proj-b");
        assert!(record_one("proj-a", "note.updated", Some("kn_1"), &Actor::user()));
        assert!(record_one("proj-b", "note.updated", Some("kn_2"), &Actor::user()));
        let (a, _, _) = take("proj-a").expect("a");
        let (b, _, _) = take("proj-b").expect("b");
        assert_eq!(a.entity_ids, vec!["kn_1".to_string()]);
        assert_eq!(b.entity_ids, vec!["kn_2".to_string()]);
    }
}
