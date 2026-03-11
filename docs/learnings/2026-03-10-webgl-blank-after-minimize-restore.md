# WebView2 blank screen after minimize → restore

**Date:** 2026-03-11

## Summary

Minimizing the EzyDev window and restoring it caused the entire app to go blank — not just terminal panes, but the **entire WebView2 surface** (white rectangle + black exposed areas). Resizing the window by even 1px immediately fixed it. Three attempts were needed to find the right fix level.

## Symptoms

- Minimize the app (taskbar click, Win+D, or minimize button)
- Restore the app (taskbar click or Alt+Tab)
- Entire window is blank: white rectangle (WebView2 at stale bounds) + black background
- All UI elements gone — TabBar, terminal panes, headers, everything
- Resizing the window even 1px immediately fixes it
- Happens "almost every time" the app is minimized or goes out of focus

## Root cause

WebView2 in frameless Tauri windows (`decorations: false` + custom `WM_NCCALCSIZE` subclass) doesn't repaint its compositor surface after minimize→restore. The Chromium compositor freezes while the document is hidden, and on restore, the WebView2 controller doesn't recalculate its internal bounds.

The key insight: the problem is at the **native Win32 / WebView2 compositor level**, not the JavaScript or xterm level. `ResizeObserver`, `IntersectionObserver`, and even `document.visibilitychange` with Tauri's JS `setSize` API all failed because they operate inside the frozen webview.

## Failed attempts and why they failed

### Attempt 1: xterm.js per-pane `visibilitychange` (TerminalPane.tsx)

Added `document.addEventListener("visibilitychange", ...)` that calls `term.refresh(0, rows-1)` + `fitAddon.fit()` for each terminal pane.

**Why it failed**: Assumed the problem was xterm WebGL canvases not repainting. The screenshot revealed the **entire WebView2 container** was blank (white rectangle + black background = WebView2 rendered at wrong bounds). Refreshing xterm canvases inside a blank WebView2 has no visible effect — the compositor isn't displaying any of the DOM content. The faulty reasoning was "blank after minimize" = "xterm WebGL context lost", when the actual issue was one level higher.

### Attempt 2: Tauri JS `setSize` toggle (App.tsx)

Added a global `visibilitychange` handler that toggles window size by 1px using `getCurrentWindow().setSize(new PhysicalSize(w+1, h))` then reverts in `requestAnimationFrame`.

**Why it failed**: Two possible reasons: (1) `visibilitychange` may not fire reliably in WebView2 when the native window is minimized — the browser event depends on the WebView2 runtime reporting visibility, which may be delayed or skipped for frameless windows; (2) Even if the event fires, the Tauri JS `setSize` API goes through IPC → Rust → Win32 `SetWindowPos`, which adds latency and may not reach the WebView2 compositor in time. The fundamental flaw: trying to fix a native compositor problem from inside the compositor (JS runs inside the frozen webview).

### Attempt 3: Native Win32 subclass `WM_SIZE` interception (lib.rs) ← Final fix

Added `WM_SIZE` handling to the existing `WM_NCCALCSIZE` subclass proc. Tracks minimized state with `AtomicBool`, defers the resize via `PostMessageW(WM_WEBVIEW_REPAINT)`, then forces a 1px `SetWindowPos` cycle (or `SWP_FRAMECHANGED` for maximized windows).

**Why this should work**: Operates at the same level as the problem — native Win32 messages. `WM_SIZE` is guaranteed to fire on restore (it's how Windows notifies the window of its new size). `PostMessageW` defers the fix to after the restore sequence completes. `SetWindowPos` directly triggers WebView2's `ICoreWebView2Controller::put_Bounds` which forces the compositor to recalculate and repaint.

## Fix (final — Rust subclass proc)

In `src-tauri/src/lib.rs` `win32_border` module:

1. Added constants: `WM_SIZE`, `WM_USER`, `WM_WEBVIEW_REPAINT`, `SIZE_MINIMIZED`
2. Added static: `WAS_MINIMIZED: AtomicBool`
3. Added extern: `GetWindowRect`, `PostMessageW`
4. In `subclass_proc`:
   - `WM_SIZE` with `SIZE_MINIMIZED` → set flag
   - `WM_SIZE` with restore (flag was set) → `PostMessageW(WM_WEBVIEW_REPAINT)`
   - `WM_WEBVIEW_REPAINT` → check if maximized:
     - **Maximized**: `SetWindowPos` with `SWP_FRAMECHANGED | SWP_NOSIZE | SWP_NOMOVE`
     - **Normal/snapped**: `SetWindowPos` +1px width, then `SetWindowPos` original width

Also kept the TerminalPane.tsx `visibilitychange` → `term.refresh()` as belt-and-suspenders for xterm canvases (layer 2 of the original problem).

Removed the failed App.tsx JS-level fix (unused `PhysicalSize` import cleaned up too).

## Prevention

- **When debugging blank-after-minimize in Tauri/WebView2, always check which LEVEL is blank**: entire webview container (native fix needed) vs. specific child elements (JS fix may suffice)
- **JS-level fixes cannot fix native compositor issues** — `visibilitychange`, `setSize`, DOM reflow tricks all operate inside the webview, which is exactly the thing that's frozen
- **Native Win32 subclass is the correct fix level** for WebView2 rendering bugs — it intercepts messages before the webview processes them
- **`PostMessageW` is essential for deferred work in message handlers** — doing `SetWindowPos` directly inside `WM_SIZE` causes reentrancy; posting a custom message defers it cleanly
- **Maximized windows need special handling** — can't resize +1px (would un-maximize), use `SWP_FRAMECHANGED` instead

## Verification

1. `npm run build` — passes clean (tsc + vite)
2. `cargo check` — passes (1 pre-existing unrelated warning)
3. Requires Tauri rebuild (`npm run tauri:dev`) to test
4. Manual test: minimize app → restore → entire UI should repaint immediately
5. Test all window states: normal, maximized, snapped left/right
