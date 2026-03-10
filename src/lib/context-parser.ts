import { invoke } from "@tauri-apps/api/core";
import { getCachedDistro } from "./wsl-cache";
import type { TerminalType } from "../types";

export interface ContextInfo {
  /** Percentage remaining (0-100, two decimal places) */
  percent: number;
  /** Tokens remaining (window - used) */
  remaining: number;
  /** Total context window size */
  window: number;
  /** Model identifier (e.g. "Claude Opus 4.6", "gpt-5.4") */
  model: string | null;
  /** Codex 5h rate limit used percentage (0-100), null if unavailable */
  rateLimitFiveHour: number | null;
  /** Codex weekly rate limit used percentage (0-100), null if unavailable */
  rateLimitWeekly: number | null;
}

/**
 * Read context info from CLI session data.
 *
 * Backend returns pipe-delimited fields:
 * - Claude:  "USED_TOKENS|WINDOW|MODEL"
 * - Codex:   "USED_TOKENS|WINDOW|MODEL|RL_5H|RL_WEEKLY"
 * - Gemini:  "USED_TOKENS|WINDOW|MODEL|RPD_USED"
 */
export async function readSessionContext(
  terminalType: TerminalType,
  sessionId?: string,
): Promise<ContextInfo | null> {

  const supported = terminalType === "claude" || terminalType === "codex" || terminalType === "gemini";
  if (!supported) return null;

  const distro = getCachedDistro();
  try {
    const raw = await invoke<string>("read_session_context", {
      terminalType,
      sessionId: sessionId || "__latest__",
      distro: distro || null,
    });
    if (!raw || !raw.includes("|")) return null;

    const parts = raw.split("|");
    const used = parseInt(parts[0], 10);
    const window = parseInt(parts[1], 10);
    const model = parts[2] || null;
    if (isNaN(used) || isNaN(window) || window <= 0) return null;

    const remaining = window - used;
    const percent = Math.round((remaining / window) * 10000) / 100;
    const clampedPercent = Math.max(0, Math.min(100, percent));

    // Codex rate limits (fields 3 and 4, 0-indexed)
    const rl5h = parts[3] ? parseFloat(parts[3]) : null;
    const rlWeek = parts[4] ? parseFloat(parts[4]) : null;

    return {
      percent: clampedPercent,
      remaining: Math.max(0, remaining),
      window,
      model,
      rateLimitFiveHour: rl5h !== null && !isNaN(rl5h) ? rl5h : null,
      rateLimitWeekly: rlWeek !== null && !isNaN(rlWeek) ? rlWeek : null,
    };
  } catch {
    return null;
  }
}
