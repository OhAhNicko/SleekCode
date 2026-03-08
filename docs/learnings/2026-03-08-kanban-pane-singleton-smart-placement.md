# Kanban Pane: Singleton Enforcement + Smart Placement + Layout Toggle Reposition

**Date:** 2026-03-08

## Summary

Implemented three interconnected features for the kanban (task board) pane:
1. **Singleton per tab** — only one kanban pane can exist in a project tab at a time
2. **Smart placement** — kanban is placed below (horizontal columns) or to the right (vertical columns) based on the current layout's row count
3. **Layout toggle repositions the pane** — toggling vertical/horizontal in the kanban header doesn't just rearrange columns; it removes and re-adds the entire pane in the correct position

## Design Decisions

### Placement rules
- **<=2 rows** of panes: kanban goes at the **bottom** (vertical split, 65/35), with **horizontal** column layout (3 columns side-by-side)
- **>2 rows** of panes: kanban goes on the **right** (horizontal split, 70/30), with **vertical** column layout (1 column, multiple rows — suits tall narrow panes)

### Toggle = reposition
The user explicitly requested that the layout toggle button (horizontal/vertical icon) in the kanban header should **move the whole pane** — not just rearrange columns internally. This required:
- A `repositionKanbanPane(layout, vertical)` function that removes and re-adds the pane
- An `onReposition` callback passed from PaneGrid → KanbanBoard
- The toggle button calling `onReposition` in pane mode, falling back to local state toggle in standalone (system tab) mode

### Singleton toggle
The TabBar Tasks button now **toggles**: clicking it when a kanban exists removes it, clicking when none exists adds one with smart placement. This mirrors the browser preview button's toggle behavior.

## Key Implementation Details

### PaneKanban type extended
Added `vertical?: boolean` to `PaneKanban` interface. This persists the layout orientation in the layout tree, so on remount (after reposition) the KanbanBoard initializes with the correct column direction.

### Helper functions in layout-utils.ts
- `hasKanbanPane(layout)` — recursive check for existence
- `findKanbanPaneId(layout)` — returns the pane ID for removal
- `addKanbanPane(layout)` — smart add (returns null if already exists)
- `repositionKanbanPane(layout, vertical)` — remove + re-add with forced placement

### Row counting
Uses existing `getTopLevelColumns()` → `extractColumnLeaves()` to count max rows across all columns. These are private to layout-utils.ts, so the kanban functions live there too.

## Files Changed
- `src/types/index.ts` — `PaneKanban.vertical`
- `src/lib/layout-utils.ts` — 4 new exported functions
- `src/components/KanbanBoard.tsx` — `initialVertical` + `onReposition` props
- `src/components/PaneGrid.tsx` — `handleKanbanReposition` + passes props to KanbanBoard
- `src/components/TabBar.tsx` — toggle behavior + smart placement in Tasks button + TemplatePicker

## Prevention
- When adding new pane types that should be singletons (like kanban, code review, browser preview), always implement: find → toggle off if exists → smart add if not
- When a UI toggle changes both the pane's internal layout AND its position in the layout tree, implement as remove + re-add (not just property update) since the surrounding split direction changes

## Verification
1. Open project with 1-2 terminal rows → Tasks button → kanban at bottom, horizontal columns
2. Open project with 3+ rows → Tasks button → kanban on right, vertical columns
3. Click Tasks again → kanban removed
4. Click Tasks twice rapidly → still only one kanban
5. Toggle layout button in kanban header → pane moves position (bottom ↔ right)
