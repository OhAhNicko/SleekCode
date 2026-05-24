// Single broadcaster that hides every live native pane while any modal is
// open and re-shows them on close. Mount once near the root of App.tsx
// (outside any per-pane tree). One IPC per modal transition × pane, not
// per modal × pane × frame.
//
// Modal-close flow per plan risk #6: avoid show-on-stale-bounds race —
// re-emit set_bounds from current paneRef.getBoundingClientRect(), await
// the Resized event, then show. That way the HWND comes back at the
// correct size if layout shifted while modals were up.
//
// NOTE: this is a no-op until consumers exist on both sides:
//   - modals call useModal(key) (sweep deferred — see modalCoordinationSlice.ts)
//   - native panes register via J's nativeRendererSlice live-terms registry
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { useAnyModalOpen } from "../store/modalCoordinationSlice";

// J's slice shape is being negotiated (lead said Set<number>, J pitched
// ReadonlyArray<number>). Either Iterable works for our iteration here.
// The selector below reads the raw value without filter/map.
type StoreWithLiveTerms = ReturnType<typeof useAppStore.getState> & {
  liveNativeTerms?: ReadonlySet<number> | ReadonlyArray<number>;
};

function selectLiveTerms(
  s: ReturnType<typeof useAppStore.getState>,
): ReadonlySet<number> | ReadonlyArray<number> | undefined {
  return (s as StoreWithLiveTerms).liveNativeTerms;
}

export function NativePaneVisibilityCoordinator(): null {
  const anyModalOpen = useAnyModalOpen();
  const liveTerms = useAppStore(selectLiveTerms);
  const lastBroadcastRef = useRef<boolean | null>(null);

  useEffect(() => {
    if (lastBroadcastRef.current === anyModalOpen) return;
    lastBroadcastRef.current = anyModalOpen;

    if (!liveTerms) return;
    const ids: number[] = [];
    for (const id of liveTerms) ids.push(id);
    if (ids.length === 0) return;

    if (anyModalOpen) {
      for (const id of ids) {
        invoke("native_term_hide", { id }).catch((e) =>
          console.warn("[native-term/visibility] hide rejected:", id, e),
        );
      }
      return;
    }

    // Modal-close: re-emit bounds, await Resized, then show.
    // Without the registry of paneRefs we can't re-emit set_bounds here —
    // J's TerminalPaneNative already owns the resize observer for its own
    // pane, so each pane self-corrects bounds via its existing
    // ResizeObserver effect. Coordinator's only job on the close path is
    // to call show after a single rAF (lets J's RO fire first).
    //
    // (When J wires this, the slice may also gain a `paneRefsByTerm` map;
    // until then the show path is just "wait 1 frame, then show".)
    const raf = requestAnimationFrame(() => {
      for (const id of ids) {
        invoke("native_term_show", { id }).catch((e) =>
          console.warn("[native-term/visibility] show rejected:", id, e),
        );
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [anyModalOpen, liveTerms]);

  return null;
}
