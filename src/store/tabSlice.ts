import type { StateCreator } from "zustand";
import type { Tab, PaneLayout, DevServer, TerminalBackend, TerminalType } from "../types";
import { generatePaneId, generateTerminalId, setSessionResumeIdInLayout, findAllTerminalLeaves, setTerminalTypeInLayout } from "../lib/layout-utils";
import { snapshotTab } from "./undoCloseStore";
import { getPtyWrite } from "./terminalSlice";
import { detectBackendForPath } from "../lib/platform";
import type { RecentProject } from "./recentProjectsSlice";

/** Resolve the terminal backend for a new tab: per-project preference > path detection > global setting. */
function resolveBackend(
  workingDir: string,
  serverId: string | undefined,
  root: Record<string, unknown>,
): TerminalBackend {
  const globalBackend = (root.terminalBackend as TerminalBackend | undefined) ?? "wsl";
  if (!workingDir) return globalBackend;
  const projects = (root.recentProjects as RecentProject[] | undefined) ?? [];
  const norm = workingDir.replace(/\\/g, "/");
  const proj = projects.find(
    (p) => p.path.replace(/\\/g, "/") === norm && p.serverId === serverId,
  );
  return proj?.preferredBackend ?? detectBackendForPath(workingDir, globalBackend);
}

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
  addTabWithLayout: (name: string, workingDir: string, layout: PaneLayout | null, serverId?: string, options?: { isJiraProject?: boolean; jiraSiteId?: string; jiraProjectKey?: string }) => string;
  /** Jira project: re-point which site NEW tickets in this tab open on
   *  (rail-header switcher; open pairs keep their persisted URLs). */
  setTabJiraSite: (tabId: string, siteId: string) => void;
  removeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  updateTabLayout: (tabId: string, layout: PaneLayout | null) => void;
  /** Jira project: switch which ticket's pane pair the canvas shows. */
  setSelectedJiraTicket: (tabId: string, ticket: string | undefined) => void;
  /** Atomically update a pane's sessionResumeId inside set() to avoid read-modify-write races. */
  updatePaneSessionResumeId: (tabId: string, terminalId: string, sessionResumeId: string | undefined) => void;
  togglePinTab: (tabId: string) => void;
  renameTab: (tabId: string, name: string) => void;
  /** Replace the tab's BASE name (`name`), not the user's rename
   *  (`customName`) — for derived titles like the Jira site suffix. */
  setTabName: (tabId: string, name: string) => void;
  reorderTabs: (draggedId: string, insertBeforeId: string | null) => void;
  /** Kill the tab's PTYs but keep its layout (incl. sessionResumeIds); the WSL
   *  processes are freed. Refuses system/remote tabs, tabs with dev-server
   *  panes, and the last remaining tab when active. See canHibernateTab. */
  hibernateTab: (tabId: string) => void;
  /** Respawn a hibernated tab's layout — Claude panes resume via --resume. */
  wakeTab: (tabId: string) => void;
}

/** Why a tab can't hibernate, or null when it can. Shared by the store action
 *  (enforcement), the tab context menu (disabled-with-reason) and the
 *  auto-hibernate engine (candidate filter). */
