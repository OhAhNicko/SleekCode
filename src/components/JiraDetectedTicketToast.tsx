import { useEffect, useState } from "react";
import {
  useJiraTicketToastStore,
  switchToDetectedTicket,
} from "../store/jiraTicketToastStore";
import { useOverlayToast } from "../lib/useOverlayToast";

/** Ordinary opens are a five-second acknowledgement. An archived ticket gets
 *  longer: it reports that a deliberate archive was undone (or deliberately
 *  wasn't), which is worth reading rather than glimpsing. */
const TOAST_DURATION_MS = 5000;
const ARCHIVED_DURATION_MS = 8000;

/**
 * "Opened SUPPORT-24920 — Switch" toast for the pasted-ticket detector
 * (`lib/jira-omnibox.ts`). Renders through the shared overlay toast card, same
 * as undo-close; only the wording and the Switch action are ours.
 *
 * It is deliberately silent for an ordinary open in AUTO mode — the canvas
 * already switched, and narrating what you are looking at is noise. Everything
 * else is announced: a manual-mode open spawned a CLI you cannot see, and an
 * archived row was resurrected (or refused) either way.
 */
export default function JiraDetectedTicketToast() {
  const detected = useJiraTicketToastStore((s) => s.detected);
  const clear = useJiraTicketToastStore((s) => s.clear);
  const [visible, setVisible] = useState(false);

  const archived =
    detected?.reason === "archived-resumed" || detected?.reason === "archived-new";

  useEffect(() => {
    if (!detected) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const timer = setTimeout(
      () => {
        setVisible(false);
        clear();
      },
      archived ? ARCHIVED_DURATION_MS : TOAST_DURATION_MS,
    );
    return () => clearTimeout(timer);
    // `detected.at` is what makes a second detection of the SAME ticket restart
    // the timer instead of being swallowed as an unchanged object.
  }, [detected, archived, clear]);

  const active = visible && !!detected;

  const title = !detected
    ? ""
    : detected.reason === "archived-new"
      ? `${detected.ticket} is archived`
      : detected.reason === "archived-resumed"
        ? `Unarchived ${detected.ticket}`
        : detected.reason === "resumed"
          ? `Resumed ${detected.ticket}`
          : detected.reason === "already-open"
            ? `${detected.ticket} is already open`
            : `Opened ${detected.ticket}`;

  const detail = !detected
    ? undefined
    : detected.reason === "archived-new"
      ? "Started a new conversation instead."
      : detected.reason === "archived-resumed"
        ? "Resumed the archived conversation."
        : undefined;

  useOverlayToast({
    id: "jira-detected-ticket-toast",
    open: active,
    payload:
      active && detected
        ? {
            placement: "bottom-center",
            variant: "surface" as const,
            title,
            detail,
            dismissable: true,
            ...(detected.canSwitch
              ? { button: { label: "Switch", action: "switch" } }
              : {}),
          }
        : null,
    onAction: (action) => {
      if (action === "switch" && detected) switchToDetectedTicket(detected);
      setVisible(false);
      clear();
    },
  });

  return null;
}
