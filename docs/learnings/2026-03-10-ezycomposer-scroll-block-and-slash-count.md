# EzyComposer: Scroll Blocking, Slash Command Counter, and Text Steal on Reopen

**Date:** 2026-03-10

## Summary

Three EzyComposer issues fixed in this session:

1. **Scroll blocking** — the composer's auto-focus mechanisms made it impossible to scroll up in the terminal or select text.
2. **Slash command popup** — lacked a page counter `(1/N)` and scroll indicators; was hard-capped to 8 items with no way to see the rest.
3. **Gemini placeholder steal** — toggling the composer off/on with Ctrl+I copied Gemini's native placeholder text ("Type your message or @path/to/file") into the EzyComposer textarea.

## Symptoms

1. **Scroll**: User could not scroll up at all. The terminal snapped back to the bottom immediately.
2. **Slash commands**: No indication of how many commands existed; couldn't browse beyond the first 8.
3. **Gemini steal**: After Ctrl+I off→on, the textarea was pre-filled with Gemini's placeholder.

## Root Cause

### Scroll blocking (three layers)

**Layer 1 — `mousedown preventDefault` on the container (original code):**
The `useEffect` at mount added a `mousedown` listener on the entire terminal container with `e.preventDefault()`. This blocked the browser from giving focus to xterm, which prevented text selection and scrollbar drag. First fix attempt: guard with `isAtBottom` check. **This didn't help** because the user is AT the bottom when they start trying to scroll — the check passes, `preventDefault` fires, and the scroll never initiates.

**Layer 2 — `onWheel` on textarea with `stopPropagation` (partial):**
The textarea had `onWheel={(e) => e.stopPropagation()}` which stopped wheel events from bubbling. But wheel events go to the element under the cursor, so this only blocked scrolling when hovering directly over the small textarea area — not the main terminal. Adding wheel forwarding (`terminal.scrollLines()`) helped for the composer area but not the main terminal.

**Layer 3 — `onRender` → `scanPromptPosition` → `scrollToBottom` cycle (THE ACTUAL CAUSE):**
The `onRender` callback fires on every xterm render frame, including after scroll position changes. Inside it:
1. `scanPromptPosition()` scans the current viewport for prompt characters (`>`, `$`, etc.)
2. When scrolled up, it finds OLD prompt chars in the scrollback history
3. If it finds a Pass 1 match (prompt char), the composer stays visible and repositions
4. If it only finds Pass 2/3 (shell `$` or any non-empty line), the `alwaysVisible` check triggers `setHidden(true)`
5. When the user scrolls back down even slightly and a `>` appears in viewport, `hiddenRef.current` is `true`, so the hidden→visible transition fires `terminal.scrollToBottom()` — **snapping back to the bottom**
6. This creates an unbreakable cycle: scroll up → hide → scroll down slightly → snap to bottom

### Gemini placeholder steal

`didStealText` was a local `useRef(false)` inside PromptComposer. When Ctrl+I toggles the composer off, the component unmounts. When toggled back on, it remounts with a fresh `useRef(false)`. The mount `useEffect` calls `scanPromptPosition()` which finds Gemini's placeholder text on the prompt line (rendered as non-dim text), treats it as user-typed text, and "steals" it into the textarea.

### Slash command count

Gemini had 37 commands in our list but the real CLI reports 35. Two commands (`/plan`, `/restore`) don't exist; one (`/shortcuts`) was missing.

## Fix

### Scroll blocking
1. **Replaced `mousedown preventDefault`** with a `click` handler + 150ms delayed refocus. Clicks go through to xterm for selection/scrollbar, then focus returns to textarea.
2. **Added `isAtBottom` early return** at the top of the `onRender` callback. When scrolled up, the entire prompt-scanning/repositioning/hiding/focusing logic is skipped.
3. **When not at bottom, hide the composer** — `setHidden(true)` + `blur()` so the composer disappears when the CLI prompt scrolls out of view.
4. **On hidden→visible transition (scroll back to bottom), refocus the textarea** — safe because it only fires when `isAtBottom` is already true.
5. **Wheel forwarding** from composer div and textarea to `terminal.scrollLines()` for scrolling while hovering over the composer area.

### Gemini placeholder steal
Moved `didStealText` from a local `useRef` in PromptComposer to a `useRef` in TerminalPane, passed as `didStealRef` prop. This persists across mount/unmount cycles — text is only stolen on the very first open.

### Slash command popup
- Added `slashScrollOffset` state tracking a sliding window of 8 visible items
- Arrow keys update both `slashSelectedIdx` and `slashScrollOffset` to keep selection in view
- Added footer with `(N/total)` counter (always shown) and `▲▼` arrows (shown only when >8 matches)
- Fixed Gemini commands: removed `/plan` and `/restore`, added `/shortcuts` → exactly 35

## Prevention

- **Never use `mousedown preventDefault` on a terminal container** — it blocks all native interactions (selection, scrollbar, scroll initiation). Use delayed `click` refocus instead.
- **`onRender` callbacks in xterm run on EVERY frame, including scroll-triggered renders** — any logic inside that modifies scroll position or visibility creates feedback loops. Always guard with an `isAtBottom` check before doing anything position-related.
- **`useRef` resets on remount** — if a ref must survive component mount/unmount cycles (e.g., Ctrl+I toggle), lift it to the parent component and pass as a prop.
- **When counting array items, count the actual entries** — don't trust line-number subtraction, which is off-by-one prone. Cross-reference against the source of truth (the actual CLI's reported count).

## Verification

- `npx tsc --noEmit` — clean
- Scroll up with mouse wheel → composer hides, terminal scrolls freely
- Scroll back to bottom → composer reappears and auto-focuses
- Text selection works while scrolled up
- Ctrl+I toggle on Gemini → no placeholder text stolen
- Type `/` → see `(1/N)` counter; arrow down past 8 items → list scrolls with `▲▼` indicators
- Type `/c` → filtered count shown (e.g., `(1/5)`)
