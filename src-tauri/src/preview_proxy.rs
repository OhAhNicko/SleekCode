// Preview proxy server.
//
// Runs a local HTTP/1.1 server (hyper + tokio) that forwards iframe requests
// to a configured target origin. For HTML responses, strips framing/CSP
// headers and injects the EzyDev DevTools script so console + network capture
// works inside the BrowserPreview pane. For WebSocket upgrades (e.g. Vite
// HMR), the proxy speaks the WS handshake on both sides and bridges frames
// transparently — without WS proxying, HMR can't reach the dev server through
// the proxied iframe origin.

use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http_body_util::{combinators::BoxBody, BodyExt, Empty, Full};
use hyper::body::Incoming;
use hyper::header::{
    HeaderName, HeaderValue, CONNECTION, SEC_WEBSOCKET_ACCEPT, SEC_WEBSOCKET_KEY,
    SEC_WEBSOCKET_PROTOCOL, UPGRADE,
};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::Role;
use tokio_tungstenite::WebSocketStream;

const DEVTOOLS_INJECT_SCRIPT: &str = include_str!("preview_proxy_inject.js");

#[derive(Clone)]
pub struct ProxyHandle {
    port: u16,
    target: Arc<Mutex<Option<String>>>,
}

impl ProxyHandle {
    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn set_target(&self, raw: &str) -> Result<(), String> {
        let parsed = url_parse(raw)?;
        *self.target.lock().unwrap() = Some(parsed);
        Ok(())
    }
}

fn url_parse(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("empty url".into());
    }
    let lower = trimmed.to_ascii_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return Err("only http(s) supported".into());
    }
    let scheme_end = trimmed.find("://").ok_or("missing ://")? + 3;
    let rest = &trimmed[scheme_end..];
    let host_end = rest.find('/').unwrap_or(rest.len());
    let host_section = &rest[..host_end];
    if host_section.is_empty() {
        return Err("empty host".into());
    }
    // Strip user:pass@ if present
    let host_only = host_section
        .rsplit_once('@')
        .map(|(_, h)| h)
        .unwrap_or(host_section);
    // Strip port for the dot-check
    let host_no_port = host_only.split(':').next().unwrap_or(host_only);
    let is_local = matches!(host_no_port, "localhost" | "127.0.0.1" | "[::1]" | "::1");
    if !is_local && !host_no_port.contains('.') {
        return Err("single-label host rejected".into());
    }
    Ok(format!("{}{}", &trimmed[..scheme_end], host_section))
}

pub fn start() -> Result<ProxyHandle, String> {
    // Bind synchronously so we can return the chosen port immediately, then
    // hand the listener to a tokio runtime running on a background thread.
    let std_listener =
        std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| format!("bind failed: {e}"))?;
    let port = std_listener
        .local_addr()
        .map_err(|e| format!("local_addr: {e}"))?
        .port();
    std_listener
        .set_nonblocking(true)
        .map_err(|e| format!("nonblocking: {e}"))?;

    let target: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let target_for_thread = target.clone();

    thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .worker_threads(2)
            .thread_name("ezydev-proxy")
            .build()
        {
            Ok(r) => r,
            Err(_) => return,
        };
        rt.block_on(async move {
            let listener = match TcpListener::from_std(std_listener) {
                Ok(l) => l,
                Err(_) => return,
            };
            loop {
                let (stream, _) = match listener.accept().await {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                let io = TokioIo::new(stream);
                let target = target_for_thread.clone();
                tokio::spawn(async move {
                    let svc = service_fn(move |req: Request<Incoming>| {
                        let target = target.clone();
                        async move { Ok::<_, Infallible>(handle_request(req, target).await) }
                    });
                    let _ = http1::Builder::new()
                        .serve_connection(io, svc)
                        .with_upgrades()
                        .await;
                });
            }
        });
    });

    Ok(ProxyHandle { port, target })
}

type BodyResp = BoxBody<Bytes, Infallible>;

fn full_body(b: impl Into<Bytes>) -> BodyResp {
    Full::new(b.into()).boxed()
}

fn empty_body() -> BodyResp {
    Empty::<Bytes>::new().boxed()
}

