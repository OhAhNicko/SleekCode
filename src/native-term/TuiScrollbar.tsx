/**
 * TuiScrollbar — scrollbar for a NATIVE pane running a fullscreen TUI
 * (alternate screen), where MADE's own scrollback is empty by definition.
 *
 * Claude Code's fullscreen TUI keeps its OWN scrollback and scrolls it on the
 * mouse wheel (hardware-verified 2026-07-25). MADE therefore renders no
 * history here — it DRIVES Claude's scroller with the exact bytes a physical
 * wheel produces (win32.rs `send_wheel_notches`) and draws a bar reflecting
 * how far it has driven it. Page keys were tried first and rejected: they move
 * a whole screen per press and read as "skippy".
 *
 * Three things make this harder than a normal scrollbar, all learned on
 * hardware:
 *
 * 1. POSITION IS DEAD-RECKONED. The TUI never reports its scroll position, so
 *    the thumb is our own count of notches sent up minus notches sent back
 *    down. It counts BOTH sources — drags here, and the user's own wheel (Rust
 *    emits `tui_scroll` when it forwards a real wheel event).
 *
 * 2. THE COUNT MUST BE SYNCHRONOUS. It lives in a ref, not just state. A drag
 *    fires pointermoves far faster than React re-renders; when the delta was
 *    computed from a stale render value, every move re-sent the WHOLE distance
 *    and the content flew (round-2 bug).
 *
 * 3. THE DRAG IS RELATIVE, NOT ABSOLUTE. Pointer MOVEMENT maps to notches
 *    (overlay side), rather than seeking to a fraction of the track. Because
 *    the TUI never reports its scrollback length, an absolute position is a
 *    coordinate system we would be inventing — and seeking to it forced MADE
 *    to invent a scroll RATE too, which is what made earlier versions feel
 *    "insanely fast". Relative dragging hands the rate back to the user's
 *    hand, exactly as on a physical wheel. It also means Claude's own wheel
 *    acceleration (`wheelScrollAccelerationEnabled`) responds to a fast drag
 *    the same way it responds to a fast flick of the real wheel.
 *
 * Jump-to-bottom sends Ctrl+End, Claude's own `scroll:bottom` binding. That is
 * ABSOLUTE, so it cannot drift the way undoing our own notch count would — and
 * it re-zeroes the estimate as a side effect.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  nativeTermGetBufferLines,
  nativeTermGetViewportState,
  nativeTermTuiScroll,
  nativeTermSetPromptNav,
  subscribeAltScreen,
  subscribeTuiScroll,
  subscribeTuiPromptNav,
  type NativeTermId,
} from "../lib/native-term-bridge";
import { readSessionPrompts } from "../lib/sessions-index";
import { useAppStore } from "../store";
import {
  ANCHOR_SETTLE_MS,
  AT_BOTTOM_MARKER,
  CTRL_END,
  JUMP_MAX_STEPS,
  JUMP_SETTLE_MS,
  JUMP_STEP_NOTCHES,
  NOTCHES_PER_PAGE,
  PAGE_DOWN,
  PAGE_UP,
  computeSpan,
  matchPromptIndex,
} from "./tui-scroll-model";
import type { TerminalBackend, TerminalType } from "../types";
import { useOverlayPopupAnchor } from "./useOverlayPopupAnchor";

/**
 * Claude Code ONLY (user decision 2026-07-25). Everything here is built on
 * Claude's fullscreen conversation view: its wheel handling, its Ctrl+End
 * `scroll:bottom`, its "Jump to bottom" affordance, its sticky prompt. Codex,
 * Gemini and shell TUIs (vim, htop) also use the alternate screen but have
 * none of that, so the bar would be inert or wrong there.
 */
function scrollbarEnabledFor(type: TerminalType): boolean {
  return type === "claude";
}

