# addPaneAsGrid creates middle column when single pane + full-column browser

## Summary

When the browser preview pane is set to "Full column" mode and only one terminal pane exists, adding a new pane via `addPaneAsGrid` created an awkward three-column layout (`[CLI | newPane | browser]`) instead of stacking the new pane below the existing terminal (`[CLI / newPane | browser]`).

## Symptoms

- User has 1 CLI pane + browser preview in full-column mode (2 visual columns).
- Clicking "Add pane" places the new terminal as a middle column between the CLI and the browser.
- Expected: new pane appears below the CLI in the same left column.

## Root cause

`addPaneAsGrid` has a two-step approach for full-column special panes:

1. **Strip** the browser/codereview/fileviewer from the layout.
2. **Recurse** into `addPaneAsGrid(stripped, newLeaf)` on the remaining terminal grid.
3. **Re-attach** the special pane on its original side.

The bug is in step 2. When `stripped` is a single terminal leaf, the recursive call hits this branch in the algorithm:

```
shortIdx = -1       (no column is shorter than any other)
columns.length (1) > maxRows (1)  →  false
→ else: add a new column
```

So `addPaneAsGrid` turns the single terminal into a two-column horizontal split `[CLI | newPane]`. After re-attaching the browser on the right, the result is the three-column `[CLI | newPane | browser]`.

The algorithm is correct in isolation — for a pure terminal grid, going from 1 to 2 panes creates two side-by-side columns. But when a full-height browser already occupies a column on the side, creating a second terminal column produces a visually wrong sandwich.

## Fix

In the `rootSpecial` branch of `addPaneAsGrid` (`layout-utils.ts`), before recursing, check if the terminal grid is a single-column, single-row layout. If so, force a vertical split instead of delegating to the normal algorithm:

```typescript
const strippedCols = getTopLevelColumns(stripped);
if (strippedCols.length === 1 && extractColumnLeaves(strippedCols[0]).length === 1) {
  // Single pane: stack below instead of creating a new column
  if (countLeafPanes(stripped) >= MAX_PANES) return layout;
  newGrid = {
    type: "split",
    id: generatePaneId(),
    direction: "vertical",
    children: [stripped, newLeaf] as [PaneLayout, PaneLayout],
    sizes: [50, 50],
  };
} else {
  newGrid = addPaneAsGrid(stripped, newLeaf);
  if (newGrid === stripped) return layout;
}
```

The condition `strippedCols.length === 1 && extractColumnLeaves(strippedCols[0]).length === 1` means "exactly one terminal, one column" — it is false for any multi-pane terminal grid, so subsequent adds (2 stacked → 3rd pane creates new column) continue using normal algorithm behavior.

## Progression remains correct

- 1 CLI + browser → add → `[CLI / newPane | browser]` (2 rows, 1 col terminals) ✓
- 2 CLI stacked + browser → add → `[[CLI1; CLI2] | CLI3 | browser]` (2+1 grid, 2 terminal columns) ✓
- 2+1 CLI + browser → add → `[[CLI1; CLI2] | [CLI3; CLI4] | browser]` ✓

## Prevention

When the `rootSpecial` branch strips a full-column pane and recurses on the inner grid, the inner grid's column count does **not** represent the full visual column count the user sees. A single terminal column that looks like "column 1 of 2" should not grow to "column 1 and 2 of 3". Any future strip-and-recurse logic for special full-column panes should similarly gate column expansion behind a "single-pane" check.

## Verification

`npm run typecheck` — passes with no errors.
