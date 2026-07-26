/**
 * Shared model for the fullscreen-TUI scrollbar, used by BOTH renderers.
 *
 * The native pane draws its bar in the overlay webview (it sits over an HWND);
 * the xterm pane draws in plain DOM. Those render targets cannot be shared, but
 * the behaviour must be identical — so every constant and every bit of maths
 * lives here rather than being copied twice. Duplicated logic in this codebase
 * has already caused one silent bug (the WSL project-dir resolution existed in
 * two places, so the case-insensitive fix reached only one of them).
 *
 * The model in one line: a TUI's own scrollback cannot be read, so MADE drives
 * it with the bytes a real wheel produces and keeps a dead-reckoned position,
 * corrected against ground truth wherever the screen provides it.
 */

/** Ctrl+End — Claude's own `scroll:bottom` binding. Absolute, so unlike undoing
 * our own notch count it cannot drift. Same bytes a physical Ctrl+End produces
 * (VK_END is cursor_key('F'); ctrl gives modifier param 5). */
export const CTRL_END = "\x1b[1;5F";

/** Page keys — fallback only, for a TUI that scrolls but never enabled mouse
 * reporting. */
export const PAGE_UP = "\x1b[5~";
export const PAGE_DOWN = "\x1b[6~";

/** Notches assumed per page key, to keep the estimate honest in that fallback. */
export const NOTCHES_PER_PAGE = 10;

/** Floor for the scrollbar span, so a fresh pane has a sane, non-twitchy ratio
 * before anything is known about the scrollback. */
export const MIN_SPAN_NOTCHES = 30;

/**
 * Assumed remaining scrollback ABOVE the current position while the top is
 * unproven. The span is `pos + this`, so `frac = pos / (pos + HEADROOM)` rises
 * monotonically and approaches — never reaches — the top.
 *
 * It MUST be additive. Two earlier versions made it proportional and both were
 * degenerate: `span = pos` pinned the thumb to the top, and `span = pos * 1.5`
 * froze it two-thirds up, because any `pos * k` cancels position out entirely.
 */
export const UNKNOWN_HEADROOM_NOTCHES = 40;

/**
 * Ground-truth anchor. Claude paints its scroll state into the screen: while
 * scrolled up, the transcript shows a "Jump to bottom" affordance. Its ABSENCE
 * means we are at the bottom — an exact anchor, so the dead-reckoned estimate
 * gets corrected instead of drifting forever. Matched case-insensitively; if
 * Claude reworded it the check simply stops firing and we fall back to pure
 * dead reckoning. It degrades, it does not break.
 */
export const AT_BOTTOM_MARKER = "jump to bottom";

/** Idle delay before sampling the screen — long enough for a burst of notches
 * to have landed and repainted, short enough to feel instant. */
export const ANCHOR_SETTLE_MS = 150;

/**
 * Message-jump tuning (Ctrl+Up / Ctrl+Down). The TUI has no "scroll to previous
 * message" command, so the jump scrolls until Claude's STICKY PROMPT row — the
 * pinned, greyed copy of the message you are inside — changes. Coarse steps,
 * since a long message can span several screens; capped so a jump can never
 * run away.
 */
export const JUMP_STEP_NOTCHES = 4;
export const JUMP_MAX_STEPS = 60;
/** Let the TUI repaint between steps before re-reading the row. */
export const JUMP_SETTLE_MS = 24;

/** Span the thumb maps across: the proven total when known, else extrapolated. */
export function computeSpan(pos: number, knownSpan: number | null): number {
  return knownSpan !== null
    ? Math.max(MIN_SPAN_NOTCHES, knownSpan)
    : Math.max(MIN_SPAN_NOTCHES, pos + UNKNOWN_HEADROOM_NOTCHES);
}

/** Reduce a line to comparable form: lowercase alphanumerics only. Strips the
 * sticky row's leading glyph/indent and any box-drawing, so a truncated header
 * still prefix-matches its full prompt. */
export function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Which prompt is the sticky row showing? Returns -1 when unknown.
 *
 * The sticky row is truncated to the pane width, so this is a PREFIX match. A
 * short prefix is ambiguous across prompts that open the same way, so anything
 * under MIN_MATCH_CHARS is refused rather than guessed — a wrong match would
 * jump the thumb somewhere false, which is worse than staying on dead
 * reckoning. When several prompts share the prefix the LAST is taken: repeated
 * prompts are usually follow-ups, and the later one is the likelier read.
 */
export function matchPromptIndex(sticky: string, prompts: string[]): number {
  const MIN_MATCH_CHARS = 12;
  const key = normalizeForMatch(sticky);
  if (key.length < MIN_MATCH_CHARS || prompts.length === 0) return -1;
  let found = -1;
  for (let i = 0; i < prompts.length; i++) {
    if (normalizeForMatch(prompts[i]).startsWith(key)) found = i;
  }
  return found;
}

/**
 * SGR mouse-report bytes for `n` wheel notches (positive = up/older) at a cell.
 *
 * This is what makes dragging feel like scrolling: they are the same bytes a
 * physical wheel produces, so the TUI cannot tell them apart. Button 64 = up,
 * 65 = down; wheel events use `M` (press) in SGR.
 *
 * Aim at the pane CENTRE — a TUI can route the wheel by region (Claude draws a
 * transcript above a fixed composer), and the centre is reliably inside the
 * scrollable area, unlike (1,1) which may sit in chrome that ignores it.
 */
export function encodeSgrWheel(notches: number, col: number, row: number): string {
  if (notches === 0) return "";
  const btn = notches > 0 ? 64 : 65;
  const x = Math.max(1, Math.round(col));
  const y = Math.max(1, Math.round(row));
  return `\x1b[<${btn};${x};${y}M`.repeat(Math.abs(notches));
}
