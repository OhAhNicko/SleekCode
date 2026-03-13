import { invoke } from "@tauri-apps/api/core";
import { getCachedDistro } from "./wsl-cache";
import type { TerminalType, TerminalBackend } from "../types";

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
  /** Codex reasoning effort level (e.g. "xhigh", "high"), null if unavailable */
  effort: string | null;
  /** Codex collaboration mode (e.g. "default", "plan"), null if unavailable */
  collabMode: string | null;
  /** Claude session cost in USD, null if unavailable */
  costUsd: number | null;
  /** Claude session duration in ms, null if unavailable */
  durationMs: number | null;
  /** Claude Code CLI version (e.g. "2.1.73"), null if unavailable */
  cliVersion: string | null;
  /** Claude speed mode (e.g. "standard", "fast"), null if unavailable */
  speed: string | null;
  /** Claude context compaction count, null if unavailable */
  compactCount: number | null;
  /** Claude project-wide total cost in USD, null if unavailable */
  projectCostUsd: number | null;
  /** Gemini session summary, null if unavailable */
  summary: string | null;
  /** Gemini last-message thinking tokens, null if unavailable */
  thinkingTokens: number | null;
  /** Gemini quota reset time (ISO string), null if unavailable */
  quotaResetTime: string | null;
}

/**
 * Read context info from CLI session data.
 *
 * Backend returns pipe-delimited fields:
 * - Claude:  "USED|WINDOW|MODEL|SL_USED_PCT|COST_USD|DURATION_MS|VERSION|SERVICE_TIER|SPEED|COMPACT_COUNT|PROJECT_COST"
 * - Codex:   "USED|WINDOW|MODEL|RL_5H|RL_WEEKLY|EFFORT|COLLAB_MODE"
 * - Gemini:  "USED|WINDOW|MODEL|RPD_USED|SUMMARY|THOUGHTS|RESET_TIME"
 */
export async function readSessionContext(
  terminalType: TerminalType,
  sessionId?: string,
  backend?: TerminalBackend,
): Promise<ContextInfo | null> {

  const supported = terminalType === "claude" || terminalType === "codex" || terminalType === "gemini";
  if (!supported) return null;

  try {
    let raw: string;
    if (backend === "native") {
      // macOS/Linux: read session context directly (same as Windows path but uses $HOME)
      raw = await invoke<string>("read_session_context_native", {
        terminalType,
        sessionId: sessionId || "__latest__",
      });
    } else if (backend === "windows") {
      raw = await invoke<string>("read_session_context_windows", {
        terminalType,
        sessionId: sessionId || "__latest__",
      });
    } else {
      const distro = getCachedDistro();
      raw = await invoke<string>("read_session_context", {
        terminalType,
        sessionId: sessionId || "__latest__",
        distro: distro || null,
      });
    }
    if (!raw || !raw.includes("|")) return null;

    const parts = raw.split("|");
    const used = parseInt(parts[0], 10);
    const window = parseInt(parts[1], 10);
    const model = parts[2] || null;
    if (isNaN(used) || isNaN(window) || window <= 0) return null;

    const remaining = window - used;
    const percent = Math.round((remaining / window) * 10000) / 100;
    const clampedPercent = Math.max(0, Math.min(100, percent));

    // Defaults
    let rateLimitFiveHour: number | null = null;
    let rateLimitWeekly: number | null = null;
    let effort: string | null = null;
    let collabMode: string | null = null;
    let costUsd: number | null = null;
    let durationMs: number | null = null;
    let cliVersion: string | null = null;
    let speed: string | null = null;
    let compactCount: number | null = null;
    let projectCostUsd: number | null = null;
    let summary: string | null = null;
    let thinkingTokens: number | null = null;
    let quotaResetTime: string | null = null;

    if (terminalType === "claude") {
      // Claude: |SL_USED_PCT|COST_USD|DURATION_MS|VERSION|SERVICE_TIER|SPEED|COMPACT_COUNT|PROJECT_COST
      // field 3 = sl_used_pct (skipped), field 4-5 = per-session cost/duration, field 10 = project total
      const cost = parts[4] ? parseFloat(parts[4]) : null;
      costUsd = cost !== null && !isNaN(cost) ? cost : null;
      const dur = parts[5] ? parseInt(parts[5], 10) : null;
      durationMs = dur !== null && !isNaN(dur) ? dur : null;
      cliVersion = parts[6] || null;
      speed = parts[8] || null;
      const cc = parts[9] ? parseInt(parts[9], 10) : null;
      compactCount = cc !== null && !isNaN(cc) ? cc : null;
      const pc = parts[10] ? parseFloat(parts[10]) : null;
      projectCostUsd = pc !== null && !isNaN(pc) ? pc : null;
    } else if (terminalType === "codex") {
      // Codex: |RL_5H|RL_WEEKLY|EFFORT|COLLAB_MODE
      const rl5h = parts[3] ? parseFloat(parts[3]) : null;
      rateLimitFiveHour = rl5h !== null && !isNaN(rl5h) ? rl5h : null;
      const rlWeek = parts[4] ? parseFloat(parts[4]) : null;
      rateLimitWeekly = rlWeek !== null && !isNaN(rlWeek) ? rlWeek : null;
      effort = parts[5] || null;
      collabMode = parts[6] || null;
    } else if (terminalType === "gemini") {
      // Gemini: |RPD_USED|SUMMARY|THOUGHTS|RESET_TIME
      const rpd = parts[3] ? parseFloat(parts[3]) : null;
      rateLimitFiveHour = rpd !== null && !isNaN(rpd) ? rpd : null;
      summary = parts[4] || null;
      const th = parts[5] ? parseInt(parts[5], 10) : null;
      thinkingTokens = th !== null && !isNaN(th) && th > 0 ? th : null;
      quotaResetTime = parts[6] || null;
    }

    return {
      percent: clampedPercent,
      remaining: Math.max(0, remaining),
      window,
      model,
      rateLimitFiveHour,
      rateLimitWeekly,
      effort,
      collabMode,
      costUsd,
      durationMs,
      cliVersion,
      speed,
      compactCount,
      projectCostUsd,
      summary,
      thinkingTokens,
      quotaResetTime,
    };
  } catch {
    return null;
  }
}
