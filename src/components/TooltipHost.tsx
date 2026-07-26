/**
 * App-wide hover tooltips.
 *
 * Mount once. Every element carrying `data-tooltip="..."` gets a themed tooltip
 * — no per-component wiring, no wrapper element, and nothing to remember when
 * adding UI later. Add the attribute and it works:
 *
 *   <button data-tooltip="Prompt history" data-tooltip-shortcut="Ctrl+P">
 *
 * `data-tooltip-hint` adds a second row under the label, separated by a rule —
 * use it for an instruction ("Double-click to open in file manager") so it can
 * never reflow into the middle of a wrapped path.
 *
 * This replaces the browser's native `title=` tooltip, which cannot be styled,
 * ignores the app theme, and shows up on Windows with an OS delay MADE does not
 * control. `data-tooltip-shortcut` is optional and renders as a keycap.
 *
 * Why one delegated listener instead of per-element handlers: 213 call sites.
 * Two document-level listeners cost nothing and cannot fall out of sync with
 * the components, and a tooltip added in a component written next year needs no
 * import.
 *
 * Rendering happens in the OVERLAY webview (see OverlayRoot's `Tooltip`), not
 * here: native terminal panes are real child HWNDs stacked above WebView2, so a
 * DOM tooltip in this webview would be painted underneath them and be invisible
 * over exactly the surfaces that need it most.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useOverlayViewportPopup } from "../lib/useOverlayToast";

/**
 * Dwell before a tooltip appears. 400ms was too eager once these became themed
 * chips instead of the quiet OS tooltip — the same labels that went unnoticed
 * for months suddenly read as clutter. 600ms means a tooltip is something you
 * asked for by pausing, not something that chases the cursor.
 */
const SHOW_DELAY_MS = 600;
/** Grace after hiding during which a sibling shows instantly — standard desktop toolbar feel. */
const WARM_MS = 500;
/** Delay before hiding, so travelling between two adjacent controls doesn't flicker. */
const HIDE_DELAY_MS = 120;

interface TipState {
  anchor: { left: number; top: number; right: number; bottom: number };
  text: string;
  shortcut?: string;
  hint?: string;
}

/** True when any part of the control is clipped by overflow — i.e. there is
 *  text on screen the user genuinely cannot read. */
function isClipped(el: HTMLElement): boolean {
  if (el.scrollWidth > el.clientWidth + 1) return true;
  // The ellipsized node is usually a child span, not the tooltip carrier.
  // Controls here are small, so this walk is a handful of nodes.
  for (const child of el.querySelectorAll<HTMLElement>("*")) {
    if (child.scrollWidth > child.clientWidth + 1) return true;
  }
  return false;
}

/**
 * Suppress tooltips that would only echo text already on screen.
 *
 * Labels like the git branch chip set `data-tooltip={branch}` over a span that
 * renders the same branch with `text-overflow: ellipsis`. That is right when the
 * name is long enough to clip — the tooltip is then the only way to read it —
 * and pure noise when it is not: hovering "main" popped a chip saying "main".
 *
 * Comparing against textContent (never clipped, unlike what is painted) and
 * checking real overflow keeps the useful half and drops the rest, with no
 * per-site curation and nothing for the next person to remember. Tooltips that
 * ADD something — a shortcut, a full path, an explanation — never match, so
 * they are unaffected.
 */
function repeatsVisibleText(el: HTMLElement, tooltip: string): boolean {
  const own = (el.textContent ?? "").trim();
  if (!own || own !== tooltip.trim()) return false;
  return !isClipped(el);
}

export default function TooltipHost() {
  const [tip, setTip] = useState<TipState | null>(null);

  // Element the pointer is currently over, and the timers driving the state
  // machine. Refs throughout: these change on raw pointer events and must not
  // re-render the app.
  const anchorRef = useRef<HTMLElement | null>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastHiddenAt = useRef(0);
  const visibleRef = useRef(false);

  useOverlayViewportPopup({
    id: "app-tooltip",
    kind: "tooltip",
    open: !!tip,
    payload: tip,
  });

  const clearTimers = useCallback(() => {
    if (showTimer.current) {
      clearTimeout(showTimer.current);
      showTimer.current = null;
    }
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const hideNow = useCallback(() => {
    clearTimers();
    anchorRef.current = null;
    if (visibleRef.current) {
      visibleRef.current = false;
      lastHiddenAt.current = Date.now();
    }
    setTip(null);
  }, [clearTimers]);

  const show = useCallback((el: HTMLElement) => {
    const text = el.getAttribute("data-tooltip");
    if (!text) return;
    if (repeatsVisibleText(el, text)) return;
    // Read the rect at SHOW time, not hover time — a pane may have resized
    // during the dwell, and a stale rect would point the arrow at nothing.
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    visibleRef.current = true;
    setTip({
      anchor: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      text,
      shortcut: el.getAttribute("data-tooltip-shortcut") || undefined,
      hint: el.getAttribute("data-tooltip-hint") || undefined,
    });
  }, []);

  useEffect(() => {
    const onOver = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      const el = target?.closest?.("[data-tooltip]") as HTMLElement | null;

      if (!el || !el.getAttribute("data-tooltip")) {
        // Left every tooltip element — close, but on a delay so crossing a 1px
        // gap between two adjacent buttons doesn't blink.
        if (anchorRef.current && !hideTimer.current) {
          clearTimers();
          hideTimer.current = setTimeout(hideNow, HIDE_DELAY_MS);
        }
        return;
      }

      if (el === anchorRef.current) {
        // Re-entered the same element (e.g. moved onto its icon child) — cancel
        // any pending hide and keep what's on screen.
        if (hideTimer.current) {
          clearTimeout(hideTimer.current);
          hideTimer.current = null;
        }
        return;
      }

      clearTimers();
      anchorRef.current = el;

      // Warm: a tooltip was just up, so the user is reading the toolbar. Swap
      // immediately rather than making them wait out the dwell again.
      const warm = visibleRef.current || Date.now() - lastHiddenAt.current < WARM_MS;
      if (warm) {
        show(el);
      } else {
        showTimer.current = setTimeout(() => {
          showTimer.current = null;
          if (anchorRef.current === el && el.isConnected) show(el);
        }, SHOW_DELAY_MS);
      }
    };

    // Any deliberate interaction dismisses instantly: once you have clicked,
    // typed or scrolled, the label has served its purpose and is just in the way.
    const onDismiss = () => {
      if (anchorRef.current || visibleRef.current) hideNow();
    };

    document.addEventListener("pointerover", onOver, true);
    document.addEventListener("pointerdown", onDismiss, true);
    document.addEventListener("keydown", onDismiss, true);
    document.addEventListener("wheel", onDismiss, true);
    // Scroll does not bubble — capture catches it from any scroller.
    document.addEventListener("scroll", onDismiss, true);
    window.addEventListener("blur", onDismiss);

    return () => {
      document.removeEventListener("pointerover", onOver, true);
      document.removeEventListener("pointerdown", onDismiss, true);
      document.removeEventListener("keydown", onDismiss, true);
      document.removeEventListener("wheel", onDismiss, true);
      document.removeEventListener("scroll", onDismiss, true);
      window.removeEventListener("blur", onDismiss);
      clearTimers();
    };
  }, [clearTimers, hideNow, show]);

  return null;
}
