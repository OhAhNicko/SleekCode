import type { PaneLayout, PaneLeaf, PaneBrowser, PaneKanban, PaneCodeReview, PaneFileViewer, PaneGame, PaneSplit, TerminalType } from "../types";

let paneCounter = 0;
export function generatePaneId(): string {
  return `pane-${Date.now()}-${++paneCounter}`;
}

/**
 * Compute the analytical viewport rect of a leaf pane within a layout tree,
 * given the rect of the grid container. Returns null if the leaf is not in
 * the tree. Walks the binary split tree, dividing the rect by each split's
 * sizes (defaulting to 50/50 when unset). Used by the floating-pane FLIP
 * animation to find a target rect for a leaf that may currently be skipped
 * in PaneGrid (because it's expanded/floating/closing).
 */
export function computeLeafRect(
  layout: PaneLayout,
  paneId: string,
  containerRect: { left: number; top: number; width: number; height: number }
): { left: number; top: number; width: number; height: number } | null {
  if (layout.id === paneId) return { ...containerRect };
  if (layout.type !== "split") return null;
  const sizes = layout.sizes ?? [50, 50];
  const total = sizes[0] + sizes[1] || 1;
  const f0 = sizes[0] / total;
  if (layout.direction === "horizontal") {
    const w0 = containerRect.width * f0;
    const w1 = containerRect.width - w0;
    const r0 = { left: containerRect.left, top: containerRect.top, width: w0, height: containerRect.height };
    const r1 = { left: containerRect.left + w0, top: containerRect.top, width: w1, height: containerRect.height };
    return computeLeafRect(layout.children[0], paneId, r0) ?? computeLeafRect(layout.children[1], paneId, r1);
  }
  const h0 = containerRect.height * f0;
  const h1 = containerRect.height - h0;
  const r0 = { left: containerRect.left, top: containerRect.top, width: containerRect.width, height: h0 };
  const r1 = { left: containerRect.left, top: containerRect.top + h0, width: containerRect.width, height: h1 };
  return computeLeafRect(layout.children[0], paneId, r0) ?? computeLeafRect(layout.children[1], paneId, r1);
}

export function generateTerminalId(): string {
  return `term-${Date.now()}-${++paneCounter}`;
}

export function splitPane(
  layout: PaneLayout,
  targetId: string,
  direction: "horizontal" | "vertical",
  newLeaf: PaneLayout
): PaneLayout {
  if (layout.id === targetId) {
    const split: PaneSplit = {
      type: "split",
      id: generatePaneId(),
      direction,
      children: [layout, newLeaf],
      sizes: [50, 50],
    };
    return split;
  }

  if (layout.type === "split") {
    return {
      ...layout,
      children: [
        splitPane(layout.children[0], targetId, direction, newLeaf),
        splitPane(layout.children[1], targetId, direction, newLeaf),
      ] as [PaneLayout, PaneLayout],
    };
  }

  return layout;
}

export function removePane(
  layout: PaneLayout,
  targetId: string
): PaneLayout | null {
  if (layout.type !== "split") {
    return layout.id === targetId ? null : layout;
  }

  const [first, second] = layout.children;

  if (first.id === targetId) return second;
  if (second.id === targetId) return first;

  const newFirst = removePane(first, targetId);
  const newSecond = removePane(second, targetId);

  if (!newFirst) return newSecond;
  if (!newSecond) return newFirst;

  return {
    ...layout,
    children: [newFirst, newSecond] as [PaneLayout, PaneLayout],
  };
}

// Walk the tree and rebuild every split with sizes proportional to its child
// leaf counts, giving every leaf an equal share of the viewport area.
// Regenerating split ids busts react-resizable-panels' autoSaveId cache so our
// recomputed sizes actually take effect.
export function redistributeEqually(layout: PaneLayout): PaneLayout {
  if (layout.type !== "split") return layout;

  const newFirst = redistributeEqually(layout.children[0]);
  const newSecond = redistributeEqually(layout.children[1]);

  const leftLeaves = countLeafPanes(newFirst);
  const rightLeaves = countLeafPanes(newSecond);
  const total = leftLeaves + rightLeaves;
  const leftPct = (leftLeaves / total) * 100;

  return {
    ...layout,
    id: generatePaneId(),
    children: [newFirst, newSecond] as [PaneLayout, PaneLayout],
    sizes: [leftPct, 100 - leftPct],
  };
}

