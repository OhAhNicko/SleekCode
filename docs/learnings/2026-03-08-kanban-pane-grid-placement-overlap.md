# Kanban pane loses full-width span when adding new panes

**Date:** 2026-03-08

## Summary

When a horizontal kanban pane was open (spanning the full bottom row), adding a new terminal pane via `addPaneAsGrid` would place the new pane inside the kanban's row, breaking the full-width spanning layout. The kanban should always occupy its entire row (horizontal) or column (vertical), regardless of how many panes are added to the grid.

## Symptoms

- Open a workspace with several terminal panes and the kanban at the bottom
- Add a new pane (e.g., Codex CLI via the "+" button)
- The new pane appears to the RIGHT of one of the existing panes, pushing into the kanban's bottom row
- The kanban no longer spans the full width — it only covers part of the bottom

## Root cause

`addPaneAsGrid` rebuilds the entire layout tree by:
1. Calling `getTopLevelColumns()` to extract horizontal columns
2. Calling `extractColumnLeaves()` to get leaf panes per column
3. Deciding placement and rebuilding

When a horizontal kanban is present, the root layout is a **vertical split**: `[terminalGrid, kanbanPane]`. `getTopLevelColumns()` sees a vertical root and returns `[entireLayout]` as a single "column". Then `extractColumnLeaves()` flattens all vertical splits, treating the kanban as just another leaf alongside terminal panes. The grid rebuild algorithm then intermixes the kanban with terminals, destroying its spanning position.

Similarly, a vertical kanban (right side) would be treated as a separate "column" by `getTopLevelColumns()` and the algorithm would try to balance rows into it.

## Fix

**`layout-utils.ts` — `addPaneAsGrid`**: Added a kanban-aware preamble:
1. `findKanbanNode()` checks if a kanban exists anywhere in the layout tree
2. If found, `removePane()` strips it before any grid logic runs
3. The new pane is added to the kanban-free grid via recursive `addPaneAsGrid()`
4. The kanban is re-attached in its original position (bottom for horizontal, right for vertical)
5. A lower pane cap (`MAX_PANES_WITH_KANBAN = 12`, i.e., 4x3) is enforced when kanban is active

**`TemplatePicker.tsx`**: Grayed out 4-row grid presets (14 and 16 Sessions) when the "Kanban task board" checkbox is ticked:
- `opacity: 0.35`, `cursor: not-allowed`, disabled hover effects, tooltip
- Auto-deselects any 4-row template if kanban is toggled on while one is selected

## Prevention

- When `addPaneAsGrid` (or any layout-rebuilding function) operates on the full layout tree, it must account for **non-grid panes** (kanban, browser, code review, file viewer) that occupy fixed structural positions. The pattern is: strip special panes, operate on the grid, re-attach.
- Any future "always spans full width/height" pane type should follow the same strip-and-reattach pattern.
- Template picker constraints should mirror runtime constraints — if the runtime caps at 12 panes with kanban, the picker should prevent selecting layouts that exceed 12.

## Verification

1. Open a workspace with kanban at the bottom (horizontal)
2. Add new terminal panes — they should fill the terminal grid area only; kanban stays full-width at the bottom
3. Open "New Workspace" dialog, tick "Kanban task board" — "14 Sessions" and "16 Sessions" should be grayed out
4. Select "12 Sessions" first, then tick kanban — should remain selected. Select "16 Sessions" first, then tick kanban — should auto-deselect.
5. `npm run typecheck` passes
