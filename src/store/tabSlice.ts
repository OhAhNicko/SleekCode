import type { StateCreator } from "zustand";
import type { Tab, PaneLayout, DevServer } from "../types";
import { generatePaneId, generateTerminalId, setSessionResumeIdInLayout } from "../lib/layout-utils";
import { snapshotTab } from "./undoCloseStore";
import { getPtyWrite } from "./terminalSlice";

/** Pending dev server kills — delayed until undo window expires */
const pendingServerKills = new Map<string, { timerId: ReturnType<typeof setTimeout>; serverIds: string[] }>();

const UNDO_DELAY_MS = 5500; // slightly longer than toast (5000ms) to be safe

/** Schedule dev server kills for a closed tab. Cancellable if tab is restored. */
export function scheduleDeferredServerKill(tabId: string, servers: DevServer[]): void {
  // Cancel any existing timer for this tab
  cancelDeferredServerKill(tabId);
  if (servers.length === 0) return;

  const timerId = setTimeout(() => {
    for (const ds of servers) {
      const write = getPtyWrite(ds.terminalId);
      if (write) write("\x03");
    }
    // Remove from devServers in store (dynamic import to avoid circular ref)
    import("./index").then(({ useAppStore }) => {
      const state = useAppStore.getState();
      const currentServers = (state as unknown as { devServers: DevServer[] }).devServers ?? [];
      const remaining = currentServers.filter((ds) => !servers.some((s) => s.id === ds.id));
      useAppStore.setState({ devServers: remaining });
    });
    pendingServerKills.delete(tabId);
  }, UNDO_DELAY_MS);

  pendingServerKills.set(tabId, { timerId, serverIds: servers.map((s) => s.id) });
}

/** Cancel pending server kills when a tab is restored via undo. */
export function cancelDeferredServerKill(tabId: string): void {
  const pending = pendingServerKills.get(tabId);
  if (pending) {
    clearTimeout(pending.timerId);
    pendingServerKills.delete(tabId);
  }
}

export interface TabSlice {
  tabs: Tab[];
  activeTabId: string;
  addTab: (name: string, workingDir: string, serverId?: string) => void;
  addTabWithLayout: (name: string, workingDir: string, layout: PaneLayout | null, serverId?: string) => string;
  removeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  updateTabLayout: (tabId: string, layout: PaneLayout | null) => void;
  /** Atomically update a pane's sessionResumeId inside set() to avoid read-modify-write races. */
  updatePaneSessionResumeId: (tabId: string, terminalId: string, sessionResumeId: string | undefined) => void;
  togglePinTab: (tabId: string) => void;
  renameTab: (tabId: string, name: string) => void;
  reorderTabs: (draggedId: string, insertBeforeId: string | null) => void;
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
export const SETTINGS_TAB_ID = "settings-tab";

export const createTabSlice: StateCreator<TabSlice, [], [], TabSlice> = (
  set, get
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
    {
      id: SETTINGS_TAB_ID,
      name: "Settings",
      workingDir: "",
      layout: { type: "terminal", id: "settings-pane", terminalId: "" },
      isSettingsTab: true,
    },
  ],
  activeTabId: "",  // No default system tab — App.tsx redirect will pick the first project tab

  addTab: (name, workingDir, serverId?) => {
    const tabId = `tab-${Date.now()}`;
    const { layout } = createDefaultLayout(workingDir);
    const backend = ((get() as unknown as Record<string, unknown>).terminalBackend as string | undefined) ?? "wsl";
    set((state) => ({
      tabs: [
        ...state.tabs,
        { id: tabId, name, workingDir, layout, serverId, backend } as Tab,
      ],
      activeTabId: tabId,
      ...(workingDir ? { lastActiveProjectPath: workingDir } : {}),
    }) as Partial<TabSlice> & { lastActiveProjectPath?: string });
    window.scrollTo(0, 0);
  },

