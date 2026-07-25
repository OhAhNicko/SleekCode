import { readSessionsIndex } from "./sessions-index";
import { supportsSessionResume } from "./session-resume";
import type { TerminalBackend, TerminalType } from "../types";

/**
 * Is it safe to spawn with `--resume <id>`?
 *
 * Passing a session id that no longer exists does NOT fail quietly: the CLI
 * drops into its interactive "Resume session" picker, and MADE then behaves
 * badly around that transient dialog — the composer can steal banner text into
 * the search box (the "Welcome" glitch) and swallow the Enter meant for the
 * picker. Checking first means the picker never appears.
 *
 * FAILS OPEN on purpose. The sessions index can legitimately be missing, empty
 * or stale (it is Claude's own file, not ours), and a false "missing" would
 * silently discard a perfectly good conversation — far worse than the picker.
 * So we only report "gone" when we positively read an index that lists other
 * sessions and does not list this one.
 */
export async function sessionStillExists(
  terminalType: TerminalType,
  sessionId: string,
  projectPath: string,
  backend: TerminalBackend,
  serverId?: string,
): Promise<boolean> {
  if (!supportsSessionResume(terminalType)) return true;
  if (!projectPath) return true;
  try {
    const entries = await readSessionsIndex(projectPath, backend, serverId);
    // No index, or an index we could not read → assume it exists (fail open).
    if (!entries.length) return true;
    return entries.some((e) => e.sessionId === sessionId);
  } catch {
    return true;
  }
}
