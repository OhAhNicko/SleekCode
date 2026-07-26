// Single owner of native-pane HWND visibility (native_term_show / _hide).
//
// A native pane is a Win32 CHILD WINDOW, not DOM. CSS cannot hide it: App.tsx
// keeps every project tab's <Workspace> mounted and only flips
// `display: none` on the wrapper, so before this module a pane whose tab went
// off screen kept painting over the tab you switched TO — the "panes from the
// previous project stay" bug (reported 2026-07-25, screenshots in
// docs/learnings/2026-07-25-native-panes-leak-across-tabs.md).
//
// TWO independent inputs decide whether a pane's HWND may be on screen:
//
//   LAYOUT  — is the pane's anchor div actually laid out? Driven per-pane by
//             TerminalPaneNative's rAF geometry loop, which already reads the
//             anchor rect every frame. A zero-size rect means the pane is
//             inside a display:none subtree (inactive tab) or collapsed —
//             either way the HWND must not be visible.
//   MODALS  — a fullscreen modal renders in the MAIN webview and the GPU panes
//             would paint over it, so every pane hides while one is open
//             (NativePaneVisibilityCoordinator).
//   OCCLUSION — an expanded / floating pane window is also DOM, and a grid
//             pane's HWND would paint over its chrome (and through its
//             backdrop scrim). See occlusion.ts for the rule; the pane's
//             geometry driver evaluates it per frame.
//
// They MUST share one owner. With two independent hide/show callers the layout
// driver would re-show, on its very next frame, a pane the modal coordinator
// just hid — painting the pane straight over the modal. Here the effective
// value is `layoutVisible && !modalsOpen` and an invoke is sent ONLY when that
// value changes, so neither input can clobber the other.
//
// `applied` starts at TRUE because CreateWindowExW makes the child
// WS_VISIBLE (win32.rs) — a freshly created pane is already on screen, so the
// first reconcile must be able to send a HIDE (pane created inside a hidden
// tab during session restore, or while a modal is open) and must NOT send a
// redundant SHOW for the normal case.

import {
  nativeTermHide,
  nativeTermShow,
  type NativeTermId,
} from "../lib/native-term-bridge";
import { browserViewHide, browserViewShow } from "../browser-view/bridge";
import { flushNow } from "./frameSync";

// TWO SURFACE KINDS, ONE OWNER (added 2026-07-26).
//
// The native browser pane is a wry webview in a child HWND — a different Rust
// module, but the SAME operating-system problem this file exists for: CSS can't
// hide it, a modal must hide it, and an expanded/floating window must hide it.
// It therefore shares this owner rather than getting a parallel one. A second
// owner would reintroduce exactly the bug the header describes: two callers
// racing the per-frame layout driver, one re-showing what the other just hid.
//
// Entries are keyed `${kind}:${id}` because the two id spaces are independent
// (both count from 1 in their own Rust registry).
export type SurfaceKind = "term" | "browser";

type Entry = {
  /** Anchor div is laid out with a non-zero rect. */
  layoutVisible: boolean;
  /** Covered by an expanded / floating pane window (see occlusion.ts). */
  occluded: boolean;
  /** Visibility we last pushed to Rust. Seeded true — see header. */
  applied: boolean;
  /** Push visibility for this surface kind. */
  show: () => void;
  hide: () => void;
  /** Land any queued geometry before the show. See reconcile(). */
  beforeShow?: () => void;
};

const panes = new Map<string, Entry>();
let modalsOpen = false;

const keyOf = (kind: SurfaceKind, id: number) => `${kind}:${id}`;

function reconcile(e: Entry): void {
  const want = e.layoutVisible && !e.occluded && !modalsOpen;
  if (want === e.applied) return;
  e.applied = want;
  if (want) {
    // The pane's driver queues its (possibly stale — the layout may have
    // changed while the tab was hidden) geometry in the SAME tick, right
    // before flipping visibility. Flush it now so the move lands before the
    // show and the pane can't appear for a frame at its old position.
    e.beforeShow?.();
    e.show();
  } else {
    e.hide();
  }
}

function entryFor(kind: SurfaceKind, id: number): Entry {
  const key = keyOf(kind, id);
  let e = panes.get(key);
  if (!e) {
    // Seeded from the surface's birth state: `applied: true` because both
    // kinds are born visible — CreateWindowExW makes the terminal child
    // WS_VISIBLE, and wry's container HWND is likewise created shown (see
    // header) — and not yet known to be laid out.
    e =
      kind === "term"
        ? {
            layoutVisible: false,
            occluded: false,
            applied: true,
            show: () => void nativeTermShow(id).catch(() => {}),
            hide: () => void nativeTermHide(id).catch(() => {}),
            beforeShow: flushNow,
          }
        : {
            layoutVisible: false,
            occluded: false,
            applied: true,
            show: () => void browserViewShow(id).catch(() => {}),
            hide: () => void browserViewHide(id).catch(() => {}),
            // The browser driver pushes bounds synchronously before flipping
            // layout visibility, so there is no queue to flush here.
          };
    panes.set(key, e);
  }
  return e;
}

/** Per-pane layout visibility — is the anchor laid out with a real rect?
 *  Called every frame by TerminalPaneNative's geometry driver. */
export function setPaneLayoutVisible(
  id: NativeTermId,
  visible: boolean,
): void {
  const e = entryFor("term", id);
  e.layoutVisible = visible;
  reconcile(e);
}

/** Per-pane occlusion by an expanded / floating pane window (occlusion.ts). */
export function setPaneOccluded(id: NativeTermId, occluded: boolean): void {
  const e = entryFor("term", id);
  e.occluded = occluded;
  reconcile(e);
}

/* ---- Native browser pane (wry webview in a child HWND) ---- */

/** Browser-pane layout visibility — same contract as setPaneLayoutVisible. */
export function setBrowserLayoutVisible(id: number, visible: boolean): void {
  const e = entryFor("browser", id);
  e.layoutVisible = visible;
  reconcile(e);
}

/** Browser-pane occlusion by an expanded / floating pane window. */
export function setBrowserOccluded(id: number, occluded: boolean): void {
  const e = entryFor("browser", id);
  e.occluded = occluded;
  reconcile(e);
}

/** Drop a destroyed browser view's entry. */
export function forgetBrowser(id: number): void {
  panes.delete(keyOf("browser", id));
}

// Both setters are called EVERY frame by the pane's geometry driver and do no
// change-detection of their own — `reconcile` already returns without an
// invoke when the effective value is unchanged, and three boolean compares per
// pane per frame is cheaper than the bookkeeping to skip them. Doing it here
// also removes a trap: an early return on an unchanged input would skip the
// FIRST reconcile of a newly registered pane, which is exactly the one that
// has to hide a pane born inside a hidden tab.

/** Fullscreen-modal gate — hides/restores every registered pane at once. */
export function setModalsOpen(open: boolean): void {
  if (modalsOpen === open) return;
  modalsOpen = open;
  // Every registered surface, terminal AND browser — a modal must not be
  // painted over by either kind.
  for (const e of panes.values()) reconcile(e);
}

/** Drop a destroyed pane's entry (called from the HWND lifecycle cleanup). */
export function forgetPane(id: NativeTermId): void {
  panes.delete(keyOf("term", id));
}
