/**
 * FileLinkTooltip — positioned tooltip for hovered file-path links in the
 * native terminal pane.
 *
 * Overlay-migrated: this component no longer renders DOM (which sat invisible
 * beneath the native HWND and needed a hole cut). It computes the pane-LOCAL
 * position + text here and emits them to the overlay webview, which draws the
 * tooltip above the pane (kind "file-link-tooltip", display-only).
 *
 * Click-to-open is handled by the existing Rust-side OSC 8 / Ctrl+click
 * path (see useNativeFileLinks `link_click` subscription).
 *
 * Cell metrics: mirrored from the Rust renderer (currently hardcoded to
 * 14px Hack, ~8.4 logical px wide and ~17 logical px tall per cell).
 * TODO: when `set_font` lands real hot-swap, source these from the renderer
 * rather than hardcoding.
 */

import type { NativeTermId } from "../lib/native-term-bridge";
import { useOverlayPopupAnchor } from "./useOverlayPopupAnchor";
import type { FileLinkHover } from "./useNativeFileLinks";

// Logical-pixel cell metrics. Mirror of the Rust renderer's current
// hardcoded values for 14px Hack. Will need refresh once set_font lands
// (follow-up R-track).
const CELL_W_LOGICAL = 8.4;
const CELL_H_LOGICAL = 17;

// Rough average glyph width for the tooltip body (matches the system font
// fallback we render with). Used only to pre-clamp left position; final
// width comes from the browser layout.
const TOOLTIP_HPADDING = 16; // padding 4px left + right + chip margin
const PREFIX_LABEL = "Ctrl+click";

interface FileLinkTooltipProps {
  termId: NativeTermId;
  hover: FileLinkHover | null;
  paneRef: React.RefObject<HTMLDivElement | null>;
}

export default function FileLinkTooltip({
  termId,
  hover,
  paneRef,
}: FileLinkTooltipProps) {
  let top = 0;
  let left = 0;
  // ABOVE the hovered line (bottom-anchored in the renderer): the tooltip
  // must never sit under the cursor — its pixels belong to the overlay
  // window, so hovering it steals the mouse from the pane, hover ends, the
  // tooltip closes, the mouse returns... an open/close oscillation. Below
  // only for the top rows where above would clip.
  const above = !!hover && hover.line >= 2;
  if (hover) {
    top = above
      ? hover.line * CELL_H_LOGICAL - 4
      : (hover.line + 1) * CELL_H_LOGICAL + 4;
    left = hover.col * CELL_W_LOGICAL;

    // Clamp to pane bounds. Rough estimate of tooltip width: chip + path text.
    const paneWidth = paneRef.current?.clientWidth ?? 0;
    const approxTextChars = PREFIX_LABEL.length + 1 + hover.path.length;
    const approxWidth = approxTextChars * 7 + TOOLTIP_HPADDING; // 7px ≈ system 12px avg
    if (paneWidth > 0 && left + approxWidth > paneWidth - 8) {
      left = Math.max(0, paneWidth - approxWidth - 8);
    }
  }

  useOverlayPopupAnchor({
    id: `file-link-tooltip-${termId}`,
    kind: "file-link-tooltip",
    open: !!hover,
    anchorRef: paneRef,
    payload: hover
      ? { top, left, above, prefix: PREFIX_LABEL, path: hover.path }
      : null,
  });

  return null;
}
