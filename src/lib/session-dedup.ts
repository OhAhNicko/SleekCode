/**
 * Cross-renderer session claim/dedup state.
 *
 * Lifted verbatim out of TerminalPaneXterm so the xterm pane, the native pane
 * and the shared `useSessionContext` hook all resolve session ownership against
 * ONE universe. A per-renderer copy of any of this is the header/session-steal
 * bug class — do not re-home it into a component.
 * TerminalPaneXterm re-exports every symbol here for its existing importers.
 */
import { invoke } from "@tauri-apps/api/core";
import { toWslPath } from "./terminal-config";
import { getCachedDistro } from "./wsl-cache";

// Track session IDs already claimed by panes in this app instance.
// Prevents multiple panes from claiming the same session file during disk lookup.
export const claimedSessionIds = new Set<string>();

/** Atomically claim a session ID. Returns true if this caller won the claim. */
export function claimSessionId(id: string): boolean {
  if (claimedSessionIds.has(id)) return false;
  claimedSessionIds.add(id);
  return true;
}

// Per-pane bookkeeping used to stop an EXISTING pane from "stealing" a
// newly-added pane's session. Both late-detection and drift-detection look for
// session files started after THIS pane's spawn with no upper bound, so when a
// new resumable pane is added its fresh session (necessarily newer) gets grabbed
// by an older pane during the brief window before the new pane claims it. The
// result is the header session/model/cost text swapping between the existing
// pane and the freshly-added one (bodies/PTYs are unaffected).
export const paneSpawnMs = new Map<string, number>(); // terminalId -> first-seen (spawn) ms
export const panesWithLockedSession = new Set<string>(); // terminalIds that locked their own session
export const paneWorkingDir = new Map<string, string>(); // terminalId -> normalized workingDir

/**
 * True when a resumable pane spawned AFTER `terminalId` still hasn't locked its
 * own session — a just-detected newer session most likely belongs to it, so we
 * defer adoption. Bounded to 60s so a pane that never locks can't block older
 * panes' legitimate drift forever.
 */
export function newerResumablePaneStillResolving(terminalId: string): boolean {
  const mine = paneSpawnMs.get(terminalId);
  if (mine == null) return false;
  const now = Date.now();
  for (const [id, spawn] of paneSpawnMs) {
    if (id !== terminalId && spawn > mine && !panesWithLockedSession.has(id) && now - spawn < 60_000) {
      return true;
    }
  }
  return false;
}

/**
 * True when another resumable pane shares this pane's working dir. In that case
 * the "__latest__" session fallback is ambiguous — the most-recent session for
 * the dir may belong to the sibling pane — so an UNLOCKED pane must not display
 * it (would show another pane's session/model/cost). Once the pane locks its own
 * session this no longer applies.
 */
export function otherResumablePaneSharesDir(terminalId: string, normalizedDir: string): boolean {
  for (const [id, dir] of paneWorkingDir) {
    if (id !== terminalId && dir === normalizedDir) return true;
  }
  return false;
}

// Session-resume diagnostics. Enable with `window.__madeSessionDebug = true` in
// DevTools to trace every spawn-based lookup (inputs + result) and every dedup
// adoption/defer decision — used to confirm in the field whether a residual
// "not remembered" comes from clock skew, cwd casing, or the pane dedup race.
export function sessionDebugEnabled(): boolean {
  return typeof window !== "undefined" && !!(window as { __madeSessionDebug?: boolean }).__madeSessionDebug;
}
export function sessionDebug(msg: string, extra?: Record<string, unknown>) {
  if (!sessionDebugEnabled()) return;
  // eslint-disable-next-line no-console
  console.debug(`[SessionResume] ${msg}`, extra ?? {});
}

/**
 * Precise (spawn-based) Claude session lookup across all backends. Threads the
 * Windows-clock `nowMs` so the WSL backend can correct the startedAt floor for
 * WSL↔Windows clock skew, and a `debug` flag so the backend emits per-file
 * diagnostics. Returns the matched sessionId or null.
 */
export async function lookupClaudeBySpawn(
  backend: string | undefined,
  workingDir: string,
  minStartedAt: number,
  excludeIds: string[],
  phase: string,
): Promise<string | null> {
  const debug = sessionDebugEnabled();
  const nowMs = Date.now();
  let id: string | null = null;
  let projectPath = "";
  if (backend === "native") {
    projectPath = workingDir;
    if (projectPath) id = await invoke<string | null>("get_claude_session_id_by_spawn_native", { projectPath, minStartedAtMs: minStartedAt, nowMs, excludeIds, debug });
  } else if (backend === "windows") {
    projectPath = workingDir;
    if (projectPath) id = await invoke<string | null>("get_claude_session_id_by_spawn_windows", { projectPath, minStartedAtMs: minStartedAt, nowMs, excludeIds, debug });
  } else {
    projectPath = toWslPath(workingDir);
    if (projectPath) id = await invoke<string | null>("get_claude_session_id_by_spawn", { projectPath, minStartedAtMs: minStartedAt, nowMs, excludeIds, debug, distro: getCachedDistro() });
  }
  sessionDebug(`${phase} by_spawn`, { backend: backend ?? "wsl", projectPath, minStartedAt, nowMs, excludeCount: excludeIds.length, result: id });
  return id;
}
