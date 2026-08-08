//! The socket to MADE, and everything that can go wrong with it.
//!
//! Three properties this module is responsible for:
//!
//! 1. **Lazy, and re-connectable.** MADE may not be running when a CLI starts,
//!    may be restarted mid-session, and may never be started at all. Connecting
//!    on the first call — and re-reading the endpoint files on every attempt —
//!    is what makes "start MADE, then retry the tool" work without restarting
//!    the CLI. A short negative cache keeps a dead service from costing every
//!    call a fresh 1.5s connect.
//!
//! 2. **Multiplexed, not serialized.** Under the `ask` write policy a single
//!    write can legitimately sit for 90 seconds waiting on the user. A mutex
//!    around the whole request/response cycle would block every concurrent READ
//!    behind it, so instead one reader task fans replies back out by id.
//!
//! 3. **A closed taxonomy of failure.** Every error the caller can see is one
//!    of five kinds, because the MCP layer renders them very differently: a
//!    service-down is a clean "MADE is not running" the model can act on, while
//!    a conflict is not an error at all.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::OwnedWriteHalf;
use tokio::net::TcpStream;
use tokio::sync::{oneshot, Mutex};

use crate::endpoint::{self, Endpoint};
use crate::wire::{self, Hello, HelloOk, HelloReply, WireErr, WireRequest, WireResponse};

/// How long a TCP connect to one candidate instance may take. Loopback either
/// answers immediately or is not listening.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(1500);
/// How long the `hello-ok` may take. The service answers synchronously, but it
/// is also allowed a moment to be busy.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_millis(3000);
/// After a failed connect, don't try again for this long.
const FAIL_CACHE: Duration = Duration::from_secs(3);

/// Read calls. Generous, because a cold FTS query on a large vault is still
/// well under this and a spinner is not a failure mode a CLI recovers from.
pub const READ_TIMEOUT: Duration = Duration::from_secs(10);
/// EVERY write, with no faster variant.
///
/// Deliberately LONGER than the service's own 90s approval window: whoever
/// gives up first decides the outcome, and the service's timeout produces a
/// clean structured denial while ours would produce an unexplained hang the
/// user's Approve click can no longer resolve.
///
/// There used to be a 30s "trusted policy, nothing waits on a human" variant,
/// chosen from the write policy in the handshake. That was wrong, and the way it
/// was wrong is worth keeping: the handshake reports the policy ONCE, while the
/// service re-reads it on every request. A project that was trusted at connect
/// and tightened to `ask` an hour later still looked trusted here — so the
/// adapter gave up at 30s, told the model MADE was not running, and the service
/// committed the write anyway when the user approved at t=45s. Worse, the
/// grant is remembered per connection, so the model's retry committed the SAME
/// decision a second time. A cached copy of a mutable value is not an
/// optimization; it is a second source of truth.
pub const APPROVAL_TIMEOUT: Duration = Duration::from_secs(95);

#[derive(Debug)]
pub enum ServiceError {
    /// No MADE instance answered. The one error whose message is user-facing
    /// advice rather than a diagnosis.
    Unreachable(String),
    /// A MADE is running, but this adapter's directory is not a project it has
    /// open.
    ProjectNotOpen,
    /// The endpoint file's token was refused — a stale file, or a file from
    /// another install.
    Unauthorized,
    /// The service accepted the call and never answered in time.
    Timeout,
    /// The service answered with a structured error. `code` is one of
    /// `wire::ERR_*`.
    Service(WireErr),
}

impl std::fmt::Display for ServiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreachable(why) => write!(f, "MADE is not reachable ({why})"),
            Self::ProjectNotOpen => write!(f, "this folder is not an open project in MADE"),
            Self::Unauthorized => write!(f, "MADE refused this adapter's token"),
            Self::Timeout => write!(f, "MADE did not answer in time"),
            Self::Service(e) => write!(f, "{}: {}", e.code, e.message),
        }
    }
}

impl ServiceError {
    /// Short word for the stderr audit line.
    pub fn kind(&self) -> &str {
        match self {
            Self::Unreachable(_) => "unreachable",
            Self::ProjectNotOpen => "project-not-open",
            Self::Unauthorized => "unauthorized",
            Self::Timeout => "timeout",
            Self::Service(e) => &e.code,
        }
    }
}

