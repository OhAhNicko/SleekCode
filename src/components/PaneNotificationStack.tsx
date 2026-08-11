/**
 * PaneNotificationStack — RENDERLESS lifecycle manager for notification
 * cards. The name is historical: it used to publish a second, in-app card
 * stack to the overlay, but the OS popup (OsToastHost → the "toast" window)
 * is now THE one notification surface (user decision 2026-08-11 — the
 * two-surface model presented the same card twice). What remains here is
 * everything about a card's LIFE, none of its rendering:
 *
 *   - master switch off → drop live cards
 *   - seeing the pane = acknowledged → dismiss
 *   - auto-dismiss timers
 */

import { useEffect } from "react";
import { usePaneNotificationsStore } from "../store/paneNotificationsStore";
import { useAppStore } from "../store";

export default function PaneNotificationStack() {
  const cards = usePaneNotificationsStore((s) => s.cards);
  const notifEnabled = useAppStore((s) => s.notifEnabled ?? true);
  const notifAutoDismiss = useAppStore((s) => s.notifAutoDismiss ?? false);
  const notifAutoDismissSeconds = useAppStore((s) => s.notifAutoDismissSeconds ?? 30);

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
