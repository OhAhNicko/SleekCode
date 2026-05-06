import { useEffect, useState, useMemo, useCallback } from "react";
import { useAppStore } from "./store";
import { getTheme } from "./lib/themes";
import TabBar from "./components/TabBar";
import VerticalTabBar from "./components/VerticalTabBar";
import TemplatePicker, { type ExtraPaneType } from "./components/TemplatePicker";
import { useOrientation } from "./lib/use-orientation";
import { spawnDevServer } from "./lib/spawn-dev-server";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { buildLayoutFromTemplate, stampTerminalTypes, addPaneAsGrid, generatePaneId, addKanbanPane } from "./lib/layout-utils";
import type { WorkspaceTemplate } from "./lib/workspace-templates";
import type { TerminalType } from "./types";
import Workspace from "./components/Workspace";
import DevServerTab from "./components/DevServerTab";
import ServersPanel from "./components/ServersPanel";
import KanbanBoard from "./components/KanbanBoard";
import CommandPalette, { type PaletteAction } from "./components/CommandPalette";
import SnippetPanel from "./components/SnippetPanel";
import CommandHistory from "./components/CommandHistory";
import Sidebar from "./components/Sidebar";
import WindowResizeHandles from "./components/WindowResizeHandles";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { resolveWslCliPaths } from "./lib/wsl-cache";
import { resolveWindowsCliPaths } from "./lib/windows-cli-cache";
import { resolveNativeCliPaths } from "./lib/macos-cli-cache";
import { installStatuslineWrapper } from "./lib/statusline-setup";
import { useClipboardWatcher } from "./hooks/useClipboardWatcher";
import { useFileDrop } from "./hooks/useFileDrop";
import { useAiTimeTracker } from "./hooks/useAiTimeTracker";
import ImageInsertUndoToast from "./components/ImageInsertUndoToast";
import UploadErrorToast from "./components/UploadErrorToast";
import UndoCloseToast from "./components/UndoCloseToast";
import UndoClearToast from "./components/UndoClearToast";
import KeyboardShortcutsModal from "./components/KeyboardShortcutsModal";
import PromptHistorySearch from "./components/PromptHistorySearch";
import DevServerTerminalHost from "./components/DevServerTerminalHost";
import SettingsPane from "./components/SettingsPane";
import WelcomeModal from "./components/WelcomeModal";
import GlobalContextMenu from "./components/GlobalContextMenu";
import UpdateBanner from "./components/UpdateBanner";
import ChangelogModal from "./components/ChangelogModal";
import VoiceHud from "./components/VoiceHud";
import VoiceController from "./components/VoiceController";
import { matchesHotkey, matchesHotkeyRelease } from "./lib/voice/hotkey";
import { VOICE_ENABLED } from "./lib/voice/feature-flag";
import { useUpdateChecker } from "./hooks/useUpdateChecker";
import { getVersion } from "@tauri-apps/api/app";
import { getActivePaneSearchOpener } from "./lib/pane-search-registry";

