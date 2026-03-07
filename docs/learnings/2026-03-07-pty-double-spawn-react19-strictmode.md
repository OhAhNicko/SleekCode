# PTY Double-Spawn: React 19 StrictMode + Stale Channel Data

**Date**: 2026-03-07

## Summary

Claude panes showed duplicate `/remote-control is active` messages because the PTY was spawning twice — once from a stale React StrictMode effect that leaked data before being cancelled, and once from the real effect. Two separate bugs contributed: (1) the `usePty` effect had too many dependencies causing spurious re-runs, and (2) the Tauri IPC Channel's `onmessage` handler had no guard against stale spawns.

## Symptoms

- Multiple `/remote-control is active` lines appearing in Claude terminal panes
- Happened during runtime (not just on startup)
- On app restart with session resume, the resume command appeared to run twice
- All Claude panes affected simultaneously

## Root Cause

Two compounding issues in `src/hooks/usePty.ts`:

### Issue 1: Overly broad effect dependencies

The `useEffect` depended on `[terminalType, workingDir, serverId, injectShellIntegration]`. While these values *should* be stable for an existing terminal, parent re-renders (from Zustand store updates like `setActiveTerminal` recreating all terminal objects, or layout changes from session resume ID updates) could cause the effect to re-fire. Any re-fire kills the existing PTY and spawns a new one — restarting Claude mid-session.

### Issue 2: Missing spawnId guard on data Channel

The `setTimeout(0)` pattern was designed for React 18's synchronous StrictMode mount/cleanup/mount cycle. In React 19 (which this project uses), if the timer fires before cleanup runs — or if the effect re-fires for any reason — the first PTY spawn starts and its Channel immediately begins forwarding data to the terminal. The exit Channel had a `spawnIdRef` guard:

```js
onExitChan.onmessage = (code) => {
  if (spawnIdRef.current === thisSpawnId) { // ← guard exists
    onExit(code);
  }
};
```

But the data Channel did NOT:

```js
onDataChan.onmessage = (data) => {
  onData(new Uint8Array(data)); // ← no guard! stale spawn data leaks through
};
```

So even when the stale PTY was quickly killed after the `cancelled` check, data (including the `/remote-control` banner) had already been written to the xterm terminal.

## Debugging Story

The initial investigation focused on finding which prop change triggered the `usePty` effect re-run. Static analysis of the render chain (App → Workspace → TerminalPane portal) showed that all dependency values *should* be identical across re-renders (they're primitive strings/booleans). This was a red herring — the re-runs were happening but were hard to pinpoint statically because they depend on exact React scheduling and Zustand selector behavior at runtime.

The breakthrough came from recognizing that:
1. React 19 + StrictMode = effects double-fire with potentially async timing
2. The `setTimeout(0)` guard is a timing trick, not a correctness guarantee
3. The data Channel was the actual leak path — even "briefly alive" stale PTYs can output startup banners

## Fix

Three changes to `src/hooks/usePty.ts`:

1. **Reduced effect deps to `[terminalType]` only** — moved `workingDir`, `serverId`, `injectShellIntegration`, `onData`, `onExit` to refs. Only an explicit CLI type switch (shell → claude) should restart a PTY.

2. **Added spawnId guard to data Channel**:
   ```js
   onDataChan.onmessage = (data) => {
     if (spawnIdRef.current !== thisSpawnId) return; // discard stale data
     onDataRef.current(new Uint8Array(data));
   };
   ```

3. **Added `isStale()` helper** checked at every await point:
   ```js
   const isStale = () => cancelled || spawnIdRef.current !== thisSpawnId;
   ```
   Used after `await wslReady`, after `invoke("pty_spawn"/"pty_spawn_pooled")`, and in the error handler.

## Prevention

- **Always guard IPC Channel handlers with a generation/spawn ID** when the Channel can outlive the effect that created it. Both data and exit handlers need the guard.
- **Minimize effect dependencies for expensive side effects** (PTY spawn, WebSocket connect, etc.). Use refs for config that doesn't change during the resource's lifetime.
- **Don't rely on `setTimeout(0)` for correctness** in React 19 — it's a performance optimization (avoids wasted allocations in StrictMode), not a safety guarantee. The real safety comes from the spawnId guard.
- **React 19 StrictMode**: effect double-fire timing may differ from React 18. Always design effects to be idempotent or properly guarded, don't assume synchronous mount/cleanup/mount.

## Verification

1. `npx tsc --noEmit` passes clean
2. On app restart with session resume: each Claude pane should show `/remote-control is active` exactly once
3. During runtime: splitting panes, switching tabs, focusing terminals should never restart existing Claude processes
4. Check DevTools console: `[PTY] using pool` or `[PTY] normal spawn` should appear once per terminal on startup, not repeated
