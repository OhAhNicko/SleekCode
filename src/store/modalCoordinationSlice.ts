// Fullscreen-modal coordination for the native terminal renderer.
//
// REVIVED 2026-07-23 (was a no-op while popups used per-popup hole-cutting).
// User mandate from the overlay-webview rework: "There should be NO
// hole-cutting in the whole application." Fullscreen modals live in the MAIN
// webview (they need real keyboard focus — palette/search inputs — which the
// WS_EX_NOACTIVATE overlay webview cannot provide), so the way they get above
// the native GPU panes without a hole is: the panes are HIDDEN while any
// fullscreen modal is open (they are covered by the modal + dim backdrop
// anyway) and re-shown on close. `NativePaneVisibilityCoordinator` consumes
// `openFullscreenModals` and drives native_term_hide/show.
//
// Scope guard: ONLY register modals whose backdrop covers the whole window.
// Small anchored popups (menus, toasts, tooltips) belong to the overlay
// webview instead (src/overlay/OverlayRoot.tsx).
import { useEffect } from "react";
import type { StateCreator } from "zustand";
import { useAppStore } from "./index";

export interface ModalCoordinationSlice {
  /** Keys of currently-open fullscreen modals (copy-on-write set). */
  openFullscreenModals: ReadonlySet<string>;
  registerFullscreenModal: (key: string) => void;
  unregisterFullscreenModal: (key: string) => void;
}

const EMPTY_OPEN: ReadonlySet<string> = new Set();

export const createModalCoordinationSlice: StateCreator<
  ModalCoordinationSlice,
  [],
  [],
  ModalCoordinationSlice
> = (set, get) => ({
  openFullscreenModals: EMPTY_OPEN,

  registerFullscreenModal: (key) => {
    const prev = get().openFullscreenModals;
    if (prev.has(key)) return;
    const next = new Set(prev);
    next.add(key);
    set({ openFullscreenModals: next });
  },

  unregisterFullscreenModal: (key) => {
    const prev = get().openFullscreenModals;
    if (!prev.has(key)) return;
    const next = new Set(prev);
    next.delete(key);
    set({ openFullscreenModals: next });
  },
});

type StoreWithThisSlice = ReturnType<typeof useAppStore.getState> &
  ModalCoordinationSlice;

/** Register a fullscreen modal for the whole lifetime of the component.
 * Use in modals that unmount when closed (the common pattern here). */
export function useModal(key: string): void {
  useEffect(() => {
    const s = useAppStore.getState() as StoreWithThisSlice;
    s.registerFullscreenModal(key);
    return () => {
      (useAppStore.getState() as StoreWithThisSlice).unregisterFullscreenModal(
        key,
      );
    };
  }, [key]);
}

/** Register while `active` — for modals that stay mounted when closed. */
export function useModalWhen(key: string, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const s = useAppStore.getState() as StoreWithThisSlice;
    s.registerFullscreenModal(key);
    return () => {
      (useAppStore.getState() as StoreWithThisSlice).unregisterFullscreenModal(
        key,
      );
    };
  }, [key, active]);
}

export function useAnyModalOpen(): boolean {
  return useAppStore(
    (s) => (s as StoreWithThisSlice).openFullscreenModals.size > 0,
  );
}
