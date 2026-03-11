# CodeReview Warp-style File Headers, Collapse Mode, and GitStatusBar Polish

**Date**: 2026-03-11

## Summary

This session covered 6 distinct changes to the code review and git status bar systems:

1. **GitStatusBar "View changes" button** — merged file count + bullet + diff stats into a single clickable unit (matching Warp's design)
2. **CodeReview file headers** — complete redesign to match Warp: chevron collapse toggle, filepath, copy button, centered diff stats badge, Edit (with `FaPencil` icon), discard (`FaRotateLeft` icon), open file (`FaArrowUpRightFromSquare` icon)
3. **Hunk header layout shift fix** — Revert button was conditionally rendered (`{isHovered && <button>}`) causing the `@@` header row to resize on hover. Fixed by always rendering the button with `opacity: 0` / `pointerEvents: none` when not hovered.
4. **File header layout reorder** — copy icon moved adjacent to filepath, diff stats badge centered using dual `flex-1` spacers
5. **"Collapse all files" setting** — new persisted toggle in Settings dropdown that auto-collapses all files except the selected/first one
6. **GitStatusBar trailing divider** — moved inside the component (from a separate conditional div in TabBar) for proper spacing alignment

## Key Mistakes and Lessons

### Mistake 1: Divider as separate conditional element in TabBar
**What happened**: Added a divider between GitStatusBar and ClipboardImageStrip as a separate `<div>` in TabBar.tsx with its own duplicated IIFE gate. The divider floated awkwardly because it was subject to TabBar's flex gap rather than GitStatusBar's internal spacing.

**Why it failed**: A divider that logically belongs to a component (trailing separator) should live inside that component. Placing it as a sibling in the parent flex container means it inherits the parent's gap/alignment, not the component's. Also duplicated the conditional gate logic.

**Fix**: Moved the divider inside `GitStatusBar.tsx` as the last visual element, using `--ezy-text-muted` at 0.2 opacity.

### Mistake 2: Not using frontend-design skill for UI work
**What happened**: Made the divider change without invoking the `frontend-design` skill first. User caught this and called it out.

**Why it matters**: CLAUDE.md explicitly requires the skill for ALL visual changes, even "tiny" ones. The skill forces design thinking before coding.

**Fix**: Added a CRITICAL entry to MEMORY.md as the first item so it's always loaded.

### Mistake 3: Conditional render causing layout shift
**What happened**: The hunk header's Revert button used `{isHovered && <button>}`, which removed the button from the DOM entirely when not hovered. This caused the row height to change on hover.

**Why it failed**: Conditional rendering (`&&`) removes elements from layout flow. For elements that should be invisible but preserve space, use `opacity: 0` + `pointerEvents: none` instead.

**Fix**: Always render the Revert button, toggle visibility with opacity/pointerEvents.

## Architecture Decisions

### Per-file diff stats computed from hunks
`FileDiff` doesn't store insertion/deletion counts. The `getFileStats()` helper iterates hunk lines and counts `add`/`remove` types. This is O(n) per file per render but the data is small (typically <1000 lines per file) so memoization wasn't needed.

### Collapse-all via store, not local state
The "Collapse all files" setting lives in the persisted Zustand store (`codeReviewCollapseAll`) so it survives across sessions. The `useEffect` in `CodeReviewDiffView` syncs `collapsedFiles` local state whenever the store value, fileDiffs list, or selectedFile changes:
- **collapseAll ON**: collapse all files except `selectedFile ?? fileDiffs[0]`
- **collapseAll OFF**: clear all collapsed files (expand everything)
- Manual chevron toggles still work per-file (they modify local `collapsedFiles` state)

### Dual flex-1 spacers for centering
To center the diff stats badge between the left group (filepath + copy) and right group (Edit + discard + open), two `<div className="flex-1" />` spacers are used — one before and one after the badge. This pushes the badge to the visual center regardless of how wide the filepath or action buttons are.

## Files Changed

| File | Change |
|------|--------|
| `src/components/GitStatusBar.tsx` | Merged file count + diff stats into single clickable "View changes" button; added trailing divider inside component; bumped marginRight |
| `src/components/CodeReviewDiffView.tsx` | Complete file header redesign (Warp-style); fa6 icons; collapsible files with chevron; always-rendered Revert button; copy-to-clipboard; per-file diff stats; centered badge layout; collapseAll integration |
| `src/components/CodeReviewPane.tsx` | Added `FaExpand`/`FaCompress` fullscreen toggle; fullscreen overlay modal |
| `src/components/TabBar.tsx` | Added `codeReviewCollapseAll` store selectors; "Code Review" section in Settings dropdown; removed separate divider div; GitStatusBar divider cleanup |
| `src/store/recentProjectsSlice.ts` | Added `codeReviewCollapseAll` boolean + `setCodeReviewCollapseAll` setter |
| `src/store/index.ts` | Added `codeReviewCollapseAll` to persist config |

## Revisiting This Topic

If returning to code review or git status bar work, here's the key context:

### Component architecture
- **`GitStatusBar.tsx`** — self-contained, lives in TabBar header. Props: `workingDir`. Polls every 20s + listens for `ezydev:git-refresh`. Has branch switcher dropdown and "View changes" button (dispatches `ezydev:open-codereview`).
- **`CodeReviewPane.tsx`** — wrapper with header (branch, mode dropdown, refresh, expand, close). Has fullscreen overlay mode. Fetches git status/diff/branches. Passes data to child components.
- **`CodeReviewDiffView.tsx`** — renders file list with Warp-style headers + hunk blocks. Owns collapse state, copy-to-clipboard, confirm-discard flow. Reads `codeReviewCollapseAll` from store.
- **`CodeReviewFileList.tsx`** — sidebar file list with status badges. Has collapsible mode.

### Key events
- `ezydev:open-codereview` — opens the code review pane (dispatched from GitStatusBar's "View changes" click and TabBar's Code Review button)
- `ezydev:git-refresh` — triggers immediate re-fetch in both GitStatusBar and CodeReviewPane (fired by terminal-activity.ts when AI output gap detected)

### Backend commands (lib.rs)
- `git_is_repo` — checks if directory is a git repo
- `git_branches` — current branch + local branch list
- `git_diff_stats` — runs a single bash script: `git status --porcelain=v1 | wc -l` for file count, `git diff --numstat HEAD | awk` for insertions/deletions
- `git_switch_branch` — `git switch <branch>`
- `git_status` — `git status --porcelain=v1` parsed into `GitFileStatus[]`
- `git_diff` — full unified diff for code review
- `git_revert_hunk` — applies reverse patch via `git apply --reverse`
- `git_discard_file` — `git checkout -- <file>` or `rm` for untracked

### Store settings
- `codeReviewCollapseAll` (boolean, persisted) — when on, auto-collapses all files except selected/first in CodeReviewDiffView

## Prevention

- Always use `frontend-design` skill for ANY visual change
- Use `opacity: 0` + `pointerEvents: none` instead of conditional rendering when an element should be invisible but preserve layout space
- Place dividers/separators inside the component they logically belong to, not as siblings in parent containers
- When adding persisted settings: update slice interface, default, setter, AND persist config (4 places)

## Verification

- `npx tsc --noEmit` passes clean
- GitStatusBar: file count + diff stats are one clickable unit opening code review
- CodeReview file headers: chevron collapses/expands, copy turns green on click, diff badge centered, all fa6 icons work
- Hunk header: no layout shift on hover (Revert button always reserves space)
- Settings > Code Review > "Collapse all files" toggle works, persists across sessions
- Fullscreen expand button shows FaExpand/FaCompress, overlay works with Escape/backdrop close
