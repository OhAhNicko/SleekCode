# Console-to-Composer Bridge

## Summary
Implemented a feature that lets EzyComposer (the prompt overlay on terminal panes) insert selected browser DevTools console entries as a compact placeholder `[Console, N rows]` that expands to formatted text on submit. The feature required bridging state between two unrelated components (BrowserPreview and PromptComposer) via a standalone Zustand store, interactive row selection in the console panel, and a protected non-editable inline tag in the textarea.

## Key Architecture Decisions

### Cross-component state bridge via standalone Zustand store
BrowserPreview's `consoleEntries` live in local `useState` — inaccessible to PromptComposer. Solution: `browserConsoleStore.ts` (same pattern as `clipboardImageStore.ts`) — a lightweight standalone store with:
- `entries` — mirrored from BrowserPreview's local state via `useEffect`
- `active` — whether BrowserPreview is mounted (controls button visibility in composer)
- `selectMode` / `selectedIds` — interactive selection state
- `requestOpenConsole` — one-shot flag for composer to tell BrowserPreview to open the console tab

**Why not put this in the main store?** It's ephemeral, session-only, no persistence needed. Standalone stores are the established pattern for cross-component signaling in this codebase.

### Dynamic tag updates via useEffect on selectedIds
Each row click in the console immediately updates the `[Console, N rows]` tag in the textarea. This is done via a `useEffect` watching `consoleSelectedIds`:
- First selection: inserts tag at cursor position
- Subsequent selections: replaces old tag text with updated count via `setValue(prev => prev.replace(oldTag, newTag))`
- Deselection to zero: removes tag entirely

**Gotcha**: `setSelectMode(false)` must NOT clear `selectedIds` — the useEffect would trigger and remove the tag from the textarea. Only `setSelectMode(true)` resets the set (entering fresh selection). Exiting select mode preserves the selection so the tag stays.

### Protected non-editable tag in textarea
The tag cannot be a separate DOM element (textarea only holds text). Solution:
1. **onChange guard** — rejects any edit that would remove the tag text, its adjacent space, or break the space adjacency
2. **Visual overlay** — when tag is present, textarea `color: transparent`, and a positioned overlay div renders the full text with the tag portion at 35% opacity and user text at full color
3. **Auto-space insertion** — when user types directly before the tag (no space between), onChange auto-inserts a space to keep them visually separated

### Submit expansion
On submit, the tag + its visual space is replaced with formatted text wrapped in `\n\n`:
```
\n\n--- Browser Console (N entries) ---\n[method] text\n[method] text\n---\n\n
```
The outer `text.trim()` cleans boundaries. The visual space is consumed so it doesn't leak into the sent text.

## Bugs & Failed Attempts

### Terminal scroll jump on browser preview toggle
**Symptom**: Opening/closing browser preview caused the Claude terminal to scroll to the top.

**First attempt (failed)**: Added scroll preservation only for the `!wasAtBottom` case in the ResizeObserver's debounced `fit()` callback. Didn't fix it because:
- The user was typically AT the bottom (following Claude output)
- After `fit()`, xterm recalculates `baseY` and the terminal was no longer at bottom
- My code only restored scroll for the "scrolled up" case, not the "was at bottom" case

**Second attempt (failed)**: Added `scrollToBottom()` for the `wasAtBottom` case. Still didn't fix it because:
- The ResizeObserver was debounced at 100ms
- During that 100ms gap, xterm internally responded to the container size change and shifted its viewport
- By the time our `fit()` + scroll restoration ran, the damage was already done

**Final fix**: Made `fit()` immediate (no debounce) when the size jump is large (>50px in either dimension) — this catches pane additions/removals. Small incremental changes (window drag) still use 100ms debounce for performance. The immediate fit captures scroll position BEFORE xterm can drift.

### Overlay text not appearing grayed out
**Symptom**: Console tag overlay was invisible — tag looked the same as regular text.

**Root cause**: First attempt used an overlay span with `opacity: 0.4` and `backgroundColor` to cover the textarea text beneath. But textarea text rendering and overlay span rendering don't align pixel-perfectly due to different text rendering paths (textarea vs div). The "opaque background" trick doesn't work when there's even 1px misalignment.

**Fix**: Made textarea `color: transparent` when a tag is present, and rendered ALL text through the overlay — user text in full `terminalFg`, tag text at 35% opacity. Caret stays visible via `caretColor`. This is the same proven pattern used for the ghost text overlay.

## Prevention
- **Cross-component state bridges**: always use standalone Zustand stores (not main store) for ephemeral signaling between unrelated components
- **Protected inline text in textarea**: use onChange guards + transparent text + overlay rendering — never try to use opaque background overlays to cover textarea text
- **Terminal scroll on layout changes**: always preserve scroll position around `fitAddon.fit()`, and use immediate (not debounced) fit for large size jumps

## Verification
1. `npm run typecheck` — passes
2. `npm run build` — passes
3. Manual test plan:
   - Open browser preview with a page that has console output
   - Click console button in EzyComposer → console panel opens, selection circles appear
   - Click rows → `[Console, N rows]` updates dynamically in textarea
   - Type before/after the tag → space auto-inserted, tag protected from deletion
   - Submit → formatted console text sent with `\n\n` separation
   - Click console button again → tag removed, user text preserved
   - Button hidden when no browser preview is open
   - Open/close browser preview → terminal stays at its scroll position
