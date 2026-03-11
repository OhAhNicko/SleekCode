# CodeReview Fullscreen Expand + GitStatusBar Divider Placement

**Date**: 2026-03-11

## Summary

Added a fullscreen expand/collapse button to the CodeReviewPane (using `FaExpand`/`FaCompress` from `react-icons/fa6`) and a trailing divider to the GitStatusBar separating it from the toolbar icons. The divider was initially placed as a separate conditional element in TabBar.tsx which caused poor visual alignment.

## Symptoms

1. CodeReviewPane sidebar was too narrow to display full diff content — user requested a fullscreen expand option.
2. After adding a divider between GitStatusBar and ClipboardImageStrip, it appeared "super badly placed" — visually disconnected from the git stats and awkwardly floating.

## Root Cause

### Divider placement issue
The divider was rendered as a **separate conditionally-gated element** in TabBar.tsx between `GitStatusBar` and `ClipboardImageStrip`. This meant:
- It had its own IIFE gate function (duplicating the GitStatusBar gate logic)
- It was a sibling in the TabBar's flex row, subject to the TabBar's gap/spacing rather than the GitStatusBar's internal spacing
- The GitStatusBar had `marginRight: 2` which left almost no room before the divider
- The divider's `marginLeft: 4, marginRight: 4` created asymmetric spacing relative to the git content

### Violated the frontend-design skill rule
The initial divider implementation was done without invoking the `frontend-design` skill, which is required for ALL visual/UI changes per CLAUDE.md. This led to a poorly considered placement that needed rework.

## Fix

### Divider
- **Moved the divider inside `GitStatusBar.tsx`** as the last visual element (before the dropdown). This keeps it within the component's own flex context, inheriting its `gap: 8` and alignment.
- Used `--ezy-text-muted` at `opacity: 0.2` (subtler than `--ezy-border`) with `marginLeft: 2`
- Bumped the component's `marginRight` from 2 to 6 for balanced breathing room
- Removed the separate conditional div and duplicated gate logic from TabBar.tsx

### Fullscreen expand
- Added `fullscreen` state to CodeReviewPane
- Added `FaExpand`/`FaCompress` icons from `react-icons/fa6` (size 12) between refresh and close buttons
- When fullscreen: renders a fixed overlay (z-index 200, 95vw x 95vh) with dark backdrop
- Close button behavior changes in fullscreen: exits fullscreen first instead of closing the pane
- Escape key and backdrop click both exit fullscreen
- An inline placeholder div prevents the sidebar slot from collapsing when content moves to overlay

### TypeScript issue
- SVG elements don't accept `title` prop in this project's TS config — removed it from the expand button SVG (caught by `tsc --noEmit`)

## Prevention

1. **Always invoke `frontend-design` skill for ANY visual change** — added as the #1 entry in persistent MEMORY.md
2. **Dividers/separators belong inside the component they logically follow** — placing them as separate siblings in parent flex containers creates spacing issues because they're subject to the parent's gap/alignment rather than the component's own layout rhythm
3. **Don't duplicate conditional gate logic** — if element B should only render when element A renders, either put B inside A or extract the condition into a variable

## Verification

- `npx tsc --noEmit` passes clean
- Expand button shows `FaExpand` icon, clicking opens fullscreen overlay
- `FaCompress` shows when in fullscreen mode
- Escape and backdrop click both close fullscreen
- Close (X) button exits fullscreen first, then closes pane on second click
- Divider sits flush at the right edge of git stats, with balanced spacing to the snipping tool icon
