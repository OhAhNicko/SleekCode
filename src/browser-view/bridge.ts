// JS bridge for the native browser pane (Rust: src-tauri/src/browser_view/).
//
// The pane's surface is a wry webview in a child HWND of the main window — NOT a
// Tauri webview. That is a security decision: a Tauri-hosted webview injects the
// invoke key into every page it loads, over an IPC bridge that reaches MADE's
// unguarded app commands. See src-tauri/src/browser_view/policy.rs.
//
// Mirrors the shape of native-term-bridge.ts deliberately: same Rect contract
// (logical CSS px, window-client coords — Rust multiplies by dpr), same
// `<module>:{id}:{kind}` event channel, same window-memoised reap.

import { invoke } from "@tauri-apps/api/core";
import type { Rect } from "../lib/native-term-bridge";

export type BrowserViewId = number;

/* ------------------------------------------------------------------ */
/*  Page-reload orphan reaping                                         */
/* ------------------------------------------------------------------ */

// Identical reasoning to native-term-bridge's ensureFreshSession:
//
//  - ORDERING, not timing. Awaiting inside create guarantees the reap finishes
//    before this page's first view exists. A boot effect would race the first
//    create, and reaping a live view is worse than the bug.
//  - The memo lives on `window`, NOT a module-level `let`. In dev, Vite can hot
//    replace this module while the page keeps running, which would reset a
//    module flag and let the next create reap the views this very page is using.
//    A page reload gets a fresh `window`; an HMR swap does not.
const REAP_KEY = "__madeBrowserViewReaped";
type ReapHost = { [REAP_KEY]?: Promise<void> };

export function ensureFreshBrowserSession(): Promise<void> {
  const host = window as unknown as ReapHost;
  let reap = host[REAP_KEY];
  if (!reap) {
    reap = invoke<number>("browser_view_reap_all")
      .then((n) => {
        if (n > 0) {
          console.warn(
            `[browser-view] reaped ${n} orphaned view(s) from a previous page load`,
          );
        }
      })
      .catch((e) => {
        console.error("[browser-view] reap of orphaned views failed", e);
      });
    host[REAP_KEY] = reap;
  }
  return reap;
}

/* ------------------------------------------------------------------ */
/*  Commands                                                           */
/* ------------------------------------------------------------------ */

export async function browserViewCreate(
  url: string,
  rect: Rect,
  dpr: number,
): Promise<BrowserViewId> {
  await ensureFreshBrowserSession();
  return invoke<BrowserViewId>("browser_view_create", { url, rect, dpr });
}

export function browserViewDestroy(id: BrowserViewId): Promise<void> {
  return invoke<void>("browser_view_destroy", { id });
}

export function browserViewShow(id: BrowserViewId): Promise<void> {
  return invoke<void>("browser_view_show", { id });
}

export function browserViewHide(id: BrowserViewId): Promise<void> {
  return invoke<void>("browser_view_hide", { id });
}

/** `cornerRadius` is logical CSS px; 0 clears the clip. A child HWND ignores
 *  CSS border-radius / overflow:hidden, so the pane's rounded frame (viewport
 *  presets) has to be reproduced as a Win32 region. */
export function browserViewSetBounds(
  id: BrowserViewId,
  rect: Rect,
  dpr: number,
  cornerRadius: number,
): Promise<void> {
  return invoke<void>("browser_view_set_bounds", {
    id,
    rect,
    dpr,
    cornerRadius,
  });
}

export function browserViewNavigate(
  id: BrowserViewId,
  url: string,
): Promise<void> {
  return invoke<void>("browser_view_navigate", { id, url });
}

export function browserViewBack(id: BrowserViewId): Promise<void> {
  return invoke<void>("browser_view_back", { id });
}

export function browserViewForward(id: BrowserViewId): Promise<void> {
  return invoke<void>("browser_view_forward", { id });
}

export function browserViewReload(id: BrowserViewId): Promise<void> {
  return invoke<void>("browser_view_reload", { id });
}

export function browserViewHardReload(id: BrowserViewId): Promise<void> {
  return invoke<void>("browser_view_hard_reload", { id });
}

export function browserViewFocus(id: BrowserViewId): Promise<void> {
  return invoke<void>("browser_view_focus", { id });
}

export function browserViewUrl(id: BrowserViewId): Promise<string> {
  return invoke<string>("browser_view_url", { id });
}

/** Run JS inside the browsing page (inspect start/stop, storage reads). */
export function browserViewEval(id: BrowserViewId, js: string): Promise<void> {
  return invoke<void>("browser_view_eval", { id, js });
}

/* ------------------------------------------------------------------ */
/*  Events                                                             */
/* ------------------------------------------------------------------ */

export type BrowserViewEventKind =
  | "devtools"
  | "blocked"
  | "popup"
  | "download"
  | "navigated"
  | "ctxmenu";

/** One record forwarded from the page's injected script.
 *
 *  UNTRUSTED. The script runs in the visited page's world, so a hostile page can
 *  forge these. Rust validates the envelope (closed `kind` set, size/batch/text
 *  caps, rate limit) — see policy.rs — and the payload's only destination is
 *  DevTools panel text. Never interpret it as a command, and never render it as
 *  HTML. */
export interface DevtoolsItem {
  kind: string;
  payload: string;
}

export interface DevtoolsEvent {
  items: DevtoolsItem[];
}

/** A navigation the security policy refused (file://, MADE's own origin, …). */
export interface BlockedEvent {
  url: string;
  reason: string;
}

