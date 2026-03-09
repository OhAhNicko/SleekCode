# WSL Pool Exhaustion, Dashed TUI Borders, and EzyComposer Position Bug

## Summary

Four bugs resolved when opening many panes simultaneously:
1. **WSL pool exhaustion** — only 3–5 of N requested panes would start; rest were blank
2. **`stty -echo` race condition** — Codex/Gemini showed echoed PATH text and block-character artifacts before loading
3. **EzyComposer "too big"** — composer spanned the full pane height on most panes when 16 opened at once
4. **Dashed TUI borders** — box-drawing characters in all 16 panes rendered as dashed/dotted lines instead of solid

---

## Bug 1: WSL Pool Exhaustion (blank panes)

### Symptoms
- Opening a 3-pane layout: only 3 start (matches pre-warm count of 3)
- Opening a 16-pane grid: 5 start (matches `WSL_POOL_MAX = 5`), rest blank
- Numbers matched exactly with pool constants

### Root Cause
`WSL_POOL_MAX = 5` and pre-warm count = 3. Once the pool emptied, the fallback `pty_spawn` (direct `wsl.exe` cold-start via ConPTY) is unreliable for many concurrent spawns — produces blank terminals.

Auto-replenishment was done in the frontend via `invoke("pty_pool_warm", { count: 3 })` after each pane open. This was fragile: concurrent pane opens meant multiple frontend calls racing to replenish, and the replenish call itself fires after the pane is already requesting a session.

### Fix
- `WSL_POOL_MAX`: 5 → 16 (`pty.rs`)
- Pre-warm count: 3 → 16 (`wsl-cache.ts`)
- Moved replenishment to Rust: `pty_spawn_pooled` spawns a background thread after each use to refill 1 session. Removed the fragile frontend `invoke("pty_pool_warm", ...)` call.
- Added `pool_distro()` global in Rust so auto-replenishment knows which distro to spawn.

---

## Bug 2: `stty -echo` Race Condition (Codex/Gemini startup noise)

### Symptoms
- Codex/Gemini panes show echoed PATH text and block-character artifacts before loading
- Only affects sessions retrieved from the pool, especially auto-replenished ones

### Root Cause
`spawn_one_wsl` pushed the session to the pool immediately after `spawn_command()` returned. But bash hadn't yet executed `stty -echo 2>/dev/null` in the `-c` command. If `pty_spawn_pooled` popped the session during that window, the init command was echoed into the terminal.

The original bash command also did `stty echo` before `eval "$cmd"`, which was incorrect — CLIs set their own terminal modes via ncurses.

### Fix
- Ready signal: bash runs `stty -echo 2>/dev/null; printf '\001'; IFS= read -r cmd; eval "$cmd"`
- `spawn_one_wsl` reads from the PTY until it sees `\x01` (with 5s timeout) before returning, guaranteeing `stty -echo` has run
- Removed the incorrect `stty echo 2>/dev/null` before `eval`
- Added `printf '\033[2J\033[H'` before `exec cli` in `getPooledInitCommand()` — clears the screen before the CLI draws its TUI, hiding any remaining startup output

---

## Bug 3: EzyComposer "Too Big" (wrong `topOffset`)

### Symptoms
- EzyComposer spans full pane height on most panes when 16 opened simultaneously
- Toggling Ctrl+I twice (close+reopen) fixes it
- Affects all CLI types, not just one

### Root Cause
`PromptComposer`'s initial `tryFind()` ran while the CLI was still loading (or showing startup output). `scanPromptPosition()` found a false positive (startup noise containing `>`) at an early row, set `topOffset = 0`, and **stopped polling immediately** (`if (tryFind()) return`). The `onRender` listener didn't fire again (no new PTY data after the initial draw), leaving the wrong position frozen. With `topOffset = 0` the composer rendered from the top of the pane to the bottom.

