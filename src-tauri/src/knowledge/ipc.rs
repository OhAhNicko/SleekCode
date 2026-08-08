//! Loopback NDJSON server for the MCP adapters.
//!
//! Each CLI launches `made-knowledge-mcp` over stdio; that adapter holds no
//! durable state and forwards everything here. The transport is a TCP socket on
//! `127.0.0.1:0` (preview_proxy's shape) because a WSL-launched adapter runs as
//! a WINDOWS process, and Windows loopback is reachable from WSL2 under both
//! NAT and mirrored networking where a named pipe is not.
//!
//! Two security properties this file is responsible for:
//!
//! 1. **Identity is constructed here, never accepted from the caller.** The
//!    agent kind comes from the `--agent` flag baked into the CLI's own MCP
//!    registration, the project from an ancestor walk of the adapter's cwd
//!    validated against actually-open projects, and the session from MADE's own
//!    pane registry. Anything identity-shaped in `params` is ignored, because
//!    `params` is the one part of a tool call a model fully controls.
//!
//! 2. **A hello with a valid token must be the FIRST frame, within 3 seconds.**
//!    Any local web page can open a socket to a loopback port; requiring an
//!    authenticated first frame means a cross-protocol POST gets dropped before
//!    it can reach a method.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, watch};

use crate::debug_log::dlog;

use super::model::*;
use super::projector;
use super::search;
use super::store::{self, CreateNoteInput, UpdateNoteInput};
use super::{ProjectKnowledge};

/// One frame may not exceed this. Note bodies are the large payloads and they
/// are documents, not blobs.
const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
/// What an UNAUTHENTICATED peer is allowed to buffer. A hello is a few hundred
/// bytes; nothing legitimate comes close to this before the token is checked.
const PRE_AUTH_FRAME_BYTES: usize = 16 * 1024;
/// Live connections, total. The adapter opens one socket per CLI pane, so this
/// is far above any real workload and exists purely so a local process cannot
/// spawn sockets — and their per-socket buffers and tasks — without limit.
const MAX_LIVE_CONNECTIONS: usize = 64;
/// How long an unauthenticated socket may stay open.
const HANDSHAKE_SECS: u64 = 3;
/// How long an agent write waits for the user under the `ask` policy before it
/// is denied. Deterministic denial matters more than patience: a write that
/// commits after the caller gave up is worse than one that never happened.
const APPROVAL_TIMEOUT_SECS: u64 = 90;
/// Endpoint files older than this were left by instances that are long gone.
const ENDPOINT_MAX_AGE_SECS: u64 = 7 * 24 * 3600;

pub const APPROVAL_EVENT: &str = "made:knowledge-approval";

pub struct IpcInfo {
    pub port: u16,
    pub token: String,
}

static INFO: OnceLock<IpcInfo> = OnceLock::new();
static NEXT_CONN_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
struct ConnInfo {
    agent_kind: String,
    project_key: String,
    pane_id: Option<String>,
    /// Joined from MADE's own pane registry at hello. NEVER set from the wire —
    /// see the `session-info` handler.
    session_id: Option<String>,
    mode: String,
    connected_at: i64,
    last_seen_at: i64,
    call_count: i64,
    pid: i64,
    /// Self-reported by the MCP client, for the diagnostics list only. Untrusted
    /// and never used for attribution or authorization.
    client_name: Option<String>,
    client_version: Option<String>,
}

fn connections() -> &'static Mutex<HashMap<u64, ConnInfo>> {
    static CONNECTIONS: OnceLock<Mutex<HashMap<u64, ConnInfo>>> = OnceLock::new();
    CONNECTIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

struct PendingApproval {
    tx: oneshot::Sender<String>,
    project_key: String,
}

fn approvals() -> &'static Mutex<HashMap<String, PendingApproval>> {
    static APPROVALS: OnceLock<Mutex<HashMap<String, PendingApproval>>> = OnceLock::new();
    APPROVALS.get_or_init(|| Mutex::new(HashMap::new()))
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

pub fn start(dir: &Path) -> Result<&'static IpcInfo, String> {
    if let Some(info) = INFO.get() {
        return Ok(info);
    }
    // Bind synchronously so the port is known before we return, exactly as
    // preview_proxy does.
    let std_listener =
        std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| format!("bind failed: {e}"))?;
    let port = std_listener
        .local_addr()
        .map_err(|e| format!("local_addr: {e}"))?
        .port();
    std_listener
        .set_nonblocking(true)
        .map_err(|e| format!("nonblocking: {e}"))?;

    // 244 bits from two v4 uuids — no rand dependency, and far past guessing.
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    write_endpoint_files(dir, port, &token)?;

    let handle = super::runtime_handle().ok_or("knowledge runtime is not running")?;
    handle.spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(std_listener) {
            Ok(l) => l,
            Err(e) => {
                dlog(&format!("[knowledge] ipc listener: {e}"));
                return;
            }
        };
        // Bounds how many sockets — and therefore how many read buffers and
        // tasks — can exist at once, including sockets that never authenticate.
        let slots = std::sync::Arc::new(tokio::sync::Semaphore::new(MAX_LIVE_CONNECTIONS));
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                continue;
            };
            // try_acquire, never acquire: blocking the accept loop on a full
            // table would stall every future connection behind the flood
            // instead of shedding it.
            let Ok(permit) = slots.clone().try_acquire_owned() else {
                dlog("[knowledge] ipc connection refused: too many live sockets");
                drop(stream);
                continue;
            };
            tokio::spawn(async move {
                serve(stream).await;
                drop(permit);
            });
        }
    });

    let _ = INFO.set(IpcInfo { port, token });
    INFO.get().ok_or_else(|| "ipc info missing".to_string())
}

/// Per-instance discovery file plus the legacy singular one. Per-instance is
/// what makes a dev build running beside production deterministic: the adapter
/// probes every live endpoint and binds to the one that claims write ownership
/// of its project.
fn write_endpoint_files(dir: &Path, port: u16, token: &str) -> Result<(), String> {
    let body = json!({
        "v": 1,
        "port": port,
        "token": token,
        "pid": std::process::id(),
        "appVersion": env!("CARGO_PKG_VERSION"),
        "startedAt": now_ms(),
    });
    let text = serde_json::to_string_pretty(&body).unwrap_or_default();
    let per_instance = dir.join(format!("endpoint-{}.json", std::process::id()));
    projector::atomic_write(&per_instance, text.as_bytes())
        .map_err(|e| format!("write endpoint file: {e}"))?;
    let _ = projector::atomic_write(&dir.join("endpoint.json"), text.as_bytes());
    Ok(())
}

