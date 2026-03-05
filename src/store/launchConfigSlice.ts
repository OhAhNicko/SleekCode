import type { StateCreator } from "zustand";
import type { PaneLayout, TerminalType } from "../types";
import { generatePaneId, generateTerminalId } from "../lib/layout-utils";

export interface LaunchConfig {
  id: string;
  name: string;
  workingDir: string;
  layout: PaneLayout;
  terminalTypes: Record<string, TerminalType>;
  createdAt: number;
  serverId?: string;
}

export interface LaunchConfigSlice {
  launchConfigs: LaunchConfig[];
  saveLaunchConfig: (name: string, tabId: string) => void;
  loadLaunchConfig: (configId: string) => void;
  deleteLaunchConfig: (configId: string) => void;
  renameLaunchConfig: (configId: string, name: string) => void;
}

/** Walk a layout tree and collect all terminalIds. */
function collectTerminalIds(layout: PaneLayout): string[] {
  if (layout.type === "terminal") return [layout.terminalId];
  if (layout.type === "split") {
    return [
      ...collectTerminalIds(layout.children[0]),
      ...collectTerminalIds(layout.children[1]),
    ];
  }
  return [];
}

/** Deep-clone a layout, replacing all pane IDs and terminal IDs with fresh ones.
 *  Returns the new layout and a mapping from old terminalId to new terminalId. */
function cloneLayoutWithFreshIds(
  layout: PaneLayout
): { layout: PaneLayout; terminalIdMap: Record<string, string> } {
  const terminalIdMap: Record<string, string> = {};

  function walk(node: PaneLayout): PaneLayout {
    if (node.type === "terminal") {
      const newTerminalId = generateTerminalId();
      terminalIdMap[node.terminalId] = newTerminalId;
      return { ...node, id: generatePaneId(), terminalId: newTerminalId };
    }
    if (node.type === "split") {
      return {
        ...node,
        id: generatePaneId(),
        children: [walk(node.children[0]), walk(node.children[1])] as [PaneLayout, PaneLayout],
      };
    }
    // browser, editor, kanban — just give new pane id
    return { ...node, id: generatePaneId() };
  }

  return { layout: walk(layout), terminalIdMap };
}

// We need access to the full store to read tabs/terminals and call addTabWithLayout/addTerminals.
// Use `get` from the StateCreator to access sibling slices at call time.
export const createLaunchConfigSlice: StateCreator<
  // The slice needs to access TabSlice and TerminalSlice methods at runtime.
  // We type it loosely here; the composed store provides the full type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any,
  [],
  [],
  LaunchConfigSlice
> = (set, get) => ({
  launchConfigs: [],

  saveLaunchConfig: (name: string, tabId: string) => {
    const state = get();
    const tab = state.tabs?.find((t: { id: string }) => t.id === tabId);
    if (!tab) return;

    const terminalIds = collectTerminalIds(tab.layout);
    const terminalTypes: Record<string, TerminalType> = {};
    for (const tid of terminalIds) {
      const term = state.terminals?.[tid];
      if (term) terminalTypes[tid] = term.type;
    }

    const config: LaunchConfig = {
      id: `lc-${Date.now()}`,
      name,
      workingDir: tab.workingDir,
      layout: tab.layout,
      terminalTypes,
      createdAt: Date.now(),
      serverId: tab.serverId,
    };

    set((s: { launchConfigs: LaunchConfig[] }) => ({
      launchConfigs: [...s.launchConfigs, config],
    }));
  },

  loadLaunchConfig: (configId: string) => {
    const state = get();
    const config = state.launchConfigs?.find(
      (c: LaunchConfig) => c.id === configId
    );
    if (!config) return;

    const { layout, terminalIdMap } = cloneLayoutWithFreshIds(config.layout);

    // Build terminal batch from the type mapping
    const batch = Object.entries(terminalIdMap).map(([oldId, newId]) => ({
      id: newId,
      type: config.terminalTypes[oldId] ?? ("shell" as TerminalType),
      workingDir: config.workingDir,
      serverId: config.serverId,
    }));

    state.addTerminals?.(batch);
    state.addTabWithLayout?.(config.name, config.workingDir, layout, config.serverId);
  },

  deleteLaunchConfig: (configId: string) => {
    set((s: { launchConfigs: LaunchConfig[] }) => ({
      launchConfigs: s.launchConfigs.filter((c) => c.id !== configId),
    }));
  },

  renameLaunchConfig: (configId: string, name: string) => {
    set((s: { launchConfigs: LaunchConfig[] }) => ({
      launchConfigs: s.launchConfigs.map((c) =>
        c.id === configId ? { ...c, name } : c
      ),
    }));
  },
});