### Fix
- Changed initial polling to continue for **1 second after first success** instead of stopping immediately
- `firstHitAt` tracks when first hit occurred; polling runs until `now - firstHitAt >= 1000ms` (or 15s total timeout)
- Added `ResizeObserver` on `.xterm-screen` to re-scan when terminal is resized (handles the case where `onRender` doesn't fire)

---

## Bug 4: Dashed TUI Borders (renderer mismatch)

### Symptoms
- When 16 panes open simultaneously, ALL terminals show dashed/dotted box-drawing lines instead of solid
- Visible in Claude Code's welcome box (`┌─ Claude Code ─┐` renders as `┌╌ Claude Code ╌┐`)
- EzyComposer card borders (for Codex/Gemini) also appeared dashed
- Single-pane layouts look fine; only triggers with large pane counts (>6)
- Closing and reopening a single pane fixes it for that pane

### Initial Misdiagnosis
The first investigation focused on `.pane-active { box-shadow: inset 0 0 0 1px ... }` — the 1px spread was suspected of rendering as dotted at 125–150% DPI scaling (physical fractional pixels). This was changed to 2px but **did not fix the issue**. The user confirmed it was still broken.

This was wrong because:
1. CSS box-shadows don't render as "dashed" — they render as solid or not at all
2. The dashing was INSIDE the xterm canvas, in terminal content, not in a CSS overlay

### Root Cause
The `manyPanes = paneCountRef.current > 6` guard caused the code to **entirely skip the WebGL addon** for large pane counts:

```javascript
const webglTimer = !manyPanes ? setTimeout(() => { /* WebGL init */ }, 200) : undefined;
```

With >6 panes, every terminal used the **DOM renderer** (xterm's default fallback). The DOM renderer renders each character as an HTML `<span>` element with CSS `font-family`, `font-size`, and critically: `letter-spacing: 1px`.

CSS `letter-spacing` adds space **after** each character (trailing gap). For normal text this is fine. But for Unicode box-drawing characters (─ │ ┌ ┐ └ ┘) that need to tile edge-to-edge, a 1px trailing gap after each character breaks the continuity:

```
─ [1px gap] ─ [1px gap] ─   →   appears as   ╌ ╌ ╌   (dashed)
```

The **WebGL renderer** handles this correctly: it renders glyphs into a texture atlas at cell boundaries. The letter-spacing offsets glyph position within the cell rather than adding space between cells, so adjacent box-drawing chars connect.

The `manyPanes` optimization was added to avoid Chrome's `~16 WebGL contexts` cap. But `MAX_PANES = 16` and Chrome's cap is ~16 — meaning exactly 16 panes CAN each get a WebGL context. The optimization was over-conservative and introduced the rendering regression.

### Fix
Removed the `!manyPanes` guard; always attempt WebGL for every pane. For >6 panes, stagger the init delay randomly between 200–1000ms to avoid all 16 requesting GPU contexts simultaneously:

```javascript
const webglDelay = manyPanes ? 200 + Math.floor(Math.random() * 800) : 200;
const webglTimer = setTimeout(() => {
  try {
    if (!disposed && el.offsetHeight) {
      const webgl = new WebglAddon();
      term.loadAddon(webgl);
      term.options.fontFamily = "Hack, monospace";
      term.options.fontSize = baseFontSize;
      fitAddon.fit();
    }
  } catch {
    // Context limit exceeded — canvas/DOM renderer is the fallback
  }
}, webglDelay);
```

The existing `try/catch` already handles WebGL failures gracefully. `manyPanes` is retained but now only controls the `scrollback` budget (2000 vs 10000 lines).

---

## Prevention

- **Never skip WebGL for large pane counts** — the DOM renderer's CSS `letter-spacing` breaks box-drawing character continuity. If WebGL must be limited, use `letterSpacing: 0` in the terminal options when falling back to DOM renderer.
- **Auto-replenishment belongs in Rust** — the frontend can't reliably call `invoke()` after every pane open without race conditions.
- **Never push a pooled session before verifying init is complete** — use a ready signal (sentinel byte `\x01`) that the spawned process emits after terminal setup.
- **Don't stop scanning EzyComposer position on first hit** — keep polling briefly (1s) after first success to let the CLI's TUI fully draw.
- **DPI artifacts in box-shadows** — use 2px spread (`inset 0 0 0 2px`) for active pane indicators instead of 1px to avoid fractional-pixel dotted rendering at 125–150% display scaling.

## Verification

- Open 16 CLI panes simultaneously — all 16 should start and show solid TUI borders
- EzyComposer should appear at the prompt row, not spanning full pane height
- No garbled text visible before Codex/Gemini loads
- Claude Code welcome box: `┌─ Claude Code ─┐` should be solid lines, not dashed
