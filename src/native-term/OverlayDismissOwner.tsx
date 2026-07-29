// The single owner of "an outside interaction happened, close open popups".
//
// See src/lib/overlay-dismiss.ts for WHY dismissal moved out of the overlay
// window. This component installs the dismissal sources exactly once:
//   1. capture-phase pointerdown on main's DOM,
//   2. `pointer_down` from every live native pane HWND,
//   3. window blur (alt-tab / another app takes over),
//   4. (a suppressor, not a source) `overlay:interaction` pings — a press
//      INSIDE an overlay popup blurs main exactly like source 3, and the ping
//      is what tells the two apart.
//
// Mount once, near the app root. Renders nothing.
import { useEffect, useRef } from "react";
import { useAppStore } from "../store";
import { fireOverlayDismiss } from "../lib/overlay-dismiss";
import { listenOverlayInteraction } from "../lib/overlay-bridge";
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

  // A pointerdown INSIDE an overlay popup is not an outside interaction, but
  // it produces the same main-webview blur as a real focus loss: the overlay's
  // WebView2 child takes Win32 focus on the click (WS_EX_NOACTIVATE +
  // MA_NOACTIVATE stop ACTIVATION from moving, not Chromium's SetFocus), and
  // for a non-focus-handoff popup nothing ever sets overlayFocused — so the
  // deferred blur check below sampled appWindowFocused === false and dismissed
  // the very menu being clicked (recent-menu quick/backend toggles, which are
  // documented to keep the menu open). The overlay reports its pointerdowns
  // (see overlay-bridge listenOverlayInteraction); a blur explained by a fresh
  // ping is an intra-app handoff, never an outside click.
  const lastOverlayInteractionAt = useRef(0);

  // Main-webview pointerdown + app blur.
  useEffect(() => {
    // CAPTURE phase so a component that stops propagation (menus, editors,
    // drag handles) cannot swallow the dismissal — the same trap that made
    // Settings dropdowns unscrollable when a bubble-phase listener was used.
    const onPointerDown = (e: PointerEvent) => fireOverlayDismiss(e.target);

    // A DOM `blur` on the main webview does NOT mean MADE lost focus.
    //
    // On Windows, WebView2 fires LostFocus whenever a SIBLING HWND takes Win32
    // focus — a native terminal pane, the embedded browser view, or the overlay
    // window itself. All three are still MADE. This handler used to dismiss on
    // that raw event, which is why clicking a dropdown trigger closed the menu
    // it had just opened, roughly two times in five (2026-07-27 report).
    //
    // It was a pure race, and the trace showed both sides of it: every trigger
    // click produced a blur ~20ms later. When the blur landed BEFORE the menu
    // opened (~100ms after the click) it dismissed nothing and the menu worked;
    // when it landed after, the menu died with no item ever clicked. Same code
    // path, opposite outcome, decided only by scheduling — hence "sometimes".
    //
    // The store already derives the honest signal for exactly this reason:
    // `appWindowFocused = webviewFocused || nativePaneFocused || overlayFocused
    // || browserViewFocused` (see nativeRendererSlice, and the same Windows
    // quirk documented on the caret in TerminalPaneNative). Dismissal just never
    // used it.
    //
    // The deferral is not a debounce-until-it-works: during an intra-app handoff
    // `appWindowFocused` legitimately DIPS to false for a moment, because the
    // webview's blur arrives over the DOM before the new owner's focus_gained
    // arrives over the event bus. The codebase already names this "the
    // appWindowFocused dip-and-recover". Sampling once on the trailing edge is
    // what distinguishes a real alt-tab (still false) from a handoff (recovered).
    const BLUR_DISMISS_GRACE_MS = 150;
    // How fresh an overlay ping must be to explain a blur. The press lands
    // 0–40 ms before the blur and this check runs BLUR_DISMISS_GRACE_MS after
    // it, so a ping that caused the blur is ~150–200 ms old here; 400 ms
    // leaves margin for event-bus latency without masking real focus losses
    // (an actual outside click fires its own pointerdown-based dismissal
    // regardless of this timer).
    const OVERLAY_INTERACTION_GRACE_MS = 400;
    let blurTimer: ReturnType<typeof setTimeout> | undefined;
    const onBlur = () => {
      clearTimeout(blurTimer);
      blurTimer = setTimeout(() => {
        const s = useAppStore.getState() as StoreWithNative;
        if (s.appWindowFocused) return; // focus stayed inside MADE — not an outside click
        if (
          performance.now() - lastOverlayInteractionAt.current <
          OVERLAY_INTERACTION_GRACE_MS
        )
          return; // blur caused by a click INSIDE an overlay popup
        fireOverlayDismiss(null);
      }, BLUR_DISMISS_GRACE_MS);
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      clearTimeout(blurTimer);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // Overlay pointerdown pings (source 4 — see lastOverlayInteractionAt).
  useEffect(() => {
    let un: Unlisten | undefined;
    let disposed = false;
    void listenOverlayInteraction(() => {
      lastOverlayInteractionAt.current = performance.now();
    }).then((u) => {
      if (disposed) u();
      else un = u;
    });
    return () => {
      disposed = true;
      un?.();
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
