// Native browser pane — Tauri command layer.
//
// The pane's surface is a wry WebView in a child HWND of the main window (see
// host.rs), replacing the iframe + single-origin proxy that could not follow a
// cross-origin redirect and so could not open even google.se.
//
// Platform split follows native_term's convention: this command layer is NOT
// cfg-gated (it compiles everywhere so `generate_handler!` stays uniform), while
// the platform host is Windows-only and other targets get `Err` stubs.

pub mod policy;

#[cfg(target_os = "windows")]
mod host;

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

/// Pane geometry in LOGICAL CSS px, in window-client coordinates — the same wire
/// contract native_term uses (`rectOf` / `surfaceRectOf` on the JS side). The
/// host multiplies by `dpr` to get physical px.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// Injected into every page the browsing webview loads, before page scripts.
///
/// THE SAME FILE the preview proxy injects into framed pages. One script, two
/// transports (`window.parent.postMessage` when framed, `window.ipc.postMessage`
/// when native) so the DevTools panel behaves identically on both engines and the
/// two cannot drift.
///
/// SECURITY: this runs in the VISITED PAGE's world, so a hostile page can tamper
/// with it, forge its messages and flood the channel. Nothing it sends is trusted
/// — `policy::parse_devtools_envelope` re-validates every batch (closed kind set,
/// size/batch/text caps, rate limit) and the payload's only destination is
/// DevTools panel text.
pub const HOST_INIT_SCRIPT: &str = r#"
(function () {
  if (window.__madeMin) return;
  try { Object.defineProperty(window, '__madeMin', { value: true }); } catch (e) {}
  function send(kind, msg) {
    try {
      window.ipc.postMessage(JSON.stringify({
        v: 1, kind: 'devtools',
        items: [{ kind: kind, payload: JSON.stringify(msg) }]
      }));
    } catch (e) {}
  }
  // PASSIVE ONLY. addEventListener does not alter any native, so nothing here
  // is visible to a tampering check.
  window.addEventListener('focus', function () { send('focus', { type: 'made-focus', focused: true }); });
  window.addEventListener('blur',  function () { send('focus', { type: 'made-focus', focused: false }); });
  if (document.hasFocus && document.hasFocus()) send('focus', { type: 'made-focus', focused: true });
  function ready() { send('ready', { type: 'made-ready' }); }
  if (document.readyState === 'complete') ready();
  else window.addEventListener('load', ready);

  // History depth for the toolbar's back/forward buttons — a real browser
  // grays them out, and wry exposes no history query, so the page's own
  // Navigation API (Chromium) is the only accurate source. PASSIVE (listener
  // only), and like everything here the two booleans are untrusted — worst
  // case a hostile page wrongly grays a nav button.
  if (window.navigation) {
    var navState = function () {
      send('navstate', {
        type: 'made-navstate',
        back: !!window.navigation.canGoBack,
        fwd: !!window.navigation.canGoForward
      });
    };
    window.navigation.addEventListener('currententrychange', navState);
    navState();
  }

  // Right-click -> MADE's own context menu.
  //
  // The click never reaches a host wnd_proc: WebView2 owns input inside the
  // page, so unlike the native terminal pane there is no WM_RBUTTONDOWN to
  // intercept. Reporting it from the page is the only seam.
  //
  // SHIFT passes through untouched, so pages with their own right-click UI
  // (editors, maps, Docs) stay usable — the same escape hatch the terminal
  // panes use, inverted: plain right-click belongs to MADE.
  //
  // Still passive in the fingerprinting sense: this only adds a listener, it
  // replaces no native, so `fetch.toString()` and friends stay untouched.
  window.addEventListener('contextmenu', function (e) {
    if (e.shiftKey) return;
    e.preventDefault();
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    var img = e.target && e.target.tagName === 'IMG' ? e.target : null;
    var sel = '';
    try { sel = String(window.getSelection ? window.getSelection() : ''); } catch (err) {}
    var el = e.target;
    var editable = !!(el && (el.isContentEditable ||
      el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'));
    send('ctxmenu', {
      type: 'made-ctxmenu',
      x: Math.round(e.clientX), y: Math.round(e.clientY),
      linkUrl: a ? String(a.href).slice(0, 2048) : '',
      linkText: a ? String(a.textContent || '').trim().slice(0, 200) : '',
      imgUrl: img ? String(img.currentSrc || img.src || '').slice(0, 2048) : '',
      selText: sel.slice(0, 2000),
      editable: editable
    });
  }, true);
})();
"#;

/// The FULL DevTools instrumentation — console/network/inspector/storage capture.
///
/// Injected ON DEMAND (`browser_view_enable_devtools`), never at page load.
///
/// WHY: it replaces `window.fetch`, `XMLHttpRequest.prototype.open/send`,
/// `console.*` and `history.pushState`. After that `window.fetch.toString()` no
/// longer returns `[native code]`, which is a canonical automation-tampering
/// fingerprint — Google's bot detection reads exactly those, and MADE was
/// tripping reCAPTCHA on an ordinary search because every page was instrumented
/// whether or not anyone was looking (reported 2026-07-27). Instrument only while
/// the panel is open; a page you are merely browsing sees untouched natives.
pub const DEVTOOLS_SCRIPT: &str = include_str!("../preview_proxy_inject.js");

/// Ask before saving a download, or save straight away?
///
/// A user setting, so it is process-wide rather than per view. `true` (ask) is
/// the default: the download is cancelled at the webview and nothing reaches disk
/// until the shelf's Save is pressed. `false` reproduces Chrome's out-of-the-box
/// behaviour — straight into the Downloads folder, no prompt — and is also the
/// only mode that issues a SINGLE request, so it is the one that works for
/// downloads behind a one-time token or a POST.
static PROMPT_DOWNLOADS: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(true);

pub fn prompt_downloads() -> bool {
    PROMPT_DOWNLOADS.load(Ordering::Relaxed)
}

static PARENT_HWND: OnceLock<isize> = OnceLock::new();
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

/// First setter wins, mirroring `native_term::registry::set_parent_hwnd`. Called
/// from lib.rs setup once the main window exists.
pub fn set_parent_hwnd(hwnd: isize) {
    let _ = PARENT_HWND.set(hwnd);
}

fn parent_hwnd() -> Option<isize> {
    PARENT_HWND.get().copied()
}

fn alloc_id() -> u32 {
    NEXT_ID.fetch_add(1, Ordering::Relaxed)
}

/// Run `f` on the main thread and await its result.
///
/// Required because `wry::WebView` is not `Send` on Windows (apartment-threaded
/// COM), so the whole registry is main-thread-only.
///
/// EVERY command here MUST be `async`, and this MUST await rather than block.
/// A non-async `#[tauri::command]` runs on Tauri's sync THREADPOOL
/// (tauri-macros command/wrapper.rs:241), and a blocking wait parks that thread
/// until the main thread services the closure. The geometry driver pushes bounds
/// every frame, so a blocking version exhausts the pool within seconds and then
/// EVERY Rust command in the app stops responding — pty writes, native-pane
/// geometry, the lot. The app looks completely frozen with panes stuck at stale
/// positions. (Diagnosed from exactly that symptom, 2026-07-26.)
#[cfg(target_os = "windows")]
async fn on_main<T: Send + 'static>(
    app: &tauri::AppHandle,
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| format!("browser_view: main-thread dispatch failed: {e}"))?;
    rx.await
        .map_err(|e| format!("browser_view: main-thread reply failed: {e}"))
}