async fn handle_request(
    req: Request<Incoming>,
    target: Arc<Mutex<Option<String>>>,
) -> Response<BodyResp> {
    // CORS preflight
    if req.method() == hyper::Method::OPTIONS {
        return cors_preflight();
    }

    let target_origin = match target.lock().unwrap().clone() {
        Some(t) => t,
        None => {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "Preview not configured",
                "The preview proxy hasn't been pointed at a target URL yet. Enter a URL in the address bar and press Enter.",
                None,
                None,
            );
        }
    };

    if is_websocket_upgrade(&req) {
        return handle_websocket(req, target_origin).await;
    }

    handle_http(req, target_origin).await
}

fn is_websocket_upgrade(req: &Request<Incoming>) -> bool {
    let h = req.headers();
    let conn_upgrade = h
        .get(CONNECTION)
        .and_then(|v| v.to_str().ok())
        .map(|s| {
            s.split(',')
                .any(|p| p.trim().eq_ignore_ascii_case("upgrade"))
        })
        .unwrap_or(false);
    let upgrade_ws = h
        .get(UPGRADE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false);
    conn_upgrade && upgrade_ws
}

async fn handle_http(req: Request<Incoming>, target_origin: String) -> Response<BodyResp> {
    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|p| p.as_str().to_string())
        .unwrap_or_else(|| "/".into());
    let target_url = format!("{}{}", target_origin, path_and_query);

    let method_str = req.method().as_str().to_string();
    let method = match reqwest::Method::from_bytes(method_str.as_bytes()) {
        Ok(m) => m,
        Err(_) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "Bad request",
                &format!("Unknown method: {method_str}"),
                Some(&target_url),
                None,
            );
        }
    };

    // Snapshot headers to forward, before consuming the body.
    let mut forward_headers: Vec<(String, String)> = Vec::new();
    for (name, value) in req.headers().iter() {
        let n = name.as_str().to_ascii_lowercase();
        if matches!(
            n.as_str(),
            "host" | "origin" | "referer" | "accept-encoding" | "connection"
        ) {
            continue;
        }
        if let Ok(v) = value.to_str() {
            forward_headers.push((name.as_str().to_string(), v.to_string()));
        }
    }

    let body_bytes = match req.into_body().collect().await {
        Ok(c) => c.to_bytes(),
        Err(_) => Bytes::new(),
    };

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .danger_accept_invalid_certs(false)
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Proxy init failed",
                &format!("Could not build HTTP client: {e}"),
                Some(&target_url),
                None,
            );
        }
    };

    let mut builder = client.request(method, &target_url);
    for (n, v) in forward_headers {
        builder = builder.header(&n, v);
    }
    builder = builder.header("accept-encoding", "identity");
    if !body_bytes.is_empty() {
        builder = builder.body(body_bytes.to_vec());
    }

    let proxy_res = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            let (title, detail, hint) = describe_error(&e);
            let hint_ref = if hint.is_empty() { None } else { Some(hint.as_str()) };
            return error_response(
                StatusCode::BAD_GATEWAY,
                &title,
                &detail,
                Some(&target_url),
                hint_ref,
            );
        }
    };

    let status_code = proxy_res.status().as_u16();
    let content_type = proxy_res
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    // Collect response headers, dropping ones that would break injection or framing.
    let mut response_headers: Vec<(String, String)> = Vec::new();
    for (name, value) in proxy_res.headers().iter() {
        let n = name.as_str().to_ascii_lowercase();
        if matches!(
            n.as_str(),
            "content-length"
                | "content-encoding"
                | "transfer-encoding"
                | "content-security-policy"
                | "content-security-policy-report-only"
                | "x-frame-options"
                | "connection"
                | "keep-alive"
        ) {
            continue;
        }
        if let Ok(v) = value.to_str() {
            response_headers.push((name.as_str().to_string(), v.to_string()));
        }
    }
    response_headers.push(("access-control-allow-origin".into(), "*".into()));

    let body_bytes = proxy_res.bytes().await.unwrap_or_default();

    let final_body: Bytes = if content_type.contains("text/html") {
        let html = String::from_utf8_lossy(&body_bytes).into_owned();
        let tag = format!("<script>{}</script>", DEVTOOLS_INJECT_SCRIPT);
        let lower = html.to_ascii_lowercase();
        let injected = if let Some(idx) = lower.find("<head") {
            if let Some(rel_end) = html[idx..].find('>') {
                let end = idx + rel_end + 1;
                let mut out = String::with_capacity(html.len() + tag.len());
                out.push_str(&html[..end]);
                out.push_str(&tag);
                out.push_str(&html[end..]);
                out
            } else {
                format!("{tag}{html}")
            }
        } else {
            format!("{tag}{html}")
        };
        Bytes::from(injected.into_bytes())
    } else {
        body_bytes
    };

    let mut builder =
        Response::builder().status(StatusCode::from_u16(status_code).unwrap_or(StatusCode::OK));
    for (n, v) in response_headers {
        if let (Ok(name), Ok(val)) = (
            HeaderName::try_from(n.as_bytes()),
            HeaderValue::from_str(&v),
        ) {
            builder = builder.header(name, val);
        }
    }
    builder
        .body(full_body(final_body))
        .unwrap_or_else(|_| internal_error())
}

