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
import { createFloatingPanesSlice, type FloatingPanesSlice } from "./floatingPanesSlice";
import { createLayoutSlice, type LayoutSlice } from "./layoutSlice";
import { createVoiceSlice, type VoiceSlice } from "./voiceSlice";
import { createNativeRendererSlice, type NativeRendererSlice } from "./nativeRendererSlice";
import { createModalCoordinationSlice, type ModalCoordinationSlice } from "./modalCoordinationSlice";
import { stripGamePanes } from "../lib/layout-utils";
import type { Tab } from "../types";

export type AppStore = TabSlice & TerminalSlice & ServerSlice & ThemeSlice & KanbanSlice & LaunchConfigSlice & SnippetSlice & HistorySlice & SidebarSlice & RecentProjectsSlice & GameSlice & SessionSlice & AiTimeSlice & FloatingPanesSlice & LayoutSlice & VoiceSlice & NativeRendererSlice & ModalCoordinationSlice;

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
      ...createFloatingPanesSlice(...a),
      ...createLayoutSlice(...a),
      ...createVoiceSlice(...a),
      ...createNativeRendererSlice(...a),
      ...createModalCoordinationSlice(...a),
    }),
    {
      name: "made-storage",
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
        watchScreenshotsFolder: state.watchScreenshotsFolder,
        screenshotsFolderOverride: state.screenshotsFolderOverride,
        rememberScreenshotWindow: state.rememberScreenshotWindow,
        screenshotWindowRect: state.screenshotWindowRect,
        showKanbanButton: state.showKanbanButton,
        panePromptHistory: state.panePromptHistory,
        globalPromptHistory: state.globalPromptHistory,
        autoStartServerCommand: state.autoStartServerCommand,
        previewInProjectTab: state.previewInProjectTab,
        devServerButtonInHeader: state.devServerButtonInHeader,
        devServerTabIcon: state.devServerTabIcon,
        customServerCommands: state.customServerCommands,
        browserFullColumn: state.browserFullColumn,
        browserSpawnLeft: state.browserSpawnLeft,
        copyOnSelect: state.copyOnSelect,
        hoverTooltips: state.hoverTooltips,
        confirmQuit: state.confirmQuit,
        confirmReloadPanes: state.confirmReloadPanes,
        claudeNotifChannel: state.claudeNotifChannel,
        jiraBaseUrl: state.jiraBaseUrl,
        jiraPromptTemplate: state.jiraPromptTemplate,
        jiraReplyInSwedish: state.jiraReplyInSwedish,
        jiraReplyInEnglish: state.jiraReplyInEnglish,
        jiraClaudeSide: state.jiraClaudeSide,
        jiraClaudeModel: state.jiraClaudeModel,
        jiraCli: state.jiraCli,
        jiraCodexModel: state.jiraCodexModel,
        jiraGeminiModel: state.jiraGeminiModel,
        jiraMode: state.jiraMode,
        jiraAcronyms: state.jiraAcronyms,
        jiraAcronymCounts: state.jiraAcronymCounts,
        jiraTicketColors: state.jiraTicketColors,
        jiraRowFullColor: state.jiraRowFullColor,
        jiraSubticketMode: state.jiraSubticketMode,
        jiraStackCollapsed: state.jiraStackCollapsed,
        jiraStackSizes: state.jiraStackSizes,
        jiraDetectPastedTickets: state.jiraDetectPastedTickets,
        jiraAutoSwitchToDetected: state.jiraAutoSwitchToDetected,
        jiraArchivedTicketAction: state.jiraArchivedTicketAction,
        codeReviewCollapseAll: state.codeReviewCollapseAll,
        perProjectEditor: state.perProjectEditor,
        editorWordWrap: state.editorWordWrap,
        showTabPath: state.showTabPath,
        autoHibernateEnabled: state.autoHibernateEnabled,
        autoHibernateMinutes: state.autoHibernateMinutes,
        notifEnabled: state.notifEnabled,
        notifAutoDismiss: state.notifAutoDismiss,
        notifAutoDismissSeconds: state.notifAutoDismissSeconds,
        notifAutoSwitchMinimized: state.notifAutoSwitchMinimized,
        notifSystemMinimized: state.notifSystemMinimized,
        notifSoundEnabled: state.notifSoundEnabled,
        notifSoundVolume: state.notifSoundVolume,
        openPanesInBackground: state.openPanesInBackground,
        wideGridLayout: state.wideGridLayout,
        redistributeOnClose: state.redistributeOnClose,
        hoverOpenAddPaneMenu: state.hoverOpenAddPaneMenu,
        autoMinimizeGameOnAiDone: state.autoMinimizeGameOnAiDone,
        terminalBackend: state.terminalBackend,
        wslDistro: state.wslDistro,
        commitMsgMode: state.commitMsgMode,
        shadowAiCli: state.shadowAiCli,
        projectColors: state.projectColors,
        projectSounds: state.projectSounds,
        statuslineToggles: state.statuslineToggles,
        vibrantColors: state.vibrantColors,
        projectPaneTint: state.projectPaneTint,
        projectPaneTintStrength: state.projectPaneTintStrength,
        activePaneLift: state.activePaneLift,
        radiusScaleOverride: state.radiusScaleOverride,
        uiFont: state.uiFont,
        uiFontSize: state.uiFontSize,
        nativeCursorStyle: state.nativeCursorStyle,
        nativeCursorBlink: state.nativeCursorBlink,
        terminalFontFamily: state.terminalFontFamily,
        perCliFontFamily: state.perCliFontFamily,
        cliFontFamilies: state.cliFontFamilies,
        terminalLineHeight: state.terminalLineHeight,
        boldUsesBright: state.boldUsesBright,
        minContrast: state.minContrast,
        dimStrength: state.dimStrength,
        cursorBlockOpacity: state.cursorBlockOpacity,
        scrollbackLines: state.scrollbackLines,
        appIconVariant: state.appIconVariant,
        colorPresets: state.colorPresets,
        activeColorPresetId: state.activeColorPresetId,
        highscores: state.highscores,
        timedHighscores: state.timedHighscores,
        gameStats: state.gameStats,
        completedCrosswordIds: state.completedCrosswordIds,
        customCrosswords: state.customCrosswords,
        // gameSidebarPaused is deliberately NOT persisted — it only arms a
        // paused restart within a session.
        gameSidebarOpen: state.gameSidebarOpen,
        gameSidebarWidth: state.gameSidebarWidth,
        gameSidebarGame: state.gameSidebarGame,
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
        defaultGeminiMdPath: state.defaultGeminiMdPath,
        defaultJiraClaudeMdPath: state.defaultJiraClaudeMdPath,
        defaultUseSingleSourcePointers: state.defaultUseSingleSourcePointers,
        customScaffolds: state.customScaffolds,
        paneModes: state.paneModes,
        floatRects: state.floatRects,
        floatOrder: state.floatOrder,
        verticalModeEnabled: state.verticalModeEnabled,
        verticalTabBarCompact: state.verticalTabBarCompact,
        voiceEnabled: state.voiceEnabled,
        whisperUrl: state.whisperUrl,
        whisperFormat: state.whisperFormat,
        llmUrl: state.llmUrl,
        llmModel: state.llmModel,
        ttsUrl: state.ttsUrl,
        ttsVoice: state.ttsVoice,
        voiceLanguage: state.voiceLanguage,
        voiceActivationMode: state.voiceActivationMode,
        pttHotkey: state.pttHotkey,
        voiceConfirmDestructive: state.voiceConfirmDestructive,
        browserIframeForLocalhost: state.browserIframeForLocalhost,
        browserAskBeforeDownload: state.browserAskBeforeDownload,
        useNativeTerminalRenderer: state.useNativeTerminalRenderer,
        nativeSharedGpu: state.nativeSharedGpu,
        newPaneNativeRenderer: state.newPaneNativeRenderer,
        scrollThumbAcceleration: state.scrollThumbAcceleration,
        wheelAcceleration: state.wheelAcceleration,
        termProgram: state.termProgram,
        termProgramVersion: state.termProgramVersion,
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

        // One-shot migration: drop ALL "windows"-stamped backends from
        // recentProjects[].preferredBackend and tabs[].backend left over
        // from v0.1.33–v0.1.38. Those versions tried to auto-stamp Windows-
        // filesystem projects to backend "windows", which routed Claude/Codex/
        // Gemini through `.cmd` shims that ConPTY/CreateProcessW can't run
        // reliably ("[Process exited]"). v0.1.39 reverts to v0.1.34 behavior:
        // every tab uses the global terminalBackend ("wsl" by default), which
        // is the path that's been working for users for months.
        if (state.recentProjects && Array.isArray(state.recentProjects)) {
          state.recentProjects = state.recentProjects.map((p) => {
            if (p.preferredBackend !== "windows") return p;
            const { preferredBackend, ...rest } = p;
            void preferredBackend;
            return rest;
          });
        }

        // Seed serverCommands from the single serverCommand a project was
        // saved with before dev servers could be plural. Idempotent — once the
        // list exists it is the truth and serverCommand is only its mirror.
        if (state.recentProjects && Array.isArray(state.recentProjects)) {
          state.recentProjects = state.recentProjects.map((p) =>
            p.serverCommand && !p.serverCommands
              ? { ...p, serverCommands: [p.serverCommand] }
              : p,
          );
        }
        filteredTabs = filteredTabs.map((t) => {
          if (t.backend !== "windows") return t;
          const { backend, ...rest } = t;
          void backend;
          return rest as typeof t;
        });

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

        // Default Claude sign-in to the preferred Keychain mode (2026-07). Any
        // stored OAuth token stays in place as the re-selectable fallback.
        if (state.servers) {
          state.servers = state.servers.map((s) =>
            s.claudeAuth ? s : { ...s, claudeAuth: "keychain" as const },
          );
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

        // One-shot migration (2026-08-01): the games panel left the layout tree
        // and became a single app-level sidebar. Strip every persisted `game`
        // node — nothing renders them now, and a stray one would fall through to
        // the split branch and read `direction` off a leaf — and carry the open
        // game across so the sidebar resumes it.
        let gameSidebarOpen = state.gameSidebarOpen ?? current.gameSidebarOpen;
        let gameSidebarGame = state.gameSidebarGame ?? current.gameSidebarGame;
        filteredTabs = filteredTabs.map((t) => {
          if (!t.layout) return t;
          const stripped = stripGamePanes(t.layout);
          if (!stripped.found) return t;
          // A game pane was open pre-upgrade, so the sidebar opens post-upgrade.
          gameSidebarOpen = true;
          gameSidebarGame = gameSidebarGame ?? stripped.game;
          return { ...t, layout: stripped.layout };
        });

        const aiTimeBursts = state.aiTimeBursts ?? current.aiTimeBursts;

        // A dangling active color-preset id (hand-edited or partially wiped
        // blob) must not survive hydration — panes would silently render as
        // "no preset" while the dropdown showed a phantom selection.
        const activeColorPresetId =
          state.activeColorPresetId != null &&
          (state.colorPresets ?? []).some((p) => p.id === state.activeColorPresetId)
            ? state.activeColorPresetId
            : null;

        // Auto-complete onboarding for existing users who already have persisted state
        const onboardingCompleted = state.onboardingCompleted ?? true;

        return {
          ...current,
          ...state,
          tabs: filteredTabs,
          activeTabId,
          activeColorPresetId,
          cliYolo,
          gameStats,
          highscores,
          timedHighscores,
          projectSessions,
          aiTimeBursts,
          onboardingCompleted,
          gameSidebarOpen,
          gameSidebarGame,
          // When session restore is off, reset all panel/sidebar state to defaults
          ...(!state.restoreLastSession && {
            devServerPanelOpen: false,
            sidebarOpen: false,
            gameSidebarOpen: false,
          }),
        };
      },
    }
  )
);
