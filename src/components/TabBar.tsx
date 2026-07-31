import { useCallback, useState, useRef, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "../store";
import { spawnDevServer } from "../lib/spawn-dev-server";
import { openDevServerUrl, wantsInAppOpen } from "../lib/open-dev-server-url";
import { buildLayoutFromTemplate, stampTerminalTypes, findAllTerminalIds, findAllBrowserPanes, addBrowserPaneRight, addBrowserPaneLeft, addPaneAsGrid, removePane, generatePaneId, findKanbanPaneId, addKanbanPane, cloneLayoutWithFreshIds, countLeafPanes, hasGamePane } from "../lib/layout-utils";
import { TERMINAL_CONFIGS } from "../lib/terminal-config";
import { getProjectColor, autoAssignColor, isQuickOpenEnabled, type ProjectColorId, type RecentProject } from "../store/recentProjectsSlice";
import { isTerminalActive } from "../lib/terminal-activity";
import { isWindows, detectBackendForPath } from "../lib/platform";
import { startCustomWindowDrag, toggleMaximizeOnDoubleClick } from "../lib/window-chrome";
import { useModalWhen } from "../store/modalCoordinationSlice";
import { useOverlayMenu } from "../lib/useOverlayMenu";
import { useOverlayPopupAnchor } from "../native-term/useOverlayPopupAnchor";
import type { RemoteServer, TerminalType } from "../types";
import RemoteFileBrowser from "./RemoteFileBrowser";
import CreateProjectModal from "./CreateProjectModal";
import ClipboardImageStrip from "./ClipboardImageStrip";
import VoiceMicButton from "./VoiceMicButton";
import { VOICE_ENABLED } from "../lib/voice/feature-flag";
import GitStatusBar from "./GitStatusBar";
import { FaChevronDown, FaCheck } from "react-icons/fa";
import { TbBrowserPlus, TbBrowserMinus } from "react-icons/tb";
import { FaXmark, FaPlus, FaGear, FaServer } from "react-icons/fa6";
import { PiKanbanDuotone, PiGameControllerDuotone } from "react-icons/pi";
import { AiOutlinePushpin, AiFillPushpin } from "react-icons/ai";
import { BiSidebar } from "react-icons/bi";
import JiraProjectModal from "./JiraProjectModal";
import { createJiraProjectAt } from "../lib/jira-project";

function truncateTabPath(path: string, maxSegments = 3): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = normalized.split("/").filter(Boolean);
  return segments.slice(-maxSegments).join("/");
}

