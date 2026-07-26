import type { BrowserCtxMenuEvent } from "./bridge";

/**
 * What the page reported under the cursor at the last right-click.
 *
 * The menu provider needs this synchronously while it builds, and it cannot
 * travel on the synthesized DOM `contextmenu` event, so it is parked here —
 * same pattern as `lib/pane-state-registry.ts`.
 *
 * EVERYTHING HERE IS UNTRUSTED. It originates in the visited page's world,
 * where a hostile page can forge any field. Read `safeExternalUrl()` before
 * offering to open or copy a URL.
 */
/** The id the browser pane declares as `data-ctx-id`; one browsing pane at a time. */
export const BROWSER_SURFACE_ID = "browser";

const contexts = new Map<string, BrowserCtxMenuEvent>();

export function setBrowserPageContext(surfaceId: string, e: BrowserCtxMenuEvent): void {
  contexts.set(surfaceId, e);
}

export function getBrowserPageContext(surfaceId: string): BrowserCtxMenuEvent | undefined {
  return contexts.get(surfaceId);
}

export function clearBrowserPageContext(surfaceId: string): void {
  contexts.delete(surfaceId);
}

/**
 * Return the URL only if it is safe to hand to the OS or the clipboard.
 *
 * A page-supplied URL reaches two places that leave the sandbox: "Open in
 * default browser" (the user's real browser, with their real cookies) and the
 * clipboard. `javascript:`, `data:`, `file:` and friends are exactly what an
 * attacker would put on a link to escape, so only http/https pass.
 */
export function safeExternalUrl(raw: string): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Shorten a URL for display without hiding its origin. */
export function displayUrl(raw: string, max = 48): string {
  if (raw.length <= max) return raw;
  return raw.slice(0, max - 1) + "…";
}
