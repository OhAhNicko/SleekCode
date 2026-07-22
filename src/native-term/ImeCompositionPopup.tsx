import { useEffect, useRef, useState } from "react";
import { useOverlayPopupAnchor } from "./useOverlayPopupAnchor";
import {
  type NativeTermId,
  subscribeImeComposition,
  subscribeCursor,
} from "../lib/native-term-bridge";

// IME pre-edit overlay for the native terminal pane. Shows the composing text
// near the native cursor while the user is composing (CJK / dead-key input)
// and disappears once the IME commits or clears.
//
// Overlay-migrated: this component no longer renders DOM (which sat invisible
// beneath the native HWND and needed a hole cut). It computes the pane-LOCAL
// caret position + split text here and emits them to the overlay webview
// (kind "ime-composition", display-only).
//
// Pane-local coordinates throughout. The Rust side may not yet emit
// `cursor` events — when no cursor has been seen, we fall back to a
// bottom-left anchor inside the pane so the user still sees their text.
//
// Listeners are scoped strictly to bridge subscribers — no
// `window.addEventListener`, no `.focus()`, per repo memory rules.

interface ImeCompositionPopupProps {
  termId: NativeTermId;
  paneRef: React.RefObject<HTMLDivElement | null>;
}

interface CompositionState {
  text: string;
  cursor: number;
}

export default function ImeCompositionPopup({
  termId,
  paneRef,
}: ImeCompositionPopupProps) {
  const [composition, setComposition] = useState<CompositionState | null>(null);
  // Cursor cache. A ref because we don't want every cursor move to re-render
  // the popup — we read it lazily when composition state changes.
  const cursorRef = useRef<{ x: number; y: number; h: number } | null>(null);
  // Forces a re-render after a cursor update lands while composing, so the
  // popup chases the caret without subscribing the whole render to cursor.
  const [, bumpVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const unlistens: Array<() => void> = [];

    (async () => {
      const u1 = await subscribeImeComposition(termId, (p) => {
        if (cancelled) return;
        if (!p.text || p.committed) {
          setComposition(null);
        } else {
          setComposition({ text: p.text, cursor: p.cursor });
        }
      });
      unlistens.push(u1);

      const u2 = await subscribeCursor(termId, (p) => {
        if (cancelled) return;
        cursorRef.current = { x: p.x, y: p.y, h: p.h };
        // Only re-emit when actively composing — otherwise the popup is
        // closed and there's nothing to reposition.
        setComposition((prev) => {
          if (prev) bumpVersion((v) => v + 1);
          return prev;
        });
      });
      unlistens.push(u2);
    })();

    return () => {
      cancelled = true;
      for (const u of unlistens) u();
    };
  }, [termId]);

  // Position relative to the pane container. Prefer the cached cursor;
  // fall back to bottom-left when Rust hasn't emitted a cursor yet.
  let top = 0;
  let left = 0;
  if (composition) {
    const paneHeight = paneRef.current?.clientHeight ?? 0;
    const cursor = cursorRef.current;
    if (cursor) {
      // Place the popup just below the caret. `h` is the caret height in
      // logical px; nudge down 2px so the popup sits flush under the line.
      top = cursor.y + cursor.h + 2;
      left = cursor.x;
    } else {
      top = Math.max(0, paneHeight - 40);
      left = 16;
    }
  }

  useOverlayPopupAnchor({
    id: `ime-composition-${termId}`,
    kind: "ime-composition",
    open: !!composition,
    anchorRef: paneRef,
    payload: composition
      ? {
          top,
          left,
          before: composition.text.slice(0, composition.cursor),
          after: composition.text.slice(composition.cursor),
        }
      : null,
  });

  return null;
}
