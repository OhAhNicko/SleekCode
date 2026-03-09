# Recent Project Quick-Open Toggle

**Date:** 2026-03-08

## Summary

Added a per-project "quick open" toggle button to the Recent Projects dropdown. When toggled ON, clicking the project row instantly opens it with the last-used grid + CLI layout, skipping the template picker. When OFF, clicking opens the template picker as usual.

## Failed Attempts

### Attempt 1: Grid-cycling toggle button
**What was built:** A button on each row that cycled through workspace templates (1 → 2 → 4 → 6 → etc.) on click, updating the saved `lastTemplate` inline.

**Why it was wrong:** The user wanted a "remember and reuse" feature — not a way to change the grid from the dropdown. The cycling button was a configuration widget when the user wanted a quick-action shortcut. Misread "toggle" as "cycle through options" instead of "on/off switch."

### Attempt 2: Dedicated quick-open action button
**What was built:** A button labeled with a grid icon + pane count that, when clicked, performed the quick-open action (bypassing the picker). The row click was changed to always open the template picker.

**Why it was wrong:** This was a clickable action button, not a toggle. The user explicitly said "toggle button" — meaning a persistent on/off setting that changes the row click behavior, not a separate action trigger. The distinction: a toggle changes *how clicking the row works*, while an action button is a second click target alongside the row.

## Final Solution

- Added `quickOpen?: boolean` field to `RecentProject` interface (persisted to localStorage)
- Added `toggleProjectQuickOpen(path)` Zustand action
- Toggle button (lightning icon + pane count) appears on rows that have a saved `lastTemplate`
- Visual states: OFF = muted border/text, ON = accent-colored border + glow background
- Row click behavior is gated on `canQuickOpen = !!project.lastTemplate && !!project.quickOpen`

## Prevention

- When a user says "toggle button," it means a persistent on/off switch that changes behavior — not a cycling selector or action button.
- Ask clarifying questions early when the interaction model is ambiguous (toggle vs action vs cycle).

## Verification

- `npm run build` passes (no TS errors in changed files)
- Toggle persists across sessions via Zustand localStorage
- Row click with toggle ON: instant open with saved grid
- Row click with toggle OFF: opens template picker
- Toggle only appears when `lastTemplate` is saved (project was opened at least once before)
