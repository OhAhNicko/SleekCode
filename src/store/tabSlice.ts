import type { StateCreator } from "zustand";
import type { Tab, PaneLayout } from "../types";
import { generatePaneId, generateTerminalId } from "../lib/layout-utils";

export interface TabSlice {
  tabs: Tab[];
  activeTabId: string;
  addTab: (name: string, workingDir: string, serverId?: string) => void;
  addTabWithLayout: (name: string, workingDir: string, layout: PaneLayout, serverId?: string) => string;
  removeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  updateTabLayout: (tabId: string, layout: PaneLayout) => void;
  togglePinTab: (tabId: string) => void;
}

function createDefaultLayout(_workingDir: string): {
  layout: PaneLayout;
  terminalId: string;
} {
  const terminalId = generateTerminalId();
  return {
    layout: {
      type: "terminal",
      id: generatePaneId(),
      terminalId,
    },
    terminalId,
  };
}

const DEV_SERVER_TAB_ID = "dev-server-tab";
const SERVERS_TAB_ID = "servers-tab";
const KANBAN_TAB_ID = "kanban-tab";

export const createTabSlice: StateCreator<TabSlice, [], [], TabSlice> = (
  set
) => ({
  tabs: [
    {
      id: KANBAN_TAB_ID,
      name: "Tasks",
      workingDir: "",
      layout: { type: "terminal", id: "kanban-pane", terminalId: "" },
      isKanbanTab: true,
    },
    {
      id: DEV_SERVER_TAB_ID,
      name: "Dev Servers",
      workingDir: "",
      layout: { type: "terminal", id: "dev-server-pane", terminalId: "" },
      isDevServerTab: true,
    },
    {
      id: SERVERS_TAB_ID,
      name: "Servers",
      workingDir: "",
      layout: { type: "terminal", id: "servers-pane", terminalId: "" },
      isServersTab: true,
    },
  ],
  activeTabId: KANBAN_TAB_ID,

  addTab: (name, workingDir, serverId?) => {
    const tabId = `tab-${Date.now()}`;
    const { layout } = createDefaultLayout(workingDir);
    set((state) => ({
      tabs: [
        ...state.tabs,
        { id: tabId, name, workingDir, layout, serverId },
      ],
      activeTabId: tabId,
    }));
    window.scrollTo(0, 0);
  },

  addTabWithLayout: (name, workingDir, layout, serverId?) => {
    const tabId = `tab-${Date.now()}`;
    set((state) => ({
      tabs: [
        ...state.tabs,
        { id: tabId, name, workingDir, layout, serverId },
      ],
      activeTabId: tabId,
    }));
    window.scrollTo(0, 0);
    return tabId;
  },

  removeTab: (tabId) => {
    if (tabId === DEV_SERVER_TAB_ID || tabId === SERVERS_TAB_ID || tabId === KANBAN_TAB_ID) return;
    set((state) => {
      const tab = state.tabs.find((t) => t.id === tabId);
      if (tab?.isPinned) return state;
      const remaining = state.tabs.filter((t) => t.id !== tabId);
      const newActiveId =
        state.activeTabId === tabId
          ? remaining[remaining.length - 1]?.id ?? DEV_SERVER_TAB_ID
          : state.activeTabId;
      return { tabs: remaining, activeTabId: newActiveId };
    });
  },

  setActiveTab: (tabId) => {
    set({ activeTabId: tabId });
    window.scrollTo(0, 0);
  },

  updateTabLayout: (tabId, layout) => {
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, layout } : t)),
    }));
  },

  togglePinTab: (tabId) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId ? { ...t, isPinned: !t.isPinned } : t
      ),
    }));
  },
});
