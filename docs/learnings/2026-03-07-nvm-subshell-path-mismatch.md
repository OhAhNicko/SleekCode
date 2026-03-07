# nvm causes $() subshell PATH to differ from exported PATH

## Summary
`which <cli>` inside a `$()` bash subshell fails to find nvm-installed binaries, even though the same `which` command works when run as a direct (non-subshell) command. This caused Gemini CLI to not be cached, skipping the WSL pool optimization and adding ~10s startup time.

## Symptoms
- `[PTY] normal spawn for gemini (pool skipped or empty)` in console
- Gemini CLI took ~10 seconds to open while Claude Code and Codex were fast
- `getCachedCliPath("gemini")` returned null

## Root cause
nvm modifies the **exported** `PATH` environment variable (visible to child processes via `env`) but NOT bash's **internal** `$PATH` shell variable. This creates a split:

- `echo "$PATH"` → no nvm entries (bash internal variable)
- `env | grep PATH` → includes `/home/user/.nvm/versions/node/.../bin` (exported env)
- `which gemini` (direct command) → inherits exported PATH → finds binary
- `$(which gemini)` (subshell) → subshell re-exports bash's internal PATH → loses nvm entries → fails

The Rust `wsl_resolve_cli_env` command used `echo "gemini=$(which gemini 2>/dev/null)"` which ran `which` inside a `$()` subshell, inheriting the broken PATH.

This affected gemini and codex (nvm-installed) but may have appeared to work for claude (installed in `~/.local/bin`) in some environments depending on whether `.local/bin` was in bash's internal PATH.

## Fix
1. Changed CLI resolution to run `which` as direct commands (no subshells), using delimiter-based parsing
2. Changed PATH capture from `echo "PATH=$PATH"` to `env | sed -n 's/^PATH=/PATH=/p'` (pipe, no subshell)

Both changes avoid `$()` subshells entirely, so child processes inherit the correct exported PATH.

## Prevention
- Never use `$()` subshells when the parent bash might have nvm or similar tools that modify exported PATH differently from the shell variable
- When capturing environment from bash, prefer `env` (external command, reads exported env) over `echo "$VAR"` (reads shell variable)
- Test with nvm-installed binaries specifically (they exercise this edge case)

## Verification
```bash
# Old pattern (BROKEN):
wsl.exe -- bash -lic 'echo "gemini=$(which gemini 2>/dev/null)"'
# Output: gemini=

# New pattern (WORKS):
wsl.exe -- bash -lic 'which gemini 2>/dev/null'
# Output: /home/user/.nvm/versions/node/v22.21.1/bin/gemini
```