/** Find the ID of the first leaf pane in a layout tree */
export function findFirstLeafId(layout: PaneLayout): string | null {
  if (layout.type === "split") {
    return findFirstLeafId(layout.children[0]);
  }
  return layout.id;
}

export function findAllTerminalIds(layout: PaneLayout): string[] {
  if (layout.type === "terminal") return [layout.terminalId];
  if (layout.type === "browser") return [];
  if (layout.type === "codereview") return [];
  if (layout.type === "fileviewer") return [];
  if (layout.type === "game") return [];
  if (layout.type === "split") {
    return [
      ...findAllTerminalIds(layout.children[0]),
      ...findAllTerminalIds(layout.children[1]),
    ];
  }
  return [];
}

/** Find the pane ID for a given terminal ID in a layout tree */
export function findPaneIdForTerminal(layout: PaneLayout, terminalId: string): string | null {
  if (layout.type === "terminal" && layout.terminalId === terminalId) return layout.id;
  if (layout.type === "split") {
    return findPaneIdForTerminal(layout.children[0], terminalId) ?? findPaneIdForTerminal(layout.children[1], terminalId);
  }
  return null;
}

/** Swap two leaf panes by their IDs in the layout tree */
export function swapPanes(layout: PaneLayout, idA: string, idB: string): PaneLayout {
  // First pass: find the two nodes
  function findNode(node: PaneLayout, id: string): PaneLayout | null {
    if (node.id === id) return node;
    if (node.type === "split") {
      return findNode(node.children[0], id) ?? findNode(node.children[1], id);
    }
    return null;
  }
  const nodeA = findNode(layout, idA);
  const nodeB = findNode(layout, idB);
  if (!nodeA || !nodeB || idA === idB) return layout;

  // Second pass: replace idA→nodeB, idB→nodeA
  function replace(node: PaneLayout): PaneLayout {
    if (node.id === idA) return { ...nodeB!, id: idA };
    if (node.id === idB) return { ...nodeA!, id: idB };
    if (node.type === "split") {
      return {
        ...node,
        children: [replace(node.children[0]), replace(node.children[1])] as [PaneLayout, PaneLayout],
      };
    }
    return node;
  }
  return replace(layout);
}

/**
 * Distribute `count` panes across `cols` columns.
 * Returns an array of per-column row counts (taller columns first).
 */
function distributeColumns(count: number, cols: number): number[] {
  if (cols <= 0) return [count];
  const base = Math.floor(count / cols);
  const remainder = count % cols;
  return Array.from({ length: cols }, (_, i) => base + (i < remainder ? 1 : 0));
}

/**
 * Build a PaneLayout tree from a workspace template.
 * Supports both rectangular (cols*rows) and non-rectangular (paneCount < cols*rows) grids.
 * `paneCount` overrides `cols * rows` when provided (for 10, 14 session layouts).
 */
export function buildLayoutFromTemplate(
  _templateId: string,
  cols: number,
  rows: number,
  paneCount?: number
): { layout: PaneLayout; terminalIds: string[] } {
  const terminalIds: string[] = [];
  const count = paneCount ?? cols * rows;

  function makeLeaf(): PaneLeaf {
    const terminalId = generateTerminalId();
    terminalIds.push(terminalId);
    return { type: "terminal", id: generatePaneId(), terminalId };
  }

  // Single pane
  if (count === 1) {
    return { layout: makeLeaf(), terminalIds };
  }

  // Compute per-column row counts
  const colHeights = distributeColumns(count, cols);

  // Build each column as a vertical stack
  function buildColumn(rowCount: number): PaneLayout {
    if (rowCount === 1) return makeLeaf();
    const leaves: PaneLeaf[] = [];
    for (let i = 0; i < rowCount; i++) leaves.push(makeLeaf());
    return buildBalancedSameDir(leaves, "vertical");
  }

  const builtColumns = colHeights.map((h) => buildColumn(h));
  return { layout: buildBalancedSameDir(builtColumns, "horizontal"), terminalIds };
}

