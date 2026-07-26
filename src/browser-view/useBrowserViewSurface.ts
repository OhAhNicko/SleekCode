// Lifecycle + geometry driver for the native browser pane's surface.
//
// Ported from TerminalPaneNative's driver (TerminalPaneNative.tsx:703-774) rather
// than reinvented — the constraints are identical because both are OS surfaces
// parked over a DOM anchor:
//
//   - Continuous rAF, NOT ResizeObserver. RO misses position-only changes (a
//     header settling into flow) and coalesces during a fast divider drag. RO is
//     demoted to resetting the no-change guard.
//   - `checkVisibility({visibilityProperty:true})` as well as the rect check:
//     a parked subtree can keep a non-zero bounding rect while being invisible.
//   - Bounds are pushed BEFORE flipping layout visibility, so the surface can
//     never appear for a frame at its previous position.
//   - Visibility goes through the shared owner in native-term/visibility.ts.
//     Two owners would race this per-frame loop — one re-showing what the other
//     just hid.

import { useEffect, useRef, useState } from "react";
import { surfaceRectOf, type Rect } from "../lib/native-term-bridge";
import {
  anyFloatingWindow,
  isOccluded,
  OCCLUDER_SELECTOR,
} from "../native-term/occlusion";
import {
  forgetBrowser,
  setBrowserLayoutVisible,
  setBrowserOccluded,
} from "../native-term/visibility";
import {
  browserViewCreate,
  browserViewDestroy,
  browserViewSetBounds,
  type BrowserViewId,
} from "./bridge";

interface Options {
  /** Anchor whose rect the surface tracks. */
  anchorRef: React.RefObject<HTMLDivElement | null>;
  /** URL to open when the surface is first created. */
  initialUrl: string;
  /** When false, no surface is created (the pane is running the iframe). */
  enabled: boolean;
  /** Logical CSS px corner radius to clip the surface to; 0 = square.
   *  A child HWND ignores CSS border-radius / overflow:hidden, so the pane's
   *  rounded frame under a viewport preset must be reproduced as a Win32
   *  region or the corners render square over it. */
  cornerRadius: number;
  /** Force the surface hidden even though it is laid out.
   *
   *  Needed because DOM can never paint above a child HWND: any panel anchored
   *  over the pane (the downloads shelf) would be swallowed by the webview.
   *  Routed through the same occlusion input the floating-window rule uses, so
   *  there is still exactly ONE owner of visibility. */
  hidden?: boolean;
}

interface Result {
  id: BrowserViewId | null;
  /** Non-null once Rust has refused to open the pane (bad URL, no parent HWND). */
  error: string | null;
}

