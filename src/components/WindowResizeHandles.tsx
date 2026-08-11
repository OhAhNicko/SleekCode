import type { CSSProperties } from "react";
import { startCustomWindowResize, type CustomResizeDirection } from "../lib/window-chrome";
import { WINDOW_RESIZE_EDGE_PX } from "../lib/window-resize-frame";

// px — invisible resize border thickness. Shared, because every surface that
// can cover these handles (native panes, overlay popups) has to subtract the
// same number to stay off them; see lib/window-resize-frame.ts.
const HANDLE = WINDOW_RESIZE_EDGE_PX;

// px — how far each corner grip's arms reach along its two edges. A corner was
// a bare HANDLE×HANDLE (6×6) square, which is a brutally small target — the
// classic "top-left corner won't grab" complaint. Each corner is now an
// L-shaped zone with CORNER_ARM-long arms, clip-path'd to the HANDLE-thick
// frame band, so the bigger target never covers content pixels and stays
// inside the clearance every overlapping surface already subtracts.
const CORNER_ARM = 22;

const H = `${HANDLE}px`;
const A = `${CORNER_ARM}px`;
const AH = `${CORNER_ARM - HANDLE}px`;

const directions: ReadonlyArray<{
  dir: CustomResizeDirection;
  style: CSSProperties;
}> = [
  // Edges — inset by CORNER_ARM so the corner grips own their arm spans.
  { dir: "North", style: { top: 0, left: CORNER_ARM, right: CORNER_ARM, height: HANDLE, cursor: "n-resize" } },
  { dir: "South", style: { bottom: 0, left: CORNER_ARM, right: CORNER_ARM, height: HANDLE, cursor: "s-resize" } },
  { dir: "West", style: { left: 0, top: CORNER_ARM, bottom: CORNER_ARM, width: HANDLE, cursor: "w-resize" } },
  { dir: "East", style: { right: 0, top: CORNER_ARM, bottom: CORNER_ARM, width: HANDLE, cursor: "e-resize" } },
  // Corners — L-shaped zones (clip-path also clips hit-testing).
  {
    dir: "NorthWest",
    style: {
      top: 0, left: 0, width: CORNER_ARM, height: CORNER_ARM, cursor: "nw-resize",
      clipPath: `polygon(0 0, ${A} 0, ${A} ${H}, ${H} ${H}, ${H} ${A}, 0 ${A})`,
    },
  },
  {
    dir: "NorthEast",
    style: {
      top: 0, right: 0, width: CORNER_ARM, height: CORNER_ARM, cursor: "ne-resize",
      clipPath: `polygon(0 0, ${A} 0, ${A} ${A}, ${AH} ${A}, ${AH} ${H}, 0 ${H})`,
    },
  },
  {
    dir: "SouthWest",
    style: {
      bottom: 0, left: 0, width: CORNER_ARM, height: CORNER_ARM, cursor: "sw-resize",
      clipPath: `polygon(0 0, ${H} 0, ${H} ${AH}, ${A} ${AH}, ${A} ${A}, 0 ${A})`,
    },
  },
  {
    dir: "SouthEast",
    style: {
      bottom: 0, right: 0, width: CORNER_ARM, height: CORNER_ARM, cursor: "se-resize",
      clipPath: `polygon(${AH} 0, ${A} 0, ${A} ${A}, 0 ${A}, 0 ${AH}, ${AH} ${AH})`,
    },
  },
] as const;

export default function WindowResizeHandles() {
  return (
    <>
      {directions.map(({ dir, style }) => (
        <div
          key={dir}
          onPointerDown={(e) => startCustomWindowResize(e, dir)}
          style={{
            position: "fixed",
            zIndex: 9999,
            ...style,
          }}
        />
      ))}
    </>
  );
}
