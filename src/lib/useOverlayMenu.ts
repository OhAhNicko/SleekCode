import { useEffect, useRef } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { emitOverlayPopup, listenOverlayAction } from "./overlay-bridge";
import type { OverlayMenuPayload } from "./overlay-menu-model";

/**
 * Main-side driver for a generic anchored dropdown rendered by the overlay
 * webview (kind "anchored-menu", a backdrop popup: outside click dismisses,
 * full transparency => real drop shadow).
 *
 * While `open`, streams the anchor element's live rect + the display model;
 * the overlay bounces the picked item's `actionId` (or `__dismiss__`) back.
 * `onClose` fires for BOTH dismissal and after an item action — the caller
 * clears its open-state there. Keyboard stays in the main webview.
 */
export function useOverlayMenu(opts: {
  id: string;
  open: boolean;
  /** Element to anchor to (rect streamed per-frame) … */
  anchorRef?: { current: HTMLElement | null };
  /** … or a fixed point (cursor menus): zero-size rect, emitted once … */
  anchorPoint?: { x: number; y: number } | null;
  /** … or a fixed rect (pre-measured anchors), emitted once. */
  anchorRect?: { x: number; y: number; width: number; height: number } | null;
  payload: OverlayMenuPayload | null;
  /** `data` carries modifier state from the overlay click: { ctrl: boolean }. */
  onAction: (actionId: string, data?: unknown) => void;
  onClose: () => void;
}): void {
  const { id, open, anchorRef } = opts;
  const payloadJson = JSON.stringify(opts.payload ?? null);
  const pointJson = JSON.stringify(
    opts.anchorPoint
      ? { x: opts.anchorPoint.x, y: opts.anchorPoint.y, width: 0, height: 0 }
      : (opts.anchorRect ?? null),
  );
  const onActionRef = useRef(opts.onAction);
  onActionRef.current = opts.onAction;
  const onCloseRef = useRef(opts.onClose);
  onCloseRef.current = opts.onClose;

  useEffect(() => {
    if (!open) {
      emitOverlayPopup({ id, kind: "anchored-menu", open: false, rect: null });
      return;
    }
    const point = JSON.parse(pointJson) as {
      x: number;
      y: number;
      width: number;
      height: number;
    } | null;
    if (point) {
      emitOverlayPopup({
        id,
        kind: "anchored-menu",
        open: true,
        rect: point,
        payload: JSON.parse(payloadJson),
      });
      return () => {
        emitOverlayPopup({ id, kind: "anchored-menu", open: false, rect: null });
      };
    }
    let raf = 0;
    let lastJson = "";
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = anchorRef?.current;
      if (!el) return;
      const b = el.getBoundingClientRect();
      if (b.width <= 0 || b.height <= 0) return;
      const rect = { x: b.left, y: b.top, width: b.width, height: b.height };
      const json = JSON.stringify(rect);
      if (json === lastJson) return;
      lastJson = json;
      emitOverlayPopup({
        id,
        kind: "anchored-menu",
        open: true,
        rect,
        payload: JSON.parse(payloadJson),
      });
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      emitOverlayPopup({ id, kind: "anchored-menu", open: false, rect: null });
    };
  }, [id, open, anchorRef, payloadJson, pointJson]);

  useEffect(() => {
    if (!open) return;
    let un: UnlistenFn | undefined;
    let disposed = false;
    listenOverlayAction((msg) => {
      if (msg.id !== id) return;
      if (msg.action !== "__dismiss__") onActionRef.current(msg.action, msg.data);
      onCloseRef.current();
    }).then((u) => {
      if (disposed) u();
      else un = u;
    });
    // Escape closes (keyboard lives in the MAIN webview, never the overlay).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      disposed = true;
      un?.();
      document.removeEventListener("keydown", onKey, true);
    };
  }, [id, open]);
}
