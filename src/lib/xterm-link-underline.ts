/**
 * Always-on link underlines for the XTERM pane (user decision 2026-07-24:
 * links must be spottable at all times in every CLI, not only on hover —
 * xterm/native parity; the native renderer does the same in link_scan.rs +
 * grid.rs).
 *
 * xterm.js link providers only decorate on HOVER, so this maintains a thin
 * overlay layer inside `.xterm-screen`: on every render/scroll/resize it
 * re-scans the visible rows with the shared matchers
 * (findLinkRangesInLine) and draws 1px underline divs at the matched cell
 * ranges. pointer-events:none — hover/click behavior stays with the link
 * provider.
 *
 * Known approximation: `translateToString(false)` maps a wide (CJK) glyph to
 * ONE char, so links positioned AFTER wide chars on the same line drift left
 * by one cell per preceding wide glyph. Links themselves are ASCII; accepted
 * (same class of residual as the wide-glyph advance drift in the native
 * renderer).
 */

import type { Terminal } from "@xterm/xterm";
import { findLinkRangesInLine } from "./file-link-provider";

export function attachLinkUnderlines(term: Terminal): () => void {
  let layer: HTMLDivElement | null = null;

  const ensureLayer = (): HTMLDivElement | null => {
    if (layer && layer.isConnected) return layer;
    const screen = term.element?.querySelector(".xterm-screen") as HTMLElement | null;
    if (!screen) return null;
    layer = document.createElement("div");
    layer.className = "ezy-link-underline-layer";
    layer.style.cssText =
      "position:absolute;inset:0;pointer-events:none;z-index:8;overflow:hidden;";
    screen.appendChild(layer);
    return layer;
  };

  let raf = 0;
  const redraw = () => {
    raf = 0;
    const host = ensureLayer();
    if (!host) return;
    // Cell metrics from the render service (private API — the same source
    // the addons use; guarded so a future xterm bump degrades to no-op).
    const core = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } } })._core;
    const cell = core?._renderService?.dimensions?.css?.cell;
    if (!cell || !cell.width || !cell.height) {
      host.replaceChildren();
      return;
    }
    const fg = term.options.theme?.foreground ?? "#e6edf3";
    const buf = term.buffer.active;
    const frag = document.createDocumentFragment();
    for (let row = 0; row < term.rows; row++) {
      const line = buf.getLine(buf.viewportY + row);
      if (!line) continue;
      // trimRight=false pads to the full column count → char index == column
      // (modulo the wide-char caveat in the header comment).
      const text = line.translateToString(false);
      if (!text.includes("/")) continue;
      for (const [s, e] of findLinkRangesInLine(text)) {
        const u = document.createElement("div");
        u.style.cssText = `position:absolute;left:${s * cell.width}px;top:${
          (row + 1) * cell.height - 2
        }px;width:${(e - s) * cell.width}px;height:1px;background:${fg};opacity:0.65;`;
        frag.appendChild(u);
      }
    }
    host.replaceChildren(frag);
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(redraw);
  };

  const d1 = term.onRender(schedule);
  const d2 = term.onScroll(schedule);
  const d3 = term.onResize(schedule);
  schedule();

  return () => {
    d1.dispose();
    d2.dispose();
    d3.dispose();
    if (raf) cancelAnimationFrame(raf);
    layer?.remove();
    layer = null;
  };
}