/** Stamp terminalType onto each terminal leaf, matching by terminalId order */
export function stampTerminalTypes(
  layout: PaneLayout,
  terminalIds: string[],
  types: TerminalType[]
): PaneLayout {
  let result = layout;
  for (let i = 0; i < terminalIds.length; i++) {
    result = setTerminalTypeInLayout(result, terminalIds[i], types[i] ?? "shell");
  }
  return result;
}

/** Collect all terminal leaf nodes from a layout tree */
export function findAllTerminalLeaves(layout: PaneLayout): PaneLeaf[] {
  if (layout.type === "terminal") return [layout];
  if (layout.type === "split") {
    return [
      ...findAllTerminalLeaves(layout.children[0]),
      ...findAllTerminalLeaves(layout.children[1]),
    ];
  }
  return [];
}

/**
 * Extract top-level columns from a layout.
 * Recursively flattens horizontal splits at the root level.
 * Non-horizontal nodes (leaves, vertical splits) are returned as single columns.
 */
function getTopLevelColumns(layout: PaneLayout): PaneLayout[] {
  if (layout.type === "split" && layout.direction === "horizontal") {
    return [
      ...getTopLevelColumns(layout.children[0]),
      ...getTopLevelColumns(layout.children[1]),
    ];
  }
  return [layout];
}

/**
 * Extract leaf-level rows from a single column.
 * Recursively flattens vertical splits; non-vertical nodes are opaque cells.
 */
function extractColumnLeaves(column: PaneLayout): PaneLayout[] {
  if (column.type === "split" && column.direction === "vertical") {
    return [
      ...extractColumnLeaves(column.children[0]),
      ...extractColumnLeaves(column.children[1]),
    ];
  }
  return [column];
}

/**
 * Build a balanced binary tree where ALL splits use the same direction.
 * Sizes are proportional so each node gets equal space.
 */
function buildBalancedSameDir(
  nodes: PaneLayout[],
  direction: "horizontal" | "vertical"
): PaneLayout {
  if (nodes.length === 1) return nodes[0];
  if (nodes.length === 2) {
    return {
      type: "split",
      id: generatePaneId(),
      direction,
      children: [nodes[0], nodes[1]] as [PaneLayout, PaneLayout],
      sizes: [50, 50],
    };
  }
  // Split at midpoint; use proportional sizes so each leaf gets equal width/height
  const mid = Math.ceil(nodes.length / 2);
  const leftPct = (mid / nodes.length) * 100;
  const left = buildBalancedSameDir(nodes.slice(0, mid), direction);
  const right = buildBalancedSameDir(nodes.slice(mid), direction);
  return {
    type: "split",
    id: generatePaneId(),
    direction,
    children: [left, right] as [PaneLayout, PaneLayout],
    sizes: [leftPct, 100 - leftPct],
  };
}

const MAX_PANES = 16;
const MAX_PANES_WITH_KANBAN = 12;

/** Find the kanban pane node in the layout, or null if none */
function findKanbanNode(layout: PaneLayout): PaneKanban | null {
  if (layout.type === "kanban") return layout;
  if (layout.type === "split") {
    return findKanbanNode(layout.children[0]) ?? findKanbanNode(layout.children[1]);
  }
  return null;
}

/**
 * Find a browser/codereview/fileviewer pane that is a direct child of the root
 * horizontal split (i.e., a full-column pane wrapping the terminal grid).
 * Returns the pane, which side it's on, and its size percentage.
 */
function findRootSpecialColumnPane(layout: PaneLayout): {
  pane: PaneLayout;
  side: "left" | "right";
  sizePercent: number;
} | null {
  if (layout.type !== "split" || layout.direction !== "horizontal") return null;
  const sizes = layout.sizes ?? [50, 50];
  const isSpecial = (p: PaneLayout) =>
    p.type === "browser" || p.type === "codereview" || p.type === "fileviewer" || p.type === "game";
  if (isSpecial(layout.children[0])) {
    return { pane: layout.children[0], side: "left", sizePercent: sizes[0] };
  }
  if (isSpecial(layout.children[1])) {
    return { pane: layout.children[1], side: "right", sizePercent: sizes[1] };
  }
  return null;
}