interface TuiScrollbarProps {
  termId: NativeTermId | null;
  terminalType: TerminalType;
  /** Session whose transcript backs the exact-position match. */
  sessionId?: string;
  workingDir?: string;
  backend?: TerminalBackend;
  paneRef: React.RefObject<HTMLDivElement | null>;
  /** Pane's PTY writer — Ctrl+End and the page-key fallback. */
  write: (data: string) => void;
  /** Bumped by the pane whenever a prompt is submitted — lands at the bottom. */
  submitNonce?: number;
}

export default function TuiScrollbar({
  termId,
  terminalType,
  sessionId,
  workingDir,
  backend,
  paneRef,
  write,
  submitNonce,
}: TuiScrollbarProps) {
  const enabled = scrollbarEnabledFor(terminalType);
  // The overlay is a SEPARATE webview with no store access, so this rides
  // along in the popup payload.
  const accelEnabled = useAppStore((st) => st.scrollThumbAcceleration);
  // Both must hold: alternate screen AND the TUI wants mouse input.
  const [altScreen, setAltScreen] = useState(false);
  const [mouseReporting, setMouseReporting] = useState(false);
  // `pos` renders the thumb; `posRef` is authoritative and updates
  // synchronously so back-to-back pointermoves compute honest deltas.
  const [pos, setPos] = useState(0);
  const posRef = useRef(0);
  // Total scrollback in notches, PROVEN by the top anchor. null = still
  // unknown, so the span is extrapolated instead (see MIN_SPAN_NOTCHES).
  const [knownSpan, setKnownSpan] = useState<number | null>(null);
  const knownSpanRef = useRef<number | null>(null);
  knownSpanRef.current = knownSpan;
  const writeRef = useRef(write);
  writeRef.current = write;

  const setPosition = useCallback((n: number) => {
    const clamped = Math.max(0, n);
    posRef.current = clamped;
    setPos(clamped);
    // Travelling past a previously-proven top means the buffer grew (or the
    // estimate drifted high) — let the span follow rather than clamping the
    // thumb at the top.
    setKnownSpan((k) => (k !== null && clamped > k ? clamped : k));
  }, []);

  /**
   * Exact position, from the conversation itself.
   *
   * Notch counting can never be exact: Claude accelerates the wheel, so one
   * notch is not a fixed number of lines. But Claude renders a STICKY PROMPT
   * naming the message you are inside, and the session JSONL lists every user
   * message — so matching one against the other gives "message 7 of 20", which
   * acceleration cannot perturb.
   *
   * The match CALIBRATES the existing notch position rather than replacing it
   * (pos = frac * span), so dragging keeps working in one coordinate system and
   * the thumb is exact at every sample, drifting only between them.
   */
  const promptsRef = useRef<string[]>([]);

  useEffect(() => {
    if (!sessionId || !workingDir || !altScreen) {
      promptsRef.current = [];
      return;
    }
    let cancelled = false;
    const load = async () => {
      const list = await readSessionPrompts(workingDir, sessionId, backend ?? "wsl");
      if (!cancelled) promptsRef.current = list;
    };
    void load();
    // The conversation grows; refresh periodically so newly-sent prompts count.
    const id = setInterval(load, 20000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sessionId, workingDir, backend, altScreen]);

  // ── Ground-truth anchors ────────────────────────────────────────────────
  // Dead reckoning counts notches SENT, not lines actually scrolled, so it
  // drifts — worst at the limits, where surplus notches are absorbed entirely.
  // Sample the real screen once scrolling settles and snap the estimate to
  // truth at whichever end we can prove:
  //   bottom — Claude's "Jump to bottom" affordance is gone  -> pos = 0
  //   top    — scrolling up left the screen byte-identical   -> span = pos
  // Between anchors the estimate stays smooth and interpolated.
  const lastScreenRef = useRef<string | null>(null);
  const sampleTimerRef = useRef(0);
  const lastDirRef = useRef(0);

  const sampleAnchors = useCallback(async () => {
    if (termId == null) return;
    try {
      const vp = await nativeTermGetViewportState(termId);
      const lines = await nativeTermGetBufferLines(termId, 0, Math.max(1, vp.rows));
      const screen = lines.join("\n");
      const atBottomNow = !screen.toLowerCase().includes(AT_BOTTOM_MARKER);
      const unchanged = lastScreenRef.current === screen;
      lastScreenRef.current = screen;

      if (atBottomNow) {
        // Exact: nothing above us to jump back down to.
        posRef.current = 0;
        setPos(0);
        return;
      }
      // EXACT position from the conversation, when the sticky prompt is
      // recognisable. Calibrates the notch estimate instead of replacing it.
      const stickyIdx = matchPromptIndex(lines[0] ?? "", promptsRef.current);
      const total = promptsRef.current.length;
      if (stickyIdx >= 0 && total > 1) {
        // stickyIdx 0 = oldest message = top of the scrollback.
        const frac = (total - 1 - stickyIdx) / (total - 1);
        const spanNow = computeSpan(posRef.current, knownSpanRef.current);
        const calibrated = Math.round(frac * spanNow);
        posRef.current = calibrated;
        setPos(calibrated);
        return;
      }

      if (unchanged && lastDirRef.current > 0) {
        // We pushed upward and nothing moved — this is the true top, so the
        // distance travelled IS the total scrollback. Now the thumb can
        // legitimately reach the top.
        setKnownSpan(Math.max(1, posRef.current));
      }
    } catch {
      // Pane went away mid-read, or the command failed — anchors are an
      // optimisation, never a correctness requirement.
    }
  }, [termId]);

  const scheduleAnchorSample = useCallback(
    (dir: number) => {
      lastDirRef.current = dir;
      if (sampleTimerRef.current) clearTimeout(sampleTimerRef.current);
      sampleTimerRef.current = window.setTimeout(() => {
        sampleTimerRef.current = 0;
        void sampleAnchors();
      }, ANCHOR_SETTLE_MS);
    },
    [sampleAnchors],
  );

  useEffect(
    () => () => {
      if (sampleTimerRef.current) clearTimeout(sampleTimerRef.current);
    },
    [],
  );

  // Mirror the Rust alt-screen edge (emitted on transition only).
  useEffect(() => {
    if (termId == null || !enabled) {
      setAltScreen(false);
      return;
    }
    let un: (() => void) | undefined;
    let disposed = false;
    subscribeAltScreen(termId, (e) => {
      setAltScreen(e.active);
      setMouseReporting(e.mouseReporting);
      if (!e.active) {
        // The normal buffer has a REAL scrollbar; our estimate means nothing,
        // and a different program will have a different scrollback.
        setPosition(0);
        setKnownSpan(null);
      }
    }).then((u) => {
      if (disposed) u();
      else un = u;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, [termId, enabled, setPosition]);

  // Track the user's OWN wheel scrolling so the thumb follows it. Rust emits
  // this only for real WM_MOUSEWHEEL forwards — never for the notches we
  // synthesize below — so there is no double-counting.
  useEffect(() => {
    if (termId == null || !enabled) return;
    let un: (() => void) | undefined;
    let disposed = false;
    subscribeTuiScroll(termId, (e) => {
      setPosition(posRef.current + e.notches);
      scheduleAnchorSample(e.notches);
    }).then((u) => {
      if (disposed) u();
      else un = u;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, [termId, enabled, setPosition]);

  // A submitted prompt lands the TUI at the bottom.
  useEffect(() => {
    if (submitNonce === undefined) return;
    setPosition(0);
  }, [submitNonce, setPosition]);

  /**
   * Scroll by `n` notches right now (positive = up/older). Sent unbuffered so
   * the drag stays in lockstep with the pointer. The estimate is advanced
   * OPTIMISTICALLY because the command path is not echoed back as
   * `tui_scroll` — only real wheel events are, so there is no double count.
   */
  const scrollBy = useCallback(
    (n: number) => {
      if (n === 0 || termId == null) return;
      setPosition(posRef.current + n);
      scheduleAnchorSample(n);
      nativeTermTuiScroll(termId, n)
        .then((sent) => {
          if (sent) return;
          // No mouse reporting — fall back to page keys.
          const pages = Math.max(1, Math.round(Math.abs(n) / NOTCHES_PER_PAGE));
          writeRef.current((n > 0 ? PAGE_UP : PAGE_DOWN).repeat(pages));
        })
        .catch(() => {});
    },
    [termId, setPosition],
  );

  /** Read Claude's sticky prompt row (the pinned message header at the top). */
  const readSticky = useCallback(async (): Promise<string | null> => {
    if (termId == null) return null;
    try {
      const lines = await nativeTermGetBufferLines(termId, 0, 1);
      return (lines[0] ?? "").trim();
    } catch {
      return null;
    }
  }, [termId]);

  const jumpingRef = useRef(false);

  /**
   * Jump one message: scroll in `dir` (+1 = older) until the sticky prompt row
   * changes. Heuristic by necessity — alt-screen has no OSC 133 markers to
   * index the way the xterm pane does, so the rendered header IS the marker.
   */
  const jumpMessage = useCallback(
    async (dir: number) => {
      if (termId == null || jumpingRef.current) return;
      jumpingRef.current = true;
      try {
        const from = await readSticky();
        for (let i = 0; i < JUMP_MAX_STEPS; i++) {
          const step = dir > 0 ? JUMP_STEP_NOTCHES : -JUMP_STEP_NOTCHES;
          const sent = await nativeTermTuiScroll(termId, step);
          if (!sent) break; // no mouse reporting — nothing to drive
          setPosition(posRef.current + step);
          await new Promise((r) => setTimeout(r, JUMP_SETTLE_MS));
          const now = await readSticky();
          // null = read failed; stop rather than spin.
          if (now === null) break;
          if (now !== from) break; // crossed into another message
        }
      } finally {
        jumpingRef.current = false;
        scheduleAnchorSample(dir);
      }
    },
    [termId, readSticky, setPosition, scheduleAnchorSample],
  );

  // Tell Rust whether to claim Ctrl+Up/Down for this pane. Off for every pane
  // type without a sticky-prompt UI, so the keys still reach those TUIs.
  useEffect(() => {
    if (termId == null) return;
    void nativeTermSetPromptNav(termId, enabled).catch(() => {});
  }, [termId, enabled]);

  // Ctrl+Up / Ctrl+Down, claimed by Rust and routed here.
  useEffect(() => {
    if (termId == null || !enabled) return;
    let un: (() => void) | undefined;
    let disposed = false;
    subscribeTuiPromptNav(termId, (e) => {
      void jumpMessage(e.dir);
    }).then((u) => {
      if (disposed) u();
      else un = u;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, [termId, enabled, jumpMessage]);

  // Gate on mouse reporting as well as alt-screen. Claude's own docs call its
  // scroll settings "fullscreen mode only", and driving its scroller requires
  // wheel events — so a Claude pane that is NOT taking mouse input is not in
  // the fullscreen conversation view and must not show this bar.
  const open = enabled && altScreen && mouseReporting && termId != null;
  const span = computeSpan(pos, knownSpan);

  useOverlayPopupAnchor({
    id: `tui-scrollbar-${termId}`,
    kind: "tui-scrollbar",
    open,
    anchorRef: paneRef,
    payload: open ? { pos, span, accel: accelEnabled } : null,
    onAction: (action, data) => {
      switch (action) {
        case "toBottom":
          // Claude's own scroll:bottom — absolute, so no drift.
          writeRef.current(CTRL_END);
          setPosition(0);
          break;
        case "scrollBy": {
          const n = (data as { notches?: number } | undefined)?.notches;
          if (typeof n === "number") scrollBy(n);
          break;
        }
      }
    },
  });

  return null;
}
