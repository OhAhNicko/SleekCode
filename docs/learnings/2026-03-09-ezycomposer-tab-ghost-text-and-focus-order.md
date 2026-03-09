# EzyComposer: Tab ghost-text acceptance broken for Claude + Tab focus order

## Summary
Three related fixes to Tab key behaviour in the EzyComposer textarea:
1. Tab failed to accept ghost/placeholder text in Claude terminals (but worked in Codex/Gemini).
2. Tab skipped all interactive buttons inside the composer and jumped to UI outside.
3. Accepting a placeholder suggestion inserted literal "..." into the textarea instead of a space.

## Symptoms
- Pressing Tab in an empty Claude EzyComposer textarea moved focus to a random element elsewhere in the app instead of filling in the ghost suggestion text.
- Tab worked correctly in Codex/Gemini composers.
- Console, Promptify, and Send buttons were unreachable by keyboard.
- After Tab-accepting a placeholder like "Fix the bug in...", the cursor landed after the ellipsis with no space, forcing the user to manually delete "..." before typing.

## Root cause

### Tab falling through for Claude
The `handleKeyDown` Tab branch processes ghost text in priority order:
1. Image cycling (`[Img N]`)
2. CLI autocomplete: `if (cliSuggestion) { e.preventDefault(); ... }`
3. *(was missing)* Placeholder acceptance
4. Fall-through: `return` — **no `e.preventDefault()`**

For Codex and Gemini, `scanCliSuggestion()` finds dim/gray autocomplete cells in the terminal buffer (those CLIs render suggestions as SGR-dim or palette-gray text inline). So `cliSuggestion` is non-empty and Tab is caught by check #2.

For Claude CLI, there is no dim inline suggestion text — Claude is a TUI app that doesn't emit shell-style tab-completion ghost text. `cliSuggestion` stays `""` (falsy), so Tab fell through to the bare `return` without `e.preventDefault()`. The browser then moved focus to the next focusable element in the DOM outside the composer.

The rotating placeholder suggestions ("Fix the bug in...", etc.) were shown via the native HTML `placeholder` attribute — the Tab handler had no case for them at all.

### Buttons not in Tab order
The Console, Promptify, and Send interactive elements are `<div onClick>` elements (not `<button>`), intentionally, per the project rule that `<button>` inflates line-height in compact layouts. Plain `<div>` elements are not focusable by default and are skipped by the browser's Tab order entirely.

### Trailing "..." in accepted placeholder
The placeholder strings are defined with literal trailing ellipsis (e.g. `"Fix the bug in..."`). The Tab handler inserted them verbatim with `setValue(placeholder)`, leaving the cursor after `...` with no space.

## Fix

**1. Placeholder Tab acceptance** (`handleKeyDown` in `PromptComposer.tsx`):
```ts
// Placeholder ghost — accept the rotating placeholder suggestion (strip trailing "...", add space)
if (!value && placeholder) {
  e.preventDefault();
  setValue(placeholder.replace(/\.\.\.$/, "") + " ");
  return;
}
```
Added after the `cliSuggestion` check. Guards on `!value` so it only fires when the textarea is empty (matching when the placeholder is actually visible). Strips trailing `...` and appends a space so the user can type immediately.

**2. `tabIndex={0}` on button divs**:
Added `tabIndex={0}` to the Console insert button, Promptifier button, and Send button divs. Browser naturally cycles them in DOM order: textarea → console (if visible) → promptify → send.

## Prevention
- When a Tab handler falls through with a bare `return` (no `e.preventDefault()`), the browser WILL move focus out of the component. For any composer where the textarea should remain "sticky", every no-op Tab exit must be deliberate.
- Distinguish between CLI ghost text (`cliSuggestion` from buffer scan) and UI placeholder text — they are different state. Claude CLI doesn't emit dim buffer text so the CLI check alone is insufficient for Claude.
- `<div onClick>` elements are invisible to keyboard Tab navigation. Add `tabIndex={0}` any time a div acts as a button and should be reachable by keyboard.

## Verification
- `npm run typecheck` — passes clean.
- Manual: open Claude composer, observe rotating placeholder, press Tab → text fills with trailing space, cursor ready.
- Manual: Tab again from filled textarea → moves to Promptify button, Tab again → Send button.
- Manual: Codex/Gemini Tab acceptance of CLI suggestions still works (checked by code review — cliSuggestion check is before placeholder check, priority unchanged).
