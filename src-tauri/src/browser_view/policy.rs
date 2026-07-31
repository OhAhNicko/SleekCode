// Security policy for the native browser pane.
//
// This module is the trust boundary between a visited website and MADE. It is
// deliberately `cfg`-free and dependency-free so it can be compiled and tested
// standalone in WSL with `rustc --test` — the Windows toolchain is not needed to
// prove the rules, and these are the rules that must not regress.
//
// WHY THIS EXISTS AT ALL. The browsing webview is built with wry directly rather
// than through Tauri, because a Tauri-hosted webview injects the invoke key into
// EVERY page's main frame with no origin gate (tauri manager/webview.rs:176) over
// an IPC transport any page can reach (wry webview2/mod.rs:880-886), and app
// commands skip the ACL entirely when the app declares no manifest
// (tauri webview/mod.rs:1802 — MADE declares none, build.rs:8). A page in a Tauri
// webview could therefore read `__TAURI_INVOKE_KEY__` off its own window and call
// read_file / write_file / pty_spawn. Hosting with wry means no Tauri bootstrap,
// no invoke key and no command bridge exist in that webview at all.
//
// What remains reachable is exactly what this file governs:
//   1. Which URLs the webview may navigate to      -> is_navigation_allowed
//   2. What may cross the one IPC channel we own   -> parse_devtools_envelope
//
// Both treat their input as hostile. The injected DevTools script runs in the
// page's world, so a malicious page can tamper with it, forge its messages and
// flood the channel.

/// Hard cap on a single IPC message. The DevTools batch is small; anything near
/// this is either a bug or an attack. Rejected wholesale rather than truncated —
/// a truncated JSON payload is just a parse failure with extra steps.
pub const MAX_IPC_BYTES: usize = 64 * 1024;

/// Max entries accepted in one batch.
pub const MAX_BATCH_ITEMS: usize = 200;

/// Max characters kept from a single record's payload. Longer values are
/// truncated (not rejected) — a genuinely long console line is normal.
///
/// Sized for the STORAGE snapshot, which is one payload carrying every
/// localStorage/sessionStorage/cookie entry. At the old 4096 it was truncated
/// mid-JSON, so `JSON.parse` failed on the JS side and the Storage tab silently
/// stayed empty. The injected script also bounds the snapshot (key count and
/// per-value length), so this ceiling should never actually be reached; it stays
/// well under MAX_IPC_BYTES so a batch of them still fits one envelope.
pub const MAX_ITEM_TEXT: usize = 32 * 1024;

/// Outcome of checking a navigation request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavDecision {
    /// Normal web navigation.
    Allow,
    /// Blocked, with a stable reason string for logging + the DevTools panel.
    Block(BlockReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockReason {
    /// `file:` — would let a page read local files and exfiltrate them.
    LocalFile,
    /// MADE's own webview origin (`*.localhost` custom protocols) or `tauri:`.
    AppOrigin,
    /// `javascript:` — script injection through the address bar / a link.
    JavascriptUrl,
    /// `data:` / `blob:` at top level — phishing and exfiltration vector.
    InlineDocument,
    /// Anything else that is not http(s): custom schemes, ftp, mailto handlers…
    UnsupportedScheme,
    /// Malformed / unparseable.
    Malformed,
}

impl BlockReason {
    pub fn as_str(self) -> &'static str {
        match self {
            BlockReason::LocalFile => "local file access is blocked",
            BlockReason::AppOrigin => "navigation to MADE's own origin is blocked",
            BlockReason::JavascriptUrl => "javascript: URLs are blocked",
            BlockReason::InlineDocument => "data:/blob: documents are blocked",
            BlockReason::UnsupportedScheme => "only http and https are supported",
            BlockReason::Malformed => "malformed URL",
        }
    }
}

/// Lowercased scheme of a URL, without allocating a parser dependency.
/// Returns None when there is no `:` or the scheme has invalid characters.
fn scheme_of(url: &str) -> Option<String> {
    let trimmed = url.trim();
    let colon = trimmed.find(':')?;
    if colon == 0 {
        return None;
    }
    let scheme = &trimmed[..colon];
    // RFC 3986: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )
    let mut chars = scheme.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphabetic() {
        return None;
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.') {
        return None;
    }
    Some(scheme.to_ascii_lowercase())
}

