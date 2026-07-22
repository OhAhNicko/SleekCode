import { useEffect, useRef } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { emitOverlayPopup, listenOverlayAction } from "../lib/overlay-bridge";

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
 */
export function useOverlayPopupAnchor(opts: {
  id: string;
  kind: string;
  open: boolean;
  anchorRef: { current: HTMLElement | null };
  /** Kind-specific data forwarded to the overlay renderer (must be JSON-safe). */
  payload?: unknown;
  /** Called with actions the overlay popup bounces back (interactive popups). */
  onAction?: (action: string) => void;
}): void {
  const { id, kind, open, anchorRef } = opts;
  // Serialize so a new inline object each render doesn't restart the effect.
  const payloadJson = JSON.stringify(opts.payload ?? null);
  // Ref so a new inline closure each render doesn't resubscribe the listener.
  const onActionRef = useRef(opts.onAction);
  onActionRef.current = opts.onAction;

  useEffect(() => {
    if (!open) return;
    let un: UnlistenFn | undefined;
    let disposed = false;
    listenOverlayAction((msg) => {
      if (msg.id !== id) return;
      onActionRef.current?.(msg.action);
    }).then((u) => {
      if (disposed) u();
      else un = u;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, [id, open]);

  useEffect(() => {
    if (!open) {
      emitOverlayPopup({ id, kind, open: false, rect: null });
      return;
    }
    let raf = 0;
    let lastJson = "";
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = anchorRef.current;
      if (!el) return;
      const b = el.getBoundingClientRect();
      if (b.width <= 0 || b.height <= 0) return;
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
      emitOverlayPopup({ id, kind, open: false, rect: null });
    };
  }, [id, kind, open, anchorRef, payloadJson]);
}
