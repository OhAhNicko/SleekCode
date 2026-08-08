//! What this adapter claims to be, and what it refuses to pass on.
//!
//! Trusted identity has exactly three sources, none of which a model can reach:
//! `--agent` (baked into each CLI's own MCP registration), the process's own
//! working directory, and the inherited `MADE_PANE_ID`. Everything else is
//! joined server-side.
//!
//! `params` is the one part of a tool call a model fully controls, so anything
//! identity-shaped in it is stripped here before the frame is sent. The service
//! ignores those keys anyway (`ipc::dispatch` builds the actor from the
//! connection); this is the second lock on the same door, and it also keeps the
//! stderr audit line honest about what was actually asked for.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

/// The directory whose presence marks a project as knowledge-enabled. Mirrors
/// `knowledge::projector::MEMORY_DIR`, including its per-build split: a debug
/// adapter walks for the dev world's folder and can never adopt a live
/// project (live/dev isolation, 2026-08-07).
#[cfg(debug_assertions)]
pub const MEMORY_DIR: &str = ".project-memory-dev";
#[cfg(not(debug_assertions))]
pub const MEMORY_DIR: &str = ".project-memory";

/// Environment variable carrying the MADE pane this CLI was launched in.
///
/// On the WSL→Windows path this arrives via `WSLENV=MADE_PANE_ID/w`, which
/// MADE's own process environment declares at startup so every descendant
/// inherits it. When it is missing, attribution degrades to agent-kind only —
/// never to a failure.
pub const PANE_ENV: &str = "MADE_PANE_ID";

/// The CLI names `--agent` accepts. Anything else becomes `unknown`, which the
/// service still serves — it just cannot colour the attribution dot.
pub const AGENT_KINDS: &[&str] = &["claude", "codex", "gemini"];
pub const AGENT_UNKNOWN: &str = "unknown";

/// Identity-shaped keys removed from every tool argument object.
///
/// The list is deliberately the union of what the service's payload types would
/// accept if it trusted them: a project, a pane, a session, a CLI kind, and the
/// actor record itself.
const FORGED_KEYS: &[&str] = &[
    "projectId",
    "projectKey",
    "paneId",
    "agentKind",
    "sessionId",
    "actor",
];

pub fn normalize_agent(raw: &str) -> String {
    let lower = raw.trim().to_ascii_lowercase();
    if AGENT_KINDS.contains(&lower.as_str()) {
        lower
    } else {
        AGENT_UNKNOWN.to_string()
    }
}

/// Keep only `[A-Za-z0-9_-]` and cap the length.
///
/// The pane id is inherited from the environment and reaches a SQL parameter
/// and a log line. It is MADE's own value in every real launch, but "in every
/// real launch" is not a boundary — a shell profile can set anything.
pub fn sanitize_pane_id(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .trim()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .take(64)
        .collect();
    (!cleaned.is_empty()).then_some(cleaned)
}

/// Walk up from `start` looking for a `.project-memory` directory.
///
/// Only a GUESS: it is sent alongside the raw cwd and the service re-resolves
/// both against the projects it actually has open. A CLI started in a
/// subdirectory of a project is the normal case this exists for.
pub fn find_project_root(start: &Path) -> Option<PathBuf> {
    let mut dir = start.to_path_buf();
    for _ in 0..64 {
        if dir.join(MEMORY_DIR).is_dir() {
            return Some(dir);
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

/// Remove identity-shaped keys from a tool argument object, returning the names
/// that were dropped so the audit line can record the attempt.
pub fn strip_forged_identity(args: &mut Map<String, Value>) -> Vec<&'static str> {
    let mut dropped = Vec::new();
    for key in FORGED_KEYS {
        if args.remove(*key).is_some() {
            dropped.push(*key);
        }
    }
    dropped
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_the_three_known_clis_are_agent_kinds() {
        assert_eq!(normalize_agent("claude"), "claude");
        assert_eq!(normalize_agent("  CODEX "), "codex");
        assert_eq!(normalize_agent("Gemini"), "gemini");
        // An unrecognised value must not be echoed back as if it were real —
        // "unknown" is a state the service and the UI both handle.
        assert_eq!(normalize_agent("user"), AGENT_UNKNOWN);
        assert_eq!(normalize_agent(""), AGENT_UNKNOWN);
        assert_eq!(normalize_agent("claude; rm -rf ~"), AGENT_UNKNOWN);
    }

    #[test]
    fn pane_ids_are_reduced_to_a_safe_alphabet() {
        assert_eq!(sanitize_pane_id("term-42").as_deref(), Some("term-42"));
        assert_eq!(sanitize_pane_id("pane_7").as_deref(), Some("pane_7"));
        assert_eq!(sanitize_pane_id("a'; DROP TABLE").as_deref(), Some("aDROPTABLE"));
        assert_eq!(sanitize_pane_id("   "), None);
        assert_eq!(sanitize_pane_id("!!!"), None);
        assert_eq!(sanitize_pane_id(&"x".repeat(500)).map(|s| s.len()), Some(64));
    }

    #[test]
    fn identity_keys_never_survive_into_a_frame() {
        let mut args = json!({
            "title": "Real argument",
            "content": "# Real\n",
            "projectId": "someone-elses-project",
            "projectKey": "c:/other",
            "paneId": "term-999",
            "agentKind": "claude",
            "sessionId": "borrowed-session",
            "actor": { "kind": "user" },
        })
        .as_object()
        .cloned()
        .expect("object");

        let dropped = strip_forged_identity(&mut args);
        assert_eq!(dropped.len(), FORGED_KEYS.len(), "dropped: {dropped:?}");
        for key in FORGED_KEYS {
            assert!(!args.contains_key(*key), "{key} survived");
        }
        // The real arguments must be untouched — stripping is a filter, not a
        // rewrite.
        assert_eq!(args["title"], "Real argument");
        assert_eq!(args.len(), 2);

        // Nothing to strip is the common case and costs no allocation churn.
        let mut clean = json!({ "id": "kn_a" }).as_object().cloned().unwrap();
        assert!(strip_forged_identity(&mut clean).is_empty());
        assert_eq!(clean.len(), 1);
    }

    #[test]
    fn the_project_root_walk_finds_an_ancestor_and_gives_up_cleanly() {
        let base = std::env::temp_dir().join(format!("made-mcp-identity-{}", std::process::id()));
        let deep = base.join("a").join("b").join("c");
        std::fs::create_dir_all(&deep).expect("mkdir");
        std::fs::create_dir_all(base.join(MEMORY_DIR)).expect("mkdir memory");

        assert_eq!(find_project_root(&deep).as_deref(), Some(base.as_path()));
        assert_eq!(find_project_root(&base).as_deref(), Some(base.as_path()));

        let _ = std::fs::remove_dir_all(base.join(MEMORY_DIR));
        assert_eq!(find_project_root(&deep), None, "no marker, no guess");

        let _ = std::fs::remove_dir_all(&base);
    }
}
