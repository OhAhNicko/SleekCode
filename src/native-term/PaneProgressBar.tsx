/**
 * PaneProgressBar — a hairline progress indicator along the top edge of the
 * terminal surface, driven by ConEmu progress sequences (OSC 9;4). Claude emits
 * these during long operations when its "Emit OSC 9;4 progress sequences"
 * setting is on.
 *
 * WHY NOT A BAR IN THE HEADER. The header already has a 44x4 bar, and it means
 * "context remaining". A second bar of the same shape beside it would put two
 * different quantities in one visual language — a budget and a task — and the
 * reader would have to remember which is which. This is a different axis and
 * gets a different form: a full-width hairline at the top of the content, the
 * page-load idiom, which is unmistakably "something is running right now" and
 * vanishes completely when nothing is.
 *
 * No animation, per the repo's UI rules: an indeterminate state renders as a
 * dimmed full-width line rather than a pulsing or travelling one.
 */

import { useEffect, useRef, useState } from "react";
import { subscribeProgress, type NativeTermId } from "../lib/native-term-bridge";
import { useAppStore } from "../store";

/** ConEmu states. 1 = normal, 2 = error, 3 = indeterminate, 4 = paused;
 * 0 clears. */
const STATE_CLEAR = 0;
const STATE_ERROR = 2;
const STATE_INDETERMINATE = 3;
const STATE_PAUSED = 4;

/**
 * Safety net: a program that dies mid-operation never sends its clearing
 * `state 0`, and a progress bar stuck at 60% forever is worse than none.
 */
const STALE_MS = 120_000;

interface PaneProgressBarProps {
  termId: NativeTermId | null;
}

export default function PaneProgressBar({ termId }: PaneProgressBarProps) {
  const [prog, setProg] = useState<{ state: number; percent: number } | null>(null);
  const staleTimer = useRef(0);
  // Debug aid for the TERM_PROGRAM setting: Claude gates progress reporting on
  // recognising the terminal, so "did anything arrive" is the only way to tell
  // whether the advertised identity worked. Logged once per pane.
  const loggedRef = useRef(false);

  useEffect(() => {
    if (termId == null) {
      setProg(null);
      return;
    }
    let un: (() => void) | undefined;
    let disposed = false;
    subscribeProgress(termId, (e) => {
      if (!loggedRef.current) {
        loggedRef.current = true;
        console.info(
          `[capability] progress (OSC 9;4) received — TERM_PROGRAM="${useAppStore.getState().termProgram || "(none)"}"`,
        );
      }
      if (staleTimer.current) clearTimeout(staleTimer.current);
      if (e.state === STATE_CLEAR) {
        setProg(null);
        return;
      }
      setProg({ state: e.state, percent: e.percent });
      staleTimer.current = window.setTimeout(() => {
        staleTimer.current = 0;
        setProg(null);
      }, STALE_MS);
    }).then((u) => {
      if (disposed) u();
      else un = u;
    });
    return () => {
      disposed = true;
      un?.();
      if (staleTimer.current) clearTimeout(staleTimer.current);
    };
  }, [termId]);

  // NOTE: the 2px row is ALWAYS reserved, transparent when idle. Mounting and
  // unmounting it instead would add/remove 2px from the pane's layout, which
  // resizes the native HWND — and at a row boundary that changes the terminal's
  // row count and reflows the TUI. A progress bar must never reflow the
  // terminal it is reporting on.
  const indeterminate = prog?.state === STATE_INDETERMINATE;
  const width = indeterminate || prog?.state === STATE_ERROR ? 100 : (prog?.percent ?? 0);
  const color =
    prog?.state === STATE_ERROR
      ? "var(--ezy-red)"
      : prog?.state === STATE_PAUSED
        ? "var(--ezy-text-muted)"
        : "var(--ezy-accent)";

  return (
    <div
      style={{
        position: "relative",
        height: 2,
        width: "100%",
        flexShrink: 0,
        // The track is the pane's own chrome colour, so an in-progress bar
        // reads as a fill rather than as an added band of UI.
        backgroundColor: prog ? "var(--ezy-border-subtle)" : "transparent",
        overflow: "hidden",
      }}
      title={
        !prog
          ? undefined
          : indeterminate
          ? "Working…"
          : prog?.state === STATE_ERROR
            ? "Failed"
            : `${prog?.percent ?? 0}%`
      }
    >
      <div
        style={{
          width: prog ? `${width}%` : "0%",
          height: "100%",
          backgroundColor: color,
          // Dimmed rather than animated for the unknown-duration case.
          opacity: indeterminate ? 0.45 : 1,
          transition: "width 300ms ease, background-color 300ms ease",
        }}
      />
    </div>
  );
}
