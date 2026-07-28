/**
 * XtermTuiScrollbar — the fullscreen-TUI scrollbar for XTERM panes.
 *
 * Same model as the native pane's bar (everything shared lives in
 * `tui-scroll-model.ts`); only the plumbing differs:
 *
 *   native pane          xterm pane
 *   ───────────          ──────────
 *   drawn in the         drawn in plain DOM — an xterm pane is DOM, so no
 *   overlay webview      overlay is needed and no region has to be claimed
 *   (it sits over an
 *   HWND)
 *
 *   Rust scanner emits   xterm.js exposes the state directly:
 *   alt_screen +         `buffer.active.type === "alternate"` and
 *   mouseReporting       `modes.mouseTrackingMode`
 *
 *   screen read via      `buffer.active.getLine(i).translateToString()`
 *   get_buffer_lines
 *
 * Because it is DOM, this version has no hit-strip problem: it cannot steal
 * clicks from a native surface, so the track is simply a normal element.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import { readSessionPrompts } from "../lib/sessions-index";
import {
  ANCHOR_SETTLE_MS,
  AT_BOTTOM_MARKER,
  CTRL_END,
  JUMP_BTN_BOTTOM_CLAMP_PX,
  JUMP_BTN_GAP_PX,
  JUMP_BTN_IDLE_MS,
  computeSpan,
  encodeSgrWheel,
  matchPromptIndex,
} from "../native-term/tui-scroll-model";
import type { TerminalBackend, TerminalType } from "../types";

interface XtermTuiScrollbarProps {
  terminal: Terminal | null;
  terminalType: TerminalType;
  /** Writes straight to the PTY. */
  write: (data: string) => void;
  sessionId?: string;
  workingDir?: string;
  backend?: TerminalBackend;
  /** Bumped on prompt submit — a submitted prompt lands at the bottom. */
  submitNonce?: number;
}

/** Claude only, exactly as on the native side: the whole design rests on
 * Claude's fullscreen view (its wheel handling, Ctrl+End, "Jump to bottom",
 * its sticky prompt). Other alt-screen programs have none of that. */
function enabledFor(type: TerminalType): boolean {
  return type === "claude";
}

