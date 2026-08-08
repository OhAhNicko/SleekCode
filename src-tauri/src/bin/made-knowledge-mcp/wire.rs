//! The NDJSON dialect this adapter speaks to MADE's knowledge service.
//!
//! **`src-tauri/src/knowledge/ipc.rs` is the authority.** These structs are a
//! deliberate MIRROR of the frames that file writes and reads, duplicated
//! rather than shared because the adapter is a standalone binary: linking
//! `made_lib` to reach four serde structs would drag tauri, wgpu and WebView2
//! into a process whose entire job is to relay JSON between a stdin pipe and a
//! loopback socket.
//!
//! Duplication earns a drift alarm, which is what the fixture test at the
//! bottom of this file is. The fixtures are the literal frames `ipc.rs`
//! emits — copied from its `handshake()` and `handle_request()` replies — so a
//! rename on either side fails a test here instead of silently producing a
//! server that connects and then answers nothing.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Protocol version carried in `hello`. Bump only alongside `ipc.rs`.
pub const WIRE_VERSION: u32 = 1;

/// Mirrors `ipc::MAX_FRAME_BYTES`. A peer that never sends a newline must not
/// be able to make either side allocate without bound.
pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

/// The first frame on every socket, and the only one that carries the token.
///
/// `cwd` and `projectRootGuess` are both sent on purpose: the guess is this
/// process's ancestor walk to a `.project-memory` directory, and the raw cwd is
/// the fallback. Neither is trusted — the service resolves the project itself
/// and answers `unknown-project` if it disagrees.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    /// Always `"hello"`. `ipc::handshake` drops any socket whose first frame
    /// says otherwise, before a method can be reached.
    pub kind: String,
    pub v: u32,
    pub token: String,
    /// `claude` | `codex` | `gemini` | `unknown` — from `--agent`, which each
    /// CLI's own MCP registration bakes in. A model cannot reach it.
    pub agent: String,
    pub pid: u32,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_root_guess: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    pub adapter_version: String,
}

impl Hello {
    pub fn new(
        token: String,
        agent: &str,
        cwd: String,
        project_root_guess: Option<String>,
        pane_id: Option<String>,
    ) -> Self {
        Self {
            kind: "hello".into(),
            v: WIRE_VERSION,
            token,
            agent: agent.to_string(),
            pid: std::process::id(),
            cwd,
            project_root_guess,
            pane_id,
            adapter_version: env!("CARGO_PKG_VERSION").to_string(),
        }
    }
}

/// The service's answer to `hello`, discriminated by its `kind`.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum HelloReply {
    HelloOk(HelloOk),
    HelloErr(HelloErr),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloOk {
    pub project_key: String,
    pub project_root: String,
    /// `rw` when this MADE instance owns the project's writer lock, `ro` when
    /// it is following another instance. The endpoint probe prefers `rw`.
    pub mode: String,
    /// Joined server-side from MADE's pane registry — the adapter never sends
    /// one, because a session id it could supply is a session id a model could
    /// forge.
    #[serde(default)]
    pub session_id: Option<String>,
    /// `read-only` | `ask` | `trusted`, for diagnostics only. The service is
    /// the single enforcement point; nothing here branches on it.
    #[serde(default)]
    pub write_policy: String,
}

