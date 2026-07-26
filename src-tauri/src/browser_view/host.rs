// Windows host for the native browser pane: a wry WebView living in a child HWND
// of the main window, positioned over the pane's anchor div.
//
// WHY WRY DIRECTLY (not tauri's add_child) — see browser_view/policy.rs and the
// comment beside the `wry` dependency in Cargo.toml. Short version: a Tauri-hosted
// webview hands every page it loads the invoke key over an IPC bridge that reaches
// MADE's unguarded app commands. Hosting with wry means that bridge does not exist
// in this webview; the only channel is the single DevTools envelope, validated by
// `policy::parse_devtools_envelope`.
//
// THREADING (load-bearing). `wry::WebView` is NOT `Send` on Windows — the WebView2
// controller is apartment-threaded COM. So unlike native_term's `Send` HWND wrapper,
// the registry cannot be a `static Mutex<HashMap<..>>`; it lives in a main-thread
// `thread_local!` and every entry point hops through `AppHandle::run_on_main_thread`.
// `on_main` blocks on a reply channel, which is safe ONLY because Tauri runs command
// handlers off the main thread. Never call `on_main` from a main-thread context.
//
// Z-ORDER. WebView2 is itself a WS_CHILD of the main window, so a freshly created
// sibling can land underneath it. Same trap native_term solved: assert HWND_TOP on
// create and on every show (`bring_above_siblings`).

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::Instant;

use tauri::{AppHandle, Emitter, Manager};
use wry::dpi::{PhysicalPosition, PhysicalSize};
use wry::{NewWindowResponse, Rect as WryRect, WebContext, WebView, WebViewBuilder};

use super::policy::{self, RateLimiter};
use super::{PaneRect, HOST_INIT_SCRIPT};

/// Burst / sustained budget for the DevTools IPC channel, per view.
/// A chatty page is normal; a flooding page is not.
const IPC_BURST: f64 = 120.0;
const IPC_PER_SEC: f64 = 60.0;

struct HostedView {
    webview: WebView,
    /// Container HWND, cached so show/hide can re-assert z-order without going
    /// back through COM.
    hwnd: isize,
    limiter: RateLimiter,
    last_ipc: Instant,
    /// URLs the user has explicitly approved, each good for ONE download.
    ///
    /// The prompt model is cancel-first: an unapproved download is refused
    /// outright, so nothing reaches disk before the decision. Approving inserts
    /// the URL here and re-triggers the download inside the SAME webview, so
    /// cookies and session still apply; the second attempt finds the token,
    /// consumes it, and proceeds. Single-use, so approving one download can
    /// never stand in for the next.
    allowed_downloads: HashSet<String>,
}

thread_local! {
    /// Main-thread-only registry. See the THREADING note above.
    static VIEWS: RefCell<HashMap<u32, HostedView>> = RefCell::new(HashMap::new());

    /// ONE browsing profile shared by every browser pane: its own WebView2
    /// environment and user-data folder, so browsing cookies never mix with
    /// MADE's app webview state, and logins survive a restart.
    static CONTEXT: RefCell<Option<WebContext>> = const { RefCell::new(None) };

    /// Re-entrancy guard for `create`.
    ///
    /// wry's build PUMPS THE WINDOWS MESSAGE LOOP while it waits for the
    /// WebView2 environment and controller callbacks. Anything already queued
    /// for the main thread therefore runs *inside* the build — including another
    /// `run_on_main_thread` closure from a second pane. Holding a RefCell borrow
    /// of CONTEXT across the build would make that a panic (already-borrowed) in
    /// a wnd_proc, which on Windows aborts the process rather than unwinding.
    /// So the context is taken OUT for the duration and this flag rejects the
    /// re-entrant create instead.
    static CREATING: Cell<bool> = const { Cell::new(false) };
}

