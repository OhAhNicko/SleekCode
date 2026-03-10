# 2026-03-10: Window snap taskbar overlap + COLORTERM env gap on resume

## Summary

Two issues fixed:

1. **Window snap (Win+Left/Right) caused the app to extend behind the Windows taskbar**, hiding bottom content.
2. **Resumed CLI panes and SSH sessions were missing `COLORTERM=truecolor`**, potentially causing degraded color output.

## Symptoms

### Snap overlap
- Pressing Win+Left or Win+Right to snap the window would make the bottom of the viewport go behind the taskbar.
- Content at the bottom of the app was invisible/inaccessible.

### COLORTERM gap
- Resumed panes (session restore) and SSH remote panes didn't get `COLORTERM=truecolor` in their environment.
- CLIs may have rendered with 256-color fallback instead of 24-bit truecolor.

## Root cause

### Snap overlap
The `WM_NCCALCSIZE` subclass handler in `lib.rs` only handled the maximize case (`WS_MAXIMIZE` flag set). Win+Left/Right snap does **not** set `WS_MAXIMIZE` — the window is just repositioned. However, because `WS_THICKFRAME` is set (required for resize dragging), Windows extends the proposed window rect a few pixels beyond the work area boundaries during snap. The handler returned `0` for non-maximized windows (meaning "client area = entire proposed rect"), so the client area included the overshoot pixels that extended behind the taskbar.

The previous fix for maximize (falling through to `DefSubclassProc`) worked because `DefSubclassProc` clips to the visible monitor area when `WS_MAXIMIZE` is set. But for snap without `WS_MAXIMIZE`, `DefSubclassProc` doesn't apply that clipping.

### COLORTERM gap
Five spawn paths exist in `terminal-config.ts` / `usePty.ts`:
- **Fast path** (new pane, cached CLI): sets both via `/usr/bin/env` args
- **Pooled path** (new pane, WSL pool): sets both via `export` in init command
- **`pty_spawn` fallback** (pool empty): sets both via `env` map
- **Resume/slow path** (`bash -lic`): only inherited `.bashrc` — **missing `COLORTERM`**
- **SSH remote path**: only inherited remote shell — **missing `COLORTERM`**

The resume path was added later specifically to handle `--resume` flag parsing (wsl.exe mangles separate args), and the env setup was overlooked.

## Fix

### Snap overlap (`src-tauri/src/lib.rs`)
- Added FFI declarations for `MonitorFromWindow`, `GetMonitorInfoW`, and structs `RECT`, `MONITORINFO`, `NCCALCSIZE_PARAMS`.
- Rewrote `subclass_proc` to explicitly query the monitor work area:
  - **Maximized** (`WS_MAXIMIZE`): set `rgrc[0]` to the work area exactly (replaces the `DefSubclassProc` fallthrough).
  - **Non-maximized** (snap or normal): clamp `rgrc[0]` edges to work area boundaries. For normal floating windows the proposed rect is already within bounds, so the clamps are no-ops. For snap, this trims the `WS_THICKFRAME` overshoot.
- Always returns `0` (no non-client area) — no more fallthrough to `DefSubclassProc`.

### COLORTERM gap (`src/lib/terminal-config.ts`)
- Resume path (line 91): prepended `export TERM=xterm-256color COLORTERM=truecolor;` to the `bash -lic` command string.
- SSH path (lines 213-217): prepended the same `export` to the remote command.

## Prevention

- **When adding a new spawn path, audit all env vars** — grep for `TERM=` and `COLORTERM=` across all paths to ensure consistency.
- **When handling Win32 window messages, test all window states** — maximize, snap-left, snap-right, snap-fill, normal. `WS_MAXIMIZE` is not set for all "docked" states.
- **Don't rely on `DefSubclassProc` for frameless windows** — it was designed for decorated windows. Explicitly computing work area bounds is more reliable.

## Verification

- `npm run build` passes (tsc + vite, 0 errors).
- Snap fix requires Tauri rebuild (`npm run tauri:dev`) to test the Rust changes.
- Test: Win+Left, Win+Right, Win+Up (maximize), double-click titlebar (maximize), drag to restore — window should never extend behind taskbar.
- COLORTERM: resume a Claude session and check `echo $COLORTERM` prints `truecolor`.
