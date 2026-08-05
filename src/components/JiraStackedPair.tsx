/**
 * Stacked sub-ticket canvas (Settings → Jira → "Sub-ticket mode: Stacked").
 *
 * Default mode shows ONE instance of a ticket at a time and the rail swaps
 * between them. Stacked mode shows them all at once: the base ticket on top,
 * each sub-ticket below it, sharing the ticket's single browser beside them.
 *
 * Why this bypasses PaneGrid rather than extending it: the grid's splits are
 * strictly BINARY, so N instances live there as a nested tree, and a collapsed
 * pane needs an exact pixel height that a tree of percentage splits cannot
 * express. Here the term side is ONE flat PanelGroup — order preserved,
 * dividers between the expanded panes, and collapsed panes pinned to the
 * header height.
 *
 * Collapsing is deliberately just a height. A pane folded to its header gives
 * its terminal anchor a zero-height rect, which `TerminalPaneNative`'s geometry
 * tick already treats as "not laid out": it hides the HWND and skips the
 * resize, so folding never reflows the conversation inside. Nothing in the
 * native layer needed to learn about this feature.
 */
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from "react-resizable-panels";
import type { PaneLeaf, PaneSplit } from "../types";
import { useAppStore } from "../store";
import { jiraPairParts, jiraPairId, jiraTermPaneId } from "../lib/jira-layout";
import { TerminalSlotHost, BrowserSlotHost, useSplitterDragging } from "./PaneSlotHost";

/** Pane header height (TerminalHeader's fixed 28px). A collapsed pane is
 *  exactly this tall, so only its header — and its chevron — remain. */
const HEADER_PX = 28;

/** Smallest share an EXPANDED pane may be dragged to. Below roughly this the
 *  pane shows a header and two lines, which reads as broken rather than small
 *  — collapsing is the way to make a pane small. */
const MIN_EXPANDED_PCT = 8;