async fn handle_websocket(
    req: Request<Incoming>,
    target_origin: String,
) -> Response<BodyResp> {
    // Validate WS handshake fields.
    let key = match req
        .headers()
        .get(SEC_WEBSOCKET_KEY)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
    {
        Some(k) if !k.is_empty() => k,
        _ => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "Bad WebSocket request",
                "Missing Sec-WebSocket-Key header.",
                None,
                None,
            );
        }
    };

    let subprotocol = req
        .headers()
        .get(SEC_WEBSOCKET_PROTOCOL)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|p| p.as_str().to_string())
        .unwrap_or_else(|| "/".into());

    // Build upstream WS URL by swapping http(s) → ws(s) on the configured target.
    let upstream_url = if let Some(rest) = target_origin.strip_prefix("http://") {
        format!("ws://{rest}{path_and_query}")
    } else if let Some(rest) = target_origin.strip_prefix("https://") {
        format!("wss://{rest}{path_and_query}")
    } else {
        return error_response(
            StatusCode::BAD_GATEWAY,
            "Bad target",
            "Target origin scheme is unsupported.",
            Some(&target_origin),
            None,
        );
    };

    // Build the upstream WS request, propagating any subprotocol the client asked for.
    let mut upstream_request = match upstream_url.as_str().into_client_request() {
        Ok(r) => r,
        Err(e) => {
            return error_response(
                StatusCode::BAD_GATEWAY,
                "Upstream WS request failed",
                &format!("Could not build upstream WebSocket request: {e}"),
                Some(&upstream_url),
                None,
            );
        }
    };
    if let Some(ref sp) = subprotocol {
        if let Ok(v) = HeaderValue::from_str(sp) {
            upstream_request
                .headers_mut()
                .insert(SEC_WEBSOCKET_PROTOCOL, v);
        }
    }

    let (upstream_ws, upstream_resp) =
        match tokio_tungstenite::connect_async(upstream_request).await {
            Ok(pair) => pair,
            Err(e) => {
                return error_response(
                    StatusCode::BAD_GATEWAY,
                    "Can't reach the dev server",
                    &format!("WebSocket connect failed: {e}"),
                    Some(&upstream_url),
                    Some("<b>Tip:</b> make sure your dev server is running and supports WebSocket connections (HMR)."),
                );
            }
        };

    // Echo whichever subprotocol the upstream actually accepted (if any).
    let accepted_protocol = upstream_resp
        .headers()
        .get(SEC_WEBSOCKET_PROTOCOL)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    // Spawn the bridge once the client side completes the upgrade.
    let on_upgrade = hyper::upgrade::on(req);
    tokio::spawn(async move {
        let upgraded = match on_upgrade.await {
            Ok(u) => u,
            Err(_) => return,
        };
        let upgraded = TokioIo::new(upgraded);
        let client_ws = WebSocketStream::from_raw_socket(upgraded, Role::Server, None).await;
        bridge_ws(client_ws, upstream_ws).await;
    });

    // Build the 101 response for the client.
    let accept = derive_accept_key(key.as_bytes());
    let mut builder = Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header(UPGRADE, "websocket")
        .header(CONNECTION, "upgrade")
        .header(SEC_WEBSOCKET_ACCEPT, accept);
    if let Some(p) = accepted_protocol {
        if let Ok(v) = HeaderValue::from_str(&p) {
            builder = builder.header(SEC_WEBSOCKET_PROTOCOL, v);
        }
    }
    builder
        .body(empty_body())
        .unwrap_or_else(|_| internal_error())
}

