// Outside-click dismissal for overlay popups.
//
// WHY THIS EXISTS: menus and dropdowns used to be dismissed by the overlay
// window itself — while one was open the overlay ran REGIONLESS, i.e. covering
// the whole client area and hit-testable everywhere, so any click landed on its
// backdrop div. That single design decision forced the overlay window to be
// hidden and re-regioned around every popup, and those transitions are what
// produced the ghost bugs: a hidden window keeps its last COMPOSITED frame, and
// a region merely CLIPS stale pixels instead of repainting them, so the next
// show/unclip re-displayed a menu at its previous position
// (docs/learnings/2026-07-26-overlay-popup-lifecycle-races.md).
//
// With backdrop mode gone the overlay only ever covers its own popup rects, so
// an outside click never reaches it. Dismissal is therefore driven from the
// MAIN webview instead, from three sources:
//   1. pointerdown anywhere in main's DOM (capture phase) — popups live in the
//      other webview, so any main-side pointerdown is by definition "outside";
//   2. `pointer_down` from a native pane's HWND — panes are OS windows, their
//      clicks never reach main's DOM, and no pre-existing event covered a click
//      on an ALREADY-focused pane;
//   3. the app losing focus.
//
// Ordering note: dismissal fires on POINTERDOWN and opening happens on CLICK,
// so the click that opens a menu dismisses nothing (no popup is open yet) and
// then opens it.
import { useEffect, useRef } from "react";

const EVENT = "made:dismiss-overlay-popups";

/**
 * Broadcast "something was clicked outside every overlay popup".
 *
 * `target` is the DOM node that was pressed, when there is one. Popups whose
 * TRIGGER contains it ignore the event: otherwise a toggle button could never
 * close its own menu — pointerdown would dismiss and the following click would
 * immediately re-open. Native-pane clicks pass null (no DOM target), which
 * matches no trigger and therefore always dismisses.
 */
export function fireOverlayDismiss(target: EventTarget | null = null): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { target } }));
}

/**
 * Close `open` popups on any outside interaction.
 *
 * Used by every popup hook that previously relied on the overlay's backdrop.
 * The latest `close` is held in a ref, so callers may pass a fresh closure
 * every render without the subscription churning (or going stale).
 */
export function useDismissOnOutsidePointer(
  open: boolean,
  close: () => void,
  triggerRef?: { current: HTMLElement | null },
): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  const triggerRefRef = useRef(triggerRef);
  triggerRefRef.current = triggerRef;
  useEffect(() => {
    if (!open) return;
    const onDismiss = (e: Event) => {
      const target = (e as CustomEvent<{ target: EventTarget | null }>).detail
        ?.target;
      const trigger = triggerRefRef.current?.current;
      // A press ON the trigger is that trigger's business (toggle/re-open),
      // never a dismissal.
      if (trigger && target instanceof Node && trigger.contains(target)) return;
      closeRef.current();
    };
    window.addEventListener(EVENT, onDismiss);
    return () => window.removeEventListener(EVENT, onDismiss);
  }, [open]);
}