/// Identity this adapter presents in every handshake. Fixed at startup.
#[derive(Debug, Clone)]
pub struct AdapterIdentity {
    pub agent: String,
    pub cwd: String,
    pub project_root_guess: Option<String>,
    pub pane_id: Option<String>,
    /// An endpoint file chosen explicitly on the command line, bypassing
    /// discovery.
    pub endpoint_override: Option<std::path::PathBuf>,
}

/// One live socket plus the reply routing for it.
struct Connection {
    writer: Mutex<OwnedWriteHalf>,
    pending: Mutex<HashMap<u64, oneshot::Sender<WireResponse>>>,
    next_id: AtomicU64,
    alive: AtomicBool,
    hello: HelloOk,
}

impl Connection {
    fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }
}

pub struct ServiceClient {
    identity: AdapterIdentity,
    conn: Mutex<Option<Arc<Connection>>>,
    /// When the last connect attempt failed, so a dead service costs one probe
    /// every few seconds instead of one per tool call.
    last_failure: Mutex<Option<(Instant, String)>>,
    /// How many connections have been retired.
    ///
    /// The retry decision has to be about the connection a CALL used, not about
    /// whatever happens to be in the slot when that call finishes. With N
    /// requests in flight and MADE restarting under them, all N fail — but only
    /// the first to notice finds a dead connection to clear, and the rest used
    /// to see an empty slot and conclude there was nothing to retry. This
    /// counter is what lets a loser recognise that its own socket was the one
    /// retired.
    retired: AtomicU64,
}

impl ServiceClient {
    pub fn new(identity: AdapterIdentity) -> Self {
        Self {
            identity,
            conn: Mutex::new(None),
            last_failure: Mutex::new(None),
            retired: AtomicU64::new(0),
        }
    }

    /// What the service said at handshake time, if we are connected right now.
    ///
    /// Diagnostics ONLY. Nothing may branch on it: every field is a snapshot of
    /// a value the service re-reads per request, so acting on it is acting on
    /// what was true at connect time (see `APPROVAL_TIMEOUT`).
    #[allow(dead_code)]
    pub async fn current_hello(&self) -> Option<HelloOk> {
        let guard = self.conn.lock().await;
        guard
            .as_ref()
            .filter(|c| c.is_alive())
            .map(|c| c.hello.clone())
    }

    /// Send one request and wait for its reply.
    pub async fn call(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, ServiceError> {
        // One retry, and only for a connection that died between calls: a MADE
        // restart must not surface as a tool failure the user has to
        // understand. A genuinely-down service is caught by the negative cache
        // rather than retried.
        //
        // Snapshot the retirement count FIRST, so this call can tell "nothing
        // was ever connected" from "the socket I was using got retired while I
        // was waiting on it".
        let seen = self.retired.load(Ordering::Relaxed);
        match self.call_once(method, &params, timeout).await {
            Err(ServiceError::Unreachable(_)) if self.drop_dead_connection(seen).await => {
                self.call_once(method, &params, timeout).await
            }
            other => other,
        }
    }

    async fn call_once(
        &self,
        method: &str,
        params: &Value,
        timeout: Duration,
    ) -> Result<Value, ServiceError> {
        let conn = self.connection().await?;
        let id = conn.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        conn.pending.lock().await.insert(id, tx);

        let frame = match serde_json::to_string(&WireRequest {
            id,
            method: method.to_string(),
            params: params.clone(),
        }) {
            Ok(frame) => frame,
            Err(e) => {
                conn.pending.lock().await.remove(&id);
                return Err(ServiceError::Unreachable(format!(
                    "could not encode {method}: {e}"
                )));
            }
        };

        // Refuse an oversized frame HERE rather than posting it. The service
        // drops any connection whose frame passes 4 MiB, so sending one costs
        // the socket and every other request multiplexed on it — and the model
        // would be told "MADE is not running", which is both false and
        // unactionable. `invalid-params` routes through the arm that names the
        // problem and what to do about it.
        //
        // The waiter was already inserted above; leaving it would keep a
        // oneshot sender alive for the life of the connection.
        if frame.len() > wire::MAX_FRAME_BYTES {
            conn.pending.lock().await.remove(&id);
            return Err(ServiceError::Service(WireErr {
                code: wire::ERR_INVALID_PARAMS.into(),
                message: format!(
                    "this call is {} bytes and MADE accepts at most {} per request — split the \
                     content into smaller notes, or send a shorter update",
                    frame.len(),
                    wire::MAX_FRAME_BYTES
                ),
                data: None,
            }));
        }

        let sent = {
            let mut w = conn.writer.lock().await;
            match w.write_all(frame.as_bytes()).await {
                Ok(()) => w.write_all(b"\n").await,
                Err(e) => Err(e),
            }
        };
        if let Err(e) = sent {
            conn.pending.lock().await.remove(&id);
            conn.alive.store(false, Ordering::Relaxed);
            return Err(ServiceError::Unreachable(format!("write failed: {e}")));
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(response)) => match (response.ok, response.err) {
                (Some(ok), _) => Ok(ok),
                (None, Some(err)) => Err(classify(err)),
                // A reply that is neither: the service answered something this
                // adapter does not understand, which is a bug, not a denial.
                (None, None) => Err(ServiceError::Service(WireErr {
                    code: wire::ERR_INTERNAL.into(),
                    message: format!("MADE returned an empty reply to {method}"),
                    data: None,
                })),
            },
            // The sender was dropped: the reader task saw EOF.
            Ok(Err(_)) => Err(ServiceError::Unreachable("MADE closed the connection".into())),
            Err(_) => {
                conn.pending.lock().await.remove(&id);
                Err(ServiceError::Timeout)
            }
        }
    }

