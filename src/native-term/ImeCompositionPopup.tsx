import { useEffect, useRef, useState } from "react";
import { useOverlayPublisher } from "../store/overlayRegionSlice";
import {
  type NativeTermId,
  subscribeImeComposition,
  subscribeCursor,
} from "../lib/native-term-bridge";

// IME pre-edit overlay for the native terminal pane. Renders a small popup
// near the native cursor while the user is composing (CJK / dead-key input)
// and disappears once the IME commits or clears.
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
  // Publish the popup's rect so the native HWND cuts a hole — without this
  // the pre-edit popup is INVISIBLE over the GPU pane (the old "would punch
  // through our own pane" skip-rationale was inverted for native panes).
  // Hook runs unconditionally (before the early return below); a null/absent
  // root publishes null, which is a no-op.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useOverlayPublisher(`ime-composition-${termId}`, rootRef);
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
        // Only re-render when actively composing — otherwise the popup is
        // unmounted and there's nothing to reposition.
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

  if (!composition) return null;

  // Position relative to the pane container. Prefer the cached cursor;
  // fall back to bottom-left when Rust hasn't emitted a cursor yet.
  const paneEl = paneRef.current;
  const paneHeight = paneEl?.clientHeight ?? 0;
  const cursor = cursorRef.current;

  let top: number;
  let left: number;
  if (cursor) {
    // Place the popup just below the caret. `h` is the caret height in
    // logical px; nudge down 2px so the popup sits flush under the line.
    top = cursor.y + cursor.h + 2;
    left = cursor.x;
  } else {
    top = Math.max(0, paneHeight - 40);
    left = 16;
  }

  // Split text at the IME caret to render a thin caret indicator inline.
  const before = composition.text.slice(0, composition.cursor);
  const after = composition.text.slice(composition.cursor);

  return (
    <div
      ref={rootRef}
      aria-hidden
      style={{
        position: "absolute",
        top,
        left,
        zIndex: 50,
        pointerEvents: "none",
        padding: "4px 8px",
        background: "rgb(20,20,24)",
        color: "#ffffff",
        border: "1px solid rgba(255,255,255,0.15)",
        borderRadius: 4,
        fontSize: 14,
        lineHeight: 1.2,
        whiteSpace: "nowrap",
        maxWidth: "calc(100% - 32px)",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      <span>{before}</span>
      <span
        style={{
          display: "inline-block",
          width: 1,
          height: "1em",
          background: "#ffffff",
          verticalAlign: "text-bottom",
          margin: "0 1px",
        }}
      />
      <span>{after}</span>
    </div>
  );
}