/**
 * Add a new leaf pane to the layout in a smart grid pattern.
 * Extracts the current column structure, decides placement, and rebuilds.
 * Caps at MAX_PANES (4x4 grid), or MAX_PANES_WITH_KANBAN (4x3) when kanban is open.
 *
 * When a kanban pane exists, it is stripped before grid placement and re-attached
 * afterward so the kanban always spans its full row/column.
 * When a browser/codereview/fileviewer pane wraps the layout as a full column,
 * it is similarly stripped and re-attached so new terminals stay in the terminal grid.
 */
export function addPaneAsGrid(layout: PaneLayout, newLeaf: PaneLayout, wideGrid = false): PaneLayout {
  // If kanban exists, strip it, add pane to the grid only, then re-attach
  const kanban = findKanbanNode(layout);
  if (kanban) {
    const stripped = removePane(layout, kanban.id);
    if (!stripped) return layout;

    // Enforce lower pane limit when kanban occupies a full row/column
    if (countLeafPanes(stripped) >= MAX_PANES_WITH_KANBAN) return layout;

    const newGrid = addPaneAsGrid(stripped, newLeaf, wideGrid);
    // If grid didn't change (hit inner max), return original layout
    if (newGrid === stripped) return layout;

    // Re-attach kanban in its original position
    if (kanban.vertical) {
      return {
        type: "split",
        id: generatePaneId(),
        direction: "horizontal",
        children: [newGrid, { ...kanban, id: generatePaneId() }],
        sizes: [70, 30],
      };
    }
    return {
      type: "split",
      id: generatePaneId(),
      direction: "vertical",
      children: [newGrid, { ...kanban, id: generatePaneId() }],
      sizes: [65, 35],
    };
  }

  // If a full-column special pane (browser/codereview/fileviewer) wraps the layout,
  // strip it, add to the inner terminal grid only, then re-attach on the same side.
  const rootSpecial = findRootSpecialColumnPane(layout);
  if (rootSpecial) {
    const stripped = removePane(layout, rootSpecial.pane.id);
    if (!stripped) return layout;

    let newGrid: PaneLayout;
    const strippedCols = getTopLevelColumns(stripped);
    // When the terminal grid has only 1 column with 1 row (single pane), force a
    // vertical split so the new pane stacks below instead of creating an awkward
    // middle column sandwiched between the terminal and the browser.
    if (!wideGrid && strippedCols.length === 1 && extractColumnLeaves(strippedCols[0]).length === 1) {
      if (countLeafPanes(stripped) >= MAX_PANES) return layout;
      newGrid = {
        type: "split",
        id: generatePaneId(),
        direction: "vertical",
        children: [stripped, newLeaf] as [PaneLayout, PaneLayout],
        sizes: [50, 50],
      };
    } else {
      newGrid = addPaneAsGrid(stripped, newLeaf, wideGrid);
      if (newGrid === stripped) return layout;
    }

    const sz = rootSpecial.sizePercent;
    if (rootSpecial.side === "left") {
      return {
        type: "split",
        id: generatePaneId(),
        direction: "horizontal",
        children: [rootSpecial.pane, newGrid] as [PaneLayout, PaneLayout],
        sizes: [sz, 100 - sz],
      };
    } else {
      return {
        type: "split",
        id: generatePaneId(),
        direction: "horizontal",
        children: [newGrid, rootSpecial.pane] as [PaneLayout, PaneLayout],
        sizes: [100 - sz, sz],
      };
    }
  }

  const columns = getTopLevelColumns(layout);
  const columnLeaves = columns.map(extractColumnLeaves);

  // Enforce max pane limit
  const totalLeaves = columnLeaves.reduce((sum, col) => sum + col.length, 0);
  if (totalLeaves >= MAX_PANES) return layout;
  const rowCounts = columnLeaves.map((col) => col.length);
  const maxRows = Math.max(...rowCounts);

  // Wide grid mode: force side-by-side columns until we have 4, then balance
  const WIDE_GRID_MIN_COLS = 4;
  if (wideGrid && columns.length < WIDE_GRID_MIN_COLS) {
    columnLeaves.push([newLeaf]);
  } else {
    // Find the first column that has fewer rows than the tallest
    const shortIdx = rowCounts.findIndex((count) => count < maxRows);

    if (shortIdx !== -1) {
      // Fill the short column
      columnLeaves[shortIdx].push(newLeaf);
    } else if (columns.length > maxRows) {
      // More columns than rows — start a new row in first column
      columnLeaves[0].push(newLeaf);
    } else {
      // Add a new column
      columnLeaves.push([newLeaf]);
    }
  }

  // Rebuild: each column is a vertical tree, then combine horizontally
  const rebuiltColumns = columnLeaves.map((leaves) =>
    buildBalancedSameDir(leaves, "vertical")
  );
  return buildBalancedSameDir(rebuiltColumns, "horizontal");
}

