import { invoke } from "@tauri-apps/api/core";

/**
 * Screenshot markup: shape model, geometry and the flatten-to-PNG pipeline.
 *
 * ## Everything is in IMAGE-PIXEL space
 *
 * Not screen pixels, ever. The SVG editing layer is given
 * `viewBox="0 0 natural.w natural.h"` at a CSS size of `dispW × dispH`, so the
 * browser scales shapes and stroke widths for free — zoom, pan, expand and
 * window-resize cost nothing, and what the user sees is exactly what
 * `flattenToPng` reproduces on the canvas. Storing screen coordinates would
 * mean re-deriving every shape on every zoom change and would still drift.
 *
 * That also means stroke widths must NOT use `vector-effect: non-scaling-stroke`
 * in the SVG layer: a stroke is 8 image pixels, and it should look thicker as
 * you zoom in, because it will be 8 image pixels in the exported file.
 */

export type Tool = "select" | "marker" | "rect" | "ellipse" | "arrow" | "crop";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ShapeBase {
  id: string;
  color: string;
  /** Stroke width in IMAGE pixels. */
  width: number;
}

export type Shape =
  | (ShapeBase & { kind: "marker"; points: Point[] })
  | (ShapeBase & { kind: "rect"; x: number; y: number; w: number; h: number })
  | (ShapeBase & { kind: "ellipse"; x: number; y: number; w: number; h: number })
  | (ShapeBase & { kind: "arrow"; x1: number; y1: number; x2: number; y2: number });

export type ShapeKind = Shape["kind"];

/**
 * Highlighter opacity. Paired with `multiply` compositing in both the SVG layer
 * and the canvas flatten — plain alpha over dark terminal text reads as a grey
 * smear, while multiply keeps the text legible and looks like actual ink.
 */
export const MARKER_ALPHA = 0.35;

/**
 * The four size steps, in image pixels — one scale per tool family.
 *
 * The size control picks an INDEX, not a width, so the same four buttons drive
 * every tool. A highlighter and an outline need wildly different numbers to
 * feel like the same "medium": 4px is a sensible box border and an invisible
 * marker. These marker widths are sized to cover a line of terminal text at
 * their lower end and a heading at their upper.
 */
export const THICKNESS_PRESETS = [2, 4, 8, 14] as const;
export const MARKER_THICKNESS_PRESETS = [12, 20, 32, 52] as const;

export function resolveThickness(tool: Tool, index: number): number {
  const table = tool === "marker" ? MARKER_THICKNESS_PRESETS : THICKNESS_PRESETS;
  return table[Math.min(table.length - 1, Math.max(0, index))];
}

/** Nib width in CSS px, and the bounds its height is allowed to take. */
const NIB_W = 11;
const NIB_MIN_H = 10;
/** Chromium accepts cursors up to 128px; past ~64 one stops being a pointer. */
const NIB_MAX_H = 64;

/**
 * The highlighter cursor IS the nib: a vertical rounded bar as tall as the
 * stroke it will lay down, in the ink it will lay down, centred on the pointer.
 *
 * A pen-shaped icon (the first attempt) and a crosshair share the same problem
 * — both say "a point goes here", when what you actually need to know before
 * dragging across a line of text is *how tall the band will be and where its
 * edges land*. Showing the real footprint means you line the cursor up with the
 * text instead of guessing and undoing.
 *
 * Height is derived from the on-screen stroke size, so it tracks both the size
 * preset and the zoom level. It is clamped at both ends: below `NIB_MIN_H` the
 * cursor is too small to aim, above `NIB_MAX_H` it stops reading as a pointer.
 * Inside that band it is exact.
 */
