/**
 * Terminal activity tracker for AI terminals (claude, codex, gemini).
 *
 * Detection strategy: **sustained output duration**.
 * - User typing resets the clock (it's echo, not AI work).
 * - PTY output sets a "burst start" timestamp on first chunk.
 * - Terminal is "active" only when output has been arriving for 1.5+ seconds
 *   continuously with no user interaction in between.
 * - Resize is NOT a reset — reflow bursts are ~200ms, never reaching 1.5s.
 */

import type { TerminalType } from "../types";

const AI_TYPES: ReadonlySet<TerminalType> = new Set(["claude", "codex", "gemini"]);

interface ActivityState {
  /** When the current uninterrupted output burst started (0 = no burst). */
  burstStart: number;
  /** When the last output chunk arrived. */
  lastOutput: number;
}

const state = new Map<string, ActivityState>();

/** How long output must sustain before we consider it AI work. */
const SUSTAINED_MS = 1500;

/** If no output for this long, the burst is considered ended. */
const GAP_MS = 4000;

/** Reset the burst — user typed something. */
export function recordTerminalWrite(terminalId: string): void {
  const s = state.get(terminalId);
  if (s) {
    s.burstStart = 0;
    s.lastOutput = 0;
  }
}

/** Record PTY output. Only tracks AI terminal types. */
export function recordTerminalActivity(terminalId: string, terminalType: TerminalType, _dataSize: number): void {
  if (!AI_TYPES.has(terminalType)) return;

  const now = Date.now();
  let s = state.get(terminalId);
  if (!s) {
    s = { burstStart: 0, lastOutput: 0 };
    state.set(terminalId, s);
  }

  // If the previous burst ended (gap too large), start fresh
  if (s.lastOutput > 0 && now - s.lastOutput > GAP_MS) {
    s.burstStart = 0;
  }

  if (s.burstStart === 0) {
    s.burstStart = now;
  }
  s.lastOutput = now;
}

/** Remove tracking when terminal is destroyed. */
export function clearTerminalActivity(terminalId: string): void {
  state.delete(terminalId);
}

/** Check if a terminal has sustained AI activity. */
export function isTerminalActive(terminalId: string): boolean {
  const s = state.get(terminalId);
  if (!s || s.burstStart === 0 || s.lastOutput === 0) return false;

  const now = Date.now();
  // Output must have arrived recently
  if (now - s.lastOutput > GAP_MS) return false;
  // And the burst must have been going for at least SUSTAINED_MS
  return s.lastOutput - s.burstStart >= SUSTAINED_MS;
}
