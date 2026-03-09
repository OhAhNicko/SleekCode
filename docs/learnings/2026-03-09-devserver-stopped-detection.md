# Dev Server Stopped Detection

**Date:** 2026-03-09
**File:** `src/components/DevServerTerminalHost.tsx`

---

## Summary

Three separate bugs in `DevServerTerminalHost` caused dev server status indicators to get stuck:

1. After Ctrl+C, the server showed "running" forever (no stopped detection).
2. After fix #1, clicking "play" to restart left the server stuck at "detecting..." forever.
3. After fix #2, clicking "restart" also left the server stuck at "detecting..." forever.

All three were fixed, but each required understanding a distinct failure mode.

---

## Bug 1: No stopped detection after Ctrl+C

### Symptoms
Server stops (Ctrl+C → shell returns to `$` prompt), but the status indicator stays green ("running") indefinitely.

### Root cause
After port detection, a grace timer fires after 8 seconds and calls `unregisterTerminalDataListener(ds.terminalId)`. After that, **no listener exists** — the PTY data for `^C` + shell prompt is completely invisible to the detection code. The `onPtyExit` path doesn't fire either because the PTY shell (bash) is still alive; only the server subprocess exited.

There was also a gap during the 8-second grace period: when `updateDevServerStatus("running")` is called, React re-renders, the main `useEffect` cleanup re-runs (unregistering the old listener), and the new listener has fresh state (`portFound = false`). This new listener never detects "stopped" because it has no prompt detection logic.

### Fix
Three-layer approach:

1. **Save the new chunk separately** in the listener: `const chunk = textDecoder.decode(data, { stream: true }); buffer += chunk;`. This lets us check fresh incoming data independently from the accumulated buffer.

2. **Grace-period detection (0–8s after port found):** After port detection sets `portDetectedRef.current.add(ds.id)`, the re-registered listener checks each new `chunk` (not the full buffer) for a shell prompt pattern. If found, cancels the grace timer and sets status "stopped".
   ```
   if (portDetectedRef.current.has(ds.id)) {
     if (/[\$%#] $/.test(cleanChunk)) { ... stopped ... }
     return;
   }
   ```

3. **Post-grace detection (8s+):** The grace timer now registers a **new lightweight "stopped monitor" listener** instead of fully unregistering. It accumulates a small 500-byte monitor buffer and watches for shell prompt patterns.

4. **Effect cleanup guards resolved servers:** Changed the main effect cleanup to skip `unregisterTerminalDataListener` for servers with `resolvedRef.current.has(ds.id)`, so the stopped monitor survives React re-renders.

Shell prompt pattern used: `/[\$%#] $/` — shell prompt character followed by a space at end of cleaned buffer. Avoids false positives (dev server log output rarely ends with `$ ` or `% `).

Also changed port detection from `buffer.match(PORT_REGEX)` to `cleanBuffer.match(PORT_REGEX)` so ANSI color codes around URLs don't break matching.

---

## Bug 2: Play button stuck at "detecting..." after restart

### Symptoms
After stopping the server (status correctly shows "stopped"), clicking the Play (▶) button starts the server but status never leaves "detecting..." ("starting" state).

### Root cause
The Play button handler was:
```js
const write = getPtyWrite(expandedServer.terminalId);
if (write) write(expandedServer.command + "\r");
updateDevServerStatus(expandedServer.id, "starting");
```

It called `updateDevServerStatus("starting")` **without first clearing `resolvedRef.current`**. Here's why that mattered:

React effects run in definition order — the main data-listener effect runs **before** the cleanup/restart effect. So after the state update triggered a re-render:

