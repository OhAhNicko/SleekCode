# Quit Confirmation Dialog — Close Button + OS Intercept

## Summary
Added a "Are you sure?" confirmation dialog when the user closes EzyDev, with a "Do not show again" checkbox that permanently disables it. The setting is also togglable any time from the Settings menu (Behavior section). Both the in-app close button (top-right X) and OS-level close events (Alt+F4, taskbar) are intercepted.

## Implementation

### Two close paths to handle
There are two distinct ways the window can close in a Tauri app:
1. **Custom close button** — the `onClick` handler in `TabBar.tsx` that calls `getCurrentWindow().close()`
2. **OS-level close** — Alt+F4, taskbar right-click → Close, or window manager close. These bypass the custom button entirely and fire a Tauri `CloseRequested` event.

Both paths needed to be intercepted independently.

### Tauri v2 `onCloseRequested`
In Tauri v2, `getCurrentWindow().onCloseRequested(handler)` intercepts OS-level close events. Calling `event.preventDefault()` inside the handler stops the window from closing. To actually close afterwards (when the user confirms), call `getCurrentWindow().destroy()` — calling `.close()` again would re-trigger the event and loop.

```ts
// App.tsx
getCurrentWindow().onCloseRequested((event) => {
  const { confirmQuit } = useAppStore.getState();
  if (confirmQuit) {
    event.preventDefault();
    window.dispatchEvent(new Event("ezydev:quit-requested"));
  }
}).then((fn) => { unlisten = fn; });
```

Reading from `useAppStore.getState()` inside the handler (rather than capturing from a `useEffect` closure) avoids the stale-closure problem — the setting is always current at event time.

### Cross-component event relay
The `onCloseRequested` handler lives in `App.tsx`, but the dialog state lives in `TabBar.tsx` (where the settings toggle also lives). A custom window event `ezydev:quit-requested` bridges them — App dispatches, TabBar listens and sets `showQuitConfirm(true)`.

### Custom close button
The close button onClick now checks `confirmQuit` first:
- If enabled: `setShowQuitConfirm(true)` (no `.close()` call — avoids triggering the Tauri event a second time)
- If disabled: `getCurrentWindow().close()` as before (flows through the Tauri handler, which won't preventDefault)

### "Do not show again" checkbox
A local `quitDontShow` boolean resets to `false` each time the dialog opens. When the user confirms quit with it checked, `setConfirmQuit(false)` is called before `destroy()`. The setting persists in localStorage via the Zustand `partialize` array.

## Files changed
- `src/store/recentProjectsSlice.ts` — `confirmQuit: boolean` (default `true`) + `setConfirmQuit`
- `src/store/index.ts` — `confirmQuit` added to `partialize`
- `src/App.tsx` — `onCloseRequested` Tauri handler, imports `getCurrentWindow`
- `src/components/TabBar.tsx` — close button logic, `ezydev:quit-requested` listener, dialog JSX, settings toggle

## Prevention / Key patterns
- **Never call `.close()` from inside the confirm action** — use `.destroy()`. Calling `.close()` after `preventDefault()` re-fires the event.
- **Read store values inside the event handler via `getState()`** to avoid stale closures in long-lived `useEffect` setups.
- **Reset local dialog state (`dontShowAgain`) on open**, not on close — ensures a fresh state each time the dialog appears.
- **`onCloseRequested` returns a promise** for the unlisten function — must await/`.then()` and store it for cleanup in the `useEffect` return.

## Verification
- `npm run typecheck` — passes clean, no errors
- Manual: click X → dialog appears → Cancel dismisses → Quit closes app
- Manual: Alt+F4 → same dialog
- Manual: check "Do not show again" + Quit → subsequent X click closes immediately
- Manual: Settings → Behavior → "Confirm before quitting" toggle re-enables it
