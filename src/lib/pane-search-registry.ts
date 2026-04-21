import { useAppStore } from "../store";

// Runtime registry of per-pane "open search bar" callbacks.
// Kept outside Zustand to avoid re-renders — mirrors the PTY write callback pattern.
const openSearchCallbacks: Record<string, () => void> = {};

export function registerPaneSearch(paneId: string, openFn: () => void): void {
  openSearchCallbacks[paneId] = openFn;
}

export function unregisterPaneSearch(paneId: string): void {
  delete openSearchCallbacks[paneId];
}

/**
 * Resolve which pane's search opener to call for a global Ctrl+F press.
 *
 * Order:
 *   1. Active terminal (from the Zustand store's terminals[].isActive flag).
 *   2. Pane wrapping the currently focused DOM element (data-pane-id attribute).
 *   3. Fallback: element carrying the .pane-active class.
 */
export function getActivePaneSearchOpener(): (() => void) | undefined {
  const terms = useAppStore.getState().terminals;
  for (const term of Object.values(terms)) {
    if (term.isActive && openSearchCallbacks[term.id]) {
      return openSearchCallbacks[term.id];
    }
  }

  if (typeof document !== "undefined") {
    const active = document.activeElement;
    const fromFocus =
      active instanceof HTMLElement
        ? active.closest("[data-pane-id]")
        : null;
    const paneEl =
      (fromFocus as HTMLElement | null) ??
      (document.querySelector(".pane-active[data-pane-id]") as HTMLElement | null) ??
      (document.querySelector(".pane-active") as HTMLElement | null);
    const paneId = paneEl?.dataset.paneId;
    if (paneId && openSearchCallbacks[paneId]) {
      return openSearchCallbacks[paneId];
    }
  }

  return undefined;
}