1. **Main effect cleanup** (runs first): My new guard `if (!resolvedRef.current.has(ds.id))` saw `resolvedRef` still had the server's ID → **skipped `unregisterTerminalDataListener`** (correct for keeping the stopped monitor alive during normal operation, but wrong here).
2. **Main effect body** (runs second): `if (resolvedRef.current.has(ds.id)) continue` → **skipped registering a new listener** entirely.
3. **Cleanup effect** (runs last): `resolvedRef.current.delete(ds.id)` — cleared resolvedRef, but **no re-render is triggered by ref mutation**, so the main effect never re-runs.

Result: no listener ever registered for the restarted server.

### Fix
Clear all resolved state **before** triggering the React state update:
```js
resolvedRef.current.delete(expandedServer.id);
portDetectedRef.current.delete(expandedServer.id);
stoppedMonitorRef.current.delete(expandedServer.id);
const write = getPtyWrite(expandedServer.terminalId);
if (write) write(expandedServer.command + "\r");
updateDevServerStatus(expandedServer.id, "starting");
```

With `resolvedRef` cleared before the re-render, the main effect cleanup correctly calls `unregisterTerminalDataListener` (removing any old stopped monitor), and the main effect body correctly registers a fresh port-detection listener.

### Key insight
**Ref mutations do not trigger React re-renders.** If logic depends on a ref having a certain value when an effect runs, that ref must be mutated synchronously before the state update that triggers the render — not after it in a later effect.

---

## Bug 3: Restart button also stuck at "detecting..."

### Symptoms
Same as Bug 2, but triggered by the Restart (↺) button rather than Play.

### Root cause
`restartServer()` correctly cleared `resolvedRef` and `portDetectedRef` before calling `updateDevServerStatus("starting")`. So the main effect body **did** register a fresh listener. However, the cleanup effect's restart loop then **killed it**:

```js
// Cleanup effect — restart detection loop
if (stoppedMonitorRef.current.has(ds.id)) {
  unregisterTerminalDataListener(stoppedMonitorRef.current.get(ds.id)!);  // ← bug
  stoppedMonitorRef.current.delete(ds.id);
}
```

This code runs **after** the main effect (which already registered a new port-detection listener). `stoppedMonitorRef.current` still had the server's entry from the previous "stopped monitor" — so the cleanup effect called `unregisterTerminalDataListener`, killing the freshly-registered new listener. Status stuck at "detecting...".

### Why this was masked for Bug 2
Bug 2 (Play) was never exercised before Bug 1 was fixed, because when stopped detection didn't work, the server was always in "running" state — the Stop button was shown, not the Play button. Only once stopped detection was fixed did the Play path become reachable.

### Fix
Two changes:

1. **`restartServer` callback**: add `stoppedMonitorRef.current.delete(serverId)` before the state update, so when the cleanup effect's restart loop runs, `stoppedMonitorRef.current.has(ds.id)` is already `false` and the `unregisterTerminalDataListener` call is skipped.

2. **Cleanup effect restart loop**: removed the `unregisterTerminalDataListener` call entirely. The main effect cleanup already handles unregistering the old listener (since `resolvedRef` is cleared before the re-render). Keeping `unregisterTerminalDataListener` in the cleanup effect was incorrect — it runs *after* the new listener is registered, not before.

---

## Prevention

- **React effect ordering is deterministic: cleanup of previous effects, then new effect bodies, in definition order.** For two effects that interact, the second one's body runs after the first one's body. If the second effect modifies state that the first effect reads, the first effect has already committed to its decision by the time the second effect runs.
- **Any ref that gates a `useEffect` must be mutated synchronously before the state update that triggers the render.** "Clear the ref in a later effect" is too late.
- **A single listener slot per terminal ID means an effect registering a new listener and another effect unregistering via `unregisterTerminalDataListener` are in conflict.** Guard all `unregisterTerminalDataListener` calls with checks that verify the listener you're removing is the one you think it is.

---

## Verification

- `npm run typecheck` passes.
- Manually tested: start server → Ctrl+C → status goes to "stopped" → click Play → status goes through "detecting..." → "running" → Ctrl+C again → "stopped". Restart button follows same pattern.
