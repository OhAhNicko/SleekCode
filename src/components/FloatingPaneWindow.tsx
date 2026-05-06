import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PaneLayout, FloatRect } from "../types";
import { useAppStore } from "../store";
import { renderLeafPane, type RenderLeafCallbacks, mountTerminalSlot } from "../lib/render-pane";
import { animateRect, FLIP_DURATION, FLIP_EASING } from "../lib/flip";

const MIN_W = 320;
const MIN_H = 200;
const HEADER_H = 24;

interface FloatingPaneWindowProps {
  paneId: string;
  node: PaneLayout;
  /** "closing" means we're animating from current rect to grid rect, then will unmount. */
  mode: "expanded" | "float" | "closing";
  zIndex: number;
  isTopmost: boolean;
  callbacks: RenderLeafCallbacks;
  /** Source rect for the open animation (grid slot rect). */
  fromRect?: DOMRect;
  /** Target rect for the close animation (where the grid slot lives now). */
  closeTargetRect?: DOMRect;
  paneTitle: string;
  onClosingDone?: () => void;
}

function getExpandedRect(): FloatRect {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const inset = Math.round(Math.min(vw, vh) * 0.025);
  return { x: inset, y: inset, w: vw - inset * 2, h: vh - inset * 2 };
}

export default function FloatingPaneWindow({
  paneId,
  node,
  mode,
  zIndex,
  isTopmost,
  callbacks,
  fromRect,
  closeTargetRect,
  paneTitle,
  onClosingDone,
}: FloatingPaneWindowProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const slotMountTargetRef = useRef<HTMLDivElement | null>(null);
  const expandPane = useAppStore((s) => s.expandPane);
  const popoutPane = useAppStore((s) => s.popoutPane);
  const minimizePane = useAppStore((s) => s.minimizePane);
  const bringToFront = useAppStore((s) => s.bringToFront);
  const setFloatRect = useAppStore((s) => s.setFloatRect);
  const floatRect = useAppStore((s) => s.floatRects[paneId]);

  const [localRect, setLocalRect] = useState<FloatRect>(() => {
    if (mode === "expanded" || mode === "closing") return getExpandedRect();
    return floatRect ?? getExpandedRect();
  });

  // Sync external floatRect / mode changes into local rect (for non-drag updates)
  useEffect(() => {
    if (mode === "expanded") setLocalRect(getExpandedRect());
    else if (mode === "float" && floatRect) setLocalRect(floatRect);
  }, [mode, floatRect]);

  // Open animation: grid slot rect → current rect (FLIP)
  const didOpenAnim = useRef(false);
  useLayoutEffect(() => {
    if (didOpenAnim.current) return;
    didOpenAnim.current = true;
    if (!fromRect || !wrapperRef.current) return;
    const el = wrapperRef.current;
    const toRect = el.getBoundingClientRect();
    animateRect(el, fromRect, toRect, { duration: FLIP_DURATION, easing: FLIP_EASING });
  }, [fromRect]);

  // Close animation: current rect → closeTargetRect, then notify parent
  useLayoutEffect(() => {
    if (mode !== "closing" || !wrapperRef.current) return;
    const el = wrapperRef.current;
    const fromR = el.getBoundingClientRect();
    if (!closeTargetRect) {
      onClosingDone?.();
      return;
    }
    const anim = animateRect(el, fromR, closeTargetRect, { duration: FLIP_DURATION, easing: FLIP_EASING, fill: "forwards" });
    if (!anim) {
      onClosingDone?.();
      return;
    }
    const done = () => onClosingDone?.();
    anim.addEventListener("finish", done);
    anim.addEventListener("cancel", done);
    return () => {
      anim.removeEventListener("finish", done);
      anim.removeEventListener("cancel", done);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, closeTargetRect]);

  // Animate expanded ↔ float resize
  const prevModeRef = useRef(mode);
  useLayoutEffect(() => {
    if (prevModeRef.current === mode) return;
    const wasFloat = prevModeRef.current === "float";
    const wasExpanded = prevModeRef.current === "expanded";
    prevModeRef.current = mode;

    if (mode === "closing") return;
    if (!wrapperRef.current) return;

    if ((wasFloat && mode === "expanded") || (wasExpanded && mode === "float")) {
      const el = wrapperRef.current;
      const fromR = el.getBoundingClientRect();
      const toR = mode === "expanded" ? getExpandedRect() : floatRect ?? getExpandedRect();
      animateRect(el, fromR, { left: toR.x, top: toR.y, width: toR.w, height: toR.h });
    }
  }, [mode, floatRect]);

  // Mount the persistent xterm slot into the floating wrapper for terminals.
  // Browser panes use a different mechanism: their iframe lives in a fixed-
  // position slot owned by Workspace and overlays the placeholder div via
  // getBoundingClientRect — so we don't move any DOM here for browsers.
  useLayoutEffect(() => {
    if (node.type !== "terminal") return;
    const el = slotMountTargetRef.current;
    if (!el) return;
    mountTerminalSlot(el, callbacks.getTerminalSlot(node.terminalId));
  }, [node, callbacks]);

  // ----- Drag (header) -----
  const handleHeaderPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (mode !== "float") return;
      if ((e.target as HTMLElement).closest("[data-pane-action]")) return;
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const start = { ...localRect };
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        const next: FloatRect = { x: start.x + dx, y: start.y + dy, w: start.w, h: start.h };
        setLocalRect(next);
      };
      const onUp = (ev: PointerEvent) => {
        target.releasePointerCapture(ev.pointerId);
        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", onUp);
        target.removeEventListener("pointercancel", onUp);
        setLocalRect((r) => {
          setFloatRect(paneId, r);
          return r;
        });
      };
      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", onUp);
      target.addEventListener("pointercancel", onUp);
    },
    [mode, localRect, paneId, setFloatRect]
  );

  // ----- Resize (8 handles) -----
  type Anchor = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
  const handleResizePointerDown = useCallback(
    (anchor: Anchor) => (e: React.PointerEvent<HTMLDivElement>) => {
      if (mode !== "float") return;
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startY = e.clientY;
      const start = { ...localRect };
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        let { x, y, w, h } = start;
        if (anchor.includes("e")) w = Math.max(MIN_W, start.w + dx);
        if (anchor.includes("s")) h = Math.max(MIN_H, start.h + dy);
        if (anchor.includes("w")) {
          const newW = Math.max(MIN_W, start.w - dx);
          x = start.x + (start.w - newW);
          w = newW;
        }
        if (anchor.includes("n")) {
          const newH = Math.max(MIN_H, start.h - dy);
          y = start.y + (start.h - newH);
          h = newH;
        }
        setLocalRect({ x, y, w, h });
      };
      const onUp = (ev: PointerEvent) => {
        target.releasePointerCapture(ev.pointerId);
        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", onUp);
        target.removeEventListener("pointercancel", onUp);
        setLocalRect((r) => {
          setFloatRect(paneId, r);
          return r;
        });
      };
      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", onUp);
      target.addEventListener("pointercancel", onUp);
    },
    [mode, localRect, paneId, setFloatRect]
  );

  const onWrapperClick = useCallback(() => {
    if (mode === "float" && !isTopmost) bringToFront(paneId);
  }, [mode, isTopmost, bringToFront, paneId]);

  const wrapperStyle: React.CSSProperties = {
    position: "fixed",
    left: localRect.x,
    top: localRect.y,
    width: localRect.w,
    height: localRect.h,
    zIndex,
    backgroundColor: "var(--ezy-bg)",
    border: `1px solid var(--ezy-border)`,
    borderRadius: 6,
    overflow: "hidden",
    boxShadow: isTopmost
      ? "0 12px 40px rgba(0,0,0,0.55), 0 4px 12px rgba(0,0,0,0.35)"
      : "0 6px 24px rgba(0,0,0,0.45), 0 2px 6px rgba(0,0,0,0.30)",
    display: "flex",
    flexDirection: "column",
    pointerEvents: mode === "closing" ? "none" : "auto",
  };

  // The header buttons swap based on mode
  const buttons = (
    <div className="flex items-center gap-0.5" style={{ flexShrink: 0 }}>
      {mode === "expanded" && (
        <button
          data-pane-action="popout"
          onClick={(e) => {
            e.stopPropagation();
            popoutPane(paneId);
          }}
          title="Pop out to floating window"
          className="p-1 rounded transition-colors hover:bg-[var(--ezy-border)]"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2.5" y="3.5" width="6" height="6" />
            <polyline points="6.5,1.5 10.5,1.5 10.5,5.5" />
            <line x1="10.5" y1="1.5" x2="6.5" y2="5.5" />
          </svg>
        </button>
      )}
      {mode === "float" && (
        <button
          data-pane-action="expand"
          onClick={(e) => {
            e.stopPropagation();
            expandPane(paneId);
          }}
          title="Expand to fullscreen"
          className="p-1 rounded transition-colors hover:bg-[var(--ezy-border)]"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="2,5 2,2 5,2" />
            <polyline points="10,7 10,10 7,10" />
            <polyline points="7,2 10,2 10,5" />
            <polyline points="5,10 2,10 2,7" />
          </svg>
        </button>
      )}
      <button
        data-pane-action="minimize"
        onClick={(e) => {
          e.stopPropagation();
          minimizePane(paneId);
        }}
        title="Minimize back into grid"
        className="p-1 rounded transition-colors hover:bg-[var(--ezy-border)]"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <line x1="2.5" y1="9.5" x2="9.5" y2="9.5" />
        </svg>
      </button>
      <button
        data-pane-action="close"
        onClick={(e) => {
          e.stopPropagation();
          callbacks.onClose(paneId);
        }}
        title="Close pane"
        className="p-1 rounded transition-colors hover:bg-[var(--ezy-border)]"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className="hover:!stroke-[var(--ezy-red)]">
          <line x1="3" y1="3" x2="9" y2="9" />
          <line x1="9" y1="3" x2="3" y2="9" />
        </svg>
      </button>
    </div>
  );

  // Resize handles (only when floating)
  const resizeHandles = mode === "float" ? (
    <>
      <div onPointerDown={handleResizePointerDown("n")} style={{ position: "absolute", top: 0, left: 6, right: 6, height: 5, cursor: "ns-resize", zIndex: 2 }} />
      <div onPointerDown={handleResizePointerDown("s")} style={{ position: "absolute", bottom: 0, left: 6, right: 6, height: 5, cursor: "ns-resize", zIndex: 2 }} />
      <div onPointerDown={handleResizePointerDown("e")} style={{ position: "absolute", top: 6, right: 0, bottom: 6, width: 5, cursor: "ew-resize", zIndex: 2 }} />
      <div onPointerDown={handleResizePointerDown("w")} style={{ position: "absolute", top: 6, left: 0, bottom: 6, width: 5, cursor: "ew-resize", zIndex: 2 }} />
      <div onPointerDown={handleResizePointerDown("nw")} style={{ position: "absolute", top: 0, left: 0, width: 10, height: 10, cursor: "nwse-resize", zIndex: 3 }} />
      <div onPointerDown={handleResizePointerDown("ne")} style={{ position: "absolute", top: 0, right: 0, width: 10, height: 10, cursor: "nesw-resize", zIndex: 3 }} />
      <div onPointerDown={handleResizePointerDown("sw")} style={{ position: "absolute", bottom: 0, left: 0, width: 10, height: 10, cursor: "nesw-resize", zIndex: 3 }} />
      <div onPointerDown={handleResizePointerDown("se")} style={{ position: "absolute", bottom: 0, right: 0, width: 10, height: 10, cursor: "nwse-resize", zIndex: 3 }} />
    </>
  ) : null;

  return (
    <div ref={wrapperRef} style={wrapperStyle} data-floating-pane-id={paneId} data-floating-zindex={zIndex} onMouseDown={onWrapperClick}>
      <div
        onPointerDown={handleHeaderPointerDown}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest("[data-pane-action]")) return;
          if (mode === "expanded") popoutPane(paneId);
          else if (mode === "float") expandPane(paneId);
        }}
        style={{
          height: HEADER_H,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 6px 0 10px",
          backgroundColor: "var(--ezy-surface)",
          borderBottom: "1px solid var(--ezy-border-subtle)",
          cursor: mode === "float" ? "move" : "default",
          userSelect: "none",
        }}
      >
        <div
          className="text-xs"
          style={{
            color: "var(--ezy-text-secondary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            minWidth: 0,
          }}
        >
          {paneTitle}
        </div>
        {buttons}
      </div>
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {node.type === "terminal" ? (
          <div ref={slotMountTargetRef} className="h-full w-full" />
        ) : node.type === "browser" ? (
          // Anchor for the fixed-position browser slot owned by Workspace.
          <div
            data-browser-pane-id={node.id}
            className="h-full w-full"
          />
        ) : (
          renderLeafPane(node, callbacks)
        )}
      </div>
      {resizeHandles}
    </div>
  );
}
