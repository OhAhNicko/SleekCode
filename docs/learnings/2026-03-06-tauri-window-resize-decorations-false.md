# Tauri v2: Window resize broken with `decorations: false`

## Summary

With `"decorations": false` in Tauri v2 on Windows, the native window resize borders are removed along with the title bar. The window can only be resized from the top edge (because `-webkit-app-region: drag` on the tab bar creates a partial resize zone there). All other edges and corners are unresizable.

## Symptoms

- Window cannot be resized from left, right, or bottom edges
- Window cannot be resized from corners
- Only the top border (near the custom tab bar) allows resize dragging

## Root cause

Setting `"decorations": false` in `tauri.conf.json` removes ALL native window chrome on Windows, including the invisible resize borders that the OS normally provides. The `-webkit-app-region: drag` CSS on the tab bar was the only thing providing any resize-like behavior (at the top edge only).

## Failed attempt: `shadow: true`

The first fix attempted was adding `"shadow": true` to the window config in `tauri.conf.json`. This is sometimes cited as restoring resize borders on Windows (by adding the `WS_CAPTION` window style). In this case, it did not restore resize functionality on any edge. This may be version-dependent or may only work in certain Tauri/WebView2 configurations.

**Why it failed:** `shadow: true` adds a drop shadow but does not reliably restore the native resize hit-test borders when `decorations: false` is set. The behavior is inconsistent across Tauri versions and Windows configurations.

## Fix

Created a `WindowResizeHandles` component that renders 8 invisible `position: fixed` divs (4 edges + 4 corners) with a 6px hit zone. Each div calls `getCurrentWindow().startResizeDragging(direction)` from `@tauri-apps/api/window` on `mouseDown`.

Three changes required:
1. **New component** `src/components/WindowResizeHandles.tsx` — the 8 resize handle divs
2. **`src/App.tsx`** — render `<WindowResizeHandles />` at the root
3. **`src-tauri/capabilities/default.json`** — add `core:window:allow-start-resize-dragging` permission

## Prevention

- When using `decorations: false` in Tauri v2, always implement manual resize handles using `startResizeDragging()` — don't rely on native resize borders existing.
- The `shadow: true` config option is not a reliable substitute for manual resize handles.

## Verification

- Build passes (`npm run build`, `tsc --noEmit`)
- User confirmed resize works from all edges after the programmatic fix
