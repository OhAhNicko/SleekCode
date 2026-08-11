/**
 * ToastRoot — renderer inside the custom OS notification popup window.
 *
 * Driven entirely by the main webview (OsToastHost): cards arrive over
 * `made:os-toast-cards`, clicks go back over `made:os-toast-action` (the main
 * webview owns the store and the navigation — this window navigates nothing
 * itself). The window is placed/shown by the main side; the ONE thing this
 * side owns is its own height: after each render it measures the card column
 * and asks Rust to size the window to it (`toast_window_place`), so the
 * window always fits its content exactly and never scrolls.
 *
 * Theme rides the overlay's broadcast bridge (`overlay:theme` +
 * `overlay:ready`) — the main webview re-emits on every ready announcement,
 * so this window inherits the app's --ezy-* tokens with zero new wiring.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { listenOverlayTheme, emitOverlayReady } from "../lib/overlay-bridge";
import { NotifCardVisual, type NotifCardData } from "../overlay/NotifCardVisual";

/** Logical width of the popup window; identical to the in-app stack's card
 * width. The window is transparent (cards draw their own antialiased
 * corners) and clipped to the union of the card rects (SetWindowRgn, see
 * toast_window_place) so the gaps between stacked cards are click-through —
 * the same look and hit behavior as the in-app stack. */
const TOAST_W = 320;

export function ToastRoot() {
  const [cards, setCards] = useState<NotifCardData[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  // Breadcrumbs into %TEMP%\made-logs\made-<profile>.log: the whole show
  // chain (cards event → measure → place) is otherwise fire-and-forget, and
  // a failure anywhere reads as "toasts just don't appear".
  useEffect(() => {
    void invoke("debug_log_line", { line: "[toast] root mounted" }).catch(() => {});
  }, []);

  useEffect(() => {
    let un: (() => void) | undefined;
    let disposed = false;
    listen<{ cards: NotifCardData[] }>("made:os-toast-cards", (e) => {
      const next = e.payload.cards ?? [];
      void invoke("debug_log_line", { line: `[toast] cards=${next.length}` }).catch(() => {});
      setCards(next);
    }).then((u) => {
      if (disposed) u();
      else un = u;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  // Theme adoption — same contract as OverlayRoot.
  useEffect(() => {
    let un: (() => void) | undefined;
    let disposed = false;
    listenOverlayTheme((vars) => {
      const root = document.documentElement;
      for (const [name, value] of Object.entries(vars)) {
        root.style.setProperty(name, value);
      }
    }).then((u) => {
      if (disposed) {
        u();
        return;
      }
      un = u;
      emitOverlayReady();
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  // Self-measure → window size + clip region. The main side decides WHEN the
  // window shows; re-measuring on every cards change keeps both exact while
  // it is visible (the place command is idempotent and skips identical
  // regions). Card rects are viewport coords, which ARE window-local logical
  // px — this webview fills the toast window exactly.
  useLayoutEffect(() => {
    if (cards.length === 0) return;
    const root = rootRef.current;
    const h = root?.scrollHeight ?? 0;
    if (!root || h <= 0) return;
    // Same radius the cards draw with (NotifCardVisual: radius-scale * 8px),
    // so the window clip and the painted corner coincide.
    const radiusScale =
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--ezy-radius-scale"),
      ) || 1;
    const rects = [...root.children].map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, radius: radiusScale * 8 };
    });
    void invoke("toast_window_place", { width: TOAST_W, height: h, rects })
      .then(() =>
        invoke("debug_log_line", {
          line: `[toast] placed ${TOAST_W}x${h} rects=${rects.length}`,
        }),
      )
      .catch((err) =>
        invoke("debug_log_line", { line: `[toast] place FAILED: ${String(err)}` }),
      )
      .catch(() => {});
  }, [cards]);

  const act = (action: string) => {
    void emit("made:os-toast-action", { action });
  };

  return (
    <div
      ref={rootRef}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        fontFamily: "var(--ezy-font-ui, Inter, system-ui, sans-serif)",
        // No background: the window is transparent, and the cards paint their
        // own surface — the gaps between stacked cards show the desktop.
      }}
    >
      {cards.map((card) => (
        <div
          key={card.id}
          onClick={() => act(`${card.hasAction ? "open" : "focus"}:${card.id}`)}
          style={{ cursor: "pointer" }}
        >
          <NotifCardVisual card={card} onDismiss={() => act(`dismiss:${card.id}`)} />
        </div>
      ))}
    </div>
  );
}
