// The single owner of "an outside interaction happened, close open popups".
//
// See src/lib/overlay-dismiss.ts for WHY dismissal moved out of the overlay
// window. This component installs the three sources exactly once:
//   1. capture-phase pointerdown on main's DOM,
//   2. `pointer_down` from every live native pane HWND,
//   3. window blur (alt-tab / another app takes over).
//
// Mount once, near the app root. Renders nothing.
import { useEffect, useRef } from "react";
import { useAppStore } from "../store";
import { fireOverlayDismiss } from "../lib/overlay-dismiss";
import type { NativeRendererSlice } from "../store/nativeRendererSlice";
import {
  subscribePointerDown,
  type NativeTermId,
} from "../lib/native-term-bridge";

/** The bridge keeps its unlisten type private; mirror it here. */
type Unlisten = () => void;

type StoreWithNative = ReturnType<typeof useAppStore.getState> &
  NativeRendererSlice;

export function OverlayDismissOwner(): null {
  const liveNativeTerms = useAppStore(
    (s) => (s as StoreWithNative).liveNativeTerms,
  );

  // Main-webview pointerdown + app blur.
  useEffect(() => {
    // CAPTURE phase so a component that stops propagation (menus, editors,
    // drag handles) cannot swallow the dismissal — the same trap that made
    // Settings dropdowns unscrollable when a bubble-phase listener was used.
    const onPointerDown = (e: PointerEvent) => fireOverlayDismiss(e.target);
    const onBlur = () => fireOverlayDismiss(null);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // Native panes are OS windows: their clicks never reach main's DOM, so each
  // live pane needs its own subscription. Re-runs when the live set changes;
  // ids that vanished are unsubscribed by the cleanup.
  const unlistensRef = useRef<Map<NativeTermId, Unlisten>>(new Map());
  useEffect(() => {
    const map = unlistensRef.current;
    for (const id of liveNativeTerms) {
      if (map.has(id)) continue;
      // Placeholder so a second effect run cannot double-subscribe while the
      // promise is still in flight.
      map.set(id, () => {});
      void subscribePointerDown(id, () => fireOverlayDismiss(null))
        .then((un) => {
          // The ONLY reason to drop it here is that the pane died while we were
          // subscribing — in which case the teardown loop below already removed
          // its entry. Do NOT key this on an effect-scoped "disposed" flag:
          // this effect re-runs on every live-set change, so its cleanup would
          // fire while the subscribe promise was still pending, the next run
          // would skip the id (placeholder present), and the resolving promise
          // would then unsubscribe it for good. That pane's clicks silently
          // stopped dismissing popups — the "pane right-click menus only close
          // 3 times out of 10" bug (user-reported 2026-07-26).
          if (!map.has(id)) {
            un();
            return;
          }
          map.set(id, un);
        })
        .catch(() => {
          map.delete(id);
        });
    }
    for (const [id, un] of map) {
      if (!liveNativeTerms.has(id)) {
        un();
        map.delete(id);
      }
    }
  }, [liveNativeTerms]);

  useEffect(() => {
    const map = unlistensRef.current;
    return () => {
      for (const un of map.values()) un();
      map.clear();
    };
  }, []);

  return null;
}
