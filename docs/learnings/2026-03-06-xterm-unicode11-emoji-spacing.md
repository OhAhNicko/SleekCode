# xterm.js Unicode 11 addon for emoji spacing

**Date:** 2026-03-06

## Summary

Emojis in the terminal (e.g. Claude Code's status bar) rendered without spacing after them in EzyDev's xterm.js terminal pane, while other terminals (Warp, WezTerm) rendered them correctly with proper spacing.

## Symptoms

- Emoji characters in the terminal status bar appeared jammed against the following text (e.g. `📁~/projects/ttm5` instead of `📁 ~/projects/ttm5`)
- The same content rendered correctly in Warp and other terminals
- Only affected EzyDev's xterm.js-based terminal pane

## Root cause

xterm.js defaults to Unicode 6 character width tables. Unicode 6 doesn't know that most emoji codepoints are double-width (2 cells), so it allocates only 1 cell for each emoji. This "eats" the space character that follows the emoji, making it look like there's no gap.

The `@xterm/addon-unicode11` addon provides Unicode 11 width tables that correctly mark emoji ranges as double-width.

## Debugging story — three failed attempts

### Attempt 1: Load addon before `term.open()`
Loaded the Unicode11Addon before calling `term.open()`. This caused the `term.unicode` API to be unavailable (it's only initialized after open), which threw an error and **broke all terminal rendering** — the app showed empty panes.

**Why it failed:** The `term.unicode` property (used to set `activeVersion = "11"`) is only populated after the terminal is attached to the DOM via `open()`.

### Attempt 2: Move addon after `open()` but without `allowProposedApi`
Moved the addon loading after `term.open()`, which fixed the crash from attempt 1. But the addon threw: `"You must set the allowProposedApi option to true to use proposed API"`. Since this was wrapped in try-catch (added to prevent the crash from attempt 1), it silently failed and emojis still had no spacing.

**Why it failed:** The Unicode addon uses xterm.js "proposed API" (`term.unicode.register()`), which is gated behind the `allowProposedApi` Terminal constructor option. Without it, the addon's `activate()` method throws immediately.

### Attempt 3 (fix): Add `allowProposedApi: true` + load after `open()`
Added `allowProposedApi: true` to the Terminal constructor options AND loaded the addon after `term.open()`. This worked.

## Fix

1. Install `@xterm/addon-unicode11` (`npm install @xterm/addon-unicode11`)
2. Add `allowProposedApi: true` to the `Terminal` constructor options
3. Load the addon **after** `term.open()`:
   ```ts
   term.open(containerRef.current);
   try {
     const unicode11 = new Unicode11Addon();
     term.loadAddon(unicode11);
     term.unicode.activeVersion = "11";
   } catch {
     // Fall back to default unicode handling
   }
   ```

## Prevention

- When using xterm.js addons that touch `term.unicode`, `term.parser`, or other "proposed" APIs, always set `allowProposedApi: true` on the Terminal constructor.
- Always load addons that depend on terminal state (like unicode) **after** `term.open()`, not before.
- When adding new xterm.js addons, check the addon's source for `allowProposedApi` requirements.

## Verification

- `npm run build` passes
- Emoji characters in terminal output (e.g. Claude Code status bar) now have correct spacing
- Terminals load and function normally (no blank panes)
