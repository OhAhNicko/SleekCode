# Claude Code Session Resume on App Restart

**Date:** 2026-03-07
**Scope:** Multi-file feature spanning types, Rust backend, React hooks, and terminal spawning

## Summary

Implemented session resume for Claude Code panes so that conversations persist across app restarts. Each Claude pane captures its session UUID from `~/.claude/projects/<encoded-path>/*.jsonl` files and passes `--resume <uuid>` on the next spawn. This required solving several non-obvious issues with WSL process spawning, stale React closures, Zustand persist timing, and multi-pane session deduplication.

## The Journey: 5 Failed Approaches Before Success

### Attempt 1: Parse Claude's exit output for `--resume <uuid>`

**Reasoning:** Claude prints `To resume this conversation, run: claude --resume <uuid>` on exit. Parse it from PTY output.

**Why it failed:** When the user closes a pane via the X button, Claude is force-killed (SIGKILL) and never prints the exit message. The PTY exit event either doesn't fire or fires after the React component unmounts. Even when Claude exits gracefully, raw PTY output contains ANSI escape codes that break the regex. A `stripAnsi()` function and xterm buffer fallback were added but the fundamental problem remained: force-kill = no output.

**Lesson:** Don't rely on process exit output for critical state capture. Processes can be killed at any time.

### Attempt 2: Filesystem lookup via Rust/WSL command

**Reasoning:** Claude stores session files at `~/.claude/projects/<encoded-path>/<uuid>.jsonl`. List them sorted by modification time, take the newest.

**Initial failure:** The Rust command used `bash -c` (non-login shell) and double quotes in the script. Windows->WSL command-line escaping mangled the double quotes. Fixed by using `bash -lic` (login shell, matching working `wsl_resolve_cli_env` pattern) and eliminating all double quotes — using `~` instead of `$HOME` and `sed` instead of `basename`.

**Lesson:** For WSL commands from Windows, always use `bash -lic` and avoid double quotes in the script string. Use `~` for home directory, `sed` for string manipulation. Match patterns from code that already works (`wsl_resolve_cli_env`).

### Attempt 3: UUID fetched but not persisted across restart

**Reasoning:** The disk lookup successfully returned UUIDs, but on restart `sessionResumeId` was always `undefined`.

**Root cause:** The `onSessionResumeId` callback in Workspace.tsx captured `tab.layout` from the React render closure. The disk lookup fires ~5 seconds after first data. By then, `tab.layout` was stale — any state update in the interim (terminal focus, other pane changes) would overwrite the layout, losing the `sessionResumeId`.

**Fix:** Read the current layout from the Zustand store at callback time instead of the closure:
```typescript
// BAD: stale closure
onSessionResumeId={(id) => {
  updateTabLayout(tab.id, setSessionResumeIdInLayout(tab.layout, termId, id));
}}

// GOOD: read current state
onSessionResumeId={(id) => {
  const currentTab = useAppStore.getState().tabs.find(t => t.id === tab.id);
  if (currentTab) {
    updateTabLayout(tab.id, setSessionResumeIdInLayout(currentTab.layout, termId, id));
  }
}}
```

**Lesson:** Any callback that fires asynchronously (timers, promises, event handlers) and modifies Zustand state should read the current state via `useAppStore.getState()` at call time, not from the render closure. This is a general React+Zustand pattern for deferred callbacks.

### Attempt 4: UUID persisted + restored, but `--resume` doesn't work at spawn time

**Reasoning:** Debug logs confirmed `sessionResumeId` was flowing through props to `usePty`. The `--resume <uuid>` flag was visible in the spawn command. But Claude started fresh sessions.

**Root cause (Part A — wsl.exe argument parsing):** The "fast path" spawn used `wsl.exe -e /usr/bin/env PATH=... claude --resume <uuid>`, passing `--resume` as a separate argument through `wsl.exe`'s argument parser. This works for simple flags but `--resume` was not reaching Claude correctly. The user confirmed `claude --resume <uuid>` works when typed manually inside a bash session.

**Fix:** Force resume spawns to use `bash -lic` (the "slow path"): `wsl.exe -- bash -lic "cd '/path' && exec /path/to/claude --resume <uuid>"`. This wraps everything in a single shell string that bash interprets, matching the manual test exactly.

**Root cause (Part B — WSL cold start race):** On app restart, terminal spawns raced ahead before WSL was fully booted. The pre-warmed WSL pool was empty (pool warming is async). The normal spawn path started `wsl.exe` on a cold WSL instance, which caused `--resume` to fail silently.

