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
import { createGameSlice, type GameSlice } from "./gameSlice";
import type { Tab } from "../types";

export type AppStore = TabSlice & TerminalSlice & ServerSlice & ThemeSlice & KanbanSlice & LaunchConfigSlice & SnippetSlice & HistorySlice & SidebarSlice & RecentProjectsSlice & GameSlice;

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
      ...createGameSlice(...a),
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
        // devServerPanelOpen intentionally not persisted — always starts closed
        expandedDirs: state.expandedDirs,
        recentProjects: state.recentProjects,
        alwaysShowTemplatePicker: state.alwaysShowTemplatePicker,
        restoreLastSession: state.restoreLastSession,
        autoInsertClipboardImage: state.autoInsertClipboardImage,
        cliFontSizes: state.cliFontSizes,
        cliYolo: state.cliYolo,
        promptComposerEnabled: state.promptComposerEnabled,
        promptComposerAlwaysVisible: state.promptComposerAlwaysVisible,
        composerExpansion: state.composerExpansion,
        promptHistory: state.promptHistory,
        autoStartServerCommand: state.autoStartServerCommand,
        previewInProjectTab: state.previewInProjectTab,
        customServerCommands: state.customServerCommands,
        browserFullColumn: state.browserFullColumn,
        browserSpawnLeft: state.browserSpawnLeft,
        copyOnSelect: state.copyOnSelect,
        confirmQuit: state.confirmQuit,
        codeReviewCollapseAll: state.codeReviewCollapseAll,
        openPanesInBackground: state.openPanesInBackground,
        autoMinimizeGameOnAiDone: state.autoMinimizeGameOnAiDone,
        terminalBackend: state.terminalBackend,
        commitMsgMode: state.commitMsgMode,
        shadowAiCli: state.shadowAiCli,
        projectColors: state.projectColors,
        vibrantColors: state.vibrantColors,
        highscores: state.highscores,
        timedHighscores: state.timedHighscores,
        gameStats: state.gameStats,
        completedCrosswordIds: state.completedCrosswordIds,
        customCrosswords: state.customCrosswords,
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

        // Migrate legacy claudeYolo → cliYolo
        const persAny = state as Record<string, unknown>;
        let cliYolo = state.cliYolo ?? {};
        if (persAny.claudeYolo === true && !cliYolo.claude) {
          cliYolo = { ...cliYolo, claude: true };
        }

        // Migrate legacy RemoteServer fields → single host
        if (state.servers) {
          state.servers = (state.servers as unknown as Record<string, unknown>[]).map((server) => {
            if ('localIp' in server || 'tailscaleHostname' in server) {
              const host = server.preferTailscale
                ? ((server.tailscaleHostname as string) || (server.localIp as string) || '')
                : ((server.localIp as string) || (server.tailscaleHostname as string) || '');
              // eslint-disable-next-line @typescript-eslint/no-unused-vars
              const { localIp, tailscaleHostname, preferTailscale, defaultDirectory, ...rest } = server;
              return { ...rest, host } as unknown as typeof state.servers extends (infer T)[] ? T : never;
            }
            return server as unknown as typeof state.servers extends (infer T)[] ? T : never;
          }) as typeof state.servers;
        }

        // Deep-merge game-related objects so new entries (e.g. pong, blockBreaker)
        // get defaults even when persisted state was saved before they existed
        const gameStats = {
          ...current.gameStats,
          ...state.gameStats,
        };
        const highscores = {
          ...current.highscores,
          ...state.highscores,
        };
        const timedHighscores = {
          ...current.timedHighscores,
          ...state.timedHighscores,
        };

        return {
          ...current,
          ...state,
          tabs: filteredTabs,
          activeTabId,
          cliYolo,
          gameStats,
          highscores,
          timedHighscores,
          // When session restore is off, reset all panel/sidebar state to defaults
          ...(!state.restoreLastSession && {
            devServerPanelOpen: false,
            sidebarOpen: false,
          }),
        };
      },
    }
  )
);