export default function JiraStackedPair({
  tabId,
  pair,
  claudeSide,
  getTerminalSlot,
  onPairSizes,
}: {
  tabId: string;
  /** The ticket's stored pair: browser on one side, every instance's terminal
   *  on the other. Handed over untouched by `displayJiraPairFor(…, "stacked")`. */
  pair: PaneSplit;
  claudeSide: "left" | "right";
  getTerminalSlot: (terminalId: string) => HTMLDivElement;
  /** Divider position, already mapped back to STORED child order. */
  onPairSizes?: (sizes: [number, number]) => void;
}) {
  const { browser, terms, termIndex } = jiraPairParts(pair);
  const ticket = pair.id.slice(jiraPairId("").length);

  const collapsedMap = useAppStore((s) => s.jiraStackCollapsed);
  const setStackSizes = useAppStore((s) => s.setJiraStackSizes);
  const storedSizes = useAppStore((s) => s.jiraStackSizes?.[`${tabId}:${ticket}`]);
  const onDragging = useSplitterDragging();

  const instKeyOf = useCallback(
    (leaf: PaneLeaf) => leaf.id.slice(jiraTermPaneId("").length),
    [],
  );
  const isCollapsed = useCallback(
    (leaf: PaneLeaf) => !!collapsedMap?.[`${tabId}:${instKeyOf(leaf)}`],
    [collapsedMap, tabId, instKeyOf],
  );

  const expandedCount = terms.filter((t) => !isCollapsed(t)).length;

  // Collapsed panes are pinned in PIXELS, but the library speaks percentages —
  // so the pinned share is recomputed whenever the column resizes.
  const columnRef = useRef<HTMLDivElement>(null);
  const [columnPx, setColumnPx] = useState(0);
  useEffect(() => {
    const el = columnRef.current;
    if (!el) return;
    const read = () => setColumnPx(el.getBoundingClientRect().height);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Before the first measurement, claim nothing rather than a wrong share.
  const collapsedPct = columnPx > 0 ? Math.min(50, (HEADER_PX / columnPx) * 100) : 0;

  // Stored sizes cover the EXPANDED panes only, in stack order. A stale array
  // (an instance opened or closed since the last drag) is dropped rather than
  // misapplied — equal share is always a correct answer.
  const sizes = storedSizes?.length === expandedCount ? storedSizes : null;
  const freeSpace = Math.max(0, 100 - collapsedPct * (terms.length - expandedCount));
  const equalShare = expandedCount > 0 ? freeSpace / expandedCount : 100;

  // Drive collapse imperatively: a Panel reads `defaultSize` once, so the only
  // way a re-render can fold one is to ask it to. Re-runs on `collapsedPct` too
  // — the pinned share is a percentage of a column height that changes.
  const panelRefs = useRef(new Map<string, ImperativePanelHandle>());
  useEffect(() => {
    for (const leaf of terms) {
      const handle = panelRefs.current.get(leaf.id);
      if (!handle) continue;
      const shouldCollapse = isCollapsed(leaf);
      if (shouldCollapse && !handle.isCollapsed()) handle.collapse();
      else if (!shouldCollapse && handle.isCollapsed()) handle.expand();
    }
  }, [terms, isCollapsed, collapsedPct]);

  const termsRef = useRef(terms);
  termsRef.current = terms;
  const handleStackLayout = useCallback(
    (next: number[]) => {
      // The callback reports EVERY panel including the pinned ones; only the
      // expanded panes' shares are ours to replay.
      const kept = next.filter((_, i) => {
        const leaf = termsRef.current[i];
        return leaf && !isCollapsed(leaf);
      });
      if (kept.length > 0) setStackSizes(tabId, ticket, kept);
    },
    [tabId, ticket, isCollapsed, setStackSizes],
  );

  const handlePairLayout = useCallback(
    (next: number[]) => {
      if (next.length !== 2 || !onPairSizes) return;
      // `next` is in DISPLAY order; the layout stores stored-child order.
      const stackFirst = claudeSide === "left";
      const termShare = stackFirst ? next[0] : next[1];
      const browserShare = stackFirst ? next[1] : next[0];
      onPairSizes(
        termIndex === 0 ? [termShare, browserShare] : [browserShare, termShare],
      );
    },
    [claudeSide, termIndex, onPairSizes],
  );

  const stack = (
    <div ref={columnRef} className="h-full w-full">
      <PanelGroup direction="vertical" onLayout={handleStackLayout}>
        {terms.map((leaf, i) => {
          const collapsed = isCollapsed(leaf);
          // Index among the EXPANDED panes — what the stored size array is
          // keyed by, since collapsed panes hold no share.
          const expandedIndex = terms.slice(0, i).filter((t) => !isCollapsed(t)).length;
          const size = collapsed ? collapsedPct : (sizes?.[expandedIndex] ?? equalShare);
          // A divider only means something when BOTH neighbours can give.
          const inert = i > 0 && (collapsed || isCollapsed(terms[i - 1]));
          return (
            <Fragment key={leaf.id}>
              {i > 0 && (
                <PanelResizeHandle
                  onDragging={onDragging}
                  disabled={inert}
                  style={{
                    height: 4,
                    backgroundColor: "var(--ezy-surface-raised)",
                    cursor: inert ? "default" : "row-resize",
                    position: "relative",
                  }}
                />
              )}
              <Panel
                id={leaf.id}
                order={i}
                ref={(h: ImperativePanelHandle | null) => {
                  if (h) panelRefs.current.set(leaf.id, h);
                  else panelRefs.current.delete(leaf.id);
                }}
                defaultSize={size}
                // The library's own collapse API. A Panel is uncontrolled after
                // mount, so re-rendering with a smaller `defaultSize` would NOT
                // move it — collapse has to be driven imperatively (see the
                // sync effect above).
                collapsible
                collapsedSize={collapsedPct}
                minSize={MIN_EXPANDED_PCT}
              >
                <TerminalSlotHost
                  paneId={leaf.id}
                  terminalId={leaf.terminalId}
                  getTerminalSlot={getTerminalSlot}
                />
              </Panel>
            </Fragment>
          );
        })}
      </PanelGroup>
    </div>
  );

  const browserSide = <BrowserSlotHost paneId={browser.id} />;
  const storedTermShare = pair.sizes?.[termIndex] ?? 50;
  const storedBrowserShare = pair.sizes?.[termIndex === 0 ? 1 : 0] ?? 50;
  const stackFirst = claudeSide === "left";

  return (
    <div data-grid-root className="h-full w-full" style={{ backgroundColor: "var(--ezy-bg)" }}>
      <PanelGroup direction="horizontal" onLayout={handlePairLayout}>
        <Panel minSize={15} defaultSize={stackFirst ? storedTermShare : storedBrowserShare}>
          {stackFirst ? stack : browserSide}
        </Panel>
        <PanelResizeHandle
          onDragging={onDragging}
          style={{
            width: 4,
            backgroundColor: "var(--ezy-surface-raised)",
            cursor: "col-resize",
            position: "relative",
          }}
        />
        <Panel minSize={15} defaultSize={stackFirst ? storedBrowserShare : storedTermShare}>
          {stackFirst ? browserSide : stack}
        </Panel>
      </PanelGroup>
    </div>
  );
}