/** Count all leaf panes (terminal, browser, editor, kanban, codereview, fileviewer) in a layout. */
export function countLeafPanes(layout: PaneLayout): number {
  if (layout.type === "split") {
    return countLeafPanes(layout.children[0]) + countLeafPanes(layout.children[1]);
  }
  return 1;
}

/** Walk the layout tree and set sessionResumeId on the matching terminal leaf */
export function setSessionResumeIdInLayout(
  layout: PaneLayout,
  terminalId: string,
  sessionResumeId: string | undefined
): PaneLayout {
  if (layout.type === "terminal" && layout.terminalId === terminalId) {
    return { ...layout, sessionResumeId };
  }
  if (layout.type === "split") {
    return {
      ...layout,
      children: [
        setSessionResumeIdInLayout(layout.children[0], terminalId, sessionResumeId),
        setSessionResumeIdInLayout(layout.children[1], terminalId, sessionResumeId),
      ] as [PaneLayout, PaneLayout],
    };
  }
  return layout;
}

/** Walk the layout tree and set terminalType on the matching terminal leaf */
export function setTerminalTypeInLayout(
  layout: PaneLayout,
  terminalId: string,
  terminalType: TerminalType
): PaneLayout {
  if (layout.type === "terminal" && layout.terminalId === terminalId) {
    return { ...layout, terminalType };
  }
  if (layout.type === "split") {
    return {
      ...layout,
      children: [
        setTerminalTypeInLayout(layout.children[0], terminalId, terminalType),
        setTerminalTypeInLayout(layout.children[1], terminalId, terminalType),
      ] as [PaneLayout, PaneLayout],
    };
  }
  return layout;
}

/** Find all browser panes in a layout tree */
export function findAllBrowserPanes(layout: PaneLayout): PaneBrowser[] {
  if (layout.type === "browser") return [layout];
  if (layout.type === "split") {
    return [
      ...findAllBrowserPanes(layout.children[0]),
      ...findAllBrowserPanes(layout.children[1]),
    ];
  }
  return [];
}

/** Replace url + linkedTabId on a specific browser pane in the tree (immutable). */
export function setBrowserPaneUrl(
  layout: PaneLayout,
  paneId: string,
  url: string,
  linkedTabId?: string,
): PaneLayout {
  if (layout.type === "browser") {
    return layout.id === paneId ? { ...layout, url, linkedTabId } : layout;
  }
  if (layout.type === "split") {
    return {
      ...layout,
      children: [
        setBrowserPaneUrl(layout.children[0], paneId, url, linkedTabId),
        setBrowserPaneUrl(layout.children[1], paneId, url, linkedTabId),
      ] as [PaneLayout, PaneLayout],
    };
  }
  return layout;
}

/**
 * Open a browser pane at `url` while enforcing the "at most one browser pane per
 * tab" invariant: if any browser pane already exists in the tree, retarget the
 * first one to the new URL and prune any stragglers; otherwise insert a fresh
 * pane using the layout-mode flags (full column vs. grid). Use this for
 * URL-driven open-from-link callers (DevServerTab, voice dispatcher) — the
 * toggle-style toolbar buttons in TabBar/VerticalTabBar are unchanged.
 */