    /// Is this call worth retrying on a fresh connection?
    ///
    /// Two ways to earn a yes. Either this call is the one that FOUND the dead
    /// socket — clear it, and count the retirement — or somebody else already
    /// cleared it while this call was in flight, which means the socket this
    /// call was waiting on is the same one that died. The second case is the
    /// whole point: with several tool calls outstanding when MADE restarts,
    /// exactly one of them wins the race to the slot, and the losers are no
    /// less entitled to a retry for having been slower.
    ///
    /// Still exactly one retry per call — the retried `call_once` is unguarded —
    /// and still no probe storm when MADE is genuinely down: the winner's failed
    /// reconnect re-arms `last_failure`, so every loser's retry short-circuits
    /// on the negative cache in `connection()`.
    async fn drop_dead_connection(&self, seen: u64) -> bool {
        let mut guard = self.conn.lock().await;
        match guard.as_ref() {
            Some(c) if !c.is_alive() => {
                *guard = None;
                self.retired.fetch_add(1, Ordering::Relaxed);
                // A reconnect must not be blocked by the failure this very call
                // just recorded.
                *self.last_failure.lock().await = None;
                true
            }
            // Nothing dead in the slot. Retry only if a retirement happened
            // under us — otherwise there was never a connection to lose, which
            // is the "MADE was never running" case and must not retry.
            _ => self.retired.load(Ordering::Relaxed) != seen,
        }
    }

    async fn connection(&self) -> Result<Arc<Connection>, ServiceError> {
        let mut guard = self.conn.lock().await;
        if let Some(existing) = guard.as_ref().filter(|c| c.is_alive()) {
            return Ok(existing.clone());
        }
        *guard = None;

        if let Some((at, why)) = self.last_failure.lock().await.as_ref() {
            if at.elapsed() < FAIL_CACHE {
                return Err(ServiceError::Unreachable(why.clone()));
            }
        }

        match self.connect().await {
            Ok(conn) => {
                *guard = Some(conn.clone());
                *self.last_failure.lock().await = None;
                Ok(conn)
            }
            Err(e) => {
                if let ServiceError::Unreachable(why) = &e {
                    *self.last_failure.lock().await = Some((Instant::now(), why.clone()));
                }
                Err(e)
            }
        }
    }

