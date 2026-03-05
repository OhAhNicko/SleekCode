# 2026-03-06 — FileViewer Infinite Loop & Code Review Pane

## Summary

Implemented two new pane types for EzyDev: a **Code Review Pane** (git diff viewer with hunk-level revert) and a **Tabbed File Viewer** (Warp-inspired tabbed code browser using CodeMirror). The File Viewer caused a critical infinite render loop that blanked the entire app. Also restored a missing Browser Preview button in TerminalHeader.

## Symptoms

- Clicking a file in the sidebar to open the File Viewer caused the entire app to go blank/white
- No error in the console — React silently unmounted everything due to an infinite re-render loop exhausting the stack
- The app became completely unresponsive

## Root Cause

The `FileViewerPane` component accepted an `onFilesChange` callback prop from `PaneGrid`. This callback was passed as an inline arrow function:

```tsx
// In PaneGrid
<FileViewerPane
  onFilesChange={(files, active) => {
    // update layout...
    onLayoutChange(newLayout);
  }}
/>
```

Inside `FileViewerPane`, a `useEffect` had `onFilesChange` in its dependency array:

```tsx
useEffect(() => {
  if (onFilesChange) onFilesChange(files, activeFile);
}, [files, activeFile, onFilesChange]);
```

**The chain of failure:**

1. `PaneGrid` renders → creates a **new** `onFilesChange` function reference (inline arrow)
2. `FileViewerPane` mounts → `useEffect` fires because `onFilesChange` is a new reference
3. `onFilesChange` calls `onLayoutChange` → updates the layout in the Zustand store
4. `PaneGrid` re-renders (layout changed) → creates another **new** `onFilesChange` reference
5. `useEffect` fires again → goto step 3
6. Infinite loop → React gives up → blank screen

**Why wrapping in `useCallback` wouldn't help:** The callback closed over `layout` (which changes on every layout update), so even `useCallback` would produce a new reference whenever layout changed — the loop would persist.

**Why `useRef` for the callback wouldn't fully help:** Even if we stored the callback in a ref to avoid the dependency, the fundamental design was flawed — the child was syncing its internal state back to the parent on every change, and the parent was re-rendering the child with a new callback, creating a circular data flow.

## Fix

Removed the `onFilesChange` callback entirely. The `FileViewerPane` manages its own tab state (open files, active file) internally using local `useState`. It listens for `ezydev:fileviewer-add` custom events to receive new files from the outside — a unidirectional pattern that can't create loops.

The key insight: **tab state within a viewer pane doesn't need to be reflected in the layout tree**. The layout only needs to know "there's a file viewer here" — not which files are open in it.

## Prevention

1. **Never put parent-provided callbacks in useEffect dependency arrays** unless they're guaranteed stable (wrapped in `useCallback` with stable deps, or coming from Zustand/context)
2. **Inline arrow function props create new references every render** — if a child uses them in useEffect deps, it will re-run the effect every render
3. **Circular data flow (child notifies parent → parent re-renders child → child notifies parent) is always a bug** — break the cycle by either:
   - Making the state owned by only one side (parent OR child, not both)
   - Using events/refs for communication that doesn't trigger re-renders
4. **When a component goes blank with no console error**, suspect infinite re-render loops — React silently unmounts when the render stack overflows

## Other Issues

### TabBar Button Vertical Alignment
- Two new icon buttons (Code Review, File Viewer) appeared top-aligned in the TabBar header
- Root cause: the buttons were bare `<div>` flex children without `alignSelf` specified, defaulting to `stretch` which, combined with the flex container's alignment, pushed them to the top
- Fix: Added `alignSelf: "center"` to both button styles

### Missing Browser Preview Button
- The Browser Preview button was missing from `TerminalHeader.tsx`
- It had `onOpenBrowser` in the props interface but no corresponding UI element rendering it
- Fix: Added the button with a browser window SVG icon between the Open Editor and Split Right buttons

## Verification

- `npx tsc --noEmit` passes clean (0 errors)
- Code Review pane opens via Ctrl+Shift+G or TabBar button, shows git diffs with file list + colored unified diff
- File Viewer opens via TabBar button (native file dialog, multi-select), supports tabbed file browsing
- No infinite loop — clicking files, switching tabs, closing tabs all work without blanking
- Browser Preview button visible in terminal pane headers
