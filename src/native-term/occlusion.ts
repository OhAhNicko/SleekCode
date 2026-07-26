// Which native panes are occluded by an expanded / floating pane window.
//
// The expand+float feature is built out of DOM z-index (FloatingPanesLayer: a
// `rgba(0,0,0,0.55)` backdrop at 349, the window at 350+). z-index orders
// things WITHIN the webview, and a native pane is a child HWND — a sibling of
// the WebView2 window — so it renders above all of that no matter what:
//
//   * grid panes paint over the floating window's title bar, border and
//     shadow wherever they overlap (user-reported 2026-07-26);
//   * the backdrop cannot dim them, so in `expanded` mode — which insets the
//     viewport by only 2.5% — any pane not physically covered sits at full
//     brightness on top of the scrim;
//   * z-order BETWEEN the floated pane's surface and the grid panes' surfaces
//     is whatever `bring_above_siblings` last set, not the DOM order, so it
//     shifts as the window is dragged.
//
// DOM cannot be lifted above an HWND, so the only correct answer is to hide
// the panes that would be covered. The rule (design call, 2026-07-26):
//
//   * expanded → hide every native pane except the one inside the window,
//     because the scrim implies everything behind it is dimmed and we cannot
//     dim an HWND;
//   * float → hide only the panes the window actually overlaps, so a small
//     floating window still leaves the rest of the workspace watchable.
//
// The rects come from the DOM, not the store: a drag updates
// FloatingPaneWindow's local state and only commits to `floatRects` on
// pointerup, so the store lags a live drag by the whole gesture.
//
// One querySelectorAll per frame, shared by every pane: the first caller of a
// frame refreshes the cache and the rest reuse it. Without that it would be
// O(panes × floats) layout reads per frame. The cache is keyed on a short time
// bucket rather than a counter the callers bump, because every pane's driver
// runs in the same rAF batch microseconds apart — no cross-module frame
// coordination needed, and worst-case staleness is half a frame.

import type { Rect } from "../lib/native-term-bridge";

/** Every DOM surface that covers native panes and therefore has to hide them.
 *
 * `data-floating-pane-id` — FloatingPaneWindow (expand / float).
 * `data-native-occluder` — any other full-window DOM surface with a backdrop.
 *   The expanded dev-server panel is one: it dims the workspace with an
 *   `rgba(0,0,0,0.4)` layer at z-index 300, which cannot dim an HWND, and its
 *   own terminals are native panes that would otherwise fight the workspace
 *   panes for z-order (user-reported 2026-07-26).
 */
export const OCCLUDER_SELECTOR =
  "[data-floating-pane-id], [data-native-occluder]";
const FLOAT_SELECTOR = OCCLUDER_SELECTOR;

type Occluders = {
  /** Live wrapper rects, viewport coords. */
  rects: DOMRect[];
  /** True when any window is in `expanded` mode. */
  anyExpanded: boolean;
};

let cache: Occluders = { rects: [], anyExpanded: false };
let cachedAt = -1;

/** Half a 60Hz frame — long enough that every pane in one rAF batch shares a
 *  read, short enough that a drag never shows stale geometry. */
const CACHE_TTL_MS = 8;

function refresh(): Occluders {
  const now = performance.now();
  if (now - cachedAt < CACHE_TTL_MS) return cache;
  cachedAt = now;
  const nodes = document.querySelectorAll<HTMLElement>(FLOAT_SELECTOR);
  if (nodes.length === 0) {
    cache = { rects: [], anyExpanded: false };
    return cache;
  }
  const rects: DOMRect[] = [];
  let anyExpanded = false;
  nodes.forEach((el) => {
    rects.push(el.getBoundingClientRect());
    // Both mean "this covers the window behind a backdrop", so nothing outside
    // the host may keep painting.
    if (
      el.dataset.floatingMode === "expanded" ||
      el.dataset.nativeOccluder === "expanded"
    ) {
      anyExpanded = true;
    }
  });
  cache = { rects, anyExpanded };
  return cache;
}

/** Is any pane expanded/floating right now? Lets a caller skip the per-pane
 *  `closest()` tree-walk on the overwhelmingly common no-float path — this
 *  runs for every native pane on every frame. */
export function anyFloatingWindow(): boolean {
  return refresh().rects.length > 0;
}

/**
 * Should the pane anchored at `rect` hide because a floating window covers it?
 *
 * `hostMode` is the host's mode (`data-floating-mode` for a floating window,
 * `data-native-occluder` for the dev-server panel) of the surface this pane
 * lives INSIDE, or null for a pane still in the grid — the caller gets it from
 * `closest()`. A window's own content must never hide itself.
 *
 * `expanded` and `float` can coexist (expandPane only demotes other EXPANDED
 * panes), and their DOM z-order comes from floatOrder, so a float can even
 * outrank the expanded window. Rather than mirror that ordering into HWNDs —
 * which cannot be ordered against DOM at all — an expanded window wins
 * outright: everything hides except its own content. That matches the scrim,
 * which is what the user reads as "this pane is the whole app right now".
 *
 * Two floats overlapping each other are left alone: both are popped-out
 * content, and hiding one would blank the very pane the user pulled out.
 */
export function isOccluded(rect: Rect, hostMode: string | null): boolean {
  const { rects, anyExpanded } = refresh();
  if (rects.length === 0) return false;
  if (anyExpanded) return hostMode !== "expanded" && hostMode !== "closing";
  if (hostMode != null) return false;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  return rects.some(
    (f) => rect.x < f.right && right > f.left && rect.y < f.bottom && bottom > f.top,
  );
}
