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
        devServerPanelOpen: state.devServerPanelOpen,
        expandedDirs: state.expandedDirs,
        recentProjects: state.recentProjects,
        alwaysShowTemplatePicker: state.alwaysShowTemplatePicker,
        restoreLastSession: state.restoreLastSession,
        autoInsertClipboardImage: state.autoInsertClipboardImage,
        cliFontSizes: state.cliFontSizes,
        claudeYolo: state.claudeYolo,
        promptComposerEnabled: state.promptComposerEnabled,
        promptComposerAlwaysVisible: state.promptComposerAlwaysVisible,
        promptHistory: state.promptHistory,
        autoStartServerCommand: state.autoStartServerCommand,
        previewInProjectTab: state.previewInProjectTab,
        customServerCommands: state.customServerCommands,
        browserFullColumn: state.browserFullColumn,
        browserSpawnLeft: state.browserSpawnLeft,
        copyOnSelect: state.copyOnSelect,
        confirmQuit: state.confirmQuit,
        projectColors: state.projectColors,
        vibrantColors: state.vibrantColors,
      }),
      merge: (persisted, current) => {
        const state = persisted as Partial<AppStore> | undefined;
        if (!state) return current;

        // When restoreLastSession is on, keep ALL tabs; otherwise only system + pinned
        let filteredTabs = state.tabs
          ? state.restoreLastSession
            ? state.tabs
            : state.tabs.filter((tab) => isSystemTab(tab) || tab.isPinned)
          : current.tabs;

        // Ensure system tabs always exist (may be missing from old persisted state)
        for (const sysTab of current.tabs.filter(isSystemTab)) {
          if (!filteredTabs.some((t) => t.id === sysTab.id)) {
            filteredTabs = [sysTab, ...filteredTabs];
          }
        }

        // Fix activeTabId if it pointed to a dropped tab or the dev-server-tab (now a sidebar panel)
        const tabIds = new Set(filteredTabs.map((t) => t.id));
        let activeTabId =
          state.activeTabId && tabIds.has(state.activeTabId)
            ? state.activeTabId
            : filteredTabs[0]?.id ?? current.activeTabId;
        // Dev server tab is no longer a full page — redirect to first non-system tab
        if (activeTabId === "dev-server-tab") {
          const nonSystem = filteredTabs.find((t) => !t.isDevServerTab && !t.isServersTab && !t.isKanbanTab);
          activeTabId = nonSystem?.id ?? filteredTabs[0]?.id ?? current.activeTabId;
        }

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
