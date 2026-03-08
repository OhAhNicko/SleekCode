# PTY spawns at wrong dimensions causing TUI rendering artifacts

**Date**: 2026-03-07

## Summary

When opening a project with multiple split panes (session restore or template), terminal panes rendered with wrong dimensions. Claude Code's TUI showed garbled overlapping text. Resizing the window manually forced a re-fit that fixed everything.

## Symptoms

- Claude Code welcome banner had overlapping/garbled text in the middle (characters from two different column widths rendered on top of each other)
- Text wrapping was incorrect — lines wrapped at the wrong column
- Only happened on multi-pane project open (session restore, template launch)
- Manually resizing the window and back immediately fixed it
- Single-pane opens were fine (the default 80x24 happened to be close enough, or the pane was full-width)

## Root cause

**The PTY was spawning with default 80x24 dimensions before `fitAddon.fit()` could measure the real container size.**

The timing:
1. Component renders -> `usePty` hook captures `initialDims = { cols: 80, rows: 24 }` from props
2. `usePty` effect fires -> `setTimeout(async () => spawn, 0)` (macrotask, deferred)
3. `initTerminal` effect fires -> `ensureHackFont().then(initTerminal)` (async font load)
4. **setTimeout(0) fires** -> PTY spawns with cols=80, rows=24
5. **Font loads** -> `initTerminal` runs -> `fitAddon.fit()` -> terminal resized to e.g. 60x30
6. `term.onResize` fires -> `resize(60, 30)` -> but PTY already started at 80x24

The ConPTY process starts Claude Code, which immediately draws its TUI at 80 columns. Then the resize signal arrives, Claude Code redraws, but the initial 80-column output is already in the xterm buffer, creating garbled overlap artifacts.

## Failed attempts and why they failed

### Attempt 1: Double-rAF + 300ms safety timeout re-fit

**Hypothesis**: `fitAddon.fit()` runs before `react-resizable-panels` has finalized panel sizes, so re-fitting after layout settles would fix it.

**Why it failed**: The issue was never about container dimensions or CSS layout timing. `fitAddon.fit()` WAS measuring correct container dimensions. The problem was that `resize()` calls were silently dropped because `ptyIdRef.current` was null (PTY hadn't spawned yet). Extra `fit()` calls just triggered more dropped `resize()` calls.

### Attempt 2: Buffer pending resize in usePty, replay after spawn

**Hypothesis**: Since `resize()` is dropped when PTY hasn't spawned, buffer the latest resize and replay it after `ptyIdRef.current` is set.

**Why it failed partially**: The resize DID get replayed after spawn, but there was still a **race condition**. The PTY spawned at 80x24 and Claude Code started drawing immediately. The buffered resize arrived milliseconds later, causing SIGWINCH. Claude Code redrew, but the initial 80-column output was already in the buffer, creating the same artifacts. The resize came too late — it needed to never be wrong in the first place.

### Attempt 3 (final fix): `ready` flag to defer PTY spawn

**Hypothesis**: Don't spawn the PTY until `fitAddon.fit()` has determined the real dimensions, so the PTY starts at the correct size from the beginning.

**Why it worked**: By adding a `ready` boolean state (initially false, set to true after `fitAddon.fit()`), the PTY spawn is completely deferred until the terminal knows its real dimensions. The spawn uses `colsRef`/`rowsRef` (updated via the re-render triggered by `setTermReady(true)`) to read the latest correct values. No race condition — the PTY starts at the right size.

## Fix

### `src/hooks/usePty.ts`
- Added `ready?: boolean` option (default true for backward compat)
- Added `colsRef`/`rowsRef` to read latest dimensions at spawn time (not closure-captured stale values)
- Early return from spawn effect when `!ready`
- Added `ready` to effect dependency array
- Kept `pendingResizeRef` as defense-in-depth for edge cases (panel resize between init and spawn)

### `src/components/TerminalPane.tsx`
- Added `termReady` state (initially false)
- Set `termReady = true` after `fitAddon.fit()` + `initialDims` update
- Passed `ready: termReady` to `usePty`

## Prevention

- **Never spawn a PTY with default/guessed dimensions** — always wait for the actual container measurement. The cost of a few ms delay is invisible; the cost of wrong dimensions is visually broken TUI apps.
- **When a hook captures values at render time but uses them in deferred async work, use refs** — closure-captured values are stale by the time setTimeout/async callbacks execute. The existing pattern in usePty (workingDirRef, serverIdRef) already does this for other values; cols/rows were the exception.
- **When debugging "resize fixes it" bugs, check whether the initial dimensions were correct AND whether the resize IPC actually reached the PTY** — a resize that's silently dropped (null ptyId check) looks exactly like a resize that never happened.

## Verification

1. `npm run build` passes
2. Open a project with multiple Claude Code panes (session restore or template)
3. Terminals should render correctly without needing a window resize
4. Split an existing pane — new terminal should render correctly
5. Window resize — existing behavior still works
