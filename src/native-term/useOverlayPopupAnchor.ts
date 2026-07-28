import { useEffect, useRef } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { emitOverlayPopup, listenOverlayAction } from "../lib/overlay-bridge";
import { useAnyModalOpen } from "../store/modalCoordinationSlice";
import { useDismissOnOutsidePointer } from "../lib/overlay-dismiss";
import { anyFloatingWindow, isOccluded, OCCLUDER_SELECTOR } from "./occlusion";

/**
 * Emit a pane/element-anchored popup's live state to the overlay webview while
 * it's open. This is the migration replacement for `useOverlayPublisher` — but
 * instead of publishing a rect for the hole-cut driver, it emits the anchor's
 * rect over the event bus so the OVERLAY renders the popup above the native
 * panes (no hole).
 *
 * While `open`, a rAF loop re-reads the anchor's `getBoundingClientRect()` and
 * emits `overlay:popup` on change (position AND size — a bare ResizeObserver
 * misses position-only moves, same reasoning as the native geometry driver).
 * On close/unmount it emits `open:false` so the overlay drops it.
 *
 * ## Fullscreen modals force-close every popup
 *
 * These render in the overlay webview, a separate always-on-top window. No DOM
 * z-index in the MAIN webview can cover it, so a fullscreen modal that dims the
 * app still gets the TUI scrollbar, the jump-to-bottom button and the exit
 * banner painted on top of it — chrome for panes the user cannot even see.
 *
 * `useModalWhen` already hides the native panes themselves through
 * `native-term/visibility.ts`; this applies the same rule to the popups that
 * float above them, in the one place they are all published from. Every kind
 * routed through here is anchored to app UI that a fullscreen modal covers, so
 * none of them has a reason to outlive one.
 */
export function useOverlayPopupAnchor(opts: {
  id: string;
  kind: string;
  open: boolean;
  anchorRef: { current: HTMLElement | null };
  /** Kind-specific data forwarded to the overlay renderer (must be JSON-safe). */
  payload?: unknown;
  /** Called with actions the overlay popup bounces back (interactive popups). */
  onAction?: (action: string, data?: unknown) => void;
}): void {
  const { id, kind, anchorRef } = opts;
  // MUST be called unconditionally. Writing this as
  //     opts.open && !useAnyModalOpen()
  // short-circuits: when `opts.open` is false the hook never runs, so the hook
  // COUNT changes between renders. React then hands the remaining hooks the
  // wrong slots — which is why a popup whose `open` toggles (TuiScrollbar,
  // driven by alt-screen) produced both "change in the order of Hooks" and a
  // TypeError reading a store field off undefined.
  const anyModalOpen = useAnyModalOpen();
  const open = opts.open && !anyModalOpen;
  // Serialize so a new inline object each render doesn't restart the effect.
  const payloadJson = JSON.stringify(opts.payload ?? null);
  // Ref so a new inline closure each render doesn't resubscribe the listener.
  const onActionRef = useRef(opts.onAction);
  onActionRef.current = opts.onAction;

  // Outside-click dismissal (see lib/overlay-dismiss.ts): the overlay no longer
  // covers the screen to catch it, so it comes from the main webview and is
  // reported as the same "__dismiss__" action the backdrop used to send.
  useDismissOnOutsidePointer(
    opts.open,
    () => onActionRef.current?.("__dismiss__"),
    opts.anchorRef,
  );

  useEffect(() => {
    if (!open) return;
    let un: UnlistenFn | undefined;
    let disposed = false;
    listenOverlayAction((msg) => {
      if (msg.id !== id) return;
      onActionRef.current?.(msg.action, msg.data);
    }).then((u) => {
      if (disposed) u();
      else un = u;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, [id, open]);

  // Close ONLY when `open` flips false or the caller unmounts — never on a
  // payload change. This effect deliberately excludes payloadJson: with it in
  // the emit effect's cleanup, every payload update tore the popup down and
  // recreated it over the event bus (visible as a close/open FLICKER on the
  // recent-menu toggles and the file-link tooltip). Payload changes now
  // restart only the emit loop below, which overwrites the popup in place.
  useEffect(() => {
    if (!open) {
      emitOverlayPopup({ id, kind, open: false, rect: null });
      return;
    }
    if (import.meta.env.DEV) {
      // Diagnostic seam: if this logs but nothing renders, the overlay side
      // is broken; if a popup's trigger fires and this never logs, the
      // trigger→open wiring in the calling component is broken.
      console.debug("[overlay-anchor] open", id);
    }
    return () => {
      emitOverlayPopup({ id, kind, open: false, rect: null });
    };
  }, [id, kind, open]);

  useEffect(() => {
    if (!open) return;
    let raf = 0;
    let lastJson = "";
    let frame = 0;
    /** Emitted open:false because the anchor's pane is occluded. */
    let occludedHidden = false;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      // Keepalive: the event bus is fire-and-forget — a missed message must
      // not orphan a popup forever. Re-emit periodically so the overlay's
      // ghost-sweep (OverlayRoot) can drop popups whose owner went silent.
      if (++frame % 45 === 0) lastJson = "";
      const el = anchorRef.current;
      if (!el) return;
      const b = el.getBoundingClientRect();
      if (b.width <= 0 || b.height <= 0) return;

      // OCCLUSION, not just modals (2026-07-27). The doc block above covers
      // fullscreen modals, but an expanded/floating window hides panes through
      // a DIFFERENT owner — occlusion.ts, keyed on `data-native-occluder` /
      // `data-floating-pane-id` — and `useAnyModalOpen()` is false for those.
      // So a pane could be hidden while its overlay chrome kept drawing: the
      // TUI scrollbars of background panes floated on top of the expanded
      // dev-server panel (user screenshot, 2026-07-27).
      //
      // Mirrors the pane's own geometry driver exactly, including reading BOTH
      // host attributes, so a popup anchored inside the occluding window (its
      // own content) is never hidden by it.
      if (anyFloatingWindow()) {
        const host = el.closest<HTMLElement>(OCCLUDER_SELECTOR);
        const hostMode =
          host?.dataset.floatingMode ?? host?.dataset.nativeOccluder ?? null;
        if (
          isOccluded(
            { x: b.left, y: b.top, width: b.width, height: b.height },
            hostMode,
          )
        ) {
          if (!occludedHidden) {
            occludedHidden = true;
            emitOverlayPopup({ id, kind, open: false, rect: null });
          }
          return;
        }
      }
      if (occludedHidden) {
        // Un-occluded: clear the dedup guard so the next emit actually goes
        // out rather than being swallowed as "same rect as last time".
        occludedHidden = false;
        lastJson = "";
      }
      const rect = { x: b.left, y: b.top, width: b.width, height: b.height };
      const json = JSON.stringify(rect);
      if (json === lastJson) return;
      lastJson = json;
      emitOverlayPopup({
        id,
        kind,
        open: true,
        rect,
        payload: JSON.parse(payloadJson),
      });
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [id, kind, open, anchorRef, payloadJson]);
}
