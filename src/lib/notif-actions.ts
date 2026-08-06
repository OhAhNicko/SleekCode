/**
 * Notification-card click handling — ONE implementation for both surfaces
 * that render the cards: the in-app stack (PaneNotificationStack) and the
 * custom OS popup window (OsToastHost). Verbs:
 *
 *   dismiss:<cardId>  → drop the card
 *   open:<cardId>     → dismiss + run the card's clickAction (Jira cards)
 *   focus:<cardId>    → dismiss + switch to the pane's tab + focus the pane
 *
 * The OS popup additionally restores/foregrounds the main window BEFORE
 * calling this (its click is the user asking to come back to MADE).
 */

import { useAppStore } from "../store";
import { usePaneNotificationsStore } from "../store/paneNotificationsStore";
import { getTerminalFocus } from "../store/terminalSlice";
import { findAllTerminalLeaves } from "./layout-utils";

/** Retry delay for focusing a pane that is still mounting (hibernated tab
 * wake respawns its panes a tick after setActiveTab). */
const FOCUS_RETRY_MS = 350;

let retryTimer = 0;

export function handleNotifCardAction(action: string): void {
  const sep = action.indexOf(":");
  if (sep === -1) return;
  const verb = action.slice(0, sep);
  const cardId = action.slice(sep + 1);
  const store = usePaneNotificationsStore.getState();

  if (verb === "dismiss") {
    store.dismiss(cardId);
    return;
  }

  // Cards carrying a clickAction (Jira updates) route through it instead of
  // the pane-focus path — their terminalId is synthetic.
  if (verb === "open") {
    const card = store.cards.find((c) => c.id === cardId);
    store.dismiss(cardId);
    const clickAction = card?.clickAction;
    if (!clickAction) return;
    const aSep = clickAction.indexOf(":");
    if (aSep !== -1 && clickAction.slice(0, aSep) === "jira-open") {
      void import("./jira-notify").then((m) =>
        m.openTicketFromNotification(clickAction.slice(aSep + 1)),
      );
    }
    return;
  }

  if (verb !== "focus") return;
  const card = store.cards.find((c) => c.id === cardId);
  store.dismiss(cardId);
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
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = window.setTimeout(() => {
        retryTimer = 0;
        focusPane();
      }, FOCUS_RETRY_MS);
    }
  });
}