export function openOrUpdateBrowserPane(
  layout: PaneLayout,
  url: string,
  options: {
    linkedTabId?: string;
    sizePercent?: number;
    spawnLeft?: boolean;
    fullColumn?: boolean;
    wideGridLayout?: boolean;
  } = {},
): { layout: PaneLayout; paneId: string } {
  const existing = findAllBrowserPanes(layout);

  if (existing.length > 0) {
    // Update first; remove the rest (legacy duplicates from older sessions).
    const target = existing[0];
    let next: PaneLayout | null = layout;
    for (const extra of existing.slice(1)) {
      if (next) next = removePane(next, extra.id);
    }
    if (!next) next = layout;
    next = setBrowserPaneUrl(next, target.id, url, options.linkedTabId);
    return { layout: next, paneId: target.id };
  }

  const sizePercent = options.sizePercent ?? 35;
  if (options.fullColumn) {
    return options.spawnLeft
      ? addBrowserPaneLeft(layout, url, sizePercent, options.linkedTabId)
      : addBrowserPaneRight(layout, url, sizePercent, options.linkedTabId);
  }
  const paneId = generatePaneId();
  const newPane: PaneBrowser = {
    type: "browser",
    id: paneId,
    url,
    linkedTabId: options.linkedTabId,
  };
  const newLayout = addPaneAsGrid(layout, newPane, options.wideGridLayout ?? false);
  return { layout: newLayout, paneId };
}

/** Check if a kanban pane already exists anywhere in the layout tree */
export function hasKanbanPane(layout: PaneLayout): boolean {
  if (layout.type === "kanban") return true;
  if (layout.type === "split") {
    return hasKanbanPane(layout.children[0]) || hasKanbanPane(layout.children[1]);
  }
  return false;
}

/** Find the ID of the kanban pane in the layout, or null if none */
export function findKanbanPaneId(layout: PaneLayout): string | null {
  if (layout.type === "kanban") return layout.id;
  if (layout.type === "split") {
    return findKanbanPaneId(layout.children[0]) ?? findKanbanPaneId(layout.children[1]);
  }
  return null;
}

/**
 * Add a kanban pane with smart placement rules:
 * - If kanban already exists: returns null (caller should toggle/remove)
 * - If ≤2 rows of panes: split down (bottom pane), horizontal kanban columns
 * - If >2 rows: add to the right (like browser preview), vertical kanban layout
 */
export function addKanbanPane(layout: PaneLayout): PaneLayout | null {
  if (hasKanbanPane(layout)) return null;

  const columns = getTopLevelColumns(layout);
  const columnLeaves = columns.map(extractColumnLeaves);
  const maxRows = Math.max(...columnLeaves.map((col) => col.length), 0);

  if (maxRows > 2) {
    // Many rows — add to the right, vertical kanban (1 column, multiple rows)
    const kanbanPane: PaneKanban = { type: "kanban", id: generatePaneId(), vertical: true };
    return {
      type: "split",
      id: generatePaneId(),
      direction: "horizontal",
      children: [layout, kanbanPane],
      sizes: [70, 30],
    };
  }

  // Few rows — add at the bottom, horizontal kanban (several columns side by side)
  const kanbanPane: PaneKanban = { type: "kanban", id: generatePaneId(), vertical: false };
  return {
    type: "split",
    id: generatePaneId(),
    direction: "vertical",
    children: [layout, kanbanPane],
    sizes: [65, 35],
  };
}

/**
 * Reposition an existing kanban pane: remove it and re-add with forced placement.
 * - vertical=true → move to the right, 1-column layout
 * - vertical=false → move to the bottom, multi-column layout
 */
export function repositionKanbanPane(layout: PaneLayout, vertical: boolean): PaneLayout | null {
  const kanbanId = findKanbanPaneId(layout);
  if (!kanbanId) return null;

  const stripped = removePane(layout, kanbanId);
  if (!stripped) return null;

  if (vertical) {
    const kanbanPane: PaneKanban = { type: "kanban", id: generatePaneId(), vertical: true };
    return {
      type: "split",
      id: generatePaneId(),
      direction: "horizontal",
      children: [stripped, kanbanPane],
      sizes: [70, 30],
    };
  }

  const kanbanPane: PaneKanban = { type: "kanban", id: generatePaneId(), vertical: false };
  return {
    type: "split",
    id: generatePaneId(),
    direction: "vertical",
    children: [stripped, kanbanPane],
    sizes: [65, 35],
  };
}

/**
 * Add a browser pane on the far right of the layout, taking full vertical height.
 * Wraps the entire existing layout in a horizontal split with the browser on the right.
 */
