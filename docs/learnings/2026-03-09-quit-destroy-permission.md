# Quit Button Broken — `destroy()` Needs `core:window:allow-destroy`

## Summary

The "Quit" button in EzyDev's close confirmation dialog did nothing. The root cause was a missing Tauri v2 capability permission: `core:window:allow-destroy`. The fix is a one-line addition to `capabilities/default.json`. A failed intermediate fix (replacing `destroy()` with `close()`) introduced additional regressions and is documented in detail below.

## Symptoms

- Clicking "Quit" in the confirmation dialog had no effect — app stayed open.
- No visible error. The `destroy()` call returned a rejected Promise that was never caught.

## Root Cause

In Tauri v2, every window command requires an explicit capability entry. `getCurrentWindow().destroy()` maps to the `plugin:window|destroy` command, which requires `core:window:allow-destroy`. The capabilities file only had `core:window:allow-close`. Without the permission, the JS call silently fails.

```json
// Was missing:
"core:window:allow-destroy"
```

## Failed Intermediate Fix — And Why It Made Things Worse

### Attempt: replace `destroy()` with `close()` + bypass flag

Reasoning: `close()` is already permitted (`core:window:allow-close`). To avoid the re-fire loop (calling `close()` from within the `onCloseRequested` flow re-triggers the event), a module-level `quitState.confirmed` flag was added. The handler would skip `preventDefault()` when the flag was true.

```ts
// quitState.ts
export const quitState = { confirmed: false };

// App.tsx onCloseRequested
if (confirmQuit && !quitState.confirmed) { event.preventDefault(); ... }

// TabBar.tsx Quit button
quitState.confirmed = true;
getCurrentWindow().close();
```

### Why it broke more things

1. **The close loop problem was already documented.** `docs/learnings/2026-03-09-quit-confirmation-dialog.md` explicitly warned: *"Never call `.close()` from inside the confirm action — use `.destroy()`. Calling `.close()` after `preventDefault()` re-fires the event."* This was ignored during the first fix attempt.

2. **The X button (popup disabled) stopped working.** Even though the App.tsx change was logically equivalent for the `confirmQuit = false` branch, the user reported the X button no longer closed the app. The most likely explanation: HMR applied the change, but Vite may have created a new module instance for `quit-state.ts` without properly cleaning up the stale `onCloseRequested` listener from the old module instance. The stale listener had the old logic. With multiple listeners registered, behavior became unpredictable.

3. **Module-level shared state + HMR is fragile.** Exporting a mutable object from a new module and relying on it across component boundaries (App.tsx + TabBar.tsx) is risky under HMR — each hot reload can create new module instances while stale event listeners hold references to old instances.

## Fix

Add the missing permission to `src-tauri/capabilities/default.json`:

```json
"core:window:allow-destroy",
```

Revert all `quitState` changes. The original `destroy()` call is correct.

**Requires a full Tauri rebuild** — capabilities are compiled into the binary. `npm run tauri:dev` picks up the change.

## Prevention

- **Check `docs/learnings/` before implementing a fix** — the quit dialog gotcha was already documented.
- **`destroy()` vs `close()` distinction in Tauri v2:**
  - `close()` = polite request → triggers `onCloseRequested` → can be `preventDefault()`'d
  - `destroy()` = force kill → bypasses `onCloseRequested` entirely → requires `core:window:allow-destroy`
- **When `destroy()` appears in code but doesn't work, check capabilities first** — the failure is silent (rejected Promise, not caught).
- **Don't replace `destroy()` with `close()` inside the confirm flow** — it creates a re-fire loop. The permission approach is the right fix.

## Verification

- `npm run typecheck` — passes clean.
- Full `tauri:dev` restart required to apply capability change.
- Manual: click X → dialog → Quit → app closes.
- Manual: disable popup → click X → app closes directly.
