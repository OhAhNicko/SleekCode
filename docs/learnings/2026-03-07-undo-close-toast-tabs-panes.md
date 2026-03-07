# Undo Close Toast for Tabs and Panes

**Date:** 2026-03-07

## Summary

Added an undo toast that appears when closing tabs or panes, allowing the user to restore them within 5 seconds (via button click or Ctrl+Z). Follows the same pattern as the existing `ImageInsertUndoToast`.

## Architecture

### Standalone zustand store (`undoCloseStore.ts`)
- Holds the last closed item: either a `{ type: "tab", tab, index }` or `{ type: "pane", tabId, layoutBefore }`
- Helper functions `snapshotTab()` and `snapshotPane()` are called before destructive operations
- `undoClose()` restores the item: re-inserts tab at original index, or restores the full tab layout

### Snapshot points
- **Tab close**: `tabSlice.ts` `removeTab()` calls `snapshotTab()` before filtering the tab out
- **Terminal pane close**: `Workspace.tsx` `handleTerminalClose()` calls `snapshotPane()` before `removePane()`
- **Non-terminal pane close** (editor, browser, code review, file viewer): `PaneGrid.tsx` `handleClose()` calls `snapshotPane()` before `removePane()`

### Why session resume works automatically
The pane layout snapshot preserves `sessionResumeId` on terminal leaves. When undo restores the layout, the terminal component remounts with the same `sessionResumeId`, so `usePty` passes `--resume <id>` to Claude CLI. No extra logic needed — the snapshot captures everything.

### Limitations
- Only the most recent close is undoable (new close replaces previous)
- PTY processes are killed on unmount — undo spawns fresh processes (terminal scroll-back is lost, but Claude sessions resume via `--resume`)
- 5-second window before the undo option expires

## Key Design Decision: Layout snapshot vs. pane snapshot
Considered snapshotting just the removed pane, but restoring a pane into the correct split position in the layout tree is complex. Snapshotting the entire tab layout before removal is simpler and guarantees correct restoration — the layout tree is small so the memory cost is negligible.

## Files Changed
- `src/store/undoCloseStore.ts` (new)
- `src/components/UndoCloseToast.tsx` (new)
- `src/store/tabSlice.ts` — added `snapshotTab()` call in `removeTab`
- `src/components/Workspace.tsx` — added `snapshotPane()` call in `handleTerminalClose`
- `src/components/PaneGrid.tsx` — added `tabId` prop, `snapshotPane()` call in `handleClose`
- `src/App.tsx` — renders `<UndoCloseToast />`

## Verification
- `npx tsc --noEmit` passes
- `npm run build` passes
