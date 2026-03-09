# CLI Ghost Text Relay into EzyComposer

**Date:** 2026-03-08
**File:** `src/components/PromptComposer.tsx`

## Summary

Implemented relaying CLI autocomplete suggestions (dim/ghost text rendered in the terminal buffer) into EzyComposer's ghost text overlay, so users can see and accept CLI suggestions with TAB even when the overlay hides the native terminal input.

## Architecture

CLI tools (Codex, Gemini, Claude) render autocomplete suggestions as **dim text** on the prompt line in the xterm.js buffer. The text uses various styling methods depending on the CLI:

- **SGR dim attribute** (`isDim()`) — standard dim (CSI 2 m)
- **Palette color 8** (bright black) — common in Codex
- **xterm-256 grays** (palette 232–250) — extended grayscale
- **RGB grays** (`isFgRGB()` with low-brightness channels) — used by Gemini CLI

A shared `isCellDim()` helper detects all four styles, used by both `scanPromptPosition` (to exclude ghost text from `existing`) and `scanCliSuggestion` (to extract it).

### Data flow

1. `terminal.onRender()` fires → `scanPromptPosition()` finds the prompt line
2. `scanCliSuggestion(promptLineIdx)` iterates cells on that line, skipping non-dim chars (user text), collecting dim chars (suggestion)
3. `cliSuggestion` state is set → `effectiveGhost = ghostText || cliSuggestion` renders in the overlay
4. TAB key accepts: appends to textarea value, clears suggestion (no terminal write)
5. Enter submits the full text to the terminal via `onSubmit`

## Bugs Encountered and Their Root Causes

### Bug 1: CLI suggestion appeared as real text instantly

**Symptoms:** When EzyComposer opened, the CLI's dim suggestion was immediately placed into the textarea as editable text, not as ghost text.

**Faulty reasoning:** Assumed `translateToString()` on a buffer line would only return "real" user-typed text. It doesn't — it returns ALL characters including dim/ghost ones. The regex `m[2]` captured everything after the prompt char.

**Root cause:** `scanPromptPosition()` used `line.translateToString().trim()` to extract `existing` text. This included dim suggestion chars. The steal logic (`setValue(result.existing)`) then put the full string including the suggestion into the textarea.

**Fix:** Replaced regex-based text extraction in Pass 1 with cell-by-cell iteration. Now `existing` is built by scanning individual cells and stopping at the first dim cell (`isCellDim(cell)`). Only non-dim characters are included.

### Bug 2: Ghost text overlaid the placeholder and was misaligned

**Symptoms:** When CLI suggestion was active with empty textarea, both "Type your prompt..." placeholder and the ghost suggestion were visible simultaneously. The ghost text was also vertically offset from where the placeholder sits.

**Root cause (placeholder):** The textarea's native placeholder still renders when `value === ""`. The ghost overlay rendered on top of it, creating visual clutter.

**Root cause (alignment):** The textarea had `marginTop: useCard ? 7 : 0` for card-style composers (Codex/Gemini), but the ghost overlay div had `margin: 0` — a 7px vertical mismatch.

**Fix:**
- Placeholder: `placeholder={cliSuggestion ? "" : "Type your prompt..."}`
- Alignment: Added `marginTop: useCard ? 7 : 0` to the ghost overlay div

### Bug 3: Ghost suggestion reappeared after TAB accept (doubling)

**Symptoms:** After pressing TAB to accept the suggestion, the ghost text immediately re-appeared after the accepted text, showing "Implement {feature}Implement {feature}" visually.

**Faulty reasoning:** Assumed `setCliSuggestion("")` on TAB would stay cleared. Forgot about the `useEffect` on `value` that re-scans the terminal buffer — it found the same dim text still in the terminal and set `cliSuggestion` right back.

**Root cause:** The `useEffect` on `value` unconditionally re-scanned the terminal. After TAB set `value` to the suggestion text, the effect fired, found dim text in the buffer, and restored `cliSuggestion`. The ghost overlay then rendered the suggestion after the now-real text.

**Fix:** CLI ghost suggestion only displays when the textarea is empty. Three-layer enforcement:
1. `onRender` callback: gates scan with `if (!valueRef.current)`
2. `useEffect` on `value`: only scans when `!value`, clears `cliSuggestion` when `value` is truthy
3. `effectiveGhost`: `ghostText || (!value ? cliSuggestion : "")` as safety net

A `valueRef` keeps the current value accessible inside the `onRender` closure (which captures stale state from its dependency array).

### Bug 4: TAB accept sent text to both EzyComposer AND the CLI

**Symptoms:** Pressing TAB in EzyComposer to accept a ghost suggestion also caused the CLI to accept its native suggestion simultaneously — the text was doubled in the terminal.

**Faulty reasoning:** Thought we should `write(cliSuggestion)` to keep the terminal in sync. But this sent the suggestion text to the PTY, where the CLI interpreted it as user input AND accepted its own ghost text.

**Root cause:** `write(cliSuggestion)` in the TAB handler was sending characters to the terminal during composition. The full text would then be sent AGAIN on Enter via `onSubmit`, resulting in doubled input.

**Fix:** Removed `write(cliSuggestion)` from the TAB handler. TAB only updates the textarea `value`. The terminal receives the text once, on Enter, via `onSubmit`.

### Bug 5: Gemini CLI ghost text not detected

**Symptoms:** Ghost suggestions worked in Codex CLI but not Gemini CLI.

**Root cause:** Gemini CLI uses **RGB foreground colors** (true-color gray) for its ghost text, not SGR dim or palette color 8. The original detection only checked `isDim()` and palette color 8.

**Fix:** Created `isCellDim()` helper that covers all four common ghost text styles: SGR dim, palette 8, xterm-256 grays (232–250), and RGB grays (all channels < 180, spread < 40).

## Prevention

- **Never use `translateToString()` when cell attributes matter** — it strips all styling information. Use `line.getCell(col)` for attribute-aware scanning.
- **Different CLIs use different terminal escape sequences** — always test ghost text / dim detection across multiple CLIs (Codex, Gemini, Claude). Check SGR dim, palette colors, AND RGB.
- **Don't write to the terminal during EzyComposer composition** — the composer collects text and sends it all at once on submit. Mid-composition writes cause double input.
- **`onRender` doesn't fire on textarea edits** — the terminal has no knowledge of textarea changes. Use `useEffect` on `value` to re-scan the buffer when textarea content changes. Use a `valueRef` for the `onRender` closure.
- **Ghost text must be gated on empty textarea** — CLI suggestions are a hint for an empty prompt, not an inline completion for partial text.

## Verification

1. `npm run build` passes
2. Codex pane: dim suggestion appears as ghost text, TAB accepts, no doubling
3. Gemini pane: same behavior (RGB gray detection works)
4. After TAB accept + delete all text: ghost suggestion reappears
5. Image autocomplete (`im` + TAB) still works, takes priority over CLI suggestion
6. Typing any text hides CLI ghost suggestion; clearing textarea restores it
