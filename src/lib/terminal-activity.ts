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
  terminalType: TerminalType;
}

const state = new Map<string, ActivityState>();

// --- Ungated recency (hibernation idle gate) -------------------------------
//
// The burst heuristic above is COSMETIC (tab dots, AI-time) and unsuitable as
// a kill-safety signal: it is AI-gated, rate-thresholded (200 B/s), and
// `recordTerminalWrite` zeroes `lastOutput`. The hibernation gate instead
// needs raw recency for EVERY pane type: "when did this pane last emit any
// output at all / last receive a keystroke". Kept separate so neither system
// can distort the other.
const lastOutputAt = new Map<string, number>();
const lastInputAt = new Map<string, number>();

// An IDLE TUI is not output-silent: cursor blink alone trickles ~5-20 B/s
// (the reason the burst heuristic has its 200 B/s floor). "Meaningful" output
// is therefore windowed: ≥500 bytes inside a 10 s window (50 B/s) — far above
// blink noise, far below anything real (a working spinner repaints whole
// lines at ~10 Hz). A pane whose lastMeaningfulOutputAt is old is quiet even
// if its cursor still blinks.
const OUTPUT_WINDOW_MS = 10_000;
const MEANINGFUL_BYTES_PER_WINDOW = 500;
const outWin = new Map<string, { windowStart: number; bytes: number }>();
const lastMeaningfulOutputAt = new Map<string, number>();

/** Epoch ms of the pane's most recent PTY output (any type, any size). */
export function paneLastOutputAt(terminalId: string): number | undefined {
  return lastOutputAt.get(terminalId);
}

/** Epoch ms of the last time output exceeded the trickle threshold — the
 *  hibernation gate's output signal (raw lastOutputAt never goes quiet for
 *  TUIs). */
export function paneLastMeaningfulOutputAt(terminalId: string): number | undefined {
  return lastMeaningfulOutputAt.get(terminalId);
}

/** Epoch ms of the pane's most recent recorded user input. Native panes only
 *  record composer writes (direct keys go to the child HWND, invisible to
 *  JS), so treat "undefined/old" as weak evidence — the output + CPU signals
 *  carry the gate. */
export function paneLastInputAt(terminalId: string): number | undefined {
  return lastInputAt.get(terminalId);
}

const SUSTAINED_MS = 1500;
const GAP_MS = 4000;
const RESIZE_LOCKOUT_MS = 2500;
const TYPING_LOCKOUT_MS = 2000;

/** Minimum average bytes/sec to count as real AI work. */
const MIN_BYTES_PER_SEC = 200;

export function recordTerminalWrite(terminalId: string): void {
  lastInputAt.set(terminalId, Date.now());
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
  {
    const now = Date.now();
    lastOutputAt.set(terminalId, now);
    let w = outWin.get(terminalId);
    if (!w || now - w.windowStart > OUTPUT_WINDOW_MS) {
      w = { windowStart: now, bytes: 0 };
      outWin.set(terminalId, w);
    }
    w.bytes += dataSize;
    if (w.bytes >= MEANINGFUL_BYTES_PER_WINDOW) lastMeaningfulOutputAt.set(terminalId, now);
  }
  if (!AI_TYPES.has(terminalType)) return;

  const now = Date.now();
  let s = state.get(terminalId);
  if (!s) {
    s = { burstStart: 0, lastOutput: 0, burstBytes: 0, lockoutUntil: 0, terminalType };
    state.set(terminalId, s);
  }

  if (s.lastOutput > 0 && now - s.lastOutput > GAP_MS) {
    // AI output gap detected — the AI likely finished working.
    // Refresh git status bar so file/diff counts update immediately.
    if (isConfirmedActive(s, s.lastOutput)) {
      dispatchBurstEvents(terminalId, s);
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
  const s = state.get(terminalId);
  if (s && isConfirmedActive(s, Date.now())) {
    dispatchBurstEvents(terminalId, s);
  }
  state.delete(terminalId);
  lastOutputAt.delete(terminalId);
  lastInputAt.delete(terminalId);
  outWin.delete(terminalId);
  lastMeaningfulOutputAt.delete(terminalId);
}

/** Dispatch enriched ai-done and git-refresh events with burst metadata. */
function dispatchBurstEvents(terminalId: string, s: ActivityState): void {
  const durationMs = s.lastOutput - s.burstStart;
  const detail = { terminalId, terminalType: s.terminalType, durationMs };
  window.dispatchEvent(new CustomEvent("made:git-refresh", { detail }));
  window.dispatchEvent(new CustomEvent("made:ai-done", { detail }));
}

/**
 * Sweep all tracked terminals for stale bursts (no new data for > GAP_MS)
 * and dispatch events. Call this periodically to catch idle terminals.
 */
export function flushStaleBursts(): void {
  const now = Date.now();
  for (const [terminalId, s] of state) {
    if (s.lastOutput > 0 && now - s.lastOutput > GAP_MS && isConfirmedActive(s, s.lastOutput)) {
      dispatchBurstEvents(terminalId, s);
      s.burstStart = 0;
      s.burstBytes = 0;
    }
  }
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
