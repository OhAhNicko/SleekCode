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

import type { TerminalType } from "../types";

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
/**
 * Budget when the screen shows no prompt marker to aim at — a TUI whose user
 * messages this code cannot recognise. The marker can then never change, so the
 * full budget would scroll the whole scrollback on every keypress. Three steps
 * degrade the jump to roughly a page, which is a defensible answer to "previous
 * prompt" when there is no prompt to find.
 */
export const JUMP_MAX_STEPS_NO_MARKER = 3;
/** Let the TUI repaint between steps before re-reading the row. */
export const JUMP_SETTLE_MS = 24;

/**
 * Jump-to-bottom for a CLI with no absolute "scroll to bottom" command: scroll
 * down in bursts until the screen stops changing. Coarse, because this is a
 * "get me all the way back" action, and capped so a pane that repaints on its
 * own (a CLI mid-response) cannot make it loop.
 */
export const JUMP_BOTTOM_NOTCHES = 12;
export const JUMP_BOTTOM_MAX_ROUNDS = 40;

/**
 * Jump-to-bottom button, both renderers. The button rides 6px BELOW the thumb
 * (ported from the normal-buffer xterm button, TerminalPaneXterm updateJumpBtn)
 * and is clamped so it never leaves the pane. It hides while the position is
 * moving and reappears once the bar has been still for the idle delay — a
 * button chasing a moving thumb is unclickable noise.
 */
export const JUMP_BTN_GAP_PX = 6;
export const JUMP_BTN_BOTTOM_CLAMP_PX = 28;
export const JUMP_BTN_IDLE_MS = 250;

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

// ── Per-CLI capabilities ──────────────────────────────────────────────────
//
// The bar was Claude-only because three of the four things it does were sourced
// from Claude's UI: its Ctrl+End `scroll:bottom` binding, its "Jump to bottom"
// affordance, and its sticky prompt row. Screenshots of Codex and Gemini
// scrolled up (2026-08-03) confirmed neither renders ANY of them — row 0 is
// ordinary transcript, and nothing marks "you are scrolled up".
//
// So the capabilities become nullable rather than assumed, and each null has a
// CLI-agnostic fallback. The one that makes the bar worth drawing at all is the
// bottom anchor: `sampleAnchors` already proves the TOP by scrolling up and
// finding the screen byte-identical, and the same trick proves the bottom. Both
// ends of travel are then exact and only the middle is interpolated.
//
// Lives here, not in the component, because XtermTuiScrollbar.tsx carries a
// parallel copy of the same anchor logic — this file exists so the two cannot
// drift.

/** What a given CLI can tell us about its own scroll position. */
export interface TuiScrollProfile {
  /** Absolute scroll-to-bottom bytes, or null → scroll down until settled. */
  toBottom: string | null;
  /** Lowercased text whose ABSENCE proves we are at the bottom, or null →
   *  prove it by scrolling down and finding the screen unchanged. */
  atBottomMarker: string | null;
  /** Exact-position source, or null → dead reckoning between the anchors. */
  position: "sticky-prompt" | null;
  /** Draw the bar for this pane type at all. */
  scrollbar: boolean;
}

/**
 * Claude's entry reproduces the constants the component used to reference
 * directly, so enabling the bar elsewhere cannot change Claude's behaviour.
 */
export function tuiScrollProfile(type: TerminalType): TuiScrollProfile {
  switch (type) {
    case "claude":
      return {
        toBottom: CTRL_END,
        atBottomMarker: AT_BOTTOM_MARKER,
        position: "sticky-prompt",
        scrollbar: true,
      };
    case "codex":
    case "gemini":
      return { toBottom: null, atBottomMarker: null, position: null, scrollbar: true };
    default:
      // Shell TUIs (vim, htop, less) occupy the alternate screen too, but they
      // are not conversations — there is nothing to navigate and no anchor to
      // read, so the bar would be inert.
      return { toBottom: null, atBottomMarker: null, position: null, scrollbar: false };
  }
}

/**
 * Are we at the bottom of the TUI's own scrollback?
 *
 * Two proofs, and which one applies is the CLI's capability, not a preference:
 *
 *  - `marker` present — Claude paints a "Jump to bottom" affordance while
 *    scrolled up, so its ABSENCE is the proof. One screen read, no scrolling.
 *  - `marker` null — push DOWN and see whether anything moved. An unchanged
 *    screen after a downward scroll is the bottom, exactly mirroring the
 *    existing top anchor ("pushed up, nothing moved → that is the top").
 *
 * The `lastDir < 0` requirement is what keeps the fallback honest: a screen
 * that happens to be unchanged for any other reason — an idle pane, a repaint
 * that landed identically — cannot be mistaken for the bottom unless the user
 * was actually travelling toward it.
 */
export function isAtBottom(args: {
  marker: string | null;
  screen: string;
  unchanged: boolean;
  lastDir: number;
}): boolean {
  const { marker, screen, unchanged, lastDir } = args;
  if (marker) return !screen.toLowerCase().includes(marker);
  return unchanged && lastDir < 0;
}