/// Where the browsing profile lives. Deliberately a sibling of, never inside,
/// MADE's own WebView2 data directory.
fn profile_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app
        .path()
        .app_local_data_dir()
        .ok()
        .map(|d| d.join("browser-profile"))?;
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("[browser_view] could not create profile dir {dir:?}: {e}");
        return None;
    }
    Some(dir)
}

/// Parent-HWND adapter so wry's `build_as_child` can take MADE's main window,
/// which the app stores as a bare `isize`.
struct ParentWindow(isize);

impl raw_window_handle::HasWindowHandle for ParentWindow {
    fn window_handle(
        &self,
    ) -> Result<raw_window_handle::WindowHandle<'_>, raw_window_handle::HandleError> {
        let nz = std::num::NonZeroIsize::new(self.0)
            .ok_or(raw_window_handle::HandleError::Unavailable)?;
        let handle = raw_window_handle::Win32WindowHandle::new(nz);
        // SAFETY: the HWND belongs to the main window, which outlives every
        // browser pane (panes are torn down on window close / page reload).
        Ok(unsafe {
            raw_window_handle::WindowHandle::borrow_raw(raw_window_handle::RawWindowHandle::Win32(
                handle,
            ))
        })
    }
}

fn to_wry_rect(rect: &PaneRect, dpr: f32) -> WryRect {
    // ONE scaling model, matching native_term: logical CSS px * dpr = physical px.
    // Passing physical explicitly rather than letting wry infer from HWND DPI
    // keeps the pane's geometry identical to the terminal panes'.
    let x = (rect.x * dpr).round() as i32;
    let y = (rect.y * dpr).round() as i32;
    let w = (rect.width * dpr).round().max(1.0) as u32;
    let h = (rect.height * dpr).round().max(1.0) as u32;
    WryRect {
        position: PhysicalPosition::new(x, y).into(),
        size: PhysicalSize::new(w, h).into(),
    }
}

