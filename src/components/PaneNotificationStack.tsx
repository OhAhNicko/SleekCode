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

import { useEffect } from "react";
import { useOverlayViewportPopup } from "../lib/useOverlayToast";
import { usePaneNotificationsStore } from "../store/paneNotificationsStore";
import { useAnyModalOpen } from "../store/modalCoordinationSlice";
import { useAppStore } from "../store";
import { handleNotifCardAction } from "../lib/notif-actions";

export default function PaneNotificationStack() {
  const cards = usePaneNotificationsStore((s) => s.cards);
  const notifEnabled = useAppStore((s) => s.notifEnabled ?? true);
  const notifAutoDismiss = useAppStore((s) => s.notifAutoDismiss ?? false);
  const notifAutoDismissSeconds = useAppStore((s) => s.notifAutoDismissSeconds ?? 30);
  // Hook order must be stable — called unconditionally (see useOverlayPopupAnchor).
  const anyModalOpen = useAnyModalOpen();

  // useOverlayViewportPopup has no modal suppression of its own; without this
  // gate the stack would paint over fullscreen modals in the overlay window,
  // where no main-webview z-index can cover it. Cards are kept — the stack
  // returns when the modal closes.
  const open = cards.length > 0 && !anyModalOpen;

  // Master switch off → drop any visible cards too (not just future ones), so
  // re-enabling later doesn't resurface a stale stack.
  useEffect(() => {
    if (!notifEnabled) usePaneNotificationsStore.getState().clear();
  }, [notifEnabled]);

  // Seeing the pane IS the acknowledgement: when a card's pane becomes the
  // active pane of the active tab with the window visible, the user is looking
  // at the very thing the card announced — drop it. Same condition that stops
  // these cards being CREATED (isSuppressed in lib/pane-notifications.ts), so
  // a card can never coexist with its pane being on screen.
  useEffect(() => {
    if (cards.length === 0) return;
    const sweep = () => {
      const s = useAppStore.getState();
      // "On screen" now also requires the app to be FOCUSED — with the custom
      // OS popups, an unfocused MADE counts as "the user can't see it".
      if (s.windowMinimized || !s.appWindowFocused) return;
      for (const c of usePaneNotificationsStore.getState().cards) {
        if (s.terminals[c.terminalId]?.isActive === true && c.tabId === s.activeTabId) {
          usePaneNotificationsStore.getState().dismiss(c.id);
        }
      }
    };
    sweep();
    return useAppStore.subscribe(sweep);
  }, [cards]);

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
        hasAction: !!c.clickAction,
      })),
    },
    onAction: (action) => {
      // Outside-click "dismissal" — meaningless for a persistent stack.
      if (action === "__dismiss__") return;
      // Shared with the custom OS popup window (lib/notif-actions).
      handleNotifCardAction(action);
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

  return null;
}
