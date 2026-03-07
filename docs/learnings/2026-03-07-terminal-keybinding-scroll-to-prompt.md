# Terminal Keybindings: Scroll-to-Prompt & Windows Terminal Parity

**Date:** 2026-03-07

## Summary

Added Windows Terminal-style keybindings to xterm.js terminals: PgUp/PgDn to jump between shell prompts, End to scroll to bottom, Ctrl+Backspace/Delete for word deletion, and a Warp-inspired "jump to bottom" floating button.

## Features Implemented

1. **PgUp** — jump to previous prompt (walks backwards through OSC 133 command blocks)
2. **PgDn** — jump to next prompt (walks forward); scrolls to bottom if no more prompts ahead
3. **End** — scroll to bottom (always on, not behind toggle)
4. **Double-tap Up Arrow** (within 350ms) — same as PgUp
5. **Ctrl+Backspace** — backward-kill-word (`\x1b\x7f`, same as Alt+Backspace)
6. **Ctrl+Delete** — kill-word forward (`\x1b[3;3~`, same as Alt+Delete)
7. **Jump-to-bottom button** — floating button below scrollbar thumb, visible when scrolled up
8. **Settings toggle** — "Scroll to prompt" in Behavior section (controls PgUp/PgDn/double-tap only)

## Bug: `scrollToNextPrompt` Always Jumped to Bottom

### Symptoms

PgUp worked correctly (jumped to previous prompt), but PgDn always scrolled to the bottom instead of the next prompt forward.

### Root Cause

The initial implementation used `promptLine > viewportTop` to find the next prompt. After PgUp scrolls to a prompt, `viewportY` equals that prompt's line exactly. The condition `> viewportTop` correctly skipped the current prompt but found nothing ahead because:

1. **Off-by-one ambiguity**: `viewportY` after `scrollToLine(promptLine)` could be exactly equal to `promptLine`, meaning the next prompt at `promptLine + N` should have been found. But the real issue was...
2. **No forward prompts in `completed` blocks**: The active/current prompt (where the cursor sits at the bottom) is NOT in the `completed` blocks array because it hasn't finished executing yet (no OSC 133;D received). So if the user PgUp'd to the second-to-last prompt and pressed PgDn, the only prompt ahead was the untracked active prompt — the loop found nothing and fell through to `scrollToBottom()`.

### Fix

Changed the threshold to `viewportTop + 2` (skip the prompt we're viewing) and removed the early `return` from the command blocks branch so it falls through to the buffer-scan fallback. The buffer scan can find the active prompt line (which contains `$ `) even though it's not in the command blocks.

### Prevention

- When implementing bidirectional navigation over a list, always consider whether the "current position" (bottom/active) is represented in the data structure. If not, the forward direction needs a fallback.
- Use `+2` or similar tolerance instead of `+1` for viewport-based comparisons — `scrollToLine` may not set `viewportY` to the exact requested line.

## Bug: Ctrl+Backspace & Ctrl+Delete Not Working Initially

### Symptoms

Neither Ctrl+Backspace nor Ctrl+Delete had any visible effect when first tested.

### Root Cause

Unclear — after adding debug `console.log` statements, both handlers fired correctly and the PTY write calls worked. The most likely explanation is that the Tauri WebView needed a restart to pick up the new key handler registrations (HMR may not fully re-register `attachCustomKeyEventHandler` since the terminal instance persists across hot reloads).

### Prevention

- When testing new keybindings in xterm.js, always do a full page reload (not just HMR) since `attachCustomKeyEventHandler` is registered once during terminal init.
- Debug logs are valuable for confirming handlers fire — add them early when keybindings seem broken.

## Key Implementation Details

### Escape sequences for word deletion
- **Ctrl+Backspace** sends `\x1b\x7f` (ESC + DEL) — readline interprets as `backward-kill-word`
- **Ctrl+Delete** sends `\x1b[3;3~` (CSI 3;3~) — same as Alt+Delete in xterm, kills word forward

### Jump-to-bottom button positioning
- Uses `term.onScroll` + `term.onRender` to update position via direct DOM manipulation (no React re-renders)
- Thumb bottom calculated as `(viewportY + rows) / (baseY + rows) * containerHeight`
- Button placed 6px below thumb bottom, clamped to not overflow container

### Shell integration vs fallback
- Shell terminals with OSC 133 markers use precise `promptLine` from `CommandBlockParser`
- Non-shell terminals fall back to buffer scanning for `[$#❯]\s` patterns

## Verification

- `npx tsc --noEmit` — clean
- `npm run build` — passes
- Manual: PgUp/PgDn navigate between prompts, End scrolls to bottom, Ctrl+Backspace/Delete delete words, jump button appears when scrolled up
