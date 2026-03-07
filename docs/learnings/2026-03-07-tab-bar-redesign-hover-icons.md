# Tab Bar Redesign: Hover Icons + Pin Stripes

**Date:** 2026-03-07

## Summary

Reworked the tab design in `TabBar.tsx`:
1. Removed the default `>_` terminal prompt icon from regular project tabs (kept special icons for kanban/servers/dev server/remote tabs).
2. Replaced the separate close button, pin indicator, and pin toggle with a single right-aligned vertical column containing a small X (close) on top and pin icon below.
3. Both icons are hover-only (using Tailwind `group-hover` on the tab button).
4. Pinned tabs are indicated by diagonal stripe background pattern instead of an always-visible pin icon.

## Key Decisions

- **No icon for regular tabs** — special system tabs (kanban, servers, dev server, remote) retain their unique icons via `renderTabIcon()`, but regular project tabs just show the label. This cleans up visual noise.
- **Vertical icon column** — X and pin stacked vertically in a flex column at the far right of the tab. Uses `marginRight: -6` to push icons closer to the right edge (eating into the tab's 12px right padding).
- **Diagonal stripes for pinned state** — `repeating-linear-gradient(135deg, transparent 0-4px, rgba(255,255,255,0.05) 4-8px)` overlaid via `backgroundImage`. Subtle enough to not clash with active/inactive background colors.
- **All icons hover-only** — both X and pin use `opacity-0 group-hover:opacity-40 hover:!opacity-100`. No special treatment for active tabs.

## Iterative Refinements

1. **First pass** — stripes were too thin (3px transparent + 1px stripe). Doubled to 4px/4px.
2. **Second pass** — icons too close together and too far from right edge. Increased gap from 1px to 4px, marginLeft from 4 to 8.
3. **Third pass** — still not enough spacing/alignment. Added `marginRight: -6` and bumped gap to 6px.

## Prevention

- For hover-reveal icon patterns, start with larger gaps (6px+) — tiny icons at 10x10px need breathing room.
- When positioning elements near container edges, negative margins into padding is a clean approach.

## Verification

- `npx tsc --noEmit` passes
- `npm run build` passes
- Removed unused `isUnclosable` variable (caught by TypeScript)