/* ------------------------------------------------------------------ */
/*  Commands — Windows                                                 */
/* ------------------------------------------------------------------ */

#[cfg(target_os = "windows")]
mod cmds {
    use super::*;

    #[tauri::command]
    pub async fn browser_view_create(
        app: tauri::AppHandle,
        url: String,
        rect: PaneRect,
        dpr: f32,
    ) -> Result<u32, String> {
        let parent = parent_hwnd()
            .ok_or_else(|| "browser_view: parent HWND not captured yet".to_string())?;
        let id = alloc_id();
        let app_for_host = app.clone();
        on_main(&app, move || {
            host::create(&app_for_host, parent, id, &url, &rect, dpr)
        }).await??;
        Ok(id)
    }

    #[tauri::command]
    pub async fn browser_view_destroy(app: tauri::AppHandle, id: u32) -> Result<(), String> {
        on_main(&app, move || host::destroy(id)).await?
    }

    #[tauri::command]
    pub async fn browser_view_reap_all(app: tauri::AppHandle) -> Result<usize, String> {
        on_main(&app, host::reap_all).await
    }

    #[tauri::command]
    pub async fn browser_view_show(app: tauri::AppHandle, id: u32) -> Result<(), String> {
        on_main(&app, move || host::show(id)).await?
    }

    #[tauri::command]
    pub async fn browser_view_hide(app: tauri::AppHandle, id: u32) -> Result<(), String> {
        on_main(&app, move || host::hide(id)).await?
    }

    #[tauri::command]
    pub async fn browser_view_set_bounds(
        app: tauri::AppHandle,
        id: u32,
        rect: PaneRect,
        dpr: f32,
        corner_radius: f32,
    ) -> Result<(), String> {
        on_main(&app, move || {
            host::set_bounds(id, &rect, dpr, corner_radius)
        }).await?
    }

    #[tauri::command]
    pub async fn browser_view_navigate(
        app: tauri::AppHandle,
        id: u32,
        url: String,
    ) -> Result<(), String> {
        on_main(&app, move || host::navigate(id, &url)).await?
    }

    /// Back / forward are driven through the page's own history object — wry
    /// exposes no history API, and this is exactly what a browser's buttons do.
    #[tauri::command]
    pub async fn browser_view_back(app: tauri::AppHandle, id: u32) -> Result<(), String> {
        on_main(&app, move || host::eval(id, "history.back()")).await?
    }

    #[tauri::command]
    pub async fn browser_view_forward(app: tauri::AppHandle, id: u32) -> Result<(), String> {
        on_main(&app, move || host::eval(id, "history.forward()")).await?
    }