/// Drop discovery files from instances that never got to clean up. Kill -9 is
/// the normal way a MADE process ends here, so this is the only cleanup path
/// that can be relied on.
pub fn sweep_stale_endpoints(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !(name.starts_with("endpoint-") && name.ends_with(".json")) {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .and_then(|m| now.duration_since(m).map_err(std::io::Error::other))
            .map(|age| age.as_secs() > ENDPOINT_MAX_AGE_SECS)
            .unwrap_or(false);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

pub fn connections_snapshot() -> Vec<McpConnectionInfo> {
    let Ok(map) = connections().lock() else {
        return Vec::new();
    };
    let mut out: Vec<McpConnectionInfo> = map
        .iter()
        .map(|(id, c)| McpConnectionInfo {
            id: *id,
            agent_kind: c.agent_kind.clone(),
            project_key: c.project_key.clone(),
            pane_id: c.pane_id.clone(),
            session_id: c.session_id.clone(),
            mode: c.mode.clone(),
            connected_at: c.connected_at,
            last_seen_at: c.last_seen_at,
            call_count: c.call_count,
            pid: c.pid,
            client_name: c.client_name.clone(),
            client_version: c.client_version.clone(),
        })
        .collect();
    out.sort_by_key(|c| c.connected_at);
    out
}

/// A project is closing: forget its connections so the diagnostics list does
/// not show sockets pointing at a store that no longer exists.
pub fn drop_project_connections(project_key: &str) {
    if let Ok(mut map) = connections().lock() {
        map.retain(|_, c| c.project_key != project_key);
    }
    if let Ok(mut pending) = approvals().lock() {
        let ids: Vec<String> = pending
            .iter()
            .filter(|(_, a)| a.project_key == project_key)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if let Some(a) = pending.remove(&id) {
                let _ = a.tx.send("deny".into());
            }
        }
    }
}

/// How many agent writes are waiting on the user under the `ask` policy. Read
/// by `status()` so the sidebar can surface a pending prompt it may have missed.
pub fn pending_approval_count(project_key: &str) -> i64 {
    approvals()
        .lock()
        .map(|m| m.values().filter(|a| a.project_key == project_key).count() as i64)
        .unwrap_or(0)
}

/// Resolve a pending approval. Called by `knowledge_respond_approval`.
pub fn respond_approval(request_id: &str, verdict: &str) -> Result<(), String> {
    let pending = approvals()
        .lock()
        .map_err(|_| "approvals poisoned".to_string())?
        .remove(request_id)
        .ok_or("that approval is no longer waiting")?;
    pending
        .tx
        .send(verdict.to_string())
        .map_err(|_| "the agent stopped waiting".to_string())
}

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------

/// Reads NDJSON frames with a hard size cap, so a peer that never sends a
/// newline cannot make us allocate without bound.
///
/// The cap is per-connection and starts SMALL: an unauthenticated peer only
/// ever needs to send a hello, so until the token checks out it gets
/// `PRE_AUTH_FRAME_BYTES`, not the full 4 MiB a real request body may need.
/// Otherwise a local process could open sockets, push just under 4 MiB with no
/// newline on each, and hold that much resident per socket for the whole
/// handshake window without ever authenticating.
struct Framer {
    stream: tokio::net::tcp::OwnedReadHalf,
    buf: Vec<u8>,
    limit: usize,
}

impl Framer {
    async fn next_line(&mut self) -> Result<Option<String>, String> {
        loop {
            if let Some(idx) = self.buf.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = self.buf.drain(..=idx).collect();
                let text = String::from_utf8_lossy(&line[..line.len() - 1])
                    .trim_end_matches('\r')
                    .to_string();
                return Ok(Some(text));
            }
            if self.buf.len() > self.limit {
                return Err(format!("frame exceeds {} bytes", self.limit));
            }
            let mut chunk = [0u8; 8192];
            let n = self
                .stream
                .read(&mut chunk)
                .await
                .map_err(|e| format!("read: {e}"))?;
            if n == 0 {
                return Ok(None);
            }
            self.buf.extend_from_slice(&chunk[..n]);
        }
    }
}

/// The wire error codes are a CLOSED set, mirrored in the adapter's
/// `wire.rs`: `conflict | denied | read-only | not-found | unknown-project |
/// bad-token | invalid-params | internal`. Adding one means amending the plan's
/// contract and both mirrors together — a code only one side knows is a code the
/// other side handles as an unrecognised failure.
///
/// `invalid-params` is specifically "the caller sent a bad or missing required
/// field, and re-sending it correctly will work". It must never be used for a
/// service-side failure, which is what `internal` is for.
const ERR_INVALID_PARAMS: &str = "invalid-params";

#[derive(Debug, Serialize)]
struct WireErr {
    code: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
}

impl WireErr {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            data: None,
        }
    }
    fn with_data(code: &str, message: impl Into<String>, data: Value) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            data: Some(data),
        }
    }
}

async fn serve(stream: tokio::net::TcpStream) {
    let _ = stream.set_nodelay(true);
    let (read_half, mut write_half) = stream.into_split();
    let mut framer = Framer {
        stream: read_half,
        buf: Vec::new(),
        limit: PRE_AUTH_FRAME_BYTES,
    };

    // One writer task owns the socket's write half, so concurrently handled
    // requests never interleave halfway through a frame.
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        while let Some(line) = out_rx.recv().await {
            if write_half.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if write_half.write_all(b"\n").await.is_err() {
                break;
            }
        }
    });

    // The handshake is the gate. A socket that has not authenticated in three
    // seconds is dropped without ever reaching a method.
    let hello = match tokio::time::timeout(
        Duration::from_secs(HANDSHAKE_SECS),
        framer.next_line(),
    )
    .await
    {
        Ok(Ok(Some(line))) => line,
        _ => return,
    };

    let conn_id = match handshake(&hello, &out_tx) {
        Some(id) => id,
        None => return,
    };
    // Authenticated: real request bodies (a note's full content) need the room.
    framer.limit = MAX_FRAME_BYTES;

    let (closed_tx, closed_rx) = watch::channel(false);
    loop {
        match framer.next_line().await {
            Ok(Some(line)) => {
                let out = out_tx.clone();
                let closed = closed_rx.clone();
                tokio::spawn(async move {
                    if let Some(response) = handle_request(conn_id, &line, closed).await {
                        let _ = out.send(response);
                    }
                });
            }
            Ok(None) => break,
            Err(e) => {
                dlog(&format!("[knowledge] ipc read error: {e}"));
                break;
            }
        }
    }

    let _ = closed_tx.send(true);
    disconnect(conn_id);
}

