// Preview proxy server.
//
// Runs a local HTTP server that forwards iframe requests to a configured
// target origin, injecting the EzyDev DevTools script into HTML responses
// and stripping framing/CSP headers so the page renders inside our pane.
//
// In dev this used to live in vite.config.ts as a Vite plugin, which meant
// production builds had no proxy. Moving it into Tauri makes the browser
// pane work in both dev and prod with the same code path.

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tiny_http::{Header, Method, Response, Server, StatusCode};

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
    let server = Server::http("127.0.0.1:0")
        .map_err(|e| format!("bind failed: {e}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .ok_or("no ip")?
        .port();

    let target: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let target_for_thread = target.clone();

    thread::spawn(move || {
        let server = Arc::new(server);
        loop {
            let req = match server.recv() {
                Ok(r) => r,
                Err(_) => continue,
            };
            let target = target_for_thread.clone();
            // Spawn per-request so concurrent page assets don't queue.
            thread::spawn(move || handle_request(req, target));
        }
    });

    Ok(ProxyHandle { port, target })
}

fn handle_request(mut req: tiny_http::Request, target: Arc<Mutex<Option<String>>>) {
    // CORS preflight
    if req.method() == &Method::Options {
        let mut res = Response::empty(204);
        for h in cors_headers() {
            res.add_header(h);
        }
        let _ = req.respond(res);
        return;
    }

    let target_origin = match target.lock().unwrap().clone() {
        Some(t) => t,
        None => {
            respond_error(
                req,
                503,
                "Preview not configured",
                "The preview proxy hasn't been pointed at a target URL yet. Enter a URL in the address bar and press Enter.",
                None,
                None,
            );
            return;
        }
    };

    let path = req.url().to_string();
    let target_url = format!("{}{}", target_origin, path);

    // Read inbound body (drain even for GETs — some clients send Content-Length: 0).
    let mut body_bytes: Vec<u8> = Vec::new();
    let _ = req.as_reader().read_to_end(&mut body_bytes);

    // Build outbound request.
    let method_str = req.method().as_str().to_string();
    let method = match reqwest::Method::from_bytes(method_str.as_bytes()) {
        Ok(m) => m,
        Err(_) => {
            respond_error(
                req,
                400,
                "Bad request",
                &format!("Unknown method: {method_str}"),
                Some(&target_url),
                None,
            );
            return;
        }
    };

    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .danger_accept_invalid_certs(false)
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            respond_error(
                req,
                500,
                "Proxy init failed",
                &format!("Could not build HTTP client: {e}"),
                Some(&target_url),
                None,
            );
            return;
        }
    };

    let mut req_builder = client.request(method, &target_url);
    for header in req.headers() {
        let name = header.field.as_str().as_str().to_ascii_lowercase();
        if matches!(
            name.as_str(),
            "host" | "origin" | "referer" | "accept-encoding" | "connection"
        ) {
            continue;
        }
        let value = header.value.as_str();
        req_builder = req_builder.header(header.field.as_str().as_str(), value);
    }
    req_builder = req_builder.header("accept-encoding", "identity");
    if !body_bytes.is_empty() {
        req_builder = req_builder.body(body_bytes);
    }

    let proxy_res = match req_builder.send() {
        Ok(r) => r,
        Err(e) => {
            let (title, detail, hint) = describe_error(&e);
            respond_error(req, 502, &title, &detail, Some(&target_url), Some(&hint));
            return;
        }
    };

    let status_code = proxy_res.status().as_u16();
    let content_type = proxy_res
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    // Collect headers, dropping ones that would break injection or framing.
    let mut headers_out: Vec<Header> = Vec::new();
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
        let v = match value.to_str() {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Ok(h) = Header::from_bytes(name.as_str().as_bytes(), v.as_bytes()) {
            headers_out.push(h);
        }
    }
    if let Ok(h) = Header::from_bytes(b"access-control-allow-origin", b"*") {
        headers_out.push(h);
    }

    let body = proxy_res.bytes().unwrap_or_default().to_vec();

    let final_body: Vec<u8> = if content_type.contains("text/html") {
        let html = String::from_utf8_lossy(&body).into_owned();
        let tag = format!("<script>{}</script>", DEVTOOLS_INJECT_SCRIPT);
        // Find first <head ...> open tag (case-insensitive) and inject after it.
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
        injected.into_bytes()
    } else {
        body
    };

    let status = StatusCode(status_code);
    let body_len = final_body.len();
    let cursor = std::io::Cursor::new(final_body);
    let response = Response::new(status, headers_out, cursor, Some(body_len), None);
    let _ = req.respond(response);
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

fn cors_headers() -> Vec<Header> {
    vec![
        Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap(),
        Header::from_bytes(&b"Access-Control-Allow-Methods"[..], &b"GET,POST,PUT,DELETE,OPTIONS"[..]).unwrap(),
        Header::from_bytes(&b"Access-Control-Allow-Headers"[..], &b"*"[..]).unwrap(),
    ]
}

fn respond_error(
    req: tiny_http::Request,
    status: u16,
    title: &str,
    detail: &str,
    target: Option<&str>,
    hint: Option<&str>,
) {
    let html = render_error_page(title, detail, target, hint);
    let mut response = Response::from_string(html).with_status_code(status);
    if let Ok(h) = Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]) {
        response.add_header(h);
    }
    if let Ok(h) = Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]) {
        response.add_header(h);
    }
    let _ = req.respond(response);
}

fn render_error_page(title: &str, detail: &str, target: Option<&str>, hint: Option<&str>) -> String {
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
