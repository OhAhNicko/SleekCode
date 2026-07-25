/**
 * PaneNotification — surfaces a CLI's "I need you" signal as a branded in-app
 * toast instead of an OS notification.
 *
 * Claude Code emits a desktop-notification escape sequence when it wants
 * attention (a permission prompt, a finished turn). Which sequence depends on
 * its `notifChannel` setting — iTerm2 = OSC 9, Kitty = OSC 99, Ghostty =
 * OSC 777 — and MADE's Rust scanner accepts all three, so whichever channel is
 * selected works. The bell channel is deliberately NOT wired: a BEL carries no
 * message, and a toast saying nothing is worse than no toast.
 *
 * In-app rather than an OS notification, per the design brief: the point is to
 * tell you WHICH pane wants you, in a workspace with several, and hand you a
 * one-click way to get there. An OS toast pulls focus out of the app to say
 * something the app itself is better placed to show.
 *
 * Reuses the existing overlay toast (`useOverlayToast`), so it inherits MADE's
 * card styling, placement and dismiss behaviour rather than introducing a
 * second notification look.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeNotify, type NativeTermId } from "../lib/native-term-bridge";
import { useOverlayToast } from "../lib/useOverlayToast";
import { useAppStore } from "../store";
import type { TerminalType } from "../types";

/** How long a notification stays up. Long enough to read a sentence and reach
 * the button; short enough that a burst does not stack up forever. */
const TOAST_MS = 9000;

const CLI_LABEL: Partial<Record<TerminalType, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
};

interface PaneNotificationProps {
  termId: NativeTermId | null;
  terminalType: TerminalType;
  /** Shown as the toast title so you can tell panes apart. */
  paneLabel?: string;
  /** Focus this pane — the whole point of the toast. */
  onFocusPane?: () => void;
  /** True when this pane is already the active one. */
  isActive?: boolean;
}

export default function PaneNotification({
  termId,
  terminalType,
  paneLabel,
  onFocusPane,
  isActive,
}: PaneNotificationProps) {
  const [note, setNote] = useState<{ title: string; body: string } | null>(null);
  const timerRef = useRef(0);
  /** See PaneProgressBar — same debug aid for the TERM_PROGRAM setting. */
  const loggedRef = useRef(false);
  const onFocusRef = useRef(onFocusPane);
  onFocusRef.current = onFocusPane;
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  const dismiss = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = 0;
    }
    setNote(null);
  }, []);

  useEffect(() => {
    if (termId == null) return;
    let un: (() => void) | undefined;
    let disposed = false;
    subscribeNotify(termId, (e) => {
      if (!loggedRef.current) {
        loggedRef.current = true;
        console.info(
          `[capability] notification received — TERM_PROGRAM="${useAppStore.getState().termProgram || "(none)"}"`,
        );
      }
      const body = e.body.trim();
      if (!body) return;
      // A pane you are already looking at does not need to be announced —
      // you can see it. This keeps the toast meaningful rather than constant.
      if (isActiveRef.current) return;
      setNote({ title: e.title.trim(), body });
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = 0;
        setNote(null);
      }, TOAST_MS);
    }).then((u) => {
      if (disposed) u();
      else un = u;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, [termId]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const cliName = CLI_LABEL[terminalType] ?? "Terminal";
  // The program's own title wins when it sends one (Ghostty's OSC 777 does);
  // otherwise name the pane, which is the information the user actually needs.
  const title = note?.title || paneLabel || cliName;

  useOverlayToast({
    id: `pane-notify-${termId}`,
    open: note !== null,
    payload: note
      ? {
          placement: "bottom-right",
          variant: "surface",
          title,
          detail: note.body,
          button: { label: "Go to pane", action: "focus" },
          dismissable: true,
        }
      : null,
    onAction: (action) => {
      if (action === "focus") onFocusRef.current?.();
      dismiss();
    },
  });

  return null;
}