    #[tauri::command]
    pub async fn browser_view_reload(app: tauri::AppHandle, id: u32) -> Result<(), String> {
        on_main(&app, move || host::reload(id)).await?
    }

    #[tauri::command]
    pub async fn browser_view_hard_reload(app: tauri::AppHandle, id: u32) -> Result<(), String> {
        on_main(&app, move || host::hard_reload(id)).await?
    }

    #[tauri::command]
    pub async fn browser_view_focus(app: tauri::AppHandle, id: u32) -> Result<(), String> {
        on_main(&app, move || host::focus(id)).await?
    }

    #[tauri::command]
    pub async fn browser_view_url(app: tauri::AppHandle, id: u32) -> Result<String, String> {
        on_main(&app, move || host::current_url(id)).await?
    }

    /// Approve a pending download (and re-issue it inside the page).
    #[tauri::command]
    pub async fn browser_view_allow_download(
        app: tauri::AppHandle,
        id: u32,
        url: String,
        name: String,
    ) -> Result<(), String> {
        on_main(&app, move || host::allow_download(id, &url, &name)).await?
    }

    /// Set whether downloads are prompted for. No main-thread hop needed: this
    /// only flips an atomic that the download handler reads.
    #[tauri::command]
    pub fn browser_view_set_prompt_downloads(enabled: bool) {
        PROMPT_DOWNLOADS.store(enabled, Ordering::Relaxed);
    }

    /// Refuse a pending download.
    #[tauri::command]
    pub async fn browser_view_deny_download(
        app: tauri::AppHandle,
        id: u32,
        url: String,
    ) -> Result<(), String> {
        on_main(&app, move || host::deny_download(id, &url)).await?
    }

    /// Turn on DevTools capture for this view by injecting the instrumentation
    /// script. Deliberately NOT done at page load — see DEVTOOLS_SCRIPT.
    #[tauri::command]
    pub async fn browser_view_enable_devtools(
        app: tauri::AppHandle,
        id: u32,
    ) -> Result<(), String> {
        on_main(&app, move || host::eval(id, DEVTOOLS_SCRIPT)).await?
    }

    /// Runs JS inside the browsing page. Callable only from MADE's own trusted UI
    /// (the browsing webview has no Tauri IPC at all), and used for the DevTools
    /// commands: inspect start/stop, read storage, clear storage.
    #[tauri::command]
    pub async fn browser_view_eval(app: tauri::AppHandle, id: u32, js: String) -> Result<(), String> {
        on_main(&app, move || host::eval(id, &js)).await?
    }
}

/* ------------------------------------------------------------------ */
/*  Commands — non-Windows stubs                                       */
/*                                                                     */
/*  The host is Windows-only for now (same position native_term is in). */
/*  These keep macOS/Linux builds compiling and `generate_handler!`     */
/*  identical across targets.                                          */
/* ------------------------------------------------------------------ */

#[cfg(not(target_os = "windows"))]
mod cmds {
    use super::*;

    const UNSUPPORTED: &str = "browser_view: native browser pane is Windows-only for now";

    #[tauri::command]
    pub async fn browser_view_create(
        _app: tauri::AppHandle,
        _url: String,
        _rect: PaneRect,
        _dpr: f32,
    ) -> Result<u32, String> {
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub async fn browser_view_destroy(_app: tauri::AppHandle, _id: u32) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub async fn browser_view_reap_all(_app: tauri::AppHandle) -> Result<usize, String> {
        Ok(0)
    }

    #[tauri::command]
    pub async fn browser_view_show(_app: tauri::AppHandle, _id: u32) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub async fn browser_view_hide(_app: tauri::AppHandle, _id: u32) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub async fn browser_view_set_bounds(
        _app: tauri::AppHandle,
        _id: u32,
        _rect: PaneRect,
        _dpr: f32,
        _corner_radius: f32,
    ) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub async fn browser_view_navigate(
        _app: tauri::AppHandle,
        _id: u32,
        _url: String,
    ) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub async fn browser_view_back(_app: tauri::AppHandle, _id: u32) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub async fn browser_view_forward(_app: tauri::AppHandle, _id: u32) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub async fn browser_view_reload(_app: tauri::AppHandle, _id: u32) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub async fn browser_view_hard_reload(_app: tauri::AppHandle, _id: u32) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub async fn browser_view_focus(_app: tauri::AppHandle, _id: u32) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub async fn browser_view_url(_app: tauri::AppHandle, _id: u32) -> Result<String, String> {
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub async fn browser_view_eval(
        _app: tauri::AppHandle,
        _id: u32,
        _js: String,
    ) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub async fn browser_view_enable_devtools(
        _app: tauri::AppHandle,
        _id: u32,
    ) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub async fn browser_view_allow_download(
        _app: tauri::AppHandle,
        _id: u32,
        _url: String,
        _name: String,
    ) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub async fn browser_view_deny_download(
        _app: tauri::AppHandle,
        _id: u32,
        _url: String,
    ) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    #[tauri::command]
    pub fn browser_view_set_prompt_downloads(enabled: bool) {
        PROMPT_DOWNLOADS.store(enabled, Ordering::Relaxed);
    }
}

pub use cmds::*;