**Fix:** Added `wslReady` promise to `wsl-cache.ts` that resolves after WSL boots + pool warms. Resume spawns `await wslReady` before proceeding. Fresh spawns can still race ahead and use the pool.

**Root cause (Part C — pooled bash environment):** The pooled bash sessions use `--norc --noprofile`, creating a minimal environment. Even after WSL was ready, the pooled path might lack environment setup Claude needs for `--resume`.

**Fix:** Skip the pooled spawn path entirely for resume spawns. Force the `bash -lic` normal spawn path, which sources the full login profile.

**Lesson:** When spawning CLI tools via `wsl.exe`, there are three distinct spawn mechanisms with different reliability:
1. `wsl.exe -e /usr/bin/env ...` (fast path) — arguments get parsed by wsl.exe, may mangle `--flags`
2. `wsl.exe -- bash -lic "command"` (slow path) — bash handles everything, most reliable
3. Pooled bash (pre-warmed `--norc --noprofile`) — fast but minimal environment

For commands where argument correctness is critical (like `--resume`), always use the `bash -lic` path. It's slower but matches interactive shell behavior exactly.

### Attempt 5 (final): Both panes resume the same session

**Reasoning:** Disk lookup finds the most recent `.jsonl` file. Both Claude panes got the same UUID.

**Fix:** Three-part solution:
1. Skip disk lookup if pane already has a persisted `sessionResumeId` (restart case)
2. Module-level `claimedSessionIds` Set tracks which UUIDs are already taken
3. Rust `get_claude_session_id` accepts `exclude_ids` parameter, returns the most recent file NOT in the exclude list

## Files Changed

| File | Change |
|---|---|
| `src/types/index.ts` | Added `sessionResumeId?: string` to `PaneLeaf` |
| `src/lib/session-resume.ts` | New file: `supportsSessionResume()`, `getResumeFlag()`, `extractSessionResumeId()` |
| `src/lib/layout-utils.ts` | Added `setSessionResumeIdInLayout()` tree walker |
| `src/lib/terminal-config.ts` | Resume spawns use `bash -lic` with cd baked in; accepts `wslCwd` param |
| `src/lib/wsl-cache.ts` | Exports `wslReady` promise; awaits pool warming before resolving |
| `src/hooks/usePty.ts` | Threads `sessionResumeId` via ref; skips pool for resume; awaits `wslReady` |
| `src/components/TerminalPane.tsx` | Disk lookup with exclude list; `claimedSessionIds` set; skips lookup if already has ID |
| `src/components/Workspace.tsx` | Passes `sessionResumeId` from leaf to pane; reads current store state in callback |
| `src-tauri/src/lib.rs` | `get_claude_session_id` accepts `exclude_ids`, returns first non-excluded UUID |

## Key Architecture Decisions

1. **Ref pattern for sessionResumeId in usePty**: The ID is captured via `useRef` and NOT included in the effect dependency array. This prevents kill-respawn cycles when the ID is persisted mid-session. The ref is read once at spawn time inside a `setTimeout(..., 0)`.

2. **Disk lookup vs output parsing**: Filesystem lookup is fundamentally more reliable than output parsing because it doesn't depend on clean process exit. The trade-off is a ~5 second delay before the ID is captured (waiting for Claude to create the session file).

3. **bash -lic for resume, fast path for fresh**: Fresh sessions use the fast `wsl.exe -e /usr/bin/env` path or the pool. Resume sessions always use `bash -lic` for maximum compatibility. The ~1 second startup penalty is acceptable since resume only happens on app restart.

## Prevention Checklist

- [ ] Async callbacks modifying Zustand state: always use `getState()` at call time
- [ ] WSL command strings: use `bash -lic`, avoid double quotes, use `~` for home
- [ ] CLI flag passing via wsl.exe: use `bash -lic "command --flag"`, not `wsl.exe -e command --flag`
- [ ] Multi-pane features: always consider the "both panes get the same value" scenario
- [ ] Process exit output: never rely on it for critical state — processes can be killed

## Verification

1. `npx tsc --noEmit` passes
2. Open 2+ Claude panes, have different conversations, close app
3. Reopen — each pane resumes its own unique session
4. Change terminal type from Claude to Shell — verify resume ID is cleared
5. Split a Claude pane — new pane starts fresh (no resume ID)