export function markerCursor(strokeCssPx: number, color: string): string {
  const h = Math.round(
    Math.min(NIB_MAX_H, Math.max(NIB_MIN_H, strokeCssPx)),
  );
  const w = NIB_W;
  const r = (w - 3) / 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    // Dark outer edge then a light inner one, so the nib is visible against a
    // white screenshot and a black terminal alike.
    `<rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="${r + 0.5}" ` +
    `fill="${color}" fill-opacity="0.45" stroke="#111827" stroke-width="2"/>` +
    `<rect x="2" y="2" width="${w - 4}" height="${h - 4}" rx="${r}" ` +
    `fill="none" stroke="#ffffff" stroke-width="1"/>` +
    `</svg>`;
  // Hotspot at the centre: the stroke is drawn centred on the pointer path, so
  // the nib has to straddle it the same way.
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${Math.floor(
    w / 2,
  )} ${Math.floor(h / 2)}, crosshair`;
}

/** Drag distance before a press becomes a drag rather than a click. */
export const DRAG_THRESHOLD_PX = 4;

// ---------------------------------------------------------------------------
// Coordinate mapping
// ---------------------------------------------------------------------------

/**
 * Viewport coordinate → image pixel.
 *
 * `stageRect` must come from `getBoundingClientRect()` — its fractional width
 * is what makes this exact. The stage's `clientWidth` is an integer and rounds
 * the centring term, which shows up as a visible offset at high zoom.
 *
 * The image is centred in the stage by flexbox and then translated by `pan`,
 * so its top-left is `centre - half the displayed size + pan`.
 */
export function screenToImage(
  clientX: number,
  clientY: number,
  stageRect: { left: number; top: number; width: number; height: number },
  dispW: number,
  dispH: number,
  pan: Point,
  view: Rect,
): Point {
  const imgLeft = stageRect.left + (stageRect.width - dispW) / 2 + pan.x;
  const imgTop = stageRect.top + (stageRect.height - dispH) / 2 + pan.y;
  // `view.x/y` is the offset of a confirmed crop: the pixel in the top-left of
  // the stage is not image pixel 0,0 once the view has been clipped, but every
  // shape is still stored in FULL-image coordinates.
  return {
    x: view.x + ((clientX - imgLeft) * view.w) / dispW,
    y: view.y + ((clientY - imgTop) * view.h) / dispH,
  };
}

/** Image pixels per CSS pixel — for turning a screen tolerance into image units. */
export function imagePerCssPx(view: { w: number }, dispW: number): number {
  return dispW > 0 ? view.w / dispW : 1;
}

/** Clamp a point into the visible region. */
export function clampToBounds(p: Point, bounds: Rect): Point {
  return {
    x: Math.min(bounds.x + bounds.w, Math.max(bounds.x, p.x)),
    y: Math.min(bounds.y + bounds.h, Math.max(bounds.y, p.y)),
  };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export function normalizeRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

/** Axis-aligned bounds, stroke excluded. */
export function boundsOf(shape: Shape): Rect {
  switch (shape.kind) {
    case "rect":
    case "ellipse":
      return { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
    case "arrow":
      return normalizeRect(
        { x: shape.x1, y: shape.y1 },
        { x: shape.x2, y: shape.y2 },
      );
    case "marker": {
      if (shape.points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of shape.points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
  }
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Is this point on the shape?
 *
 * Outline shapes are hit on their OUTLINE, not their filled area. A big
 * rectangle drawn around a region would otherwise swallow every click meant for
 * the shapes inside it — which is the whole point of drawing a box around them.
 * `tolerance` is in image pixels; callers scale a screen-space slop by
 * `imagePerCssPx` so the grab zone stays constant on screen at any zoom.
 */
export function hitTest(shape: Shape, p: Point, tolerance: number): boolean {
  const slop = shape.width / 2 + tolerance;

  switch (shape.kind) {
    case "marker": {
      for (let i = 1; i < shape.points.length; i++) {
        if (distToSegment(p, shape.points[i - 1], shape.points[i]) <= slop) return true;
      }
      // A single-point tap still deserves a hit target.
      return (
        shape.points.length === 1 &&
        Math.hypot(p.x - shape.points[0].x, p.y - shape.points[0].y) <= slop
      );
    }
    case "arrow":
      return (
        distToSegment(p, { x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 }) <= slop
      );
    case "rect": {
      const { x, y, w, h } = shape;
      const inOuter = p.x >= x - slop && p.x <= x + w + slop && p.y >= y - slop && p.y <= y + h + slop;
      if (!inOuter) return false;
      const inInner = p.x > x + slop && p.x < x + w - slop && p.y > y + slop && p.y < y + h - slop;
      return !inInner;
    }
    case "ellipse": {
      const rx = shape.w / 2;
      const ry = shape.h / 2;
      if (rx <= 0 || ry <= 0) return false;
      const cx = shape.x + rx;
      const cy = shape.y + ry;
      const nx = (p.x - cx) / rx;
      const ny = (p.y - cy) / ry;
      const d = Math.sqrt(nx * nx + ny * ny);
      // Convert the normalised radial error back into pixels along the
      // shorter axis — good enough for a grab test, and cheap.
      return Math.abs(d - 1) * Math.min(rx, ry) <= slop;
    }
  }
}

/** Topmost shape under the point, or null. Later shapes render on top. */
export function pickShape(shapes: Shape[], p: Point, tolerance: number): Shape | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    if (hitTest(shapes[i], p, tolerance)) return shapes[i];
  }
  return null;
}

export function translateShape(shape: Shape, dx: number, dy: number): Shape {
  switch (shape.kind) {
    case "marker":
      return { ...shape, points: shape.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
    case "arrow":
      return { ...shape, x1: shape.x1 + dx, y1: shape.y1 + dy, x2: shape.x2 + dx, y2: shape.y2 + dy };
    default:
      return { ...shape, x: shape.x + dx, y: shape.y + dy };
  }
}

/**
 * Map a shape from one bounding box into another.
 *
 * One routine covers resize for every kind: rects and ellipses simply become
 * the new box, while arrows and marker strokes have their points remapped
 * proportionally. A zero-width or zero-height source (a perfectly horizontal
 * arrow) would divide by zero, so those axes translate instead of scaling.
 */
export function remapShape(shape: Shape, from: Rect, to: Rect): Shape {
  const sx = from.w === 0 ? 1 : to.w / from.w;
  const sy = from.h === 0 ? 1 : to.h / from.h;
  const mapX = (x: number) => to.x + (x - from.x) * sx;
  const mapY = (y: number) => to.y + (y - from.y) * sy;

  switch (shape.kind) {
    case "marker":
      return { ...shape, points: shape.points.map((p) => ({ x: mapX(p.x), y: mapY(p.y) })) };
    case "arrow":
      return {
        ...shape,
        x1: mapX(shape.x1),
        y1: mapY(shape.y1),
        x2: mapX(shape.x2),
        y2: mapY(shape.y2),
      };
    default:
      return { ...shape, x: to.x, y: to.y, w: to.w, h: to.h };
  }
}

/**
 * Two crop interactions, side by side so they can be compared.
 *
 * - `v1` — draw a region, then move and resize it.
 * - `v2` — a dashed frame sits on the image bounds from the moment the tool is
 *   armed; you trim by dragging its borders inward.
 */
export type CropVariant = "v1" | "v2";

/**
 * A crop is pending until it is confirmed.
 *
 * Pending dims the excluded area so you can judge the framing; confirming
 * actually clips the view to `rect`, so what you then see IS the result rather
 * than a preview of it. Both states are undoable.
 */
export interface CropState {
  rect: Rect;
  confirmed: boolean;
}

/** The region of the bitmap currently on screen — the confirmed crop, else all of it. */
export function viewRegion(
  crop: CropState | null,
  natural: { w: number; h: number },
): Rect {
  return crop?.confirmed ? crop.rect : { x: 0, y: 0, w: natural.w, h: natural.h };
}

/**
 * Keep a crop inside the visible region. Size is preserved where possible.
 *
 * Bounded by the VIEW, not the whole bitmap: once a crop is confirmed the rest
 * of the image is off screen, and a second crop must not be able to reach back
 * out into pixels the user can no longer see.
 */
export function clampRectToBounds(r: Rect, bounds: Rect): Rect {
  const w = Math.min(r.w, bounds.w);
  const h = Math.min(r.h, bounds.h);
  return {
    w,
    h,
    x: Math.min(bounds.x + bounds.w - w, Math.max(bounds.x, r.x)),
    y: Math.min(bounds.y + bounds.h - h, Math.max(bounds.y, r.y)),
  };
}

/**
 * Does this crop actually remove anything?
 *
 * v2 seeds a full-bounds frame the moment the tool is armed, and that must not
 * count as an edit — it would light up "Save as new" before the user has done
 * anything.
 */
export function isRealCrop(
  crop: CropState | null,
  natural: { w: number; h: number } | null,
): boolean {
  if (!crop || !natural) return false;
  const EPS = 1;
  const r = crop.rect;
  return (
    r.x > EPS || r.y > EPS || r.w < natural.w - EPS || r.h < natural.h - EPS
  );
}

export type Anchor = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/**
 * New bounds for a handle drag. Mirrors `FloatingPaneWindow`'s resize maths —
 * clamping to the minimum pins the opposite edge instead of letting the box
 * jitter around the cursor.
 */
export function resizeRect(start: Rect, anchor: Anchor, dx: number, dy: number, min: number): Rect {
  let { x, y, w, h } = start;
  if (anchor.includes("e")) w = Math.max(min, start.w + dx);
  if (anchor.includes("s")) h = Math.max(min, start.h + dy);
  if (anchor.includes("w")) {
    const nw = Math.max(min, start.w - dx);
    x = start.x + (start.w - nw);
    w = nw;
  }
  if (anchor.includes("n")) {
    const nh = Math.max(min, start.h - dy);
    y = start.y + (start.h - nh);
    h = nh;
  }
  return { x, y, w, h };
}

/**
 * Thin out a freehand stroke. A slow drag emits a point per pointermove — tens
 * of thousands for one gesture — which bloats the undo stack and the SVG path
 * for no visible gain at this stroke width.
 */
export function simplifyPoints(points: Point[], minDist = 2): Point[] {
  if (points.length < 3) return points;
  const out: Point[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = out[out.length - 1];
    if (Math.hypot(points[i].x - prev.x, points[i].y - prev.y) >= minDist) {
      out.push(points[i]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

/** SVG `points` attribute for a marker stroke. */
export function pointsAttr(points: Point[]): string {
  return points.map((p) => `${p.x},${p.y}`).join(" ");
}

/** Where the two arrowhead barbs land, in image space. */
export function arrowHead(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
): { left: Point; right: Point } {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  // Scales with the stroke so a thick arrow doesn't end in a pinpoint.
  const len = Math.max(width * 3.2, 8);
  const spread = Math.PI / 7;
  return {
    left: { x: x2 - len * Math.cos(angle - spread), y: y2 - len * Math.sin(angle - spread) },
    right: { x: x2 - len * Math.cos(angle + spread), y: y2 - len * Math.sin(angle + spread) },
  };
}

// ---------------------------------------------------------------------------
// Flatten + save
// ---------------------------------------------------------------------------

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not decode the screenshot"));
    img.src = src;
  });
}

function drawShape(ctx: CanvasRenderingContext2D, shape: Shape): void {
  ctx.save();
  ctx.strokeStyle = shape.color;
  ctx.lineWidth = shape.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (shape.kind === "marker") {
    // Matches the SVG layer's `mix-blend-mode: multiply` + stroke-opacity, so
    // what was drawn on screen is what lands in the file.
    ctx.globalAlpha = MARKER_ALPHA;
    ctx.globalCompositeOperation = "multiply";
    ctx.beginPath();
    shape.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    // A single tap has no line to stroke — emit a dot instead of nothing.
    if (shape.points.length === 1) ctx.lineTo(shape.points[0].x + 0.01, shape.points[0].y);
    ctx.stroke();
  } else if (shape.kind === "rect") {
    ctx.strokeRect(shape.x, shape.y, shape.w, shape.h);
  } else if (shape.kind === "ellipse") {
    ctx.beginPath();
    ctx.ellipse(
      shape.x + shape.w / 2,
      shape.y + shape.h / 2,
      Math.abs(shape.w / 2),
      Math.abs(shape.h / 2),
      0,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
  } else {
    const { left, right } = arrowHead(shape.x1, shape.y1, shape.x2, shape.y2, shape.width);
    ctx.beginPath();
    ctx.moveTo(shape.x1, shape.y1);
    ctx.lineTo(shape.x2, shape.y2);
    ctx.moveTo(left.x, left.y);
    ctx.lineTo(shape.x2, shape.y2);
    ctx.lineTo(right.x, right.y);
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Composite the screenshot and its annotations into a PNG, returned as bare
 * base64 (no `data:` prefix).
 *
 * The source is a `data:` URL, which does NOT taint the canvas, so `toDataURL`
 * is legal here. Do not swap the source for a cross-origin URL — the taint is
 * silent and `toDataURL` would start throwing.
 */
export async function flattenToPng(
  sourceDataUri: string,
  shapes: Shape[],
  crop: Rect | null,
  natural: { w: number; h: number },
): Promise<string> {
  const img = await loadImage(sourceDataUri);
  const region: Rect = crop ?? { x: 0, y: 0, w: natural.w, h: natural.h };

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(region.w));
  canvas.height = Math.max(1, Math.round(region.h));

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get a 2D context");

  ctx.drawImage(
    img,
    region.x,
    region.y,
    region.w,
    region.h,
    0,
    0,
    canvas.width,
    canvas.height,
  );

  // Shapes are stored in full-image coordinates; shifting the origin lets them
  // be replayed unchanged and lets the canvas clip whatever falls outside a crop.
  ctx.translate(-region.x, -region.y);
  for (const shape of shapes) drawShape(ctx, shape);

  const dataUrl = canvas.toDataURL("image/png");
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

export interface SavedImage {
  path: string;
  /** Snake_case on the wire — `ClipboardImageResult` has no rename_all. */
  data_uri: string;
}

/** Persist flattened bytes. See `save_annotated_image` in lib.rs for the guards. */
export function saveAnnotated(base64Png: string): Promise<SavedImage> {
  return invoke<SavedImage>("save_annotated_image", { base64Png });
}