async fn bridge_ws<S1, S2>(client: WebSocketStream<S1>, upstream: WebSocketStream<S2>)
where
    S1: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    S2: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut client_tx, mut client_rx) = client.split();
    let (mut upstream_tx, mut upstream_rx) = upstream.split();

    // Forward in both directions until either side closes.
    let c2u = async {
        while let Some(msg) = client_rx.next().await {
            match msg {
                Ok(m) => {
                    if upstream_tx.send(m).await.is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = upstream_tx.close().await;
    };
    let u2c = async {
        while let Some(msg) = upstream_rx.next().await {
            match msg {
                Ok(m) => {
                    if client_tx.send(m).await.is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = client_tx.close().await;
    };
    tokio::join!(c2u, u2c);
}

fn cors_preflight() -> Response<BodyResp> {
    Response::builder()
        .status(StatusCode::NO_CONTENT)
        .header("access-control-allow-origin", "*")
        .header("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS")
        .header("access-control-allow-headers", "*")
        .body(empty_body())
        .unwrap_or_else(|_| internal_error())
}

fn internal_error() -> Response<BodyResp> {
    Response::builder()
        .status(StatusCode::INTERNAL_SERVER_ERROR)
        .body(empty_body())
        .unwrap()
}

fn describe_error(err: &reqwest::Error) -> (String, String, String) {
    let msg = err.to_string();
    let lower = msg.to_ascii_lowercase();
    if lower.contains("dns") || lower.contains("name resolution") || lower.contains("not known") {
        (
            "Host not found".into(),
            "DNS lookup failed for this address.".into(),
            "<b>Tip:</b> double-check the URL for typos.".into(),
        )
    } else if lower.contains("connection refused") {
        (
            "Connection refused".into(),
            "Nothing is listening on this address. The dev server may have stopped, crashed, or hasn't started yet.".into(),
            "<b>Tip:</b> start your dev server (e.g. <code>npm run dev</code>) and then refresh.".into(),
        )
    } else if err.is_timeout() {
        (
            "Request timed out".into(),
            "The target server didn't respond in time.".into(),
            "<b>Tip:</b> make sure the server is responsive, then refresh.".into(),
        )
    } else {
        (
            "Can't reach the page".into(),
            msg,
            String::new(),
        )
    }
}

fn error_response(
    status: StatusCode,
    title: &str,
    detail: &str,
    target: Option<&str>,
    hint: Option<&str>,
) -> Response<BodyResp> {
    let html = render_error_page(title, detail, target, hint);
    Response::builder()
        .status(status)
        .header("content-type", "text/html; charset=utf-8")
        .header("access-control-allow-origin", "*")
        .body(full_body(html))
        .unwrap_or_else(|_| internal_error())
}

fn render_error_page(
    title: &str,
    detail: &str,
    target: Option<&str>,
    hint: Option<&str>,
) -> String {
    let target_block = target
        .map(|t| format!(r#"<code class="target">{}</code>"#, html_escape(t)))
        .unwrap_or_default();
    let hint_block = hint
        .filter(|h| !h.is_empty())
        .map(|h| format!(r#"<div class="hint">{h}</div>"#))
        .unwrap_or_default();
    format!(
        r##"<!doctype html><html><head><meta charset="utf-8"><title>{t}</title>
<style>
:root{{color-scheme:dark;}}
html,body{{margin:0;padding:0;height:100%;background:#0d1117;color:#e6edf3;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  -webkit-font-smoothing:antialiased;}}
.wrap{{min-height:100%;display:flex;align-items:center;justify-content:center;padding:32px;}}
.card{{max-width:480px;width:100%;background:#161b22;border:1px solid #30363d;
  border-radius:8px;padding:28px 28px 24px;box-shadow:0 8px 24px rgba(0,0,0,0.3);}}
.icon{{width:44px;height:44px;border-radius:50%;background:rgba(248,81,73,0.12);
  display:flex;align-items:center;justify-content:center;margin-bottom:16px;}}
h1{{margin:0 0 8px;font-size:16px;font-weight:600;color:#e6edf3;letter-spacing:-0.01em;}}
p{{margin:0 0 14px;font-size:13px;line-height:1.55;color:#8b949e;}}
.target{{display:block;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:12px;background:#1c2128;border:1px solid #30363d;border-radius:4px;
  padding:6px 10px;color:#c9d1d9;word-break:break-all;margin-bottom:14px;}}
.hint{{font-size:12px;color:#8b949e;border-top:1px solid #21262d;padding-top:12px;margin-top:4px;}}
.hint b{{color:#c9d1d9;font-weight:600;}}
</style></head><body><div class="wrap"><div class="card">
<div class="icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f85149" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
<h1>{t}</h1><p>{d}</p>{target_block}{hint_block}
</div></div></body></html>"##,
        t = html_escape(title),
        d = html_escape(detail),
    )
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
