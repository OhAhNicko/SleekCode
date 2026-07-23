import { useCallback, useState, useRef, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "../store";
import { spawnDevServer } from "../lib/spawn-dev-server";
import { buildLayoutFromTemplate, stampTerminalTypes, findAllTerminalIds, findAllBrowserPanes, addBrowserPaneRight, addBrowserPaneLeft, addPaneAsGrid, removePane, generatePaneId, findKanbanPaneId, addKanbanPane, cloneLayoutWithFreshIds, countLeafPanes, hasGamePane } from "../lib/layout-utils";
import { TERMINAL_CONFIGS } from "../lib/terminal-config";
import { PROJECT_COLOR_PRESETS, getProjectColor, autoAssignColor, type ProjectColorId, type RecentProject } from "../store/recentProjectsSlice";
import { isTerminalActive } from "../lib/terminal-activity";
import { isWindows, detectBackendForPath } from "../lib/platform";
import { startCustomWindowDrag, toggleMaximizeOnDoubleClick } from "../lib/window-chrome";
import { useModalWhen } from "../store/modalCoordinationSlice";
import { useOverlayMenu } from "../lib/useOverlayMenu";
import { useOverlayPopupAnchor } from "../native-term/useOverlayPopupAnchor";
import { useOverlayViewportPopup } from "../lib/useOverlayToast";
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
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const recentProjects = useAppStore((s) => s.recentProjects);
  const addRecentProject = useAppStore((s) => s.addRecentProject);
  const removeRecentProject = useAppStore((s) => s.removeRecentProject);
  const servers = useAppStore((s) => s.servers);
  const cliYolo = useAppStore((s) => s.cliYolo);
  const toggleProjectQuickOpen = useAppStore((s) => s.toggleProjectQuickOpen);
  const setProjectBackend = useAppStore((s) => s.setProjectBackend);
  const terminalBackend = useAppStore((s) => s.terminalBackend);
  const confirmQuit = useAppStore((s) => s.confirmQuit);
  const setConfirmQuit = useAppStore((s) => s.setConfirmQuit);
  const showMiniGamesButton = useAppStore((s) => s.showMiniGamesButton ?? false);
  const showKanbanButton = useAppStore((s) => s.showKanbanButton ?? true);
  const devServers = useAppStore((s) => s.devServers);
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
  const projectsDir = useAppStore((s) => s.projectsDir);
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [colorPickerTab, setColorPickerTab] = useState<{ tabId: string; x: number; y: number } | null>(null);
  // Tab color picker — overlay-rendered (kind "swatch-menu", backdrop).
  const colorPickerDir = (() => {
    if (!colorPickerTab) return null;
    const t = tabs.find((tb) => tb.id === colorPickerTab.tabId);
    return t ? t.workingDir.replace(/\\/g, "/") : null;
  })();
  useOverlayViewportPopup({
    id: "tabbar-color-picker",
    kind: "swatch-menu",
    open: !!colorPickerTab && colorPickerDir != null,
    payload:
      colorPickerTab && colorPickerDir != null
        ? {
            x: colorPickerTab.x,
            y: colorPickerTab.y,
            title: "TAB COLOR",
            selected: projectColors[colorPickerDir] ?? null,
            swatches: PROJECT_COLOR_PRESETS.map((p) => ({
              id: p.id,
              label: p.label,
              color: p.color,
            })),
          }
        : null,
    onAction: (action) => {
      if (action === "__dismiss__") {
        setColorPickerTab(null);
        return;
      }
      if (colorPickerDir == null) return;
      if (action === "color:none") setProjectColor(colorPickerDir, null);
      else if (action.startsWith("color:"))
        setProjectColor(colorPickerDir, action.slice(6) as ProjectColorId);
      setColorPickerTab(null);
    },
  });
  const quitConfirmRef = useRef<HTMLDivElement>(null);
  const tabsContainerRef = useRef<HTMLDivElement>(null);

  // Hole-cut publishers: each floating overlay publishes its viewport rect so
  // the native HWND underneath cuts a hole. Refs are conditionally attached
  // (only when the overlay is rendered); useOverlayPublisher's rAF loop
  // tolerates null refs and re-reads each frame.
  const newTabChevronRef = useRef<HTMLDivElement>(null);
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
          sections: [
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
    onAction: (actionId) => {
      const [verb, type] = actionId.split(":");
      if (verb === "split") {
        window.dispatchEvent(
          new CustomEvent("made:split-terminal", { detail: { type } }),
        );
      } else if (verb === "split-down") {
        window.dispatchEvent(
          new CustomEvent("made:split-terminal", {
            detail: { type, direction: "vertical" },
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

  // Delayed path tooltip (2s hover)
  const [pathTooltip, setPathTooltip] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const pathTooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tab-path hover tooltip — overlay-rendered (kind "tooltip", display-only).
  const pathTooltipTab = pathTooltip
    ? tabs.find((t) => t.id === pathTooltip.tabId)
    : null;
  useOverlayViewportPopup({
    id: "tabbar-path-tooltip",
    kind: "tooltip",
    open: !!pathTooltip && !!pathTooltipTab?.workingDir,
    payload:
      pathTooltip && pathTooltipTab?.workingDir
        ? { x: pathTooltip.x, y: pathTooltip.y, text: pathTooltipTab.workingDir }
        : null,
  });
  const clearPathTooltip = useCallback(() => {
    if (pathTooltipTimer.current) { clearTimeout(pathTooltipTimer.current); pathTooltipTimer.current = null; }
    setPathTooltip(null);
  }, []);

  const anyMenuOpen = showNewTabMenu || showRecentMenu;
  const closeAllMenus = useCallback(() => {
    setShowNewTabMenu(false);
    setShowRecentMenu(false);
    setColorPickerTab(null);
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
            const canQuickOpen = hasSavedLayout && !!project.quickOpen;
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
              showFresh: canQuickOpen,
              showQuick: hasSavedLayout,
              quickOn: !!project.quickOpen,
              paneCount: String(savedPaneCount ?? "?"),
              backendLabel: backend ?? undefined,
            };
          }),
          canCreate: !!projectsDir,
          servers: servers.map((sv) => ({ id: sv.id, name: sv.name })),
        }
      : null,
    onAction: (action) => {
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
          if ((!!project.lastLayout || !!project.lastTemplate) && project.quickOpen) {
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
        {/* Sidebar toggle (Warp-style) */}
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

        {/* Dev Servers icon button */}
        {(() => {
          const isDevActive = devServerPanelOpen;
          const runningCount = devServers.filter((s) => s.status === "running" || s.status === "starting").length;
          return (
            <div
              title="Dev Servers"
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
                  borderRadius: 6,
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
          title="Settings"
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
        <div ref={tabsContainerRef} style={{ display: "flex", alignItems: "stretch", minWidth: 0, overflow: "hidden" }}>
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
                  onContextMenu={(e) => {
                    if (isSystemTab) return;
                    e.preventDefault();
                    setColorPickerTab({ tabId: tab.id, x: e.clientX, y: e.clientY });
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
                    minWidth: 0,
                    maxWidth: 200,
                    height: "100%",
                    borderRight: "1px solid var(--ezy-border-subtle)",
                    borderBottom: tabColor ? `2px solid ${tabColor}` : "2px solid transparent",
                    userSelect: "none",
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.03)";
                      e.currentTarget.style.color = "var(--ezy-text-secondary)";
                    }
                    // Delayed path tooltip (2s)
                    if (tab.workingDir) {
                      clearPathTooltip();
                      const rect = e.currentTarget.getBoundingClientRect();
                      const tid = tab.id;
                      pathTooltipTimer.current = setTimeout(() => {
                        setPathTooltip({ tabId: tid, x: rect.left + rect.width / 2, y: rect.bottom + 4 });
                      }, 2000);
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.backgroundColor = "transparent";
                      e.currentTarget.style.color = "var(--ezy-text-muted)";
                    }
                    clearPathTooltip();
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
                                borderRadius: 3,
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
                          {cliCount > 1 && (
                            <span
                              style={{
                                fontSize: 9,
                                fontWeight: 600,
                                lineHeight: 1,
                                padding: "1px 4px",
                                borderRadius: 4,
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
                                  borderRadius: 6,
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
                borderRadius: 4,
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
                    <span style={{ fontSize: 9, fontWeight: 600, lineHeight: 1, padding: "1px 4px", borderRadius: 4, position: "relative" as const, top: 1, backgroundColor: "var(--ezy-surface-raised)", border: "1px solid var(--ezy-border)", color: "var(--ezy-text-secondary)" }}>
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
              if (!showRecentMenu) e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
            }}
            onMouseLeave={(e) => {
              if (!showRecentMenu) e.currentTarget.style.backgroundColor = "transparent";
            }}
          >
            <FaPlus size={13} color={showRecentMenu ? "var(--ezy-text)" : "var(--ezy-text-muted)"} />
          </div>

          {/* Recent Projects dropdown */}
          {/* Recent-projects menu — overlay-rendered (kind "recent-menu", hook above). */}

          {/* Chevron — opens dropdown menu (only when a project is open) */}
          {tabs.some(t => !t.isKanbanTab && !t.isDevServerTab && !t.isServersTab && !t.isSettingsTab) && <><div
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
              if (!showNewTabMenu) e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
            }}
            onMouseLeave={(e) => {
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
            title="Tasks"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              alignSelf: "center",
              width: 34,
              height: 26,
              cursor: "pointer",
              borderRadius: 4,
              backgroundColor: "transparent",
              transition: "background-color 120ms ease",
            }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-surface)"}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
          >
            <PiKanbanDuotone size={14} color="var(--ezy-text-muted)" style={{ transform: "scale(1.5)" }} />
          </div>
        )}

        {/* Browser Preview — only for project tabs */}
        {(() => {
          const at = tabs.find((t) => t.id === activeTabId);
          return at && !at.isDevServerTab && !at.isServersTab && !at.isKanbanTab && !at.isSettingsTab;
        })() && (
          <div
            onClick={() => {
              const store = useAppStore.getState();
              const tab = store.tabs.find((t) => t.id === store.activeTabId);
              if (!tab || !tab.layout || tab.isDevServerTab || tab.isServersTab || tab.isKanbanTab || tab.isSettingsTab) return;

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
            title="Browser Preview"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              alignSelf: "center",
              width: 34,
              height: 26,
              cursor: "pointer",
              borderRadius: 4,
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
            title="Mini Games"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              alignSelf: "center",
              width: 34,
              height: 26,
              cursor: "pointer",
              borderRadius: 4,
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
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <line x1="1" y1="5" x2="9" y2="5" stroke="var(--ezy-text-muted)" strokeWidth="1" />
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
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1">
                <rect x="0.5" y="2.5" width="7" height="7" />
                <polyline points="2.5,2.5 2.5,0.5 9.5,0.5 9.5,7.5 7.5,7.5" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1">
                <rect x="1" y="1" width="8" height="8" />
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
              if (svg) svg.style.stroke = "var(--ezy-text-muted)";
            }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.2" strokeLinecap="round">
              <line x1="1" y1="1" x2="9" y2="9" />
              <line x1="9" y1="1" x2="1" y2="9" />
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
      {/* Color picker — overlay-rendered (useOverlayViewportPopup above). */}

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
              borderRadius: 10,
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
                  borderRadius: 3,
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
                  borderRadius: 6,
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
                  borderRadius: 6,
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
          onCreated={(name, dir) => {
            setShowCreateProjectModal(false);
            setPendingDir({ name, dir });
          }}
          onClose={() => setShowCreateProjectModal(false)}
        />
      )}

      {/* Delayed path tooltip (2s hover on tab) */}
      {/* Tab-path tooltip — overlay-rendered (useOverlayViewportPopup above). */}
    </>
  );
}
