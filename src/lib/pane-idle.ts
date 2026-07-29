/**
 * Trustworthy per-pane "is work happening" gate for tab hibernation.
 *
 * The burst heuristic in terminal-activity.ts is cosmetic and MUST NOT gate
 * kills (AI-only, rate-thresholded, zeroed by typing). This gate instead
 * demands sustained quiet on INDEPENDENT signals, and fails safe: any signal
 * that cannot be read counts as "working". A session whose pane is only
 * orchestrating subagents is caught twice — the parent TUI's spinner keeps
 * the output signal hot, and the subagent processes (which inherit
 * MADE_PANE_ID) keep the CPU signal hot.
 *
 * Signals, all in the WINDOWS clock (never compare WSL file times against
 * Date.now() — WSL↔Windows clock skew is a documented bug class here; change
 * detection between OUR OWN observations is skew-immune):
 *  - meaningful PTY output recency (terminal-activity.ts, windowed so idle
 *    TUI cursor-blink trickle doesn't count);
 *  - recorded user input recency;
 *  - process-tree CPU deltas from the wsl_pane_activity sweep (MADE_PANE_ID
 *    tagged /proc scan);
 *  - Claude session transcript mtime CHANGES (claude_session_activity_mtime).
 */
import { paneLastInputAt, paneLastMeaningfulOutputAt } from "./terminal-activity";
import { findAllTerminalLeaves } from "./layout-utils";
import { tabHibernateBlocker } from "../store/tabSlice";
import type { Tab, TerminalInstance } from "../types";

/** Sweep cadence the engine runs at; verdicts treat samples older than about
 *  two sweeps as unavailable. */
export const SWEEP_INTERVAL_MS = 45_000;
/** CPU ticks (10 ms units) per sweep window above which the pane's process
 *  tree counts as busy: ~1 s of CPU per 45 s (>2%). Idle node event loops sit
 *  well under this; any real work — subagents included — sits far above. */
const CPU_EPSILON_TICKS = 100;
const SIGNAL_FRESH_MS = SWEEP_INTERVAL_MS * 2 + 15_000;

const cpuPrev = new Map<string, number>();
const cpuSampleCount = new Map<string, number>();
const cpuLastBusyAt = new Map<string, number>();
const cpuLastSampleAt = new Map<string, number>();
const sessionMtimeRaw = new Map<string, number>();
const sessionLastChangeAt = new Map<string, number>();
const sessionLastCheckedAt = new Map<string, number>();

export type PaneCpuSample = { pane_id: string; cpu_ticks: number; proc_count: number };

/** Feed one sweep result. Panes that vanished from the sweep lose their
 *  history so their CPU signal reads unavailable (→ working) until re-proven. */
export function ingestCpuSweep(samples: PaneCpuSample[], now: number): void {
  const seen = new Set<string>();
  for (const s of samples) {
    seen.add(s.pane_id);
    const prev = cpuPrev.get(s.pane_id);
    cpuPrev.set(s.pane_id, s.cpu_ticks);
    cpuLastSampleAt.set(s.pane_id, now);
    cpuSampleCount.set(s.pane_id, (cpuSampleCount.get(s.pane_id) ?? 0) + 1);
    if (prev === undefined) {
      // First sighting: the delta is unknowable — treat as busy now.
      cpuLastBusyAt.set(s.pane_id, now);
      continue;
    }
    // Ticks can shrink when processes in the tree exit; a shrink means the
    // tree CHANGED, which is activity by definition.
    const delta = s.cpu_ticks >= prev ? s.cpu_ticks - prev : Number.MAX_SAFE_INTEGER;
    if (delta > CPU_EPSILON_TICKS) cpuLastBusyAt.set(s.pane_id, now);
  }
  for (const id of [...cpuPrev.keys()]) {
    if (!seen.has(id)) {
      cpuPrev.delete(id);
      cpuSampleCount.delete(id);
      cpuLastSampleAt.delete(id);
    }
  }
}

