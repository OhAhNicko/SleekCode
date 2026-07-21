import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as RPointerEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Phase 0 de-risk prototype UI for the overlay webview.
 *
 * Renders a single draggable "popup" test box over the terminal panes to
 * validate the 4 hardware gates:
 *   1. composites ABOVE the native panes (visible, opaque, clean rounded
 *      corners + real shadow — no hole, no artifact),
 *   2. follows the main window (move / resize / maximize / minimize->restore),
 *   3. click-through — clicks OUTSIDE the box reach the terminal; clicks ON the
 *      box (and its buttons) hit the overlay webview,
 *   4. transparency is stable (no black fill, no flash).
 *
 * The box publishes its own bounding rect to the Win32 click-through region via
 * the `overlay_set_region` command. The overlay root is `pointer-events:none`;
 * only the box/pip is `pointer-events:auto` (the slot-park click-through
 * idiom). But CSS pointer-events only governs WITHIN this webview — the Win32
 * region is what makes off-box clicks fall through to the terminal HWND below,
 * which is why we mirror the box rect into the region on every layout.
 */

type PopupRect = { x: number; y: number; width: number; height: number };

const BOX_W = 300;
const BOX_H = 180;

export function OverlayRoot() {
  const [pos, setPos] = useState({ x: 160, y: 160 });
  const [hits, setHits] = useState(0);
  const [visible, setVisible] = useState(true);
  const interactiveRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  const publishRegion = useCallback((rects: PopupRect[]) => {
    invoke("overlay_set_region", { rects }).catch((e) =>
      console.error("[overlay] overlay_set_region failed", e),
    );
  }, []);

  // After every layout, set the Win32 click-through region to exactly the
  // bounding rect of whatever interactive element is showing (box or pip).
  // Everything outside it stays click-through to the terminal below.
  useLayoutEffect(() => {
    const el = interactiveRef.current;
    if (!el) {
      publishRegion([]);
      return;
    }
    const r = el.getBoundingClientRect();
    publishRegion([{ x: r.left, y: r.top, width: r.width, height: r.height }]);
  }, [pos, visible, hits, publishRegion]);

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    // Don't start a drag from the buttons.
    if ((e.target as HTMLElement).tagName === "BUTTON") return;
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    setPos({
      x: e.clientX - dragRef.current.dx,
      y: e.clientY - dragRef.current.dy,
    });
  };
  const onPointerUp = (e: RPointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer may not be captured — ignore */
    }
  };

  if (!visible) {
    // Box hidden: region collapses to just this pip so the rest of the client
    // area is fully click-through to the terminals.
    return (
      <div ref={interactiveRef} style={pipStyle} onClick={() => setVisible(true)}>
        Show overlay test box
      </div>
    );
  }

  return (
    <div
      ref={interactiveRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{ ...boxStyle, left: pos.x, top: pos.y }}
    >
      <div style={{ fontWeight: 600, fontSize: 14 }}>Overlay test box</div>
      <div style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.45 }}>
        Drag me over a terminal. Click OUTSIDE me and the terminal should get
        it (cursor moves, typing works). Click a button and the overlay gets it.
      </div>
      <div
        style={{
          marginTop: "auto",
          display: "flex",
          gap: 10,
          alignItems: "center",
        }}
      >
        <button
          style={buttonStyle}
          onClick={(e) => {
            e.stopPropagation();
            setHits((h) => h + 1);
          }}
        >
          Hit me
        </button>
        <span
          style={{
            fontSize: 12,
            opacity: 0.82,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          hits: {hits}
        </span>
        <button
          style={{ ...buttonStyle, marginLeft: "auto" }}
          onClick={(e) => {
            e.stopPropagation();
            setVisible(false);
          }}
        >
          Hide
        </button>
      </div>
    </div>
  );
}

const boxStyle: CSSProperties = {
  position: "fixed",
  width: BOX_W,
  height: BOX_H,
  pointerEvents: "auto",
  boxSizing: "border-box",
  padding: 16,
  borderRadius: 14,
  background: "#171b22",
  border: "1px solid rgba(255,255,255,0.12)",
  boxShadow: "0 18px 50px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.4)",
  color: "#e6edf3",
  fontFamily: "Inter, system-ui, sans-serif",
  userSelect: "none",
  cursor: "grab",
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const buttonStyle: CSSProperties = {
  appearance: "none",
  border: "1px solid rgba(255,255,255,0.14)",
  background: "#233041",
  color: "#e6edf3",
  borderRadius: 8,
  padding: "6px 12px",
  fontSize: 12,
  cursor: "pointer",
};

const pipStyle: CSSProperties = {
  position: "fixed",
  top: 12,
  left: 12,
  pointerEvents: "auto",
  border: "1px solid rgba(255,255,255,0.14)",
  background: "#171b22",
  color: "#e6edf3",
  borderRadius: 10,
  padding: "8px 12px",
  fontSize: 12,
  fontFamily: "Inter, system-ui, sans-serif",
  boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
  cursor: "pointer",
};
