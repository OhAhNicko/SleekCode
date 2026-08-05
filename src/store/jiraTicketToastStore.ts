/**
 * "Opened SUPPORT-24920 — Switch" toast for the pasted-ticket detector.
 *
 * A tiny store rather than a prop chain because the producer is a library
 * function (`lib/jira-omnibox.ts`, called from a browser pane's address bar)
 * and the consumer is a top-level toast mounted in App.tsx. Same shape as
 * `undoCloseStore`.
 */
import { create } from "zustand";
import { useAppStore } from "./index";

/** Why the toast is up. Decides its wording, and — for `archived-*` — whether
 *  it appears at all in auto mode, where an ordinary open needs no narration
 *  because the canvas already switched to it. */
export type DetectedTicketReason =
  | "opened"
  | "resumed"
  | "already-open"
  | "archived-resumed"
  | "archived-new";

export interface DetectedTicket {
  ticket: string;
  /** Instance key to select on Switch — `TICKET` or `TICKET#n`. */
  instKey: string;
  tabId: string;
  reason: DetectedTicketReason;
  /** Show the Switch button: the canvas is NOT already on this ticket. */
  canSwitch: boolean;
  /** Distinguishes two detections of the same ticket, so the toast's timer
   *  restarts instead of the second one being swallowed as "no change". */
  at: number;
}

interface JiraTicketToastStore {
  detected: DetectedTicket | null;
  show: (value: Omit<DetectedTicket, "at">) => void;
  clear: () => void;
}

export const useJiraTicketToastStore = create<JiraTicketToastStore>((set) => ({
  detected: null,
  show: (value) => set({ detected: { ...value, at: Date.now() } }),
  clear: () => set({ detected: null }),
}));

/** Switch the canvas to the toast's ticket. */
export function switchToDetectedTicket(item: DetectedTicket): void {
  const store = useAppStore.getState();
  if (!store.tabs.some((t) => t.id === item.tabId)) return; // tab closed meanwhile
  if (store.activeTabId !== item.tabId) store.setActiveTab(item.tabId);
  store.setSelectedJiraTicket(item.tabId, item.instKey);
}
