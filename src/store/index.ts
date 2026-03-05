import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createTabSlice, type TabSlice } from "./tabSlice";
import { createTerminalSlice, type TerminalSlice } from "./terminalSlice";
import { createServerSlice, type ServerSlice } from "./serverSlice";
import { createThemeSlice, type ThemeSlice } from "./themeSlice";
import { createKanbanSlice, type KanbanSlice } from "./kanbanSlice";
import { createLaunchConfigSlice, type LaunchConfigSlice } from "./launchConfigSlice";
import { createSnippetSlice, type SnippetSlice } from "./snippetSlice";
import { createHistorySlice, type HistorySlice } from "./historySlice";
import { createSidebarSlice, type SidebarSlice } from "./sidebarSlice";
import { createRecentProjectsSlice, type RecentProjectsSlice } from "./recentProjectsSlice";
import type { Tab } from "../types";

export type AppStore = TabSlice & TerminalSlice & ServerSlice & ThemeSlice & KanbanSlice & LaunchConfigSlice & SnippetSlice & HistorySlice & SidebarSlice & RecentProjectsSlice;

function isSystemTab(tab: Tab): boolean {
  return !!(tab.isDevServerTab || tab.isServersTab || tab.isKanbanTab);
}

export const useAppStore = create<AppStore>()(
  persist(
    (...a) => ({
      ...createTabSlice(...a),
      ...createTerminalSlice(...a),
      ...createServerSlice(...a),
      ...createThemeSlice(...a),
      ...createKanbanSlice(...a),
      ...createLaunchConfigSlice(...a),
      ...createSnippetSlice(...a),
      ...createHistorySlice(...a),
      ...createSidebarSlice(...a),
      ...createRecentProjectsSlice(...a),
    }),
    {
      name: "ezydev-storage",
      partialize: (state) => ({
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        servers: state.servers,
        themeId: state.themeId,
        tasks: state.tasks,
        launchConfigs: state.launchConfigs,
        snippets: state.snippets,
        commandHistory: state.commandHistory,
        sidebarOpen: state.sidebarOpen,
        sidebarTab: state.sidebarTab,
        expandedDirs: state.expandedDirs,
        recentProjects: state.recentProjects,
        alwaysShowTemplatePicker: state.alwaysShowTemplatePicker,
      }),
      merge: (persisted, current) => {
        const state = persisted as Partial<AppStore> | undefined;
        if (!state) return current;

        // Filter tabs: keep system tabs + pinned user tabs, drop the rest
        const filteredTabs = state.tabs
          ? state.tabs.filter((tab) => isSystemTab(tab) || tab.isPinned)
          : current.tabs;

        // Fix activeTabId if it pointed to a dropped tab
        const tabIds = new Set(filteredTabs.map((t) => t.id));
        const activeTabId =
          state.activeTabId && tabIds.has(state.activeTabId)
            ? state.activeTabId
            : filteredTabs[0]?.id ?? current.activeTabId;

        return {
          ...current,
          ...state,
          tabs: filteredTabs,
          activeTabId,
        };
      },
    }
  )
);
