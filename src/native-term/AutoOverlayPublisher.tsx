// Auto overlay publisher — fallback for any React popup that paints over a
// native HWND pane without an explicit `useOverlayPublisher` registration.
//
// Polls the DOM every 100ms for overlay-like elements (role=dialog/menu/
// listbox/tooltip, [data-cut-pane-hole], or any direct body child / one level
// deeper with computed position:fixed and z-index > 10). For each found
// element it publishes a viewport rect to overlayRegionSlice so the native
// pane underneath cuts a hole. Doubly-publishing (manual + auto for the same
// popup) is harmless: overlayRegionSlice's same-rect dedupe makes the second
// publish a no-op.
//
// Skips elements inside [data-pane-id] / [data-terminal-id] — in-pane
// overlays (ImeCompositionPopup, PaneSearchBar) publish EXPLICITLY with
// per-pane keys instead: over native GPU panes they NEED a hole to be
// visible at all (the old "would punch through our own pane" rationale was
// inverted for the native renderer), and explicit keys avoid this poller's
// generic keying.
//
// Mounted once in App.tsx near NativePaneVisibilityCoordinator.
import { useEffect } from "react";
import { useAppStore } from "../store";
import type { Rect } from "../lib/native-term-bridge";

const ROLE_SELECTOR =
  '[role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"], [data-cut-pane-hole]';
const POLL_MS = 100;
const MIN_SIZE = 4;

function collectCandidates(): Element[] {
  const out: Element[] = [];
  // Opt-in only: ARIA role or explicit data-cut-pane-hole attribute. The
  // earlier "scan body.children + one deeper for position:fixed z>10" was
  // too aggressive — it caught always-on chrome containers and hole-cut
  // the entire pane area before the HWND had a chance to render. Re-enable
  // a wider scan only with stricter qualification (e.g. requires also
  // matching a role) if specific popups need it.
  for (const el of document.querySelectorAll(ROLE_SELECTOR)) {
    out.push(el);
  }
  return out;
}

export function AutoOverlayPublisher(): null {
  useEffect(() => {
    const knownKeys = new WeakMap<Element, string>();
    let counter = 0;
    let lastFound = new Set<string>();
    const publish = useAppStore.getState().publishOverlayRect;

    const tick = () => {
      const candidates = collectCandidates();
      const found = new Map<string, Rect>();
      for (const el of candidates) {
        // Skip overlays inside a native pane — those are part of the pane
        // surface (IME popup, in-pane search). Cutting a hole would punch
        // through our own pane.
        if ((el as HTMLElement).closest("[data-terminal-id], [data-pane-id]")) {
          continue;
        }
        const r = el.getBoundingClientRect();
        if (r.width < MIN_SIZE || r.height < MIN_SIZE) continue;
        let key = knownKeys.get(el);
        if (!key) {
          key = `auto-${counter++}`;
          knownKeys.set(el, key);
        }
        found.set(key, { x: r.left, y: r.top, width: r.width, height: r.height });
      }
      // Publish/refresh every rect.
      for (const [k, r] of found) publish(k, r);
      // Clear keys that disappeared (popup closed / unmounted).
      for (const k of lastFound) {
        if (!found.has(k)) publish(k, null);
      }
      lastFound = new Set(found.keys());
    };

    const id = setInterval(tick, POLL_MS);
    tick();
    return () => {
      clearInterval(id);
      for (const k of lastFound) publish(k, null);
    };
  }, []);
  return null;
}