/// Validate the hello frame and register the connection. Returns None when the
/// socket should be dropped.
fn handshake(line: &str, out: &mpsc::UnboundedSender<String>) -> Option<u64> {
    let reply_err = |code: &str| {
        let _ = out.send(json!({ "kind": "hello-err", "code": code }).to_string());
    };

    let Ok(msg) = serde_json::from_str::<Value>(line) else {
        reply_err("internal");
        return None;
    };
    if msg.get("kind").and_then(|v| v.as_str()) != Some("hello") {
        reply_err("bad-token");
        return None;
    }
    let token = msg.get("token").and_then(|v| v.as_str()).unwrap_or("");
    let expected = INFO.get().map(|i| i.token.as_str()).unwrap_or("");
    if expected.is_empty() || !constant_time_eq(token, expected) {
        reply_err("bad-token");
        return None;
    }

    let mut agent_kind = msg
        .get("agent")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let cwd = msg.get("cwd").and_then(|v| v.as_str()).unwrap_or("");
    let guess = msg.get("projectRootGuess").and_then(|v| v.as_str());
    let pid = msg.get("pid").and_then(|v| v.as_i64()).unwrap_or(0);
    let pane_id = msg
        .get("paneId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let Some(project) = guess
        .and_then(find_open_project)
        .or_else(|| find_open_project(cwd))
    else {
        reply_err("unknown-project");
        return None;
    };

    // The CLI session id is joined here, from MADE's own pane registry — the
    // adapter has no way to know it and must not be trusted with it if it did.
    // A pane only lends its identity when it belongs to THIS project, so an id
    // inherited across a project boundary cannot borrow someone else's session.
    let pane = pane_id
        .as_deref()
        .and_then(super::pane_info)
        .filter(|info| info.project_key.is_empty() || info.project_key == project.key);
    let session_id = pane.as_ref().and_then(|info| info.session_id.clone());
    // `--agent` is baked into each CLI's own MCP registration and is the
    // authoritative answer. The pane registry only fills in when the adapter
    // was launched without it — degrading to a known CLI beats "unknown".
    if agent_kind == "unknown" {
        if let Some(kind) = pane.as_ref().map(|i| i.agent_kind.clone()) {
            if !kind.is_empty() {
                agent_kind = kind;
            }
        }
    }
    let mode = if project.read_only() { "ro" } else { "rw" };
    let policy = project.with_inner(|inner| store::write_policy(&inner.conn));

    let id = NEXT_CONN_ID.fetch_add(1, Ordering::Relaxed);
    let now = now_ms();
    if let Ok(mut map) = connections().lock() {
        map.insert(
            id,
            ConnInfo {
                agent_kind: agent_kind.clone(),
                project_key: project.key.clone(),
                pane_id: pane_id.clone(),
                session_id: session_id.clone(),
                mode: mode.to_string(),
                connected_at: now,
                last_seen_at: now,
                call_count: 0,
                pid,
                client_name: None,
                client_version: None,
            },
        );
    }
    project.with_inner(|inner| {
        let _ = inner
            .conn
            .prepare_cached(
                "INSERT INTO agent_sessions(pane_id,agent_kind,cli_session_id,pid,status,\
                                            connected_at,last_seen_at) \
                 VALUES(?1,?2,?3,?4,'active',?5,?5)",
            )
            .and_then(|mut s| {
                s.execute(rusqlite::params![pane_id, agent_kind, session_id, pid, now])
            });
    });

    let _ = out.send(
        json!({
            "kind": "hello-ok",
            "projectKey": project.key,
            "projectRoot": project.root.to_string_lossy(),
            "mode": mode,
            "sessionId": session_id,
            "writePolicy": policy,
        })
        .to_string(),
    );
    dlog(&format!(
        "[knowledge] ipc connect: {agent_kind} pid={pid} project={} mode={mode}",
        project.key
    ));
    Some(id)
}

fn disconnect(conn_id: u64) {
    let info = connections().lock().ok().and_then(|mut m| m.remove(&conn_id));
    let Some(info) = info else { return };
    if let Some(project) = super::get(&info.project_key) {
        project.with_inner(|inner| {
            inner.granted.remove(&conn_id);
            let _ = inner
                .conn
                .prepare_cached(
                    "UPDATE agent_sessions SET status='closed', last_seen_at=?2 \
                     WHERE pane_id IS ?1 AND status='active'",
                )
                .and_then(|mut s| s.execute(rusqlite::params![info.pane_id, now_ms()]));
        });
    }
    dlog(&format!(
        "[knowledge] ipc disconnect: {} project={}",
        info.agent_kind, info.project_key
    ));
}

/// Compare without an early return, so a wrong token teaches nothing about how
/// much of it was right.
fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Walk up from a directory looking for `.project-memory`, then require that
/// the project it belongs to is actually open in this instance.
fn find_open_project(start: &str) -> Option<Arc<ProjectKnowledge>> {
    if start.trim().is_empty() {
        return None;
    }
    let mut dir = PathBuf::from(start);
    for _ in 0..64 {
        if dir.join(projector::MEMORY_DIR).is_dir() {
            if let Some(p) = super::get(&super::project_key(&dir.to_string_lossy())) {
                return Some(p);
            }
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const WRITE_METHODS: &[&str] = &[
    "create_note",
    "update_note",
    "update_state",
    "add_decision",
    "add_learning",
    "create_handoff",
    "create_task",
    "update_task",
    "link_entities",
];

async fn handle_request(
    conn_id: u64,
    line: &str,
    closed: watch::Receiver<bool>,
) -> Option<String> {
    let msg: Value = serde_json::from_str(line).ok()?;
    let req_id = msg.get("id").cloned().unwrap_or(Value::Null);
    let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or(json!({}));

    let reply = |result: Result<Value, WireErr>| -> Option<String> {
        Some(match result {
            Ok(ok) => json!({ "id": req_id, "ok": ok }).to_string(),
            Err(err) => json!({ "id": req_id, "err": err }).to_string(),
        })
    };

    let Some(info) = touch_connection(conn_id) else {
        return reply(Err(WireErr::new("internal", "connection is gone")));
    };
    let Some(project) = super::get(&info.project_key) else {
        return reply(Err(WireErr::new(
            "unknown-project",
            "that project is no longer open in MADE",
        )));
    };

    if method == "ping" {
        return reply(Ok(json!({ "pong": true })));
    }
    if method == "session-info" {
        // Records the client's self-description for the diagnostics list, and
        // NOTHING that identifies who is writing.
        //
        // This used to read `params["sessionId"]` and overwrite the connection's
        // session id with it, which contradicted property #1 at the top of this
        // file for the one field it happened to name. The legitimate adapter
        // never sends a sessionId — it says so in a comment, for exactly this
        // reason — so the branch's only live effect was to let any process that
        // could read `endpoint-<pid>.json` attribute its writes to someone
        // else's agent session in the revision history and the audit log.
        //
        // The session id comes from the hello-time pane-registry join and from
        // nowhere else. That join is bounded to panes registered for THIS
        // project, so the worst a token holder can do is borrow a real
        // same-project session — it can never invent one.
        let client_name = params
            .get("clientName")
            .and_then(|v| v.as_str())
            .map(|s| s.chars().take(120).collect::<String>());
        let client_version = params
            .get("clientVersion")
            .and_then(|v| v.as_str())
            .map(|s| s.chars().take(60).collect::<String>());
        if client_name.is_some() || client_version.is_some() {
            if let Ok(mut map) = connections().lock() {
                if let Some(c) = map.get_mut(&conn_id) {
                    if client_name.is_some() {
                        c.client_name = client_name;
                    }
                    if client_version.is_some() {
                        c.client_version = client_version;
                    }
                }
            }
        }
        return reply(Ok(json!({ "ok": true })));
    }

    if WRITE_METHODS.contains(&method) {
        if let Err(e) = authorize_write(&project, conn_id, &info, method, closed).await {
            return reply(Err(e));
        }
    }

    // Identity is assembled from the connection, never from params.
    let actor = Actor::agent(
        &info.agent_kind,
        info.session_id.clone(),
        info.pane_id.clone(),
    );
    reply(project.with_inner(|inner| dispatch(inner, method, &params, &actor)))
}

fn touch_connection(conn_id: u64) -> Option<ConnInfo> {
    let mut map = connections().lock().ok()?;
    let c = map.get_mut(&conn_id)?;
    c.last_seen_at = now_ms();
    c.call_count += 1;
    Some(c.clone())
}

/// The single choke point for agent writes. UI commands never come through
/// here — a user editing their own notes is not something to prompt about.
async fn authorize_write(
    project: &Arc<ProjectKnowledge>,
    conn_id: u64,
    info: &ConnInfo,
    method: &str,
    mut closed: watch::Receiver<bool>,
) -> Result<(), WireErr> {
    if project.read_only() {
        return Err(WireErr::new(
            "read-only",
            "another MADE instance owns this project — edit there, or close it",
        ));
    }
    let (policy, already_granted) = project.with_inner(|inner| {
        (
            store::write_policy(&inner.conn),
            inner.granted.contains(&conn_id),
        )
    });
    match policy.as_str() {
        store::POLICY_READ_ONLY => {
            return Err(WireErr::new(
                "read-only",
                "this project's memory is read-only — change it in MADE under \
                 Settings > NexusMind > Memory write policy",
            ))
        }
        store::POLICY_TRUSTED => return Ok(()),
        _ => {}
    }
    if already_granted {
        return Ok(());
    }

    let request_id = new_id("apr_");
    let (tx, rx) = oneshot::channel::<String>();
    if let Ok(mut map) = approvals().lock() {
        map.insert(
            request_id.clone(),
            PendingApproval {
                tx,
                project_key: project.key.clone(),
            },
        );
    }
    emit_approval(&ApprovalRequest {
        request_id: request_id.clone(),
        project_key: project.key.clone(),
        project_path: project.root.to_string_lossy().to_string(),
        agent_kind: info.agent_kind.clone(),
        pane_id: info.pane_id.clone(),
        method: method.to_string(),
        created_at: now_ms(),
    });

    let verdict = tokio::select! {
        v = rx => v.unwrap_or_else(|_| "deny".into()),
        _ = tokio::time::sleep(Duration::from_secs(APPROVAL_TIMEOUT_SECS)) => "deny".into(),
        // The caller hung up. Denying here is what guarantees no write commits
        // after an agent has already given up on the answer.
        _ = closed.changed() => "deny".into(),
    };
    if let Ok(mut map) = approvals().lock() {
        map.remove(&request_id);
    }

    match verdict.as_str() {
        "always" => {
            project.with_inner(|inner| {
                let _ = store::meta_set(&inner.conn, store::META_POLICY, store::POLICY_TRUSTED);
                inner.granted.insert(conn_id);
            });
            Ok(())
        }
        "approve" => {
            project.with_inner(|inner| inner.granted.insert(conn_id));
            Ok(())
        }
        // Before denying, check whether this connection was granted while we
        // were waiting.
        //
        // Two writes arriving together both see `granted == false` and both
        // raise a prompt. The user answers one, which grants the CONNECTION —
        // and the grant is session-scoped by design, "covers the rest of that
        // session". The other request was still parked on its own channel, so
        // it was denied 90 seconds later on a session the user had already
        // approved. Re-reading the grant here is what makes the deny reflect
        // the session's actual state instead of one stale prompt's outcome.
        _ if project.with_inner(|inner| inner.granted.contains(&conn_id)) => Ok(()),
        _ => Err(WireErr::new(
            "denied",
            &format!(
                "the user did not approve this write. Ask them to allow it in MADE, \
                 or write to {}/ directly and it will be imported.",
                projector::MEMORY_DIR
            ),
        )),
    }
}

fn emit_approval(request: &ApprovalRequest) {
    let Some(app) = super::app_handle() else {
        return;
    };
    let _ = app.emit(APPROVAL_EVENT, request.clone());
    super::events::emit_now(
        &request.project_key,
        &request.project_path,
        0,
        &["approval"],
        0,
    );
}

/// Methods map one-to-one onto the same synchronous service functions the Tauri
/// commands call. Nothing here is agent-specific except the actor.
fn dispatch(
    inner: &mut super::Inner,
    method: &str,
    params: &Value,
    actor: &Actor,
) -> Result<Value, WireErr> {
    let s = |key: &str| params.get(key).and_then(|v| v.as_str()).map(|v| v.to_string());
    let i = |key: &str| params.get(key).and_then(|v| v.as_i64());
    let b = |key: &str| params.get(key).and_then(|v| v.as_bool());
    let list = |key: &str| -> Vec<String> {
        params
            .get(key)
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default()
    };
    // A missing or wrong-typed required field is the CALLER's problem, and the
    // adapter has an `invalid-params` arm that tells the model which field to
    // supply and to re-read the entity for its current revision. Reporting
    // these as `internal` made that arm dead code and handed the model a bare
    // "internal error" it could only retry blindly. Genuine service failures
    // keep `internal` — see the `internal()` helper below.
    let need = |key: &str| -> Result<String, WireErr> {
        s(key).ok_or_else(|| WireErr::new(ERR_INVALID_PARAMS, format!("'{key}' is required")))
    };
    // Optimistic concurrency only works if the caller states the revision it
    // read. A DEFAULT here is not a convenience, it is a bypass — see the
    // `update_state` arm.
    let need_i = |key: &str| -> Result<i64, WireErr> {
        i(key).ok_or_else(|| {
            WireErr::new(
                ERR_INVALID_PARAMS,
                format!("'{key}' is required — read the document first and pass its revision"),
            )
        })
    };

    match method {
        "search" => {
            let hits = search::search(&inner.conn, &need("query")?, i("limit").unwrap_or(10))
                .map_err(internal)?;
            Ok(json!(hits))
        }
        "get_context" => {
            let refs = list("refs");
            let pkg = search::resolve_refs(
                inner,
                &refs,
                i("budgetTokens").unwrap_or(search::DEFAULT_BUDGET_TOKENS),
                true,
                actor,
            )
            .map_err(internal)?;
            Ok(json!(pkg))
        }
        "get_note" => {
            let id = need("id")?;
            let meta = inner
                .graph
                .note(&id)
                .cloned()
                .ok_or_else(|| WireErr::new("not-found", format!("no note {id}")))?;
            let content = store::note_content(&inner.conn, &id).map_err(internal)?;
            Ok(json!(Note { meta, content }))
        }
        "get_doc" => {
            let kind = need("kind")?;
            let meta = inner
                .graph
                .by_type(&kind)
                .cloned()
                .ok_or_else(|| WireErr::new("not-found", format!("no {kind} document")))?;
            let content = store::note_content(&inner.conn, &meta.id).map_err(internal)?;
            Ok(json!(Note { meta, content }))
        }
        "list_note_summaries" => Ok(json!(inner.graph.list(b("includeArchived").unwrap_or(false)))),
        "list_recent_changes" => {
            let (events, latest) =
                store::recent_events(&inner.conn, i("sinceSeq"), i("limit").unwrap_or(50))
                    .map_err(internal)?;
            Ok(json!({ "events": events, "latestSeq": latest }))
        }
        "get_latest_handoff" => Ok(json!(store::latest_handoff(&inner.conn).map_err(internal)?)),
        "list_tasks" => Ok(json!(
            store::list_tasks(&inner.conn, b("includeDone").unwrap_or(false)).map_err(internal)?
        )),

        "create_note" => {
            let result = store::create_note(
                inner,
                CreateNoteInput {
                    title: need("title")?,
                    content: s("content").unwrap_or_default(),
                    note_type: s("noteType"),
                    tags: list("tags"),
                    ..Default::default()
                },
                actor,
            )
            .map_err(internal)?;
            commit_reply(result)
        }
        "update_note" => {
            let result = store::update_note(
                inner,
                UpdateNoteInput {
                    id: need("id")?,
                    // 0 never matches a head (notes start at 1), so an unstated
                    // base routes through merge/conflict rather than committing
                    // clean — the safe default, unlike update_state's.
                    base_revision: i("baseRevision").unwrap_or(0),
                    // NOT unwrap_or_default: a missing or null content would
                    // otherwise replace the note with an empty string as a
                    // clean commit.
                    content: need("content")?,
                    title: s("title"),
                    tags: params.get("tags").map(|_| list("tags")),
                    reason: s("reason"),
                },
                actor,
                store::SOURCE_API,
            )
            .map_err(internal)?;
            commit_reply(result)
        }
        "update_state" => {
            let doc = inner
                .graph
                .by_type("state")
                .cloned()
                .ok_or_else(|| WireErr::new("not-found", "no state document"))?;
            // Both params are REQUIRED, and neither may fall back to a value
            // read from the head.
            //
            // Defaulting `baseRevision` to `doc.revision` made the optimistic
            // check compare the head against itself, so a model that simply
            // omitted the field — which they routinely do for anything the
            // schema marks optional — took the clean-commit branch and
            // last-writer-wins over every revision committed since it read the
            // document, with status "ok" and no conflict record. STATE.md is
            // the most contended doc in the store, so this was the worst
            // possible place for it. Defaulting `content` was the same defect
            // one step further: a missing or null content committed an EMPTY
            // STATE.md as a clean write.
            let base_revision = need_i("baseRevision")?;
            let content = need("content")?;
            let result = store::update_note(
                inner,
                UpdateNoteInput {
                    id: doc.id,
                    base_revision,
                    content,
                    reason: s("reason"),
                    ..Default::default()
                },
                actor,
                store::SOURCE_API,
            )
            .map_err(internal)?;
            commit_reply(result)
        }
        "add_decision" | "add_learning" => {
            let doc = if method == "add_decision" {
                "decisions"
            } else {
                "learnings"
            };
            let result = store::append_entry(
                inner,
                doc,
                &need("title")?,
                &s("content").unwrap_or_default(),
                &list("tags"),
                actor,
            )
            .map_err(internal)?;
            commit_reply(result)
        }
        "create_handoff" => {
            let input: HandoffInput =
                serde_json::from_value(params.clone()).map_err(|e| internal(e.to_string()))?;
            Ok(json!(store::create_handoff(inner, input, actor).map_err(internal)?))
        }
        "create_task" => Ok(json!(store::create_task(
            inner,
            &need("title")?,
            s("detail"),
            actor
        )
        .map_err(internal)?)),
        "update_task" => Ok(json!(store::update_task(
            inner,
            &need("id")?,
            s("status"),
            s("title"),
            s("detail"),
            s("assignee"),
            actor
        )
        .map_err(internal)?)),
        "link_entities" => {
            let id = store::link_entities(
                inner,
                &need("sourceId")?,
                &need("targetId")?,
                &s("relType").unwrap_or_else(|| "relates-to".into()),
                actor,
            )
            .map_err(internal)?;
            Ok(json!({ "id": id }))
        }
        other => Err(WireErr::new(
            "internal",
            format!("unknown method '{other}'"),
        )),
    }
}

/// A conflict is a structured answer, not a failure — the caller rebases onto
/// the revision and content this carries and tries again.
fn commit_reply(result: CommitResult) -> Result<Value, WireErr> {
    if result.status != store::STATUS_CONFLICT {
        return Ok(json!(result));
    }
    Err(WireErr::with_data(
        "conflict",
        "this note changed since the revision you edited — re-read it, merge \
         your change into the current content, and retry with the new baseRevision",
        json!(result),
    ))
}

fn internal(message: impl Into<String>) -> WireErr {
    let message = message.into();
    if message.contains("not found") {
        WireErr::new("not-found", message)
    } else {
        WireErr::new("internal", message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::testutil::fixture;

    #[test]
    fn constant_time_eq_still_compares_correctly() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "abcd"));
        assert!(constant_time_eq("", ""));
    }

    #[test]
    fn dispatch_reads_and_writes_with_a_server_side_actor() {
        let mut f = fixture();
        store::scaffold(&mut f.inner).expect("scaffold");
        let actor = Actor::agent("codex", Some("sess-1".into()), Some("term-9".into()));

        let created = dispatch(
            &mut f.inner,
            "create_note",
            &json!({ "title": "Agent Note", "content": "# Agent Note\n\nbody\n" }),
            &actor,
        )
        .expect("create_note");
        let id = created["id"].as_str().expect("id").to_string();
        assert_eq!(created["status"], "ok");
        assert_eq!(f.inner.graph.note(&id).unwrap().updated_by, "codex");

        let fetched = dispatch(&mut f.inner, "get_note", &json!({ "id": id }), &actor)
            .expect("get_note");
        assert_eq!(fetched["meta"]["title"], "Agent Note");
        assert!(fetched["content"].as_str().unwrap().contains("body"));

        let doc = dispatch(&mut f.inner, "get_doc", &json!({ "kind": "state" }), &actor)
            .expect("get_doc");
        assert_eq!(doc["meta"]["filePath"], "STATE.md");

        let hits = dispatch(&mut f.inner, "search", &json!({ "query": "body" }), &actor)
            .expect("search");
        assert_eq!(hits.as_array().unwrap().len(), 1);

        assert!(dispatch(&mut f.inner, "get_note", &json!({ "id": "kn_nope" }), &actor)
            .is_err_and(|e| e.code == "not-found"));
        assert!(dispatch(&mut f.inner, "nonsense", &json!({}), &actor).is_err());
    }

    #[test]
    fn params_cannot_forge_identity() {
        let mut f = fixture();
        let actor = Actor::agent("codex", Some("real-session".into()), Some("term-1".into()));
        // The model tries to pass itself off as the user, in every shape the
        // payload types use.
        let created = dispatch(
            &mut f.inner,
            "create_note",
            &json!({
                "title": "Forged",
                "content": "# Forged\n",
                "actor": { "actorType": "user" },
                "actorType": "user",
                "agentKind": "claude",
                "updatedBy": "user",
                "sessionId": "someone-elses-session",
            }),
            &actor,
        )
        .expect("create_note");

        let id = created["id"].as_str().unwrap();
        let meta = f.inner.graph.note(id).unwrap();
        assert_eq!(meta.updated_by, "codex", "params overrode the actor");
        assert_eq!(meta.created_by, "codex");

        let hist = store::history(&f.inner.conn, id, 5, None).unwrap();
        assert_eq!(hist[0].actor.actor_type, "agent");
        assert_eq!(hist[0].actor.agent_kind.as_deref(), Some("codex"));
        assert_eq!(hist[0].actor.session_id.as_deref(), Some("real-session"));
    }

    #[test]
    fn a_stale_write_comes_back_as_a_structured_conflict() {
        let mut f = fixture();
        let note = f.note("Doc", "# Doc\n\nline\n");
        f.update(&note.id, 1, "# Doc\n\nmine\n");
        let actor = Actor::agent("claude", None, None);

        let err = dispatch(
            &mut f.inner,
            "update_note",
            &json!({ "id": note.id, "baseRevision": 1, "content": "# Doc\n\ntheirs\n" }),
            &actor,
        )
        .expect_err("stale base must not commit");
        assert_eq!(err.code, "conflict");
        // Everything needed to rebase without another round trip.
        let data = err.data.expect("conflict data");
        assert_eq!(data["status"], "conflict");
        assert_eq!(data["conflict"]["currentRevision"], 2);
        assert!(data["conflict"]["currentContent"]
            .as_str()
            .unwrap()
            .contains("mine"));
    }

    #[test]
    fn write_methods_are_the_documented_set() {
        // The policy gate keys off this list, so a new write method that is not
        // in it would bypass approval entirely.
        for method in [
            "create_note",
            "update_note",
            "update_state",
            "add_decision",
            "add_learning",
            "create_handoff",
            "create_task",
            "update_task",
            "link_entities",
        ] {
            assert!(WRITE_METHODS.contains(&method), "{method} is not gated");
        }
        for method in ["search", "get_note", "get_doc", "get_context", "list_tasks"] {
            assert!(!WRITE_METHODS.contains(&method), "{method} must not prompt");
        }
    }

    /// `update_state` must never fill in a base revision for the caller.
    ///
    /// It used to default `baseRevision` to the CURRENT head, which made the
    /// optimistic check compare the head against itself: an agent that read
    /// STATE.md at rev 5 and omitted the field — the normal thing for a model
    /// to do with an optional param — overwrote everything committed since,
    /// clean, with status "ok" and no conflict record.
    #[test]
    fn update_state_without_a_base_revision_is_refused_not_defaulted() {
        let mut f = fixture();
        store::scaffold(&mut f.inner).expect("scaffold");
        let actor = Actor::agent("codex", None, None);

        let state = f.inner.graph.by_type("state").cloned().expect("state doc");
        let read_at = state.revision;
        // Somebody else moves the head while our agent is thinking.
        dispatch(
            &mut f.inner,
            "update_state",
            &json!({ "baseRevision": read_at, "content": "# State\n\nfrom the other agent\n" }),
            &Actor::agent("claude", None, None),
        )
        .expect("first writer commits");

        // The stale agent omits baseRevision entirely.
        let err = dispatch(
            &mut f.inner,
            "update_state",
            &json!({ "content": "# State\n\nstale agent\n" }),
            &actor,
        )
        .expect_err("an omitted baseRevision must not commit");
        assert!(
            err.message.contains("baseRevision"),
            "the error must name the missing field: {err:?}"
        );

        // The other agent's work is still the head.
        let head = f.inner.graph.by_type("state").cloned().expect("state doc");
        let content = store::note_content(&f.inner.conn, &head.id).expect("content");
        assert!(
            content.contains("from the other agent"),
            "the stale write overwrote the head: {content:?}"
        );

        // Passing the stale revision explicitly is the honest path, and it
        // comes back as a conflict rather than a silent overwrite.
        let err = dispatch(
            &mut f.inner,
            "update_state",
            &json!({ "baseRevision": read_at, "content": "# State\n\nstale agent\n" }),
            &actor,
        )
        .expect_err("a stale base must conflict");
        assert_eq!(err.code, "conflict");
    }

    /// Missing required fields come back as `invalid-params`, and the frame the
    /// adapter parses carries that code verbatim.
    ///
    /// The code set is closed and mirrored in the adapter's `wire.rs`. These
    /// used to ship as `internal`, which left the adapter's `invalid-params`
    /// arm — the one that tells the model which field to supply and to re-read
    /// the entity for its current revision — as dead code, and handed the model
    /// a bare "internal error" it could only retry blindly.
    #[test]
    fn missing_required_fields_are_invalid_params_not_internal() {
        let mut f = fixture();
        store::scaffold(&mut f.inner).expect("scaffold");
        let actor = Actor::agent("codex", None, None);
        let state = f.inner.graph.by_type("state").cloned().expect("state");
        let note = f.note("Doc", "# Doc\n\nbody\n");

        let cases: Vec<(&str, serde_json::Value)> = vec![
            ("update_state", json!({ "content": "# State\n" })),
            ("update_state", json!({ "baseRevision": state.revision })),
            ("update_note", json!({ "id": note.id, "baseRevision": 1 })),
            ("update_note", json!({ "content": "# Doc\n" })),
            ("search", json!({})),
            ("create_note", json!({ "content": "no title" })),
        ];
        for (method, params) in cases {
            let err = dispatch(&mut f.inner, method, &params, &actor)
                .expect_err("a missing required field must be refused");
            assert_eq!(
                err.code, ERR_INVALID_PARAMS,
                "{method} with {params} reported `{}`, not invalid-params",
                err.code
            );
            assert!(!err.message.is_empty(), "the message must name the field");
        }

        // A genuine service failure keeps `internal`, and a stale write still
        // reports `conflict`: this change must not have flattened the set.
        assert_eq!(
            dispatch(&mut f.inner, "get_note", &json!({ "id": "kn_nope" }), &actor)
                .expect_err("missing note")
                .code,
            "not-found"
        );
        f.update(&note.id, 1, "# Doc\n\nmine\n");
        assert_eq!(
            dispatch(
                &mut f.inner,
                "update_note",
                &json!({ "id": note.id, "baseRevision": 1, "content": "# Doc\n\ntheirs\n" }),
                &actor,
            )
            .expect_err("stale")
            .code,
            "conflict"
        );
    }

    /// `session-info` must not be able to set the session id.
    ///
    /// The handler used to overwrite the connection's session id with
    /// `params["sessionId"]`, so any process that could read
    /// `endpoint-<pid>.json` could attribute its writes to somebody else's
    /// agent session in the revision history and the audit log. The real
    /// adapter never sends the field at all.
    ///
    /// Tested at the dispatch layer the forged value would have to reach: the
    /// handler itself only mutates `ConnInfo`, and the proof that matters is
    /// that nothing a caller sends can change the actor a write is recorded
    /// under.
    #[test]
    fn session_info_cannot_forge_the_session_id() {
        let mut f = fixture();
        // The actor the connection was built with at hello, from the pane
        // registry — the only legitimate source.
        let real = Actor::agent("codex", Some("real-session".into()), Some("term-1".into()));

        let created = dispatch(
            &mut f.inner,
            "create_note",
            &json!({
                "title": "Forged",
                "content": "# Forged\n",
                // Every shape the forged id could arrive in.
                "sessionId": "claude-victim-session",
                "session_id": "claude-victim-session",
                "actor": { "kind": "agent", "sessionId": "claude-victim-session" },
            }),
            &real,
        )
        .expect("create_note");
        let id = created["id"].as_str().expect("id");

        let hist = store::history(&f.inner.conn, id, 5, None).expect("history");
        assert_eq!(
            hist[0].actor.session_id.as_deref(),
            Some("real-session"),
            "a params-supplied sessionId reached the revision history"
        );
        let (events, _) = store::recent_events(&f.inner.conn, None, 50).expect("events");
        for e in &events {
            assert_ne!(
                e.actor.session_id.as_deref(),
                Some("claude-victim-session"),
                "a forged sessionId reached the audit log"
            );
        }

        // And the handler itself no longer READS the field. Comment lines are
        // stripped first — the block explains the old bug, so scanning raw text
        // would match the explanation and never the code.
        let handler_src = include_str!("ipc.rs");
        let handler: String = handler_src
            .split("if method == \"session-info\"")
            .nth(1)
            .expect("session-info handler")
            .split("if WRITE_METHODS")
            .next()
            .expect("handler body")
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !handler.contains("\"sessionId\""),
            "session-info reads sessionId again — identity must come from the \
             pane-registry join at hello and nowhere else"
        );
        assert!(
            handler.contains("clientName"),
            "the diagnostics passthrough went missing"
        );
    }

    /// A grant that lands while another request is waiting cancels its denial.
    ///
    /// Two writes arriving together both saw `granted == false` and both raised
    /// a prompt. Answering one granted the connection, but the other was still
    /// parked on its own channel and was denied 90 seconds later — on a session
    /// the user had already approved.
    #[tokio::test]
    async fn a_grant_during_the_wait_cancels_a_pending_denial() {
        let f = fixture();
        // `dir` is declared first so it outlives `project` — dropping it closes
        // the directory the connection's database lives in.
        let crate::knowledge::testutil::Fixture { inner, dir } = f;
        let db_path = dir.path().join("k.db");
        let project = Arc::new(super::super::ProjectKnowledge {
            key: inner.project_key.clone(),
            root: dir.path().to_path_buf(),
            memory_dir: inner.memory_dir.clone(),
            db_path,
            mode: super::super::Mode::ReadWrite,
            inner: Mutex::new(inner),
            watcher: Mutex::new(None),
        });
        let info = ConnInfo {
            agent_kind: "codex".into(),
            project_key: project.key.clone(),
            pane_id: None,
            session_id: None,
            mode: "rw".into(),
            connected_at: now_ms(),
            last_seen_at: now_ms(),
            call_count: 0,
            pid: 0,
            client_name: None,
            client_version: None,
        };
        let conn_id = 4242u64;
        let (_closed_tx, closed_rx) = watch::channel(false);

        // Policy is `ask` by default, and the connection starts ungranted.
        let waiting = {
            let project = project.clone();
            tokio::spawn(async move {
                authorize_write(&project, conn_id, &info, "create_note", closed_rx).await
            })
        };

        // Wait until the request is actually registered, rather than sleeping a
        // fixed amount and hoping.
        let mut request_id = None;
        for _ in 0..200 {
            if let Some(id) = approvals()
                .lock()
                .ok()
                .and_then(|m| m.keys().next().cloned())
            {
                request_id = Some(id);
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let request_id = request_id.expect("the approval was never raised");

        // The user answers a CONCURRENT prompt on this same connection, which
        // grants the session; then this older prompt resolves as a denial.
        project.with_inner(|inner| inner.granted.insert(conn_id));
        respond_approval(&request_id, "deny").expect("respond");

        let outcome = waiting.await.expect("join");
        assert!(
            outcome.is_ok(),
            "a write on an already-granted connection was denied: {:?}",
            outcome.err()
        );

        // An ungranted connection is still refused — the fix must not turn the
        // gate off.
        let (_c2_tx, c2_rx) = watch::channel(false);
        let info2 = ConnInfo {
            agent_kind: "claude".into(),
            project_key: project.key.clone(),
            pane_id: None,
            session_id: None,
            mode: "rw".into(),
            connected_at: now_ms(),
            last_seen_at: now_ms(),
            call_count: 0,
            pid: 0,
            client_name: None,
            client_version: None,
        };
        let other_conn = 4243u64;
        let denied = {
            let project = project.clone();
            tokio::spawn(async move {
                authorize_write(&project, other_conn, &info2, "create_note", c2_rx).await
            })
        };
        let mut second = None;
        for _ in 0..200 {
            if let Some(id) = approvals()
                .lock()
                .ok()
                .and_then(|m| m.keys().next().cloned())
            {
                second = Some(id);
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        respond_approval(&second.expect("second approval"), "deny").expect("respond");
        let outcome = denied.await.expect("join");
        assert!(
            outcome.is_err_and(|e| e.code == "denied"),
            "an ungranted connection must still be refused"
        );
    }

    /// An unauthenticated peer gets a small buffer, and the socket table is
    /// bounded.
    ///
    /// The handshake window let a peer grow a ~4 MiB read buffer before it had
    /// proven anything, and the accept loop had no ceiling, so N stalled local
    /// sockets held ~N x 4 MiB plus two tasks each — all pre-auth.
    #[tokio::test]
    async fn an_unauthenticated_peer_cannot_buffer_megabytes() {
        assert!(
            PRE_AUTH_FRAME_BYTES < MAX_FRAME_BYTES,
            "the pre-auth cap must be tighter than the authenticated one"
        );
        // Enough for the largest legitimate hello by a wide margin.
        assert!(PRE_AUTH_FRAME_BYTES >= 8 * 1024);
        assert!(MAX_LIVE_CONNECTIONS > 0);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let (read_half, _write) = stream.into_split();
            let mut framer = Framer {
                stream: read_half,
                buf: Vec::new(),
                limit: PRE_AUTH_FRAME_BYTES,
            };
            framer.next_line().await
        });

        // A peer that never sends a newline.
        let mut client = tokio::net::TcpStream::connect(addr).await.expect("connect");
        let blob = vec![b'x'; 64 * 1024];
        // Writing may fail once the server drops the socket; that is the point.
        for _ in 0..8 {
            if client.write_all(&blob).await.is_err() {
                break;
            }
        }

        let result = server.await.expect("join");
        let err = result.expect_err("a newline-less flood must be refused");
        assert!(
            err.contains("exceeds"),
            "expected a frame-size refusal, got {err:?}"
        );
    }

    /// The exact `invalid-params` frame, mirrored against the adapter.
    ///
    /// Byte-identical to `FIXTURE_INVALID_PARAMS` in
    /// `src/bin/made-knowledge-mcp/wire.rs`. The two files deliberately do not
    /// reference each other — the adapter is a standalone binary that never
    /// links `made_lib` — so this pair of literals IS the drift alarm: change
    /// the code, the message or the envelope on one side and the other side's
    /// copy stops matching. Both halves must be edited together.
    const FIXTURE_INVALID_PARAMS: &str = r#"{"id":9,"err":{"code":"invalid-params","message":"'baseRevision' is required — read the document first and pass its revision"}}"#;

    #[test]
    fn the_invalid_params_frame_matches_the_adapter_fixture() {
        let mut f = fixture();
        store::scaffold(&mut f.inner).expect("scaffold");
        let actor = Actor::agent("codex", None, None);

        // Produced by a REAL rejection and serialized exactly as the socket
        // writer does it (see the `reply` path), not hand-assembled.
        let err = dispatch(
            &mut f.inner,
            "update_state",
            &json!({ "content": "# State\n\nno base revision\n" }),
            &actor,
        )
        .expect_err("a missing baseRevision must be refused");
        let frame = json!({ "id": 9, "err": err }).to_string();

        // Compared as PARSED values, not as strings. serde_json's default map
        // is a BTreeMap, so the real socket frame emits keys alphabetically
        // (`err` before `id`) while the fixture literal reads in the natural
        // order — same object, different spelling. Both sides parse with serde,
        // so key order is not part of the contract and asserting on it would
        // fail forever over something neither mirror controls.
        let produced: Value = serde_json::from_str(&frame).expect("produced frame parses");
        let expected: Value =
            serde_json::from_str(FIXTURE_INVALID_PARAMS).expect("fixture parses");
        assert_eq!(
            produced, expected,
            "the wire frame drifted from the adapter's fixture — update BOTH \
             mirrors (knowledge/ipc.rs and bin/made-knowledge-mcp/wire.rs)"
        );
        // `data` is absent for this class: unlike a conflict there is nothing to
        // rebase against, only a field to supply.
        assert!(produced["err"].get("data").is_none());
    }

    /// A missing or null `content` must never be read as "replace with empty".
    #[test]
    fn a_missing_content_cannot_wipe_a_document() {
        let mut f = fixture();
        store::scaffold(&mut f.inner).expect("scaffold");
        let actor = Actor::agent("codex", None, None);
        let state = f.inner.graph.by_type("state").cloned().expect("state doc");

        for params in [
            json!({ "baseRevision": state.revision }),
            json!({ "baseRevision": state.revision, "content": null }),
        ] {
            assert!(
                dispatch(&mut f.inner, "update_state", &params, &actor).is_err(),
                "update_state committed an empty STATE.md for {params}"
            );
        }

        let note = f.note("Doc", "# Doc\n\nreal content\n");
        for params in [
            json!({ "id": note.id, "baseRevision": 1 }),
            json!({ "id": note.id, "baseRevision": 1, "content": null }),
        ] {
            assert!(
                dispatch(&mut f.inner, "update_note", &params, &actor).is_err(),
                "update_note emptied a note for {params}"
            );
        }

        // Nothing above moved a head.
        assert_eq!(f.inner.graph.note(&note.id).unwrap().revision, 1);
        let content = store::note_content(&f.inner.conn, &note.id).expect("content");
        assert!(content.contains("real content"));
    }
}
