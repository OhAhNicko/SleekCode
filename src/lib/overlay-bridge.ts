// Cross-window event contract between the MAIN webview and the transparent
// OVERLAY webview (they are separate JS contexts with separate Zustand stores,
// so state flows over Tauri's event bus — `emit` broadcasts to every webview's
// listeners).
//
//   main  --overlay:popup-->  overlay   (open/close + anchor rect + payload)
//   overlay  --overlay:action-->  main  (actions from interactive popups)
//
// This is the ONLY channel the migration uses; the main webview is the source
// of truth and the overlay is a dumb renderer.

import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

export type OverlayRect = { x: number; y: number; width: number; height: number };

/** main -> overlay: one popup's current state. */
export type OverlayPopupMsg = {
  /** Stable per-popup id, e.g. `exit-banner-${terminalId}`. */
  id: string;
  /** Discriminator the overlay switches on to pick a renderer. */
  kind: string;
  /** Whether the popup is open. `false` (or a null rect) removes it. */
  open: boolean;
  /** Anchor rect in main-client-local (== overlay-local) logical px. */
  rect: OverlayRect | null;
  /** Arbitrary kind-specific data the overlay renderer needs. */
  payload?: unknown;
  /** Diagnostic: Date.now() at emit time, stamped by emitOverlayPopup on open
   * messages. The overlay logs the transport delta when it is suspiciously
   * large (event-bus backlog). NOT part of popupSignature — keepalive re-sends
   * re-stamp it without counting as content changes. */
  _ts?: number;
};

/** overlay -> main: an action dispatched by an interactive popup. */
export type OverlayActionMsg = {
  id: string;
  action: string;
  data?: unknown;
};

/** main -> overlay: the app theme as CSS custom properties (`--ezy-*` -> value). */
export type OverlayThemeMsg = Record<string, string>;

export const OVERLAY_POPUP_EVENT = "overlay:popup";
export const OVERLAY_ACTION_EVENT = "overlay:action";
export const OVERLAY_THEME_EVENT = "overlay:theme";
export const OVERLAY_READY_EVENT = "overlay:ready";
export const OVERLAY_FOCUS_EVENT = "overlay:focus";
export const OVERLAY_INTERACTION_EVENT = "overlay:interaction";

// ---- main side --------------------------------------------------------------

/**
 * Popup kinds that are MENUS — a panel the user is about to read and click
 * through. Mirrors the backdrop-popup cases in OverlayRoot's `OverlayPopup`
 * switch; keep the two in step when adding a menu kind, or the new menu
 * silently loses tooltip suppression (see `subscribeMenuOpen`).
 *
 * "swatch-menu" is deliberately absent — it was folded into "anchored-menu"
 * (see overlay-menu-model.ts) and nothing emits it any more.
 */
const MENU_KINDS = new Set([
  "anchored-menu",
  "git-branch-menu",
  "session-picker",
  "recent-menu",
  "sound-picker",
]);

/** Ids of the menu-kind popups currently open. */
const openMenus = new Set<string>();
const menuOpenHandlers = new Set<(open: boolean) => void>();

/**
 * Is any menu open right now?
 *
 * The one consumer today is TooltipHost: a hover tooltip must never paint over
 * a menu, and the tooltip state machine cannot learn about menus any other way
 * — a menu opened from a native pane arrives as a SYNTHESIZED `contextmenu`
 * with no `pointerdown` behind it, so the tooltip's own dismiss listeners never
 * fire. Tracking it here rather than in the tooltip means the answer is
 * correct for every menu, including ones opened by code that has never heard
 * of tooltips.
 */
export function isMenuOpen(): boolean {
  return openMenus.size > 0;
}

/** Fires on empty <-> non-empty transitions only. Returns an unsubscribe. */
export function subscribeMenuOpen(cb: (open: boolean) => void): () => void {
  menuOpenHandlers.add(cb);
  return () => {
    menuOpenHandlers.delete(cb);
  };
}

/**
 * Track a menu's open state by ID, not by count. `anchored-menu` re-emits
 * `open: true` on a 750ms keepalive and again on every anchor-rect change
 * (useOverlayMenu), so a counter would run away within seconds of a menu
 * opening and never return to zero.
 */
function noteMenuState(msg: OverlayPopupMsg): void {
  if (!MENU_KINDS.has(msg.kind)) return;
  const before = openMenus.size > 0;
  if (msg.open && msg.rect) openMenus.add(msg.id);
  else openMenus.delete(msg.id);
  const after = openMenus.size > 0;
  if (before === after) return;
  for (const h of [...menuOpenHandlers]) h(after);
}

