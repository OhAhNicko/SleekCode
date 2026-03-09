# Interactive Mode Hiding, Focus Retention, and Arrow Key Debounce

**Date:** 2026-03-08
**File:** `src/components/PromptComposer.tsx`

## Summary

Implemented three EzyComposer behaviors for CLI interactive dialogs: (1) auto-hide during askuserquestion/plan acceptance dialogs, (2) persistent textarea focus when clicking the terminal area, and (3) arrow key history debounce after re-show. Also organized interactive hint detection per-CLI for future extensibility.

## Feature 1: Interactive Mode Detection and Auto-Hiding

### How it works

When a CLI (Claude Code) presents an interactive UI — askuserquestion, plan acceptance, tool permissions — the `>` prompt changes from an input prompt to a selection marker. The `isInteractiveMode()` function scans lines below the prompt for hint text ("enter to select", "arrow keys", "esc to cancel"). When detected, EzyComposer sets `display: none`.

When the dialogue ends, the CLI re-renders a normal input prompt. The `onRender` callback sees `promptPass === 1` and no interactive hints → sets `hidden = false`, scrolls to bottom, and re-focuses the textarea.

### Hint strings are per-CLI

Interactive hints are stored in a `Record<string, string[]>` keyed by `terminalType`. Claude's strings are verified; Codex and Gemini are stubbed with the same strings and `TODO` comments. When testing those CLIs, swap in the real phrases.

### Bugs Encountered

#### Bug A: `>` selection markers matched Pass 1 prompt detection

**Symptoms:** EzyComposer didn't hide because `scanPromptPosition()` Pass 1 matched `> 3. Option text` as a valid input prompt.

**Root cause:** The `>` character at column 0 in Claude's selection UI (e.g., `> 3. Create new file`) looks identical to the input prompt `> ` to the regex `^([>❯›»])\s?(.*)`.

**Fix:** Added three filters to Pass 1:
1. **Indentation check** (`promptCol > 1` → skip) — selection markers can be indented
2. **Numbered option check** (`/^\d+[.)]/.test(after)` → skip) — `> 3. Option` is a selection, not input
3. **Distance-from-bottom check** (`lastContentLine - i > 6` → skip) — old prompts far from the viewport bottom aren't the current input

#### Bug B: `offset: -9999` didn't actually hide the composer

**Symptoms:** EzyComposer moved to the top of the pane but was still visible because the parent container didn't clip overflow.

**Root cause:** Setting `topOffset = -9999` positioned the div offscreen within its container, but if the container had `overflow: visible` (or the parent's bounding rect allowed it), the composer was still rendered.

**Fix:** Used `display: none` via a `hidden` state instead of offsetting. This truly removes the element from rendering. Added `hiddenRef` for synchronous access in event handlers (React `setState` is async).

#### Bug C: Composer didn't re-show after dialogue ended

**Symptoms:** After answering Claude's askuserquestion, the composer stayed hidden.

**Root cause:** `isInteractiveMode()` scanned the entire viewport (from `promptLineIdx` down). Old hint text from the previous dialogue (scrolled above the new prompt) was still in the viewport, causing `isInteractiveMode()` to return `true` even though the dialogue was over.

**Fix:** Changed `isInteractiveMode()` to only scan lines BELOW the matched prompt line (`for i = promptLineIdx; i <= vpEnd`). Old hints above the current prompt don't trigger hiding.

#### Bug D: Content-below check (counting non-empty lines) was too aggressive

**Symptoms:** Normal prompts with a status bar line below them triggered the "old prompt" heuristic and were skipped.

**Root cause:** Original check counted non-empty lines below the `>` — if ≥2, it was considered "not the input prompt." But status bars, spinners, and other CLI chrome create non-empty lines below the real prompt.

**Fix:** Replaced the count with a distance measurement: `lastContentLine - i > 6`. The current input prompt is always near the bottom of the viewport; old prompts from interactive UIs are far from the bottom.

## Feature 2: Focus Retention

### Failed attempt: `onBlur` → `setTimeout(focus, 0)`

**Symptoms:** Caret blinked rapidly/erratically.

**Root cause:** `onBlur` fires, `setTimeout` re-focuses, which causes the browser to process the focus, then any residual blur event from the click fires again → rapid blur/focus loop. Even with `setTimeout(..., 0)`, the cycle repeats on every frame.

**Fix:** Replaced with `mousedown` `preventDefault()` on the terminal container. `preventDefault()` on `mousedown` stops the browser from moving focus in the first place — no blur ever occurs, no loop.

The `mousedown` listener excludes clicks on the composer itself (buttons, thumbnails) by checking against a `data-composer` attribute on the outer div. Only clicks on the terminal area (xterm canvas, background) are intercepted.

## Feature 3: Arrow Key Debounce

**Problem:** When the composer re-shows after a dialogue, the arrow keys used to navigate the dialogue could immediately trigger EzyComposer's prompt history navigation.

**Fix:** `showTimeRef.current = Date.now()` is set when transitioning hidden → visible. ArrowUp/ArrowDown handlers check `Date.now() - showTimeRef.current < 300` and skip if within the grace period. Also skip if `hiddenRef.current` is true.

## Feature 4: SHIFT+TAB Forwarding

**Problem:** SHIFT+TAB in Claude CLI toggles between modes (e.g., plan mode). With EzyComposer focused, the browser's default SHIFT+TAB moves focus to the previous focusable element, losing the caret.

**Fix:** Added SHIFT+TAB handler in `handleKeyDown`: `e.preventDefault(); write("\x1b[Z")`. This forwards the ANSI escape for SHIFT+TAB to the terminal and keeps focus in the textarea.

## Prevention

- **`display: none` is the only reliable way to hide an overlay** — offset-based hiding (-9999) can still render if containers don't clip overflow.
- **Never use `onBlur` → `setTimeout(focus)` for focus retention** — it creates blur/focus loops with rapid caret blinking. Use `mousedown` `preventDefault()` on the parent container instead.
- **Interactive mode detection must only scan BELOW the current prompt** — old hint text scrolled above the new prompt will cause false positives.
- **Distance-from-bottom is more robust than line-counting** for distinguishing the current input prompt from old prompts in scrollback.
- **Arrow key handlers need debounce after composer re-show** — otherwise dialogue navigation bleeds into history navigation.
- **Per-CLI hint strings** enable independent testing and tuning without breaking other CLIs.

## Verification

1. `npm run build` passes
2. Claude pane: askuserquestion dialogue → composer hides, dialogue works, composer re-shows after answer
3. Claude pane: plan acceptance → composer hides, returns after plan applied
4. SHIFT+TAB in Claude pane → mode toggles, focus stays in composer
5. Terminal scroll position is at bottom when composer re-shows
6. Clicking terminal area keeps focus in composer textarea
7. Arrow keys don't trigger history immediately after composer re-shows
8. Codex/Gemini panes: composer still works normally (hint strings stubbed)
