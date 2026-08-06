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

/** Logical width of the popup window; matches the in-app stack's card width
 * plus the 12px gutter each side. */
const TOAST_W = 344;

export function ToastRoot() {
  const [cards, setCards] = useState<NotifCardData[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let un: (() => void) | undefined;
    let disposed = false;
    listen<{ cards: NotifCardData[] }>("made:os-toast-cards", (e) => {
      setCards(e.payload.cards ?? []);
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

  // Self-measure → window height. The main side decides WHEN the window
  // shows; re-measuring on every cards change keeps the height exact while
  // it is visible (the place command is idempotent).
  useLayoutEffect(() => {
    if (cards.length === 0) return;
    const h = rootRef.current?.scrollHeight ?? 0;
    if (h > 0) {
      void invoke("toast_window_place", { width: TOAST_W, height: h }).catch(() => {});
    }
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
        padding: 12,
        fontFamily: "var(--ezy-font-ui, Inter, system-ui, sans-serif)",
        backgroundColor: "var(--ezy-bg, #131313)",
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
