/**
 * Terminal activity tracker for AI terminals (claude, codex, gemini).
 *
 * Detection strategy: **sustained output with high data rate**.
 * - User typing resets clock + sets lockout (suppresses TUI echo).
 * - Resize sets lockout for idle terminals (suppresses TUI redraw).
 * - Terminal is "active" only when output has been sustained for 1.5+ seconds
 *   AND has a data rate >= 200 bytes/sec (filters TUI idle output like
 *   cursor blinks which produce ~5-20 bytes/sec).
 */

import type { TerminalType } from "../types";

const AI_TYPES: ReadonlySet<TerminalType> = new Set(["claude", "codex", "gemini"]);

interface ActivityState {
  burstStart: number;
  lastOutput: number;
  burstBytes: number;
  lockoutUntil: number;
}

const state = new Map<string, ActivityState>();

const SUSTAINED_MS = 1500;
const GAP_MS = 4000;
const RESIZE_LOCKOUT_MS = 2500;
const TYPING_LOCKOUT_MS = 2000;

/** Minimum average bytes/sec to count as real AI work. */
const MIN_BYTES_PER_SEC = 200;

export function recordTerminalWrite(terminalId: string): void {
  const s = state.get(terminalId);
  if (s) {
    s.burstStart = 0;
    s.lastOutput = 0;
    s.burstBytes = 0;
    s.lockoutUntil = Math.max(s.lockoutUntil, Date.now() + TYPING_LOCKOUT_MS);
  }
}

export function recordTerminalResize(terminalId: string): void {
  const s = state.get(terminalId);
  if (s) {
    const now = Date.now();
    const wasConfirmedActive = isConfirmedActive(s, now);
    if (wasConfirmedActive) return;

    s.burstStart = 0;
    s.lastOutput = 0;
    s.burstBytes = 0;
    s.lockoutUntil = now + RESIZE_LOCKOUT_MS;
  }
}

export function recordTerminalActivity(terminalId: string, terminalType: TerminalType, dataSize: number): void {
  if (!AI_TYPES.has(terminalType)) return;

  const now = Date.now();
  let s = state.get(terminalId);
  if (!s) {
    s = { burstStart: 0, lastOutput: 0, burstBytes: 0, lockoutUntil: 0 };
    state.set(terminalId, s);
  }

  if (s.lastOutput > 0 && now - s.lastOutput > GAP_MS) {
    // AI output gap detected — the AI likely finished working.
    // Refresh git status bar so file/diff counts update immediately.
    if (isConfirmedActive(s, s.lastOutput)) {
      window.dispatchEvent(new Event("ezydev:git-refresh"));
      window.dispatchEvent(new Event("ezydev:ai-done"));
    }
    s.burstStart = 0;
    s.burstBytes = 0;
  }

  if (s.burstStart === 0) {
    if (now < s.lockoutUntil) return;
    s.burstStart = now;
    s.burstBytes = 0;
  }
  s.lastOutput = now;
  s.burstBytes += dataSize;
}

export function clearTerminalActivity(terminalId: string): void {
  state.delete(terminalId);
}

function isConfirmedActive(s: ActivityState, now: number): boolean {
  if (s.burstStart === 0 || s.lastOutput === 0) return false;
  if (now - s.lastOutput > GAP_MS) return false;
  const duration = s.lastOutput - s.burstStart;
  if (duration < SUSTAINED_MS) return false;
  const bytesPerSec = (s.burstBytes / duration) * 1000;
  return bytesPerSec >= MIN_BYTES_PER_SEC;
}

export function isTerminalActive(terminalId: string): boolean {
  const s = state.get(terminalId);
  if (!s) return false;
  return isConfirmedActive(s, Date.now());
}