/// Host portion of an http(s) URL, lowercased, port stripped.
fn host_of(url: &str) -> Option<String> {
    let trimmed = url.trim();
    let after_scheme = trimmed.split_once("://")?.1;
    // Authority ends at the first '/', '?' or '#'.
    let end = after_scheme
        .find(|c| c == '/' || c == '?' || c == '#')
        .unwrap_or(after_scheme.len());
    let authority = &after_scheme[..end];
    // Strip userinfo.
    let hostport = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority);
    if hostport.is_empty() {
        return None;
    }
    // IPv6 literal.
    if let Some(rest) = hostport.strip_prefix('[') {
        let close = rest.find(']')?;
        return Some(format!("[{}]", rest[..close].to_ascii_lowercase()));
    }
    let host = hostport.split(':').next().unwrap_or(hostport);
    if host.is_empty() {
        return None;
    }
    Some(host.to_ascii_lowercase())
}

/// Is this host one of MADE's own webview origins?
///
/// Tauri serves the app over `http://<protocol>.localhost` on Windows (`tauri`,
/// `ipc`, `asset`, …). A bare `localhost` is NOT included: that is where the
/// user's dev servers live and is a legitimate browsing target.
fn is_app_origin_host(host: &str) -> bool {
    host.ends_with(".localhost")
}

/// The single navigation gate. Applied to every navigation the webview attempts,
/// including redirects and in-page link clicks.
pub fn classify_navigation(url: &str) -> NavDecision {
    let trimmed = url.trim();

    // A blank document is how the pane starts before any URL is entered.
    if trimmed.eq_ignore_ascii_case("about:blank") {
        return NavDecision::Allow;
    }

    let scheme = match scheme_of(trimmed) {
        Some(s) => s,
        None => return NavDecision::Block(BlockReason::Malformed),
    };

    match scheme.as_str() {
        "http" | "https" => {
            let host = match host_of(trimmed) {
                Some(h) => h,
                None => return NavDecision::Block(BlockReason::Malformed),
            };
            if is_app_origin_host(&host) {
                return NavDecision::Block(BlockReason::AppOrigin);
            }
            NavDecision::Allow
        }
        "file" => NavDecision::Block(BlockReason::LocalFile),
        "javascript" => NavDecision::Block(BlockReason::JavascriptUrl),
        "data" | "blob" => NavDecision::Block(BlockReason::InlineDocument),
        // `tauri:`, `asset:`, `ipc:` and every other custom or exotic scheme.
        _ => {
            if scheme == "tauri" || scheme == "asset" || scheme == "ipc" {
                NavDecision::Block(BlockReason::AppOrigin)
            } else {
                NavDecision::Block(BlockReason::UnsupportedScheme)
            }
        }
    }
}

/// Convenience wrapper for the wry navigation handler, which wants a bare bool.
pub fn is_navigation_allowed(url: &str) -> bool {
    matches!(classify_navigation(url), NavDecision::Allow)
}

/// A single DevTools record, already clamped. `kind` is validated against a
/// closed set; free-form strings are length-capped. Nothing here is ever
/// interpreted as a command — it exists only to be displayed as text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevtoolsItem {
    pub kind: String,
    pub payload: String,
}

/// Kinds the panel understands. An unknown kind is dropped rather than passed
/// through, so a hostile page cannot invent a message type and hope some future
/// consumer handles it.
const ALLOWED_KINDS: &[&str] = &[
    "console",
    "network",
    "inspect-result",
    "storage",
    "url",
    "ready",
    // Page focus/blur. The browsing webview takes REAL Win32 focus (you type in
    // it), which blurs MADE's main webview — without this the app would read as
    // unfocused and drop its accent ring while you browse.
    "focus",
    // Navigation-history depth (canGoBack/canGoForward booleans) so the
    // toolbar can gray its back/forward buttons like a real browser. Reported
    // by the page's Navigation API; untrusted like everything else here.
    "navstate",
    // Right-click position + what sits under the cursor (link / image /
    // selection). UNTRUSTED like everything else here: a hostile page can forge
    // any of it, so the URLs it reports are scheme-checked before the menu
    // offers to open or copy them, and nothing is ever acted on automatically.
    "ctxmenu",
];

pub fn is_allowed_kind(kind: &str) -> bool {
    ALLOWED_KINDS.contains(&kind)
}

/// Truncate on a char boundary so the result is always valid UTF-8.
pub fn clamp_text(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

/// Why an IPC message was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IpcReject {
    TooLarge,
    NotJson,
    WrongShape,
    NoValidItems,
}

