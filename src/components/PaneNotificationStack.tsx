/**
 * PaneNotificationStack — main-webview owner of the bottom-right notification
 * stack. Publishes the card list to the overlay (kind "notif-stack", rendered
 * in OverlayRoot) and routes clicks back:
 *
 *   focus:<cardId>   → dismiss + switch to the pane's tab + focus the pane
 *   dismiss:<cardId> → dismiss that card
 *   __dismiss__      → IGNORED. useOverlayViewportPopup bounces this on every
 *                      outside pointerdown; a persistent stack must survive it.
 *
 * One popup id for the whole stack: payload updates overwrite in place, so
 * cards appearing/disappearing never close/reopen the popup, and there is a
 * single keepalive + ghost-sweep entry instead of one per card.
 */

import { useEffect, useRef } from "react";
import { useOverlayViewportPopup } from "../lib/useOverlayToast";
import { usePaneNotificationsStore } from "../store/paneNotificationsStore";
import { useAnyModalOpen } from "../store/modalCoordinationSlice";
import { useAppStore } from "../store";
import { getTerminalFocus } from "../store/terminalSlice";
import { findAllTerminalLeaves } from "../lib/layout-utils";

/** Retry delay for focusing a pane that is still mounting (hibernated tab
 * wake respawns its panes a tick after setActiveTab). */
const FOCUS_RETRY_MS = 350;

export default function PaneNotificationStack() {
  const cards = usePaneNotificationsStore((s) => s.cards);
  const dismiss = usePaneNotificationsStore((s) => s.dismiss);
  const notifAutoDismiss = useAppStore((s) => s.notifAutoDismiss ?? false);
  const notifAutoDismissSeconds = useAppStore((s) => s.notifAutoDismissSeconds ?? 30);
  // Hook order must be stable — called unconditionally (see useOverlayPopupAnchor).
  const anyModalOpen = useAnyModalOpen();
  const retryTimerRef = useRef(0);

  // useOverlayViewportPopup has no modal suppression of its own; without this
  // gate the stack would paint over fullscreen modals in the overlay window,
  // where no main-webview z-index can cover it. Cards are kept — the stack
  // returns when the modal closes.
  const open = cards.length > 0 && !anyModalOpen;

  useOverlayViewportPopup({
    id: "pane-notif-stack",
    kind: "notif-stack",
    open,
    payload: {
      cards: cards.map((c) => ({
        id: c.id,
        projectName: c.projectName,
        paneLabel: c.paneLabel ?? "",
        timeHHMM: c.timeHHMM,
        body: c.body,
        kind: c.kind,
      })),
    },
    onAction: (action) => {
      // Outside-click "dismissal" — meaningless for a persistent stack.
      if (action === "__dismiss__") return;
      const sep = action.indexOf(":");
      if (sep === -1) return;
      const verb = action.slice(0, sep);
      const cardId = action.slice(sep + 1);
      if (verb === "dismiss") {
        dismiss(cardId);
        return;
      }
      if (verb !== "focus") return;
      const card = usePaneNotificationsStore.getState().cards.find((c) => c.id === cardId);
      dismiss(cardId);
      if (!card) return;

      const s = useAppStore.getState();
      const tab = s.tabs.find((t) => t.id === card.tabId);
      // Tab gone, or the pane was closed since the card fired — nothing to go to.
      if (!tab?.layout) return;
      if (!findAllTerminalLeaves(tab.layout).some((l) => l.terminalId === card.terminalId)) return;

      if (s.activeTabId !== tab.id) s.setActiveTab(tab.id); // wakes hibernated tabs
      const focusPane = () =>
        window.dispatchEvent(
          new CustomEvent("made:focus-terminal", {
            detail: { terminalId: card.terminalId, takeFocus: true },
          }),
        );
      requestAnimationFrame(() => {
        focusPane();
        // Hibernated wake: panes register their focus fn a tick later — one
        // bounded retry so the click still lands.
        if (!getTerminalFocus(card.terminalId)) {
          if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
          retryTimerRef.current = window.setTimeout(() => {
            retryTimerRef.current = 0;
            focusPane();
          }, FOCUS_RETRY_MS);
        }
      });
    },
  });

  // Auto-dismiss (Settings > Terminal > Notifications). Deadlines derive from
  // addedAt, so enabling the toggle retroactively applies to visible cards.
  useEffect(() => {
    if (!notifAutoDismiss || cards.length === 0) return;
    const timers = cards.map((c) =>
      window.setTimeout(
        () => usePaneNotificationsStore.getState().dismiss(c.id),
        Math.max(0, c.addedAt + notifAutoDismissSeconds * 1000 - Date.now()),
      ),
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, [cards, notifAutoDismiss, notifAutoDismissSeconds]);

  useEffect(
    () => () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    },
    [],
  );

  return null;
}