export function useBrowserViewSurface({
  anchorRef,
  initialUrl,
  enabled,
  cornerRadius,
  hidden = false,
}: Options): Result {
  const [id, setId] = useState<BrowserViewId | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Read through a ref so changing the URL never tears the surface down —
  // navigation is a command, not a remount.
  const initialUrlRef = useRef(initialUrl);
  initialUrlRef.current = initialUrl;

  // Read through a ref too: switching viewport preset changes the radius but
  // must never tear the surface down and reload the page.
  const radiusRef = useRef(cornerRadius);
  radiusRef.current = cornerRadius;

  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;

  useEffect(() => {
    if (!enabled) return;
    const el = anchorRef.current;
    if (!el) return;

    let cancelled = false;
    let createdId: BrowserViewId | null = null;
    let geomRafId = 0;
    let raf2Id = 0;

    // Two nested rAFs before asking for a window: the pane grid can report a
    // 0x0 rect for a frame or two right after mount.
    const raf1 = requestAnimationFrame(() => {
      raf2Id = requestAnimationFrame(() => {
        void (async () => {
          let newId: BrowserViewId;
          try {
            newId = await browserViewCreate(
              initialUrlRef.current,
              surfaceRectOf(el),
              window.devicePixelRatio,
            );
          } catch (e) {
            console.error("[browser-view] create FAILED", e);
            if (!cancelled) setError(String(e));
            return;
          }
          if (cancelled) {
            // Lost the race with unmount — tear down immediately rather than
            // leaking a surface nobody holds.
            void browserViewDestroy(newId).catch(() => {});
            return;
          }
          createdId = newId;
          setId(newId);
          startGeometryLoop(newId);
        })();
      });
    });

    function startGeometryLoop(viewId: BrowserViewId) {
      let lastGeomJson = "";
      // Single-in-flight backpressure, mirroring frameSync's guard for the
      // terminal panes. Each bounds push is a round trip to the MAIN thread; a
      // fast drag emits one per frame, and without this they queue faster than
      // the main thread drains them. (The blocking version of this call is what
      // wedged the app on 2026-07-26 — keep the pressure bounded.)
      let inFlight = false;
      // Self-heal. The change-guard suppresses identical pushes, which means one
      // missed or dropped update leaves the webview parked at a stale rect
      // FOREVER — a child HWND does not re-layout itself. Re-assert the current
      // bounds a couple of times a second so any such gap corrects itself within
      // ~500ms instead of needing a pane resize to shake it loose.
      let lastHeal = 0;
      const HEAL_INTERVAL_MS = 500;

      const pushGeom = () => {
        // Re-arm FIRST so an exception below cannot kill the loop.
        geomRafId = requestAnimationFrame(pushGeom);
        const node = anchorRef.current;
        if (!node || !node.isConnected) return;

        const rect: Rect = surfaceRectOf(node);
        const domVisible = node.checkVisibility
          ? node.checkVisibility({ visibilityProperty: true })
          : true;

        if (!domVisible || rect.width <= 0 || rect.height <= 0) {
          setBrowserLayoutVisible(viewId, false);
          // Clear the guard so the next visible frame re-pushes geometry that
          // may have changed while hidden.
          lastGeomJson = "";
          return;
        }

        if (hiddenRef.current) {
          // Explicit suppression wins over the geometric test.
          setBrowserOccluded(viewId, true);
        } else if (anyFloatingWindow()) {
          const floatHost = node.closest<HTMLElement>(OCCLUDER_SELECTOR);
          setBrowserOccluded(
            viewId,
            isOccluded(rect, floatHost?.dataset.floatingMode ?? null),
          );
        } else {
          setBrowserOccluded(viewId, false);
        }

        const dpr = window.devicePixelRatio;
        const radius = radiusRef.current;
        // Radius is part of the guard: the region is in client coords, so a
        // preset change with an unchanged rect still needs a re-apply.
        const json = JSON.stringify([rect, dpr, radius]);
        const now = performance.now();
        if (now - lastHeal > HEAL_INTERVAL_MS) {
          lastHeal = now;
          lastGeomJson = "";
        }
        if (json !== lastGeomJson && !inFlight) {
          lastGeomJson = json;
          inFlight = true;
          void browserViewSetBounds(viewId, rect, dpr, radius)
            .catch(() => {})
            .finally(() => {
              inFlight = false;
            });
        } else if (json !== lastGeomJson) {
          // Dropped this frame; clear the guard so the NEXT frame re-pushes the
          // current rect. Never leave the surface at a stale position.
          lastGeomJson = "";
        }

        // AFTER the bounds push, so the hidden -> visible transition shows the
        // surface at its current position, never its previous one.
        setBrowserLayoutVisible(viewId, true);
      };

      geomRafId = requestAnimationFrame(pushGeom);
    }

    // RO only invalidates the change-guard; the rAF loop does the pushing.
    const ro = new ResizeObserver(() => {
      /* guard reset happens naturally: the next frame sees a different rect */
    });
    ro.observe(el);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1);
      if (raf2Id) cancelAnimationFrame(raf2Id);
      if (geomRafId) cancelAnimationFrame(geomRafId);
      ro.disconnect();
      if (createdId != null) {
        // forget BEFORE destroy — a leftover entry would keep a dead id in the
        // modal reconcile loop.
        forgetBrowser(createdId);
        void browserViewDestroy(createdId).catch(() => {});
      }
    };
  }, [enabled, anchorRef]);

  return { id, error };
}