  addTabWithLayout: (name, workingDir, layout, serverId?) => {
    const tabId = `tab-${Date.now()}`;
    const backend = ((get() as unknown as Record<string, unknown>).terminalBackend as string | undefined) ?? "wsl";
    set((state) => ({
      tabs: [
        ...state.tabs,
        { id: tabId, name, workingDir, layout, serverId, backend } as Tab,
      ],
      activeTabId: tabId,
      ...(workingDir ? { lastActiveProjectPath: workingDir } : {}),
    }) as Partial<TabSlice> & { lastActiveProjectPath?: string });
    window.scrollTo(0, 0);
    return tabId;
  },

  removeTab: (tabId) => {
    if (tabId === DEV_SERVER_TAB_ID || tabId === SERVERS_TAB_ID || tabId === KANBAN_TAB_ID || tabId === SETTINGS_TAB_ID) return;
    set((state) => {
      const tab = state.tabs.find((t) => t.id === tabId);
      if (tab?.isPinned) return state;
      snapshotTab(tabId);

      // Persist layout to recent project for quick-open restore
      if (tab && tab.layout && !tab.isDevServerTab && !tab.isServersTab && !tab.isKanbanTab && !tab.isSettingsTab) {
        import("./index").then(({ useAppStore }) => {
          useAppStore.getState().updateProjectLayout(tab.workingDir, tab.layout!, tab.serverId);
        });
      }

      // Defer dev server kill — keep servers alive during undo window
      const devServers = (state as unknown as { devServers: DevServer[] }).devServers ?? [];
      const tabServers = devServers.filter((ds) => ds.tabId === tabId);
      scheduleDeferredServerKill(tabId, tabServers);

      const remaining = state.tabs.filter((t) => t.id !== tabId);
      const nonSystemRemaining = remaining.filter((t) => !t.isDevServerTab && !t.isServersTab && !t.isKanbanTab && !t.isSettingsTab);
      const newActiveTab =
        state.activeTabId === tabId
          ? nonSystemRemaining[nonSystemRemaining.length - 1]
          : remaining.find((t) => t.id === state.activeTabId);
      const newActiveId = newActiveTab?.id ?? "";
      const patch: Partial<TabSlice> & { lastActiveProjectPath?: string } = {
        tabs: remaining,
        activeTabId: newActiveId,
      };
      if (newActiveTab && newActiveTab.workingDir && !newActiveTab.isDevServerTab && !newActiveTab.isServersTab && !newActiveTab.isKanbanTab && !newActiveTab.isSettingsTab) {
        patch.lastActiveProjectPath = newActiveTab.workingDir;
      }
      return patch;
    });
  },

  setActiveTab: (tabId) => {
    set((state) => {
      const tab = state.tabs.find((t) => t.id === tabId);
      const isProjectTab = !!(tab && !tab.isDevServerTab && !tab.isServersTab && !tab.isKanbanTab && !tab.isSettingsTab && tab.workingDir);
      return {
        activeTabId: tabId,
        ...(isProjectTab ? { lastActiveProjectPath: tab!.workingDir } : {}),
      } as Partial<TabSlice> & { lastActiveProjectPath?: string };
    });
    window.scrollTo(0, 0);
  },

  updateTabLayout: (tabId, layout) => {
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, layout } : t)),
    }));
  },

  updatePaneSessionResumeId: (tabId, terminalId, sessionResumeId) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId && t.layout
          ? { ...t, layout: setSessionResumeIdInLayout(t.layout, terminalId, sessionResumeId) }
          : t
      ),
    }));
  },

  togglePinTab: (tabId) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId ? { ...t, isPinned: !t.isPinned } : t
      ),
    }));
  },

  renameTab: (tabId, name) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId ? { ...t, customName: name } : t
      ),
    }));
  },

  reorderTabs: (draggedId, insertBeforeId) =>
    set((state) => {
      const tabs = [...state.tabs];
      const fromIdx = tabs.findIndex((t) => t.id === draggedId);
      if (fromIdx === -1) return state;
      const [dragged] = tabs.splice(fromIdx, 1);
      if (insertBeforeId === null) {
        tabs.push(dragged);
      } else {
        const toIdx = tabs.findIndex((t) => t.id === insertBeforeId);
        tabs.splice(toIdx === -1 ? tabs.length : toIdx, 0, dragged);
      }
      return { tabs };
    }),
});
