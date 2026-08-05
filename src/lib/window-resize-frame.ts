/**
 * The frameless window's invisible resize frame — one definition, three
 * consumers.
 *
 * MADE's window is `decorations: false` + `resizable: false` (tauri.conf.json),
 * so Windows draws no sizing border and hands us nothing to grab. Resizing is
 * entirely MADE's own: 6px `position: fixed` divs at the four edges and corners
 * in the MAIN webview (components/WindowResizeHandles.tsx), driving
 * lib/window-chrome.ts.
 *
 * That makes the frame FRAGILE in a way a normal window's is not. The handles
 * are DOM, and MADE puts real OS windows on top of the webview:
 *
 *   - native terminal panes (child HWNDs, native_term/window/win32.rs), and
 *   - the overlay popup window (owned top-level, overlay/win32.rs).
 *
 * Neither obeys z-index. Whatever pixels they claim, the main webview never
 * sees the pointer in — so anything of ours that reaches a window edge silently
 * takes window resizing away from the user along that whole span. It has
 * happened twice:
 *
 *   2026-07-26  a pane flush with the right edge swallowed the East handle
 *               (fixed by surfaceRectOf, native-term-bridge.ts)
 *   2026-08-04  the far-right pane's TUI scrollbar — which lives in the
 *               OVERLAY window, not the pane — swallowed it again, because the
 *               2026-07-26 trim only ever applied to the pane's own HWND
 *
 * Hence the shared constant: every surface that can cover the frame subtracts
 * the SAME number, and a change here reaches all of them at once. The rule for
 * anything new that paints over the app: keep out of this frame.
 */
export const WINDOW_RESIZE_EDGE_PX = 6;

export interface FrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Clip `rect` out of the window's resize frame on all four sides.
 *
 * Returns `null` when nothing is left — a rect that lived entirely inside the
 * frame has no business being drawn there at all, and the caller drops it.
 *
 * Unlike `surfaceRectOf` (which only ever shrinks width/height so a native
 * pane's surface origin stays on its anchor's origin), this moves the origin
 * when it must: it clips a REGION, and a region has no anchored children to
 * shift out of alignment.
 */
export function clipOutOfResizeFrame(
  rect: FrameRect,
  viewportWidth: number,
  viewportHeight: number,
): FrameRect | null {
  const edge = WINDOW_RESIZE_EDGE_PX;
  const left = Math.max(rect.x, edge);
  const top = Math.max(rect.y, edge);
  const right = Math.min(rect.x + rect.width, viewportWidth - edge);
  const bottom = Math.min(rect.y + rect.height, viewportHeight - edge);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}