/// Parse the one envelope the browsing webview is allowed to send.
///
/// Shape: `{"v":1,"kind":"devtools","items":[{"kind":"console","payload":"…"}]}`
///
/// Everything else is refused. This is intentionally strict and boring: the
/// channel's only job is to carry text to a panel, so there is no reason to
/// accept anything clever.
pub fn parse_devtools_envelope(raw: &str) -> Result<Vec<DevtoolsItem>, IpcReject> {
    if raw.len() > MAX_IPC_BYTES {
        return Err(IpcReject::TooLarge);
    }
    let value: serde_json::Value = serde_json::from_str(raw).map_err(|_| IpcReject::NotJson)?;
    let obj = value.as_object().ok_or(IpcReject::WrongShape)?;

    if obj.get("v").and_then(|v| v.as_u64()) != Some(1) {
        return Err(IpcReject::WrongShape);
    }
    if obj.get("kind").and_then(|v| v.as_str()) != Some("devtools") {
        return Err(IpcReject::WrongShape);
    }
    let items = obj
        .get("items")
        .and_then(|v| v.as_array())
        .ok_or(IpcReject::WrongShape)?;

    let mut out = Vec::new();
    for item in items.iter().take(MAX_BATCH_ITEMS) {
        let Some(o) = item.as_object() else { continue };
        let Some(kind) = o.get("kind").and_then(|v| v.as_str()) else {
            continue;
        };
        if !is_allowed_kind(kind) {
            continue;
        }
        // `payload` is carried as an opaque JSON string. The panel parses it;
        // Rust never interprets it.
        let payload = match o.get("payload") {
            Some(serde_json::Value::String(s)) => clamp_text(s, MAX_ITEM_TEXT),
            Some(other) => clamp_text(&other.to_string(), MAX_ITEM_TEXT),
            None => continue,
        };
        out.push(DevtoolsItem {
            kind: kind.to_string(),
            payload,
        });
    }

    if out.is_empty() {
        return Err(IpcReject::NoValidItems);
    }
    Ok(out)
}

/* ------------------------------------------------------------------ */
/*  Downloads                                                          */
/* ------------------------------------------------------------------ */

// Downloads follow Chrome's behaviour: allowed, written to the user's Downloads
// folder without a prompt, with conflicting names uniquified rather than
// overwritten.
//
// The filename is attacker-controlled — it comes from the server's
// Content-Disposition header or the URL — so it is the security-sensitive part.
// Chrome sanitises it to a bare name inside the download directory; so do we.
// Without this, a suggested name like `..\..\Windows\System32\evil.dll` would
// escape the folder, and a page could write anywhere the user can.

/// Characters Windows forbids in a file name, plus the path separators.
const ILLEGAL_FILENAME_CHARS: &[char] =
    &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// Windows reserved device names. Creating `CON`, `NUL`, `COM1`… does not make a
/// file, so these are prefixed rather than used verbatim.
const RESERVED_STEMS: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6",
    "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6",
    "lpt7", "lpt8", "lpt9",
];

/// Longest file name we will write. Well under MAX_PATH so the joined path
/// survives a deep Downloads folder.
const MAX_FILENAME_LEN: usize = 180;

/// Reduce a server-suggested name to a safe bare file name.
///
/// Never returns an empty string, a path, or a reserved device name.
pub fn sanitize_download_filename(suggested: &str) -> String {
    // 1. Keep only the last path component — this is what defeats traversal
    //    (`../../x`, `C:\Windows\x`, `a/b/c`).
    let last = suggested
        .rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or("");

    // 2. Drop control characters and anything Windows forbids.
    let mut cleaned: String = last
        .chars()
        .filter(|c| !c.is_control() && !ILLEGAL_FILENAME_CHARS.contains(c))
        .collect();

    // 3. Windows silently strips trailing dots/spaces, which is a classic way to
    //    smuggle a different name past a check. Strip them ourselves.
    while cleaned.ends_with('.') || cleaned.ends_with(' ') {
        cleaned.pop();
    }
    let cleaned = cleaned.trim_start().to_string();

    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        return "download".to_string();
    }

    // 4. Reserved device names, with or without an extension.
    let stem = cleaned.split('.').next().unwrap_or("").to_ascii_lowercase();
    let mut out = if RESERVED_STEMS.contains(&stem.as_str()) {
        format!("_{cleaned}")
    } else {
        cleaned
    };

    // 5. Cap the length, keeping the extension so the file still opens.
    if out.len() > MAX_FILENAME_LEN {
        let ext = match out.rfind('.') {
            // Only treat a short trailing segment as an extension.
            Some(i) if out.len() - i <= 12 => out[i..].to_string(),
            _ => String::new(),
        };
        let keep = MAX_FILENAME_LEN.saturating_sub(ext.len());
        let mut head = out[..keep.min(out.len())].to_string();
        while !head.is_empty() && !out.is_char_boundary(head.len()) {
            head.pop();
        }
        out = format!("{head}{ext}");
    }
    out
}