    /// Probe every discovered instance and bind to the best one.
    ///
    /// "Best" is the instance that owns this project WRITABLY. A read-only
    /// follower is kept as a fallback and used only if no writable instance
    /// answers, so reads keep working while a second MADE holds the lock.
    async fn connect(&self) -> Result<Arc<Connection>, ServiceError> {
        let endpoints = endpoint::discover(self.identity.endpoint_override.as_deref());
        if endpoints.is_empty() {
            return Err(ServiceError::Unreachable(
                "no MADE endpoint file was found".into(),
            ));
        }

        let mut fallback: Option<Arc<Connection>> = None;
        let mut last_refusal: Option<ServiceError> = None;

        for ep in &endpoints {
            match self.handshake_with(ep).await {
                Ok(conn) => {
                    if conn.hello.writable() {
                        if let Some(ro) = fallback.take() {
                            close(&ro).await;
                        }
                        return Ok(conn);
                    }
                    // Keep the first read-only answer, keep probing for a
                    // writable one.
                    if fallback.is_none() {
                        fallback = Some(conn);
                    } else {
                        close(&conn).await;
                    }
                }
                // A hard refusal from one instance says nothing about the
                // others — a dev build with a different project open is the
                // normal case. Remember it in case nobody accepts us.
                Err(e @ (ServiceError::ProjectNotOpen | ServiceError::Unauthorized)) => {
                    last_refusal = Some(e);
                }
                Err(_) => {}
            }
        }

        if let Some(ro) = fallback {
            return Ok(ro);
        }
        Err(last_refusal.unwrap_or_else(|| {
            ServiceError::Unreachable("no MADE instance answered on its endpoint".into())
        }))
    }

    async fn handshake_with(&self, ep: &Endpoint) -> Result<Arc<Connection>, ServiceError> {
        let addr = format!("127.0.0.1:{}", ep.port);
        let stream = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(&addr))
            .await
            .map_err(|_| ServiceError::Unreachable(format!("{addr} did not accept in time")))?
            .map_err(|e| ServiceError::Unreachable(format!("{addr}: {e}")))?;
        let _ = stream.set_nodelay(true);
        let (read_half, mut write_half) = stream.into_split();

        let hello = Hello::new(
            ep.token.clone(),
            &self.identity.agent,
            self.identity.cwd.clone(),
            self.identity.project_root_guess.clone(),
            self.identity.pane_id.clone(),
        );
        let mut frame = serde_json::to_string(&hello)
            .map_err(|e| ServiceError::Unreachable(format!("encode hello: {e}")))?;
        frame.push('\n');
        write_half
            .write_all(frame.as_bytes())
            .await
            .map_err(|e| ServiceError::Unreachable(format!("send hello: {e}")))?;

        let mut reader = BufReader::new(read_half);
        let mut line = String::new();
        let read = tokio::time::timeout(HANDSHAKE_TIMEOUT, read_frame(&mut reader, &mut line))
            .await
            .map_err(|_| ServiceError::Unreachable("MADE did not answer the handshake".into()))?
            .map_err(|e| ServiceError::Unreachable(format!("handshake read: {e}")))?;
        if read == 0 {
            // The service drops unauthenticated sockets silently. From here
            // that is indistinguishable from a crash, so it reads as
            // unreachable rather than as a specific refusal.
            return Err(ServiceError::Unreachable(
                "MADE closed the socket during the handshake".into(),
            ));
        }

        let reply: HelloReply = serde_json::from_str(line.trim_end())
            .map_err(|e| ServiceError::Unreachable(format!("unreadable hello reply: {e}")))?;
        let ok = match reply {
            HelloReply::HelloOk(ok) => ok,
            HelloReply::HelloErr(err) => {
                return Err(match err.code.as_str() {
                    wire::ERR_UNKNOWN_PROJECT => ServiceError::ProjectNotOpen,
                    wire::ERR_BAD_TOKEN => ServiceError::Unauthorized,
                    other => ServiceError::Unreachable(format!("MADE refused the handshake: {other}")),
                })
            }
        };

        // Which instance answered, in a form that survives a bug report. With a
        // dev build running beside the installed one, "it connected" is not the
        // useful fact — WHICH one it connected to is.
        eprintln!(
            "[made-knowledge-mcp] connected to MADE {} (pid {}) on port {} — project {} [{}], \
             policy {}",
            if ep.app_version.is_empty() { "?" } else { &ep.app_version },
            ep.pid,
            ep.port,
            ok.project_root,
            ok.mode,
            ok.write_policy,
        );

