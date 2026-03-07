import type { PaneLayout, PaneLeaf, PaneBrowser, PaneSplit, TerminalType } from "../types";

let paneCounter = 0;
export function generatePaneId(): string {
  return `pane-${Date.now()}-${++paneCounter}`;
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

/**
 * Build a PaneLayout tree from a workspace template grid spec.
 * Converts cols x rows → nested PaneSplit tree.
 * "main-side" is a special case: 1 big left + 2 stacked right.
 */
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

export function buildLayoutFromTemplate(
  templateId: string,
  cols: number,
  rows: number
): { layout: PaneLayout; terminalIds: string[] } {
  const terminalIds: string[] = [];

  function makeLeaf(): PaneLeaf {
    const terminalId = generateTerminalId();
    terminalIds.push(terminalId);
    return { type: "terminal", id: generatePaneId(), terminalId };
  }

  // Special case: main + side (1 big + 2 stacked)
  if (templateId === "main-side") {
    const main = makeLeaf();
    const top = makeLeaf();
    const bottom = makeLeaf();
    const rightSplit: PaneSplit = {
      type: "split",
      id: generatePaneId(),
      direction: "vertical",
      children: [top, bottom],
      sizes: [50, 50],
    };
    const layout: PaneSplit = {
      type: "split",
      id: generatePaneId(),
      direction: "horizontal",
      children: [main, rightSplit],
      sizes: [60, 40],
    };
    return { layout, terminalIds };
  }

  // Build a single column (stack rows vertically)
  function buildColumn(rowCount: number): PaneLayout {
    if (rowCount === 1) return makeLeaf();
    const leaves: PaneLeaf[] = [];
    for (let i = 0; i < rowCount; i++) leaves.push(makeLeaf());
    return buildBinaryTree(leaves, "vertical");
  }

  // Build a balanced binary tree from an array of nodes
  function buildBinaryTree(
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
    // Split into two halves
    const mid = Math.ceil(nodes.length / 2);
    const left = buildBinaryTree(nodes.slice(0, mid), direction === "horizontal" ? "vertical" : "horizontal");
    const right = buildBinaryTree(nodes.slice(mid), direction === "horizontal" ? "vertical" : "horizontal");
    return {
      type: "split",
      id: generatePaneId(),
      direction,
      children: [left, right] as [PaneLayout, PaneLayout],
      sizes: [50, 50],
    };
  }

  // Single pane
  if (cols === 1 && rows === 1) {
    return { layout: makeLeaf(), terminalIds };
  }

  // Single row, multiple cols
  if (rows === 1) {
    const columns: PaneLayout[] = [];
    for (let c = 0; c < cols; c++) columns.push(makeLeaf());
    return { layout: buildBinaryTree(columns, "horizontal"), terminalIds };
  }

  // Multiple rows and cols: build columns, then combine horizontally
  const columns: PaneLayout[] = [];
  for (let c = 0; c < cols; c++) {
    columns.push(buildColumn(rows));
  }
  return { layout: buildBinaryTree(columns, "horizontal"), terminalIds };
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

/**
 * Add a new leaf pane to the layout in a smart grid pattern.
 * Extracts the current column structure, decides placement, and rebuilds.
 * Caps at MAX_PANES (4x4 grid).
 */
export function addPaneAsGrid(layout: PaneLayout, newLeaf: PaneLayout): PaneLayout {
  const columns = getTopLevelColumns(layout);
  const columnLeaves = columns.map(extractColumnLeaves);

  // Enforce max pane limit
  const totalLeaves = columnLeaves.reduce((sum, col) => sum + col.length, 0);
  if (totalLeaves >= MAX_PANES) return layout;
  const rowCounts = columnLeaves.map((col) => col.length);
  const maxRows = Math.max(...rowCounts);

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

/**
 * Add a browser pane on the far right of the layout, taking full vertical height.
 * Wraps the entire existing layout in a horizontal split with the browser on the right.
 */
export function addBrowserPaneRight(layout: PaneLayout, url: string, sizePercent = 35): { layout: PaneLayout; paneId: string } {
  const paneId = generatePaneId();
  const browserPane: PaneBrowser = { type: "browser", id: paneId, url };
  const newLayout: PaneSplit = {
    type: "split",
    id: generatePaneId(),
    direction: "horizontal",
    children: [layout, browserPane],
    sizes: [100 - sizePercent, sizePercent],
  };
  return { layout: newLayout, paneId };
}
