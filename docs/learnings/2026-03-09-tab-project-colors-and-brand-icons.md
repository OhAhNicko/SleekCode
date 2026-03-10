# Tab Project Colors and Brand Icons

**Date:** 2026-03-09

## Summary

Added official brand logomark SVGs for Claude/OpenAI/Gemini to terminal pane headers, the add-pane dropdown, and the CLI type picker. Implemented per-project color-coded tab underlines with right-click color picker. Redesigned the CLI pane count badge and made the close button hover-only.

## Symptoms / Bugs Encountered

### Bug 1: All tabs got the same auto-assigned color
Every new project tab launched with orange. Opening 3 different projects resulted in 3 orange underlines.

### Bug 2: Same-frame render race condition
When multiple tabs rendered in the same React render pass, each called `autoAssignColor(projectColors)` with the same stale Zustand snapshot. All saw the same "existing" colors and picked the same random unused color.

### Bug 3: Persisted duplicate colors survived the fix
After fixing the race condition, old projects that were already persisted with duplicate `"orange"` assignments in `projectColors` were never reassigned — the code only auto-assigned when `localColors[dir] === undefined`, but they were defined (just duplicated).

## Root Cause

**Bug 1:** The original `autoAssignColor` cycled by `usedColors.length % PRESET_COUNT`, which returned the same index for the same count. Since the store started empty, the first 3 projects all hit index 0 (orange).

**Bug 2:** Zustand state updates from `setProjectColor()` calls inside a `.map()` loop don't commit until the next render. Each iteration reads the same `projectColors` object.

**Bug 3:** The fix for Bug 2 (local accumulating map) only helped NEW assignments (`undefined` check). Projects already persisted with duplicate colors were not detected or corrected.

## Fix

1. **Randomized selection** — `autoAssignColor` picks randomly from unused colors (not cycling by index). Fallback: random from least-used colors when all 11 are taken.

2. **Pre-scan with local map** — Before the `.map()` render loop, an IIFE iterates all visible tabs, builds a `localColors` map that accumulates assignments, then commits them all to the store. Each new project sees the previous project's assignment.

3. **Dedup pass** — After assignment, a second pass detects visible projects sharing the same color. It keeps the first and reassigns duplicates via `autoAssignColor(localColors)`, which sees the already-claimed colors.

## Prevention

- **Never call state-mutating store actions inside a `.map()` render loop** expecting each iteration to see the previous iteration's mutation. Zustand (like React setState) batches updates. Accumulate mutations in a local variable and commit after the loop.
- **When adding persisted auto-assigned data, always include a migration/dedup path** for existing persisted state that predates the assignment logic.
- **Randomize color/ID assignment** instead of cycling by count — cycling creates deterministic collisions when multiple items are created simultaneously.

## Verification

1. `npx tsc --noEmit` — passes clean
2. Open 3+ different project tabs — each gets a distinct underline color
3. Right-click a tab → color picker appears with 11 swatches + "None"
4. Change color → underline updates immediately
5. Close and reopen app → colors persist correctly
6. Same project in 2 tabs → same color on both tabs