export function emitOverlayPopup(msg: OverlayPopupMsg): void {
  noteMenuState(msg);
  void emit(OVERLAY_POPUP_EVENT, msg.open ? { ...msg, _ts: Date.now() } : msg);
}

/**
 * Handlers for `overlay:action`, plus the single real Tauri listener feeding
 * them. Kept module-level so registration is SYNCHRONOUS.
 *
 * Tauri's `listen()` is async, and most callers subscribe inside an
 * `if (!open) return` effect — so the window between a popup appearing and its
 * listener going live was one where the user's click bounced back to nobody.
 * A one-item menu opening under the cursor is clickable inside that window,
 * which is why the snip menu's "View all screenshots" did nothing perhaps one
 * press in three while the always-mounted `GlobalContextMenu` never missed one.
 *
 * Adding to the set is immediate; only the underlying bridge is async, and it
 * is installed once for the life of the page.
 */
const actionHandlers = new Set<(msg: OverlayActionMsg) => void>();
let actionBridge: Promise<UnlistenFn> | null = null;

export function listenOverlayAction(
  cb: (msg: OverlayActionMsg) => void,
): Promise<UnlistenFn> {
  actionHandlers.add(cb);
  actionBridge ??= listen<OverlayActionMsg>(OVERLAY_ACTION_EVENT, (e) => {
    // Copy first: a handler may unsubscribe itself while dispatching.
    for (const h of [...actionHandlers]) h(e.payload);
  });
  // Resolved immediately so callers that `await` before storing the unlisten
  // still cannot open a gap — the handler is already registered above.
  return Promise.resolve(() => {
    actionHandlers.delete(cb);
  });
}

export function emitOverlayTheme(vars: OverlayThemeMsg): void {
  void emit(OVERLAY_THEME_EVENT, vars);
}

/** The overlay announces it (re)loaded — re-emit the current theme on this. */
export function listenOverlayReady(cb: () => void): Promise<UnlistenFn> {
  return listen(OVERLAY_READY_EVENT, () => cb());
}

/** overlay -> main: a pointerdown landed inside an overlay popup. The overlay
 * window's region only ever covers its own popups, so any press it receives is
 * by definition an INSIDE-popup interaction — never an "outside click". The
 * dismissal owner uses this to tell "the main webview blurred because the
 * user clicked one of MADE's own popups" apart from a real focus loss
 * (clicking the overlay makes its WebView2 child take Win32 focus, which
 * fires main's DOM blur — see OverlayDismissOwner). */
export function listenOverlayInteraction(cb: () => void): Promise<UnlistenFn> {
  return listen(OVERLAY_INTERACTION_EVENT, () => cb());
}

/** overlay -> main: the overlay window gained/lost OS focus (focus-handoff
 * popups like pane search take real keyboard focus). Main folds this into
 * appWindowFocused so the app never LOOKS unfocused mid-search. */
export function listenOverlayFocus(
  cb: (focused: boolean) => void,
): Promise<UnlistenFn> {
  return listen<{ focused: boolean }>(OVERLAY_FOCUS_EVENT, (e) =>
    cb(e.payload.focused),
  );
}

// ---- overlay side -----------------------------------------------------------

export function listenOverlayPopup(
  cb: (msg: OverlayPopupMsg) => void,
): Promise<UnlistenFn> {
  return listen<OverlayPopupMsg>(OVERLAY_POPUP_EVENT, (e) => cb(e.payload));
}

export function emitOverlayAction(msg: OverlayActionMsg): void {
  void emit(OVERLAY_ACTION_EVENT, msg);
}

export function listenOverlayTheme(
  cb: (vars: OverlayThemeMsg) => void,
): Promise<UnlistenFn> {
  return listen<OverlayThemeMsg>(OVERLAY_THEME_EVENT, (e) => cb(e.payload));
}

export function emitOverlayReady(): void {
  void emit(OVERLAY_READY_EVENT, null);
}

export function emitOverlayFocus(focused: boolean): void {
  void emit(OVERLAY_FOCUS_EVENT, { focused });
}

/** See listenOverlayInteraction. Fired from a capture-phase pointerdown in
 * the overlay document; carries no payload — only the timing matters. */
export function emitOverlayInteraction(): void {
  void emit(OVERLAY_INTERACTION_EVENT, null);
}
