# Dev Server Lock Error Detection — Port-Before-Error Race Condition

## Summary

When restarting a Next.js dev server, the process prints its port URL (`localhost:3001`) BEFORE checking for lock file conflicts. Our port detection logic saw the port, marked the server as "running" (green dot), and unregistered the data listener — so the lock error that followed seconds later was never seen. The server showed as "running" with a green dot despite having failed to start.

## Symptoms

- Restarting a Next.js dev server showed green "running" dot even when the server failed with a lock error
- The error `Unable to acquire lock at .../.next/dev/lock, is another instance of next dev running?` appeared in the terminal but was not detected
- The server card stayed green indefinitely — the PTY shell remained alive (returned to `$` prompt), so `onPtyExit` never fired

## Root Cause

Next.js startup sequence:
1. Prints `Port 3000 is in use, using available port 3001 instead`
2. Prints `http://localhost:3001` (port URL)
3. Prints `Starting...`
4. Prints `Unable to acquire lock` error

Our detection logic:
1. Saw `localhost:3001` in step 2 → matched `PORT_REGEX`
2. Set `resolvedRef` + `portDetectedRef`, status = "running", green dot
3. **Unregistered the data listener** — no more output scanning
4. Lock error in step 4 arrived to an already-dead listener
5. The npm command returned to shell prompt (`$`), but the PTY shell stayed alive → `onPtyExit` never fired
6. Server stuck showing "running" forever

### Why the initial auto-retry approach failed

The first fix attempt added lock error patterns to the detection list and an auto-retry mechanism. But it was structured to check lock errors AFTER the `if (resolvedRef.current.has(ds.id)) return;` guard — and the port detection had already set `resolvedRef` and unregistered the listener. The lock patterns were never reached.

### Why just reordering checks didn't help

The port text and lock error arrive as separate data chunks in the PTY stream. When the port chunk arrives, the lock error isn't in the buffer yet. By the time the lock error chunk arrives, the listener is gone.

## Fix

**Grace window after port detection** — don't immediately resolve and unregister:

1. When port is detected: update port in store, set status "running", BUT keep the listener active
2. Start an 8-second grace timer
3. The lock error check runs **unconditionally** on every data chunk — the `resolvedRef` guard only gates port/generic-error checks, not lock checks
4. If a lock error arrives during the grace window: cancel the timer, clear the "resolved" state, and auto-retry (double Ctrl+C, wait 2-3.5s, re-run command)
5. After 8 seconds with no lock error: finally unregister the listener (server is truly running)
6. Up to 2 auto-retries with increasing delays, then show "Lock file conflict" error

Also improved restart mechanism:
- Double Ctrl+C (100ms apart) for processes that need confirmation
- Increased base restart delay from 500ms to 1500ms for lock file release

## Prevention

- **Never unregister PTY data listeners immediately on first positive match** — dev server startup is multi-phase. A port URL being printed doesn't mean the server is healthy. Keep listening for a grace period.
- **Lock/fatal errors should bypass all gating** — check them unconditionally on every data chunk regardless of other state flags.
- **PTY exit ≠ process exit** — the shell survives when a command fails. Don't rely on `onPtyExit` for detecting command failures within a running shell.

## Verification

1. Start a Next.js dev server via EzyDev
2. While it's running, restart it → should detect lock error, auto-retry, and eventually succeed
3. If lock persists after 2 retries → shows red dot + "Lock file conflict" error message
4. `npm run build` passes with no errors