/// Lift the container above its siblings — WebView2 is also a WS_CHILD and will
/// otherwise paint over the pane. Mirrors native_term's `bring_above_siblings`.
fn bring_above_siblings(hwnd: isize) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOP, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };
    if hwnd == 0 {
        return;
    }
    unsafe {
        let _ = SetWindowPos(
            HWND(hwnd as *mut _),
            HWND_TOP,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}

/// Clip the container to a rounded rect, matching the pane's CSS.
///
/// DESIGN PARITY, not decoration: under a viewport preset the iframe sits in a
/// `borderRadius: 4` + `overflow: hidden` wrapper. A child HWND ignores both —
/// CSS cannot clip an OS window — so without this the native surface renders
/// square corners over the pane's rounded frame. Same mechanism native_term uses
/// for its hole rects (see native_term/region.rs).
///
/// `radius_logical <= 0` clears the region, restoring a plain rectangular window.
fn apply_corner_region(hwnd: isize, w_px: i32, h_px: i32, radius_logical: f32, dpr: f32) {
    use windows::Win32::Foundation::{BOOL, HWND};
    use windows::Win32::Graphics::Gdi::{
        CreateRoundRectRgn, DeleteObject, SetWindowRgn, HRGN,
    };
    if hwnd == 0 || w_px <= 0 || h_px <= 0 {
        return;
    }
    let hwnd = HWND(hwnd as *mut _);
    unsafe {
        if radius_logical <= 0.0 {
            // NULL region = no clipping. Cheap and idempotent, so the plain
            // (responsive) case never carries a stale rounded region.
            SetWindowRgn(hwnd, HRGN(std::ptr::null_mut()), BOOL(1));
            return;
        }
        // CreateRoundRectRgn's last two args are the corner ELLIPSE size
        // (= 2 x radius); right/bottom are exclusive, matching CreateRectRgn.
        let diam = (((radius_logical * dpr).round() as i32) * 2).max(2);
        let rgn = CreateRoundRectRgn(0, 0, w_px, h_px, diam, diam);
        if rgn.is_invalid() {
            return;
        }
        // SetWindowRgn takes ownership on SUCCESS only — on failure we still
        // own the HRGN and must free it or it leaks (MSDN).
        if SetWindowRgn(hwnd, rgn, BOOL(1)) == 0 {
            let _ = DeleteObject(rgn);
        }
    }
}

/// Container HWND of a built webview, as an `isize`.
///
/// Crosses a COM-version boundary by value: `HWND` is a pointer newtype, so
/// going through `isize` is safe even though webview2-com's `windows` crate and
/// the one native_term uses are different major versions.
fn container_hwnd(webview: &WebView) -> isize {
    use windows_webview2::Win32::Foundation::HWND as Webview2Hwnd;
    use wry::WebViewExtWindows;
    // COM getter style: the HWND comes back through an out-param, not a return.
    let mut out = Webview2Hwnd(std::ptr::null_mut());
    match unsafe { webview.controller().ParentWindow(&mut out) } {
        Ok(()) => out.0 as isize,
        Err(e) => {
            eprintln!("[browser_view] could not read container HWND: {e}");
            0
        }
    }
}

/// Chrome's download conflict rule: keep the name if free, else `name (1).ext`,
/// `name (2).ext`, … The numbering is pure + unit-tested in policy; only the
/// "does it exist" loop lives here.
fn unique_path(dir: &std::path::Path, name: &str) -> PathBuf {
    let direct = dir.join(name);
    if !direct.exists() {
        return direct;
    }
    for n in 1..10_000u32 {
        let candidate = dir.join(policy::numbered_variant(name, n));
        if !candidate.exists() {
            return candidate;
        }
    }
    // Absurd fallback: 10k collisions on one name. Overwriting is still wrong,
    // so fall back to a name that cannot collide.
    dir.join(policy::numbered_variant(name, u32::MAX))
}

/// Emit a `browser_view:{id}:{kind}` event, matching native_term's channel
/// convention. Best-effort: a dead subscriber is not an error.
fn emit(app: &AppHandle, id: u32, kind: &str, payload: serde_json::Value) {
    let _ = app.emit(&format!("browser_view:{id}:{kind}"), payload);
}

pub fn create(
    app: &AppHandle,
    parent_hwnd: isize,
    id: u32,
    url: &str,
    rect: &PaneRect,
    dpr: f32,
) -> Result<(), String> {
    // The initial URL is policy-checked like any other navigation — a pane must
    // not be openable at file:// or MADE's own origin via its constructor.
    if !policy::is_navigation_allowed(url) {
        return Err(format!(
            "browser_view: refusing to open {url}: {}",
            match policy::classify_navigation(url) {
                policy::NavDecision::Block(r) => r.as_str(),
                policy::NavDecision::Allow => "allowed",
            }
        ));
    }

    let parent = ParentWindow(parent_hwnd);
    let bounds = to_wry_rect(rect, dpr);

    let app_for_nav = app.clone();
    let app_for_ipc = app.clone();
    let app_for_new_window = app.clone();
    let app_for_download = app.clone();
    let app_for_download_done = app.clone();

    // Resolved once per view: the Downloads folder Chrome would use.
    let download_dir: Option<PathBuf> = app.path().download_dir().ok();

    if CREATING.with(|c| c.get()) {
        return Err(
            "browser_view: a view is already being created (re-entrant call)".into(),
        );
    }
    CREATING.with(|c| c.set(true));
    // Taken OUT rather than borrowed — see the CREATING doc comment.
    let mut ctx = CONTEXT
        .with(|c| c.borrow_mut().take())
        .unwrap_or_else(|| WebContext::new(profile_dir(app)));

    let built = (|| -> Result<WebView, String> {
        let builder = WebViewBuilder::new_with_web_context(&mut ctx)
            .with_url(url)
            .with_bounds(bounds)
            .with_focused(false)
            // ---- Security requirement 3: navigation scheme allowlist ----
            .with_navigation_handler(move |candidate| {
                match policy::classify_navigation(&candidate) {
                    policy::NavDecision::Allow => {
                        // Address-bar source of truth. Previously the injected
                        // script reported this by patching history.pushState —
                        // one of the tampering signals that tripped reCAPTCHA.
                        // The navigation handler already knows, for free.
                        emit(
                            &app_for_nav,
                            id,
                            "navigated",
                            serde_json::json!({ "url": candidate }),
                        );
                        true
                    }
                    policy::NavDecision::Block(reason) => {
                        eprintln!(
                            "[browser_view] blocked navigation to {candidate}: {}",
                            reason.as_str()
                        );
                        emit(
                            &app_for_nav,
                            id,
                            "blocked",
                            serde_json::json!({ "url": candidate, "reason": reason.as_str() }),
                        );
                        false
                    }
                }
            })
            // ---- Security requirement 4: no uncontrolled popups ----
            // window.open / target=_blank must never spawn a second webview we
            // do not govern. Hand the URL to the pane instead (it decides whether
            // to navigate in place or open the OS browser).
            .with_new_window_req_handler(move |candidate, _features| {
                if policy::is_navigation_allowed(&candidate) {
                    emit(
                        &app_for_new_window,
                        id,
                        "popup",
                        serde_json::json!({ "url": candidate }),
                    );
                } else {
                    eprintln!("[browser_view] blocked popup to {candidate}");
                }
                NewWindowResponse::Deny
            })
            // ---- Downloads: Chrome behaviour ----
            // Allowed, written to the user's Downloads folder with no prompt,
            // conflicts uniquified rather than overwritten.
            //
            // The suggested name is ATTACKER-CONTROLLED (Content-Disposition or
            // the URL), so it is sanitised to a bare file name before use —
            // otherwise `..\..\Windows\System32\evil.dll` would escape the
            // folder. See policy::sanitize_download_filename (unit-tested).
            .with_download_started_handler(move |candidate, path| {
                let suggested = path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();
                let name = policy::sanitize_download_filename(&suggested);

                // Approved already? Consume the single-use token and proceed.
                let approved = VIEWS.with(|views| {
                    views
                        .borrow_mut()
                        .get_mut(&id)
                        .map(|v| v.allowed_downloads.remove(&candidate))
                        .unwrap_or(false)
                });
                // With prompting off, save straight away — and note this path
                // issues only ONE request, so it is the mode that works for
                // one-time-token and POST-initiated downloads.
                if !approved && super::prompt_downloads() {
                    // Cancel and ask. Zero bytes touch disk before the answer.
                    emit(
                        &app_for_download,
                        id,
                        "download",
                        serde_json::json!({
                            "phase": "request",
                            "url": candidate,
                            "name": name,
                        }),
                    );
                    return false;
                }
                let dir = match download_dir.clone() {
                    Some(d) => d,
                    None => {
                        eprintln!("[browser_view] no download dir; denying {candidate}");
                        return false;
                    }
                };
                let target = unique_path(&dir, &name);
                let shown = target.display().to_string();
                *path = target;
                emit(
                    &app_for_download,
                    id,
                    "download",
                    serde_json::json!({
                        "phase": "start", "url": candidate, "path": shown,
                    }),
                );
                true
            })
            .with_download_completed_handler(move |candidate, path, success| {
                emit(
                    &app_for_download_done,
                    id,
                    "download",
                    serde_json::json!({
                        "phase": "end",
                        "url": candidate,
                        "path": path.map(|p| p.display().to_string()),
                        "success": success,
                    }),
                );
            })
            // ---- Security requirement 2: one IPC envelope, treated as hostile ----
            .with_ipc_handler(move |req| {
                let raw = req.body();
                let allowed = VIEWS.with(|views| {
                    let mut views = views.borrow_mut();
                    match views.get_mut(&id) {
                        Some(v) => {
                            let now = Instant::now();
                            let elapsed = now.duration_since(v.last_ipc).as_secs_f64();
                            v.last_ipc = now;
                            v.limiter.allow(elapsed)
                        }
                        // Messages can arrive between build and registry insert.
                        None => true,
                    }
                });
                if !allowed {
                    return;
                }
                match policy::parse_devtools_envelope(raw) {
                    Ok(items) => {
                        // Split the context-menu report onto its own channel.
                        // It drives UI with ACTIONS, not DevTools panel text, so
                        // its consumer should not have to sift the console
                        // stream for it — and keeping the channels separate
                        // keeps "what can this payload reach?" easy to answer.
                        let (ctx, rest): (Vec<_>, Vec<_>) =
                            items.into_iter().partition(|i| i.kind == "ctxmenu");

                        for item in ctx {
                            emit(
                                &app_for_ipc,
                                id,
                                "ctxmenu",
                                serde_json::json!({ "payload": item.payload }),
                            );
                        }

                        if !rest.is_empty() {
                            let payload: Vec<serde_json::Value> = rest
                                .into_iter()
                                .map(|i| serde_json::json!({ "kind": i.kind, "payload": i.payload }))
                                .collect();
                            emit(
                                &app_for_ipc,
                                id,
                                "devtools",
                                serde_json::json!({ "items": payload }),
                            );
                        }
                    }
                    Err(reason) => {
                        // Dropped, never partially honoured. Logged at debug volume
                        // because a hostile page can generate these at will.
                        #[cfg(debug_assertions)]
                        eprintln!("[browser_view] rejected IPC message: {reason:?}");
                        let _ = reason;
                    }
                }
            })
            .with_initialization_script(HOST_INIT_SCRIPT);

        builder
            .build_as_child(&parent)
            .map_err(|e| format!("browser_view: webview build failed: {e}"))
    })();

    // Restore the shared context and clear the guard on BOTH paths — an early
    // `?` here would strand the profile and wedge every later create.
    CONTEXT.with(|c| *c.borrow_mut() = Some(ctx));
    CREATING.with(|c| c.set(false));
    let webview = built?;

    let hwnd = container_hwnd(&webview);
    bring_above_siblings(hwnd);


    VIEWS.with(|views| {
        views.borrow_mut().insert(
            id,
            HostedView {
                webview,
                hwnd,
                limiter: RateLimiter::new(IPC_BURST, IPC_PER_SEC),
                last_ipc: Instant::now(),
                allowed_downloads: HashSet::new(),
            },
        );
    });

    Ok(())
}

/// Run `f` against a live view. Missing id is an error, matching
/// `native_term::registry::with_window`.
fn with_view<T>(id: u32, f: impl FnOnce(&mut HostedView) -> Result<T, String>) -> Result<T, String> {
    VIEWS.with(|views| {
        let mut views = views.borrow_mut();
        match views.get_mut(&id) {
            Some(v) => f(v),
            None => Err(format!("browser_view: id {id} not found")),
        }
    })
}

pub fn destroy(id: u32) -> Result<(), String> {
    VIEWS.with(|views| match views.borrow_mut().remove(&id) {
        // Dropping the WebView tears down the controller and its container HWND.
        Some(_) => Ok(()),
        None => Err(format!("browser_view: id {id} not found")),
    })
}

/// Drop every view. Called on page reload, where React-owned panes would
/// otherwise be orphaned — the same trap native_term's `reap_all` covers.
pub fn reap_all() -> usize {
    VIEWS.with(|views| {
        let drained: Vec<_> = views.borrow_mut().drain().collect();
        let n = drained.len();
        drop(drained);
        if n > 0 {
            eprintln!("[browser_view] reaped {n} orphaned view(s) from a previous page load");
        }
        n
    })
}

pub fn show(id: u32) -> Result<(), String> {
    with_view(id, |v| {
        v.webview
            .set_visible(true)
            .map_err(|e| format!("browser_view: show failed: {e}"))?;
        // Re-assert on every show: sibling order can change while hidden.
        bring_above_siblings(v.hwnd);
        Ok(())
    })
}

pub fn hide(id: u32) -> Result<(), String> {
    with_view(id, |v| {
        v.webview
            .set_visible(false)
            .map_err(|e| format!("browser_view: hide failed: {e}"))
    })
}

pub fn set_bounds(
    id: u32,
    rect: &PaneRect,
    dpr: f32,
    corner_radius: f32,
) -> Result<(), String> {
    let bounds = to_wry_rect(rect, dpr);
    let w_px = (rect.width * dpr).round().max(1.0) as i32;
    let h_px = (rect.height * dpr).round().max(1.0) as i32;
    with_view(id, |v| {
        v.webview
            .set_bounds(bounds)
            .map_err(|e| format!("browser_view: set_bounds failed: {e}"))?;
        // Region is in CLIENT coords, so it must be re-applied on every resize.
        apply_corner_region(v.hwnd, w_px, h_px, corner_radius, dpr);
        Ok(())
    })
}

pub fn navigate(id: u32, url: &str) -> Result<(), String> {
    // Checked here as well as in the navigation handler: load_url is a
    // programmatic entry point and must not be a way around the allowlist.
    if !policy::is_navigation_allowed(url) {
        return Err(format!("browser_view: navigation to {url} is not allowed"));
    }
    with_view(id, |v| {
        v.webview
            .load_url(url)
            .map_err(|e| format!("browser_view: navigate failed: {e}"))
    })
}

pub fn eval(id: u32, js: &str) -> Result<(), String> {
    with_view(id, |v| {
        v.webview
            .evaluate_script(js)
            .map_err(|e| format!("browser_view: eval failed: {e}"))
    })
}

pub fn reload(id: u32) -> Result<(), String> {
    with_view(id, |v| {
        v.webview
            .reload()
            .map_err(|e| format!("browser_view: reload failed: {e}"))
    })
}

/// Hard reload: clear this profile's browsing data, then reload. Mirrors the
/// iframe path's "Hard Reload (clear storage)" toolbar action.
pub fn hard_reload(id: u32) -> Result<(), String> {
    with_view(id, |v| {
        v.webview
            .clear_all_browsing_data()
            .map_err(|e| format!("browser_view: clear browsing data failed: {e}"))?;
        v.webview
            .reload()
            .map_err(|e| format!("browser_view: reload failed: {e}"))
    })
}

pub fn focus(id: u32) -> Result<(), String> {
    with_view(id, |v| {
        v.webview
            .focus()
            .map_err(|e| format!("browser_view: focus failed: {e}"))
    })
}

/// Approve one download and re-issue it inside the page.
///
/// Re-issued via an `<a download>` click rather than a fresh HTTP request from
/// Rust, so the page's cookies and session still apply. Known limit: this repeats
/// the request, so a download behind a one-time token or produced by a POST can
/// fail the second time — the shelf reports the failure and the user can retry
/// from the page.
pub fn allow_download(id: u32, url: &str, name: &str) -> Result<(), String> {
    if !policy::is_navigation_allowed(url) {
        return Err(format!("browser_view: refusing download from {url}"));
    }
    with_view(id, |v| {
        v.allowed_downloads.insert(url.to_string());
        let js = format!(
            "(function(){{var a=document.createElement('a');a.href={};a.download={};document.body.appendChild(a);a.click();a.remove();}})()",
            serde_json::to_string(url).unwrap_or_else(|_| "''".into()),
            serde_json::to_string(name).unwrap_or_else(|_| "''".into()),
        );
        v.webview
            .evaluate_script(&js)
            .map_err(|e| format!("browser_view: re-issuing download failed: {e}"))
    })
}

/// Drop a pending approval. The download was already cancelled at the webview,
/// so this only clears any token that a double-click may have inserted.
pub fn deny_download(id: u32, url: &str) -> Result<(), String> {
    with_view(id, |v| {
        v.allowed_downloads.remove(url);
        Ok(())
    })
}

pub fn current_url(id: u32) -> Result<String, String> {
    with_view(id, |v| {
        v.webview
            .url()
            .map_err(|e| format!("browser_view: url read failed: {e}"))
    })
}
