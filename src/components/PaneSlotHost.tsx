/**
 * The two pane placeholders every layout renderer needs.
 *
 * A terminal's DOM lives in a persistent slot element owned by Workspace and is
 * re-parented into whichever placeholder currently represents it; a browser
 * pane's placeholder is a pure positioning anchor whose fixed-position iframe
 * overlays it. Extracted from `PaneGrid` so the Jira stacked renderer hosts
 * panes through the SAME code — the scroll-restore step below is the kind of
 * detail a second copy silently loses.
 */
import { useCallback, useEffect, useRef, type ReactElement } from "react";
import { flushNow, setDragActive } from "../native-term/frameSync";

/**
 * `onDragging` handler for a splitter, shared by every pane renderer.
 *
 * Native panes are OS windows repositioned from a frame-sync batch; a drag
 * arms that coalescer and the release flushes it on the NEXT frame, after the
 * final layout has landed. The unmount guard matters: a pane closed mid-drag
 * would otherwise leave the coalescer armed forever and freeze every later
 * geometry update.
 */
export function useSplitterDragging(): (isDragging: boolean) => void {
  const armedRef = useRef(false);
  useEffect(
    () => () => {
      if (armedRef.current) {
        armedRef.current = false;
        setDragActive(false);
      }
    },
    [],
  );
  return useCallback((isDragging: boolean) => {
    armedRef.current = isDragging;
    setDragActive(isDragging);
    if (!isDragging) requestAnimationFrame(() => flushNow());
  }, []);
}

/**
 * Placeholder that adopts a terminal's slot element.
 *
 * Re-parenting resets `scrollTop` to 0 with no scroll event on a detached
 * node, so the saved value TerminalPane keeps on the viewport is re-applied
 * after the move. Without it, every layout restructure scrolls xterm panes to
 * the top.
 */
export function TerminalSlotHost({
  paneId,
  terminalId,
  getTerminalSlot,
}: {
  paneId: string;
  terminalId: string;
  getTerminalSlot: (terminalId: string) => HTMLDivElement;
}): ReactElement {
  return (
    <div
      data-pane-id={paneId}
      className="h-full w-full"
      ref={(el) => {
        if (!el) return;
        const slot = getTerminalSlot(terminalId);
        if (slot.parentElement === el) return;
        // Drop a stale slot (a previous terminal assigned to this pane).
        while (el.firstChild) el.removeChild(el.firstChild);
        el.appendChild(slot);
        const viewport = slot.querySelector(".xterm-viewport") as HTMLElement | null;
        const saved = viewport?.dataset.savedScrollTop;
        if (viewport && saved) {
          const scrollTop = parseFloat(saved);
          if (scrollTop > 0) viewport.scrollTop = scrollTop;
        }
      }}
    />
  );
}

/** Positioning anchor for a browser pane. The iframe/webview never moves in the
 *  DOM — Workspace overlays it onto this rect — so it never reloads. */
export function BrowserSlotHost({ paneId }: { paneId: string }): ReactElement {
  return (
    <div data-pane-id={paneId} data-browser-pane-id={paneId} className="h-full w-full" />
  );
}
