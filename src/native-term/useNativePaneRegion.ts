import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getOverlayRectInPane } from "./geometry";
import type { Rect } from "../lib/native-term-bridge";
import { dropPendingRegion, isDragActive, queueRegion } from "./frameSync";
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

// Always the production `native_term_set_region` — it operates on any
// registry id. (The Phase-0 debug alias it once shadowed was deleted in P7a;
// pinning the production name here is why that removal was a no-op for this
// hook.)
function commandFor(_isPhase0Spike: boolean): string {
  return "native_term_set_region";
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

      // P4b: coarsen during splitter drags — skip hole recomputation
      // entirely while PaneGrid reports a drag in flight (geometry keeps
      // flowing via queueGeom so panes track the splitter). On release
      // PaneGrid clears the flag and the next tick recomputes; the
      // lastEmitJsonRef guard re-emits only if the holes actually changed.
      if (isDragActive()) return;

      const paneRect = pane.getBoundingClientRect();
      if (paneRect.width <= 0 || paneRect.height <= 0) return;

      const rects: Rect[] = [];

      if (overlayRefs !== undefined) {
        // Prop-drilled mode (spike): convert each overlayRef directly.
        for (const ref of overlayRefs) {
          const r = getOverlayRectInPane(ref.current, pane);
          if (r) rects.push(r);
        }
      } else {
        // Slice-sourced mode: read global publishers, intersect with pane.
        const globalMap = (useAppStore.getState() as StoreWithOverlaySlice)
          .overlayRects;
        if (globalMap.size > 0) {
          for (const viewportRect of globalMap.values()) {
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

      // P4b: route through the frame-sync coalescer — this pane's holes
      // merge with every pane's geometry/holes for the frame into ONE
      // `native_term_frame_sync` invoke. Stale-id failures are logged
      // Rust-side as benign partial failures.
      queueRegion(termId, rects);
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
      // Drop any queued-but-unflushed hole update for this id BEFORE the
      // direct clear below — otherwise the coalescer could flush stale
      // holes one frame AFTER the clear. Teardown stays a direct invoke
      // (no rAF dependency while unmounting).
      dropPendingRegion(termId);
      invoke(cmd, { id: termId, holes: [] }).catch((e) =>
        console.warn("[native-term/region] set_region cleanup rejected:", e),
      );
    };
  }, [termId, paneRef, overlayRefs, isPhase0Spike]);
}
