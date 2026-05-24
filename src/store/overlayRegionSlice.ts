// Overlay region coordination for the native terminal renderer.
//
// Every React overlay that paints on top of a native pane publishes its
// viewport-relative rect here (via `useOverlayPublisher`). The hole-cut
// consumer (`useNativePaneRegion`) reads from this slice and converts
// to pane-local at the rAF tick using its own paneRef.
//
// Rect storage convention: VIEWPORT-COORDS (`getBoundingClientRect()`
// output), NOT pane-local. Decoupling publishers from pane position
// lets overlays publish without knowing where their pane lives in the
// DOM tree. Pane-local conversion happens at consumption.
import { useEffect, useLayoutEffect, useMemo } from "react";
import type { StateCreator } from "zustand";
import type { Rect } from "../lib/native-term-bridge";
import { useAppStore } from "./index";

export interface OverlayRegionSlice {
  overlayRectsByTerm: Map<number, Map<string, Rect>>;
  publishOverlayRect: (termId: number, key: string, rect: Rect | null) => void;
  clearOverlaysForTerm: (termId: number) => void;
}

export const createOverlayRegionSlice: StateCreator<
  OverlayRegionSlice,
  [],
  [],
  OverlayRegionSlice
> = (set) => ({
  overlayRectsByTerm: new Map(),

  publishOverlayRect: (termId, key, rect) => {
    set((state) => {
      const prevInner = state.overlayRectsByTerm.get(termId);

      if (rect === null) {
        if (!prevInner || !prevInner.has(key)) return state;
        const nextInner = new Map(prevInner);
        nextInner.delete(key);
        const nextOuter = new Map(state.overlayRectsByTerm);
        if (nextInner.size === 0) {
          nextOuter.delete(termId);
        } else {
          nextOuter.set(termId, nextInner);
        }
        return { overlayRectsByTerm: nextOuter };
      }

      const existing = prevInner?.get(key);
      if (
        existing &&
        existing.x === rect.x &&
        existing.y === rect.y &&
        existing.width === rect.width &&
        existing.height === rect.height
      ) {
        return state;
      }

      const nextInner = new Map(prevInner ?? []);
      nextInner.set(key, rect);
      const nextOuter = new Map(state.overlayRectsByTerm);
      nextOuter.set(termId, nextInner);
      return { overlayRectsByTerm: nextOuter };
    });
  },

  clearOverlaysForTerm: (termId) => {
    set((state) => {
      if (!state.overlayRectsByTerm.has(termId)) return state;
      const nextOuter = new Map(state.overlayRectsByTerm);
      nextOuter.delete(termId);
      return { overlayRectsByTerm: nextOuter };
    });
  },
});

// TODO(O1 store register): once src/store/index.ts intersects this slice
// into AppStore, drop these casts. M-list edit deferred to lead.
type StoreWithThisSlice = ReturnType<typeof useAppStore.getState> &
  OverlayRegionSlice;

// Publisher hook — every overlay calls this on mount. Re-publishes on every
// layout change (ResizeObserver + window resize) and on every animation
// frame while the overlay is mounted (to catch transform/position changes
// that don't trigger ResizeObserver, e.g. cursor-tracking PromptComposer).
export function useOverlayPublisher(
  termId: number | null,
  key: string,
  overlayRef: React.RefObject<HTMLElement | null>,
): void {
  const publish = (useAppStore.getState() as StoreWithThisSlice).publishOverlayRect;

  useLayoutEffect(() => {
    if (termId == null) return;
    const el = overlayRef.current;
    if (!el) return;

    let raf = 0;
    let lastJson = "";

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) {
        if (lastJson !== "null") {
          lastJson = "null";
          publish(termId, key, null);
        }
        return;
      }
      const rect: Rect = { x: r.left, y: r.top, width: r.width, height: r.height };
      const json = `${rect.x},${rect.y},${rect.width},${rect.height}`;
      if (json === lastJson) return;
      lastJson = json;
      publish(termId, key, rect);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      publish(termId, key, null);
    };
  }, [termId, key, overlayRef, publish]);
}

// Selector hook returning a memoized array of rects for a term.
// Stable identity when the inner Map reference is stable (slice's
// copy-on-write semantics guarantee that).
export function useOverlayRectsForTerm(termId: number | null): readonly Rect[] {
  const inner = useAppStore((s) =>
    termId == null
      ? undefined
      : (s as StoreWithThisSlice).overlayRectsByTerm.get(termId),
  );
  return useMemo(() => (inner ? Array.from(inner.values()) : []), [inner]);
}

// Effect helper for native pane lifecycle: clear all overlays for a term
// when the pane unmounts. Call from TerminalPaneNative cleanup.
export function useClearOverlaysOnUnmount(termId: number | null): void {
  const clear = (useAppStore.getState() as StoreWithThisSlice).clearOverlaysForTerm;
  useEffect(() => {
    if (termId == null) return;
    return () => clear(termId);
  }, [termId, clear]);
}
