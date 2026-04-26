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
import { createSessionSlice, type SessionSlice } from "./sessionSlice";
import { createAiTimeSlice, type AiTimeSlice } from "./aiTimeSlice";
import type { Tab } from "../types";

export type AppStore = TabSlice & TerminalSlice & ServerSlice & ThemeSlice & KanbanSlice & LaunchConfigSlice & SnippetSlice & HistorySlice & SidebarSlice & RecentProjectsSlice & GameSlice & SessionSlice & AiTimeSlice;

function isSystemTab(tab: Tab): boolean {
  return !!(tab.isDevServerTab || tab.isServersTab || tab.isKanbanTab || tab.isSettingsTab);
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
      ...createSessionSlice(...a),
      ...createAiTimeSlice(...a),
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
        lastActiveProjectPath: state.lastActiveProjectPath,
        alwaysShowTemplatePicker: state.alwaysShowTemplatePicker,
        restoreLastSession: state.restoreLastSession,
        autoInsertClipboardImage: state.autoInsertClipboardImage,
        cliFontSizes: state.cliFontSizes,
        cliYolo: state.cliYolo,
        promptComposerEnabled: state.promptComposerEnabled,
        promptComposerAlwaysVisible: state.promptComposerAlwaysVisible,
        composerExpansion: state.composerExpansion,
        maskImagePathsInTerminal: state.maskImagePathsInTerminal,
        showKanbanButton: state.showKanbanButton,
        panePromptHistory: state.panePromptHistory,
        globalPromptHistory: state.globalPromptHistory,
        autoStartServerCommand: state.autoStartServerCommand,
        previewInProjectTab: state.previewInProjectTab,
        customServerCommands: state.customServerCommands,
        browserFullColumn: state.browserFullColumn,
        browserSpawnLeft: state.browserSpawnLeft,
        copyOnSelect: state.copyOnSelect,
        confirmQuit: state.confirmQuit,
        codeReviewCollapseAll: state.codeReviewCollapseAll,
        showTabPath: state.showTabPath,
        openPanesInBackground: state.openPanesInBackground,
        wideGridLayout: state.wideGridLayout,
        redistributeOnClose: state.redistributeOnClose,
        autoMinimizeGameOnAiDone: state.autoMinimizeGameOnAiDone,
        terminalBackend: state.terminalBackend,
        commitMsgMode: state.commitMsgMode,
        shadowAiCli: state.shadowAiCli,
        projectColors: state.projectColors,
        statuslineToggles: state.statuslineToggles,
        vibrantColors: state.vibrantColors,
        highscores: state.highscores,
        timedHighscores: state.timedHighscores,
        gameStats: state.gameStats,
        completedCrosswordIds: state.completedCrosswordIds,
        customCrosswords: state.customCrosswords,
        projectSessions: state.projectSessions,
        aiTimeBursts: state.aiTimeBursts,
        onboardingCompleted: state.onboardingCompleted,
        showChangelogOnUpdate: state.showChangelogOnUpdate,
        lastSeenVersion: state.lastSeenVersion,
        pendingChangelog: state.pendingChangelog,
        pullWithRebase: state.pullWithRebase,
        projectsDir: state.projectsDir,
        defaultClaudeMdPath: state.defaultClaudeMdPath,
        defaultAgentsMdPath: state.defaultAgentsMdPath,
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

        // Fix activeTabId if it pointed to a dropped tab or the dev-server-tab (now a sidebar panel).
        // Preference order for the fallback:
        //   1. persisted activeTabId if it still resolves to a known tab
        //   2. tab whose workingDir matches lastActiveProjectPath (last-focused project)
        //   3. first non-system (project) tab
        //   4. first tab of any kind
        const tabIds = new Set(filteredTabs.map((t) => t.id));
        const projectTabs = filteredTabs.filter((t) => !isSystemTab(t));
        const lastPath = (state.lastActiveProjectPath ?? "").replace(/\\/g, "/");
        const lastActiveProjectTab = lastPath
          ? projectTabs.find((t) => (t.workingDir ?? "").replace(/\\/g, "/") === lastPath)
          : undefined;

        let activeTabId =
          state.activeTabId && tabIds.has(state.activeTabId)
            ? state.activeTabId
            : (lastActiveProjectTab?.id ?? projectTabs[0]?.id ?? filteredTabs[0]?.id ?? current.activeTabId);

        // Dev server tab is no longer a full page — always redirect to a project tab when possible.
        if (activeTabId === "dev-server-tab") {
          activeTabId = lastActiveProjectTab?.id ?? projectTabs[0]?.id ?? filteredTabs[0]?.id ?? current.activeTabId;
        }

        // Migrate legacy claudeYolo → cliYolo
        const persAny = state as Record<string, unknown>;
        let cliYolo = state.cliYolo ?? {};
        if (persAny.claudeYolo === true && !cliYolo.claude) {
          cliYolo = { ...cliYolo, claude: true };
        }

        // Migrate legacy promptHistory → panePromptHistory + globalPromptHistory
        if (persAny.promptHistory && Array.isArray(persAny.promptHistory) && !state.globalPromptHistory) {
          (state as Record<string, unknown>).globalPromptHistory = persAny.promptHistory;
          (state as Record<string, unknown>).panePromptHistory = {};
        }

        // One-shot migration: before detectBackendForPath was fixed, projects
        // on Windows-filesystem paths inherited the global "wsl" fallback as
        // their preferredBackend, which sent PowerShell panes to
        // `wsl --cd …` instead of Set-Location. Strip the stamp so
        // resolveBackend re-detects on next tab open. Covers C:\… drives,
        // /mnt/<drive>/ views, and non-WSL UNCs.
        // Helper: is this path Windows-filesystem-shaped?
        const isWindowsFsPath = (raw: string): boolean => {
          if (!raw) return false;
          const norm = raw.replace(/\\/g, "/").toLowerCase();
          const isWslFs =
            norm.startsWith("/home/") ||
            norm.startsWith("/root/") ||
            norm.startsWith("//wsl.localhost/") ||
            norm.startsWith("//wsl$/");
          if (isWslFs) return false;
          return (
            /^[a-z]:\//.test(norm) ||
            /^\/mnt\/[a-z]\//.test(norm) ||
            norm.startsWith("//")
          );
        };
        if (state.recentProjects && Array.isArray(state.recentProjects)) {
          state.recentProjects = state.recentProjects.map((p) => {
            if (p.preferredBackend !== "wsl" || !p.path) return p;
            if (isWindowsFsPath(p.path)) {
              const { preferredBackend, ...rest } = p;
              void preferredBackend;
              return rest;
            }
            return p;
          });
        }
        // Also fix already-open tabs: tab.backend is stamped at addTab time and
        // never re-derived. Any tab on a Windows-filesystem path stamped "wsl"
        // came from the same buggy detection. Flip to "windows" so the next
        // PTY spawn for that tab uses Set-Location.
        if (state.tabs && Array.isArray(state.tabs)) {
          state.tabs = state.tabs.map((t) => {
            if (t.backend !== "wsl" || !t.workingDir) return t;
            if (isWindowsFsPath(t.workingDir)) {
              return { ...t, backend: "windows" };
            }
            return t;
          });
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

        const projectSessions = {
          ...current.projectSessions,
          ...state.projectSessions,
        };

        const aiTimeBursts = state.aiTimeBursts ?? current.aiTimeBursts;

        // Auto-complete onboarding for existing users who already have persisted state
        const onboardingCompleted = state.onboardingCompleted ?? true;

        return {
          ...current,
          ...state,
          tabs: filteredTabs,
          activeTabId,
          cliYolo,
          gameStats,
          highscores,
          timedHighscores,
          projectSessions,
          aiTimeBursts,
          onboardingCompleted,
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
