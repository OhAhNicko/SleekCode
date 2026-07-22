import { useEffect, useRef } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { emitOverlayPopup, listenOverlayAction } from "./overlay-bridge";

/**
 * Payload for the overlay's generic "toast" renderer (OverlayRoot). Covers all
 * of MADE's floating toasts: undo-close, undo-clear, image-insert-undo
 * (surface cards with an action button), upload-error and dev-server-restore
 * (solid status cards). Must stay JSON-safe — it crosses the event bus.
 */
export type OverlayToastPayload = {
  placement: "bottom-center" | "bottom-right";
  /** surface = themed card (--ezy-surface-raised); solid = colored status bg. */
  variant: "surface" | "solid";
  /** Background for the solid variant (e.g. "#dc2626"). */
  bg?: string;
  title: string;
  detail?: string;
  /** Action button (e.g. Undo) — `action` is bounced back via overlay:action. */
  button?: { label: string; action: string };
  /** Small hint after the button, e.g. "Ctrl+Z". */
  shortcutHint?: string;
  /** Show an X button that bounces the "dismiss" action. */
  dismissable?: boolean;
};

/**
 * Viewport-anchored companion to `useOverlayPopupAnchor`: publishes a toast to
 * the overlay webview while `open`, and routes its button/dismiss actions back
 * to the caller. The toast positions itself in the overlay (bottom-center /
 * bottom-right), so no anchor rect is streamed — toasts don't track a DOM
 * element. Keyboard shortcuts (Ctrl+Z etc.) stay in the MAIN webview: the
 * overlay is WS_EX_NOACTIVATE and never receives keystrokes.
 */
export function useOverlayToast(opts: {
  id: string;
  open: boolean;
  payload: OverlayToastPayload | null;
  onAction?: (action: string) => void;
}): void {
  const { id, open } = opts;
  // Serialize so a new inline payload object each render doesn't re-emit.
  const payloadJson = JSON.stringify(opts.payload ?? null);
  // Keep the latest handler without resubscribing the action listener.
  const onActionRef = useRef(opts.onAction);
  onActionRef.current = opts.onAction;

  useEffect(() => {
    if (!open) {
      emitOverlayPopup({ id, kind: "toast", open: false, rect: null });
      return;
    }
    emitOverlayPopup({
      id,
      kind: "toast",
      open: true,
      // Toasts are viewport-anchored; the renderer ignores the rect (it must
      // still be non-null — OverlayRoot drops popups with a null rect).
      rect: { x: 0, y: 0, width: 0, height: 0 },
      payload: JSON.parse(payloadJson),
    });
    return () => {
      emitOverlayPopup({ id, kind: "toast", open: false, rect: null });
    };
  }, [id, open, payloadJson]);

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
}
