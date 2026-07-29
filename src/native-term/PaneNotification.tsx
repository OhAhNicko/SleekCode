/**
 * PaneNotification — forwards a native pane's CLI "I need you" signal into the
 * central notification pipeline (lib/pane-notifications.ts).
 *
 * Claude Code emits a desktop-notification escape sequence when it wants
 * attention (a permission prompt, a finished turn). Which sequence depends on
 * its `notifChannel` setting — iTerm2 = OSC 9, Kitty = OSC 99, Ghostty =
 * OSC 777 — and MADE's Rust scanner accepts all three, so whichever channel is
 * selected works. The bell channel is deliberately NOT wired: a BEL carries no
 * message, and a card saying nothing is worse than no card.
 *
 * Presentation, suppression, stacking and click-to-focus all live centrally:
 * suppression in particular must NOT be computed from this pane's props —
 * App.tsx mounts a Workspace per project tab, so several panes have
 * `isActive === true` at once and a prop check swallows background tabs'
 * notifications.
 */

import { useEffect, useRef } from "react";
import { subscribeNotify, type NativeTermId } from "../lib/native-term-bridge";
import { addPaneNotification } from "../lib/pane-notifications";
import { useAppStore } from "../store";
import type { TerminalBackend, TerminalType } from "../types";

interface PaneNotificationProps {
  termId: NativeTermId | null;
  terminalId: string;
  terminalType: TerminalType;
  /** Session name when known — shown on the card to tell panes apart. */
  paneLabel?: string;
  workingDir: string;
  backend?: TerminalBackend;
  serverId?: string;
  sessionResumeId?: string;
}

export default function PaneNotification({
  termId,
  terminalId,
  terminalType,
  paneLabel,
  workingDir,
  backend,
  serverId,
  sessionResumeId,
}: PaneNotificationProps) {
  /** See PaneProgressBar — same debug aid for the TERM_PROGRAM setting. */
  const loggedRef = useRef(false);
  // The subscription is keyed on termId only; everything else is read through
  // a render-refreshed ref so a session rename or late resume-id doesn't tear
  // down the native event listener.
  const ctxRef = useRef({ terminalId, terminalType, paneLabel, workingDir, backend, serverId, sessionResumeId });
  ctxRef.current = { terminalId, terminalType, paneLabel, workingDir, backend, serverId, sessionResumeId };

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
      const c = ctxRef.current;
      void addPaneNotification({
        terminalId: c.terminalId,
        terminalType: c.terminalType,
        title: e.title.trim(),
        body: e.body.trim(),
        paneLabel: c.paneLabel,
        workingDir: c.workingDir,
        backend: c.backend,
        serverId: c.serverId,
        sessionResumeId: c.sessionResumeId,
      });
    }).then((u) => {
      if (disposed) u();
      else un = u;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, [termId]);

  return null;
}
