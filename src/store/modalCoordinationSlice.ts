// Modal-open coordination for the native terminal renderer.
//
// Every modal, palette, command-menu, and full-pane sheet that can overlap a
// native pane must register itself here so NativePaneVisibilityCoordinator
// can hide the native HWNDs while a modal is open and re-show them after.
//
// Adoption checklist (each component adds `useModal('<unique-key>')` at the
// top of its render function — keys must be unique across the codebase):
//
//   - ChangelogModal           → useModal('changelog')
//   - ClearDataModal           → useModal('clear-data')
//   - ConnectToGitHubModal     → useModal('connect-github')
//   - ReleaseModal             → useModal('release')
//   - WelcomeModal             → useModal('welcome')
//   - SettingsPane (overlay)   → useModal('settings')
//   - GlobalContextMenu        → useModal('global-context-menu')
//   - EmptyTabLauncher         → useModal('empty-tab-launcher')
//   - ServersPanel (overlay)   → useModal('servers-panel')
//   - DevServerRestoreToast    → useModal('dev-server-restore-toast')   // intersects panes
//   - UpdateBanner             → useModal('update-banner')               // intersects panes
//   - VoiceHud                 → useModal('voice-hud')                   // intersects panes
//
// Sweep deferred — do not edit any of the above files in this slice's first ship.
import { useEffect } from "react";
import type { StateCreator } from "zustand";
import { useAppStore } from "./index";

export interface ModalCoordinationSlice {
  openModals: Set<string>;
  pushModal: (key: string) => void;
  popModal: (key: string) => void;
}

export const createModalCoordinationSlice: StateCreator<
  ModalCoordinationSlice,
  [],
  [],
  ModalCoordinationSlice
> = (set) => ({
  openModals: new Set<string>(),

  pushModal: (key) => {
    set((state) => {
      if (state.openModals.has(key)) return state;
      const next = new Set(state.openModals);
      next.add(key);
      return { openModals: next };
    });
  },

  popModal: (key) => {
    set((state) => {
      if (!state.openModals.has(key)) return state;
      const next = new Set(state.openModals);
      next.delete(key);
      return { openModals: next };
    });
  },
});

// TODO(O1 store register): once src/store/index.ts intersects this slice
// into AppStore, drop these casts — currently AppStore doesn't yet know
// about us, and that registration is an M-list edit deferred to lead.
type StoreWithThisSlice = ReturnType<typeof useAppStore.getState> &
  ModalCoordinationSlice;

export function useModal(key: string): void {
  useEffect(() => {
    const state = useAppStore.getState() as StoreWithThisSlice;
    state.pushModal(key);
    return () => state.popModal(key);
  }, [key]);
}

export function useAnyModalOpen(): boolean {
  return useAppStore((s) => (s as StoreWithThisSlice).openModals.size > 0);
}
