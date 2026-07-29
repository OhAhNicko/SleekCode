import { create } from "zustand";

/**
 * A pane notification card — one entry in the bottom-right stack.
 *
 * Immutable after `add`: the body is resolved (transcript snippet or OSC
 * status text) BEFORE the card is created, so a card never changes size while
 * it is on screen (the overlay clips popups to their rendered rects; a growing
 * card would need region churn under the user's pointer).
 */
export interface PaneNotifCard {
  id: string;
  terminalId: string;
  /** Tab that owned the terminal when the notification fired. */
  tabId: string;
  projectName: string;
  /** Session name when known — tells panes of the same project apart. */
  paneLabel?: string;
  body: string;
  kind: "permission" | "finished";
  /** Absolute finish time, 24h "HH:MM" — stamped at event receipt. */
  timeHHMM: string;
  addedAt: number;
}

/** Backstop only — one card per pane already bounds the stack naturally. */
const MAX_STACK = 6;

interface PaneNotificationsStore {
  /** Newest first. */
  cards: PaneNotifCard[];
  add: (card: PaneNotifCard) => void;
  dismiss: (id: string) => void;
  clear: () => void;
}

/** Session-only store for the pane-notification stack (not persisted). */
export const usePaneNotificationsStore = create<PaneNotificationsStore>((set) => ({
  cards: [],

  // One card per pane: a new notification from the same terminal replaces the
  // old one (and moves to the top) — "finished twice" is one fact, not two.
  add: (card) =>
    set((state) => ({
      cards: [card, ...state.cards.filter((c) => c.terminalId !== card.terminalId)].slice(
        0,
        MAX_STACK,
      ),
    })),

  dismiss: (id) =>
    set((state) => ({ cards: state.cards.filter((c) => c.id !== id) })),

  clear: () => set({ cards: [] }),
}));
