# Maximized Window Corners Appear Chopped Off

**Date**: 2026-03-08

---

## Summary

On Windows 11, maximizing the EzyDev Tauri window caused the corners of the app content to appear visually clipped — as if the window had rounded corners cutting into the UI. The actual cause was `WM_NCCALCSIZE` returning `0` unconditionally, combined with `WS_THICKFRAME`, causing the maximized window's client area to extend ~8px beyond the screen edges in all directions.

---

## Symptoms

- When the app window was maximized, the corners looked "rounded" or "chopped off"
- Content at the edges/corners of the screen was missing (invisible)
- The window otherwise worked fine — the visual defect only appeared at full maximize

---

## Root Cause

The `win32_border::remove_border()` function in `lib.rs` installs a window subclass proc that intercepts `WM_NCCALCSIZE`. When `wParam == 1` (Windows asking "what should the client area be?"), the proc returns `0`, telling Windows the entire window rect is client area.

This is correct behavior for a normal (non-maximized) frameless window — it removes the 1px top non-client border that Windows draws.

**The problem**: `WS_THICKFRAME` is also set (required for resize dragging). When a window with `WS_THICKFRAME` is maximized, Windows expands the window rect by ~8px on each side beyond the screen boundary. This is intentional — it hides the invisible resize borders off-screen so they don't visually appear on the desktop. The window is positioned at roughly `(-8, -8)` with size `(screen_w + 16, screen_h + 16)`.

By returning `0` unconditionally in `WM_NCCALCSIZE`, we made the client area equal to this oversized rect. The 8px overflow on each side is outside the monitor's visible area, so that content is never rendered. At each corner, you lose 8px in both X and Y directions — a diagonal clip that looks exactly like rounded corners.

---

## Failed First Attempt

**Hypothesis**: The visual was caused by Windows 11 DWM rounded corner preference (`DWMWCP_ROUND`) still being applied to the maximized window, clipping the WebView content at the corners.

**Approach**: Added a `set_window_corners` Tauri command that called `DwmSetWindowAttribute(DWMWCP_DONOTROUND)` when maximized, and restored `DWMWCP_ROUND` when unmaximized. Called this from `TabBar.tsx`'s `isMaximized` useEffect.

**Why it failed**: Windows 11 automatically handles DWM corner preferences for maximized windows — it already shows square corners regardless of the `DWMWCP_ROUND` preference. So setting `DWMWCP_DONOTROUND` explicitly had no visible effect. The DWM corner approach was solving the wrong problem entirely. The actual clipping was not from DWM frame rendering but from the client rect overflowing the screen.

---

## Fix

In `src-tauri/src/lib.rs`, updated the `subclass_proc` to only return `0` when the window is **not** maximized:

```rust
const WS_MAXIMIZE: isize = 0x01000000;

unsafe extern "system" fn subclass_proc(...) -> isize {
    if msg == WM_NCCALCSIZE && wparam == 1 {
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        if (style & WS_MAXIMIZE) == 0 {
            // Not maximized: remove all non-client area
            return 0;
        }
        // Maximized: fall through to DefSubclassProc
        // This correctly clips the client area to the visible monitor bounds
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}
```

When maximized, `DefSubclassProc` handles `WM_NCCALCSIZE` and correctly positions the client area within the monitor's visible bounds, accounting for the `WS_THICKFRAME` overflow.

The only minor tradeoff: when maximized, Windows may draw a 1px top non-client border (since we're no longer intercepting it). This is visually acceptable.

---

## Prevention

- **Any frameless Tauri/Electron window using `WS_THICKFRAME` for resize + `WM_NCCALCSIZE` returning 0**: always guard against the maximized case. `WS_THICKFRAME` + maximize = oversized window rect by design.
- **When the user describes "rounded corners" on a maximized frameless window**: first check if content is simply overflowing the screen bounds (WM_NCCALCSIZE issue), before investigating DWM corner preferences.
- The `set_window_corners` command added during the failed attempt remains in `lib.rs` and is harmless but unused — can be removed in a cleanup pass.

---

## Verification

1. Run `npm run tauri:dev`
2. Maximize the window — content should fill all four corners cleanly
3. Restore the window — normal frameless appearance with shadow and rounded corners
4. `npm run typecheck` — passes clean