export function addBrowserPaneRight(layout: PaneLayout, url: string, sizePercent = 35, linkedTabId?: string): { layout: PaneLayout; paneId: string } {
  const paneId = generatePaneId();
  const browserPane: PaneBrowser = { type: "browser", id: paneId, url, linkedTabId };
  const newLayout: PaneSplit = {
    type: "split",
    id: generatePaneId(),
    direction: "horizontal",
    children: [layout, browserPane],
    sizes: [100 - sizePercent, sizePercent],
  };
  return { layout: newLayout, paneId };
}

/**
 * Add a browser pane on the far left of the layout, taking full vertical height.
 * Wraps the entire existing layout in a horizontal split with the browser on the left.
 */
export function addBrowserPaneLeft(layout: PaneLayout, url: string, sizePercent = 35, linkedTabId?: string): { layout: PaneLayout; paneId: string } {
  const paneId = generatePaneId();
  const browserPane: PaneBrowser = { type: "browser", id: paneId, url, linkedTabId };
  const newLayout: PaneSplit = {
    type: "split",
    id: generatePaneId(),
    direction: "horizontal",
    children: [browserPane, layout],
    sizes: [sizePercent, 100 - sizePercent],
  };
  return { layout: newLayout, paneId };
}

/**
 * Clone a layout tree with fresh pane/terminal IDs.
 * Preserves terminalType, sessionResumeId, sizes, directions, and all non-terminal pane data.
 * Returns the cloned layout plus a list of terminal IDs (for creating TerminalInstance records).
 */
export function cloneLayoutWithFreshIds(
  layout: PaneLayout,
  opts?: { stripResume?: boolean }
): { layout: PaneLayout; terminalIds: { id: string; type: TerminalType; sessionResumeId?: string }[] } {
  const terminalIds: { id: string; type: TerminalType; sessionResumeId?: string }[] = [];

  function walk(node: PaneLayout): PaneLayout {
    switch (node.type) {
      case "terminal": {
        const newId = generateTerminalId();
        const resumeId = opts?.stripResume ? undefined : node.sessionResumeId;
        terminalIds.push({ id: newId, type: node.terminalType ?? "shell", sessionResumeId: resumeId });
        return {
          type: "terminal",
          id: generatePaneId(),
          terminalId: newId,
          terminalType: node.terminalType,
          sessionResumeId: resumeId,
        } as PaneLeaf;
      }
      case "split":
        return {
          type: "split",
          id: generatePaneId(),
          direction: node.direction,
          children: [walk(node.children[0]), walk(node.children[1])] as [PaneLayout, PaneLayout],
          sizes: node.sizes,
        } as PaneSplit;
      case "browser":
        return { type: "browser", id: generatePaneId(), url: node.url, linkedTabId: node.linkedTabId } as PaneBrowser;
      case "kanban":
        return { type: "kanban", id: generatePaneId(), vertical: node.vertical } as PaneKanban;
      case "codereview":
        return { type: "codereview", id: generatePaneId() } as PaneCodeReview;
      case "fileviewer":
        return { type: "fileviewer", id: generatePaneId(), files: [], activeFile: "" } as PaneFileViewer;
      case "game":
        return { type: "game", id: generatePaneId(), game: node.game } as PaneGame;
      case "editor":
        // Editors reference specific files that may not exist — skip, replace with shell
        const editorId = generateTerminalId();
        terminalIds.push({ id: editorId, type: "shell" });
        return { type: "terminal", id: generatePaneId(), terminalId: editorId, terminalType: "shell" } as PaneLeaf;
      default:
        return node;
    }
  }

  return { layout: walk(layout), terminalIds };
}

/** Check if a game pane exists anywhere in the layout tree */
export function hasGamePane(layout: PaneLayout): boolean {
  if (layout.type === "game") return true;
  if (layout.type === "split") {
    return hasGamePane(layout.children[0]) || hasGamePane(layout.children[1]);
  }
  return false;
}

/** Find the ID of the game pane in the layout, or null if none */
export function findGamePaneId(layout: PaneLayout): string | null {
  if (layout.type === "game") return layout.id;
  if (layout.type === "split") {
    return findGamePaneId(layout.children[0]) ?? findGamePaneId(layout.children[1]);
  }
  return null;
}
