# 2026-03-11: EzyComposer interactive focus, Gemini placeholder, and PTY dims race

## Summary

Three fixes in one session:
1. When EzyComposer hides for interactive CLI dialogues (Gemini permission prompts, plan acceptance), keyboard focus wasn't transferred to the terminal — user had to click manually.
2. Gemini's internal placeholder text ("Type your message or @path/to/file") was picked up as a CLI ghost suggestion instead of showing our own placeholder.
3. Intermittent race condition on session restore: PTY spawned at tiny column widths (~8 cols) because `setTermReady(true)` fired before CSS grid had distributed panel sizes.

## Symptoms

### Interactive focus
- Gemini shows a dialogue (e.g., "Allow CLI to open document?")
- EzyComposer correctly hides
- But arrow keys / Enter don't work — user must click the terminal pane first

### Gemini placeholder
- Gemini's dim "Type your message or @path/to/file" text appears as ghost suggestion in EzyComposer
- Our rotating placeholder suggestions never show

### PTY dims race
- On app restart with session resume, some panes render Claude Code TUI at ~8 character columns
- Text wraps every few characters, welcome screen is garbled
- Only happens sometimes, specifically during session restore with many panes

## Root cause

### Interactive focus
In `PromptComposer.tsx`, when `isInteractiveMode()` returns true, the code called `textareaRef.current?.blur()` but never focused the terminal. Keyboard input had no target element.

### Gemini placeholder
`scanCliSuggestion()` collects dim/gray cells on the prompt line as autocomplete suggestions. Gemini renders its internal placeholder ("Type your message or @path/to/file") as dim text, which matched the dim-cell detection. No CLI-specific filtering existed.

### PTY dims race
In `TerminalPane.tsx` init effect:
1. `fitAddon.fit()` runs synchronously — measures container size
2. `initialDims.current = { cols: term.cols, rows: term.rows }` captures the result
3. `setTermReady(true)` triggers PTY spawn via `usePty` hook

During session restore, all 16 panes mount simultaneously. The CSS grid (react-resizable-panels) hasn't distributed final panel sizes yet when step 1 runs. The container might be at a minimal/transitional size, yielding tiny cols. The double-rAF and 300ms safety-net fits happen later and correct xterm's internal dims, but the PTY was already spawned at the wrong size. TUI apps (Claude Code) draw their welcome screen at the initial tiny width and may not fully redraw after `SIGWINCH`.

## Fix

### Interactive focus (PromptComposer.tsx:401-411)
Added `terminal.focus()` after `textareaRef.current?.blur()` in the interactive-mode hide path. xterm now receives keyboard input immediately.

### Gemini placeholder (PromptComposer.tsx:338-339)
Added check in `scanCliSuggestion()`: if `terminalType === "gemini"` and the collected dim text starts with "Type your message", return empty string. Our placeholder suggestions show instead.

### PTY dims race (TerminalPane.tsx:276-302)
Moved `initialDims.current` assignment and `setTermReady(true)` into a `signalReady()` function that's called from the double-rAF callback (after one full layout+paint cycle) or the 300ms safety-net timer — whichever fires first. A `readySignalled` flag prevents double-firing. This adds ~32ms delay to PTY spawn but ensures the CSS grid has settled.

## Prevention

- **Focus transfers**: whenever hiding an overlay that captures keyboard input, always transfer focus to the underlying interactive element (terminal, input field, etc.).
- **CLI-specific filtering**: each CLI has unique dim-text patterns. When `scanCliSuggestion()` picks up unexpected text, add per-CLI exclusions rather than changing the general detection logic.
- **Deferred ready signals**: never gate PTY spawn on dimensions measured before layout stabilizes. Use double-rAF or similar to wait for CSS layout to settle, especially when many components mount simultaneously.

## Verification

- `npm run build` passes
- `npm run typecheck` passes
- Interactive: open Gemini, trigger a permission dialogue → keyboard works immediately without clicking
- Placeholder: Gemini at idle prompt → shows rotating EzyDev suggestions, not "Type your message..."
- Dims: restart app with 16-pane session restore → all panes render at correct width