        let conn = Arc::new(Connection {
            writer: Mutex::new(write_half),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            alive: AtomicBool::new(true),
            hello: ok,
        });
        tokio::spawn(read_loop(reader, conn.clone()));
        Ok(conn)
    }
}

/// Read one NDJSON frame, refusing to allocate past the wire's frame cap.
///
/// A bare `read_line` grows its buffer until it meets a newline, so a peer that
/// sends 500 MB without one makes this process allocate 500 MB — and testing the
/// length AFTERWARDS, as this used to, checks the bound only once the damage is
/// done. `take` moves the limit in front of the allocation, mirroring the
/// service's own `Framer`, which has always tested before each read.
///
/// An oversized frame returns `Ok(n)` with no trailing newline. Callers treat
/// that as a broken peer: `Err` is for transport failure, and a peer ignoring
/// the frame cap is not a transport failure.
async fn read_frame<R>(reader: &mut R, line: &mut String) -> std::io::Result<usize>
where
    R: tokio::io::AsyncBufRead + Unpin,
{
    // +1 so a frame of exactly MAX_FRAME_BYTES still has room for its newline.
    let mut limited = reader.take(wire::MAX_FRAME_BYTES as u64 + 1);
    let read = limited.read_line(line).await?;
    if read > 0 && !line.ends_with('\n') {
        return Err(std::io::Error::other(format!(
            "frame exceeds {} bytes",
            wire::MAX_FRAME_BYTES
        )));
    }
    Ok(read)
}

