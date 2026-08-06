/**
 * Per-ticket Jira canvas layout helpers.
 *
 * A Jira tab's layout is NOT a free-form grid: it is a container of one
 * "pair" per ticket — a horizontal split of the ticket's Claude pane and its
 * own browser pane. Only the SELECTED ticket's pair is displayed; the rest
 * stay in the layout so their panes remain mounted (portals iterate the full
 * layout), which is what keeps background tickets' Claude sessions running.
 * The container shape (nested binary splits) is storage-only and never drawn.
 */
import type { PaneLayout, PaneLeaf, PaneSplit } from "../types";

export const jiraPairId = (ticket: string) => `pane-jira-pair-${ticket}`;
export const jiraTermPaneId = (instKey: string) => `pane-jira-term-${instKey}`;
/** Exported because the pasted-ticket detector reads a browser pane's ticket
 *  back OUT of its id — the pane is all a BrowserPreview knows about itself. */
export const JIRA_BROWSER_PANE_PREFIX = "pane-jira-browser-";
export const jiraBrowserPaneId = (ticket: string) => `${JIRA_BROWSER_PANE_PREFIX}${ticket}`;
/** Assigned-tab browser-only preview (never part of a pair, never in
 *  tab.layout). A DISTINCT prefix keeps it out of pair detection and out of
 *  the pasted-ticket logic, both of which key on the prefixes above. */
export const JIRA_ASSIGNED_PANE_PREFIX = "pane-jira-assigned-";
export const jiraAssignedPaneId = (ticket: string) => `${JIRA_ASSIGNED_PANE_PREFIX}${ticket}`;

const CONTAINER_ID_PREFIX = "pane-jira-root-";
const TERM_GROUP_PREFIX = "pane-jira-terms-";

/**
 * Instance keys. A duplicated ticket ("SUPPORT-24920 #2") shares its BASE
 * ticket's pair — and therefore its browser pane — with the original; only the
 * Claude terminal is per-instance. The instance key is the base ticket for the
 * original and `TICKET#n` for duplicates; `#` can never appear in a real
 * ticket key, so the suffix is unambiguous.
 */
export const jiraInstanceKey = (ticket: string, instance?: number) =>
  instance && instance > 1 ? `${ticket}#${instance}` : ticket;

/** Instance key back out of a term pane's id, or null for any other pane. */
export function jiraInstKeyOfTermPaneId(paneId: string): string | null {
  const prefix = jiraTermPaneId("");
  return paneId.startsWith(prefix) ? paneId.slice(prefix.length) : null;
}

