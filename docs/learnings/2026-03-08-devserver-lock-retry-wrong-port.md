# Dev Server Lock Error Retry Killed Wrong Port

**Date:** 2026-03-08

## Summary

The dev server lock error retry logic killed the wrong port, causing an infinite retry loop. Additionally, the server status dot showed green ("running") immediately on launch, before the port was confirmed.

## Symptoms

- Opening a project tab with `npm run dev` when a previous Next.js instance was still running caused the lock error: "Unable to acquire lock at .next/dev/lock, is another instance of next dev running?"
- The retry logic sent Ctrl+C + re-ran the command, but the old process was never actually killed, so the same lock error occurred again.
- After 2 retries the error was shown, but during the retries the server row showed a green dot as if everything was fine.

## Root Cause

Two distinct issues:

### 1. Killing the wrong port

When Next.js detects port 3000 is in use, it auto-increments to 3001 and prints `http://localhost:3001`. Our port detection picked up 3001 and stored it in `ds.port`. Then the lock error fired (within the 8-second grace window). The cleanup command used `ds.port` (3001) to run `fuser -k 3001/tcp` -- this killed **our own newly-started process** instead of the **old stale process on port 3000** that was holding the lock.

The sequence:
1. Old Next.js is running on port 3000, holding `.next/dev/lock`
2. New `npm run dev` starts, detects port 3000 in use, auto-picks 3001
3. Port detection fires: `ds.port` updated to 3001
4. Lock error fires (old process holds the lock)
5. Retry: `fuser -k 3001/tcp` kills our NEW process, not the OLD one on 3000
6. Lock file still held by port-3000 process, retry fails identically

### 2. Premature green status dot

The DevServer status was set to `"running"` the moment the command was sent, not when the port was actually confirmed. This meant the green dot appeared immediately, misleading the user into thinking the server was healthy during retries.

## Fix

### Added "starting" status
- New status: `"starting" | "running" | "stopped" | "error"`
- All start/restart paths set `"starting"` initially
- Only port detection confirmation promotes to `"running"`
- StatusDot shows muted gray at 60% opacity for "starting"

### Fixed cleanup to kill the correct port
- `buildCleanupPrefix(command, detectedPort)` now ALWAYS kills `guessDefaultPort(command)` (e.g., 3000 for Next.js) in addition to `detectedPort`
- The old stale process lives on the default port, not the auto-incremented one
- Also removes framework-specific lock files (`.next/dev/lock`)

### Retry escalation
- 1st retry: Kill default port + detected port + remove lock file, then same command
- 2nd retry: Same cleanup + try with `--port <default+1>` to avoid conflict entirely
- If both fail: show error, stop retrying

## Prevention

- When dealing with port conflicts, always consider which process owns which port. The "detected" port from output parsing is the NEW process, not the OLD one.
- Status indicators should reflect confirmed state, not optimistic state. Use a distinct "pending" status when the outcome is unknown.
- `guessDefaultPort()` helper centralizes framework-specific port knowledge for reuse.

## Verification

- `npm run build` passes (tsc + vite)
- User confirmed the fix works: old processes are killed, server starts cleanly