export default function TabBar() {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const addTabWithLayout = useAppStore((s) => s.addTabWithLayout);
  const addTerminals = useAppStore((s) => s.addTerminals);
  const removeTab = useAppStore((s) => s.removeTab);
  const togglePinTab = useAppStore((s) => s.togglePinTab);
  const reorderTabs = useAppStore((s) => s.reorderTabs);
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  // Jira mode: while a Jira project tab is active, the dev server and file
  // sidebar buttons hide — the ticket workflow doesn't use either, and the
  // slimmer bar keeps the focus on the rail + pair canvas.
  const jiraMode = useAppStore((s) => s.jiraMode ?? true);
  const hideJiraChrome =
    jiraMode && !!tabs.find((t) => t.id === activeTabId)?.isJiraProject;
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const recentProjects = useAppStore((s) => s.recentProjects);
  const addRecentProject = useAppStore((s) => s.addRecentProject);
  const removeRecentProject = useAppStore((s) => s.removeRecentProject);
  const servers = useAppStore((s) => s.servers);
  const cliYolo = useAppStore((s) => s.cliYolo);
  const newPaneNativeRenderer = useAppStore((s) => s.newPaneNativeRenderer);
  const setNewPaneNativeRenderer = useAppStore((s) => s.setNewPaneNativeRenderer);
  const hoverOpenAddPaneMenu = useAppStore((s) => s.hoverOpenAddPaneMenu);
  const toggleProjectQuickOpen = useAppStore((s) => s.toggleProjectQuickOpen);
  const setProjectBackend = useAppStore((s) => s.setProjectBackend);
  const terminalBackend = useAppStore((s) => s.terminalBackend);
  const confirmQuit = useAppStore((s) => s.confirmQuit);
  const setConfirmQuit = useAppStore((s) => s.setConfirmQuit);
  const showMiniGamesButton = useAppStore((s) => s.showMiniGamesButton ?? false);
  const showKanbanButton = useAppStore((s) => s.showKanbanButton ?? true);
  const devServers = useAppStore((s) => s.devServers);
  const devServerTabIcon = useAppStore((s) => s.devServerTabIcon);
  const devServerPanelOpen = useAppStore((s) => s.devServerPanelOpen);
  const toggleDevServerPanel = useAppStore((s) => s.toggleDevServerPanel);
  const projectColors = useAppStore((s) => s.projectColors);
  const setProjectColor = useAppStore((s) => s.setProjectColor);
  const settingsPanelOpen = useAppStore((s) => s.settingsPanelOpen);
  const showTabPath = useAppStore((s) => s.showTabPath);
  const renameTab = useAppStore((s) => s.renameTab);

  const [isMaximized, setIsMaximized] = useState(false);
  const [showQuitConfirm, setShowQuitConfirm] = useState(false);
  const [quitDontShow, setQuitDontShow] = useState(false);
  const [showNewTabMenu, setShowNewTabMenu] = useState(false);
  const [showRecentMenu, setShowRecentMenu] = useState(false);
  const [browsingServer, setBrowsingServer] = useState<RemoteServer | null>(null);
  const [showServersTab] = useState(false);
  const setPendingDir = useAppStore((s) => s.setPendingDir);
  const [showCreateProjectModal, setShowCreateProjectModal] = useState(false);
  const [showJiraProjectModal, setShowJiraProjectModal] = useState(false);
  const projectsDir = useAppStore((s) => s.projectsDir);
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  // Tab color picker — overlay-rendered (kind "swatch-menu", backdrop).
  const quitConfirmRef = useRef<HTMLDivElement>(null);
  const tabsContainerRef = useRef<HTMLDivElement>(null);

  // Hole-cut publishers: each floating overlay publishes its viewport rect so
  // the native HWND underneath cuts a hole. Refs are conditionally attached
  // (only when the overlay is rendered); useOverlayPublisher's rAF loop
  // tolerates null refs and re-reads each frame.
  const newTabChevronRef = useRef<HTMLDivElement>(null);

  // Hover-to-open mode: menus stay open only while the pointer is inside the
  // button or its dropdown. Leave either → grace timer → close (the grace
  // covers the pixels between button and popup, and button-to-button swaps).
  // One shared timer suffices — at most one of the two menus is open.
  const hoverCloseTimerRef = useRef<number | null>(null);
  const cancelHoverClose = useCallback(() => {
    if (hoverCloseTimerRef.current != null) {
      clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
  }, []);
  const scheduleHoverClose = useCallback(() => {
    if (!hoverOpenAddPaneMenu) return;
    cancelHoverClose();
    hoverCloseTimerRef.current = window.setTimeout(() => {
      hoverCloseTimerRef.current = null;
      setShowRecentMenu(false);
      setShowNewTabMenu(false);
    }, 300);
  }, [hoverOpenAddPaneMenu, cancelHoverClose]);
  // "Add pane" dropdown — overlay-rendered (kind "anchored-menu").
  useOverlayMenu({
    id: "tabbar-new-tab-menu",
    open: showNewTabMenu,
    anchorRef: newTabChevronRef,
    payload: showNewTabMenu
      ? {
          placement: "below-start",
          width: 220,
          gap: 2,
          hoverTracking: hoverOpenAddPaneMenu,
          sections: [
            {
              // Sticky renderer mode: `sticky` keeps the menu OPEN, so the
              // checkmark flips in place and the user can pick a pane type in
              // the same visit. (Closing it here used to drop the overlay
              // popup — menu gone + an app blink — for a mode change that
              // adds no pane.)
              items: [
                {
                  actionId: "toggle-native-renderer",
                  label: "Native renderer (beta)",
                  sublabel: "Ctrl+click a pane type to open native once",
                  checked: newPaneNativeRenderer,
                  sticky: true,
                },
              ],
            },
            {
              title: "Add pane",
              items: (["claude", "codex", "gemini", "shell"] as const).map(
                (type) => ({
                  actionId: `split:${type}`,
                  label: TERMINAL_CONFIGS[type].label,
                  iconId: `cli-${type}`,
                  badge: cliYolo[type] ? "YOLO" : undefined,
                  trailing: {
                    actionId: `split-down:${type}`,
                    iconId: "split-down",
                    title: "Split Down",
                  },
                }),
              ),
            },
          ],
        }
      : null,
    onAction: (actionId, data) => {
      if (actionId === "__hoverin__") {
        cancelHoverClose();
        return;
      }
      if (actionId === "__hoverout__") {
        scheduleHoverClose();
        return;
      }
      if (actionId === "toggle-native-renderer") {
        setNewPaneNativeRenderer(!newPaneNativeRenderer);
        return;
      }
      const [verb, type] = actionId.split(":");
      // Ctrl (or Cmd) forces native for this one pane, regardless of the sticky
      // mode. The overlay forwards the modifier for both the row and its
      // trailing split-down button.
      const ctrl = !!(data as { ctrl?: boolean } | undefined)?.ctrl;
      const renderer =
        newPaneNativeRenderer || ctrl ? ("native" as const) : undefined;
      if (verb === "split") {
        window.dispatchEvent(
          new CustomEvent("made:split-terminal", { detail: { type, renderer } }),
        );
      } else if (verb === "split-down") {
        window.dispatchEvent(
          new CustomEvent("made:split-terminal", {
            detail: { type, direction: "vertical", renderer },
          }),
        );
      }
    },
    onClose: () => setShowNewTabMenu(false),
  });
  useModalWhen("tabbar-quit-confirm", showQuitConfirm);
  const dragStartRef = useRef<{ tabId: string; offsetX: number; startX: number; startY: number; tabWidth: number; tabTop: number } | null>(null);
  const didDragRef = useRef(false);
  const [dragState, setDragState] = useState<{
    tabId: string;
    ghostX: number;
    tabTop: number;
    insertBeforeId: string | null;
    tabWidth: number;
  } | null>(null);

  // Poll terminal activity every 1s to update active pane counts
  const [activityTick, setActivityTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setActivityTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // The tab's working-dir tooltip is now `data-tooltip` on the tab itself,
  // driven by TooltipHost like every other tooltip in the app — this used to be
  // a bespoke 2s timer publishing its own overlay popup, which made the tab bar
  // the one surface with different tooltip timing and styling.

  const anyMenuOpen = showNewTabMenu || showRecentMenu;
  const closeAllMenus = useCallback(() => {
    setShowNewTabMenu(false);
    setShowRecentMenu(false);
  }, []);

  const getInsertBeforeId = useCallback((clientX: number, excludeId: string): string | null => {
    const container = tabsContainerRef.current;
    if (!container) return null;
    for (const btn of container.querySelectorAll<HTMLElement>("[data-tab-id]")) {
      if (btn.dataset.tabId === excludeId) continue;
      const { left, width } = btn.getBoundingClientRect();
      if (clientX < left + width / 2) return btn.dataset.tabId!;
    }
    return null;
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const ds = dragStartRef.current;
      if (!ds) return;
      const dx = Math.abs(e.clientX - ds.startX);
      const dy = Math.abs(e.clientY - ds.startY);
      if (!didDragRef.current && dx < 4 && dy < 4) return;
      didDragRef.current = true;
      setDragState({
        tabId: ds.tabId,
        ghostX: e.clientX - ds.offsetX,
        tabTop: ds.tabTop,
        insertBeforeId: getInsertBeforeId(e.clientX, ds.tabId),
        tabWidth: ds.tabWidth,
      });
    };
    const onUp = () => {
      if (didDragRef.current) {
        setDragState((prev) => {
          if (prev) reorderTabs(prev.tabId, prev.insertBeforeId);
          return null;
        });
      } else {
        setDragState(null);
      }
      dragStartRef.current = null;
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
  }, [getInsertBeforeId, reorderTabs]);

  const handleNewLocalTab = useCallback(() => {
    setShowNewTabMenu(false);
    window.dispatchEvent(new Event("made:new-tab"));
  }, []);

  const handleRemotePathSelected = useCallback((remotePath: string) => {
    if (!browsingServer) return;
    const name = remotePath.split("/").filter(Boolean).pop() || browsingServer.name;
    setBrowsingServer(null);
    setPendingDir({ name, dir: remotePath, serverId: browsingServer.id });
  }, [browsingServer]);

  const autoStartServerCommand = useAppStore((s) => s.autoStartServerCommand);

  /** Quick-open a recent project using saved layout (or template fallback) */
  const quickOpenProject = useCallback(
    (project: RecentProject, startFresh: boolean) => {
      if (project.lastLayout) {
        // Use last-closed layout — clone with fresh IDs, optionally strip resume IDs
        const { layout, terminalIds } = cloneLayoutWithFreshIds(project.lastLayout, { stripResume: startFresh });
        const batch = terminalIds.map((t) => ({
          id: t.id,
          type: t.type,
          workingDir: project.path,
          serverId: project.serverId,
        }));
        addTerminals(batch);
        const tabId = addTabWithLayout(project.name, project.path, layout, project.serverId);
        addRecentProject({ path: project.path, name: project.name, template: project.lastTemplate, serverId: project.serverId });
        if (project.serverCommand && autoStartServerCommand && !project.noDevServer) {
          spawnDevServer(tabId, project.name, project.path, project.serverCommand, project.serverId);
        }
      } else if (project.lastTemplate) {
        // Fallback to template-based rebuild
        const { templateId, cols, rows, slotTypes, paneCount } = project.lastTemplate;
        const { layout, terminalIds } = buildLayoutFromTemplate(templateId, cols, rows, paneCount);
        const typedLayout = stampTerminalTypes(layout, terminalIds, slotTypes);
        const batch = terminalIds.map((id, i) => ({
          id,
          type: slotTypes[i] ?? ("shell" as TerminalType),
          workingDir: project.path,
          serverId: project.serverId,
        }));
        addTerminals(batch);
        const tabId = addTabWithLayout(project.name, project.path, typedLayout, project.serverId);
        addRecentProject({ path: project.path, name: project.name, template: project.lastTemplate, serverId: project.serverId });
        if (project.serverCommand && autoStartServerCommand && !project.noDevServer) {
          spawnDevServer(tabId, project.name, project.path, project.serverCommand, project.serverId);
        }
      }
    },
    [addTerminals, addTabWithLayout, addRecentProject, autoStartServerCommand]
  );

  // Recent-projects dropdown — overlay-rendered (custom kind "recent-menu",
  // backdrop). Live payload: rows update in place (quick/backend/remove keep
  // the menu open, mirroring the old DOM menu).
  const recentBtnRef = useRef<HTMLDivElement>(null);
  useOverlayPopupAnchor({
    id: "tabbar-recent-menu",
    kind: "recent-menu",
    open: showRecentMenu,
    anchorRef: recentBtnRef,
    payload: showRecentMenu
      ? {
          projects: recentProjects.map((project) => {
            const hasSavedLayout = !!project.lastLayout || !!project.lastTemplate;
            const canQuickOpen = hasSavedLayout && isQuickOpenEnabled(project);
            const savedPaneCount = project.lastLayout
              ? countLeafPanes(project.lastLayout)
              : project.lastTemplate?.paneCount;
            const linkedServer = project.serverId
              ? servers.find((sv) => sv.id === project.serverId)
              : undefined;
            const isOrphanRemote = !!project.serverId && !linkedServer;
            const backend = (() => {
              if (!isWindows() || project.serverId) return null;
              const effective =
                project.preferredBackend ??
                detectBackendForPath(project.path, terminalBackend);
              if (effective !== "wsl" && effective !== "windows") return null;
              return effective === "wsl" ? "WSL" : "WIN";
            })();
            return {
              key: project.id,
              name: project.name,
              subtitle: truncatePath(project.path),
              tooltip: isOrphanRemote
                ? `Server removed — re-add it in the Remote Servers panel to use this project. (${project.path})`
                : linkedServer
                  ? `${linkedServer.name}: ${project.path}`
                  : project.path,
              disabled: isOrphanRemote,
              badge: project.serverId
                ? isOrphanRemote
                  ? "no server"
                  : (linkedServer?.name ?? linkedServer?.host ?? "remote")
                : undefined,
              badgeMuted: isOrphanRemote,
              jira: !!project.isJira,
              // Jira projects reopen through their own path (rail + per-ticket
              // canvas) — the layout-restore shortcuts would rebuild them as
              // plain grids, so hide those controls for them.
              showFresh: !project.isJira && canQuickOpen,
              showQuick: !project.isJira && hasSavedLayout,
              quickOn: isQuickOpenEnabled(project),
              paneCount: String(savedPaneCount ?? "?"),
              backendLabel: backend ?? undefined,
            };
          }),
          // The modal itself offers local + server locations, so creating is
          // possible as soon as EITHER exists.
          canCreate: !!projectsDir || servers.length > 0,
          servers: servers.map((sv) => ({ id: sv.id, name: sv.name })),
          hoverTracking: hoverOpenAddPaneMenu,
        }
      : null,
    onAction: (action) => {
      if (action === "__hoverin__") {
        cancelHoverClose();
        return;
      }
      if (action === "__hoverout__") {
        scheduleHoverClose();
        return;
      }
      if (action === "__dismiss__") {
        setShowRecentMenu(false);
        return;
      }
      const idx = action.indexOf(":");
      const verb = idx === -1 ? action : action.slice(0, idx);
      const arg = idx === -1 ? "" : action.slice(idx + 1);
      const project = recentProjects.find((pr) => pr.id === arg);
      switch (verb) {
        case "open":
          if (!project) return;
          setShowRecentMenu(false);
          // Jira projects reopen as Jira tabs (rail + per-ticket canvas) —
          // never through the template picker or layout restore, which would
          // recreate them as plain grids.
          if (project.isJira) {
            void createJiraProjectAt({ path: project.path, serverId: project.serverId });
            break;
          }
          if ((!!project.lastLayout || !!project.lastTemplate) && isQuickOpenEnabled(project)) {
            quickOpenProject(project, false);
          } else {
            setPendingDir({
              name: project.name,
              dir: project.path,
              serverId: project.serverId,
            });
          }
          break;
        case "fresh":
          if (!project) return;
          setShowRecentMenu(false);
          quickOpenProject(project, true);
          break;
        case "quick":
          if (project) toggleProjectQuickOpen(project.path, project.serverId);
          break;
        case "backend": {
          if (!project) return;
          const effective =
            project.preferredBackend ??
            detectBackendForPath(project.path, terminalBackend);
          setProjectBackend(
            project.path,
            project.serverId,
            effective === "wsl" ? "windows" : "wsl",
          );
          break;
        }
        case "remove":
          if (project) removeRecentProject(project.path, project.serverId);
          break;
        case "create":
          setShowRecentMenu(false);
          setShowCreateProjectModal(true);
          break;
        case "browse":
          setShowRecentMenu(false);
          handleNewLocalTab();
          break;
        case "jira":
          setShowRecentMenu(false);
          setShowJiraProjectModal(true);
          break;
        case "server": {
          const server = servers.find((sv) => sv.id === arg);
          if (server) {
            setShowRecentMenu(false);
            setBrowsingServer(server);
          }
          break;
        }
      }
    },
  });

  // Track maximized state for window control icon
  useEffect(() => {
    const win = getCurrentWindow();
    win.isMaximized().then(setIsMaximized);
    let unlisten: (() => void) | undefined;
    const setup = async () => {
      unlisten = await win.onResized(async () => {
        setIsMaximized(await win.isMaximized());
      });
    };
    setup();
    return () => { unlisten?.(); };
  }, []);

  // Listen for open-recent event from startup screen
  useEffect(() => {
    const handler = (e: Event) => {
      const { path, name } = (e as CustomEvent).detail;
      const project = recentProjects.find((p) => p.path === path);
      if (project && (project.lastLayout || project.lastTemplate)) {
        quickOpenProject(project, false);
      } else {
        setPendingDir({ name, dir: path });
      }
    };
    window.addEventListener("made:open-recent", handler);
    return () => window.removeEventListener("made:open-recent", handler);
  }, [recentProjects, quickOpenProject]);

  // Listen for OS-level quit request (Alt+F4 etc.) intercepted in App.tsx
  useEffect(() => {
    const handler = () => {
      setQuitDontShow(false);
      setShowQuitConfirm(true);
    };
    window.addEventListener("made:quit-requested", handler);
    return () => window.removeEventListener("made:quit-requested", handler);
  }, []);

  // Helper: truncate long paths for display
  function truncatePath(fullPath: string): string {
    const segments = fullPath.replace(/\\/g, "/").split("/").filter(Boolean);
    if (segments.length <= 3) return fullPath;
    return ".../" + segments.slice(-2).join("/");
  }

  // Helper: get icon for tab type
  const renderTabIcon = (tab: typeof tabs[0], isActive: boolean) => {
    const activeColor = "var(--ezy-text)";
    const inactiveColor = "var(--ezy-text-muted)";
    const color = isActive ? activeColor : inactiveColor;

    if (tab.isKanbanTab) {
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.3" style={{ flexShrink: 0 }}>
          <rect x="1" y="2" width="4" height="12" rx="1" />
          <rect x="6" y="4" width="4" height="10" rx="1" />
          <rect x="11" y="1" width="4" height="13" rx="1" />
        </svg>
      );
    }
    if (tab.isSettingsTab) {
      return <FaGear size={13} color={color} style={{ flexShrink: 0 }} />;
    }
    if (tab.isServersTab) {
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={isActive ? "var(--ezy-cyan)" : inactiveColor} strokeWidth="1.3" style={{ flexShrink: 0 }}>
          <rect x="2" y="1" width="12" height="6" rx="1.5" />
          <rect x="2" y="9" width="12" height="6" rx="1.5" />
          <circle cx="5" cy="4" r="1" fill={isActive ? "var(--ezy-cyan)" : inactiveColor} stroke="none" />
          <circle cx="5" cy="12" r="1" fill={isActive ? "var(--ezy-cyan)" : inactiveColor} stroke="none" />
        </svg>
      );
    }
    if (tab.isDevServerTab) {
      return <FaServer size={14} color={color} style={{ flexShrink: 0 }} />;
    }
    if (tab.serverId) {
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={isActive ? "var(--ezy-cyan)" : inactiveColor} strokeWidth="1.3" style={{ flexShrink: 0 }}>
          <rect x="2" y="1" width="12" height="6" rx="1.5" />
          <rect x="2" y="9" width="12" height="6" rx="1.5" />
          <circle cx="5" cy="4" r="1" fill={isActive ? "var(--ezy-cyan)" : inactiveColor} stroke="none" />
          <circle cx="5" cy="12" r="1" fill={isActive ? "var(--ezy-cyan)" : inactiveColor} stroke="none" />
        </svg>
      );
    }
    // Default: terminal prompt icon (Warp style >_)
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        <polyline points="4,4 8,8 4,12" />
        <line x1="9" y1="12" x2="13" y2="12" />
      </svg>
    );
  };

  return (
    <>
      {/* Invisible backdrop to catch clicks outside dropdowns (Tauri drag region swallows mousedown) */}
      {anyMenuOpen && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 50 }}
          onMouseDown={closeAllMenus}
        />
      )}
      <div
        className="tab-bar flex items-stretch select-none"
        style={{
          height: 38,
          backgroundColor: "var(--ezy-bg)",
          borderBottom: "1px solid var(--ezy-border)",
          position: "relative",
          zIndex: 60,
        }}
      >
        {/* Sidebar toggle (Warp-style) — hidden in Jira mode on Jira tabs */}
        {!hideJiraChrome && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 40,
              flexShrink: 0,
              cursor: "pointer",
              backgroundColor: sidebarOpen ? "var(--ezy-surface)" : "transparent",
            }}
            onClick={() => { closeAllMenus(); if (!sidebarOpen) useAppStore.getState().setSettingsPanelOpen(false); toggleSidebar(); }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-surface)"}
            onMouseLeave={(e) => {
              if (!sidebarOpen) e.currentTarget.style.backgroundColor = "transparent";
            }}
          >
            <BiSidebar size={14} color={sidebarOpen ? "var(--ezy-accent)" : "var(--ezy-text-muted)"} />
          </div>
        )}

        {/* Dev Servers icon button — hidden in Jira mode on Jira tabs */}
        {!hideJiraChrome && (() => {
          const isDevActive = devServerPanelOpen;
          const runningCount = devServers.filter((s) => s.status === "running" || s.status === "starting").length;
          return (
            <div
              data-tooltip="Dev Servers"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 36,
                flexShrink: 0,
                cursor: "pointer",
                backgroundColor: isDevActive ? "var(--ezy-surface)" : "transparent",
                position: "relative",
                borderRight: isDevActive ? "1px solid var(--ezy-border)" : "1px solid var(--ezy-border-subtle)",
              }}
              onClick={() => { closeAllMenus(); if (!devServerPanelOpen) useAppStore.getState().setSettingsPanelOpen(false); toggleDevServerPanel(); }}
              onMouseEnter={(e) => { if (!isDevActive) e.currentTarget.style.backgroundColor = "var(--ezy-surface)"; }}
              onMouseLeave={(e) => { if (!isDevActive) e.currentTarget.style.backgroundColor = "transparent"; }}
            >
              {/* Rocket/activity icon */}
              <FaServer size={15} color={isDevActive ? "var(--ezy-accent)" : "var(--ezy-text-muted)"} />
              {runningCount > 0 && (
                <span style={{
                  position: "absolute",
                  top: 4,
                  right: 3,
                  minWidth: 12,
                  height: 12,
                  borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
                  backgroundColor: "var(--ezy-accent)",
                  border: "1px solid var(--ezy-bg)",
                  fontSize: 7,
                  fontWeight: 700,
                  color: "#fff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  lineHeight: 1,
                  padding: "0 2px",
                }}>
                  {runningCount}
                </span>
              )}
            </div>
          );
        })()}

        {/* Settings toggle */}
        <div
         
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 36,
            flexShrink: 0,
            cursor: "pointer",
            backgroundColor: settingsPanelOpen ? "var(--ezy-surface)" : "transparent",
            borderRight: settingsPanelOpen ? "1px solid var(--ezy-border)" : "1px solid var(--ezy-border-subtle)",
          }}
          onClick={() => { closeAllMenus(); if (!settingsPanelOpen) { useAppStore.setState({ sidebarOpen: false, devServerPanelOpen: false }); } useAppStore.getState().toggleSettingsPanel(); }}
          onMouseEnter={(e) => { if (!settingsPanelOpen) e.currentTarget.style.backgroundColor = "var(--ezy-surface)"; }}
          onMouseLeave={(e) => { if (!settingsPanelOpen) e.currentTarget.style.backgroundColor = "transparent"; }}
        >
          <FaGear size={14} color={settingsPanelOpen ? "var(--ezy-accent)" : "var(--ezy-text-muted)"} />
        </div>

        {/* Tabs */}
        <div ref={tabsContainerRef} data-ctx-surface="tabstrip" style={{ display: "flex", alignItems: "stretch", minWidth: 0, overflow: "hidden" }}>
          {(() => {
            // Build a local color map so tabs assigned in the same render pass see each other
            const localColors = { ...projectColors };
            const pendingAssigns: Array<[string, ProjectColorId]> = [];
            const visibleTabs = tabs.filter((t) => !t.isDevServerTab && !t.isKanbanTab && (!t.isServersTab || showServersTab) && !t.isSettingsTab);

            // Collect unique project dirs for visible non-system tabs
            const visibleDirs = new Set<string>();
            for (const tab of visibleTabs) {
              if (!(tab.isKanbanTab || tab.isDevServerTab || tab.isServersTab || tab.isSettingsTab)) {
                const dir = tab.workingDir.replace(/\\/g, "/");
                if (dir) visibleDirs.add(dir);
              }
            }

            // Assign colors for any tabs missing them
            for (const dir of visibleDirs) {
              if (localColors[dir] === undefined) {
                const newId = autoAssignColor(localColors);
                localColors[dir] = newId;
                pendingAssigns.push([dir, newId]);
              }
            }

            // Dedup: if two different visible projects share the same color, reassign the later one
            const colorToDirs = new Map<string, string[]>();
            for (const dir of visibleDirs) {
              const cid = localColors[dir];
              if (cid) {
                const list = colorToDirs.get(cid) ?? [];
                list.push(dir);
                colorToDirs.set(cid, list);
              }
            }
            for (const [, dirs] of colorToDirs) {
              if (dirs.length <= 1) continue;
              // Keep the first, reassign the rest
              for (let i = 1; i < dirs.length; i++) {
                const newId = autoAssignColor(localColors);
                localColors[dirs[i]] = newId;
                pendingAssigns.push([dirs[i], newId]);
              }
            }

            // Commit all new/changed assignments to store
            for (const [dir, colorId] of pendingAssigns) {
              setProjectColor(dir, colorId);
            }
            return visibleTabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const isSystemTab = tab.isKanbanTab || tab.isDevServerTab || tab.isServersTab || tab.isSettingsTab;
            const isUserPinned = !!tab.isPinned;
            const normalizedDir = tab.workingDir.replace(/\\/g, "/");
            const tabColor = (!isSystemTab && normalizedDir) ? getProjectColor(localColors[normalizedDir] ?? null) : null;

            return (
              <div key={tab.id} style={{ display: "contents" }}>
                {/* Placeholder slot at this position during drag */}
                {dragState && dragState.insertBeforeId === tab.id && (
                  <div style={{ width: dragState.tabWidth, flexShrink: 0, height: "100%", borderRight: "1px solid var(--ezy-border-subtle)" }} />
                )}
                {/* Skip rendering the dragged tab — its slot is gone, others shift in */}
                {dragState?.tabId === tab.id ? null : (
                <button
                  role="tab"
                  aria-selected={isActive}
                  data-tab-id={tab.id}
                  onClick={() => {
                    if (didDragRef.current) return;
                    closeAllMenus();
                    if (tab.isSettingsTab) {
                      // No-op: settings tab is only visible when panel is open,
                      // close via X button or Ctrl+,
                    } else {
                      setActiveTab(tab.id);
                    }
                  }}
                  onPointerDown={(e) => {
                    if (e.button !== 0 || isSystemTab) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    dragStartRef.current = {
                      tabId: tab.id,
                      offsetX: e.clientX - rect.left,
                      startX: e.clientX,
                      startY: e.clientY,
                      tabWidth: rect.width,
                      tabTop: rect.top,
                    };
                    didDragRef.current = false;
                  }}
                  className="group"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "0 12px",
                    position: "relative",
                    backgroundColor: isActive ? "var(--ezy-surface)" : "transparent",
                    backgroundImage: isUserPinned
                      ? "repeating-linear-gradient(135deg, transparent, transparent 4px, rgba(255,255,255,0.05) 4px, rgba(255,255,255,0.05) 8px)"
                      : undefined,
                    border: "none",
                    cursor: isSystemTab ? "pointer" : "grab",
                    fontSize: 12,
                    fontWeight: isActive ? 500 : 400,
                    color: isActive ? "var(--ezy-text)" : "var(--ezy-text-muted)",
                    fontFamily: "inherit",
                    transition: "background-color 120ms ease, color 120ms ease",
                    outline: "none",
                    // Floor evens out the strip: short-named tabs (TV, EVP)
                    // stop rendering as stubs next to long ones, without the
                    // padding/truncation costs of fully fixed-width tabs.
                    // Labels keep content sizing between the two bounds.
                    minWidth: isSystemTab ? 0 : 90,
                    maxWidth: 200,
                    height: "100%",
                    borderRight: "1px solid var(--ezy-border-subtle)",
                    borderBottom: tabColor ? `2px solid ${tabColor}` : "2px solid transparent",
                    userSelect: "none",
                  }}
                  data-tooltip={tab.workingDir || undefined}
                  onMouseEnter={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.03)";
                      e.currentTarget.style.color = "var(--ezy-text-secondary)";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.backgroundColor = "transparent";
                      e.currentTarget.style.color = "var(--ezy-text-muted)";
                    }
                  }}
                >
                  {/* Tab icon (special tabs only — no icon for regular project tabs) */}
                  {(tab.isKanbanTab || tab.isServersTab || tab.isDevServerTab || tab.isSettingsTab || tab.serverId) && renderTabIcon(tab, isActive)}

                  {/* Label with pane count and activity indicator */}
                  {!tab.isServersTab && !tab.isSettingsTab && (
                  <span
                    style={{
                      overflow: "visible",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      flex: 1,
                      minWidth: 0,
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    {(() => {
                      const termIds = tab.layout ? findAllTerminalIds(tab.layout) : [];
                      const cliCount = termIds.length;
                      // activityTick is read to trigger re-render on poll
                      void activityTick;
                      const activeCount = termIds.filter((id) => isTerminalActive(id)).length;
                      return (
                        <>
                          {showTabPath && !isSystemTab && renamingTabId === tab.id ? (
                            <input
                              ref={renameInputRef}
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              onBlur={() => {
                                if (renameValue.trim()) renameTab(tab.id, renameValue.trim());
                                setRenamingTabId(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  if (renameValue.trim()) renameTab(tab.id, renameValue.trim());
                                  setRenamingTabId(null);
                                }
                                if (e.key === "Escape") setRenamingTabId(null);
                                e.stopPropagation();
                              }}
                              onClick={(e) => e.stopPropagation()}
                              style={{
                                fontSize: 12,
                                fontFamily: "inherit",
                                backgroundColor: "var(--ezy-bg)",
                                border: "1px solid var(--ezy-accent)",
                                borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
                                color: "var(--ezy-text)",
                                outline: "none",
                                padding: "0 4px",
                                width: 80,
                                lineHeight: "18px",
                              }}
                            />
                          ) : (
                            <span
                              onDoubleClick={(e) => {
                                if (isSystemTab || !showTabPath) return;
                                e.stopPropagation();
                                setRenameValue(tab.customName ?? tab.name);
                                setRenamingTabId(tab.id);
                                setTimeout(() => renameInputRef.current?.select(), 0);
                              }}
                            >
                              {showTabPath && tab.customName ? tab.customName : tab.name}
                            </span>
                          )}
                          {tab.isHibernated && (
                            <span
                              data-tooltip={`Hibernated — ${cliCount} pane${cliCount === 1 ? "" : "s"} sleeping. Click to wake (Claude sessions resume).`}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                lineHeight: 1,
                                padding: "1px 4px",
                                borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                                position: "relative" as const,
                                top: 1,
                                backgroundColor: "var(--ezy-surface-raised)",
                                border: "1px solid var(--ezy-border)",
                                color: "var(--ezy-text-muted)",
                              }}
                            >
                              <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor">
                                <path d="M9.598 1.591a.749.749 0 01.785-.175 7.001 7.001 0 11-8.967 8.967.75.75 0 01.961-.96 5.5 5.5 0 007.046-7.046.75.75 0 01.175-.786zm1.616 1.945a7 7 0 01-7.678 7.678 5.499 5.499 0 107.678-7.678z" />
                              </svg>
                            </span>
                          )}
                          {cliCount > 1 && !tab.isHibernated && (
                            <span
                              style={{
                                fontSize: 9,
                                fontWeight: 600,
                                lineHeight: 1,
                                padding: "1px 4px",
                                borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                                position: "relative" as const,
                                top: 1,
                                backgroundColor: "var(--ezy-surface-raised)",
                                border: "1px solid var(--ezy-border)",
                                color: "var(--ezy-text-secondary)",
                              }}
                            >
                              {cliCount}
                              {activeCount > 0 && (
                                <span style={{
                                  position: "absolute",
                                  top: -7,
                                  right: -8,
                                  minWidth: 12,
                                  height: 12,
                                  borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
                                  backgroundColor: "var(--ezy-accent)",
                                  border: "1px solid var(--ezy-bg)",
                                  fontSize: 7,
                                  fontWeight: 700,
                                  color: "#fff",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  lineHeight: 1,
                                  padding: "0 2px",
                                }}>
                                  {activeCount}
                                </span>
                              )}
                            </span>
                          )}
                          {showTabPath && !isSystemTab && tab.workingDir && (
                            <span style={{ fontSize: 10, color: "var(--ezy-text-muted)", opacity: 0.5, whiteSpace: "nowrap" }}>
                              {truncateTabPath(tab.workingDir, 2)}
                            </span>
                          )}
                        </>
                      );
                    })()}
                  </span>
                  )}

                  {/* Dev-server quick-open (Settings > Preview Panes > "Dev
                      server button on project tab"). RESERVE-SLOT: the element
                      is rendered on EVERY project tab whose server is running
                      so the tab's width never changes when it (de)activates —
                      only the ACTIVE tab actually shows and handles the icon.
                      Green = the app-wide running color (StatusDot). Plain
                      click = external browser, Ctrl/Cmd = MADE browser pane. */}
                  {devServerTabIcon !== "off" && !isSystemTab && (() => {
                    const tabNorm = tab.workingDir?.replace(/\\/g, "/");
                    const ds = devServers.find(
                      (srv) =>
                        srv.status === "running" &&
                        (srv.tabId === tab.id ||
                          (!!tabNorm && srv.workingDir.replace(/\\/g, "/") === tabNorm)),
                    );
                    if (!ds) return null;
                    // "all": live icon on every tab with a running server —
                    // opens a BACKGROUND project's URL without switching tabs.
                    // "active": icon shown on the active tab only; inactive
                    // tabs keep an invisible slot so the width never shifts.
                    const iconLive = devServerTabIcon === "all" || isActive;
                    return (
                      <span
                        role={iconLive ? "button" : undefined}
                        aria-label="Open dev server in browser"
                        data-tooltip={iconLive ? `Open localhost:${ds.port} in browser` : undefined}
                        data-tooltip-hint={iconLive ? "Ctrl+Click opens the MADE browser pane" : undefined}
                        onClick={(e) => {
                          e.stopPropagation();
                          openDevServerUrl(ds, { inApp: wantsInAppOpen(e) });
                        }}
                        // No hover BACKGROUND here on purpose: the pane-count
                        // badge's activity dot overhangs its parent and any bg
                        // box behind this icon collides with it. Hover feedback
                        // is a color change, like the tab's close/pin buttons.
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: 14,
                          height: 14,
                          flexShrink: 0,
                          marginLeft: 2,
                          cursor: "pointer",
                          color: "var(--ezy-text-muted)",
                          transition: "color 120ms ease",
                          visibility: iconLive ? "visible" : "hidden",
                          pointerEvents: iconLive ? "auto" : "none",
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--ezy-text)")}
                        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--ezy-text-muted)")}
                      >
                        <svg width={10} height={10} viewBox="0 0 12 12" fill="none">
                          <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.2" />
                          <ellipse cx="6" cy="6" rx="2" ry="4.5" stroke="currentColor" strokeWidth="1" />
                          <path d="M1.5 6h9" stroke="currentColor" strokeWidth="1" />
                        </svg>
                      </span>
                    );
                  })()}

                  {/* Settings tab: X to close panel (hover reveal) */}
                  {tab.isSettingsTab && (
                    <FaXmark
                      size={10}
                      color="currentColor"
                      className="opacity-0 group-hover:opacity-40 hover:!opacity-100"
                      style={{ cursor: "pointer", transition: "opacity 120ms ease", flexShrink: 0, marginLeft: 6 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        useAppStore.getState().setSettingsPanelOpen(false);
                      }}
                    />
                  )}
                  {/* Right column: close (top) + pin (bottom) — hover reveal */}
                  {!isSystemTab && (
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 6,
                        flexShrink: 0,
                        marginLeft: 8,
                        marginRight: -6,
                      }}
                    >
                      {/* Close button — small X, only for unpinned tabs, hover only */}
                      {!isUserPinned && (
                        <FaXmark
                          size={10}
                          color="currentColor"
                          className="opacity-0 group-hover:opacity-40 hover:!opacity-100"
                          style={{
                            cursor: "pointer",
                            transition: "opacity 120ms ease",
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            removeTab(tab.id);
                          }}
                        />
                      )}
                      {/* Pin toggle — hover only for both states */}
                      {isUserPinned ? (
                        <AiFillPushpin
                          size={10}
                          color="var(--ezy-accent)"
                          className="opacity-0 group-hover:opacity-40 hover:!opacity-100"
                          style={{
                            cursor: "pointer",
                            transition: "opacity 120ms ease",
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            togglePinTab(tab.id);
                          }}
                        />
                      ) : (
                        <AiOutlinePushpin
                          size={10}
                          color="currentColor"
                          className="opacity-0 group-hover:opacity-40 hover:!opacity-100"
                          style={{
                            cursor: "pointer",
                            transition: "opacity 120ms ease",
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            togglePinTab(tab.id);
                          }}
                        />
                      )}
                    </div>
                  )}
                </button>
                )}
              </div>
            );
          });
          })()}
          {/* Placeholder slot at end when dragging past all tabs */}
          {dragState && dragState.insertBeforeId === null && (
            <div style={{ width: dragState.tabWidth, flexShrink: 0, height: "100%", borderRight: "1px solid var(--ezy-border-subtle)" }} />
          )}
        </div>

        {/* Ghost tab — pixel-perfect clone of the real tab, floats under cursor */}
        {dragState && (() => {
          const ghostTab = tabs.find((t) => t.id === dragState.tabId);
          if (!ghostTab) return null;
          const gIsActive = ghostTab.id === activeTabId;
          const gIsUserPinned = !!ghostTab.isPinned;
          const gIsSystemTab = ghostTab.isKanbanTab || ghostTab.isDevServerTab || ghostTab.isServersTab || ghostTab.isSettingsTab;
          const gTermIds = ghostTab.layout ? findAllTerminalIds(ghostTab.layout) : [];
          const gCliCount = gTermIds.length;
          return (
            <div
              style={{
                position: "fixed",
                left: dragState.ghostX,
                top: dragState.tabTop,
                pointerEvents: "none",
                zIndex: 9999,
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "0 12px",
                height: 38,
                width: dragState.tabWidth,
                fontSize: 12,
                fontWeight: gIsActive ? 500 : 400,
                color: gIsActive ? "var(--ezy-text)" : "var(--ezy-text-muted)",
                fontFamily: "inherit",
                backgroundColor: gIsActive ? "var(--ezy-surface)" : "var(--ezy-bg)",
                backgroundImage: gIsUserPinned
                  ? "repeating-linear-gradient(135deg, transparent, transparent 4px, rgba(255,255,255,0.05) 4px, rgba(255,255,255,0.05) 8px)"
                  : undefined,
                boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
                borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                border: "1px solid var(--ezy-border)",
                cursor: "grabbing",
                userSelect: "none",
                overflow: "hidden",
              }}
            >
              {(ghostTab.isKanbanTab || ghostTab.isServersTab || ghostTab.isDevServerTab || ghostTab.isSettingsTab || ghostTab.serverId) && renderTabIcon(ghostTab, gIsActive)}
              {!ghostTab.isServersTab && !ghostTab.isSettingsTab && (
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 4 }}>
                  <span>{ghostTab.name}</span>
                  {gCliCount > 1 && (
                    <span style={{ fontSize: 9, fontWeight: 600, lineHeight: 1, padding: "1px 4px", borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)", position: "relative" as const, top: 1, backgroundColor: "var(--ezy-surface-raised)", border: "1px solid var(--ezy-border)", color: "var(--ezy-text-secondary)" }}>
                      {gCliCount}
                    </span>
                  )}
                </span>
              )}
              {!gIsSystemTab && (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, flexShrink: 0, marginLeft: 8, marginRight: -6 }}>
                  {!gIsUserPinned && (
                    <FaXmark size={10} color="currentColor" style={{ opacity: 0 }} />
                  )}
                  {gIsUserPinned ? (
                    <AiFillPushpin size={10} color="var(--ezy-accent)" style={{ opacity: 0.4 }} />
                  ) : (
                    <AiOutlinePushpin size={10} color="currentColor" style={{ opacity: 0 }} />
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {/* New tab button + dropdown chevron (Warp style: separate + and ⌄) */}
        <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
          {/* + button — opens recent projects dropdown or folder picker */}
          <div
            ref={recentBtnRef}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              cursor: "pointer",
              padding: "0 8px",
              backgroundColor: showRecentMenu ? "var(--ezy-surface-raised)" : "transparent",
            }}
            onClick={() => {
              setShowNewTabMenu(false);
              if (recentProjects.length > 0 || projectsDir || servers.length > 0) {
                setShowRecentMenu((v) => !v);
              } else {
                setShowRecentMenu(false);
                handleNewLocalTab();
              }
            }}
            onMouseEnter={(e) => {
              cancelHoverClose();
              // Same hover-to-open setting as the add-pane chevron next door;
              // each button closes the other's menu, so moving the pointer
              // between the two is an instant switch.
              if (
                hoverOpenAddPaneMenu &&
                !showRecentMenu &&
                (recentProjects.length > 0 || projectsDir || servers.length > 0)
              ) {
                setShowNewTabMenu(false);
                setShowRecentMenu(true);
                return;
              }
              if (!showRecentMenu) e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
            }}
            onMouseLeave={(e) => {
              scheduleHoverClose();
              if (!showRecentMenu) e.currentTarget.style.backgroundColor = "transparent";
            }}
          >
            <FaPlus size={13} color={showRecentMenu ? "var(--ezy-text)" : "var(--ezy-text-muted)"} />
          </div>

          {/* Recent Projects dropdown */}
          {/* Recent-projects menu — overlay-rendered (kind "recent-menu", hook above). */}

          {/* Chevron — opens the Add-pane menu. Gated on the ACTIVE tab (same
              precedent as the Git bar below): the menu only ever spawns panes
              into the active tab, so a system tab hides it — and so does a
              Jira project, whose panes are opened from the ticket rail. */}
          {(() => {
            const at = tabs.find((t) => t.id === activeTabId);
            return at && !at.isKanbanTab && !at.isDevServerTab && !at.isServersTab && !at.isSettingsTab && !at.isJiraProject;
          })() && <><div
            ref={newTabChevronRef}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              cursor: "pointer",
              padding: "0 6px",
              borderLeft: "1px solid var(--ezy-border-subtle)",
              backgroundColor: showNewTabMenu ? "var(--ezy-surface-raised)" : "transparent",
            }}
            onClick={() => {
              setShowRecentMenu(false);
              setShowNewTabMenu((v) => !v);
            }}
            onMouseEnter={(e) => {
              cancelHoverClose();
              if (hoverOpenAddPaneMenu && !showNewTabMenu) {
                setShowRecentMenu(false);
                setShowNewTabMenu(true);
                return;
              }
              if (!showNewTabMenu) e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
            }}
            onMouseLeave={(e) => {
              scheduleHoverClose();
              if (!showNewTabMenu) e.currentTarget.style.backgroundColor = "transparent";
            }}
          >
            <FaChevronDown size={8} color={showNewTabMenu ? "var(--ezy-text)" : "var(--ezy-text-muted)"} />
          </div>

          {/* Add-pane menu — overlay-rendered (useOverlayMenu above). */}
          </>}
        </div>

        {/* Spacer — app-owned drag path; avoids Windows' native frame during restore drags. */}
        <div
          className="flex-1"
          onPointerDown={anyMenuOpen ? () => closeAllMenus() : startCustomWindowDrag}
          onDoubleClick={anyMenuOpen ? undefined : toggleMaximizeOnDoubleClick}
        />

        {/* Git Status Bar — only for project tabs with workingDir */}
        {(() => {
          const at = tabs.find((t) => t.id === activeTabId);
          return at && at.workingDir && !at.isDevServerTab && !at.isServersTab && !at.isKanbanTab && !at.isSettingsTab;
        })() && (
          <GitStatusBar workingDir={tabs.find((t) => t.id === activeTabId)!.workingDir!} />
        )}

        {/* Voice agent mic — sits to the left of the clipboard image strip */}
        {VOICE_ENABLED && <VoiceMicButton />}

        {/* Clipboard image thumbnails */}
        <ClipboardImageStrip />

        {/* Tasks */}
        {showKanbanButton && (
          <div
            onClick={() => {
              const store = useAppStore.getState();
              const tab = store.tabs.find((t) => t.id === activeTabId);
              if (!tab || !tab.layout || tab.isDevServerTab || tab.isServersTab || tab.isKanbanTab || tab.isSettingsTab) return;

              // Toggle: if kanban already exists, remove it
              const existingId = findKanbanPaneId(tab.layout);
              if (existingId) {
                const newLayout = removePane(tab.layout, existingId);
                if (newLayout) store.updateTabLayout(tab.id, newLayout);
                return;
              }

              // Smart add: placement depends on row count
              const newLayout = addKanbanPane(tab.layout);
              if (newLayout) store.updateTabLayout(tab.id, newLayout);
            }}
            data-tooltip="Tasks"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              alignSelf: "center",
              width: 34,
              height: 26,
              cursor: "pointer",
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
              backgroundColor: "transparent",
              transition: "background-color 120ms ease",
            }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-surface)"}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
          >
            <PiKanbanDuotone size={14} color="var(--ezy-text-muted)" style={{ transform: "scale(1.5)" }} />
          </div>
        )}

        {/* Browser Preview — only for project tabs. Hidden for Jira projects:
            every ticket owns its browser pane inside its pair, and a manually
            added free-standing browser would make the migration effect read
            the layout as legacy and rebuild it. */}
        {(() => {
          const at = tabs.find((t) => t.id === activeTabId);
          return at && !at.isDevServerTab && !at.isServersTab && !at.isKanbanTab && !at.isSettingsTab && !at.isJiraProject;
        })() && (
          <div
            onClick={() => {
              const store = useAppStore.getState();
              const tab = store.tabs.find((t) => t.id === store.activeTabId);
              if (!tab || !tab.layout || tab.isDevServerTab || tab.isServersTab || tab.isKanbanTab || tab.isSettingsTab || tab.isJiraProject) return;

              // If browser pane already exists, remove it (toggle off)
              const existing = findAllBrowserPanes(tab.layout);
              if (existing.length > 0) {
                let newLayout: import("../types").PaneLayout | null = tab.layout;
                for (const bp of existing) {
                  if (!newLayout) break;
                  newLayout = removePane(newLayout, bp.id);
                }
                store.updateTabLayout(tab.id, newLayout);
                return;
              }

              // Otherwise open a new browser preview. Bind it to this tab so
              // it tracks the live dev-server URL and shows a "Waiting for
              // dev server" state if the port isn't ready yet — avoids the
              // "can't reach page" race when the server is still starting.
              const ds = store.devServers.find((s) => s.tabId === tab.id && s.port > 0);
              const url = ds ? `http://localhost:${ds.port}` : "about:blank";
              if (store.browserFullColumn) {
                const { layout } = store.browserSpawnLeft
                  ? addBrowserPaneLeft(tab.layout, url, 35, tab.id)
                  : addBrowserPaneRight(tab.layout, url, 35, tab.id);
                store.updateTabLayout(tab.id, layout);
              } else {
                const newPane = { type: "browser" as const, id: generatePaneId(), url, linkedTabId: tab.id };
                const newLayout = addPaneAsGrid(tab.layout, newPane, store.wideGridLayout);
                store.updateTabLayout(tab.id, newLayout);
              }
            }}
            data-tooltip="Browser Preview"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              alignSelf: "center",
              width: 34,
              height: 26,
              cursor: "pointer",
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
              backgroundColor: "transparent",
              transition: "background-color 120ms ease",
            }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-surface)"}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
          >
            {(() => {
              const tab = tabs.find((t) => t.id === activeTabId);
              const hasBrowser = tab && tab.layout ? findAllBrowserPanes(tab.layout).length > 0 : false;
              return hasBrowser
                ? <TbBrowserMinus size={14} color="var(--ezy-text-muted)" style={{ transform: "scale(1.2)" }} />
                : <TbBrowserPlus size={14} color="var(--ezy-text-muted)" style={{ transform: "scale(1.2)" }} />;
            })()}
          </div>
        )}

        {/* Mini Games — only for project tabs */}
        {showMiniGamesButton && (() => {
          const at = tabs.find((t) => t.id === activeTabId);
          return at && !at.isDevServerTab && !at.isServersTab && !at.isKanbanTab && !at.isSettingsTab;
        })() && (
          <div
            onClick={() => {
              window.dispatchEvent(new CustomEvent("made:open-game"));
            }}
            data-tooltip="Mini Games"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              alignSelf: "center",
              width: 34,
              height: 26,
              cursor: "pointer",
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
              backgroundColor: "transparent",
              transition: "background-color 120ms ease",
            }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-surface)"}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
          >
            {(() => {
              const tab = tabs.find((t) => t.id === activeTabId);
              const hasGame = tab && tab.layout ? hasGamePane(tab.layout) : false;
              return <PiGameControllerDuotone size={14} color={hasGame ? "var(--ezy-accent)" : "var(--ezy-text-muted)"} style={{ transform: "scale(1.3)" }} />;
            })()}
          </div>
        )}


        {/* Separator before window controls */}
        <div style={{ width: 1, height: 16, backgroundColor: "var(--ezy-border-subtle)", alignSelf: "center", margin: "0 4px" }} />

        {/* Window controls (Warp style — subtle, integrated) */}
        <div style={{ display: "flex", alignItems: "stretch" }}>
          {/* Minimize */}
          <div
            onClick={async () => {
              const win = getCurrentWindow();
              if (await win.isMaximized()) {
                // Minimize directly without flashing the restored window,
                // then set restored state to normal so taskbar restore isn't maximized
                const { invoke } = await import("@tauri-apps/api/core");
                invoke("minimize_from_maximized").catch(() => win.minimize());
              } else {
                win.minimize();
              }
            }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 46,
              cursor: "pointer",
              transition: "background-color 120ms ease",
            }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.06)"}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
          >
            {/* Warp parity: 10px mark inset 1px in a 12px box. y=5.5 puts the
                1px stroke inside a single device row (y=5 straddled two rows
                and rendered at half brightness). */}
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <line x1="1" y1="5.5" x2="11" y2="5.5" stroke="var(--ezy-text-secondary)" strokeWidth="1" />
            </svg>
          </div>

          {/* Maximize / Restore */}
          <div
            onClick={async () => {
              const win = getCurrentWindow();
              if (await win.isMaximized()) {
                win.unmaximize();
              } else {
                win.maximize();
              }
            }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 46,
              cursor: "pointer",
              transition: "background-color 120ms ease",
            }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.06)"}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
          >
            {isMaximized ? (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--ezy-text-secondary)" strokeWidth="1">
                <rect x="1.5" y="3.5" width="7" height="7" />
                <polyline points="3.5,3.5 3.5,1.5 10.5,1.5 10.5,8.5 8.5,8.5" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--ezy-text-secondary)" strokeWidth="1">
                <rect x="1.5" y="1.5" width="9" height="9" />
              </svg>
            )}
          </div>

          {/* Close */}
          <div
            onClick={() => {
              if (confirmQuit) {
                setQuitDontShow(false);
                setShowQuitConfirm(true);
              } else {
                getCurrentWindow().close();
              }
            }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 46,
              cursor: "pointer",
              transition: "background-color 120ms ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = "#c42b1c";
              const svg = e.currentTarget.querySelector("svg");
              if (svg) svg.style.stroke = "#fff";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "transparent";
              const svg = e.currentTarget.querySelector("svg");
              if (svg) svg.style.stroke = "var(--ezy-text-secondary)";
            }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--ezy-text-secondary)" strokeWidth="1.2" strokeLinecap="round">
              <line x1="1.5" y1="1.5" x2="10.5" y2="10.5" />
              <line x1="10.5" y1="1.5" x2="1.5" y2="10.5" />
            </svg>
          </div>
        </div>
      </div>

      {/* Remote File Browser modal */}
      {browsingServer && (
        <RemoteFileBrowser
          server={browsingServer}
          onSelect={handleRemotePathSelected}
          onClose={() => setBrowsingServer(null)}
        />
      )}

      {/* Tab color picker (right-click menu) */}

      {/* Quit confirmation dialog */}
      {showQuitConfirm && (
        <div
          ref={quitConfirmRef}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0,0,0,0.55)",
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowQuitConfirm(false); }}
        >
          <div
            style={{
              backgroundColor: "var(--ezy-surface-raised)",
              border: "1px solid var(--ezy-border)",
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 10px)",
              boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
              padding: "24px 28px 20px",
              width: 320,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--ezy-text)" }}>
              Quit MADE?
            </div>
            <div style={{ fontSize: 13, color: "var(--ezy-text-secondary)", lineHeight: 1.5 }}>
              All running terminals will be closed.
            </div>
            {/* Don't show again */}
            <div
              style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginTop: 2 }}
              onClick={() => setQuitDontShow((v) => !v)}
            >
              <div
                style={{
                  width: 15,
                  height: 15,
                  borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
                  border: quitDontShow ? "none" : "1px solid var(--ezy-border-light)",
                  backgroundColor: quitDontShow ? "var(--ezy-accent)" : "transparent",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  transition: "background-color 120ms ease",
                }}
              >
                {quitDontShow && (
                  <FaCheck size={9} color="#fff" />
                )}
              </div>
              <span style={{ fontSize: 12, color: "var(--ezy-text-muted)" }}>Do not show again</span>
            </div>
            {/* Buttons */}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
              <div
                onClick={() => setShowQuitConfirm(false)}
                style={{
                  padding: "6px 16px",
                  fontSize: 12,
                  fontWeight: 500,
                  borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
                  cursor: "pointer",
                  border: "1px solid var(--ezy-border-light)",
                  color: "var(--ezy-text-secondary)",
                  backgroundColor: "transparent",
                  transition: "background-color 120ms ease",
                }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
              >
                Cancel
              </div>
              <div
                onClick={() => {
                  if (quitDontShow) setConfirmQuit(false);
                  setShowQuitConfirm(false);
                  getCurrentWindow().destroy();
                }}
                style={{
                  padding: "6px 16px",
                  fontSize: 12,
                  fontWeight: 500,
                  borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
                  cursor: "pointer",
                  border: "none",
                  color: "#fff",
                  backgroundColor: "#c42b1c",
                  transition: "background-color 120ms ease",
                }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "#a82318"}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "#c42b1c"}
              >
                Quit
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Create Project modal */}
      {showCreateProjectModal && (
        <CreateProjectModal
          onCreated={(name, dir, serverId) => {
            setShowCreateProjectModal(false);
            setPendingDir({ name, dir, serverId });
          }}
          onClose={() => setShowCreateProjectModal(false)}
        />
      )}

      {/* New Jira Project modal */}
      {showJiraProjectModal && (
        <JiraProjectModal onClose={() => setShowJiraProjectModal(false)} />
      )}

      {/* Delayed path tooltip (2s hover on tab) */}
      {/* Tab-path tooltip — overlay-rendered (useOverlayViewportPopup above). */}
    </>
  );
}
