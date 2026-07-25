// Feeds the FULLSCREEN-MODAL gate into the native-pane visibility owner
// (native-term/visibility.ts). It no longer hides/shows panes itself.
//
// REVIVED 2026-07-23 for the overlay-webview rework ("NO hole-cutting in the
// whole application"). Fullscreen modals render in the main webview (they
// need real keyboard focus, which the WS_EX_NOACTIVATE overlay webview can't
// take), so without a hole the GPU panes would paint over them — hiding the
// panes is correct because a fullscreen modal covers them anyway. Rust's
// show() path re-asserts z-order and forces a repaint frame, so re-show is
// glitch-free.
//
// REWORKED 2026-07-25: this used to walk `liveNativeTerms` and drive
// hide/show directly, tracking what it had hidden in a local Set. That made
// it a SECOND owner of pane visibility, which cannot coexist with the
// per-pane layout driver added for the tab-switch leak — the driver's next
// rAF frame would re-show a pane this component had just hidden, painting it
// over the modal. Both inputs now land in visibility.ts, which owns the
// hide/show invokes and only sends one when the effective value changes.
//
// Panes that mount WHILE a modal is open are covered without any extra
// bookkeeping here: their first geometry tick registers with the owner, whose
// reconcile sees `modalsOpen` and hides the (born-visible) HWND.
import { useEffect } from "react";
import { useAnyModalOpen } from "../store/modalCoordinationSlice";
import { setModalsOpen } from "./visibility";

export function NativePaneVisibilityCoordinator(): null {
  const anyModalOpen = useAnyModalOpen();

  useEffect(() => {
    setModalsOpen(anyModalOpen);
  }, [anyModalOpen]);

  return null;
}
