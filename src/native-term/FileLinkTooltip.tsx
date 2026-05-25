/**
 * FileLinkTooltip — positioned tooltip for hovered file-path links in the
 * native terminal pane.
 *
 * The native pane is a Win32 child window over WebView2, so React-rendered
 * overlays inside the pane container are HIDDEN beneath the HWND. To make
 * the tooltip visible we publish its rect via `useOverlayPublisher`; the
 * hole-cut driver (`useNativePaneRegion`) carves a hole in the HWND under
 * the tooltip so WebView2 paints through.
 *
 * Click-to-open is handled by the existing Rust-side OSC 8 / Ctrl+click
 * path (see useNativeFileLinks `link_click` subscription) — this component
 * is display-only and uses `pointer-events: none`.
 *
 * Cell metrics: mirrored from the Rust renderer (currently hardcoded to
 * 14px Hack, ~8.4 logical px wide and ~17 logical px tall per cell).
 * TODO: when `set_font` lands real hot-swap, source these from the renderer
 * rather than hardcoding.
 */

import { useRef } from "react";
import type { NativeTermId } from "../lib/native-term-bridge";
import { useOverlayPublisher } from "../store/overlayRegionSlice";
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
  const overlayRef = useRef<HTMLDivElement | null>(null);

  // Publish this tooltip's viewport rect so the native HWND cuts a hole and
  // the React-painted tooltip becomes visible above the WebView2 pane.
  useOverlayPublisher(`file-link-tooltip-${termId}`, overlayRef);

  if (!hover) return null;

  const top = (hover.line + 1) * CELL_H_LOGICAL + 4;
  let left = hover.col * CELL_W_LOGICAL;

  // Clamp to pane bounds. Rough estimate of tooltip width: chip + path text.
  const paneWidth = paneRef.current?.clientWidth ?? 0;
  const approxTextChars = PREFIX_LABEL.length + 1 + hover.path.length;
  const approxWidth = approxTextChars * 7 + TOOLTIP_HPADDING; // 7px ≈ system 12px avg
  if (paneWidth > 0 && left + approxWidth > paneWidth - 8) {
    left = Math.max(0, paneWidth - approxWidth - 8);
  }

  return (
    <div
      ref={overlayRef}
      aria-hidden
      style={{
        position: "absolute",
        top,
        left,
        zIndex: 60,
        pointerEvents: "none",
        padding: "4px 8px",
        background: "rgb(20,20,24)",
        color: "#ffffff",
        border: "1px solid rgba(255,255,255,0.18)",
        borderRadius: 4,
        fontSize: 12,
        lineHeight: 1.3,
        whiteSpace: "nowrap",
        maxWidth: "calc(100% - 32px)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      <span
        style={{
          color: "rgba(255,255,255,0.62)",
          fontSize: 11,
          letterSpacing: 0.2,
        }}
      >
        {PREFIX_LABEL}
      </span>
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {hover.path}
      </span>
    </div>
  );
}
