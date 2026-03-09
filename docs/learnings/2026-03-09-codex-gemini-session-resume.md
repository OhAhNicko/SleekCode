# Codex & Gemini Session Resume on App Restart

**Date:** 2026-03-09
**Scope:** Session resume for Codex CLI and Gemini CLI panes (extending existing Claude Code support)

## Summary

Extended the session resume feature (previously Claude-only) to Codex and Gemini CLIs. Each CLI stores sessions differently, uses different resume syntax, and required a separate Rust/Tauri lookup command. Gemini required 4 iterations due to incorrect assumptions about file location and a `find -printf` incompatibility with `wsl.exe` invocation.

## Key Differences Per CLI

| | Claude | Codex | Gemini |
|---|---|---|---|
| **Session path** | `~/.claude/projects/<encoded-path>/*.jsonl` | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` | `~/.gemini/tmp/<project_name>/chats/session-<ts>-<partial>.json` |
| **Resume syntax** | `claude --resume <uuid>` | `codex resume <uuid>` (subcommand) | `gemini --resume <uuid>` |
| **ID source** | Filename IS the UUID | JSON first line: `"id": "<uuid>"` | JSON line 2: `"sessionId": "<uuid>"` |
| **Project filter** | Directory encodes project path | `"cwd"` field in JSON first line | Directory per project name |
| **File format** | Single-line JSONL | Single-line JSONL | Pretty-printed JSON |

## Failed Attempts (Gemini)

### Attempt 1: Extract session ID from filename

**Reasoning:** Gemini filenames contain a partial UUID (e.g., `session-2026-03-04T20-01-18578f73.json`). Assumed the filename stem was the session ID.

**Why it failed:** The filename only contains the FIRST BLOCK of the UUID. The full session UUID is inside the JSON file content as `"sessionId": "18578f73-2769-4024-8b77-93cca984721e"`. Using the partial UUID with `gemini --resume` fails silently.

**Lesson:** Always verify the session ID format by reading the actual file content. Filenames may be abbreviated.

### Attempt 2: find -printf pipeline via wsl.exe

**Reasoning:** Used `find ~/.gemini/tmp -path '*/chats/*' -type f -printf '%T@ %p\n' | sort -rn | while read ... head -3 ... | grep sessionId` to find files sorted by mtime, read their contents, and extract the UUID. This pipeline worked perfectly when run interactively in a WSL terminal.

**Why it failed:** `find -printf` is a GNU extension that silently fails (or behaves differently) when invoked via `wsl.exe -- bash -lic "..."` from the Tauri/Windows side. With `2>/dev/null` suppressing errors, the pipeline produced empty output. The Rust `invoke` returned `null`.

**Fix:** Replaced `find -printf` with `ls -1t GLOB`, which is the same POSIX approach used by Claude's working session lookup: `ls -1t ~/.gemini/tmp/*/chats/*.json 2>/dev/null | head -20 | xargs grep -h sessionId 2>/dev/null | grep -oE 'UUID_PATTERN'`.

**Lesson:** When writing shell commands that will be invoked via `wsl.exe -- bash -lic`, stick to POSIX utilities (`ls`, `grep`, `sed`, `xargs`). Avoid GNU-specific flags like `find -printf`. The Claude session lookup (which uses `ls -1t` with glob) is the proven pattern — match it.

### Attempt 3: Searched Windows home instead of WSL home

**Reasoning:** User shared Gemini session path with backslashes (`.gemini\tmp\2codegem\chats\...`), assumed it was a Windows-side path.

**Why it failed:** User had actually copied the path from Windows File Explorer browsing the WSL filesystem (via `\\wsl.localhost\...`). The sessions ARE in the WSL home directory.

**Lesson:** Backslashes in a path don't necessarily mean Windows filesystem. WSL paths shown in Windows Explorer use backslashes. Always ask to confirm before adding cross-filesystem search paths.

## Files Changed

| File | Change |
|---|---|
| `src/lib/session-resume.ts` | Added `codex` and `gemini` to `RESUME_PATTERNS`; `getResumeFlag("codex")` returns `resume <id>` (subcommand) |
| `src/components/TerminalPane.tsx` | `lookupSession` dispatches to the right Tauri command per terminal type |
| `src-tauri/src/lib.rs` | Added `get_codex_session_id` and `get_gemini_session_id` commands; registered in invoke handler |
| `src/hooks/usePty.ts` | Removed unused `getCachedDistro` import (pre-existing issue from pool warm removal) |

## Prevention

- **New Tauri/WSL shell commands:** Always use `ls`/`grep`/`sed`/`xargs` pattern from Claude's working `get_claude_session_id`. Never use `find -printf` via `wsl.exe`.
- **Session ID extraction:** Always read the actual file content to get session IDs. Filenames may only contain partial/abbreviated IDs.
- **New CLI resume support:** Research 3 things upfront: (1) exact resume flag syntax, (2) session file storage path, (3) session ID location (filename vs file content vs JSON field).

## Verification

1. `npm run build` passes
2. Open Claude, Codex, and Gemini panes → wait 10s for session lookup
3. Restart app → all three panes resume their previous conversations
4. Open two panes of same CLI type → each resumes a different session (deduplication via `claimedSessionIds`)
