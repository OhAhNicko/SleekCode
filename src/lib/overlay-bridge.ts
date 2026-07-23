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

// ---- main side --------------------------------------------------------------

export function emitOverlayPopup(msg: OverlayPopupMsg): void {
  void emit(OVERLAY_POPUP_EVENT, msg);
}

export function listenOverlayAction(
  cb: (msg: OverlayActionMsg) => void,
): Promise<UnlistenFn> {
  return listen<OverlayActionMsg>(OVERLAY_ACTION_EVENT, (e) => cb(e.payload));
}

export function emitOverlayTheme(vars: OverlayThemeMsg): void {
  void emit(OVERLAY_THEME_EVENT, vars);
}

/** The overlay announces it (re)loaded — re-emit the current theme on this. */
export function listenOverlayReady(cb: () => void): Promise<UnlistenFn> {
  return listen(OVERLAY_READY_EVENT, () => cb());
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
