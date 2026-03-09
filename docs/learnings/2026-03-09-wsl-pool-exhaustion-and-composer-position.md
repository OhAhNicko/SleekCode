# WSL Pool Exhaustion, Echo Race, and Composer Position Bug

## Summary

Three related bugs when opening many panes simultaneously:
1. Only 3–5 panes would start (rest blank) — WSL pool exhaustion
2. Codex/Gemini showed garbled startup text — `stty -echo` race condition in auto-replenished pool sessions
3. EzyComposer appeared "too big" in most panes — prompt position detected before CLI TUI was fully drawn

## Symptoms

- Opening a 3-pane layout: only 3 panes start (matches pre-warm count of 3)
- Opening a 16-pane grid: 5 start (matches `WSL_POOL_MAX = 5`), rest are blank
- Codex/Gemini panes show echoed PATH text and block-character artifacts before loading
- EzyComposer spans the full pane height on most panes; toggling Ctrl+I fixes it

## Root Causes

### 1. WSL pool exhaustion
`WSL_POOL_MAX = 5` and `pre-warm count = 3`. Once the pool emptied, the fallback `pty_spawn` (direct `wsl.exe` cold-start via ConPTY) is unreliable when called for many concurrent spawns — produces blank terminals. Numbers matched exactly: 3 fast panes (pre-warm), 5 max (pool max), rest blank.

### 2. `stty -echo` race condition
`spawn_one_wsl` pushed the session to the pool immediately after `spawn_command()` returned. But bash hadn't yet executed `stty -echo 2>/dev/null` in the `-c` command. If `pty_spawn_pooled` popped the session within that window (especially auto-replenished sessions used right after replenishment), the init command was echoed into the terminal — showing the long PATH string before the CLI started.

The original bash command also did `stty echo` before `eval "$cmd"`, which was unnecessary (CLIs set their own terminal modes via ncurses).

### 3. Composer position detection before CLI is ready
`PromptComposer`'s initial `tryFind()` ran while the CLI was still loading (or showing startup output). `scanPromptPosition()` found a false positive (startup noise containing `>`) at an early row, set `topOffset = 0`, and **stopped polling immediately** (`if (tryFind()) return`). The `onRender` listener didn't fire again (no new PTY data after the initial draw), leaving the wrong position frozen. With `topOffset = 0` the composer rendered from the top of the pane to the bottom — "too big".

## Fixes

### Pool exhaustion
- `WSL_POOL_MAX`: 5 → 16 (`pty.rs`)
- Pre-warm count: 3 → 16 (`wsl-cache.ts`)
- Moved replenishment to Rust: `pty_spawn_pooled` spawns a background thread after each use to refill 1 session. Removed the fragile frontend `invoke("pty_pool_warm", ...)` call.
- Added `pool_distro()` global in Rust so auto-replenishment knows which distro to spawn.

### `stty -echo` race
- Added ready signal: bash now runs `stty -echo 2>/dev/null; printf '\001'; IFS= read -r cmd; eval "$cmd"`
- `spawn_one_wsl` reads from the PTY until it sees `\x01` (with 5s timeout) before returning, guaranteeing `stty -echo` has run
- Removed the incorrect `stty echo 2>/dev/null` before `eval` — CLIs manage their own terminal state

### Codex/Gemini startup noise (belt-and-suspenders)
- Added `printf '\033[2J\033[H'` before `exec cli` in `getPooledInitCommand()` — clears the screen before the CLI draws its TUI, hiding any remaining startup output

### Composer position stabilization
- Changed initial polling to continue for **1 second after first success** instead of stopping immediately
- `firstHitAt` tracks when first hit occurred; polling runs until `now - firstHitAt >= 1000ms` (or 15s total timeout)
- Gives the CLI's TUI time to fully render so the detected prompt position reflects the real input row, not loading-screen noise

## Prevention

- **Never push a pooled session to the pool before verifying the init command is in a clean state** — use a ready signal (sentinel byte) that the spawned process emits after any terminal setup.
- **Auto-replenishment belongs in Rust**, not the frontend. The frontend can't reliably call `invoke()` after every pane open without race conditions.
- **Don't stop scanning on first hit for async-loading CLIs** — keep polling briefly after first success to let the position stabilize.
- **Clear the terminal before `exec`ing a CLI** when using a pre-warmed bash session — prevents any bash output or startup noise from being visible.

## Verification

- Open 16 CLI panes simultaneously — all 16 should start and show their TUI
- EzyComposer should appear at the prompt row, not spanning the full pane
- No garbled text visible before Codex/Gemini loads
