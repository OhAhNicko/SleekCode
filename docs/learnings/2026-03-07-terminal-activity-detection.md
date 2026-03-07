# Terminal Activity Detection — AI Work Indicator

## Summary
Added pane count and active AI work indicator to tab labels (e.g., "ttm5 3 (1)" = 3 panes, 1 with AI actively working). Required ~10 iterations to get false-positive-free detection of AI terminal output vs user typing, TUI idle output, and resize reflow.

## Symptoms
- Tab switch caused all panes to show as active for several seconds
- User typing in one pane triggered the active indicator
- Idle AI panes (cursor blinks) accumulated enough data to cross thresholds
- Switching tabs caused panes to appear "frozen" (xterm.js doesn't render in `display: none`)
- Left-side panes scrolled to top on tab switch

## Root Causes

### 1. `term.onData` fires for ALL data, not just user keystrokes
**Faulty reasoning**: "onData fires when user types, so use it to detect user input and suppress activity tracking."
**Reality**: `term.onData` fires for TUI control sequences too — Claude CLI's interface generates onData events for cursor movements, screen updates, etc. This caused `recordTerminalWrite` to reset the burst tracker mid-AI-stream, killing valid active detection.
**Fix**: Moved user input detection to `attachCustomKeyEventHandler`, which only fires on real keyboard events.

### 2. Resize reflow produces sustained high-volume output
**Faulty reasoning**: "A simple byte threshold (500 bytes) or short duration will filter resize noise."
**Reality**: TUI apps like Claude CLI do full screen redraws on resize that produce 1000+ bytes over 1.5+ seconds — indistinguishable from real AI work by volume/duration alone.
**Fix**: Added resize lockout window (2.5s) that prevents NEW bursts from starting, but doesn't kill confirmed active bursts. IntersectionObserver fires lockout even when tab switch doesn't change terminal dimensions.

### 3. TUI idle output (cursor blinks) accumulates over time
**Faulty reasoning**: "If we filter by sustained duration (1.5s), idle terminals won't cross the threshold."
**Reality**: Cursor blink sequences (~5-20 bytes/sec) accumulate indefinitely. With a flat byte threshold, typing in one pane for a few seconds would cause OTHER idle AI panes to cross the byte threshold too.
**Fix**: Switched from flat byte threshold to **data rate threshold** (200 bytes/sec average). Real AI streaming produces 1000+ bytes/sec; cursor blinks produce ~5-20 bytes/sec. Clean separation.

### 4. xterm.js doesn't render when container is `display: none`
**Faulty reasoning**: "The `isActive` prop triggers refresh on the focused pane, so all panes will update."
**Reality**: `isActive` only applies to the focused pane. Other panes in the same tab also need refresh after becoming visible.
**Fix**: Added IntersectionObserver on each TerminalPane that calls `term.refresh()` when the container becomes visible.

### 5. ResizeObserver + fitAddon.fit() on hidden containers
**Faulty reasoning**: "ResizeObserver will naturally fire when panes become visible with correct dimensions."
**Reality**: ResizeObserver fires with 0x0 dimensions when containers are still hidden, and `fitAddon.fit()` with zero dimensions corrupts xterm's scroll position.
**Fix**: Guard in ResizeObserver: `if (el.clientWidth === 0 || el.clientHeight === 0) return;`

## Architecture Decisions
- **Plain Map, not Zustand**: Activity state lives in `src/lib/terminal-activity.ts` using a plain `Map<string, ActivityState>`. Zustand would cause store updates on every PTY data chunk (hundreds per second), thrashing React renders.
- **1-second poll interval**: TabBar polls `isTerminalActive()` every 1s via `setInterval` + state tick counter. Acceptable latency for a status indicator.
- **AI terminals only**: Only `claude`, `codex`, `gemini` types are tracked. Shell terminals are never marked active.

## Key Constants
- `SUSTAINED_MS = 1500` — burst must last 1.5s+ to count
- `GAP_MS = 4000` — 4s gap resets the burst
- `MIN_BYTES_PER_SEC = 200` — minimum data rate to count as real work
- `RESIZE_LOCKOUT_MS = 2500` — lockout window after resize
- `TYPING_LOCKOUT_MS = 2000` — lockout window after user keystroke

## Prevention
- **Never use `term.onData` for user input detection** — use `attachCustomKeyEventHandler` instead
- **Always guard ResizeObserver callbacks** against zero-dimension containers
- **Use IntersectionObserver** (not just isActive prop) for tab visibility changes affecting multiple panes
- **Use data rate, not absolute byte count** when distinguishing real work from idle TUI output
- **Use lockout windows** (not burst resets) for resize events — confirmed active work should survive resize

## Verification
- `npx tsc --noEmit` passes
- Manual test: AI working in 1 pane shows (1), switching tabs doesn't cause false positives, typing doesn't trigger indicator, all panes render correctly on tab switch
