// Process-wide registry of active native-terminal child windows, plus a slot
// for the captured parent HWND populated from lib.rs setup(). All access is
// synchronous + mutex-guarded — Tauri commands are short-lived and we never
// hold the lock across an .await.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};

use super::window::NativeTermWindow;

static PARENT_HWND: OnceLock<isize> = OnceLock::new();
static NEXT_ID: AtomicU32 = AtomicU32::new(1);
static REGISTRY: OnceLock<Mutex<HashMap<u32, Box<dyn NativeTermWindow>>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<u32, Box<dyn NativeTermWindow>>> {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn set_parent_hwnd(hwnd: isize) {
    // First setter wins. lib.rs setup() runs once.
    let _ = PARENT_HWND.set(hwnd);
}

pub fn parent_hwnd() -> Option<isize> {
    PARENT_HWND.get().copied()
}

pub fn alloc_id() -> u32 {
    NEXT_ID.fetch_add(1, Ordering::Relaxed)
}

pub fn insert(id: u32, window: Box<dyn NativeTermWindow>) {
    registry().lock().expect("registry poisoned").insert(id, window);
}

/// Apply a closure to the registered window, propagating any error.
pub fn with_window<F>(id: u32, f: F) -> Result<(), String>
where
    F: FnOnce(&mut Box<dyn NativeTermWindow>) -> Result<(), String>,
{
    let mut guard = registry().lock().expect("registry poisoned");
    let win = guard.get_mut(&id).ok_or_else(|| format!("native_term: id {id} not found"))?;
    f(win)
}

/// Apply a closure to EVERY registered window. The registry lock is held for
/// the whole sweep, so the closure must stay non-blocking (PostMessage-cheap)
/// and must never re-enter the registry.
pub fn for_each<F>(mut f: F)
where
    F: FnMut(&mut Box<dyn NativeTermWindow>),
{
    let mut guard = registry().lock().expect("registry poisoned");
    for win in guard.values_mut() {
        f(win);
    }
}

/// Remove and return ownership of the window so its `destroy(self: Box<Self>)`
/// can consume it.
pub fn take(id: u32) -> Option<Box<dyn NativeTermWindow>> {
    registry().lock().expect("registry poisoned").remove(&id)
}

/// Drain EVERY registered window, handing ownership to the caller.
///
/// The registry outlives the webview: it is a process-wide static, so a page
/// reload (F5, devtools reload, a Vite full reload in dev) drops all the JS
/// that owned these windows WITHOUT running any React cleanup, and their
/// HWNDs stay alive and visible on top of the freshly booted page. This is
/// the reaper for exactly that — see `native_term_reap_all`.
///
/// Returns owned boxes rather than destroying in place so the caller can drop
/// the registry lock BEFORE running `destroy`, which does Win32 teardown and
/// must never re-enter the registry while it is held.
pub fn take_all() -> Vec<Box<dyn NativeTermWindow>> {
    registry()
        .lock()
        .expect("registry poisoned")
        .drain()
        .map(|(_, w)| w)
        .collect()
}
