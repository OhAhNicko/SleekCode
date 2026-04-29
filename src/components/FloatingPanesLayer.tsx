import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PaneLayout } from "../types";
import { useAppStore } from "../store";
import FloatingPaneWindow from "./FloatingPaneWindow";
import type { RenderLeafCallbacks } from "../lib/render-pane";
import { computeLeafRect } from "../lib/layout-utils";

/**
 * Module-level registry: in-grid pane buttons capture their pane's rect at
 * click time and stash it here. The layer reads this when a pane first appears
 * in paneModes so the open animation can FLIP from the grid slot.
 */
export const paneFromRectRegistry = new Map<string, DOMRect>();

interface FloatingPanesLayerProps {
  layout: PaneLayout | null;
  callbacks: RenderLeafCallbacks;
  paneTitleFor: (node: PaneLayout) => string;
}

function findLeafById(node: PaneLayout, id: string): PaneLayout | null {
  if (node.id === id) return node;
  if (node.type === "split") {
    return findLeafById(node.children[0], id) ?? findLeafById(node.children[1], id);
  }
  return null;
}

function queryGridContainerRect(): DOMRect | null {
  const el = document.querySelector("[data-grid-root]") as HTMLElement | null;
  return el ? el.getBoundingClientRect() : null;
}

interface Tracked {
  liveMode: "expanded" | "float" | "closing";
  node: PaneLayout;
  fromRect?: DOMRect;
  closeTargetRect?: DOMRect;
}

function rectFromBox(box: { left: number; top: number; width: number; height: number }): DOMRect {
  return new DOMRect(box.left, box.top, box.width, box.height);
}

export default function FloatingPanesLayer({ layout, callbacks, paneTitleFor }: FloatingPanesLayerProps) {
  const paneModes = useAppStore((s) => s.paneModes);
  const closingPanes = useAppStore((s) => s.closingPanes);
  const floatOrder = useAppStore((s) => s.floatOrder);
  const markClosed = useAppStore((s) => s.markClosed);

  const [tracked, setTracked] = useState<Map<string, Tracked>>(new Map());
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // Reconcile tracked map with store state. Use useLayoutEffect so the closing
  // target rect is computed before the next paint, avoiding a one-frame flash.
  useLayoutEffect(() => {
    if (!layout) {
      // Layout torn down; flush all tracked panes.
      setTracked((prev) => {
        if (prev.size === 0) return prev;
        return new Map();
      });
      return;
    }

    setTracked((prev) => {
      const next = new Map(prev);

      // 1. Add or update panes that are present in paneModes
      for (const [id, mode] of Object.entries(paneModes)) {
        if (mode !== "expanded" && mode !== "float") continue;
        const node = findLeafById(layout, id);
        if (!node) continue;
        const existing = next.get(id);
        if (!existing) {
          const fromRect = paneFromRectRegistry.get(id);
          paneFromRectRegistry.delete(id);
          next.set(id, { liveMode: mode, node, fromRect });
        } else if (existing.liveMode !== mode) {
          next.set(id, { ...existing, liveMode: mode, node });
        } else if (existing.node !== node) {
          next.set(id, { ...existing, node });
        }
      }

      // 2. Move panes that just dropped from paneModes into "closing" state.
      //    Compute target rect analytically from the layout tree.
      for (const [id, entry] of next) {
        const inStore = paneModes[id] === "expanded" || paneModes[id] === "float";
        if (inStore) continue;
        if (entry.liveMode === "closing") continue;
        const containerRect = queryGridContainerRect();
        const targetBox = containerRect
          ? computeLeafRect(layout, id, {
              left: containerRect.left,
              top: containerRect.top,
              width: containerRect.width,
              height: containerRect.height,
            })
          : null;
        next.set(id, {
          ...entry,
          liveMode: "closing",
          closeTargetRect: targetBox ? rectFromBox(targetBox) : undefined,
        });
      }

      // 3. Drop panes that are neither in store nor in closingPanes (forced cleanup,
      //    e.g. layout removed them entirely without an animation pass).
      for (const id of Array.from(next.keys())) {
        const inStore = paneModes[id] === "expanded" || paneModes[id] === "float";
        const inClosing = !!closingPanes[id];
        if (!inStore && !inClosing && next.get(id)?.liveMode === "closing") {
          // Animation already finished and store cleaned up — skip removal here;
          // handleClosingDone manages it. But if the entry exists with no closing
          // marker, drop it.
        }
      }

      return next;
    });
  }, [paneModes, closingPanes, layout]);

  // When the FloatingPaneWindow signals end of close animation, clear store + local state
  const handleClosingDone = (paneId: string) => {
    markClosed(paneId);
    setTracked((prev) => {
      const next = new Map(prev);
      next.delete(paneId);
      return next;
    });
  };

  // Useful safety: if a pane is somehow stuck in closingPanes for too long
  // (e.g. tab switched mid-animation), force-clear after 2× the animation budget.
  useEffect(() => {
    const ids = Object.keys(closingPanes);
    if (ids.length === 0) return;
    const t = window.setTimeout(() => {
      for (const id of ids) markClosed(id);
    }, 800);
    return () => window.clearTimeout(t);
  }, [closingPanes, markClosed]);

  const orderedIds = Array.from(tracked.keys()).sort((a, b) => {
    const ai = floatOrder.indexOf(a);
    const bi = floatOrder.indexOf(b);
    return (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi);
  });

  const hasExpanded = orderedIds.some((id) => tracked.get(id)?.liveMode === "expanded");
  const minimizePane = useAppStore((s) => s.minimizePane);

  const onBackdropClick = () => {
    // Minimize the topmost expanded pane (only one can be expanded at a time).
    const expandedId = [...orderedIds].reverse().find((id) => tracked.get(id)?.liveMode === "expanded");
    if (expandedId) minimizePane(expandedId);
  };

  return (
    <>
      {hasExpanded && (
        <div
          onClick={onBackdropClick}
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(0,0,0,0.55)",
            zIndex: 349,
          }}
        />
      )}
      {orderedIds.map((id, idx) => {
        const t = tracked.get(id);
        if (!t) return null;
        const isTopmost = idx === orderedIds.length - 1;
        return (
          <FloatingPaneWindow
            key={id}
            paneId={id}
            node={t.node}
            mode={t.liveMode}
            zIndex={350 + idx}
            isTopmost={isTopmost}
            callbacks={callbacks}
            fromRect={t.fromRect}
            closeTargetRect={t.closeTargetRect}
            paneTitle={paneTitleFor(t.node)}
            onClosingDone={() => handleClosingDone(id)}
          />
        );
      })}
    </>
  );
}
