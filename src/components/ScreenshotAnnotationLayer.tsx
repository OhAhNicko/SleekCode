import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  arrowHead,
  boundsOf,
  clampRectToBounds,
  clampToBounds,
  DRAG_THRESHOLD_PX,
  imagePerCssPx,
  MARKER_ALPHA,
  markerCursor,
  normalizeRect,
  pickShape,
  pointsAttr,
  remapShape,
  resizeRect,
  screenToImage,
  simplifyPoints,
  translateShape,
  type Anchor,
  type Point,
  type CropState,
  type CropVariant,
  type Rect,
  type Shape,
  type Tool,
} from "../lib/annotations";

interface Props {
  imageId: string;
  /** Region of the bitmap on screen, in FULL-image coords (a confirmed crop, else all). */
  view: Rect;
  /** Displayed size of the bitmap in CSS px — the layer matches it exactly. */
  dispW: number;
  dispH: number;
  pan: Point;
  stageRef: React.RefObject<HTMLDivElement | null>;
  tool: Tool;
  color: string;
  thickness: number;
  shapes: Shape[];
  crop: CropState | null;
  cropVariant: CropVariant;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCommit: (next: Shape[]) => void;
  onCrop: (crop: Rect | null) => void;
  /** Reports whether a gesture is in flight, so Escape can cancel it first. */
  onDraftChange: (drafting: boolean) => void;
}

/** Anchors and their placement on the selection box. Corners beat edges. */
const HANDLES: ReadonlyArray<{ anchor: Anchor; style: React.CSSProperties }> = [
  { anchor: "n", style: { top: -3, left: 6, right: 6, height: 6, cursor: "ns-resize", zIndex: 2 } },
  { anchor: "s", style: { bottom: -3, left: 6, right: 6, height: 6, cursor: "ns-resize", zIndex: 2 } },
  { anchor: "e", style: { top: 6, right: -3, bottom: 6, width: 6, cursor: "ew-resize", zIndex: 2 } },
  { anchor: "w", style: { top: 6, left: -3, bottom: 6, width: 6, cursor: "ew-resize", zIndex: 2 } },
  { anchor: "nw", style: { top: -5, left: -5, width: 10, height: 10, cursor: "nwse-resize", zIndex: 3 } },
  { anchor: "ne", style: { top: -5, right: -5, width: 10, height: 10, cursor: "nesw-resize", zIndex: 3 } },
  { anchor: "sw", style: { bottom: -5, left: -5, width: 10, height: 10, cursor: "nesw-resize", zIndex: 3 } },
  { anchor: "se", style: { bottom: -5, right: -5, width: 10, height: 10, cursor: "nwse-resize", zIndex: 3 } },
];

/** Screen-space grab slop for hit-testing, converted to image px per zoom. */
const HIT_SLOP_CSS_PX = 5;
/** Smallest shape a draw or resize may produce, in image px. */
const MIN_SIZE = 6;

type Gesture =
  | { mode: "cropMove"; start: Rect; origin: Point }
  | { mode: "cropResize"; start: Rect; anchor: Anchor; origin: Point }
  | {
      mode: "draw";
      id: string;
      kind: Exclude<Tool, "select" | "crop">;
      /** Snapshotted at press: changing the swatch mid-stroke must not recolour it. */
      color: string;
      width: number;
      start: Point;
      points: Point[];
    }
  | { mode: "crop"; start: Point }
  | { mode: "move"; startShape: Shape; origin: Point }
  | { mode: "resize"; startShape: Shape; startBounds: Rect; anchor: Anchor; origin: Point };

/**
 * The markup surface: an SVG sibling of the screenshot, sized to match it
 * exactly, carrying the visible region as its `viewBox`.
 *
 * That viewBox is the whole trick — shapes are stored in FULL-image pixels and
 * the browser maps them onto the display, so zoom, pan, expand, window resize
 * AND a confirmed crop all need no recomputation here. A crop simply shifts the
 * viewBox origin, and shapes drawn before it keep their coordinates.
 *
 * Gesture state is split in two on purpose: `gesture` holds what was true when
 * the press started, `cursor` holds where the pointer is now. Every preview and
 * every commit is derived from that pair, so there is exactly one place the
 * geometry is computed and the live preview can never disagree with what gets
 * committed. Tracking the pointer in a ref instead would skip the re-render the
 * preview depends on.
 */
