# WebView2 + xterm blank screen after minimize → restore

**Date:** 2026-03-11 (updated from 2026-03-10)

## Summary

Minimizing the EzyDev window and restoring it caused the entire app to go blank — not just terminal panes, but the **entire WebView2 surface** (white rectangle + black exposed areas). Resizing the window by even 1px immediately fixed it.

## Symptoms

- Minimize the app (taskbar click, Win+D, or minimize button)
- Restore the app (taskbar click or Alt+Tab)
- Entire window is blank: white rectangle (WebView2 at wrong bounds) + black background
- All UI elements gone — TabBar, terminal panes, headers, everything
- Resizing the window even 1px immediately fixes it

## Root cause

Two layers of the problem:

### Layer 1: WebView2 compositor (primary — entire app blank)

WebView2 in frameless Tauri windows (`decorations: false` + custom `WM_NCCALCSIZE` subclass) doesn't repaint its compositor surface after minimize→restore. The Chromium compositor freezes while the document is hidden, and on restore, the WebView2 controller doesn't recalculate its bounds — it renders at stale dimensions, producing the white rectangle + black background pattern.

This is a **known WebView2 bug** with frameless windows. Standard framed windows handle this correctly because Windows sends the right `WM_NCCALCSIZE` sequence on restore, but our subclass intercepts and modifies that sequence.

### Layer 2: xterm.js WebGL renderer (secondary — terminal canvases stale)

Even if the WebView2 container repaints, the xterm.js WebGL renderer doesn't automatically repaint its canvas. `ResizeObserver` doesn't fire (element size unchanged), `IntersectionObserver` doesn't fire (intersection ratio unchanged), and there's no `visibilitychange` handler.

## Failed attempt: xterm-only fix

**First attempt**: Added a `visibilitychange` listener in `TerminalPane.tsx` that calls `term.refresh()` + `fitAddon.fit()` on each terminal pane.

**Why it failed**: The problem wasn't the xterm canvases — it was the **entire WebView2 container**. Refreshing xterm canvases inside a blank WebView2 has no visible effect. The screenshot confirmed: the white area was the WebView2 control itself rendered at wrong bounds, not individual terminal panes failing to paint. The faulty reasoning was assuming "blank after minimize" = "xterm WebGL context lost", when the actual issue was one level higher (WebView2 compositor).

## Fix (two layers)

### App.tsx — WebView2 repaint (fixes the blank screen)

Global `visibilitychange` handler that toggles window size by 1px on restore. This forces WebView2's `ICoreWebView2Controller::put_Bounds()` to fire, which recalculates the compositor surface:

```tsx
useEffect(() => {
  let wasHidden = false;
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      wasHidden = true;
    } else if (wasHidden) {
      wasHidden = false;
      const win = getCurrentWindow();
      win.innerSize().then((size) => {
        win.setSize(new PhysicalSize(size.width + 1, size.height)).catch(() => {});
        requestAnimationFrame(() => {
          win.setSize(new PhysicalSize(size.width, size.height)).catch(() => {});
        });
      }).catch(() => {});
    }
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => document.removeEventListener("visibilitychange", onVisibilityChange);
}, []);
```

- `wasHidden` flag ensures the resize only fires after actual minimize (not on every focus)
- `requestAnimationFrame` ensures the +1px resize is committed before reverting
- 1px change is invisible to the user

### TerminalPane.tsx — xterm canvas repaint (belt and suspenders)

Per-pane `visibilitychange` handler that calls `term.refresh(0, rows - 1)` + `fitAddon.fit()`. This ensures terminal canvases are repainted even if the 1px resize doesn't trigger a full refit through the debounced ResizeObserver.

## Prevention

- **When debugging "blank after minimize"**, check which LEVEL is blank: entire webview container, or just specific child canvases? The fix is different for each.
- **WebView2 + frameless windows** (`decorations: false` in Tauri) need explicit repaint handling on restore. The 1px resize toggle is the proven workaround.
- **Three observers cover different scopes** — none is a superset:
  - `ResizeObserver` → element size changes
  - `IntersectionObserver` → element visibility in DOM (display:none, scroll)
  - `visibilitychange` → document-level visibility (minimize, alt-tab, lock screen)

## Verification

1. `npm run build` — passes clean (tsc + vite)
2. Manual test: minimize app → restore → entire UI should repaint immediately
3. Manual test: alt-tab away → alt-tab back → no blank screen
