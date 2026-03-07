# xterm.js Ghost Text Positioning in TUI Apps (Claude CLI)

## Summary

Implementing inline "ghost text" autocomplete hints in xterm.js terminals hosting TUI apps (Claude CLI, Codex, etc.) required solving multiple positioning challenges. The final solution uses ANSI escape sequences with a full-buffer text search, after four failed approaches.

## Symptoms

- Ghost text (gray autocomplete hint like `g 1]` after typing "im") appeared at wrong positions or not at all
- Cursor-based positioning placed text at bottom-left instead of next to the input
- Buffer search found no matches despite text being visibly rendered on screen

## Root Causes (multiple, layered)

### 1. TUI apps hide the real terminal cursor
Claude CLI (and similar Ink/React-based TUI apps) hide the real terminal cursor and draw their own. `term.buffer.active.cursorY` and `cursorX` point to an arbitrary position (e.g., row 15, col 0) that has nothing to do with where the user's input text is rendered (e.g., row 9, col 4). This breaks ALL cursor-position-based approaches.

### 2. TUI apps render near the TOP of the buffer, not the bottom
A terminal with 55 buffer lines might have Claude CLI content on lines 1-14, with lines 15-54 completely empty. The original buffer search only checked `buf.length - 15` to `buf.length - 1` (lines 40-54) — missing the content entirely. **Fix: search ALL lines (`i >= 0`).**

### 3. PTY echo timing
When the user presses a key, `attachCustomKeyEventHandler` fires BEFORE xterm sends the character to PTY. The character round-trips through PTY before appearing in the buffer. At 10ms delay, the last character hasn't been echoed yet. At 300ms, Claude CLI has redrawn and the text is in the buffer. **Fix: 300ms delay for the buffer search.**

### 4. `translateToString()` returns spaces for empty lines
Lines not written to by the TUI app return `translateToString()` as all spaces. `trimEnd()` produces an empty string. This is normal — only lines with actual content have non-empty text.

## Approaches Tried (in order)

| # | Approach | Result | Why it failed |
|---|----------|--------|---------------|
| 1 | Manual pixel calculation (`screen.clientWidth / term.cols`) | Wrong position | Cell dimensions incorrect for TUI apps |
| 2 | `registerDecoration` API with deferred marker | Wrong position | `registerMarker(0)` captures wrong cursorY |
| 3 | `registerDecoration` API with synchronous marker | Wrong position | cursorY is unreliable regardless of timing |
| 4 | ANSI escape sequences + buffer search (last 15 lines) | Worked initially, then broke | Only searched bottom 15 lines; Claude CLI renders at top |
| 5 | Cursor position (`cursorX`/`cursorY`) | Wrong position | TUI apps hide real cursor |
| 6 | Buffer search with retry (last 15 lines, up to 4 retries) | Never found text | Same root cause as #4 — wrong search range |
| 7 | **ANSI escape sequences + FULL buffer search** | **Works** | Searches all lines, 300ms delay for echo |

## Final Working Solution

```typescript
function showInlineHint(text: string, trigger: string) {
  clearInlineHint();
  hintTimer = setTimeout(() => {
    if (disposed) return;
    const buf = term.buffer.active;
    // Search ALL buffer lines — TUI apps render near the top, not the bottom.
    for (let i = buf.length - 1; i >= 0; i--) {
      const line = buf.getLine(i);
      if (!line) continue;
      const lineText = line.translateToString().trimEnd();
      if (lineText.toLowerCase().endsWith(trigger)) {
        const row = i - buf.baseY + 1; // 1-based for ANSI
        const col = lineText.length + 1; // 1-based, after trigger text
        // Save cursor, move to position, write gray text, restore cursor
        term.write(`\x1b7\x1b[${row};${col}H\x1b[90m${text}\x1b[0m\x1b8`);
        ghostInfo = { row, col, len: text.length };
        return;
      }
    }
  }, 300);
}

function clearInlineHint() {
  clearTimeout(hintTimer);
  if (ghostInfo) {
    const { row, col, len } = ghostInfo;
    // Overwrite ghost text with spaces to erase it
    term.write(`\x1b7\x1b[${row};${col}H${" ".repeat(len)}\x1b8`);
    ghostInfo = null;
  }
}
```

Key ANSI sequences:
- `\x1b7` — save cursor position
- `\x1b[row;colH` — move cursor to absolute position (1-based)
- `\x1b[90m` — set foreground to bright black (dark gray)
- `\x1b[0m` — reset all attributes
- `\x1b8` — restore saved cursor position

## TAB Autocomplete: Deferred Write Pattern

`write()` calls inside `attachCustomKeyEventHandler` are swallowed by xterm. Must defer:

```typescript
// WRONG — text won't appear:
write("[Img 1]");
return false;

// CORRECT — defer to next macrotask, split DEL from content:
setTimeout(() => {
  write("\x7f".repeat(charsToErase)); // DEL chars to erase typed text
  setTimeout(() => write("[Img 1]"), 5); // small gap before inserting
}, 0);
return false; // prevent xterm from handling the key
```

Also must call `e.preventDefault()` for TAB — `return false` alone doesn't prevent browser focus navigation.

## Prevention

- **When searching xterm buffers, ALWAYS search ALL lines** — don't assume content is at the bottom. TUI apps can render anywhere.
- **Never rely on `cursorX`/`cursorY` for TUI apps** — they hide the real cursor. Use buffer text search instead.
- **Use 300ms+ delay** when searching for just-typed text in the buffer — PTY echo round-trip + TUI app redraw takes time.
- **Debug buffer issues by dumping ALL non-empty lines** with their indices — this instantly reveals where content lives.

## Verification

1. `npm run build` passes
2. Type "im" in Claude CLI terminal — gray ghost text `g 1]` appears inline after cursor
3. Type "img" — ghost text changes to ` 1]`
4. Press TAB from "im" or "img" — replaces typed text with `[Img 1]`
5. Press TAB again — cycles to `[Img 2]`, `[Img 3]`
6. Ghost text clears on backspace or unrelated key press