impl HelloOk {
    pub fn writable(&self) -> bool {
        self.mode == MODE_RW
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HelloErr {
    pub code: String,
}

pub const MODE_RW: &str = "rw";

// ---------------------------------------------------------------------------
// Requests and responses
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WireRequest {
    pub id: u64,
    pub method: String,
    pub params: Value,
}

/// Anything the service sends after the handshake.
///
/// `id` is optional because the wire allows unsolicited server pushes (a
/// `{"kind":"changed"}` frame). Those carry no id, and the reader drops them
/// rather than treating a missing id as a malformed reply.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct WireResponse {
    #[serde(default)]
    pub id: Option<u64>,
    /// `{"ok": null}` is a REAL ANSWER (get_latest_handoff with no handoffs),
    /// distinct from a reply with no `ok` at all. Plain `Option<Value>` folded
    /// both into `None`, which turned the designed "nothing yet" answer into
    /// an "empty reply" protocol error — found live by an agent in runtime
    /// step 9 (2026-08-08). Present-but-null deserializes as `Some(Null)`.
    #[serde(default, deserialize_with = "some_even_if_null")]
    pub ok: Option<Value>,
    #[serde(default)]
    pub err: Option<WireErr>,
    #[serde(default)]
    pub kind: Option<String>,
}

fn some_even_if_null<'de, D>(d: D) -> Result<Option<Value>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Value::deserialize(d).map(Some)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WireErr {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/* --- error codes, exactly as ipc.rs spells them ------------------------- */

pub const ERR_CONFLICT: &str = "conflict";
pub const ERR_DENIED: &str = "denied";
pub const ERR_READ_ONLY: &str = "read-only";
pub const ERR_NOT_FOUND: &str = "not-found";
/// A call the service refused as malformed — a required field omitted, most
/// importantly `baseRevision` on a write. The adapter rejects these against the
/// tool's own schema before they are ever sent, so this arm is the backstop for
/// a rule the service enforces and the schema does not yet state.
pub const ERR_INVALID_PARAMS: &str = "invalid-params";
pub const ERR_UNKNOWN_PROJECT: &str = "unknown-project";
pub const ERR_BAD_TOKEN: &str = "bad-token";
pub const ERR_INTERNAL: &str = "internal";

/* --- methods, exactly as ipc::dispatch matches them --------------------- */

/// Part of the mirrored vocabulary rather than of any code path: the adapter
/// verifies liveness with the handshake instead. Kept because a method table
/// missing an entry is how the next reader concludes the service has no such
/// method.
#[allow(dead_code)]
pub const M_PING: &str = "ping";
pub const M_SESSION_INFO: &str = "session-info";
pub const M_SEARCH: &str = "search";
pub const M_GET_CONTEXT: &str = "get_context";
pub const M_GET_NOTE: &str = "get_note";
pub const M_GET_DOC: &str = "get_doc";
pub const M_LIST_NOTE_SUMMARIES: &str = "list_note_summaries";
pub const M_LIST_RECENT_CHANGES: &str = "list_recent_changes";
pub const M_GET_LATEST_HANDOFF: &str = "get_latest_handoff";
pub const M_LIST_TASKS: &str = "list_tasks";
pub const M_CREATE_NOTE: &str = "create_note";
pub const M_UPDATE_NOTE: &str = "update_note";
pub const M_UPDATE_STATE: &str = "update_state";
pub const M_ADD_DECISION: &str = "add_decision";
pub const M_ADD_LEARNING: &str = "add_learning";
pub const M_CREATE_HANDOFF: &str = "create_handoff";
pub const M_CREATE_TASK: &str = "create_task";
pub const M_UPDATE_TASK: &str = "update_task";
pub const M_LINK_ENTITIES: &str = "link_entities";

/// The methods `ipc::WRITE_METHODS` gates behind the write policy. Kept here so
/// the audit line can say whether a call was a write without a second table.
pub const WRITE_METHODS: &[&str] = &[
    M_CREATE_NOTE,
    M_UPDATE_NOTE,
    M_UPDATE_STATE,
    M_ADD_DECISION,
    M_ADD_LEARNING,
    M_CREATE_HANDOFF,
    M_CREATE_TASK,
    M_UPDATE_TASK,
    M_LINK_ENTITIES,
];

pub fn is_write_method(method: &str) -> bool {
    WRITE_METHODS.contains(&method)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /* --- fixtures: the literal frames knowledge/ipc.rs writes ------------ */

    /// From `ipc::handshake` — the success reply, including the `sessionId:
    /// null` an unknown pane produces.
    const FIXTURE_HELLO_OK: &str = r#"{"kind":"hello-ok","projectKey":"c:/code/alpha","projectRoot":"C:\\code\\alpha","mode":"rw","sessionId":null,"writePolicy":"ask"}"#;

    /// From `ipc::handshake`'s `reply_err`.
    const FIXTURE_HELLO_ERR: &str = r#"{"kind":"hello-err","code":"unknown-project"}"#;

    /// From `ipc::handle_request`'s `reply` — the ok arm.
    const FIXTURE_OK: &str = r#"{"id":7,"ok":{"status":"ok","id":"kn_abc","revision":2}}"#;

    /// The conflict arm, carrying `CommitResult` in `data` so a caller can
    /// rebase without a second round trip (`ipc::commit_reply`).
    ///
    /// `r##` because the markdown body starts with `"# `, and `"#` would close
    /// a single-hash raw string mid-fixture.
    const FIXTURE_CONFLICT: &str = r##"{"id":8,"err":{"code":"conflict","message":"this note changed since the revision you edited","data":{"status":"conflict","id":"kn_abc","revision":1,"conflict":{"currentRevision":2,"currentContent":"# Doc\n\nmine\n"}}}}"##;

    /// The service refusing a write that omitted a required field.
    ///
    /// This code replaced `internal` for required-field rejections once
    /// `update_state` stopped defaulting a missing `baseRevision` to the
    /// current head — a default that turned the optimistic check into a
    /// comparison of the head against itself, so an omitted field committed
    /// last-writer-wins over STATE.md and reported "ok".
    ///
    /// Carries no `data`: there is nothing to rebase onto, because nothing was
    /// read. The message names the field, and the adapter turns it into an
    /// instruction to go and read one.
    const FIXTURE_INVALID_PARAMS: &str = r#"{"id":9,"err":{"code":"invalid-params","message":"'baseRevision' is required — read the document first and pass its revision"}}"#;

    /// A server push. No id, and it must not be mistaken for a reply.
    const FIXTURE_PUSH: &str = r#"{"kind":"changed"}"#;

    #[test]
    fn hello_serializes_the_keys_ipc_handshake_reads() {
        // `ipc::handshake` reads exactly these keys off the frame. A rename on
        // either side means every CLI connects and is then refused, with no
        // error either party can explain — so pin the names, not just the type.
        let hello = Hello::new(
            "t0ken".into(),
            "claude",
            "C:\\code\\alpha\\sub".into(),
            Some("C:\\code\\alpha".into()),
            Some("term-3".into()),
        );
        let v = serde_json::to_value(&hello).expect("serialize");
        assert_eq!(v["kind"], "hello");
        assert_eq!(v["v"], WIRE_VERSION);
        assert_eq!(v["token"], "t0ken");
        assert_eq!(v["agent"], "claude");
        assert_eq!(v["cwd"], "C:\\code\\alpha\\sub");
        assert_eq!(v["projectRootGuess"], "C:\\code\\alpha");
        assert_eq!(v["paneId"], "term-3");
        assert!(v["pid"].as_u64().is_some());
        assert!(v["adapterVersion"].as_str().is_some());

        // Absent optionals are omitted, not sent as null: `ipc::handshake`
        // filters `paneId` on non-empty, and a null there is one more shape it
        // would have to tolerate.
        let bare = Hello::new("t".into(), "unknown", "/home/u".into(), None, None);
        let v = serde_json::to_value(&bare).expect("serialize");
        assert!(v.get("paneId").is_none());
        assert!(v.get("projectRootGuess").is_none());
    }

    #[test]
    fn the_services_hello_replies_parse() {
        match serde_json::from_str::<HelloReply>(FIXTURE_HELLO_OK).expect("hello-ok") {
            HelloReply::HelloOk(ok) => {
                assert_eq!(ok.project_key, "c:/code/alpha");
                assert_eq!(ok.project_root, "C:\\code\\alpha");
                assert!(ok.writable(), "mode rw must read as writable");
                assert_eq!(ok.session_id, None, "an explicit null is not an error");
                assert_eq!(ok.write_policy, "ask");
            }
            other => panic!("expected hello-ok, got {other:?}"),
        }

        match serde_json::from_str::<HelloReply>(FIXTURE_HELLO_ERR).expect("hello-err") {
            HelloReply::HelloErr(e) => assert_eq!(e.code, ERR_UNKNOWN_PROJECT),
            other => panic!("expected hello-err, got {other:?}"),
        }

        // A read-only follower instance is a valid answer, not a failure.
        let ro = FIXTURE_HELLO_OK.replace(r#""mode":"rw""#, r#""mode":"ro""#);
        match serde_json::from_str::<HelloReply>(&ro).expect("ro") {
            HelloReply::HelloOk(ok) => assert!(!ok.writable()),
            other => panic!("expected hello-ok, got {other:?}"),
        }
    }

    #[test]
    fn responses_split_into_ok_err_and_push() {
        let ok: WireResponse = serde_json::from_str(FIXTURE_OK).expect("ok frame");
        assert_eq!(ok.id, Some(7));
        assert_eq!(ok.ok.expect("ok payload")["status"], "ok");
        assert!(ok.err.is_none());

        // `{"ok": null}` is an ANSWER (no handoffs yet), not a malformed
        // frame: it must arrive as Some(Null), never fold into None — folding
        // it turned the designed answer into an "empty reply" error at
        // runtime (2026-08-08).
        let null_ok: WireResponse =
            serde_json::from_str(r#"{"id": 9, "ok": null}"#).expect("null-ok frame");
        assert_eq!(null_ok.ok, Some(serde_json::Value::Null));
        // A frame with NO ok at all still reads as absent.
        let bare: WireResponse = serde_json::from_str(r#"{"id": 10}"#).expect("bare frame");
        assert!(bare.ok.is_none());

        let conflict: WireResponse = serde_json::from_str(FIXTURE_CONFLICT).expect("err frame");
        assert_eq!(conflict.id, Some(8));
        let err = conflict.err.expect("err payload");
        assert_eq!(err.code, ERR_CONFLICT);
        // The rebase data is the whole reason a conflict is not just a message.
        let data = err.data.expect("conflict data");
        assert_eq!(data["conflict"]["currentRevision"], 2);
        assert!(data["conflict"]["currentContent"]
            .as_str()
            .expect("currentContent")
            .contains("mine"));

        let push: WireResponse = serde_json::from_str(FIXTURE_PUSH).expect("push frame");
        assert_eq!(push.id, None, "a push must never look like a reply");
        assert_eq!(push.kind.as_deref(), Some("changed"));
    }

    /// `invalid-params` is a distinct code, not a flavour of `internal`.
    ///
    /// The difference is what the caller is told to do. `internal` says the
    /// service broke; this says the CALL was wrong and names the field to fix —
    /// which is the only version a model can act on. Both sides have to spell
    /// the code identically or the adapter falls through to the generic arm and
    /// the model gets a bare message with no instruction to re-read anything.
    #[test]
    fn a_refused_call_arrives_as_invalid_params_and_names_its_field() {
        let refused: WireResponse =
            serde_json::from_str(FIXTURE_INVALID_PARAMS).expect("invalid-params frame");
        assert_eq!(refused.id, Some(9));
        assert!(refused.ok.is_none(), "nothing was written");
        let err = refused.err.expect("err payload");
        assert_eq!(err.code, ERR_INVALID_PARAMS);
        assert!(err.message.contains("baseRevision"), "{}", err.message);
        // No rebase data, and correctly so: nothing was read, so there is no
        // revision to rebase onto — only a field to supply.
        assert!(err.data.is_none());

        // It must not be mistaken for the conflict path, which IS recoverable
        // by rebasing and carries the data to do it with.
        let conflict: WireResponse = serde_json::from_str(FIXTURE_CONFLICT).unwrap();
        assert_ne!(conflict.err.unwrap().code, ERR_INVALID_PARAMS);
    }

    #[test]
    fn requests_round_trip_in_the_shape_dispatch_expects() {
        let req = WireRequest {
            id: 12,
            method: M_UPDATE_NOTE.into(),
            params: json!({ "id": "kn_a", "baseRevision": 3, "content": "# A\n" }),
        };
        let text = serde_json::to_string(&req).expect("serialize");
        // `ipc::handle_request` reads `id`, `method` and `params` off the top
        // level — no envelope, no nesting.
        let back: WireRequest = serde_json::from_str(&text).expect("round trip");
        assert_eq!(back, req);
        assert!(!text.contains('\n'), "a frame must fit on one NDJSON line");
    }

    #[test]
    fn the_write_method_list_matches_the_services_policy_gate() {
        // `ipc::WRITE_METHODS` is what the ask-policy prompt keys off. This
        // list only drives the audit line, but a divergence would mean the
        // adapter's logs disagree with what the user was actually asked about.
        for method in [
            M_CREATE_NOTE,
            M_UPDATE_NOTE,
            M_UPDATE_STATE,
            M_ADD_DECISION,
            M_ADD_LEARNING,
            M_CREATE_HANDOFF,
            M_CREATE_TASK,
            M_UPDATE_TASK,
            M_LINK_ENTITIES,
        ] {
            assert!(is_write_method(method), "{method} must count as a write");
        }
        for method in [M_SEARCH, M_GET_NOTE, M_GET_DOC, M_GET_CONTEXT, M_LIST_TASKS] {
            assert!(!is_write_method(method), "{method} must not");
        }
    }
}
