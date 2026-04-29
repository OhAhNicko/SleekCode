/**
 * Lightweight FLIP-style animation helpers using the Web Animations API.
 *
 * No external deps. The element must be in its FINAL position before calling
 * flipFromTo — we animate FROM the captured "from" rect back to identity.
 *
 *  1. capture initial rect: const r = el.getBoundingClientRect()
 *  2. mutate DOM (re-parent, change classes, etc.) so el lands at its final spot
 *  3. flipFromTo(el, r, el.getBoundingClientRect())
 */

export interface FlipOptions {
  duration?: number;
  easing?: string;
  /** WAAPI fill mode. Use "forwards" for close-then-unmount to avoid a snap-back frame. */
  fill?: FillMode;
}

const DEFAULT_DURATION = 220;
const DEFAULT_EASING = "cubic-bezier(0.4, 0, 0.2, 1)";

interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

function toRect(r: DOMRect | RectLike): RectLike {
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

export function flipFromTo(
  el: HTMLElement,
  from: DOMRect | RectLike,
  to: DOMRect | RectLike,
  opts: FlipOptions = {}
): Animation | null {
  const f = toRect(from);
  const t = toRect(to);
  if (t.width === 0 || t.height === 0) return null;

  const dx = f.left - t.left;
  const dy = f.top - t.top;
  const sx = f.width / t.width;
  const sy = f.height / t.height;

  // No measurable transform delta — skip the animation to avoid a no-op flicker.
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.005 && Math.abs(sy - 1) < 0.005) {
    return null;
  }

  return el.animate(
    [
      { transform: `translate3d(${dx}px, ${dy}px, 0) scale(${sx}, ${sy})`, transformOrigin: "0 0" },
      { transform: "translate3d(0, 0, 0) scale(1, 1)", transformOrigin: "0 0" },
    ],
    {
      duration: opts.duration ?? DEFAULT_DURATION,
      easing: opts.easing ?? DEFAULT_EASING,
      fill: opts.fill ?? "none",
    }
  );
}

/**
 * Animate an element's rect (left/top/width/height) from `from` to `to` using
 * absolute positioning. Used for expanded ↔ float transitions where the
 * element stays at the same position-fixed parent but resizes.
 */
export function animateRect(
  el: HTMLElement,
  from: RectLike,
  to: RectLike,
  opts: FlipOptions = {}
): Animation | null {
  if (
    Math.abs(from.left - to.left) < 0.5 &&
    Math.abs(from.top - to.top) < 0.5 &&
    Math.abs(from.width - to.width) < 0.5 &&
    Math.abs(from.height - to.height) < 0.5
  ) {
    return null;
  }
  return el.animate(
    [
      { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` },
      { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px` },
    ],
    {
      duration: opts.duration ?? DEFAULT_DURATION,
      easing: opts.easing ?? DEFAULT_EASING,
      fill: opts.fill ?? "none",
    }
  );
}

/** Default animation timing — exported so consumers stay in sync. */
export const FLIP_DURATION = DEFAULT_DURATION;
export const FLIP_EASING = DEFAULT_EASING;