export default function App() {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const themeId = useAppStore((s) => s.themeId);
  const [showPalette, setShowPalette] = useState(false);
  const settingsOpen = useAppStore((s) => s.settingsPanelOpen);
  const launchConfigs = useAppStore((s) => s.launchConfigs);
  const loadLaunchConfig = useAppStore((s) => s.loadLaunchConfig);
  const snippets = useAppStore((s) => s.snippets);
  const [showHistory, setShowHistory] = useState(false);
  const [showSnippets, setShowSnippets] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showPromptSearch, setShowPromptSearch] = useState(false);
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const devServerPanelOpen = useAppStore((s) => s.devServerPanelOpen);
  const verticalModeEnabled = useAppStore((s) => s.verticalModeEnabled);
  const orientation = useOrientation();
  const isVertical = orientation === "portrait" && verticalModeEnabled;
  const pendingDir = useAppStore((s) => s.pendingDir);
  const setPendingDir = useAppStore((s) => s.setPendingDir);
  const addTerminals = useAppStore((s) => s.addTerminals);
  const addTabWithLayout = useAppStore((s) => s.addTabWithLayout);
  const addRecentProject = useAppStore((s) => s.addRecentProject);
  const autoStartServerCommand = useAppStore((s) => s.autoStartServerCommand);
  const recentProjects = useAppStore((s) => s.recentProjects);
  const onboardingCompleted = useAppStore((s) => s.onboardingCompleted);
  const setOnboardingCompleted = useAppStore((s) => s.setOnboardingCompleted);
  const [changelogToShow, setChangelogToShow] = useState<{ version: string; notes: string } | null>(null);

  const projectTabs = useMemo(() => tabs.filter((t) => !t.isDevServerTab && !t.isServersTab && !t.isKanbanTab && !t.isSettingsTab), [tabs]);
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? projectTabs[0] ?? tabs[0];
  const theme = getTheme(themeId);

  // Determine if a real project tab is active (not a system tab, not empty)
  const isSystemTab = activeTabId === "dev-server-tab" || activeTabId === "kanban-tab" || activeTabId === "servers-tab";
  const hasActiveProjectTab = !isSystemTab && !!activeTabId && projectTabs.some((t) => t.id === activeTabId);

  // On startup: if activeTabId is a system tab (except settings), redirect to last-active project tab.
  // If no project tabs exist, force activeTabId to "" so the startup screen shows.
  const isRedirectableSystemTab = activeTabId === "dev-server-tab" || activeTabId === "kanban-tab" || activeTabId === "servers-tab";
  useEffect(() => {
    if (isRedirectableSystemTab || !activeTabId) {
      const lastPath = (useAppStore.getState().lastActiveProjectPath ?? "").replace(/\\/g, "/");
      const fallback =
        (lastPath && projectTabs.find((t) => (t.workingDir ?? "").replace(/\\/g, "/") === lastPath)) ||
        projectTabs[0];
      if (fallback) {
        useAppStore.getState().setActiveTab(fallback.id);
      } else if (activeTabId) {
        // Force empty so system tab doesn't render
        useAppStore.getState().setActiveTab("");
      }
      if (activeTabId === "dev-server-tab" && !devServerPanelOpen) useAppStore.getState().toggleDevServerPanel();
    }
  }, [activeTabId, projectTabs, isRedirectableSystemTab, devServerPanelOpen]);

  // Settings panel and sidebars are mutually exclusive
  useEffect(() => {
    if (settingsOpen && (sidebarOpen || devServerPanelOpen)) {
      if (sidebarOpen) useAppStore.getState().toggleSidebar();
      if (devServerPanelOpen) useAppStore.getState().toggleDevServerPanel();
    }
  }, [settingsOpen]);
  useEffect(() => {
    if ((sidebarOpen || devServerPanelOpen) && settingsOpen) {
      useAppStore.getState().setSettingsPanelOpen(false);
    }
  }, [sidebarOpen, devServerPanelOpen]);

  // ─── New-tab pipeline (lifted from TabBar so VerticalTabBar can use it) ───
  const handleNewLocalTab = useCallback(async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "Select Project Directory",
      });
      if (selected && typeof selected === "string") {
        const name = selected.split(/[\\/]/).pop() || "Project";
        setPendingDir({ name, dir: selected });
      }
    } catch {
      // User cancelled or dialog error
    }
  }, [setPendingDir]);

  useEffect(() => {
    const handler = () => handleNewLocalTab();
    window.addEventListener("ezydev:new-tab", handler);
    return () => window.removeEventListener("ezydev:new-tab", handler);
  }, [handleNewLocalTab]);

  const handleTemplateSelected = useCallback(
    (
      template: WorkspaceTemplate,
      slotTypes: TerminalType[],
      serverCommand?: string,
      extraPanes?: ExtraPaneType[],
      noDevServer?: boolean,
    ) => {
      if (!pendingDir) return;
      const { layout, terminalIds } = buildLayoutFromTemplate(
        template.id,
        template.cols,
        template.rows,
        template.paneCount,
      );
      const typedLayout = stampTerminalTypes(layout, terminalIds, slotTypes);
      let finalLayout: import("./types").PaneLayout = typedLayout;
      if (extraPanes && extraPanes.length > 0) {
        for (const extra of extraPanes) {
          if (extra === "kanban") {
            const kanbanLayout = addKanbanPane(finalLayout);
            if (kanbanLayout) finalLayout = kanbanLayout;
            continue;
          }
          let extraNode: import("./types").PaneLayout;
          switch (extra) {
            case "codereview":
              extraNode = { type: "codereview" as const, id: generatePaneId() };
              break;
            case "fileviewer":
              extraNode = { type: "fileviewer" as const, id: generatePaneId(), files: [], activeFile: "" };
              break;
            case "browser":
              extraNode = { type: "browser" as const, id: generatePaneId(), url: "about:blank" };
              break;
            default:
              continue;
          }
          const { browserFullColumn: fullCol, browserSpawnLeft: spawnLeft, wideGridLayout } = useAppStore.getState();
          if (fullCol) {
            finalLayout = {
              type: "split" as const,
              id: generatePaneId(),
              direction: "horizontal" as const,
              children: (spawnLeft
                ? [extraNode, finalLayout]
                : [finalLayout, extraNode]) as [import("./types").PaneLayout, import("./types").PaneLayout],
              sizes: (spawnLeft ? [30, 70] : [70, 30]) as [number, number],
            };
          } else {
            finalLayout = addPaneAsGrid(finalLayout, extraNode, wideGridLayout);
          }
        }
      }
      const batch = terminalIds.map((id, i) => ({
        id,
        type: slotTypes[i] ?? ("shell" as TerminalType),
        workingDir: pendingDir.dir,
        serverId: pendingDir.serverId,
      }));
      addTerminals(batch);
      const tabId = addTabWithLayout(pendingDir.name, pendingDir.dir, finalLayout, pendingDir.serverId);
      addRecentProject({
        path: pendingDir.dir,
        name: pendingDir.name,
        template: { templateId: template.id, cols: template.cols, rows: template.rows, paneCount: template.paneCount, slotTypes },
        serverCommand,
        noDevServer,
        serverId: pendingDir.serverId,
      });
      if (serverCommand && autoStartServerCommand) {
        spawnDevServer(tabId, pendingDir.name, pendingDir.dir, serverCommand, pendingDir.serverId);
      }
      setPendingDir(null);
    },
    [pendingDir, addTerminals, addTabWithLayout, addRecentProject, autoStartServerCommand, setPendingDir],
  );

  const matchingRecentForPending = pendingDir
    ? recentProjects.find(
        (p) =>
          p.path.replace(/\\/g, "/") === pendingDir.dir.replace(/\\/g, "/") &&
          p.serverId === pendingDir.serverId,
      )
    : null;

  // On mount, detect a version bump and surface the cached changelog if the
  // auto-updater installed a new build. First-ever launches (null lastSeenVersion
  // with no pending cache) silently initialise without showing the modal.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let current: string;
      try {
        current = await getVersion();
      } catch {
        return;
      }
      if (cancelled) return;
      const store = useAppStore.getState();
      if (current === store.lastSeenVersion) return;
      const pending = store.pendingChangelog;
      const shouldShow =
        store.showChangelogOnUpdate &&
        !!pending &&
        pending.version === current &&
        !!pending.notes &&
        pending.notes.trim().length > 0;
      if (shouldShow) {
        setChangelogToShow({ version: pending!.version, notes: pending!.notes });
      } else {
        store.setLastSeenVersion(current);
        store.setPendingChangelog(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCloseChangelog = useCallback(() => {
    if (changelogToShow) {
      const store = useAppStore.getState();
      store.setLastSeenVersion(changelogToShow.version);
      store.setPendingChangelog(null);
    }
    setChangelogToShow(null);
  }, [changelogToShow]);

  // Build extra palette actions from launch configs, snippets, and history
  const paletteExtraActions = useMemo<PaletteAction[]>(() => {
    const actions: PaletteAction[] = [];

    // Launch configs
    for (const config of launchConfigs) {
      actions.push({
        id: `launch-${config.id}`,
        label: `Launch: ${config.name}`,
        category: "launch",
        keywords: `launch workspace config ${config.name}`,
        execute: () => loadLaunchConfig(config.id),
      });
    }

    // Snippets (added in Phase 5)
    if (snippets) {
      for (const snippet of snippets) {
        actions.push({
          id: `snippet-${snippet.id}`,
          label: `Run: ${snippet.name}`,
          category: "snippet",
          keywords: `snippet workflow run ${snippet.name} ${snippet.description ?? ""}`,
          execute: () => {
            setShowSnippets(true);
          },
        });
      }
    }

    // History action
    actions.push({
      id: "action-history",
      label: "Open Command History",
      category: "history",
      keywords: "history commands search recent",
      execute: () => setShowHistory(true),
    });

    // Code Review action
    actions.push({
      id: "action-code-review",
      label: "Open Code Review",
      category: "action",
      keywords: "git diff code review changes uncommitted",
      execute: () => window.dispatchEvent(new Event("ezydev:open-codereview")),
    });

    // Voice agent: speak a command (only when enabled)
    if (VOICE_ENABLED && useAppStore.getState().voiceEnabled) {
      actions.push({
        id: "action-voice-speak",
        label: "Voice: speak a command…",
        category: "action",
        keywords: "voice agent speak microphone whisper say",
        execute: () => window.dispatchEvent(new Event("ezydev:voice-toggle")),
      });
    }

    // File Viewer action (placeholder — files opened from sidebar go to viewer automatically)
    actions.push({
      id: "action-file-viewer",
      label: "Open File Viewer",
      category: "action",
      keywords: "file viewer tabbed browse code",
      execute: () => {
        // Open a file dialog to pick a file, then open in viewer
        // For now, just a no-op — files are opened via sidebar
      },
    });

    return actions;
  }, [launchConfigs, loadLaunchConfig, snippets]);

  // Pre-warm CLI paths at startup (background). On Windows we MUST resolve both
  // WSL and Windows CLI paths because per-project auto-detect (detectBackendForPath)
  // can stamp individual tabs as "windows" even when the global backend is "wsl".
  // If either cache is missing when a tab tries to spawn, getCachedXxxCliPath
  // returns null, command falls back to a bare name, the PTY can't resolve it,
  // and the pane spawns blank with no output.
  useEffect(() => {
    const backend = useAppStore.getState().terminalBackend ?? "wsl";
    if (backend === "native") {
      resolveNativeCliPaths();
      installStatuslineWrapper();
    } else {
      // On Windows OS — resolve both caches regardless of global default,
      // since any tab can be either wsl- or windows-backed via auto-detect.
      resolveWindowsCliPaths();
      resolveWslCliPaths();
      installStatuslineWrapper();
    }
    // Clean up clipboard images older than 24h
    invoke("cleanup_clipboard_images", { maxAgeSecs: 86400 }).catch(() => {});
  }, []);

  // Restore dev servers from persisted tabs on app startup. Delegates to
  // spawnDevServer (the same helper used by quick-open) so the SSH path is
  // identical between "open project from recent" and "app restart with
  // restoreLastSession". Loud console.warn logs are intentional — set
  // `localStorage.setItem("ezydev.silenceDevServerRestore","1")` to mute.
  useEffect(() => {
    const state = useAppStore.getState();
    const verbose = localStorage.getItem("ezydev.silenceDevServerRestore") !== "1";
    const log = (msg: string, data?: unknown) =>
      verbose && (data === undefined ? console.warn(`[DEV-SERVER-RESTORE] ${msg}`) : console.warn(`[DEV-SERVER-RESTORE] ${msg}`, data));

    log("effect fired", {
      autoStartServerCommand: state.autoStartServerCommand,
      tabsCount: state.tabs.length,
      devServersCount: state.devServers.length,
      recentProjectsCount: state.recentProjects.length,
    });

    if (!state.autoStartServerCommand) {
      log("aborting — autoStartServerCommand is OFF (toggle it in Settings)");
      return;
    }
    if (state.devServers.length > 0) {
      log("aborting — devServers already populated", state.devServers.map((d) => ({ id: d.id, tabId: d.tabId, serverId: d.serverId })));
      return;
    }

    // Key by (path + serverId) so a project at the same path on local vs SSH
    // host doesn't collide (mirrors flushTabLayoutsToRecent's key shape).
    const projectKey = (path: string, serverId?: string) =>
      `${path.replace(/\\/g, "/")}|${serverId ?? ""}`;

    // Build a lookup from (workingDir+serverId) → serverCommand using recentProjects as fallback
    const recentByKey = new Map<string, string>();
    for (const rp of state.recentProjects) {
      if (rp.serverCommand) {
        recentByKey.set(projectKey(rp.path, rp.serverId), rp.serverCommand);
      }
    }

    const projectTabs = state.tabs.filter(
      (t) => !t.isDevServerTab && !t.isServersTab && !t.isKanbanTab && !t.isSettingsTab && t.workingDir
    );

    log("project tabs eligible:", projectTabs.map((t) => ({
      id: t.id,
      name: t.name,
      workingDir: t.workingDir,
      serverId: t.serverId ?? "(local)",
      serverCommand: t.serverCommand ?? "(none — will check recentProjects)",
    })));

    const seenKeys = new Set<string>();
    let spawned = 0;
    for (const tab of projectTabs) {
      const command =
        tab.serverCommand ||
        recentByKey.get(projectKey(tab.workingDir, tab.serverId));
      if (!command) {
        log(`SKIP ${tab.name} — no serverCommand on tab and no match in recentProjects (key=${projectKey(tab.workingDir, tab.serverId)})`);
        continue;
      }

      const tabKey = projectKey(tab.workingDir, tab.serverId);
      if (seenKeys.has(tabKey)) {
        log(`SKIP ${tab.name} — duplicate of an already-spawned tab (key=${tabKey})`);
        continue;
      }
      seenKeys.add(tabKey);

      // Backfill serverCommand on the tab if it was only in recentProjects
      if (!tab.serverCommand) {
        useAppStore.setState((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === tab.id ? { ...t, serverCommand: command } : t
          ),
        }));
      }

      log(`SPAWN ${tab.name} → command="${command}" serverId=${tab.serverId ?? "(local)"} cwd=${tab.workingDir}`);
      try {
        // Delegate to the proven helper used by TabBar's quick-open path.
        // It handles addTerminal+addDevServer with serverId correctly and
        // dedupes via (workingDir + serverId).
        spawnDevServer(tab.id, tab.name, tab.workingDir, command, tab.serverId);
        spawned++;
      } catch (err) {
        log(`FAILED to spawn for ${tab.name}`, err);
      }
    }

    log(`done — spawned ${spawned} of ${projectTabs.length} project tabs`);
  }, []);

  // Intercept OS-level window close (Alt+F4, taskbar X). Always flush session state
  // synchronously so Zustand's persist middleware writes the final snapshot to
  // localStorage before the webview is torn down. Then show confirm dialog if enabled.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    getCurrentWindow().onCloseRequested((event) => {
      const s = useAppStore.getState();
      // Sync each open project tab's layout into recentProjects.lastLayout so
      // quick-open restores the exact layout the user last had — even when
      // restoreLastSession is off.
      s.flushTabLayoutsToRecent(s.tabs);

      if (s.confirmQuit) {
        event.preventDefault();
        window.dispatchEvent(new Event("ezydev:quit-requested"));
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  // Belt-and-braces flush in case the webview unloads without onCloseRequested
  // firing (browser preview, unusual Tauri paths). localStorage writes inside
  // beforeunload are synchronous via Zustand's persist middleware.
  useEffect(() => {
    const handler = () => {
      const s = useAppStore.getState();
      s.flushTabLayoutsToRecent(s.tabs);
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  // Watch Windows clipboard for new images (adds to TabBar strip automatically)
  useClipboardWatcher();

  // Handle file drops from OS onto terminal panes / EzyComposer
  useFileDrop();

  // Track AI working time from burst events
  useAiTimeTracker();

  // Auto-update checker
  const updateState = useUpdateChecker();

  // Inject theme CSS variables into :root
  useEffect(() => {
    const root = document.documentElement;
    const s = theme.surface;
    root.style.setProperty("--ezy-bg", s.bg);
    root.style.setProperty("--ezy-surface", s.surface);
    root.style.setProperty("--ezy-surface-raised", s.surfaceRaised);
    root.style.setProperty("--ezy-border", s.border);
    root.style.setProperty("--ezy-border-subtle", s.borderSubtle);
    root.style.setProperty("--ezy-border-light", s.borderLight);
    root.style.setProperty("--ezy-text", s.text);
    root.style.setProperty("--ezy-text-secondary", s.textSecondary);
    root.style.setProperty("--ezy-text-muted", s.textMuted);
    root.style.setProperty("--ezy-accent", s.accent);
    root.style.setProperty("--ezy-accent-hover", s.accentHover);
    root.style.setProperty("--ezy-accent-dim", s.accentDim);
    root.style.setProperty("--ezy-accent-glow", s.accentGlow);
    root.style.setProperty("--ezy-red", s.red);
    root.style.setProperty("--ezy-cyan", s.cyan);
  }, [theme]);

  // Listen for snippet panel open events from TerminalHeader
  useEffect(() => {
    const handler = () => setShowSnippets(true);
    window.addEventListener("ezydev:open-snippets", handler);
    return () => window.removeEventListener("ezydev:open-snippets", handler);
  }, []);

  // Listen for keyboard shortcuts modal open events from TabBar settings menu
  useEffect(() => {
    const handler = () => setShowShortcuts(true);
    window.addEventListener("ezydev:open-shortcuts", handler);
    return () => window.removeEventListener("ezydev:open-shortcuts", handler);
  }, []);

  // Listen for command palette open events from GlobalContextMenu
  useEffect(() => {
    const handler = () => setShowPalette(true);
    window.addEventListener("ezydev:open-palette", handler);
    return () => window.removeEventListener("ezydev:open-palette", handler);
  }, []);

  // Listen for prompt search open events from GlobalContextMenu
  useEffect(() => {
    const handler = () => setShowPromptSearch(true);
    window.addEventListener("ezydev:open-prompt-search", handler);
    return () => window.removeEventListener("ezydev:open-prompt-search", handler);
  }, []);


  // Global keyboard shortcuts (capture phase — fires before xterm/composer handlers)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Block all shortcuts while WelcomeModal is showing
      if (!useAppStore.getState().onboardingCompleted) return;

      const { ctrlKey, shiftKey, altKey, key } = e;
      // Helper: prevent default AND stop propagation (capture phase blocks xterm)
      const consume = () => { e.preventDefault(); e.stopPropagation(); };

      // Voice activation: hotkey behaviour depends on voiceActivationMode.
      //   "toggle" — pressing the hotkey starts; pressing again stops.
      //   "hold"   — keydown starts, keyup stops (push-to-talk).
      const voiceState = useAppStore.getState();
      if (VOICE_ENABLED && voiceState.voiceEnabled && matchesHotkey(e, voiceState.pttHotkey)) {
        if (e.repeat) {
          consume();
          return;
        }
        consume();
        if (voiceState.voiceActivationMode === "hold") {
          window.dispatchEvent(new Event("ezydev:voice-start"));
        } else {
          window.dispatchEvent(new Event("ezydev:voice-toggle"));
        }
        return;
      }

      // Esc → minimize topmost expanded/floating pane back into the grid.
      // Skip when no expanded/floating pane exists, or when a non-textarea/input
      // dialog is open (palette, modals) — those have their own Esc handlers.
      if (key === "Escape" && !ctrlKey && !shiftKey && !altKey) {
        const store = useAppStore.getState();
        const ids = Object.keys(store.paneModes);
        if (ids.length > 0) {
          // Prefer the topmost one in floatOrder (last entry).
          const topmost = [...store.floatOrder].reverse().find((id) => store.paneModes[id]) ?? ids[ids.length - 1];
          // Don't shadow Esc inside text inputs (autocomplete dropdowns etc.).
          const target = e.target as HTMLElement | null;
          const isEditable = !!target && (
            target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable
          );
          if (!isEditable) {
            consume();
            store.minimizePane(topmost);
            return;
          }
        }
      }

      // Alt+1..9 → Switch to tab by number
      // Use e.code (physical key) because Alt+digit on Windows can produce
      // special characters in e.key depending on keyboard layout / alt-codes.
      if (altKey && !ctrlKey && !shiftKey) {
        const code = e.code; // "Digit1".."Digit9"
        if (code >= "Digit1" && code <= "Digit9") {
          consume();
          const store = useAppStore.getState();
          const cycleable = store.tabs.filter((t) => !t.isDevServerTab && !t.isServersTab && !t.isKanbanTab && !t.isSettingsTab);
          const idx = parseInt(code.slice(5)) - 1; // "Digit1" → 0
          if (idx < cycleable.length) {
            store.setActiveTab(cycleable[idx].id);
          }
          return;
        }
      }

      if (!ctrlKey) return;

      // Ctrl (no Shift) shortcuts
      if (!shiftKey) {
        // Ctrl+F — open search in the active pane (terminal, editor, file viewer, code review, kanban).
        // Always consume so the WebView's native Find never shows — even when
        // no pane claims the shortcut.
        if (key === "f" || key === "F") {
          consume();
          getActivePaneSearchOpener()?.();
          return;
        }
        switch (key) {
          case "k":
            // Ctrl+K → Command Palette
            consume();
            setShowPalette((v) => !v);
            return;
          case "b":
            // Ctrl+B → Toggle Sidebar
            consume();
            toggleSidebar();
            return;
          case "/":
            // Ctrl+/ → Keyboard Shortcuts
            consume();
            setShowShortcuts((v) => !v);
            return;
          case ",":
            // Ctrl+, → Toggle Settings panel
            consume();
            if (!useAppStore.getState().settingsPanelOpen) {
              useAppStore.setState({ sidebarOpen: false, devServerPanelOpen: false });
            }
            useAppStore.getState().toggleSettingsPanel();
            return;
          case "r":
            // Ctrl+R → Search prompt history
            consume();
            setShowPromptSearch((v) => !v);
            return;
          case "1":
            // Ctrl+1 → new Claude pane (vertical / grid)
            consume();
            window.dispatchEvent(new CustomEvent("ezydev:split-terminal", { detail: { type: "claude" } }));
            return;
          case "2":
            // Ctrl+2 → new Codex pane
            consume();
            window.dispatchEvent(new CustomEvent("ezydev:split-terminal", { detail: { type: "codex" } }));
            return;
          case "3":
            // Ctrl+3 → new Gemini pane
            consume();
            window.dispatchEvent(new CustomEvent("ezydev:split-terminal", { detail: { type: "gemini" } }));
            return;
          case "d":
            // Ctrl+D → Split pane vertically (new pane right)
            consume();
            window.dispatchEvent(new CustomEvent("ezydev:split-terminal", { detail: { type: "shell" } }));
            return;
          case "w":
            // Ctrl+W → Close current pane
            consume();
            window.dispatchEvent(new Event("ezydev:close-pane"));
            return;
          case "l":
            // Ctrl+L → Clear terminal
            consume();
            window.dispatchEvent(new Event("ezydev:clear-terminal"));
            return;
          case "=":
          case "+":
            // Ctrl+= / Ctrl++ → Zoom in (increase font size)
            consume();
            window.dispatchEvent(new CustomEvent("ezydev:font-zoom", { detail: { delta: 1 } }));
            return;
          case "-":
            // Ctrl+- → Zoom out (decrease font size)
            consume();
            window.dispatchEvent(new CustomEvent("ezydev:font-zoom", { detail: { delta: -1 } }));
            return;
          case "Tab":
            // Ctrl+Tab → next project tab, wrapping at the end. Excludes ALL
            // system tabs (dev-server, servers, kanban, settings) so cycling
            // stays within real project tabs and always wraps back to the
            // first project after the last one.
            consume();
            {
              const store = useAppStore.getState();
              const cycleable = store.tabs.filter((t) => !t.isDevServerTab && !t.isServersTab && !t.isKanbanTab && !t.isSettingsTab);
              if (cycleable.length > 0) {
                const currentIndex = cycleable.findIndex((t) => t.id === store.activeTabId);
                const nextIndex = (currentIndex + 1) % cycleable.length;
                store.setActiveTab(cycleable[nextIndex].id);
              }
            }
            return;
        }
      }

      // Ctrl+Shift shortcuts
      if (shiftKey) {
        const store = useAppStore.getState();

        switch (key) {
          case "T":
            // Ctrl+Shift+T → New tab
            consume();
            window.dispatchEvent(new Event("ezydev:new-tab"));
            return;
          case "N":
            // Ctrl+Shift+N → New project/tab
            consume();
            window.dispatchEvent(new Event("ezydev:new-tab"));
            return;
          case "F":
            // Ctrl+Shift+F → Open Code Review
            consume();
            window.dispatchEvent(new Event("ezydev:open-codereview"));
            return;
          case "W":
            // Ctrl+Shift+W → Close current tab
            consume();
            {
              const activeId = store.activeTabId;
              if (activeId) store.removeTab(activeId);
            }
            return;
          case "D":
            // Ctrl+Shift+D → Split pane horizontally (new pane below)
            consume();
            window.dispatchEvent(new CustomEvent("ezydev:split-terminal", { detail: { type: "shell", direction: "vertical" } }));
            return;
          case "P":
            // Ctrl+Shift+P → Command palette (alias)
            consume();
            setShowPalette((v) => !v);
            return;
          case "E":
            // Ctrl+Shift+E → Toggle file explorer sidebar
            consume();
            {
              const s = useAppStore.getState();
              if (s.sidebarOpen && s.sidebarTab === "files") {
                s.toggleSidebar();
              } else {
                s.setSidebarTab("files");
                if (!s.sidebarOpen) s.toggleSidebar();
              }
            }
            return;
          case "C":
            // Ctrl+Shift+C → Copy (explicit)
            consume();
            document.execCommand("copy");
            return;
          case "V":
            // Ctrl+Shift+V → Paste (explicit)
            consume();
            navigator.clipboard.readText().then((text) => {
              window.dispatchEvent(new CustomEvent("ezydev:paste-text", { detail: { text } }));
            }).catch(() => {});
            return;
          case "]":
            // Ctrl+Shift+] → Focus next pane
            consume();
            window.dispatchEvent(new Event("ezydev:focus-next-pane"));
            return;
          case "[":
            // Ctrl+Shift+[ → Focus previous pane
            consume();
            window.dispatchEvent(new Event("ezydev:focus-prev-pane"));
            return;
          case "!":
            // Ctrl+Shift+1 → New Claude pane (horizontal split)
            consume();
            window.dispatchEvent(new CustomEvent("ezydev:split-terminal", { detail: { type: "claude", direction: "vertical" } }));
            return;
          case "@":
            // Ctrl+Shift+2 → New Codex pane (horizontal split)
            consume();
            window.dispatchEvent(new CustomEvent("ezydev:split-terminal", { detail: { type: "codex", direction: "vertical" } }));
            return;
          case "#":
            // Ctrl+Shift+3 → New Gemini pane (horizontal split)
            consume();
            window.dispatchEvent(new CustomEvent("ezydev:split-terminal", { detail: { type: "gemini", direction: "vertical" } }));
            return;
          case "G":
            // Ctrl+Shift+G → Toggle Mini Games button visibility
            consume();
            store.toggleMiniGamesButton();
            return;
          case "Tab":
            // Ctrl+Shift+Tab → previous project tab, wrapping at the start.
            // Mirrors the Ctrl+Tab filter so forward/back are symmetric.
            consume();
            {
              const cycleable = store.tabs.filter((t) => !t.isDevServerTab && !t.isServersTab && !t.isKanbanTab && !t.isSettingsTab);
              if (cycleable.length > 0) {
                const currentIndex = cycleable.findIndex((t) => t.id === store.activeTabId);
                const prevIndex = (currentIndex - 1 + cycleable.length) % cycleable.length;
                store.setActiveTab(cycleable[prevIndex].id);
              }
            }
            return;
        }
      }
    };

    // Push-to-talk release: stop recording when ANY part of the hotkey is
    // released, but only while we're actually listening. Using the permissive
    // matchesHotkeyRelease handles the user lifting keys one at a time.
    // Only fires in "hold" mode; toggle mode handles start/stop on keydown.
    const upHandler = (e: KeyboardEvent) => {
      if (!VOICE_ENABLED) return;
      const v = useAppStore.getState();
      if (!v.voiceEnabled || v.voiceActivationMode !== "hold") return;
      if (v.voiceHudState !== "listening") return;
      if (matchesHotkeyRelease(e, v.pttHotkey)) {
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(new Event("ezydev:voice-stop"));
      }
    };

    // Use capture phase so global shortcuts fire BEFORE xterm's key handler
    // (xterm textarea intercepts keys in bubble phase and sends them to PTY)
    window.addEventListener("keydown", handler, true);
    window.addEventListener("keyup", upHandler, true);
    return () => {
      window.removeEventListener("keydown", handler, true);
      window.removeEventListener("keyup", upHandler, true);
    };
  }, []);

  const handleOpenFile = useCallback((filePath: string, lineNumber?: number) => {
    window.dispatchEvent(
      new CustomEvent("ezydev:open-file", { detail: { filePath, lineNumber } })
    );
  }, []);

  return (
    <div className="flex flex-col h-full w-full" style={{ backgroundColor: "var(--ezy-bg)" }}>
      <WindowResizeHandles />
      {!isVertical && <TabBar />}
      <UpdateBanner {...updateState} />
      <div className="flex-1 min-h-0 flex">
        {isVertical && <VerticalTabBar />}
        {sidebarOpen && (
          <Sidebar
            rootDir={activeTab?.workingDir || ""}
            onOpenFile={handleOpenFile}
          />
        )}
        {devServerPanelOpen && <DevServerTab />}
        {settingsOpen && <SettingsPane />}
        <div className="flex-1 min-w-0 relative">
          {/* System tabs: rendered standalone, only when explicitly active */}
          {activeTabId === "kanban-tab" && (
            <div className="h-full w-full" style={{ position: "relative" }}>
              <KanbanBoard />
            </div>
          )}
          {activeTabId === "servers-tab" && (
            <div className="h-full w-full" style={{ position: "relative" }}>
              <ServersPanel />
            </div>
          )}
          {/* Startup screen: no project tab active */}
          {!hasActiveProjectTab && activeTabId !== "kanban-tab" && activeTabId !== "servers-tab" && (
            <div className="h-full w-full" style={{
              display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
              backgroundColor: "var(--ezy-bg)", gap: 32, padding: "0 40px",
            }}>
              <div style={{ textAlign: "center" }}>
                <h1 style={{
                  fontSize: 28, fontWeight: 700, color: "var(--ezy-text)",
                  letterSpacing: "-0.02em", margin: 0,
                }}>EzyDev</h1>
                <p style={{ fontSize: 13, color: "var(--ezy-text-muted)", margin: "6px 0 0" }}>
                  Open a project to get started
                </p>
              </div>
              {recentProjects.length > 0 && (
                <div style={{ width: "100%", maxWidth: 480 }}>
                  <div style={{
                    fontSize: 11, fontWeight: 600, color: "var(--ezy-text-muted)",
                    textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8,
                  }}>Recent Projects</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    {recentProjects.slice(0, 8).map((project) => (
                      <button
                        key={project.id}
                        onClick={() => window.dispatchEvent(new CustomEvent("ezydev:open-recent", { detail: { path: project.path, name: project.name } }))}
                        style={{
                          display: "flex", alignItems: "center", gap: 10,
                          padding: "8px 12px", borderRadius: 6, border: "none",
                          background: "transparent", cursor: "pointer", textAlign: "left", width: "100%",
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-surface-raised)"}
                        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                      >
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="var(--ezy-text-muted)">
                          <path d="M1.75 1A1.75 1.75 0 000 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0016 13.25v-8.5A1.75 1.75 0 0014.25 3H7.5a.25.25 0 01-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z"/>
                        </svg>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 500, color: "var(--ezy-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {project.name}
                          </div>
                          <div style={{ fontSize: 11, color: "var(--ezy-text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {project.path}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <button
                onClick={() => window.dispatchEvent(new Event("ezydev:new-tab"))}
                style={{
                  padding: "8px 20px", borderRadius: 6,
                  border: "1px solid var(--ezy-border)",
                  background: "var(--ezy-surface-raised)", color: "var(--ezy-text)",
                  fontSize: 13, fontWeight: 500, cursor: "pointer",
                }}
                onMouseEnter={(e) => e.currentTarget.style.borderColor = "var(--ezy-accent)"}
                onMouseLeave={(e) => e.currentTarget.style.borderColor = "var(--ezy-border)"}
              >
                Open Project
              </button>
            </div>
          )}
          {/* Project tabs */}
          {tabs.map((tab) => {
            if (tab.isDevServerTab || tab.isKanbanTab || tab.isServersTab || tab.isSettingsTab) return null;
            const isActive = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                className="h-full w-full"
                style={{
                  display: isActive ? "block" : "none",
                  position: isActive ? "relative" : "absolute",
                }}
              >
                <Workspace tab={tab} />
              </div>
            );
          })}
        </div>
      </div>
      <CommandPalette
        open={showPalette}
        onClose={() => setShowPalette(false)}
        extraActions={paletteExtraActions}
      />
      {showSnippets && <SnippetPanel onClose={() => setShowSnippets(false)} />}
      {showHistory && <CommandHistory onClose={() => setShowHistory(false)} />}
      {showShortcuts && <KeyboardShortcutsModal onClose={() => setShowShortcuts(false)} />}
      {showPromptSearch && (
        <PromptHistorySearch
          onClose={() => setShowPromptSearch(false)}
          onSelect={(text) => {
            window.dispatchEvent(new CustomEvent("ezydev:insert-prompt", { detail: text }));
          }}
        />
      )}
      <ImageInsertUndoToast />
      <UploadErrorToast />
      <UndoCloseToast />
      <UndoClearToast />
      {VOICE_ENABLED && <VoiceHud />}
      {VOICE_ENABLED && <VoiceController />}
      <GlobalContextMenu />
      <DevServerTerminalHost />
      {!onboardingCompleted && (
        <WelcomeModal
          onComplete={() => setOnboardingCompleted(true)}
          onSkip={() => setOnboardingCompleted(true)}
        />
      )}
      {changelogToShow && onboardingCompleted && (
        <ChangelogModal
          version={changelogToShow.version}
          notes={changelogToShow.notes}
          onClose={handleCloseChangelog}
        />
      )}
      {pendingDir && (
        <TemplatePicker
          onSelect={handleTemplateSelected}
          onClose={() => setPendingDir(null)}
          initialServerCommand={matchingRecentForPending?.serverCommand}
          initialNoDevServer={matchingRecentForPending?.noDevServer}
        />
      )}
    </div>
  );
}