/// Fan replies out to whoever is waiting on that id.
///
/// Runs until EOF or a malformed frame, then marks the connection dead and
/// wakes everyone still waiting — a waiter that is never woken is a CLI that
/// hangs until its own timeout, which is the worst outcome available here.
async fn read_loop(mut reader: BufReader<tokio::net::tcp::OwnedReadHalf>, conn: Arc<Connection>) {
    let mut line = String::new();
    loop {
        line.clear();
        match read_frame(&mut reader, &mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let Ok(response) = serde_json::from_str::<WireResponse>(line.trim_end()) else {
            continue;
        };
        // Server pushes carry no id. `changed` is the one the wire defines and
        // nothing here acts on it yet — dropping it is deliberate. Anything
        // ELSE without an id means the two sides have drifted, which is worth
        // one line rather than silence.
        let Some(id) = response.id else {
            match response.kind.as_deref() {
                Some("changed") | None => {}
                Some(other) => eprintln!("[made-knowledge-mcp] ignoring unknown push '{other}'"),
            }
            continue;
        };
        if let Some(tx) = conn.pending.lock().await.remove(&id) {
            let _ = tx.send(response);
        }
    }

    conn.alive.store(false, Ordering::Relaxed);
    conn.pending.lock().await.clear();
}

async fn close(conn: &Arc<Connection>) {
    conn.alive.store(false, Ordering::Relaxed);
    let _ = conn.writer.lock().await.shutdown().await;
}

fn classify(err: WireErr) -> ServiceError {
    match err.code.as_str() {
        wire::ERR_UNKNOWN_PROJECT => ServiceError::ProjectNotOpen,
        wire::ERR_BAD_TOKEN => ServiceError::Unauthorized,
        _ => ServiceError::Service(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn service_errors_report_a_stable_kind() {
        assert_eq!(ServiceError::Timeout.kind(), "timeout");
        assert_eq!(ServiceError::ProjectNotOpen.kind(), "project-not-open");
        assert_eq!(ServiceError::Unauthorized.kind(), "unauthorized");
        assert_eq!(ServiceError::Unreachable("x".into()).kind(), "unreachable");
        assert_eq!(
            ServiceError::Service(WireErr {
                code: wire::ERR_CONFLICT.into(),
                message: "stale".into(),
                data: None,
            })
            .kind(),
            "conflict"
        );
    }

    #[test]
    fn handshake_level_refusals_get_their_own_variants() {
        // These two are the difference between "start MADE" and "open this
        // folder in MADE" — collapsing them into one message would send the
        // user to fix the wrong thing.
        let unknown = classify(WireErr {
            code: wire::ERR_UNKNOWN_PROJECT.into(),
            message: "gone".into(),
            data: None,
        });
        assert!(matches!(unknown, ServiceError::ProjectNotOpen));

        let bad = classify(WireErr {
            code: wire::ERR_BAD_TOKEN.into(),
            message: "no".into(),
            data: None,
        });
        assert!(matches!(bad, ServiceError::Unauthorized));

        // Everything else stays a Service error with its code and data intact,
        // because the MCP layer renders conflict/denied/read-only differently
        // from each other.
        let conflict = classify(WireErr {
            code: wire::ERR_CONFLICT.into(),
            message: "stale".into(),
            data: Some(json!({ "conflict": { "currentRevision": 4 } })),
        });
        match conflict {
            ServiceError::Service(e) => {
                assert_eq!(e.code, wire::ERR_CONFLICT);
                assert_eq!(e.data.expect("data")["conflict"]["currentRevision"], 4);
            }
            other => panic!("expected a service error, got {other:?}"),
        }
    }

    #[test]
    fn the_approval_timeout_outlasts_the_services_own_window() {
        // The service denies at 90s and answers. If the adapter gave up first,
        // the user's Approve click would land on a call nobody is waiting for.
        assert!(
            APPROVAL_TIMEOUT > Duration::from_secs(90),
            "approval timeout must outlast the service's 90s ask window"
        );
        assert!(READ_TIMEOUT < APPROVAL_TIMEOUT);
    }

    /// A retry after a MADE restart must be available to EVERY call that was in
    /// flight, not only to the one that happened to notice first.
    ///
    /// `drop_dead_connection` is the whole decision, and it used to answer from
    /// the slot alone: the winner cleared the dead connection and retried, and
    /// every other caller then found an empty slot, read it as "nothing was
    /// connected", and reported "MADE is not running" for a service that was
    /// already back.
    #[tokio::test]
    async fn every_caller_in_flight_at_a_restart_earns_a_retry() {
        let client = ServiceClient::new(AdapterIdentity {
            agent: "claude".into(),
            cwd: "/nowhere".into(),
            project_root_guess: None,
            pane_id: None,
            endpoint_override: Some(std::path::PathBuf::from("/nonexistent-endpoint.json")),
        });

        // Three calls were in flight; all snapshot the same generation.
        let seen = client.retired.load(Ordering::Relaxed);

        // The winner finds the dead socket. Simulated by the state its own
        // branch leaves behind, since there is no live socket to kill here.
        client.retired.fetch_add(1, Ordering::Relaxed);

        // The losers arrive at an EMPTY slot — the exact shape that used to
        // return false — and must still be told to retry, because the socket
        // they were waiting on is the one that was retired.
        assert!(
            client.drop_dead_connection(seen).await,
            "a caller whose connection was retired under it must retry"
        );
        assert!(client.drop_dead_connection(seen).await, "and so must the next");

        // A caller that starts AFTER the retirement has nothing to retry: its
        // snapshot already includes the new generation, and an empty slot means
        // MADE was simply never up.
        let fresh = client.retired.load(Ordering::Relaxed);
        assert!(
            !client.drop_dead_connection(fresh).await,
            "no connection was ever lost, so there is nothing to retry onto"
        );
    }

    #[tokio::test]
    async fn a_missing_service_fails_fast_and_stays_cached() {
        // Point discovery at a file that does not exist: no endpoint, no probe.
        let client = ServiceClient::new(AdapterIdentity {
            agent: "claude".into(),
            cwd: "/nowhere".into(),
            project_root_guess: None,
            pane_id: None,
            endpoint_override: Some(std::path::PathBuf::from("/nonexistent-endpoint.json")),
        });
        let started = Instant::now();
        let err = client
            .call(wire::M_PING, json!({}), READ_TIMEOUT)
            .await
            .expect_err("there is no service");
        assert!(matches!(err, ServiceError::Unreachable(_)), "{err:?}");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "a missing endpoint must not cost a connect timeout"
        );
        assert!(client.current_hello().await.is_none());
    }
}