export function tabHibernateBlocker(
  tab: Tab | undefined,
  terminals: Record<string, { type: string }>,
  isOnlyTab: boolean,
): string | null {
  if (!tab) return "Tab not found";
  if (tab.isHibernated) return "Already hibernated";
  if (tab.isDevServerTab || tab.isServersTab || tab.isKanbanTab || tab.isSettingsTab)
    return "System tabs can't hibernate";
  if (tab.serverId) return "Remote tabs can't hibernate";
  if (!tab.layout) return "Nothing to hibernate";
  const leaves = findAllTerminalLeaves(tab.layout);
  if (leaves.length === 0) return "No terminal panes";
  if (leaves.some((l) => terminals[l.terminalId]?.type === "devserver"))
    return "A dev server is running in this tab";
  if (isOnlyTab) return "Can't hibernate the only tab";
  return null;
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
    const backend = resolveBackend(workingDir, serverId, get() as unknown as Record<string, unknown>);
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

  addTabWithLayout: (name, workingDir, layout, serverId?, options?) => {
    const tabId = `tab-${Date.now()}`;
    const backend = resolveBackend(workingDir, serverId, get() as unknown as Record<string, unknown>);
    set((state) => ({
      tabs: [
        ...state.tabs,
        { id: tabId, name, workingDir, layout, serverId, backend, isJiraProject: options?.isJiraProject, jiraSiteId: options?.jiraSiteId, jiraProjectKey: options?.jiraProjectKey } as Tab,
      ],
      activeTabId: tabId,
      ...(workingDir ? { lastActiveProjectPath: workingDir } : {}),
    }) as Partial<TabSlice> & { lastActiveProjectPath?: string });
    window.scrollTo(0, 0);
    return tabId;
  },

  setTabJiraSite: (tabId, siteId) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, jiraSiteId: siteId } : t)),
    })),

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
    // Activating a hibernated tab wakes it (respawn BEFORE the tab renders so
    // the layout never shows the empty-state launcher).
    if (get().tabs.find((t) => t.id === tabId)?.isHibernated) {
      get().wakeTab(tabId);
    }
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

  setSelectedJiraTicket: (tabId, ticket) => {
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, selectedJiraTicket: ticket } : t)),
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

  setTabName: (tabId, name) => {
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, name } : t)),
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

  hibernateTab: (tabId) => {
    const root = get() as unknown as TabSlice & {
      terminals: Record<string, { type: TerminalType }>;
      removeTerminals: (ids: string[]) => void;
    };
    const tab = root.tabs.find((t) => t.id === tabId);
    const otherTabs = root.tabs.filter(
      (t) => t.id !== tabId && !t.isDevServerTab && !t.isServersTab && !t.isKanbanTab && !t.isSettingsTab,
    );
    const isActive = root.activeTabId === tabId;
    if (tabHibernateBlocker(tab, root.terminals, isActive && otherTabs.length === 0)) return;
    const leaves = findAllTerminalLeaves(tab!.layout!);

    // Stamp terminalType onto every leaf BEFORE killing: interactively-created
    // leaves may lack it, and wake falls back to "shell" — a claude pane would
    // come back as bash. The live terminals map is the truth right now.
    let layout = tab!.layout!;
    for (const leaf of leaves) {
      const live = root.terminals[leaf.terminalId];
      if (live && !leaf.terminalType) {
        layout = setTerminalTypeInLayout(layout, leaf.terminalId, live.type);
      }
    }

    // If hibernating the active tab, hand activation to the last other
    // project tab first (same neighbor choice as removeTab).
    const newActive = isActive ? otherTabs[otherTabs.length - 1] : undefined;
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId ? { ...t, layout, isHibernated: true, hibernatedAt: Date.now() } : t,
      ),
      ...(newActive ? { activeTabId: newActive.id } : {}),
      ...(newActive?.workingDir ? { lastActiveProjectPath: newActive.workingDir } : {}),
    }) as Partial<TabSlice> & { lastActiveProjectPath?: string });
    // AFTER the tab is flagged: unmounting panes is what kills the PTYs, and
    // the flag is what stops Workspace's spawn paths from resurrecting them.
    root.removeTerminals(leaves.map((l) => l.terminalId));
  },

  wakeTab: (tabId) => {
    const root = get() as unknown as TabSlice & {
      terminals: Record<string, unknown>;
      addTerminals: (batch: Array<{ id: string; type: string; workingDir: string; serverId?: string }>) => void;
    };
    const tab = root.tabs.find((t) => t.id === tabId);
    if (!tab?.isHibernated) return;
    if (tab.layout) {
      const missing = findAllTerminalLeaves(tab.layout).filter(
        (l) => !root.terminals[l.terminalId],
      );
      if (missing.length) {
        root.addTerminals(
          missing.map((l) => ({
            id: l.terminalId,
            type: l.terminalType ?? "shell",
            // Keyed Jira panes persist their CLI-group folder on the leaf —
            // the resumed transcript lives under it (see PaneLeaf.cwd).
            workingDir: l.cwd ?? tab.workingDir,
            serverId: tab.serverId,
          })),
        );
      }
    }
    // Terminals exist first, THEN the flag clears — Workspace's guards stay up
    // until the layout has something to render.
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId ? { ...t, isHibernated: false, hibernatedAt: undefined } : t,
      ),
    }));
  },
});
