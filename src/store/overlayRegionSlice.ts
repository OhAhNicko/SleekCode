// Overlay region coordination for the native terminal renderer.
//
// Every React overlay that visually paints on top of a native pane publishes
// its viewport-relative rect here (via `useOverlayPublisher`). The hole-cut
// consumer (`useNativePaneRegion`, mounted per native pane in
// TerminalPaneNative) reads this global map every rAF, intersects each rect
// with the pane's bounding rect, and emits the resulting pane-local hole
// rectangles via `native_term_set_region` so the native HWND clips out the
// area underneath the React overlay. Pane stays visible everywhere the
// overlay ISN'T.
//
// Rect storage convention: VIEWPORT-COORDS (`getBoundingClientRect()`
// output), NOT pane-local. Decoupling publishers from pane position means
// overlays publish once regardless of how many native panes are live, and
// each pane independently computes its own hole set.
import { useEffect, useLayoutEffect, useMemo } from "react";
import type { StateCreator } from "zustand";
import type { Rect } from "../lib/native-term-bridge";
import { useAppStore } from "./index";

export interface OverlayRegionSlice {
  overlayRects: Map<string, Rect>;
  publishOverlayRect: (key: string, rect: Rect | null) => void;
}

export const createOverlayRegionSlice: StateCreator<
  OverlayRegionSlice,
  [],
  [],
  OverlayRegionSlice
> = (set) => ({
  overlayRects: new Map(),

  publishOverlayRect: (key, rect) => {
    set((state) => {
      const prev = state.overlayRects.get(key);

      if (rect === null) {
        if (!prev) return state;
        const next = new Map(state.overlayRects);
        next.delete(key);
        return { overlayRects: next };
      }

      if (
        prev &&
        prev.x === rect.x &&
        prev.y === rect.y &&
        prev.width === rect.width &&
        prev.height === rect.height
      ) {
        return state;
      }

      const next = new Map(state.overlayRects);
      next.set(key, rect);
      return { overlayRects: next };
    });
  },
});

type StoreWithThisSlice = ReturnType<typeof useAppStore.getState> &
  OverlayRegionSlice;

// Publisher hook — every overlay calls this on mount. Re-publishes on every
// animation frame while the overlay is mounted, so transform/position
// changes (e.g. animated slide-in) keep the hole tracking the overlay.
export function useOverlayPublisher(
  key: string,
  overlayRef: React.RefObject<HTMLElement | null>,
): void {
  const publish = (useAppStore.getState() as StoreWithThisSlice).publishOverlayRect;

  useLayoutEffect(() => {
    // Do NOT early-return on null ref: callers may render the popup body
    // conditionally and only attach the ref when shown. We start the rAF
    // loop unconditionally and the tick re-reads `overlayRef.current` each
    // frame, so it picks up the ref once the conditional renders.
    let raf = 0;
    let lastJson = "";

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = overlayRef.current;
      if (!el) {
        if (lastJson !== "null") {
          lastJson = "null";
          publish(key, null);
        }
        return;
      }
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) {
        if (lastJson !== "null") {
          lastJson = "null";
          publish(key, null);
        }
        return;
      }
      const rect: Rect = { x: r.left, y: r.top, width: r.width, height: r.height };
      const json = `${rect.x},${rect.y},${rect.width},${rect.height}`;
      if (json === lastJson) return;
      lastJson = json;
      publish(key, rect);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      publish(key, null);
    };
  }, [key, overlayRef, publish]);
}

// Convenience: call publishOverlayRect with `null` on unmount only.
// Useful for overlays whose rect doesn't change after mount (rare).
export function useStaticOverlayPublisher(
  key: string,
  rect: Rect | null,
): void {
  const publish = (useAppStore.getState() as StoreWithThisSlice).publishOverlayRect;
  useEffect(() => {
    publish(key, rect);
    return () => publish(key, null);
  }, [key, rect, publish]);
}

// Selector hook returning a memoized array of rects. Identity stable across
// renders when the underlying map reference hasn't changed (slice's
// copy-on-write semantics guarantee that).
export function useAllOverlayRects(): readonly Rect[] {
  const map = useAppStore((s) => (s as StoreWithThisSlice).overlayRects);
  return useMemo(() => Array.from(map.values()), [map]);
}
