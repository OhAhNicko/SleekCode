import { create } from "zustand";
import type { Tab, PaneLayout } from "../types";
import { useAppStore } from "./index";
import { cancelDeferredServerKill } from "./tabSlice";

type ClosedItem =
  | { type: "tab"; tab: Tab; index: number }
  // Bulk close ("Close other tabs" / "Close tabs to the right"). Without this
  // variant a bulk close snapshotted only the LAST tab removed, so closing 8
  // tabs left 7 unrecoverable while the undo toast implied otherwise.
  | { type: "tabs"; tabs: { tab: Tab; index: number }[] }
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

/**
 * Snapshot several tabs before a bulk close.
 *
 * Call ONCE with every tab that is about to go — calling `snapshotTab` in a
 * loop overwrites itself and only the last one survives.
 */
export function snapshotTabs(tabIds: string[]): void {
  const { tabs } = useAppStore.getState();
  const snapshot = tabIds
    .map((id) => {
      const index = tabs.findIndex((t) => t.id === id);
      return index === -1 ? null : { tab: tabs[index], index };
    })
    .filter((x): x is { tab: Tab; index: number } => x !== null);
  if (snapshot.length === 0) return;
  useUndoCloseStore.getState().setLastClosed({ type: "tabs", tabs: snapshot });
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
  } else if (lastClosed.type === "tabs") {
    const tabs = [...store.tabs];
    // Ascending index order so each splice lands where it was: restoring
    // high-to-low would shift every later insertion point.
    for (const { tab, index } of [...lastClosed.tabs].sort((a, b) => a.index - b.index)) {
      cancelDeferredServerKill(tab.id);
      tabs.splice(Math.min(index, tabs.length), 0, tab);
    }
    useAppStore.setState({ tabs });
  } else {
    // Restore pane layout
    const { tabId, layoutBefore } = lastClosed;
    store.updateTabLayout(tabId, layoutBefore);
  }

  useUndoCloseStore.getState().clear();
}