/** Base ticket of an instance key ("SUPPORT-24920#2" → "SUPPORT-24920"). */
export const jiraBaseTicket = (instKey: string) => instKey.replace(/#\d+$/, "");

export function buildJiraTermLeaf(
  instKey: string,
  terminalId: string,
  sessionResumeId?: string,
  /** Which CLI carries this ticket. Persisted in the layout, so a restored
   *  session respawns the same CLI rather than silently reverting to Claude. */
  terminalType: "claude" | "codex" | "gemini" = "claude",
): PaneLeaf {
  return {
    type: "terminal",
    id: jiraTermPaneId(instKey),
    terminalId,
    terminalType,
    sessionResumeId,
  };
}

export function buildJiraPair(
  ticket: string,
  term: PaneLeaf,
  url: string,
  claudeSide: "left" | "right",
): PaneSplit {
  const browser: PaneLayout = { type: "browser", id: jiraBrowserPaneId(ticket), url };
  return {
    type: "split",
    id: jiraPairId(ticket),
    direction: "horizontal",
    children: claudeSide === "left" ? [term, browser] : [browser, term],
    sizes: [50, 50],
  };
}

/** Which side of a pair holds the Claude terminal(s) — the non-browser side.
 *  With duplicates open it is a nested split of instance terminals. */
function termSideIndex(pair: PaneSplit): 0 | 1 {
  return pair.children[0].type === "browser" ? 1 : 0;
}

/**
 * A pair split into the two things the stacked renderer draws: the browser
 * leaf, and every instance terminal on the other side IN STACK ORDER.
 *
 * Order is the nesting order `addJiraTermToPair` builds (each new instance
 * wraps the previous group), which is also the order the instances were
 * opened — so the base ticket stays on top and sub-tickets append below.
 */
export function jiraPairParts(pair: PaneSplit): {
  browser: PaneLayout;
  terms: PaneLeaf[];
  /** Which STORED child holds the terminals. The stacked renderer draws the
   *  sides per the `jiraClaudeSide` setting, so it needs this to map its own
   *  divider position back onto the stored `sizes` pair. */
  termIndex: 0 | 1;
} {
  const ti = termSideIndex(pair);
  const collect = (node: PaneLayout): PaneLeaf[] => {
    if (node.type === "terminal") return [node];
    if (node.type !== "split") return [];
    return [...collect(node.children[0]), ...collect(node.children[1])];
  };
  return {
    browser: pair.children[ti === 0 ? 1 : 0],
    terms: collect(pair.children[ti]),
    termIndex: ti,
  };
}

/** Find one instance's terminal leaf anywhere in the layout. */
export function findJiraTermLeaf(layout: PaneLayout | null, instKey: string): PaneLeaf | null {
  if (!layout) return null;
  if (layout.type === "terminal") {
    return layout.id === jiraTermPaneId(instKey) ? layout : null;
  }
  if (layout.type !== "split") return null;
  return (
    findJiraTermLeaf(layout.children[0], instKey) ?? findJiraTermLeaf(layout.children[1], instKey)
  );
}

/** Nest a duplicate instance's terminal into the base ticket's pair, next to
 *  the terminals already there. The browser side is untouched. */
export function addJiraTermToPair(layout: PaneLayout, ticket: string, term: PaneLeaf): PaneLayout {
  if (layout.type !== "split") return layout;
  if (layout.id === jiraPairId(ticket)) {
    const ti = termSideIndex(layout);
    const group: PaneSplit = {
      type: "split",
      id: `${TERM_GROUP_PREFIX}${term.id}`,
      direction: "horizontal",
      children: [layout.children[ti], term],
      sizes: [50, 50],
    };
    const children = (
      ti === 0 ? [group, layout.children[1]] : [layout.children[0], group]
    ) as [PaneLayout, PaneLayout];
    return { ...layout, children };
  }
  return {
    ...layout,
    children: [
      addJiraTermToPair(layout.children[0], ticket, term),
      addJiraTermToPair(layout.children[1], ticket, term),
    ] as [PaneLayout, PaneLayout],
  };
}

/** Remove ONE instance's terminal. Wrapper groups collapse; when it was the
 *  pair's last terminal the whole pair goes — the browser with it. */
export function removeJiraInstanceTerm(
  layout: PaneLayout | null,
  instKey: string,
): PaneLayout | null {
  if (!layout) return null;
  const target = jiraTermPaneId(instKey);
  const prune = (node: PaneLayout): PaneLayout | null => {
    if (node.type === "terminal") return node.id === target ? null : node;
    if (node.type !== "split") return node;
    const left = prune(node.children[0]);
    const right = prune(node.children[1]);
    if (node.id.startsWith("pane-jira-pair-")) {
      // A pair whose last terminal went away must not leave its browser
      // floating in the container as a free-standing pane.
      const survivor = left ?? right;
      if (!left || !right) return survivor?.type === "browser" ? null : survivor;
    }
    if (left && right) return { ...node, children: [left, right] as [PaneLayout, PaneLayout] };
    return left ?? right;
  };
  return prune(layout);
}

/** All OPEN instance keys, in layout (= opened) order. */
export function listJiraInstanceKeys(layout: PaneLayout | null): string[] {
  if (!layout) return [];
  if (layout.type === "terminal") {
    return layout.id.startsWith("pane-jira-term-")
      ? [layout.id.slice("pane-jira-term-".length)]
      : [];
  }
  if (layout.type !== "split") return [];
  return [
    ...listJiraInstanceKeys(layout.children[0]),
    ...listJiraInstanceKeys(layout.children[1]),
  ];
}

/**
 * The pair subtree to DISPLAY for an instance key: the base pair with its
 * terminal side narrowed to just the selected instance's leaf. Every other
 * instance's terminal exists only in the STORED layout, which keeps its pane
 * mounted (portals iterate the full layout) and its session running. The
 * browser leaf is the same node either way — switching instances never
 * remounts it.
 */
export function displayJiraPairFor(
  layout: PaneLayout | null,
  instKey: string,
  /** "stacked" shows EVERY instance of the ticket at once (the stacked
   *  renderer lays the term side out itself, so the stored sub-tree is handed
   *  back untouched). "default" narrows to the selected instance. */
  mode: "default" | "stacked" = "default",
): PaneSplit | null {
  const pair = findJiraPair(layout, jiraBaseTicket(instKey));
  if (!pair) return null;
  if (mode === "stacked") return pair;
  const ti = termSideIndex(pair);
  const termSide = pair.children[ti];
  const term =
    termSide.type === "terminal"
      ? termSide.id === jiraTermPaneId(instKey)
        ? termSide
        : null
      : findJiraTermLeaf(termSide, instKey);
  if (!term) return null;
  if (term === termSide) return pair; // single instance — stored pair as-is
  const children = (
    ti === 0 ? [term, pair.children[1]] : [pair.children[0], term]
  ) as [PaneLayout, PaneLayout];
  return { ...pair, children };
}

/**
 * Merge the displayed pair's divider position back onto the stored pair
 * WITHOUT adopting its structure — the displayed term side holds only the
 * selected instance, so a wholesale replace would drop every other instance's
 * terminal from the layout and kill their sessions.
 */
export function writeBackJiraPairSizes(
  layout: PaneLayout,
  instKey: string,
  displayed: PaneSplit,
): PaneLayout {
  if (!displayed.sizes) return layout;
  const base = jiraBaseTicket(instKey);
  const apply = (node: PaneLayout): PaneLayout => {
    if (node.type !== "split") return node;
    if (node.id === jiraPairId(base)) {
      const flipped = termSideIndex(node) !== termSideIndex(displayed);
      const sizes = (
        flipped ? [displayed.sizes![1], displayed.sizes![0]] : displayed.sizes!
      ) as [number, number];
      return { ...node, sizes };
    }
    return {
      ...node,
      children: [apply(node.children[0]), apply(node.children[1])] as [PaneLayout, PaneLayout],
    };
  };
  return apply(layout);
}

export function findJiraPair(layout: PaneLayout | null, ticket: string): PaneSplit | null {
  if (!layout) return null;
  if (layout.type === "split") {
    if (layout.id === jiraPairId(ticket)) return layout;
    return findJiraPair(layout.children[0], ticket) ?? findJiraPair(layout.children[1], ticket);
  }
  return null;
}

/** Ensure the pair's Claude pane sits on the configured side (applied at
 *  display time, so flipping the setting reorients every ticket at once). */
export function orientJiraPair(pair: PaneSplit, claudeSide: "left" | "right"): PaneSplit {
  const [a, b] = pair.children;
  const termFirst = a.type === "terminal";
  const wantTermFirst = claudeSide === "left";
  if (termFirst === wantTermFirst) return pair;
  const sizes = pair.sizes ? ([pair.sizes[1], pair.sizes[0]] as [number, number]) : undefined;
  return { ...pair, children: [b, a], sizes };
}

/** Append a pair to the storage container (never-displayed nesting). */
export function appendJiraPair(layout: PaneLayout | null, pair: PaneSplit): PaneLayout {
  if (!layout) return pair;
  return {
    type: "split",
    id: `${CONTAINER_ID_PREFIX}${pair.id}`,
    direction: "horizontal",
    children: [layout, pair],
    sizes: [50, 50],
  };
}

/** Replace the pair for `ticket` (resize write-back from the displayed grid). */
export function replaceJiraPair(layout: PaneLayout, ticket: string, next: PaneSplit): PaneLayout {
  if (layout.type === "split") {
    if (layout.id === jiraPairId(ticket)) return next;
    return {
      ...layout,
      children: [
        replaceJiraPair(layout.children[0], ticket, next),
        replaceJiraPair(layout.children[1], ticket, next),
      ] as [PaneLayout, PaneLayout],
    };
  }
  return layout;
}

/** Remove a ticket's pair; collapses the container node around it. */
export function removeJiraPair(layout: PaneLayout | null, ticket: string): PaneLayout | null {
  if (!layout) return null;
  if (layout.type !== "split") return layout;
  if (layout.id === jiraPairId(ticket)) return null;
  const left = removeJiraPair(layout.children[0], ticket);
  const right = removeJiraPair(layout.children[1], ticket);
  if (left && right) {
    return { ...layout, children: [left, right] as [PaneLayout, PaneLayout] };
  }
  return left ?? right;
}

/** True when a layout is already in per-ticket-pair form (every leaf lives
 *  under a pane-jira-pair-* split). Old free-form Jira grids return false and
 *  get rebuilt. */
export function isJiraPairLayout(layout: PaneLayout): boolean {
  if (layout.type === "split") {
    if (layout.id.startsWith("pane-jira-pair-")) return true;
    if (layout.id.startsWith(CONTAINER_ID_PREFIX)) {
      return isJiraPairLayout(layout.children[0]) && isJiraPairLayout(layout.children[1]);
    }
    return false;
  }
  return false;
}

/** All tickets that currently have a pair in the layout. */
export function listJiraPairTickets(layout: PaneLayout | null): string[] {
  if (!layout || layout.type !== "split") return [];
  if (layout.id.startsWith("pane-jira-pair-")) {
    return [layout.id.slice("pane-jira-pair-".length)];
  }
  return [...listJiraPairTickets(layout.children[0]), ...listJiraPairTickets(layout.children[1])];
}