/// Chrome's conflict rule: `report.pdf` -> `report (1).pdf` -> `report (2).pdf`.
/// The suffix goes before the extension, never after.
pub fn numbered_variant(filename: &str, n: u32) -> String {
    match filename.rfind('.') {
        // A leading dot is a dotfile, not an extension (`.env` -> `.env (1)`).
        Some(i) if i > 0 => format!("{} ({}){}", &filename[..i], n, &filename[i..]),
        _ => format!("{filename} ({n})"),
    }
}

/// Token-bucket rate limiter for the IPC channel.
///
/// A hostile page can call `window.ipc.postMessage` in a tight loop. Without a
/// limiter that is an unbounded work generator on the UI thread. Refills at
/// `per_sec` and bursts to `capacity`; over-budget messages are dropped, never
/// queued (queuing just moves the flood).
#[derive(Debug)]
pub struct RateLimiter {
    capacity: f64,
    tokens: f64,
    per_sec: f64,
}

impl RateLimiter {
    pub fn new(capacity: f64, per_sec: f64) -> Self {
        Self {
            capacity,
            tokens: capacity,
            per_sec,
        }
    }

    /// `elapsed_secs` since the previous call. Returns true if allowed.
    pub fn allow(&mut self, elapsed_secs: f64) -> bool {
        self.tokens = (self.tokens + elapsed_secs * self.per_sec).min(self.capacity);
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_ordinary_web_urls() {
        assert!(is_navigation_allowed("https://www.google.se/"));
        assert!(is_navigation_allowed("http://google.se"));
        assert!(is_navigation_allowed("https://example.com/a/b?c=d#e"));
        assert!(is_navigation_allowed("about:blank"));
        assert!(is_navigation_allowed("ABOUT:BLANK"));
    }

    #[test]
    fn allows_localhost_dev_servers() {
        // Bare localhost is the user's own dev server — a legitimate target.
        assert!(is_navigation_allowed("http://localhost:1420/"));
        assert!(is_navigation_allowed("http://127.0.0.1:5173/index.html"));
        assert!(is_navigation_allowed("http://[::1]:8080/"));
    }

    #[test]
    fn blocks_local_file_access() {
        for u in [
            "file:///C:/Windows/win.ini",
            "file://localhost/etc/passwd",
            "FILE:///C:/secret.txt",
            "  file:///C:/leading-space.txt",
        ] {
            assert_eq!(
                classify_navigation(u),
                NavDecision::Block(BlockReason::LocalFile),
                "should block {u}"
            );
        }
    }

    #[test]
    fn blocks_made_own_origin() {
        for u in [
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/",
            "http://asset.localhost/x",
            "http://ipc.localhost/",
            "tauri://localhost",
        ] {
            assert_eq!(
                classify_navigation(u),
                NavDecision::Block(BlockReason::AppOrigin),
                "should block {u}"
            );
        }
    }

    #[test]
    fn blocks_script_and_inline_documents() {
        assert_eq!(
            classify_navigation("javascript:alert(1)"),
            NavDecision::Block(BlockReason::JavascriptUrl)
        );
        assert_eq!(
            classify_navigation("JavaScript:void(0)"),
            NavDecision::Block(BlockReason::JavascriptUrl)
        );
        assert_eq!(
            classify_navigation("data:text/html,<h1>hi"),
            NavDecision::Block(BlockReason::InlineDocument)
        );
        assert_eq!(
            classify_navigation("blob:https://x.com/uuid"),
            NavDecision::Block(BlockReason::InlineDocument)
        );
    }

    #[test]
    fn blocks_exotic_schemes() {
        for u in ["ftp://x.com/", "mailto:a@b.c", "ms-msdt:/id", "vbscript:x"] {
            assert!(!is_navigation_allowed(u), "should block {u}");
        }
    }

    #[test]
    fn userinfo_cannot_smuggle_an_app_origin() {
        // The authority parser must take the host AFTER '@', not before, or
        // `https://tauri.localhost@evil.com` would be misread (and vice versa).
        assert_eq!(host_of("https://tauri.localhost@evil.com/").as_deref(), Some("evil.com"));
        assert!(is_navigation_allowed("https://tauri.localhost@evil.com/"));
        assert_eq!(host_of("https://user:pw@tauri.localhost/").as_deref(), Some("tauri.localhost"));
        assert_eq!(
            classify_navigation("https://user:pw@tauri.localhost/"),
            NavDecision::Block(BlockReason::AppOrigin)
        );
    }

    #[test]
    fn malformed_urls_are_blocked_not_allowed() {
        for u in ["", "   ", "://nope", "not a url", "1http://x.com"] {
            assert!(!is_navigation_allowed(u), "should block {u:?}");
        }
    }

    #[test]
    fn accepts_a_well_formed_devtools_batch() {
        let raw = r#"{"v":1,"kind":"devtools","items":[
            {"kind":"console","payload":"hello"},
            {"kind":"url","payload":"https://x.com/"}
        ]}"#;
        let items = parse_devtools_envelope(raw).expect("should parse");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].kind, "console");
        assert_eq!(items[0].payload, "hello");
    }

    #[test]
    fn rejects_oversized_messages() {
        let huge = format!(
            r#"{{"v":1,"kind":"devtools","items":[{{"kind":"console","payload":"{}"}}]}}"#,
            "a".repeat(MAX_IPC_BYTES)
        );
        assert_eq!(parse_devtools_envelope(&huge), Err(IpcReject::TooLarge));
    }

    #[test]
    fn rejects_wrong_shapes() {
        assert_eq!(parse_devtools_envelope("not json"), Err(IpcReject::NotJson));
        assert_eq!(parse_devtools_envelope("[]"), Err(IpcReject::WrongShape));
        // Missing/!=1 version
        assert_eq!(
            parse_devtools_envelope(r#"{"kind":"devtools","items":[]}"#),
            Err(IpcReject::WrongShape)
        );
        // A different envelope kind must not be honoured.
        assert_eq!(
            parse_devtools_envelope(r#"{"v":1,"kind":"invoke","items":[]}"#),
            Err(IpcReject::WrongShape)
        );
    }

    #[test]
    fn focus_is_an_allowed_kind() {
        assert!(is_allowed_kind("focus"));
        let raw = r#"{"v":1,"kind":"devtools","items":[{"kind":"focus","payload":"1"}]}"#;
        assert_eq!(parse_devtools_envelope(raw).unwrap().len(), 1);
    }

    #[test]
    fn drops_unknown_item_kinds() {
        // The critical case: a page inventing a message type.
        let raw = r#"{"v":1,"kind":"devtools","items":[
            {"kind":"read_file","payload":"C:/secret"},
            {"kind":"pty_spawn","payload":"cmd.exe"}
        ]}"#;
        assert_eq!(parse_devtools_envelope(raw), Err(IpcReject::NoValidItems));
    }

    #[test]
    fn keeps_valid_items_when_mixed_with_junk() {
        let raw = r#"{"v":1,"kind":"devtools","items":[
            {"kind":"read_file","payload":"C:/secret"},
            {"kind":"console","payload":"real"},
            {"no_kind":true},
            17
        ]}"#;
        let items = parse_devtools_envelope(raw).expect("should parse");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].kind, "console");
    }

    #[test]
    fn caps_batch_length_and_item_text() {
        let one = r#"{"kind":"console","payload":"x"},"#;
        let raw = format!(
            r#"{{"v":1,"kind":"devtools","items":[{}{}]}}"#,
            one.repeat(MAX_BATCH_ITEMS + 50),
            r#"{"kind":"console","payload":"last"}"#
        );
        let items = parse_devtools_envelope(&raw).expect("should parse");
        assert_eq!(items.len(), MAX_BATCH_ITEMS);

        // Truncation applies in the band ABOVE MAX_ITEM_TEXT but BELOW
        // MAX_IPC_BYTES. Past the envelope cap the whole message is rejected
        // instead (see rejects_oversized_messages), so a *2 payload would never
        // reach the truncation path.
        // A *2 payload plus the JSON wrapper exceeds the envelope, so it would
        // be rejected before truncation ever ran.
        assert!(MAX_ITEM_TEXT * 2 >= MAX_IPC_BYTES, "band assumption changed");
        let long = "y".repeat(MAX_ITEM_TEXT + 1_000);
        let raw = format!(
            r#"{{"v":1,"kind":"devtools","items":[{{"kind":"console","payload":"{long}"}}]}}"#
        );
        assert!(raw.len() < MAX_IPC_BYTES, "test payload must fit the envelope");
        let items = parse_devtools_envelope(&raw).expect("should parse");
        assert_eq!(items[0].payload.len(), MAX_ITEM_TEXT);
    }

    #[test]
    fn clamp_never_splits_a_char() {
        // 'é' is 2 bytes: clamping to 1 must not panic or emit invalid UTF-8.
        let s = "é".repeat(10);
        let out = clamp_text(&s, 1);
        assert!(out.is_empty());
        let out = clamp_text(&s, 3);
        assert_eq!(out, "é");
    }

    #[test]
    fn download_names_cannot_escape_the_folder() {
        // THE case that matters: the name comes from the server, so traversal
        // here would let a page write anywhere the user can.
        for (input, want) in [
            ("../../../Windows/System32/evil.dll", "evil.dll"),
            ("..\\..\\Windows\\evil.dll", "evil.dll"),
            ("C:\\Windows\\System32\\drivers\\etc\\hosts", "hosts"),
            ("/etc/passwd", "passwd"),
            ("a/b/c/report.pdf", "report.pdf"),
        ] {
            assert_eq!(sanitize_download_filename(input), want, "input {input}");
        }
    }

    #[test]
    fn download_names_drop_illegal_and_control_chars() {
        assert_eq!(sanitize_download_filename("a<b>c:d\"e|f?g*h.txt"), "abcdefgh.txt");
        assert_eq!(sanitize_download_filename("re\u{0}port\u{7}.pdf"), "report.pdf");
    }

    #[test]
    fn download_names_strip_trailing_dots_and_spaces() {
        // Windows strips these itself, so leaving them in allows two different
        // suggestions to land on the same real file.
        assert_eq!(sanitize_download_filename("report.pdf..."), "report.pdf");
        assert_eq!(sanitize_download_filename("report.pdf   "), "report.pdf");
    }

    #[test]
    fn download_names_never_end_up_empty_or_dotty() {
        for input in ["", "   ", ".", "..", "/", "\\", "..\\", "<<<>>>"] {
            assert_eq!(
                sanitize_download_filename(input),
                "download",
                "input {input:?}"
            );
        }
    }

    #[test]
    fn download_names_avoid_windows_device_names() {
        assert_eq!(sanitize_download_filename("CON"), "_CON");
        assert_eq!(sanitize_download_filename("nul.txt"), "_nul.txt");
        assert_eq!(sanitize_download_filename("COM1.pdf"), "_COM1.pdf");
        // Not reserved — must pass through untouched.
        assert_eq!(sanitize_download_filename("console.log"), "console.log");
    }

    #[test]
    fn download_names_are_length_capped_but_keep_their_extension() {
        let long = format!("{}.pdf", "a".repeat(500));
        let out = sanitize_download_filename(&long);
        assert!(out.len() <= MAX_FILENAME_LEN, "len was {}", out.len());
        assert!(out.ends_with(".pdf"), "lost the extension: {out}");
    }

    #[test]
    fn numbered_variant_matches_chrome() {
        assert_eq!(numbered_variant("report.pdf", 1), "report (1).pdf");
        assert_eq!(numbered_variant("report.pdf", 2), "report (2).pdf");
        assert_eq!(numbered_variant("archive.tar.gz", 1), "archive.tar (1).gz");
        assert_eq!(numbered_variant("README", 1), "README (1)");
        // A dotfile has no extension to sit before.
        assert_eq!(numbered_variant(".env", 1), ".env (1)");
    }

    #[test]
    fn rate_limiter_bursts_then_throttles() {
        let mut rl = RateLimiter::new(10.0, 10.0);
        for _ in 0..10 {
            assert!(rl.allow(0.0), "burst should be allowed");
        }
        assert!(!rl.allow(0.0), "over budget must be dropped");
        // Refills over time.
        assert!(rl.allow(0.2), "should refill after 200ms");
    }
}