/** window.open / target=_blank, denied at the webview and handed to the pane. */
export interface PopupEvent {
  url: string;
}

/** Chrome behaviour: downloads are allowed and land in the user's Downloads
 *  folder, with the server-suggested name sanitised and conflicts uniquified
 *  (`report (1).pdf`). Reported so they are visible rather than silent. */
export interface DownloadEvent {
  /** `request` = cancelled at the webview, awaiting your Allow/Deny.
   *  `start` = approved and writing. `end` = finished or failed. */
  phase: "request" | "start" | "end";
  url: string;
  /** Sanitised file name. Present on `request`. */
  name?: string;
  /** Absolute destination. Null until approved, and on a failed completion. */
  path?: string | null;
  /** Present on `end`. */
  success?: boolean;
}

/** Approve a pending download. Re-issues it inside the page so cookies apply. */
export function browserViewAllowDownload(
  id: BrowserViewId,
  url: string,
  name: string,
): Promise<void> {
  return invoke<void>("browser_view_allow_download", { id, url, name });
}

/** Push the "ask before saving" preference to Rust. Process-wide, since it is a
 *  user setting rather than a per-pane one. */
export function browserViewSetPromptDownloads(enabled: boolean): Promise<void> {
  return invoke<void>("browser_view_set_prompt_downloads", { enabled });
}

/** Refuse a pending download. It was already cancelled at the webview. */
export function browserViewDenyDownload(
  id: BrowserViewId,
  url: string,
): Promise<void> {
  return invoke<void>("browser_view_deny_download", { id, url });
}

/** Emitted by the Rust navigation handler for every allowed navigation. This is
 *  the address bar's source of truth — reading it here means the injected script
 *  does NOT have to patch history.pushState, which was one of the tampering
 *  signals that tripped Google's bot detection. */
export interface NavigatedEvent {
  url: string;
}

/**
 * A right-click inside the page, reported by the injected script.
 *
 * UNTRUSTED, like every payload on this bridge — the page can forge all of it.
 * `x`/`y` are page-viewport px (safe: they only position a menu). The URLs are
 * scheme-checked before the menu offers to open or copy them, and nothing here
 * is ever acted on without the user picking a row.
 */
export interface BrowserCtxMenuEvent {
  x: number;
  y: number;
  linkUrl: string;
  linkText: string;
  imgUrl: string;
  selText: string;
  editable: boolean;
}

interface PayloadMap {
  navigated: NavigatedEvent;
  ctxmenu: { payload: string };
  devtools: DevtoolsEvent;
  blocked: BlockedEvent;
  popup: PopupEvent;
  download: DownloadEvent;
}

type Unlisten = () => void;

async function subscribe<K extends BrowserViewEventKind>(
  id: BrowserViewId,
  kind: K,
  cb: (payload: PayloadMap[K]) => void,
): Promise<Unlisten> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<PayloadMap[K]>(`browser_view:${id}:${kind}`, (e) =>
    cb(e.payload),
  );
}

export function subscribeBrowserDevtools(
  id: BrowserViewId,
  cb: (e: DevtoolsEvent) => void,
): Promise<Unlisten> {
  return subscribe(id, "devtools", cb);
}

/**
 * Right-click reports. The Rust side forwards the page's JSON payload verbatim
 * as a string; parse defensively — a hostile page controls its contents.
 */
export function subscribeBrowserCtxMenu(
  id: number,
  cb: (e: BrowserCtxMenuEvent) => void,
): Promise<Unlisten> {
  return subscribe(id, "ctxmenu", (raw) => {
    try {
      const parsed = JSON.parse((raw as { payload: string }).payload) as Partial<BrowserCtxMenuEvent>;
      cb({
        x: Number(parsed.x) || 0,
        y: Number(parsed.y) || 0,
        linkUrl: typeof parsed.linkUrl === "string" ? parsed.linkUrl : "",
        linkText: typeof parsed.linkText === "string" ? parsed.linkText : "",
        imgUrl: typeof parsed.imgUrl === "string" ? parsed.imgUrl : "",
        selText: typeof parsed.selText === "string" ? parsed.selText : "",
        editable: !!parsed.editable,
      });
    } catch {
      // Malformed payload from a page that tampered with the script — ignore.
    }
  });
}

export function subscribeBrowserBlocked(
  id: BrowserViewId,
  cb: (e: BlockedEvent) => void,
): Promise<Unlisten> {
  return subscribe(id, "blocked", cb);
}

export function subscribeBrowserPopup(
  id: BrowserViewId,
  cb: (e: PopupEvent) => void,
): Promise<Unlisten> {
  return subscribe(id, "popup", cb);
}

export function subscribeBrowserNavigated(
  id: BrowserViewId,
  cb: (e: NavigatedEvent) => void,
): Promise<Unlisten> {
  return subscribe(id, "navigated", cb);
}

/** Turn on DevTools capture (console/network/elements/storage) for this view.
 *  Not on at page load: the instrumentation patches natives, which reads as
 *  automation to bot detection. Called when the panel opens. */
export function browserViewEnableDevtools(id: BrowserViewId): Promise<void> {
  return invoke<void>("browser_view_enable_devtools", { id });
}

export function subscribeBrowserDownload(
  id: BrowserViewId,
  cb: (e: DownloadEvent) => void,
): Promise<Unlisten> {
  return subscribe(id, "download", cb);
}
