import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getOverlayRectInPane } from "./geometry";
import type { Rect } from "../lib/native-term-bridge";
import { useAppStore } from "../store";
import type { OverlayRegionSlice } from "../store/overlayRegionSlice";

type ParamsPropDrilled = {
  termId: number;
  paneRef: React.RefObject<HTMLElement | null>;
  overlayRefs: ReadonlyArray<React.RefObject<HTMLElement | null>>;
};

type ParamsSliceSourced = {
  termId: number;
  paneRef: React.RefObject<HTMLElement | null>;
  overlayRefs?: undefined;
};

type Params = ParamsPropDrilled | ParamsSliceSourced;

type StoreWithOverlaySlice = ReturnType<typeof useAppStore.getState> &
  OverlayRegionSlice;

// Phase 0 spike command (deleted at Phase 0 retirement); Phase 1 native command.
function commandFor(isPhase0Spike: boolean): string {
  return isPhase0Spike ? "native_term_spike_set_region" : "native_term_set_region";
}

export function useNativePaneRegion(params: Params): void {
  const { termId, paneRef } = params;
  const overlayRefs = "overlayRefs" in params ? params.overlayRefs : undefined;
  const isPhase0Spike = overlayRefs !== undefined;

  const lastEmitJsonRef = useRef<string>("");
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;

    let cancelled = false;
    const cmd = commandFor(isPhase0Spike);

    const tick = () => {
      if (cancelled) return;
      rafRef.current = requestAnimationFrame(tick);

      const paneRect = pane.getBoundingClientRect();
      if (paneRect.width <= 0 || paneRect.height <= 0) return;

      const rects: Rect[] = [];

      if (overlayRefs !== undefined) {
        for (const ref of overlayRefs) {
          const r = getOverlayRectInPane(ref.current, pane);
          if (r) rects.push(r);
        }
      } else {
        const inner = (useAppStore.getState() as StoreWithOverlaySlice)
          .overlayRectsByTerm.get(termId);
        if (inner) {
          for (const viewportRect of inner.values()) {
            const ix1 = Math.max(viewportRect.x, paneRect.left);
            const iy1 = Math.max(viewportRect.y, paneRect.top);
            const ix2 = Math.min(
              viewportRect.x + viewportRect.width,
              paneRect.right,
            );
            const iy2 = Math.min(
              viewportRect.y + viewportRect.height,
              paneRect.bottom,
            );
            if (ix2 <= ix1 || iy2 <= iy1) continue;
            rects.push({
              x: ix1 - paneRect.left,
              y: iy1 - paneRect.top,
              width: ix2 - ix1,
              height: iy2 - iy1,
            });
          }
        }
      }

      const json = JSON.stringify(rects);
      if (json === lastEmitJsonRef.current) return;
      lastEmitJsonRef.current = json;

      invoke(cmd, { id: termId, holes: rects }).catch((e) =>
        console.warn("[native-term/region] set_region rejected:", e),
      );
    };

    rafRef.current = requestAnimationFrame(tick);

    const ro = new ResizeObserver(() => {
      lastEmitJsonRef.current = "";
    });
    ro.observe(pane);

    return () => {
      cancelled = true;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      ro.disconnect();
      invoke(cmd, { id: termId, holes: [] }).catch((e) =>
        console.warn("[native-term/region] set_region cleanup rejected:", e),
      );
    };
  }, [termId, paneRef, overlayRefs, isPhase0Spike]);
}
