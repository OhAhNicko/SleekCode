/**
 * Terminal activity tracker for AI terminals (claude, codex, gemini).
 *
 * Detection strategy: **sustained output with high data rate**, plus a
 * mode-dependent extension that keeps the badge lit through the quiet
 * phases of a real turn (long shell command, extended thinking), where the
 * TUI only repaints its spinner at ~40–150 B/s — under the 200 B/s burst
 * floor but far above idle blink noise:
 * - User typing resets clock + sets lockout (suppresses TUI echo).
 * - Resize sets lockout for idle terminals (suppresses TUI redraw).
 * - A burst is "confirmed" when output has been sustained for 1.5+ seconds
 *   AND has a data rate >= 200 bytes/sec (filters TUI idle output like
 *   cursor blinks which produce ~5-20 bytes/sec).
 * - "hysteresis" (default): a confirmed burst anchors a sticky state that
 *   survives while non-lockout output keeps crossing the trickle window;
 *   12s of quiet drops it.
 * - "markers": the badge also lights while the CLI's live status line
 *   ("esc to interrupt", the spinner's token counter) keeps repainting.
 *
 * ONLY isTerminalActive changes with the mode. The burst lifecycle that
 * feeds made:ai-done (AI-time stats, git auto-refresh) is untouched.
 */

import type { TerminalType } from "../types";
import { cleanOutput } from "./pty-text";

const AI_TYPES: ReadonlySet<TerminalType> = new Set(["claude", "codex", "gemini"]);

export type AiActivityDetectionMode = "hysteresis" | "markers";

let detectionMode: AiActivityDetectionMode = "hysteresis";

/** Pushed from React (App.tsx) — this module must not import the store
 *  (store/terminalSlice imports us; a back-import would be a cycle). */
export function setAiActivityDetectionMode(mode: AiActivityDetectionMode): void {
  detectionMode = mode;
}

interface ActivityState {
  burstStart: number;
  lastOutput: number;
  burstBytes: number;
  lockoutUntil: number;
  terminalType: TerminalType;
  /** Last time a burst passed isConfirmedActive — the hysteresis anchor.
   *  0 = no anchor; cleared when the sticky feed goes quiet. */
  confirmedAt: number;
  /** Last time output beyond the trickle window arrived OUTSIDE a typing/
   *  resize lockout. Feeds the sticky state, never the kill-safety signals. */
  stickyFedAt: number;
  /** Markers mode: last time a live-only working marker matched. */
  markerSeenAt: number;
  /** Markers mode: rolling cleaned tail so a marker split across chunks
   *  still matches. */
  tail: string;
  /** Markers mode: stateful decoder so split UTF-8 sequences survive. */
  decoder?: TextDecoder;
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

/** Hysteresis: how long the sticky feed may go quiet before the anchor
 *  drops. The feed refreshes on every chunk once the 10s trickle window has
 *  accumulated its 500 bytes; at slow spinner rates (~60 B/s) the window
 *  needs up to ~8s to re-cross after each reset, so 12s rides that out
 *  while still clearing within seconds of a turn actually ending. */
const STICKY_HOLD_MS = 12_000;

/** Markers: the status line repaints at least once per second while the CLI
 *  works (timer/token counter), so 5s of no marker means it is gone. */
const MARKER_HOLD_MS = 5_000;

/** How much cleaned text to keep for bridging a marker split across chunks.
 *  Must exceed the longest marker match by a comfortable margin. */
const TAIL_CHARS = 160;

/**
 * Live-only working markers per CLI. Every entry must be text the TUI shows
 * ONLY while working and erases when done — text that survives in scrollback
 * (completed tool summaries like "(1m 0s · 4 lines)") would false-fire on
 * resize/scroll redraws.
 */
const WORKING_MARKERS: Partial<Record<TerminalType, RegExp[]>> = {
  claude: [
    /esc to interrupt/i,
    /ctrl\+b to run in background/i,
    // Spinner token counter: "(3m 26s · ↓ 9.2k tokens" — the "· ↓/↑ N tokens"
    // part only exists on the live spinner line.
    /·\s*[↓↑]\s*[\d.,]+k?\s*tokens/i,
  ],
  codex: [/esc to interrupt/i],
  gemini: [/esc to cancel/i],
};

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

export function recordTerminalActivity(
  terminalId: string,
  terminalType: TerminalType,
  dataSize: number,
  bytes?: Uint8Array,
): void {
  let crossedTrickle = false;
  {
    const now = Date.now();
    lastOutputAt.set(terminalId, now);
    let w = outWin.get(terminalId);
    if (!w || now - w.windowStart > OUTPUT_WINDOW_MS) {
      w = { windowStart: now, bytes: 0 };
      outWin.set(terminalId, w);
    }
    w.bytes += dataSize;
    if (w.bytes >= MEANINGFUL_BYTES_PER_WINDOW) {
      lastMeaningfulOutputAt.set(terminalId, now);
      crossedTrickle = true;
    }
  }
  if (!AI_TYPES.has(terminalType)) return;

  const now = Date.now();
  let s = state.get(terminalId);
  if (!s) {
    s = {
      burstStart: 0, lastOutput: 0, burstBytes: 0, lockoutUntil: 0, terminalType,
      confirmedAt: 0, stickyFedAt: 0, markerSeenAt: 0, tail: "",
    };
    state.set(terminalId, s);
  }

  // Hysteresis feed: output past the trickle window, outside lockouts, keeps
  // an anchored sticky state alive. Lockout-gated so the user's own typing
  // echo cannot stretch the badge past the end of a turn.
  if (crossedTrickle && now >= s.lockoutUntil) s.stickyFedAt = now;

  // Markers mode: match the CLI's live status line in the cleaned stream.
  // Decode statefully (ConPTY splits UTF-8 and escape sequences mid-word)
  // and keep a rolling tail so a marker split across chunks still matches.
  if (detectionMode === "markers" && bytes) {
    const markers = WORKING_MARKERS[terminalType];
    if (markers) {
      s.decoder ??= new TextDecoder("utf-8", { fatal: false });
      const text = s.tail + cleanOutput(s.decoder.decode(bytes, { stream: true }));
      if (markers.some((m) => m.test(text))) {
        s.markerSeenAt = now;
        // Consume the match: a marker left sitting in the tail would re-fire
        // on every later chunk (even blink trickle) with no new repaint.
        s.tail = "";
      } else {
        s.tail = text.length > TAIL_CHARS ? text.slice(-TAIL_CHARS) : text;
      }
    }
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

  // Anchor the hysteresis at data time — a burst must not need a badge poll
  // to coincide with it to count.
  if (isConfirmedActive(s, now)) s.confirmedAt = now;
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
  const now = Date.now();

  if (isConfirmedActive(s, now)) {
    s.confirmedAt = now;
    return true;
  }

  if (detectionMode === "markers") {
    return s.markerSeenAt > 0 && now - s.markerSeenAt <= MARKER_HOLD_MS;
  }

  // Hysteresis: an anchored pane stays active while the sticky feed is
  // fresh. Once the feed lapses the anchor is cleared for good — a later
  // feed period cannot resurrect it without a new confirmed burst.
  if (s.confirmedAt > 0 && now - s.stickyFedAt > STICKY_HOLD_MS) s.confirmedAt = 0;
  return s.confirmedAt > 0;
}