export default function XtermTuiScrollbar({
  terminal,
  terminalType,
  write,
  sessionId,
  workingDir,
  backend,
  submitNonce,
}: XtermTuiScrollbarProps) {
  const enabled = enabledFor(terminalType);
  const [active, setActive] = useState(false);
  const [pos, setPos] = useState(0);
  const [knownSpan, setKnownSpan] = useState<number | null>(null);
  const posRef = useRef(0);
  const knownSpanRef = useRef<number | null>(null);
  knownSpanRef.current = knownSpan;
  const promptsRef = useRef<string[]>([]);
  const writeRef = useRef(write);
  writeRef.current = write;

  const setPosition = useCallback((n: number) => {
    const clamped = Math.max(0, n);
    posRef.current = clamped;
    setPos(clamped);
    setKnownSpan((k) => (k !== null && clamped > k ? clamped : k));
  }, []);

  // Alt-screen + mouse-reporting gate. xterm.js has no event for mode changes,
  // so this polls — cheap (two property reads) and it only has to notice a
  // transition, not a keystroke.
  useEffect(() => {
    if (!terminal || !enabled) {
      setActive(false);
      return;
    }
    const check = () => {
      const on =
        terminal.buffer.active.type === "alternate" &&
        terminal.modes.mouseTrackingMode !== "none";
      setActive((was) => {
        if (was && !on) {
          // Left fullscreen: the normal buffer has a REAL scrollbar and our
          // estimate means nothing there.
          posRef.current = 0;
          setPos(0);
          setKnownSpan(null);
        }
        return on;
      });
    };
    check();
    const id = setInterval(check, 500);
    return () => clearInterval(id);
  }, [terminal, enabled]);

  // Session transcript, for the exact-position match.
  useEffect(() => {
    if (!sessionId || !workingDir || !active) {
      promptsRef.current = [];
      return;
    }
    let cancelled = false;
    const load = async () => {
      const list = await readSessionPrompts(workingDir, sessionId, backend ?? "wsl");
      if (!cancelled) promptsRef.current = list;
    };
    void load();
    const id = setInterval(load, 20000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sessionId, workingDir, backend, active]);

  useEffect(() => {
    if (submitNonce === undefined) return;
    posRef.current = 0;
    setPos(0);
  }, [submitNonce]);

  /** Send `n` wheel notches, aimed at the pane centre. */
  const scrollBy = useCallback(
    (n: number) => {
      if (!terminal || n === 0) return;
      const col = Math.max(1, Math.floor(terminal.cols / 2));
      const row = Math.max(1, Math.floor(terminal.rows / 2));
      writeRef.current(encodeSgrWheel(n, col, row));
      setPosition(posRef.current + n);
      scheduleSample(n);
    },
    // scheduleSample is stable (defined below via ref indirection).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [terminal, setPosition],
  );

  // ── Ground-truth anchors, same precedence as the native bar ──────────────
  const lastScreenRef = useRef<string | null>(null);
  const lastDirRef = useRef(0);
  const sampleTimer = useRef(0);

  const sampleAnchors = useCallback(() => {
    if (!terminal) return;
    const buf = terminal.buffer.active;
    const rows: string[] = [];
    for (let i = 0; i < terminal.rows; i++) {
      rows.push(buf.getLine(buf.viewportY + i)?.translateToString(true) ?? "");
    }
    const screen = rows.join("\n");
    const atBottom = !screen.toLowerCase().includes(AT_BOTTOM_MARKER);
    const unchanged = lastScreenRef.current === screen;
    lastScreenRef.current = screen;

    if (atBottom) {
      posRef.current = 0;
      setPos(0);
      return;
    }
    const idx = matchPromptIndex(rows[0] ?? "", promptsRef.current);
    const total = promptsRef.current.length;
    if (idx >= 0 && total > 1) {
      const frac = (total - 1 - idx) / (total - 1);
      const calibrated = Math.round(frac * computeSpan(posRef.current, knownSpanRef.current));
      posRef.current = calibrated;
      setPos(calibrated);
      return;
    }
    if (unchanged && lastDirRef.current > 0) {
      setKnownSpan(Math.max(1, posRef.current));
    }
  }, [terminal]);

  const sampleRef = useRef(sampleAnchors);
  sampleRef.current = sampleAnchors;
  function scheduleSample(dir: number) {
    lastDirRef.current = dir;
    if (sampleTimer.current) clearTimeout(sampleTimer.current);
    sampleTimer.current = window.setTimeout(() => {
      sampleTimer.current = 0;
      sampleRef.current();
    }, ANCHOR_SETTLE_MS);
  }

  useEffect(
    () => () => {
      if (sampleTimer.current) clearTimeout(sampleTimer.current);
    },
    [],
  );

  // ── The user's OWN wheel ─────────────────────────────────────────────────
  // In mouse-tracking mode xterm.js converts a wheel event into SGR wheel
  // reports and writes them through `onData` — the exact bytes Claude scrolls
  // by. Counting those keeps the thumb in the same unit as everything else
  // (one report = one notch), which is how the native pane's bar follows the
  // wheel via Rust's `tui_scroll` echo. Drags don't double-count: `scrollBy`
  // writes to the PTY directly, bypassing onData.
  useEffect(() => {
    if (!terminal || !active) return;
    const d = terminal.onData((data) => {
      if (!data.includes("\x1b[<6")) return;
      let n = 0;
      for (const m of data.matchAll(/\x1b\[<6([45]);\d+;\d+M/g)) {
        n += m[1] === "4" ? 1 : -1; // 64 = wheel up = older = positive
      }
      if (n === 0) return;
      setPosition(posRef.current + n);
      scheduleSample(n);
    });
    return () => d.dispose();
    // scheduleSample is stable (ref indirection).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal, active, setPosition]);

  // ── Drag (relative, with acceleration) ───────────────────────────────────
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const lastYRef = useRef(0);
  const lastTRef = useRef(0);
  const accumRef = useRef(0);

  const span = computeSpan(pos, knownSpan);
  const TRACK_W = 6;
  const PAD_Y = 6;
  const THUMB_H = 40;

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    lastYRef.current = e.clientY;
    lastTRef.current = e.timeStamp;
    accumRef.current = 0;
    setDragging(true);
  };
  const endDrag = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    setDragging(false);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!(e.buttons & 1)) return;
    const el = trackRef.current;
    if (!el) return;
    const trackH = Math.max(1, el.clientHeight - PAD_Y * 2);
    const pxPerNotch = Math.max(1, (trackH - THUMB_H) / span);
    const dy = e.clientY - lastYRef.current;
    const dt = Math.max(8, e.timeStamp - lastTRef.current);
    lastYRef.current = e.clientY;
    lastTRef.current = e.timeStamp;
    // Same acceleration curve as the overlay bar: slow drags stay 1:1 and
    // precise, fast ones multiply, capped.
    const velocity = Math.abs(dy) / dt;
    const accel = Math.min(5, 1 + Math.max(0, velocity - 0.4) * 1.6);
    accumRef.current += (-dy / pxPerNotch) * accel;
    const whole = Math.trunc(accumRef.current);
    if (whole === 0) return;
    accumRef.current -= whole;
    scrollBy(whole);
  };

  // Jump-to-bottom only exists while the bar is STILL — any position change
  // hides it and restarts the idle timer (same rule as the overlay bar), so it
  // never chases a moving thumb.
  const [still, setStill] = useState(false);
  useEffect(() => {
    setStill(false);
    const t = window.setTimeout(() => setStill(true), JUMP_BTN_IDLE_MS);
    return () => clearTimeout(t);
  }, [pos]);

  if (!active) return null;

  const frac = Math.min(1, pos / Math.max(span, pos || 1));
  const atBottom = pos === 0;

  return (
    <div
      ref={trackRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: 16,
        display: "flex",
        justifyContent: "flex-end",
        zIndex: 6,
        touchAction: "none",
      }}
    >
      {/* Track + thumb, matching the shell pane's scrollbar exactly:
          transparent track, --ezy-border thumb, --ezy-border-light on hover. */}
      <div
        style={{
          position: "relative",
          width: TRACK_W,
          margin: `${PAD_Y}px 4px`,
          borderRadius: TRACK_W / 2,
          background: "transparent",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: `calc(${(1 - frac) * 100}% - ${(1 - frac) * THUMB_H}px)`,
            left: 0,
            width: TRACK_W,
            height: THUMB_H,
            borderRadius: TRACK_W / 2,
            background: dragging ? "var(--ezy-border-light)" : "var(--ezy-border)",
            transition: dragging
              ? "background-color 120ms ease"
              : "top 90ms linear, background-color 120ms ease",
          }}
        />
      </div>

      {/* Jump to bottom — Claude's own Ctrl+End, so it is absolute and cannot
          drift like undoing our own notch count would. Rides just below the
          thumb (thumb bottom + gap, clamped inside the pane), matching the
          normal-buffer button, and only while the bar is still. */}
      {!atBottom && still && !dragging && (
        <div
          onClick={() => {
            writeRef.current(CTRL_END);
            posRef.current = 0;
            setPos(0);
          }}
          title="Jump to bottom"
          style={{
            position: "absolute",
            right: 12,
            top: `min(calc((100% - ${PAD_Y * 2 + THUMB_H}px) * ${1 - frac} + ${
              PAD_Y + THUMB_H + JUMP_BTN_GAP_PX
            }px), calc(100% - ${JUMP_BTN_BOTTOM_CLAMP_PX}px))`,
            width: 22,
            height: 22,
            borderRadius: 4,
            backgroundColor: "var(--ezy-surface-raised)",
            border: "1px solid var(--ezy-border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            opacity: 0.85,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.opacity = "1";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.opacity = "0.85";
          }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="var(--ezy-text-muted)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="2,3 6,7 10,3" />
            <line x1="3" y1="9.5" x2="9" y2="9.5" />
          </svg>
        </div>
      )}
    </div>
  );
}
