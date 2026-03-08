# Workspace Templates: Session-Count Grid + Non-Rectangular Layouts

**Date:** 2026-03-08

## Summary

Replaced the old workspace template system (named layouts like "Side by Side", "Quad", "Main + Side") with a session-count system (1, 2, 4, 6, 8, 10, 12, 14, 16). This required handling non-rectangular grids (10 and 14 panes can't fill a perfect rectangle within the 4x4 max constraint).

## Key Design Decisions

### Non-rectangular grids
With max 4 columns and 4 rows, only certain counts form perfect rectangles: 1, 2, 3, 4, 6, 8, 9, 12, 16. The user's required counts of 10 and 14 don't fit.

Solution: `distributeColumns(count, cols)` spreads panes evenly across columns, with the first N columns getting +1 row when there's a remainder:
- 10 panes / 4 cols → `[3, 3, 2, 2]`
- 14 panes / 4 cols → `[4, 4, 3, 3]`

This creates visually clean layouts where the taller columns are on the left.

### `buildBinaryTree` vs `buildBalancedSameDir` bug
The old `buildLayoutFromTemplate` used an internal `buildBinaryTree` that **alternated split directions** at each level. For 3+ columns, this meant the second-level splits were vertical instead of horizontal — creating incorrect layouts.

Example with 3 columns: `Split(H, [col1, Split(V!, [col2, col3])])` — the inner split used vertical direction instead of horizontal.

The fix: use `buildBalancedSameDir` (already existed in layout-utils for `addPaneAsGrid`) which maintains the same direction at all levels within a grouping. Columns are combined with all-horizontal splits; rows within a column use all-vertical splits.

### `paneCount` field
Added `paneCount` to `WorkspaceTemplate` to decouple the actual pane count from `cols * rows`. For rectangular templates, `paneCount === cols * rows`. For non-rectangular (10, 14), `paneCount < cols * rows`. The `buildLayoutFromTemplate` function accepts an optional `paneCount` parameter.

For backward compatibility with persisted recent projects, `RecentProjectTemplate.paneCount` is optional — old data without it falls back to `cols * rows`.

### GridPreview rewrite
The old `GridPreview` used CSS Grid (`gridTemplateColumns/Rows`) which only works for rectangular layouts. Replaced with flex columns that render per-column heights from `distributePreviewColumns()`, correctly showing uneven column heights for 10 and 14.

## Files Changed
- `src/lib/workspace-templates.ts` — 9 session-count templates, `paneCount` field
- `src/lib/layout-utils.ts` — `distributeColumns()`, rewrote `buildLayoutFromTemplate` with `paneCount` support, removed `main-side` special case
- `src/components/TemplatePicker.tsx` — flex-column `GridPreview`, removed descriptions, uses `paneCount` for slots
- `src/store/recentProjectsSlice.ts` — `paneCount?` on `RecentProjectTemplate`
- `src/components/TabBar.tsx` — passes `paneCount` to builder + recent project save

## Prevention
- When building tree layouts with >2 nodes, always use same-direction splits within a grouping level. Never alternate directions in a binary tree builder — it creates incorrect nesting.
- When extending a persisted type with a new required field, make it optional with a fallback to avoid breaking existing user data.

## Verification
1. Open "New Workspace" → 9 grid options (Single through 16 Sessions)
2. Grid previews show correct shapes (10 and 14 have uneven columns)
3. Select "10 Sessions" → 10 agent slots, launches 4 cols with [3,3,2,2] rows
4. Recent projects restore correctly with old and new template data
