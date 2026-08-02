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
  nativeTermSetPromptJump,
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
  JUMP_MAX_STEPS_NO_MARKER,
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
import { findPromptLines } from "../lib/prompt-lines";

/**
 * The SCROLLBAR is Claude Code only (user decision 2026-07-25). Everything it
 * draws is built on Claude's fullscreen conversation view: its wheel handling,
 * its Ctrl+End `scroll:bottom`, its "Jump to bottom" affordance, its sticky
 * prompt. Codex, Gemini and shell TUIs (vim, htop) also use the alternate
 * screen but have none of that, so the bar would be inert or wrong there.
 */
function scrollbarEnabledFor(type: TerminalType): boolean {
  return type === "claude";
}

/**
 * PROMPT NAVIGATION is wider than the scrollbar: any CLI that renders user
 * messages with a chevron can be walked, and the keys (Ctrl+Up/Down, PgUp/PgDn)
 * are advertised for every pane in `lib/keybindings.ts`. Kept as its own
 * predicate so extending it never turns the Claude-only scrollbar on elsewhere.
 */
function promptJumpEnabledFor(type: TerminalType): boolean {
  return type === "claude" || type === "codex" || type === "gemini";
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
  /**
   * Scroll to the previous / next prompt in MADE's OWN scrollback.
   *
   * Used whenever the pane is NOT in a walkable fullscreen TUI — a shell, or a
   * CLI rendering inline. This component owns the prompt-nav subscription (it
   * already tracks alt-screen and mouse reporting, which is what decides
   * between the two answers), so the pane hands its scrollback jumps down here
   * rather than subscribing a second time to the same event.
   */
  onScrollbackPrompt?: (dir: number) => void;
  /**
   * Filled with the TUI message-walk while one is possible, nulled otherwise.
   *
   * The PgUp/PgDn key arrives with Rust's alt-screen reading attached, but the
   * COMPOSER's PgUp/PgDn is a plain DOM keydown with no such context — and the
   * composer lives in the pane, not here. Publishing the walk lets the pane
   * route its own key the same way, so the binding does one thing whichever
   * half of the pane has focus. Null means "no walk available": scroll the
   * scrollback instead.
   */
  jumpRef?: React.MutableRefObject<((dir: number) => void) | null>;
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
  onScrollbackPrompt,
  jumpRef,
}: TuiScrollbarProps) {
  const enabled = scrollbarEnabledFor(terminalType);
  const promptJump = promptJumpEnabledFor(terminalType);
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
  // Tracked for EVERY pane, not just `enabled` ones: prompt navigation runs in
  // shell panes too (Rust claims plain PgUp/PgDn off the alternate screen), and
  // the alt-screen flag is what decides between walking a TUI and scrolling our
  // own scrollback.
  useEffect(() => {
    if (termId == null) {
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
  }, [termId, setPosition]);

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

  /**
   * The "which message am I in" marker, read off the screen.
   *
   * Claude pins a sticky copy of the current message to row 0, so that row IS
   * the marker and nothing beats it. Codex and Gemini have no such row — their
   * row 0 is ordinary transcript that changes on every notch, which would end a
   * jump after one step. For those, the marker is the topmost visible USER
   * PROMPT line instead: it survives scrolling within one message and changes
   * exactly when the jump has crossed into another.
   *
   * Returns "" when no prompt is on screen (the caller keeps scrolling toward
   * one, which is the right move) and null when the read failed.
   */
  const readSticky = useCallback(async (): Promise<string | null> => {
    if (termId == null) return null;
    try {
      if (terminalType === "claude") {
        const lines = await nativeTermGetBufferLines(termId, 0, 1);
        return (lines[0] ?? "").trim();
      }
      const vp = await nativeTermGetViewportState(termId);
      const lines = await nativeTermGetBufferLines(termId, 0, vp.rows);
      const hits = findPromptLines(lines, terminalType);
      return hits.length ? (lines[hits[0]] ?? "").trim() : "";
    } catch {
      return null;
    }
  }, [termId, terminalType]);

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
        // A pane whose screen shows no marker at all gets a SHORT walk, not the
        // full budget. Without this, a TUI that renders user messages in some
        // form this code cannot recognise would scroll its entire scrollback on
        // every keypress — the marker would never change, so the loop would run
        // to JUMP_MAX_STEPS every time. Bounded, it degrades to a page-up.
        const budget = from === "" ? JUMP_MAX_STEPS_NO_MARKER : JUMP_MAX_STEPS;
        for (let i = 0; i < budget; i++) {
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

  // Tell Rust which key sets to claim for this pane.
  //  prompt_nav  — Claude's readline translations; Claude only.
  //  prompt_jump — message navigation; every CLI with a walkable transcript,
  //                so vim / less / htop keep PgUp and Ctrl+arrow.
  useEffect(() => {
    if (termId == null) return;
    void nativeTermSetPromptNav(termId, enabled).catch(() => {});
    void nativeTermSetPromptJump(termId, promptJump).catch(() => {});
  }, [termId, enabled, promptJump]);

  // Ctrl+Up / Ctrl+Down and PgUp / PgDn, claimed by Rust and routed here.
  //
  // ONE subscription decides between the two ways to answer "previous prompt",
  // because the state that decides — is a fullscreen program on the screen, and
  // is it taking mouse input — lives here. Walk the TUI when it is; otherwise
  // hand it to the pane, which scrolls MADE's own scrollback to a prompt line.
  // Subscribed for EVERY pane, not just `promptJump` ones. Rust claims plain
  // PgUp/PgDn off the alternate screen in any pane — a shell included, which is
  // exactly where the scrollback jump is most useful — so a pane without a
  // listener would swallow the key instead of doing something with it. What
  // `promptJump` gates is narrower: whether Rust claims those keys while a
  // fullscreen program owns the screen.
  const promptJumpRef = useRef(false);
  promptJumpRef.current = promptJump;
  const onScrollbackPromptRef = useRef(onScrollbackPrompt);
  onScrollbackPromptRef.current = onScrollbackPrompt;

  // Publish the walk for the pane's own PgUp/PgDn (the composer's). Mouse
  // reporting is part of the test here, unlike the key path: `nativeTermTuiScroll`
  // sends nothing without it, so a walk would silently do nothing where the
  // scrollback jump at least tries.
  useEffect(() => {
    if (!jumpRef) return;
    jumpRef.current = promptJump && altScreen && mouseReporting ? jumpMessage : null;
    return () => {
      jumpRef.current = null;
    };
  }, [jumpRef, promptJump, altScreen, mouseReporting, jumpMessage]);
  useEffect(() => {
    if (termId == null) return;
    let un: (() => void) | undefined;
    let disposed = false;
    subscribeTuiPromptNav(termId, (e) => {
      // `e.altScreen` is Rust's reading at keypress, not our transition mirror.
      // The walk additionally needs a CLI we know how to walk — a plain
      // alt-screen program has no prompts to find, and driving its scroller
      // would just be an unrequested page-up.
      if (e.altScreen && promptJumpRef.current) void jumpMessage(e.dir);
      else if (!e.altScreen) onScrollbackPromptRef.current?.(e.dir);
    }).then((u) => {
      if (disposed) u();
      else un = u;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, [termId, jumpMessage]);

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
