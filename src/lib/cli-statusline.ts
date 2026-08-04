/**
 * Read a CLI's context percentage from the statusline it already renders.
 *
 * MADE's other route reconstructs this from the session transcript: locate the
 * rollout, find the last token-usage event, divide. That is three chances to
 * disagree with the CLI, and it did — a pane whose session could not be
 * resolved fell back to a `__latest__` read that reports zero tokens used and
 * therefore a confident, wrong "100%".
 *
 * Codex prints the answer at the bottom of its own pane:
 *
 *     gpt-5.6-sol max · Context 32% left · /mnt/c/… · main · Context 68% used · weekly 37% left
 *
 * That line is in the terminal buffer. Reading it cannot drift from what the
 * CLI believes, because it IS what the CLI believes.
 *
 * Deliberately narrow: it answers only "percent of context left". Everything
 * else in the header — model, cost, rate limits, session name — still comes
 * from the transcript, which is the only place those exist.
 */

/** A percentage parsed off a statusline, 0–100. */
export interface StatuslineContext {
  /** Percent of the context window still available. */
  percentLeft: number;
  /** The line it came from, for debugging a bad parse. */
  source: string;
}

/**
 * Both spellings Codex uses, in priority order. "left" is taken directly;
 * "used" is inverted. Anchored to the word so a percentage elsewhere on the
 * line — `weekly 37% left`, a rate limit — cannot be mistaken for context.
 */
const PATTERNS: { re: RegExp; invert: boolean }[] = [
  { re: /context\s+(\d{1,3}(?:\.\d+)?)\s*%\s*left/i, invert: false },
  { re: /context\s+(\d{1,3}(?:\.\d+)?)\s*%\s*used/i, invert: true },
  // Codex also renders the reversed word order in some builds.
  { re: /(\d{1,3}(?:\.\d+)?)\s*%\s*context\s+left/i, invert: false },
];

/** Parse one line. Null when it carries no context reading. */
export function parseStatuslineContext(line: string): StatuslineContext | null {
  for (const { re, invert } of PATTERNS) {
    const m = line.match(re);
    if (!m) continue;
    const n = parseFloat(m[1]);
    if (!isFinite(n) || n < 0 || n > 100) continue;
    return { percentLeft: invert ? 100 - n : n, source: line.trim() };
  }
  return null;
}

/**
 * Scan the last `depth` rendered rows for a context reading, bottom-up.
 *
 * Bottom-up because the statusline is the last thing drawn, and because a
 * TRANSCRIPT can contain the same words — a user asking "why is context 50%
 * used?" would match higher up the screen. A few rows of depth covers a
 * statusline that wrapped or sits above a composer, without reaching into the
 * conversation.
 */
export const STATUSLINE_SCAN_ROWS = 4;

export function findStatuslineContext(
  screenLines: string[],
  depth = STATUSLINE_SCAN_ROWS,
): StatuslineContext | null {
  const start = Math.max(0, screenLines.length - depth);
  for (let i = screenLines.length - 1; i >= start; i--) {
    const hit = parseStatuslineContext(screenLines[i] ?? "");
    if (hit) return hit;
  }
  return null;
}
