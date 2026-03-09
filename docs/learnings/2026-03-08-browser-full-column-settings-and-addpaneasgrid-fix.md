# Browser Full-Column Settings & addPaneAsGrid Special Pane Fix

**Date:** 2026-03-08

## Summary

Added two settings toggles (Full column / Spawn on left) that control how browser preview, code review, and file viewer panes are placed in the layout. In fixing the feature, also discovered and resolved a pre-existing bug in `addPaneAsGrid` where browser/codereview/fileviewer panes in full-column mode were treated as regular terminal columns, causing new terminals to be incorrectly placed inside them.

## Symptoms

- After enabling "Full column" mode, clicking the `+` button to add a new CLI terminal would sometimes place it *below the browser pane* instead of in the terminal grid.
- The browser pane appeared to shrink vertically as a new terminal split was created within its column.

## Root Cause

`addBrowserPaneRight` (and its new sibling `addBrowserPaneLeft`) wraps the **entire** existing layout in a horizontal split:
```
split(horizontal)
  ├── terminalGrid   (65%)
  └── browserPane   (35%)
```

When `addPaneAsGrid` was later called to add a new terminal, `getTopLevelColumns` flattened the root horizontal split into **two** columns: `[terminalGrid, browserPane]`. `extractColumnLeaves` on `browserPane` returned it as a single-row column. If the terminal grid had 2 rows and the browser column had 1 row, the algorithm chose to fill the shorter column — placing the new terminal **inside** the browser column as a vertical split.

This was already documented in MEMORY.md for kanban panes, but browser/codereview/fileviewer panes were not handled with the same strip-and-reattach pattern.

## Fix

**`src/lib/layout-utils.ts`** — Added `findRootSpecialColumnPane` helper that detects browser/codereview/fileviewer panes as direct children of the root horizontal split. Added a check in `addPaneAsGrid` (after the existing kanban check) that:
1. Strips the special column pane
2. Recurses into `addPaneAsGrid` on the inner terminal grid only
3. Re-attaches the special pane on its original side (left or right) at the same size percentage

```ts
function findRootSpecialColumnPane(layout: PaneLayout): {
  pane: PaneLayout; side: "left" | "right"; sizePercent: number;
} | null {
  if (layout.type !== "split" || layout.direction !== "horizontal") return null;
  const sizes = layout.sizes ?? [50, 50];
  const isSpecial = (p: PaneLayout) =>
    p.type === "browser" || p.type === "codereview" || p.type === "fileviewer";
  if (isSpecial(layout.children[0])) return { pane: layout.children[0], side: "left", sizePercent: sizes[0] };
  if (isSpecial(layout.children[1])) return { pane: layout.children[1], side: "right", sizePercent: sizes[1] };
  return null;
}
```

The recursive structure composes correctly with kanban: kanban is stripped first (outer call), then browser is stripped (inner recursive call), the grid operation runs on bare terminals, browser is reattached, then kanban is reattached.

**`src/lib/layout-utils.ts`** — Also added `addBrowserPaneLeft` (mirror of `addBrowserPaneRight`, children reversed).

**`src/store/recentProjectsSlice.ts`** — Added `browserFullColumn: boolean` (default `true`) and `browserSpawnLeft: boolean` (default `false`) with setters.

**`src/store/index.ts`** — Both settings added to the persist whitelist.

**`src/components/TabBar.tsx`**:
- Imports `addBrowserPaneLeft` and `addPaneAsGrid`
- Added 4 store selectors
- Browser preview toggle: respects full-column and left/right settings
- Template picker extra panes loop: respects both settings for browser, codereview, and fileviewer
- Settings dropdown: new "Preview Panes" section with "Full column" and "Spawn on left" toggles

## Prevention

**The pattern for any "wrapping" pane type (one that wraps the entire layout as a full-height column) is:**
1. `addBrowserPaneRight/Left` creates the wrapper — this is fine
2. Any path that calls `addPaneAsGrid` on a layout that may contain a wrapper pane **must** strip-and-reattach that wrapper, or new terminals will end up inside the wrapper's column

Check `addPaneAsGrid` whenever adding a new pane type that uses full-column wrapping.

## Verification

- `npm run typecheck` — clean
- `npm run build` — clean (rollup native module needed `npm install` refresh first — existing known issue)
- Manual: open preview browser → add new terminal → terminal appears in terminal grid, not below the browser
