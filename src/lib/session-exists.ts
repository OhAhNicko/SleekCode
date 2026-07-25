import { invoke } from "@tauri-apps/api/core";
import { getCachedDistro } from "./wsl-cache";
import { supportsSessionResume } from "./session-resume";
import { toWslPath } from "./terminal-config";
import type { TerminalBackend, TerminalType } from "../types";

/** Backend answer: `checked` false means we could not look, not "absent". */
interface SessionFileCheck {
  exists: boolean;
  checked: boolean;
}

/**
 * Is it safe to spawn with `--resume <id>`?
 *
 * The one thing the CLI actually requires is a transcript at
 * `~/.claude/projects/<encoded-cwd>/<id>.jsonl`. Nothing else is authoritative:
 *
 * - `sessions-index.json` (what this used to read) has not been written by
 *   Claude since early 2026. It is absent from nearly every project dir, and an
 *   absent index made this function fail open on EVERY id — so a session id
 *   that never existed sailed straight through to `--resume` and the pane came
 *   up showing "No conversation found with session ID: …".
 * - `~/.claude/sessions/<pid>.json` sidecars name ids that are frequently
 *   provisional; a third of them point at sessions that have no transcript.
 *
 * An id with no transcript also means no conversation was ever written under
 * it, so dropping it and starting fresh cannot lose work.
 *
 * STILL FAILS OPEN on anything we could not positively determine — SSH (no
 * remote equivalent), a project dir we cannot reach, or a thrown command. Only
 * a definite "the directory is there and the file is not" returns false.
 */
export async function sessionStillExists(
  terminalType: TerminalType,
  sessionId: string,
  projectPath: string,
  backend: TerminalBackend,
  serverId?: string,
): Promise<boolean> {
  if (!supportsSessionResume(terminalType)) return true;
  if (terminalType !== "claude") return true; // codex/gemini store sessions elsewhere
  if (!sessionId || !projectPath) return true;
  if (backend === "ssh" || serverId) return true; // no remote transcript check
  try {
    let check: SessionFileCheck;
    if (backend === "native") {
      check = await invoke<SessionFileCheck>("claude_session_file_exists_native", {
        projectPath,
        sessionId,
      });
    } else if (backend === "windows") {
      check = await invoke<SessionFileCheck>("claude_session_file_exists_windows", {
        projectPath,
        sessionId,
      });
    } else {
      // Callers hand us the pane's workingDir, which on this backend is a
      // WINDOWS path — Claude's project-dir key is built from the Unix one.
      // (toWslPath is idempotent, so an already-converted path is safe.)
      const wslCwd = toWslPath(projectPath);
      if (!wslCwd) return true;
      const distro = getCachedDistro();
      check = await invoke<SessionFileCheck>("claude_session_file_exists", {
        projectPath: wslCwd,
        sessionId,
        distro: distro || null,
      });
    }
    if (!check?.checked) return true; // could not look → keep the id
    return check.exists;
  } catch {
    return true;
  }
}
