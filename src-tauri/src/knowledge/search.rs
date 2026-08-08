//! Full-text search, and turning `@`-references into a prompt-ready context
//! package.
//!
//! Search goes through the FTS5 index; everything else in this module is about
//! the budget. A context package is pasted into a terminal in front of whatever
//! the user typed, so it has to be BOUNDED and it has to be honest: a note that
//! did not fit is marked truncated, and a reference that resolved to nothing is
//! reported rather than silently dropped.

use rusqlite::{params, Connection};

use super::model::*;
use super::store;
use super::Inner;

/// Bytes per token. Deliberately crude — this gates an inclusion decision, not
/// a billing calculation, and every real tokenizer would be a dependency.
const BYTES_PER_TOKEN: i64 = 4;
pub const DEFAULT_BUDGET_TOKENS: i64 = 12_000;

pub fn search(conn: &Connection, query: &str, limit: i64) -> Result<Vec<SearchHit>, String> {
    let Some(expr) = fts_expression(query) else {
        return Ok(Vec::new());
    };
    let mut stmt = conn
        .prepare_cached(
            "SELECT n.id, n.title, n.type, n.file_path, \
                    snippet(notes_fts, 1, '', '', '…', 12), n.updated_at, n.updated_by \
             FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid \
             WHERE notes_fts MATCH ?1 AND n.archived = 0 \
             ORDER BY bm25(notes_fts) LIMIT ?2",
        )
        .map_err(|e| format!("search prepare: {e}"))?;
    let rows = stmt
        .query_map(params![expr, limit.clamp(1, 50)], |r| {
            Ok(SearchHit {
                id: r.get(0)?,
                title: r.get(1)?,
                note_type: r.get(2)?,
                file_path: r.get(3)?,
                snippet: r.get(4)?,
                updated_at: r.get(5)?,
                updated_by: r.get(6)?,
            })
        })
        .map_err(|e| format!("search: {e}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("search row: {e}"))
}

/// Turn user input into an FTS5 MATCH expression that cannot be a syntax error.
///
/// Every token is quoted, so `AND`, `NEAR`, `*` and stray punctuation are
/// searched for rather than interpreted. The final token gets a prefix `*` so
/// search-as-you-type finds `authentication` while you are still on `auth`.
fn fts_expression(query: &str) -> Option<String> {
    let tokens: Vec<String> = query
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|t| !t.is_empty())
        .map(|t| t.replace('"', "\"\""))
        .collect();
    if tokens.is_empty() {
        return None;
    }
    let last = tokens.len() - 1;
    Some(
        tokens
            .iter()
            .enumerate()
            .map(|(i, t)| {
                if i == last && t.chars().count() >= 2 {
                    format!("\"{t}\"*")
                } else {
                    format!("\"{t}\"")
                }
            })
            .collect::<Vec<_>>()
            .join(" "),
    )
}

/// Rebuild the index from `notes`. Only needed after a bulk repair — normal
/// writes keep it current through the trigger triple.
pub fn fts_rebuild(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')")
        .map_err(|e| format!("fts rebuild: {e}"))
}

// ---------------------------------------------------------------------------
// Reference resolution
// ---------------------------------------------------------------------------

pub fn token_estimate(text: &str) -> i64 {
    (text.len() as i64 + BYTES_PER_TOKEN - 1) / BYTES_PER_TOKEN
}

/// Resolve `@`-references into a bounded, ordered context package.
///
/// `record: false` is the composer's live preview and must leave no trace;
/// `record: true` is an actual send and logs which entities at which revisions
/// were handed to which agent.
pub fn resolve_refs(
    inner: &mut Inner,
    refs: &[String],
    budget_tokens: i64,
    record: bool,
    actor: &Actor,
) -> Result<ContextPackage, String> {
    let budget = if budget_tokens > 0 {
        budget_tokens
    } else {
        DEFAULT_BUDGET_TOKENS
    };
    let mut sources: Vec<ContextSource> = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    let mut used = 0i64;

    for reference in refs {
        let trimmed = reference.trim().trim_start_matches('@');
        if trimmed.is_empty() {
            continue;
        }
        let ids = resolve_one(inner, trimmed);
        if ids.is_empty() {
            missing.push(reference.clone());
            continue;
        }
        for id in ids {
            if sources.iter().any(|s| s.entity_id == id) {
                continue;
            }
            let Some(meta) = inner.graph.note(&id).cloned() else {
                continue;
            };
            let Ok(content) = store::note_content(&inner.conn, &id) else {
                continue;
            };
            let remaining = budget - used;
            if remaining <= 0 {
                break;
            }
            let (content, truncated) = fit_to_budget(&content, remaining);
            let estimate = token_estimate(&content);
            used += estimate;
            sources.push(ContextSource {
                entity_id: meta.id,
                revision: meta.revision,
                title: meta.title,
                file_path: meta.file_path,
                content,
                token_estimate: estimate,
                truncated,
            });
        }
    }

    let revision = store::latest_seq(&inner.conn);
    let rendered = render_context(&inner.project_key, revision, &sources);
    if record && !sources.is_empty() {
        let summary = sources
            .iter()
            .map(|s| format!("{}@{}", s.file_path, s.revision))
            .collect::<Vec<_>>()
            .join(", ");
        let _ = store::record_event(
            inner,
            store::EV_CONTEXT_RESOLVED,
            None,
            actor,
            &format!("context supplied: {summary}"),
        );
    }

    Ok(ContextPackage {
        project_key: inner.project_key.clone(),
        generated_at: now_ms(),
        knowledge_revision: revision,
        token_estimate: used,
        truncated: sources.iter().any(|s| s.truncated),
        sources,
        missing,
        rendered_prompt_context: rendered,
    })
}

/// The reference grammar: a bare core-document name, `memory` for the standard
/// bundle, or `note/`, `handoff/`, `task/` with an id, slug or title.
fn resolve_one(inner: &Inner, reference: &str) -> Vec<String> {
    let lower = reference.to_ascii_lowercase();
    let by_type = |t: &str| inner.graph.by_type(t).map(|n| n.id.clone());

    match lower.as_str() {
        "project" | "state" | "architecture" | "decisions" | "learnings" | "tasks"
        | "handoffs" => return by_type(&lower).into_iter().collect(),
        // The "just catch me up" bundle.
        "memory" => {
            return ["project", "state", "handoffs"]
                .iter()
                .filter_map(|t| by_type(t))
                .collect()
        }
        _ => {}
    }

    let (kind, _rest) = lower.split_once('/').unwrap_or(("note", lower.as_str()));
    let rest_raw = reference
        .split_once('/')
        .map(|(_, r)| r)
        .unwrap_or(reference);
    match kind {
        "handoff" | "task" => {
            // Structured records are not notes; they resolve through the
            // documents that carry them.
            let doc = if kind == "handoff" { "handoffs" } else { "tasks" };
            by_type(doc).into_iter().collect()
        }
        _ => {
            if inner.graph.note(rest_raw).is_some() {
                return vec![rest_raw.to_string()];
            }
            inner.graph.resolve_title(rest_raw).into_iter().collect()
        }
    }
}

/// Cut a document to fit, preferring a heading boundary so the tail is never a
/// half-sentence.
fn fit_to_budget(content: &str, budget_tokens: i64) -> (String, bool) {
    let max_bytes = (budget_tokens * BYTES_PER_TOKEN).max(0) as usize;
    if content.len() <= max_bytes {
        return (content.to_string(), false);
    }
    let marker = "\n\n[truncated]\n";
    let room = max_bytes.saturating_sub(marker.len());
    if room == 0 {
        return (marker.trim_start().to_string(), true);
    }

    let mut cut = 0usize;
    let mut last_line = 0usize;
    for (idx, line) in content.split_inclusive('\n').enumerate() {
        let _ = idx;
        let end = last_line + line.len();
        if end > room {
            break;
        }
        if line.trim_start().starts_with('#') && last_line > 0 {
            cut = last_line;
        }
        last_line = end;
    }
    // No heading fit — fall back to the last whole line.
    if cut == 0 {
        cut = last_line;
    }
    let mut out = content[..cut].trim_end().to_string();
    out.push_str(marker);
    (out, true)
}

fn render_context(project_key: &str, revision: i64, sources: &[ContextSource]) -> String {
    if sources.is_empty() {
        return String::new();
    }
    let project = project_key.rsplit('/').find(|s| !s.is_empty()).unwrap_or(project_key);
    let mut out = format!(
        "--- project memory ({project}, knowledge revision {revision}) ---\n\n"
    );
    for source in sources {
        out.push_str(&format!(
            "### {} — rev {}\n\n{}\n\n",
            source.file_path,
            source.revision,
            source.content.trim()
        ));
    }
    out.push_str("--- end project memory ---\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::testutil::fixture;

    #[test]
    fn fts_expression_is_always_valid() {
        assert_eq!(fts_expression("auth design").as_deref(), Some("\"auth\" \"design\"*"));
        // Operators and punctuation are searched for, never interpreted. The
        // trailing `*` is stripped as punctuation and the one-character last
        // token gets no prefix star (FTS5 rejects a bare one).
        assert_eq!(fts_expression("a AND b*").as_deref(), Some("\"a\" \"AND\" \"b\""));
        assert_eq!(fts_expression("NEAR(a b)").as_deref(), Some("\"NEAR\" \"a\" \"b\""));
        assert_eq!(fts_expression("   ").as_deref(), None);
        assert_eq!(fts_expression("\"quoted\"").as_deref(), Some("\"quoted\"*"));
        // A single character gets no prefix star (FTS5 rejects a bare one).
        assert_eq!(fts_expression("x").as_deref(), Some("\"x\""));
    }

    #[test]
    fn fts_is_incremental_and_snippets_contain_the_term() {
        let mut f = fixture();
        let note = f.note("Auth Design", "# Auth Design\n\nWe use rotating refresh tokens.\n");
        f.note("Unrelated", "# Unrelated\n\nnothing to see\n");

        let hits = search(&f.inner.conn, "refresh", 10).expect("search");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, note.id);
        assert!(hits[0].snippet.contains("refresh"), "snippet: {}", hits[0].snippet);

        // An update is reflected without any rebuild — the triggers did it.
        f.update(&note.id, 1, "# Auth Design\n\nWe switched to opaque tokens.\n");
        assert!(search(&f.inner.conn, "refresh", 10).unwrap().is_empty());
        assert_eq!(search(&f.inner.conn, "opaque", 10).unwrap().len(), 1);

        // Archived notes drop out of results.
        crate::knowledge::store::archive_note(&mut f.inner, &note.id, &Actor::user(), true)
            .expect("archive");
        assert!(search(&f.inner.conn, "opaque", 10).unwrap().is_empty());

        // And a full rebuild produces the same answer.
        fts_rebuild(&f.inner.conn).expect("rebuild");
        assert!(search(&f.inner.conn, "opaque", 10).unwrap().is_empty());
    }

    #[test]
    fn search_matches_titles_and_prefixes() {
        let mut f = fixture();
        f.note("Authentication", "# Authentication\n\nbody\n");
        assert_eq!(search(&f.inner.conn, "auth", 10).unwrap().len(), 1);
        assert!(search(&f.inner.conn, "zzz", 10).unwrap().is_empty());
        assert!(search(&f.inner.conn, "", 10).unwrap().is_empty());
    }

    #[test]
    fn refs_resolve_core_docs_notes_and_the_memory_bundle() {
        let mut f = fixture();
        store::scaffold(&mut f.inner).expect("scaffold");
        let note = f.note("Auth Design", "# Auth Design\n\ndetails\n");

        let pkg = resolve_refs(
            &mut f.inner,
            &["state".into(), "note/auth-design".into(), "@nope/x".into()],
            DEFAULT_BUDGET_TOKENS,
            false,
            &Actor::user(),
        )
        .expect("resolve");
        assert_eq!(pkg.sources.len(), 2);
        assert_eq!(pkg.sources[0].file_path, "STATE.md");
        assert_eq!(pkg.sources[1].entity_id, note.id);
        assert!(pkg.sources[1].revision >= 1);
        assert_eq!(pkg.missing, vec!["@nope/x".to_string()]);
        assert!(pkg.rendered_prompt_context.contains("STATE.md"));
        assert!(pkg.rendered_prompt_context.contains("details"));

        // The bundle form.
        let bundle = resolve_refs(
            &mut f.inner,
            &["memory".into()],
            DEFAULT_BUDGET_TOKENS,
            false,
            &Actor::user(),
        )
        .unwrap();
        assert_eq!(bundle.sources.len(), 3);

        // Duplicates collapse; titles work as well as slugs.
        let dupes = resolve_refs(
            &mut f.inner,
            &["note/Auth Design".into(), "note/auth-design".into()],
            DEFAULT_BUDGET_TOKENS,
            false,
            &Actor::user(),
        )
        .unwrap();
        assert_eq!(dupes.sources.len(), 1);
    }

    #[test]
    fn preview_leaves_no_event_but_a_send_does() {
        let mut f = fixture();
        store::scaffold(&mut f.inner).expect("scaffold");
        let before = store::latest_seq(&f.inner.conn);

        resolve_refs(&mut f.inner, &["state".into()], 0, false, &Actor::user()).unwrap();
        assert_eq!(store::latest_seq(&f.inner.conn), before, "preview must be silent");

        resolve_refs(&mut f.inner, &["state".into()], 0, true, &Actor::user()).unwrap();
        let (events, _) = store::recent_events(&f.inner.conn, Some(before), 10).unwrap();
        let resolved = events
            .iter()
            .find(|e| e.event_type == store::EV_CONTEXT_RESOLVED)
            .expect("context.resolved recorded");
        assert!(resolved.summary.contains("STATE.md@"), "{}", resolved.summary);
    }

    #[test]
    fn budget_truncates_at_a_heading_boundary() {
        let mut f = fixture();
        let body = format!(
            "# Big\n\n{}\n\n## Second\n\n{}\n\n## Third\n\n{}\n",
            "a".repeat(300),
            "b".repeat(300),
            "c".repeat(300)
        );
        f.note("Big", &body);

        let pkg = resolve_refs(
            &mut f.inner,
            &["note/big".into()],
            150, // 600 bytes — the third section cannot fit
            false,
            &Actor::user(),
        )
        .expect("resolve");
        let source = &pkg.sources[0];
        assert!(source.truncated);
        assert!(source.content.contains("[truncated]"));
        assert!(source.content.contains("## Second") || source.content.contains("# Big"));
        assert!(!source.content.contains("ccc"), "third section must be cut");
        assert!(source.token_estimate <= 150);
        assert_eq!(pkg.token_estimate, source.token_estimate);
    }

    #[test]
    fn token_estimate_rounds_up() {
        assert_eq!(token_estimate(""), 0);
        assert_eq!(token_estimate("a"), 1);
        assert_eq!(token_estimate("abcd"), 1);
        assert_eq!(token_estimate("abcde"), 2);
    }

    #[test]
    fn empty_refs_produce_an_empty_package() {
        let mut f = fixture();
        let pkg = resolve_refs(&mut f.inner, &[], 0, true, &Actor::user()).unwrap();
        assert!(pkg.sources.is_empty());
        assert!(pkg.rendered_prompt_context.is_empty());
        assert_eq!(pkg.token_estimate, 0);
    }
}
