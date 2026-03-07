# Scroll-to-prompt: always-on + EzyComposer key forwarding

**Date:** 2026-03-07

## Summary

Removed the "Scroll to prompt" toggle from the settings menu (making the feature always enabled) and fixed PageUp/PageDown prompt navigation not working when the EzyComposer textarea had focus.

## Symptoms

1. The scroll-to-prompt feature (PageUp/PageDown/double-tap-Up to jump between shell prompts) was gated behind a toggle in the settings menu. User wanted it always on.
2. When the EzyComposer (PromptComposer) was active and its textarea had focus, pressing PageUp/PageDown did nothing useful — the keys went to the textarea (which is a single-line input, so they had no effect) instead of scrolling the terminal to prompts.

## Root cause

1. **Toggle:** The key handler in `TerminalPane.tsx` checked `useAppStore.getState().scrollToPromptEnabled` before processing PageUp/PageDown/ArrowUp. The toggle, state, setter, and persist entry were spread across 4 files.
2. **Composer focus:** The PromptComposer's `handleKeyDown` had no handling for PageUp/PageDown. Since the textarea captured all keyboard events when focused, these keys never reached the terminal's `attachCustomKeyEventHandler`. The user had to click above the composer (on the terminal) to shift focus back before prompt navigation would work.

## Fix

### Toggle removal (4 files):
- `TerminalPane.tsx`: Changed condition from `if (useAppStore.getState().scrollToPromptEnabled && !e.ctrlKey ...)` to `if (!e.ctrlKey ...)`
- `TabBar.tsx`: Removed the toggle switch UI element and the two store selectors (`scrollToPromptEnabled`, `setScrollToPromptEnabled`)
- `recentProjectsSlice.ts`: Removed state field, type, default value, and setter from the Zustand slice
- `store/index.ts`: Removed `scrollToPromptEnabled` from the persist whitelist

### Composer key forwarding (2 files):
- `TerminalPane.tsx`: Added `scrollToPromptRef` and `scrollToNextPromptRef` refs, assigned the closure functions to them after creation inside the useEffect, and passed them as props (via arrow-function wrappers to always call the latest ref) to `PromptComposer`
- `PromptComposer.tsx`: Added `scrollToPrompt` and `scrollToNextPrompt` to the props interface, and added PageUp/PageDown interception at the top of `handleKeyDown` (before any other key handling)

### Why refs were needed:
The `scrollToPrompt()` and `scrollToNextPrompt()` functions are defined inside a `useEffect` closure in `TerminalPane` — they capture `term`, `blockParserRef`, and `lastUpArrowTime` from that closure. They can't be lifted out as standalone functions. Storing them in refs and passing `() => ref.current()` as props ensures the PromptComposer always calls the latest version.

## Prevention

- When adding keyboard shortcuts to the terminal, always consider whether the EzyComposer might have focus and intercept the keys. If the shortcut should work regardless of focus, add forwarding in `PromptComposer.handleKeyDown`.
- Feature toggles for always-desired behavior add unnecessary complexity. Default to always-on unless there's a real conflict scenario.

## Verification

- `npx tsc --noEmit` passes clean
- No remaining references to `scrollToPromptEnabled` or `setScrollToPromptEnabled` in the codebase
- PageUp/PageDown should navigate between prompts whether the terminal or composer has focus
