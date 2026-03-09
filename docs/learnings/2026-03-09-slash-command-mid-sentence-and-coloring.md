# Slash Command: Mid-Sentence Support, Coloring, and Ctrl+Backspace

## Summary

Three enhancements to the slash command picker in EzyComposer:

1. **Mid-sentence slash commands** — `/command` now works anywhere in text, not just at the start. Typing `Fix this /cl` triggers the popup for `/clear`.
2. **Teal coloring for completed commands** — completed slash commands in the textarea render in `#5eead4` (teal) via a transparent-textarea + styled-overlay approach.
3. **Ctrl+Backspace deletes full `/command`** — browsers treat `/` as a word boundary, so Ctrl+Backspace on `/clear` normally leaves the `/` behind. Custom handler deletes the entire token.

## Symptoms (Before Fix)

1. Typing `/` only triggered the popup if the entire textarea value started with `/`. Users couldn't invoke commands mid-sentence.
2. All text in the textarea was the same color — no visual distinction between commands and regular text.
3. Ctrl+Backspace on `/clear` deleted only `clear`, leaving a stray `/` that the user had to manually delete.

## Root Cause and Approach

### Mid-sentence detection
The old `computeSlashMatches(val)` did:
```ts
const trimmed = val.trimStart();
if (!trimmed.startsWith("/") || trimmed.includes(" ")) return [];
```
This rejected any value with spaces (i.e., mid-sentence text) and only checked the start.

**Fix**: Added `findSlashToken(val, cursorPos)` that searches backwards from cursor position for a `/` preceded by start-of-string or whitespace. The function returns the query text and character range (`start`, `end`), stored in `slashTokenRef` for use by `selectSlashCommand` (which splices the replacement into position) and the Enter handler.

Key detail: `computeSlashMatches` now takes a `cursorPos` parameter. In `onChange`, this comes from `e.target.selectionStart`. This means the popup only triggers for the slash token the cursor is actually inside.

### Command coloring
Uses the same transparent-textarea + overlay pattern already proven for console tags:
1. Compute `styledSegments` — an array of `{ text, isCmd }` segments by scanning the value for known command names after `/` at word boundaries.
2. When any command is found, set textarea `color: transparent`.
3. Render a positioned overlay `<div>` with `<span>` per segment — commands in `#5eead4`, normal text in `terminalFg`.
4. Skipped when console tag overlay is active (they'd conflict; console tag overlay takes priority).

The segmenter iterates character-by-character, checking each `/` for valid command-start position (preceded by start-of-string or whitespace) and then matching against `knownCommandNames` (a Set of all built-in + user skill names).

### Ctrl+Backspace
Browsers split words at `/`, treating it as punctuation. Custom `handleKeyDown` handler intercepts `Ctrl+Backspace`:
1. Start at cursor, skip trailing whitespace backwards.
2. Skip word characters backwards (stop at whitespace or `/`).
3. If landed on `/` preceded by start-of-string or whitespace → also delete it.
4. `preventDefault()`, splice the value, set cursor position.

This makes `/clear` behave as a single "word" for Ctrl+Backspace purposes.

## Popup color iteration
The user initially asked for "a completely different color for a matched/full command." First attempt used teal (`#5eead4`) in the popup for command names. User feedback: "I like the completion color, but I don't like the new colors in the overlay (popup)." Reverted popup to original colors (typed prefix = `terminalCursor`, unmatched suffix = `terminalFg` at 0.5 opacity). Teal kept only for completed commands in the textarea.

## Files Changed

| File | Change |
|---|---|
| `src/components/PromptComposer.tsx` | `findSlashToken`, cursor-aware `computeSlashMatches`, `selectSlashCommand` splice, `styledSegments` overlay, Ctrl+Backspace handler |

## Prevention

- **Cursor-position-aware matching is essential for mid-text autocomplete** — never match against the entire textarea value when the feature should work at any position.
- **`slashTokenRef` tracks the active token range** — all consumers (selectSlashCommand, Enter handler, ghost suffix) use this ref instead of parsing the value independently.
- **Ctrl+Backspace word deletion must be intercepted for custom token boundaries** — browsers define word boundaries by punctuation, which doesn't match our `/command` semantics.
- **Ask before changing popup colors** — the user had specific preferences about where teal was acceptable (textarea yes, popup no).

## Verification

```bash
npm run typecheck  # passes clean
npm run build      # passes clean
```

Manual:
1. Type `Fix this /cl` → popup shows `clear`, `claude-docs`, etc.
2. Tab → value becomes `Fix this /clear ` with `/clear` in teal
3. Ctrl+Backspace → removes entire `/clear `, leaving `Fix this `
4. Type `/rename ` → teal command + `[name]` arg hint ghost
5. Popup command names use original colors (terminalCursor + dimmed fg), not teal
