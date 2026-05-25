// Process-wide registry of active native-terminal child windows, plus a slot
// for the captured parent handle populated from lib.rs setup(). All access is
// synchronous + mutex-guarded — Tauri commands are short-lived and we never
// hold the lock across an .await.
//
// The parent handle is platform-dependent:
//   Windows — HWND of the Tauri main window (used as WS_CHILD parent)
//   macOS   — NSView pointer of the main NSWindow's contentView (the
//             eventual `addSubview:` target for our child NSView)
//   Linux   — TBD (Phase 4+: X11 Window or Wayland wl_surface)

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};

use super::window::NativeTermWindow;

static PARENT_HANDLE: OnceLock<isize> = OnceLock::new();
static NEXT_ID: AtomicU32 = AtomicU32::new(1);
static REGISTRY: OnceLock<Mutex<HashMap<u32, Box<dyn NativeTermWindow>>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<u32, Box<dyn NativeTermWindow>>> {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Stash the platform parent handle. First setter wins; lib.rs setup() is
/// expected to call this exactly once during app startup.
pub fn set_parent_handle(handle: isize) {
    let _ = PARENT_HANDLE.set(handle);
}

pub fn parent_handle() -> Option<isize> {
    PARENT_HANDLE.get().copied()
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

/// Remove and return ownership of the window so its `destroy(self: Box<Self>)`
/// can consume it.
pub fn take(id: u32) -> Option<Box<dyn NativeTermWindow>> {
    registry().lock().expect("registry poisoned").remove(&id)
}
