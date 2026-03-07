# Window State Persistence & Maximize Icon Toggle

**Date:** 2026-03-07

## Summary

Added two features: (1) the app remembers its window size and position across restarts using `tauri-plugin-window-state`, and (2) the maximize/restore button in the custom title bar updates its icon based on the actual window state.

## Implementation

### Window state persistence

Tauri v2 provides an official plugin `tauri-plugin-window-state` (version 2) that automatically saves and restores window size, position, and maximized/fullscreen state. It persists to a file in the app's config directory (`%APPDATA%/com.ezydev.app/`).

Three files changed:
- `src-tauri/Cargo.toml` — added `tauri-plugin-window-state = "2"`
- `src-tauri/src/lib.rs` — registered `.plugin(tauri_plugin_window_state::Builder::new().build())`
- `src-tauri/capabilities/default.json` — added `"window-state:default"` permission

No frontend code needed for the persistence itself.

### Maximize button icon toggle

Since `decorations: false` means we have custom window controls, the maximize button needs to reflect the actual window state. Used `getCurrentWindow().onResized()` to listen for resize events and check `isMaximized()` after each one. The icon swaps between:
- Single rectangle (maximize) when normal
- Two overlapping rectangles (restore) when maximized

Key detail: Tauri v2 doesn't have dedicated `onMaximize`/`onUnmaximize` events exposed to JS. Using `onResized` works because maximize/unmaximize always triggers a resize. Inside the handler, `await win.isMaximized()` gives the correct state.

## Prevention

- For window state persistence in Tauri v2, always reach for `tauri-plugin-window-state` first — don't build custom localStorage-based solutions.
- Custom title bars (`decorations: false`) need manual icon state tracking for maximize/restore. The `onResized` + `isMaximized()` pattern is the reliable approach.

## Verification

1. `npx tsc --noEmit` — passes clean
2. Launch app, resize/move window, close, relaunch — window should restore to last position/size
3. Click maximize — icon should change to two overlapping rectangles (restore icon)
4. Click restore — icon should change back to single rectangle (maximize icon)
