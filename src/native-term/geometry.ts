// Pane-local hole rect: top-left of the native child HWND's client area = (0,0).
// Distinct from window-client coords used by native_term_create /
// native_term_resize, which are relative to the parent (webview) client. Rust
// applies DPI scaling and per-platform edge expansion (Win32 1px overshoot for
// SetWindowRgn aliasing).
import type { Rect } from "../lib/native-term-bridge";

export function getOverlayRectInPane(
  overlayEl: HTMLElement | null,
  paneEl: HTMLElement | null,
): Rect | null {
  if (!overlayEl || !paneEl) return null;

  const o = overlayEl.getBoundingClientRect();
  const p = paneEl.getBoundingClientRect();

  if (o.width <= 0 || o.height <= 0) return null;
  if (p.width <= 0 || p.height <= 0) return null;

  const ix1 = Math.max(o.left, p.left);
  const iy1 = Math.max(o.top, p.top);
  const ix2 = Math.min(o.right, p.right);
  const iy2 = Math.min(o.bottom, p.bottom);

  if (ix2 <= ix1 || iy2 <= iy1) return null;

  return {
    x: ix1 - p.left,
    y: iy1 - p.top,
    width: ix2 - ix1,
    height: iy2 - iy1,
  };
}
