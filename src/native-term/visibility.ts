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
import { flushNow } from "./frameSync";

type Entry = {
  /** Anchor div is laid out with a non-zero rect. */
  layoutVisible: boolean;
  /** Visibility we last pushed to Rust. Seeded true — see header. */
  applied: boolean;
};

const panes = new Map<NativeTermId, Entry>();
let modalsOpen = false;

function reconcile(id: NativeTermId, e: Entry): void {
  const want = e.layoutVisible && !modalsOpen;
  if (want === e.applied) return;
  e.applied = want;
  if (want) {
    // The pane's driver queues its (possibly stale — the layout may have
    // changed while the tab was hidden) geometry in the SAME tick, right
    // before flipping visibility. Flush it now so the move lands before the
    // show and the pane can't appear for a frame at its old position.
    flushNow();
    void nativeTermShow(id).catch(() => {});
  } else {
    void nativeTermHide(id).catch(() => {});
  }
}

/** Per-pane layout visibility. Called every frame by TerminalPaneNative's
 * geometry driver; cheap and idempotent — only a CHANGE reaches Rust. */
export function setPaneLayoutVisible(
  id: NativeTermId,
  visible: boolean,
): void {
  let e = panes.get(id);
  if (!e) {
    e = { layoutVisible: visible, applied: true };
    panes.set(id, e);
  } else {
    if (e.layoutVisible === visible) return;
    e.layoutVisible = visible;
  }
  reconcile(id, e);
}

/** Fullscreen-modal gate — hides/restores every registered pane at once. */
export function setModalsOpen(open: boolean): void {
  if (modalsOpen === open) return;
  modalsOpen = open;
  for (const [id, e] of panes) reconcile(id, e);
}

/** Drop a destroyed pane's entry (called from the HWND lifecycle cleanup). */
export function forgetPane(id: NativeTermId): void {
  panes.delete(id);
}
