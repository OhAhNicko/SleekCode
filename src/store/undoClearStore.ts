import { create } from "zustand";

interface UndoClearStore {
  clearedText: string | null;
  setClearedText: (text: string) => void;
  clear: () => void;
}

export const useUndoClearStore = create<UndoClearStore>((set) => ({
  clearedText: null,
  setClearedText: (text) => set({ clearedText: text }),
  clear: () => set({ clearedText: null }),
}));

/** Dispatch undo event and clear the store. */
export function undoClearComposer(): void {
  const { clearedText } = useUndoClearStore.getState();
  if (!clearedText) return;
  window.dispatchEvent(new CustomEvent("ezydev:undo-clear-composer", { detail: clearedText }));
  useUndoClearStore.getState().clear();
}