export default function ScreenshotAnnotationLayer({
  imageId,
  view,
  dispW,
  dispH,
  pan,
  stageRef,
  tool,
  color,
  thickness,
  shapes,
  crop,
  cropVariant,
  selectedId,
  onSelect,
  onCommit,
  onCrop,
  onDraftChange,
}: Props) {
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [cursor, setCursor] = useState<Point | null>(null);

  const gestureRef = useRef<Gesture | null>(null);
  gestureRef.current = gesture;
  const cursorRef = useRef<Point | null>(null);
  cursorRef.current = cursor;

  // Latest props for the imperative pointer handlers, which are attached once
  // per gesture and would otherwise close over stale values.
  const live = useRef({ view, dispW, dispH, pan, tool, color, thickness, shapes, crop, cropVariant });
  live.current = { view, dispW, dispH, pan, tool, color, thickness, shapes, crop, cropVariant };

  const cssPerImage = dispW > 0 ? dispW / view.w : 1;

  useEffect(() => {
    onDraftChange(gesture !== null);
  }, [gesture, onDraftChange]);

  // Switching tool or image mid-gesture must not strand a draft.
  useEffect(() => {
    setGesture(null);
    setCursor(null);
  }, [tool, imageId]);

  const toImage = useCallback(
    (clientX: number, clientY: number): Point => {
      const stage = stageRef.current;
      const l = live.current;
      if (!stage) return { x: 0, y: 0 };
      return screenToImage(
        clientX,
        clientY,
        stage.getBoundingClientRect(),
        l.dispW,
        l.dispH,
        l.pan,
        l.view,
      );
    },
    [stageRef],
  );

  // ── one gesture driver for draw / crop / move / resize ───────────────────

  const startGesture = (e: React.PointerEvent, initial: Gesture) => {
    // Stops the stage's pan handler, which would otherwise take pointer
    // capture and swallow every subsequent move.
    e.stopPropagation();
    e.preventDefault();

    // HTMLElement, not Element — only the former's event map knows `pointermove`.
    const target = e.currentTarget as HTMLElement;
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer can vanish between down and capture */
    }

    const startPoint = toImage(e.clientX, e.clientY);
    setGesture(initial);
    setCursor(startPoint);

    let disposed = false;
    const onMove = (ev: PointerEvent) => {
      const p = toImage(ev.clientX, ev.clientY);
      setCursor(p);
      // Freehand is the one gesture that needs history, not just the endpoint.
      const g = gestureRef.current;
      if (g?.mode === "draw" && g.kind === "marker") {
        setGesture({ ...g, points: [...g.points, p] });
      }
    };
    const finish = () => {
      if (disposed) return;
      disposed = true;
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", finish);
      target.removeEventListener("pointercancel", finish);
      target.removeEventListener("lostpointercapture", finish);
      try {
        target.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      commit(gestureRef.current, cursorRef.current);
      setGesture(null);
      setCursor(null);
    };

    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", finish);
    target.addEventListener("pointercancel", finish);
    // FloatingPaneWindow omits this and leaks listeners when capture is lost to
    // an alt-tab; window-chrome.ts gets it right, so follow that.
    target.addEventListener("lostpointercapture", finish);
  };

  const commit = (g: Gesture | null, cur: Point | null) => {
    if (!g || !cur) return;
    const l = live.current;

    if (g.mode === "crop") {
      const r = normalizeRect(g.start, clampToBounds(cur, l.view));
      if (r.w >= MIN_SIZE && r.h >= MIN_SIZE) onCrop(r);
      return;
    }

    if (g.mode === "cropMove" || g.mode === "cropResize") {
      onCrop(cropFrom(g, cur, l.view));
      return;
    }

    if (g.mode === "draw") {
      const shape = draftFrom(g, cur);
      if (!shape) return;
      if (shape.kind === "marker") {
        const points = simplifyPoints(shape.points);
        if (points.length < 2) return; // a click, not a stroke
        onCommit([...l.shapes, { ...shape, points }]);
        return;
      }
      if (shape.kind === "arrow") {
        if (Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1) < MIN_SIZE) return;
        onCommit([...l.shapes, shape]);
        return;
      }
      if (shape.w < MIN_SIZE || shape.h < MIN_SIZE) return;
      onCommit([...l.shapes, shape]);
      return;
    }

    const next = transformed(g, cur, cssPerImage);
    if (!next) return;
    onCommit(l.shapes.map((s) => (s.id === next.id ? next : s)));
  };

  // ── pointer entry points ─────────────────────────────────────────────────

  const onSurfacePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const l = live.current;

    if (l.tool === "select") {
      const p = toImage(e.clientX, e.clientY);
      const hit = pickShape(l.shapes, p, HIT_SLOP_CSS_PX * imagePerCssPx(l.view, l.dispW));
      if (!hit) {
        onSelect(null);
        return; // no stopPropagation — the stage gets to pan
      }
      onSelect(hit.id);
      startGesture(e, { mode: "move", startShape: hit, origin: p });
      return;
    }

    if (l.tool === "crop") {
      const p = toImage(e.clientX, e.clientY);
      const c = l.crop?.rect ?? null;
      // An existing frame is grabbable: press inside it to slide the region
      // around. Handles (rendered below) take the edges before this runs.
      if (c && p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h) {
        startGesture(e, { mode: "cropMove", start: c, origin: p });
        return;
      }
      // Outside the frame: v1 lets you draw a fresh region, v2's frame is
      // always the full image to begin with, so there is no "outside" to draw
      // in — dragging there would silently discard the trim you just made.
      if (l.cropVariant === "v1") {
        startGesture(e, { mode: "crop", start: p });
      }
      return;
    }

    onSelect(null);
    const start = toImage(e.clientX, e.clientY);
    startGesture(e, {
      mode: "draw",
      id: crypto.randomUUID(),
      kind: l.tool,
      color: l.color,
      width: l.thickness,
      start,
      points: [start],
    });
  };

  const onHandlePointerDown = (anchor: Anchor) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const shape = live.current.shapes.find((s) => s.id === selectedId);
    if (!shape) return;
    startGesture(e, {
      mode: "resize",
      startShape: shape,
      startBounds: boundsOf(shape),
      anchor,
      origin: toImage(e.clientX, e.clientY),
    });
  };

  // ── derived preview ──────────────────────────────────────────────────────

  const draft = gesture?.mode === "draw" && cursor ? draftFrom(gesture, cursor) : null;
  const draftCrop =
    cursor && gesture?.mode === "crop"
      ? normalizeRect(gesture.start, clampToBounds(cursor, view))
      : cursor && (gesture?.mode === "cropMove" || gesture?.mode === "cropResize")
        ? cropFrom(gesture, cursor, view)
        : (crop?.rect ?? null);

  let preview = shapes;
  if ((gesture?.mode === "move" || gesture?.mode === "resize") && cursor) {
    const next = transformed(gesture, cursor, cssPerImage);
    if (next) preview = shapes.map((s) => (s.id === next.id ? next : s));
  }

  // Once a crop is confirmed the view IS the crop, so the scrim's hole matches
  // its outer path and nothing dims — but the frame and handles would still
  // draw on the view edge. Only show the crop chrome while it is pending, or
  // while the crop tool is armed and you might re-crop.
  const showCropUi =
    !!draftCrop &&
    draftCrop.w > 0 &&
    draftCrop.h > 0 &&
    (tool === "crop" || (!!crop && !crop.confirmed));

  const selected = preview.find((s) => s.id === selectedId) ?? null;
  const selBounds = selected ? boundsOf(selected) : null;

  // Rebuilt only when the footprint actually changes — it is a data URI the
  // browser has to re-decode, not a cheap style swap.
  const nibCursor = useMemo(
    () => markerCursor(thickness * cssPerImage, color),
    [thickness, cssPerImage, color],
  );

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        cursor:
          tool === "marker" ? nibCursor : tool === "select" ? "default" : "crosshair",
        touchAction: "none",
      }}
      onPointerDown={onSurfacePointerDown}
      onDoubleClick={(e) => {
        // The stage's dblclick toggles Fit ↔ 1:1. That's still wanted while
        // merely looking at a screenshot, so only a live tool blocks it.
        if (tool !== "select") e.stopPropagation();
      }}
    >
      <svg
        width={dispW}
        height={dispH}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        style={{ position: "absolute", inset: 0, display: "block" }}
      >
        {preview.map((s) => (
          <ShapeNode key={s.id} shape={s} />
        ))}
        {draft && <ShapeNode shape={draft} />}

        {/* Crop scrim — everything outside the region dims, like a live snip. */}
        {showCropUi && draftCrop && (
          <>
            <path
              d={`M${view.x},${view.y} H${view.x + view.w} V${view.y + view.h} H${view.x} Z M${draftCrop.x},${draftCrop.y} v${draftCrop.h} h${draftCrop.w} v${-draftCrop.h} Z`}
              fill="rgba(0,0,0,0.55)"
              fillRule="evenodd"
            />
            {cropVariant === "v2" ? (
              // Marching-ants frame: a solid dark line under a dashed light
              // one, so the border stays legible over both a white screenshot
              // and a black terminal. Stroke widths divide by the zoom so the
              // frame is a constant thickness on screen — unlike annotation
              // strokes, this is chrome, not ink that gets exported.
              <>
                <rect
                  x={draftCrop.x}
                  y={draftCrop.y}
                  width={draftCrop.w}
                  height={draftCrop.h}
                  fill="none"
                  stroke="rgba(0,0,0,0.85)"
                  strokeWidth={1.5 / cssPerImage}
                />
                <rect
                  x={draftCrop.x}
                  y={draftCrop.y}
                  width={draftCrop.w}
                  height={draftCrop.h}
                  fill="none"
                  stroke="#fff"
                  strokeWidth={1.5 / cssPerImage}
                  strokeDasharray={`${5 / cssPerImage} ${4 / cssPerImage}`}
                />
              </>
            ) : (
              <rect
                x={draftCrop.x}
                y={draftCrop.y}
                width={draftCrop.w}
                height={draftCrop.h}
                fill="none"
                stroke="#fff"
                strokeWidth={1 / cssPerImage}
              />
            )}
          </>
        )}
      </svg>

      {/* Crop handles — both variants get them, so v1 can now be resized and
          dragged rather than only redrawn. */}
      {showCropUi && tool === "crop" && draftCrop && (
        <div
          style={{
            position: "absolute",
            left: (draftCrop.x - view.x) * cssPerImage,
            top: (draftCrop.y - view.y) * cssPerImage,
            width: Math.max(1, draftCrop.w * cssPerImage),
            height: Math.max(1, draftCrop.h * cssPerImage),
            pointerEvents: "none",
          }}
        >
          {HANDLES.map(({ anchor, style }) => (
            <div
              key={anchor}
              onPointerDown={(e) => {
                if (e.button !== 0 || !draftCrop) return;
                startGesture(e, {
                  mode: "cropResize",
                  start: draftCrop,
                  anchor,
                  origin: toImage(e.clientX, e.clientY),
                });
              }}
              style={{ position: "absolute", pointerEvents: "auto", ...style }}
            />
          ))}
          {(["nw", "ne", "sw", "se"] as const).map((c) => (
            <div
              key={`crop-pip-${c}`}
              style={{
                position: "absolute",
                width: 8,
                height: 8,
                backgroundColor: "#fff",
                border: "1px solid rgba(0,0,0,0.7)",
                boxSizing: "border-box",
                pointerEvents: "none",
                top: c.startsWith("n") ? -4 : undefined,
                bottom: c.startsWith("s") ? -4 : undefined,
                left: c.endsWith("w") ? -4 : undefined,
                right: c.endsWith("e") ? -4 : undefined,
              }}
            />
          ))}
        </div>
      )}

      {/* Selection box and handles live in the DOM rather than the SVG: these
          are the same absolutely-positioned hit targets FloatingPaneWindow
          uses, so the browser does the hit-testing and the grab zones stay a
          constant size on screen at any zoom. */}
      {selBounds && tool === "select" && (
        <div
          style={{
            position: "absolute",
            left: (selBounds.x - view.x) * cssPerImage,
            top: (selBounds.y - view.y) * cssPerImage,
            width: Math.max(1, selBounds.w * cssPerImage),
            height: Math.max(1, selBounds.h * cssPerImage),
            outline: "1px solid var(--ezy-accent)",
            outlineOffset: 1,
            pointerEvents: "none",
          }}
        >
          {HANDLES.map(({ anchor, style }) => (
            <div
              key={anchor}
              onPointerDown={onHandlePointerDown(anchor)}
              style={{ position: "absolute", pointerEvents: "auto", ...style }}
            />
          ))}
          {(["nw", "ne", "sw", "se"] as const).map((c) => (
            <div
              key={`pip-${c}`}
              style={{
                position: "absolute",
                width: 6,
                height: 6,
                borderRadius: 1,
                backgroundColor: "var(--ezy-accent)",
                pointerEvents: "none",
                top: c.startsWith("n") ? -3 : undefined,
                bottom: c.startsWith("s") ? -3 : undefined,
                left: c.endsWith("w") ? -3 : undefined,
                right: c.endsWith("e") ? -3 : undefined,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** The in-progress shape for a draw gesture at the current pointer position. */
function draftFrom(
  g: Extract<Gesture, { mode: "draw" }>,
  cur: Point,
): Shape | null {
  const base = { id: g.id, color: g.color, width: g.width };
  switch (g.kind) {
    case "marker":
      return { ...base, kind: "marker", points: g.points };
    case "arrow":
      return { ...base, kind: "arrow", x1: g.start.x, y1: g.start.y, x2: cur.x, y2: cur.y };
    case "rect":
      return { ...base, kind: "rect", ...normalizeRect(g.start, cur) };
    case "ellipse":
      return { ...base, kind: "ellipse", ...normalizeRect(g.start, cur) };
  }
}

/** The crop rect for the current pointer position, clamped to the bitmap. */
function cropFrom(
  g: Extract<Gesture, { mode: "cropMove" | "cropResize" }>,
  cur: Point,
  bounds: Rect,
): Rect {
  const dx = cur.x - g.origin.x;
  const dy = cur.y - g.origin.y;
  if (g.mode === "cropMove") {
    return clampRectToBounds({ ...g.start, x: g.start.x + dx, y: g.start.y + dy }, bounds);
  }
  return clampRectToBounds(resizeRect(g.start, g.anchor, dx, dy, MIN_SIZE), bounds);
}

/** The moved/resized shape for the current pointer position. */
function transformed(
  g: Gesture,
  cur: Point,
  cssPerImage: number,
): Shape | null {
  if (g.mode === "move") {
    const dx = cur.x - g.origin.x;
    const dy = cur.y - g.origin.y;
    // Below the threshold this was a click to select, not a drag to move.
    if (Math.hypot(dx, dy) * cssPerImage < DRAG_THRESHOLD_PX) return null;
    return translateShape(g.startShape, dx, dy);
  }
  if (g.mode === "resize") {
    const to = resizeRect(
      g.startBounds,
      g.anchor,
      cur.x - g.origin.x,
      cur.y - g.origin.y,
      MIN_SIZE,
    );
    return remapShape(g.startShape, g.startBounds, to);
  }
  return null;
}

function ShapeNode({ shape }: { shape: Shape }) {
  const common = {
    stroke: shape.color,
    strokeWidth: shape.width,
    fill: "none",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  if (shape.kind === "marker") {
    return (
      <polyline
        {...common}
        points={pointsAttr(shape.points)}
        strokeOpacity={MARKER_ALPHA}
        // Multiply is what makes this read as highlighter ink over dark
        // terminal text rather than a grey wash. Matches the canvas flatten.
        style={{ mixBlendMode: "multiply" }}
      />
    );
  }

  if (shape.kind === "rect") {
    return <rect {...common} x={shape.x} y={shape.y} width={shape.w} height={shape.h} />;
  }

  if (shape.kind === "ellipse") {
    return (
      <ellipse
        {...common}
        cx={shape.x + shape.w / 2}
        cy={shape.y + shape.h / 2}
        rx={Math.abs(shape.w / 2)}
        ry={Math.abs(shape.h / 2)}
      />
    );
  }

  const { left, right } = arrowHead(shape.x1, shape.y1, shape.x2, shape.y2, shape.width);
  return (
    <g {...common}>
      <line x1={shape.x1} y1={shape.y1} x2={shape.x2} y2={shape.y2} />
      <polyline points={pointsAttr([left, { x: shape.x2, y: shape.y2 }, right])} />
    </g>
  );
}
