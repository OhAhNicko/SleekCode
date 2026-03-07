import { create } from "zustand";
import type { Tab, PaneLayout } from "../types";
import { useAppStore } from "./index";
import { cancelDeferredServerKill } from "./tabSlice";

type ClosedItem =
  | { type: "tab"; tab: Tab; index: number }
  | { type: "pane"; tabId: string; layoutBefore: PaneLayout };

interface UndoCloseStore {
  lastClosed: ClosedItem | null;
  setLastClosed: (item: ClosedItem) => void;
  clear: () => void;
}

export const useUndoCloseStore = create<UndoCloseStore>((set) => ({
  lastClosed: null,
  setLastClosed: (item) => set({ lastClosed: item }),
  clear: () => set({ lastClosed: null }),
}));

/** Snapshot a tab before removing it (call from tabSlice). */
export function snapshotTab(tabId: string): void {
  const { tabs } = useAppStore.getState();
  const index = tabs.findIndex((t) => t.id === tabId);
  if (index === -1) return;
  const tab = tabs[index];
  useUndoCloseStore.getState().setLastClosed({ type: "tab", tab, index });
}

/** Snapshot a pane layout before removing a pane (call from Workspace/PaneGrid). */
export function snapshotPane(tabId: string, layoutBefore: PaneLayout): void {
  useUndoCloseStore.getState().setLastClosed({ type: "pane", tabId, layoutBefore });
}

/** Restore the last closed tab or pane. */
export function undoClose(): void {
  const { lastClosed } = useUndoCloseStore.getState();
  if (!lastClosed) return;

  const store = useAppStore.getState();

  if (lastClosed.type === "tab") {
    const { tab, index } = lastClosed;
    cancelDeferredServerKill(tab.id);
    const tabs = [...store.tabs];
    // Re-insert at original position (clamped)
    const insertAt = Math.min(index, tabs.length);
    tabs.splice(insertAt, 0, tab);
    useAppStore.setState({ tabs, activeTabId: tab.id });
  } else {
    // Restore pane layout
    const { tabId, layoutBefore } = lastClosed;
    store.updateTabLayout(tabId, layoutBefore);
  }

  useUndoCloseStore.getState().clear();
}
