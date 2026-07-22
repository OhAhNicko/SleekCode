// Hides every live native pane HWND while any FULLSCREEN modal is open and
// re-shows exactly the panes it hid on close.
//
// REVIVED 2026-07-23 for the overlay-webview rework ("NO hole-cutting in the
// whole application"). Fullscreen modals render in the main webview (they
// need real keyboard focus, which the WS_EX_NOACTIVATE overlay webview can't
// take), so without a hole the GPU panes would paint over them — hiding the
// panes is correct because a fullscreen modal covers them anyway. Rust's
// show() path re-asserts z-order and forces a repaint frame, so re-show is
// glitch-free.
//
// The effect re-runs on BOTH the modal flag and the live-term set: a pane
// that mounts WHILE a modal is open (e.g. session restore under the Welcome
// modal) is hidden too. On close, only ids still live are shown — an id that
// unregistered while hidden is managed by its own lifecycle.
import { useEffect, useRef } from "react";
import { useAppStore } from "../store";
import { useAnyModalOpen } from "../store/modalCoordinationSlice";
import type { NativeRendererSlice } from "../store/nativeRendererSlice";
import {
  nativeTermHide,
  nativeTermShow,
  type NativeTermId,
} from "../lib/native-term-bridge";

type StoreWithNative = ReturnType<typeof useAppStore.getState> &
  NativeRendererSlice;

export function NativePaneVisibilityCoordinator(): null {
  const anyModalOpen = useAnyModalOpen();
  const liveNativeTerms = useAppStore(
    (s) => (s as StoreWithNative).liveNativeTerms,
  );
  const hiddenRef = useRef<Set<NativeTermId>>(new Set());

  useEffect(() => {
    const hidden = hiddenRef.current;
    if (anyModalOpen) {
      for (const id of liveNativeTerms) {
        if (hidden.has(id)) continue;
        hidden.add(id);
        void nativeTermHide(id).catch(() => {});
      }
    } else if (hidden.size > 0) {
      for (const id of hidden) {
        if (!liveNativeTerms.has(id)) continue;
        void nativeTermShow(id).catch(() => {});
      }
      hidden.clear();
    }
  }, [anyModalOpen, liveNativeTerms]);

  return null;
}