/** Feed one transcript mtime observation (raw WSL epoch ms — only ever
 *  compared against the previous observation, never against our clock). */
export function ingestSessionActivity(terminalId: string, mtimeMs: number, now: number): void {
  const prev = sessionMtimeRaw.get(terminalId);
  sessionMtimeRaw.set(terminalId, mtimeMs);
  sessionLastCheckedAt.set(terminalId, now);
  if (prev === undefined || prev !== mtimeMs) sessionLastChangeAt.set(terminalId, now);
}

/** The transcript could not be read this round — its signal must go stale. */
export function dropSessionActivity(terminalId: string): void {
  sessionLastCheckedAt.delete(terminalId);
}

export type PaneVerdict = {
  working: boolean;
  /** Human-readable, shown in the tab context menu. */
  reason: string;
};

export function paneVerdict(
  terminalId: string,
  opts: { quietMs: number; requireCpu: boolean; requireSession: boolean; now?: number },
): PaneVerdict {
  const now = opts.now ?? Date.now();

  const out = paneLastMeaningfulOutputAt(terminalId);
  if (out === undefined) return { working: true, reason: "no output history yet" };
  if (now - out < opts.quietMs) return { working: true, reason: "recent terminal output" };

  const input = paneLastInputAt(terminalId);
  if (input !== undefined && now - input < opts.quietMs)
    return { working: true, reason: "recent keystrokes" };

  if (opts.requireCpu) {
    const sampledAt = cpuLastSampleAt.get(terminalId);
    if (sampledAt === undefined || now - sampledAt > SIGNAL_FRESH_MS)
      return { working: true, reason: "CPU signal unavailable" };
    if ((cpuSampleCount.get(terminalId) ?? 0) < 2)
      return { working: true, reason: "waiting for a second CPU sample" };
    const busyAt = cpuLastBusyAt.get(terminalId);
    if (busyAt !== undefined && now - busyAt < opts.quietMs)
      return { working: true, reason: "process tree using CPU" };
  }

  if (opts.requireSession) {
    const checkedAt = sessionLastCheckedAt.get(terminalId);
    if (checkedAt === undefined || now - checkedAt > SIGNAL_FRESH_MS)
      return { working: true, reason: "session transcript unreadable" };
    const changedAt = sessionLastChangeAt.get(terminalId);
    if (changedAt === undefined || now - changedAt < opts.quietMs)
      return { working: true, reason: "session transcript recently written" };
  }

  return { working: false, reason: "quiet on all signals" };
}

export type TabVerdict = {
  /** False when the tab is structurally exempt (system/remote/devserver/…). */
  eligible: boolean;
  working: boolean;
  /** Blocker text, the busiest pane's reason, or the all-quiet summary. */
  reason: string;
};

/**
 * Aggregate gate for one tab: eligible AND every terminal pane idle.
 * `quietMs` is how long EVERY signal must have been silent.
 */
export function tabIdleVerdict(
  tab: Tab,
  terminals: Record<string, TerminalInstance>,
  quietMs: number,
  now = Date.now(),
): TabVerdict {
  const blocker = tabHibernateBlocker(tab, terminals, false);
  if (blocker) return { eligible: false, working: true, reason: blocker };
  // The CPU sweep only sees the WSL VM. Panes living elsewhere (windows
  // backend, native macOS/Linux) can't be CPU-verified, and a pane the sweep
  // can't see must not be presumed idle — so CPU is required exactly when the
  // tab's panes run in WSL, which is also the only place hibernation's auto
  // mode is offered.
  const requireCpu = tab.backend !== "windows";
  for (const leaf of findAllTerminalLeaves(tab.layout!)) {
    const type = terminals[leaf.terminalId]?.type ?? leaf.terminalType;
    const v = paneVerdict(leaf.terminalId, {
      quietMs,
      requireCpu,
      requireSession: type === "claude" && !!leaf.sessionResumeId,
      now,
    });
    if (v.working) return { eligible: true, working: true, reason: v.reason };
  }
  return { eligible: true, working: false, reason: "quiet on all signals" };
}
