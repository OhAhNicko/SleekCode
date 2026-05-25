// NO-OP slice — kept so existing `useModal('key')` / `useModalWhen('key', open)`
// call sites continue to compile and run while popups are migrated to the
// per-popup hole-cut model (`useOverlayPublisher` from overlayRegionSlice).
//
// The previous "hide every native pane while any modal is open" behaviour
// was rejected by user feedback (2026-05-24) — terminal content must remain
// visible at all times. The pane-visibility broadcaster is now a no-op
// (see NativePaneVisibilityCoordinator.tsx) and these hooks are inert.
//
// Migration target per popup:
//   1. Add a ref to the popup's root element.
//   2. Call `useOverlayPublisher(key, ref)` instead of `useModal(key)` so the
//      native pane region cuts a hole at the popup's actual rect.
//   3. Delete the `useModal`/`useModalWhen` call + import.
//
// Once all popups are migrated this file can be deleted.
import type { StateCreator } from "zustand";

export interface ModalCoordinationSlice {
  // Empty by design — fields removed when the hide model was retired.
  // Kept as an interface so `store/index.ts`'s intersection types compile.
  _modalCoordinationSliceVersion?: 2;
}

export const createModalCoordinationSlice: StateCreator<
  ModalCoordinationSlice,
  [],
  [],
  ModalCoordinationSlice
> = () => ({});

export function useModal(_key: string): void {
  // intentional no-op
}

export function useModalWhen(_key: string, _active: boolean): void {
  // intentional no-op
}

export function useAnyModalOpen(): boolean {
  return false;
}
