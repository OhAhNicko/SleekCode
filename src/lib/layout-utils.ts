import type { PaneLayout, PaneLeaf, PaneSplit } from "../types";

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
