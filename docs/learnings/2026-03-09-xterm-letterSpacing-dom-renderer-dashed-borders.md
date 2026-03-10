# xterm.js letterSpacing causes dashed TUI borders in ALL renderers

**Date**: 2026-03-09

## Summary

Box-drawing characters (`│`, `─`, `┌`, `┐`, etc.) in TUI apps (Claude CLI, htop, etc.) appeared with visible 1px gaps, making borders look dashed instead of solid. Two fix attempts were needed — the first was wrong because it assumed WebGL handled letterSpacing correctly.

## Symptoms

- TUI borders rendered as dashed lines instead of solid
- Affected all terminal types (Claude, Codex, Gemini, shell)
- Previously fixed for 16-pane grid (by ensuring WebGL loads for all panes), but reappeared in single-pane and 3-pane scenarios
- Inconsistent: sometimes borders were fine, sometimes broken

## Root cause

`letterSpacing: 1` was set in the `Terminal()` constructor options. xterm.js adds extra pixels between character cells when `letterSpacing > 0`. Box-drawing characters are sized to their individual cell boundaries, so the extra inter-cell gap creates a visible break — regardless of which renderer is active.

## Debugging story — two failed hypotheses

### Attempt 1: "Only the DOM renderer is affected"

**Hypothesis**: The DOM renderer applies `letterSpacing` as CSS `letter-spacing` (inter-character gap), but the WebGL renderer handles it at the glyph-atlas level (expands cell width, draws glyphs to fill). So: set `letterSpacing: 0` at construction, then `term.options.letterSpacing = 1` after WebGL loads.

**Why it failed**: The WebGL renderer ALSO gaps box-drawing characters with `letterSpacing > 0`. The glyph atlas expands cell width, but box-drawing glyphs don't stretch to fill the extra pixel — they're drawn to standard cell boundaries. The 1px gap appears between adjacent cells regardless of renderer.

**Evidence**: User reported dashed borders on startup with only 3 panes (well within WebGL context limit). WebGL loaded successfully for all 3 panes, yet borders were still dashed.

### Attempt 2 (prior session): "Only many-pane mode is affected"

The 16-pane fix from a previous session ensured WebGL loaded for all panes (staggered delays, never skipping). This worked incidentally because the test case happened to have WebGL loading before the TUI drew borders — but the underlying `letterSpacing: 1` was still the real problem.

## Fix

Set `letterSpacing: 0` permanently in the Terminal constructor. Never set it to any value > 0.

```typescript
const term = new Terminal({
  // ...
  letterSpacing: 0, // Must stay 0 — any value >0 gaps box-drawing chars in ALL renderers
});
```

The PromptComposer textarea overlay can still use `letterSpacing: 1` in CSS — it renders normal text only (no box-drawing characters), so gaps don't matter there.

## Prevention

- **xterm.js `letterSpacing` must always be 0** — there is no renderer that correctly handles `letterSpacing > 0` for box-drawing characters.
- **Don't assume renderer-specific behavior without testing** — the WebGL renderer was assumed to handle letterSpacing correctly because it uses a glyph atlas, but box-drawing chars are still drawn to standard cell boundaries.
- **When a fix works for one scenario (16 panes), verify it works for all scenarios** — the 16-pane fix masked the root cause by making WebGL load reliably, but didn't address that WebGL + letterSpacing was also broken.

## Verification

1. Open a single terminal pane with Claude CLI → borders should be solid
2. Open 3-pane layout → all borders solid
3. Open 16-pane grid → all borders solid
4. No dashed borders at any point during terminal lifecycle
