# PTY Spawn at Tiny Cols During Session Restore

**Date:** 2026-03-11

## Summary

When restoring a session with multiple panes, some panes spawn their PTY at ~5 columns wide, causing TUI apps (Claude CLI) to render their entire welcome screen in a 5-character column — text wraps at 5 chars even though the pane is visually full-width.

## Symptoms

- Claude Code pane shows "Welc / ome / back / !" with text wrapping at ~5 characters
- The ASCII art logo is compressed into a tiny column on the left
- Model info ("Opus 4.6", "with", "high effort") wraps per-word
- The pane itself is full-width — only the content is mushed
- Happens intermittently during session restore (multiple panes mounting at once)
- Does NOT happen when opening a single new pane manually

## Root cause

During session restore, multiple TerminalPane components mount simultaneously. The CSS grid needs time to distribute space across all panes. The `signalReady()` mechanism used a double-rAF + 300ms safety timer to defer PTY spawn until layout settled. However:

1. Multiple panes mount → CSS grid starts distributing space
2. Double-rAF fires (~32ms later) — grid is STILL distributing
3. Container element exists with a transitional narrow width (e.g. 50px, not zero)
4. `fitAddon.fit()` runs, checks `el.clientWidth > 0` → passes (50 > 0)
5. Measures 50px / ~10px per char = **5 columns**
6. `signalReady()` records `initialDims = { cols: 5, rows: 24 }`
7. `setTermReady(true)` → `usePty` spawns PTY at 5 cols
8. Claude CLI draws its TUI at 5 columns

The 300ms safety timer fires next, but `readySignalled` is already `true`, so it's a no-op.

Later, the ResizeObserver fires when the container reaches its final size and resizes the PTY to the correct dimensions. But Claude CLI's initial welcome screen was already drawn at 5 cols — the damage is done. While Claude handles SIGWINCH and redraws, the initial content remains wrapped in the scrollback.

### Why double-rAF wasn't enough

A double-rAF waits for one full layout+paint cycle (~32ms at 60fps). But CSS grid distribution across many simultaneous mounts can take longer — especially during session restore where 4-8+ panes mount at once, each triggering layout recalculation. The grid may need multiple frames to converge on final sizes.

### Why the 300ms safety timer didn't help

It WOULD have helped, but `signalReady()` had already been called by the double-rAF (which fired first), setting `readySignalled = true`. The timer's call to `signalReady()` was a no-op.

## Fix

Added a **minimum column threshold** to `signalReady()`:

```typescript
const MIN_READY_COLS = 20;
const MAX_READY_RETRIES = 10; // 10 × 100ms = 1s max

function signalReady() {
  if (readySignalled || disposed) return;

  if (term.cols < MIN_READY_COLS && readyRetries < MAX_READY_RETRIES) {
    readyRetries++;
    retryTimer = setTimeout(() => {
      if (disposed) return;
      try {
        if (el.clientWidth > 0 && el.clientHeight > 0) {
          fitAddon.fit();
        }
      } catch {}
      signalReady(); // recursive retry
    }, 100);
    return;
  }

  readySignalled = true;
  initialDims.current = { cols: term.cols, rows: term.rows };
  setTermReady(true);
}
```

If `term.cols < 20` after a fit, it retries every 100ms (re-fitting each time) up to 10 times (1s max). This gives CSS grid enough time to distribute final sizes. After 1s of retries, it signals ready regardless (the ResizeObserver will correct dimensions later if the container grows).

## Prevention

- When gating PTY spawn on layout readiness, **always validate the measured dimensions** — checking `clientWidth > 0` is not enough; a 50px container is non-zero but yields unusable 5-col terminal
- Double-rAF is a heuristic, not a guarantee — CSS grid distribution across many simultaneous mounts can exceed 2 frames
- Consider the **number of concurrent mounts** as a factor — session restore with 8 panes is fundamentally different from opening 1 new pane

## Verification

1. Open the app with a saved session containing 4+ panes
2. All panes should render at correct width — no 5-column wrapping
3. Manually create a narrow split pane (<200px) — should still eventually spawn (after retry exhaustion)
4. `npm run typecheck` passes
