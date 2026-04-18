import { useCallback, useState, useRef, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "../store";
import { buildLayoutFromTemplate, stampTerminalTypes, findAllTerminalIds, findAllBrowserPanes, addBrowserPaneRight, addBrowserPaneLeft, addPaneAsGrid, removePane, generatePaneId, generateTerminalId, findKanbanPaneId, addKanbanPane, cloneLayoutWithFreshIds, countLeafPanes, hasGamePane } from "../lib/layout-utils";
import { TERMINAL_CONFIGS } from "../lib/terminal-config";
import { PROJECT_COLOR_PRESETS, getProjectColor, autoAssignColor, type ProjectColorId, type RecentProject } from "../store/recentProjectsSlice";
import { isTerminalActive } from "../lib/terminal-activity";
import type { RemoteServer, TerminalType } from "../types";
import type { WorkspaceTemplate } from "../lib/workspace-templates";
import RemoteFileBrowser from "./RemoteFileBrowser";
import TemplatePicker, { type ExtraPaneType } from "./TemplatePicker";
import CreateProjectModal from "./CreateProjectModal";
import ClipboardImageStrip from "./ClipboardImageStrip";
import GitStatusBar from "./GitStatusBar";
import { FaFolder, FaChevronDown, FaCheck } from "react-icons/fa";
import { TbBrowserPlus, TbBrowserMinus } from "react-icons/tb";
import { FaXmark, FaPlus, FaBolt, FaGear, FaServer, FaArrowsRotate } from "react-icons/fa6";
import { PiKanbanDuotone, PiGameControllerDuotone } from "react-icons/pi";
import { AiOutlinePushpin, AiFillPushpin } from "react-icons/ai";
import { BiSidebar, BiExpandVertical } from "react-icons/bi";

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
  const cliYolo = useAppStore((s) => s.cliYolo);
  const toggleProjectQuickOpen = useAppStore((s) => s.toggleProjectQuickOpen);
  const confirmQuit = useAppStore((s) => s.confirmQuit);
  const setConfirmQuit = useAppStore((s) => s.setConfirmQuit);
  const showMiniGamesButton = useAppStore((s) => s.showMiniGamesButton ?? false);
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
  const [pendingDir, setPendingDir] = useState<{ name: string; dir: string; serverId?: string } | null>(null);
  const [showCreateProjectModal, setShowCreateProjectModal] = useState(false);
  const projectsDir = useAppStore((s) => s.projectsDir);
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [colorPickerTab, setColorPickerTab] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const recentMenuRef = useRef<HTMLDivElement>(null);
  const tabsContainerRef = useRef<HTMLDivElement>(null);
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

  const handleNewLocalTab = useCallback(async () => {
    setShowNewTabMenu(false);
    try {
      const selected = await open({
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
  }, []);

  const handleRemotePathSelected = useCallback((remotePath: string) => {
    if (!browsingServer) return;
    const name = remotePath.split("/").filter(Boolean).pop() || browsingServer.name;
    setBrowsingServer(null);
    setPendingDir({ name, dir: remotePath, serverId: browsingServer.id });
  }, [browsingServer]);

  const addTerminal = useAppStore((s) => s.addTerminal);
  const addDevServer = useAppStore((s) => s.addDevServer);
  const autoStartServerCommand = useAppStore((s) => s.autoStartServerCommand);

  const spawnDevServer = useCallback(
    (tabId: string, tabName: string, workingDir: string, command: string) => {
      // Skip if a dev server already exists for the same project directory
      const norm = (p: string) => p.replace(/\\/g, "/");
      const existing = useAppStore.getState().devServers.find(
        (ds) => norm(ds.workingDir) === norm(workingDir)
      );
      if (existing) return existing.terminalId;

      const terminalId = generateTerminalId();
      addTerminal(terminalId, "devserver", workingDir);
      addDevServer({
        id: `ds-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        terminalId,
        tabId,
        projectName: tabName,
        command,
        workingDir,
        port: 0,
        status: "running",
      });
      // Persist server command on the tab for session restore
      useAppStore.setState((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tabId ? { ...t, serverCommand: command } : t
        ),
      }));
      return terminalId;
    },
    [addTerminal, addDevServer]
  );

  const handleTemplateSelected = useCallback(
    (template: WorkspaceTemplate, slotTypes: TerminalType[], serverCommand?: string, extraPanes?: ExtraPaneType[], noDevServer?: boolean) => {
      if (!pendingDir) return;
      const { layout, terminalIds } = buildLayoutFromTemplate(
        template.id,
        template.cols,
        template.rows,
        template.paneCount
      );

      // Stamp terminal types into layout tree for session restore
      const typedLayout = stampTerminalTypes(layout, terminalIds, slotTypes);

      // Append extra panes (code review, browser, etc.) as horizontal splits
      let finalLayout: import("../types").PaneLayout = typedLayout;
      if (extraPanes && extraPanes.length > 0) {
        for (const extra of extraPanes) {
          // Kanban uses smart placement (bottom or right depending on row count)
          if (extra === "kanban") {
            const kanbanLayout = addKanbanPane(finalLayout);
            if (kanbanLayout) finalLayout = kanbanLayout;
            continue;
          }

          let extraNode: import("../types").PaneLayout;
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
          // Wrap current layout + extra pane in a horizontal split (or add to grid)
          const { browserFullColumn: fullCol, browserSpawnLeft: spawnLeft, wideGridLayout } = useAppStore.getState();
          if (fullCol) {
            finalLayout = {
              type: "split" as const,
              id: generatePaneId(),
              direction: "horizontal" as const,
              children: (spawnLeft
                ? [extraNode, finalLayout]
                : [finalLayout, extraNode]) as [import("../types").PaneLayout, import("../types").PaneLayout],
              sizes: (spawnLeft ? [30, 70] : [70, 30]) as [number, number],
            };
          } else {
            finalLayout = addPaneAsGrid(finalLayout, extraNode, wideGridLayout);
          }
        }
      }

      // Batch-create all terminals
      const batch = terminalIds.map((id, i) => ({
        id,
        type: slotTypes[i] ?? ("shell" as TerminalType),
        workingDir: pendingDir.dir,
        serverId: pendingDir.serverId,
      }));
      addTerminals(batch);
      const tabId = addTabWithLayout(pendingDir.name, pendingDir.dir, finalLayout, pendingDir.serverId);
      if (!pendingDir.serverId) {
        addRecentProject({
          path: pendingDir.dir,
          name: pendingDir.name,
          template: { templateId: template.id, cols: template.cols, rows: template.rows, paneCount: template.paneCount, slotTypes },
          serverCommand,
          noDevServer,
        });
      }
      // Auto-start server command if provided and enabled
      if (serverCommand && autoStartServerCommand) {
        spawnDevServer(tabId, pendingDir.name, pendingDir.dir, serverCommand);
      }
      setPendingDir(null);
    },
    [pendingDir, addTerminals, addTabWithLayout, addRecentProject, autoStartServerCommand, spawnDevServer]
  );

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
        }));
        addTerminals(batch);
        const tabId = addTabWithLayout(project.name, project.path, layout);
        addRecentProject({ path: project.path, name: project.name, template: project.lastTemplate });
        if (project.serverCommand && autoStartServerCommand && !project.noDevServer) {
          spawnDevServer(tabId, project.name, project.path, project.serverCommand);
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
        }));
        addTerminals(batch);
        const tabId = addTabWithLayout(project.name, project.path, typedLayout);
        addRecentProject({ path: project.path, name: project.name, template: project.lastTemplate });
        if (project.serverCommand && autoStartServerCommand && !project.noDevServer) {
          spawnDevServer(tabId, project.name, project.path, project.serverCommand);
        }
      }
    },
    [addTerminals, addTabWithLayout, addRecentProject, autoStartServerCommand, spawnDevServer]
  );

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

  // Listen for Ctrl+Shift+T event from App.tsx
  useEffect(() => {
    const handler = () => handleNewLocalTab();
    window.addEventListener("ezydev:new-tab", handler);
    return () => window.removeEventListener("ezydev:new-tab", handler);
  }, [handleNewLocalTab]);

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
    window.addEventListener("ezydev:open-recent", handler);
    return () => window.removeEventListener("ezydev:open-recent", handler);
  }, [recentProjects, quickOpenProject]);

  // Listen for OS-level quit request (Alt+F4 etc.) intercepted in App.tsx
  useEffect(() => {
    const handler = () => {
      setQuitDontShow(false);
      setShowQuitConfirm(true);
    };
    window.addEventListener("ezydev:quit-requested", handler);
    return () => window.removeEventListener("ezydev:quit-requested", handler);
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
              if (recentProjects.length > 0 || projectsDir) {
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
          {showRecentMenu && (
            <div
              ref={recentMenuRef}
              className="dropdown-enter"
              style={{
                position: "absolute",
                top: "100%",
                left: 0,
                marginTop: 2,
                width: 300,
                backgroundColor: "var(--ezy-surface-raised)",
                border: "1px solid var(--ezy-border)",
                borderRadius: 8,
                overflow: "hidden",
                boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
                zIndex: 100,
              }}
            >
              <div
                style={{
                  padding: "6px 12px",
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "var(--ezy-text-muted)",
                  borderBottom: "1px solid var(--ezy-border)",
                }}
              >
                Recent Projects
              </div>
              {recentProjects.map((project) => {
                const hasSavedLayout = !!project.lastLayout || !!project.lastTemplate;
                const canQuickOpen = hasSavedLayout && !!project.quickOpen;
                const savedPaneCount = project.lastLayout ? countLeafPanes(project.lastLayout) : project.lastTemplate?.paneCount;
                return (
                <div
                  key={project.id}
                  className="group"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "7px 12px",
                    cursor: "pointer",
                    fontSize: 13,
                    color: "var(--ezy-text-secondary)",
                    position: "relative",
                  }}
                  title={project.path}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                  onClick={() => {
                    setShowRecentMenu(false);
                    if (canQuickOpen) {
                      quickOpenProject(project, false);
                    } else {
                      setPendingDir({ name: project.name, dir: project.path });
                    }
                  }}
                >
                  {/* Folder icon */}
                  <FaFolder size={14} color="var(--ezy-text-muted)" style={{ flexShrink: 0 }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 500, color: "var(--ezy-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {project.name}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--ezy-text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {truncatePath(project.path)}
                    </div>
                  </div>
                  {/* Quick-open toggle — only shown when a saved layout/template exists */}
                  {hasSavedLayout && (
                    <>
                      {/* Start Fresh — same layout, new sessions */}
                      {canQuickOpen && (
                        <button
                          title="Start fresh — same layout, new sessions"
                          style={{
                            flexShrink: 0,
                            display: "flex",
                            alignItems: "center",
                            padding: "2px 4px",
                            border: "1px solid var(--ezy-border)",
                            borderRadius: 4,
                            backgroundColor: "transparent",
                            color: "var(--ezy-text-muted)",
                            fontSize: 10,
                            cursor: "pointer",
                            lineHeight: 1,
                            transition: "all 120ms ease",
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowRecentMenu(false);
                            quickOpenProject(project, true);
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--ezy-text-muted)"; e.currentTarget.style.color = "var(--ezy-text)"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--ezy-border)"; e.currentTarget.style.color = "var(--ezy-text-muted)"; }}
                        >
                          <FaArrowsRotate size={9} />
                        </button>
                      )}
                      {/* Quick-open toggle */}
                      <button
                        title={project.quickOpen
                          ? `Quick open ON (${savedPaneCount ?? "?"} panes) — click to disable`
                          : `Quick open OFF — click to enable (reuse last ${savedPaneCount ?? "?"}-pane layout)`}
                        style={{
                          flexShrink: 0,
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          padding: "2px 6px",
                          border: "1px solid",
                          borderColor: project.quickOpen ? "var(--ezy-accent, #10b981)" : "var(--ezy-border)",
                          borderRadius: 4,
                          backgroundColor: project.quickOpen ? "var(--ezy-accent-glow, rgba(16,185,129,0.12))" : "transparent",
                          color: project.quickOpen ? "var(--ezy-accent, #10b981)" : "var(--ezy-text-muted)",
                          fontSize: 10,
                          fontWeight: 600,
                          cursor: "pointer",
                          lineHeight: 1,
                          whiteSpace: "nowrap",
                          transition: "all 120ms ease",
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleProjectQuickOpen(project.path);
                        }}
                      >
                        <FaBolt size={10} color="currentColor" />
                        {savedPaneCount ?? "?"}
                      </button>
                    </>
                  )}
                  {/* Remove button */}
                  <FaXmark
                    size={14}
                    color="var(--ezy-text-muted)"
                    className="opacity-0 group-hover:opacity-50 hover:!opacity-100"
                    style={{ flexShrink: 0, cursor: "pointer", transition: "opacity 120ms ease" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeRecentProject(project.path);
                    }}
                  />
                </div>
                );
              })}
              {/* Divider + Create / Browse */}
              <div style={{ height: 1, backgroundColor: "var(--ezy-border)", margin: "2px 0" }} />
              <button
                disabled={!projectsDir}
                title={!projectsDir ? "Set a projects directory in Settings first" : "Create a new project folder"}
                className="w-full text-left"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 12px",
                  backgroundColor: "transparent",
                  border: "none",
                  cursor: !projectsDir ? "not-allowed" : "pointer",
                  fontSize: 13,
                  color: !projectsDir ? "var(--ezy-text-muted)" : "var(--ezy-text-secondary)",
                  fontFamily: "inherit",
                  opacity: !projectsDir ? 0.45 : 1,
                }}
                onMouseEnter={(e) => { if (projectsDir) e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
                onClick={() => {
                  if (!projectsDir) return;
                  setShowRecentMenu(false);
                  setShowCreateProjectModal(true);
                }}
              >
                <FaFolder size={14} color={!projectsDir ? "var(--ezy-text-muted)" : "var(--ezy-text-muted)"} />
                Create New Project
              </button>
              <button
                className="w-full text-left"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 12px",
                  backgroundColor: "transparent",
                  border: "none",
                  cursor: "pointer",
                  fontSize: 13,
                  color: "var(--ezy-text-secondary)",
                  fontFamily: "inherit",
                }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                onClick={() => {
                  setShowRecentMenu(false);
                  handleNewLocalTab();
                }}
              >
                <FaPlus size={14} color="var(--ezy-text-muted)" />
                Browse for Folder...
              </button>
            </div>
          )}

          {/* Chevron — opens dropdown menu (only when a project is open) */}
          {tabs.some(t => !t.isKanbanTab && !t.isDevServerTab && !t.isServersTab && !t.isSettingsTab) && <><div
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

          {showNewTabMenu && (
            <div
              ref={menuRef}
              className="dropdown-enter"
              style={{
                position: "absolute",
                top: "100%",
                left: 0,
                marginTop: 2,
                width: 220,
                backgroundColor: "var(--ezy-surface-raised)",
                border: "1px solid var(--ezy-border)",
                borderRadius: 8,
                overflow: "hidden",
                boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
                zIndex: 100,
              }}
            >
              <div
                style={{
                  padding: "6px 12px 4px",
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "var(--ezy-text-muted)",
                }}
              >
                Add pane
              </div>
              {/* Claude Code */}
              {[
                { type: "claude" as const, icon: (
                  <svg width="14" height="14" viewBox="0 0 24 24">
                    <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" fill="#D97757" />
                  </svg>
                )},
                { type: "codex" as const, icon: (
                  <svg width="14" height="14" viewBox="0 0 24 24">
                    <path d="M22.282 9.821a6 6 0 0 0-.516-4.91 6.05 6.05 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a6 6 0 0 0-3.998 2.9 6.05 6.05 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.05 6.05 0 0 0 6.515 2.9A6 6 0 0 0 13.26 24a6.06 6.06 0 0 0 5.772-4.206 6 6 0 0 0 3.997-2.9 6.06 6.06 0 0 0-.747-7.073M13.26 22.43a4.48 4.48 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.8.8 0 0 0 .392-.681v-6.737l2.02 1.168a.07.07 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494M3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.77.77 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646M2.34 7.896a4.5 4.5 0 0 1 2.366-1.973V11.6a.77.77 0 0 0 .388.677l5.815 3.354-2.02 1.168a.08.08 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.08.08 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667m2.01-3.023l-.141-.085-4.774-2.782a.78.78 0 0 0-.785 0L9.409 9.23V6.897a.07.07 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.8.8 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5Z" fill="#10a37f" />
                  </svg>
                )},
                { type: "gemini" as const, icon: (
                  <svg width="14" height="14" viewBox="0 0 24 24">
                    <path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" fill="#8E75B2" />
                  </svg>
                )},
                { type: "shell" as const, icon: (
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="4,4 8,8 4,12" />
                    <line x1="9" y1="12" x2="13" y2="12" />
                  </svg>
                )},
              ].map(({ type, icon }) => (
                <div
                  key={type}
                  className="flex items-center"
                  style={{ padding: "0 0 0 0" }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                >
                  <button
                    className="text-left"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "7px 12px",
                      flex: 1,
                      backgroundColor: "transparent",
                      border: "none",
                      cursor: "pointer",
                      fontSize: 13,
                      color: "var(--ezy-text-secondary)",
                      fontFamily: "inherit",
                    }}
                    onClick={() => {
                      setShowNewTabMenu(false);
                      window.dispatchEvent(new CustomEvent("ezydev:split-terminal", { detail: { type } }));
                    }}
                  >
                    {icon}
                    {TERMINAL_CONFIGS[type].label}
                    {!!cliYolo[type] && (
                      <span
                        style={{
                          fontSize: 9,
                          fontWeight: 700,
                          letterSpacing: "0.06em",
                          lineHeight: 1,
                          padding: "1px 4px",
                          borderRadius: 3,
                          backgroundColor: "var(--ezy-red, #e55)",
                          color: "#fff",
                          marginLeft: "auto",
                        }}
                      >
                        YOLO
                      </span>
                    )}
                  </button>
                  {/* Split Down */}
                  <div
                    title="Split Down"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 28,
                      height: 28,
                      cursor: "pointer",
                      borderRadius: 4,
                      flexShrink: 0,
                      marginRight: 4,
                    }}
                    onMouseEnter={(e) => { e.stopPropagation(); e.currentTarget.style.backgroundColor = "var(--ezy-border)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowNewTabMenu(false);
                      window.dispatchEvent(new CustomEvent("ezydev:split-terminal", { detail: { type, direction: "vertical" } }));
                    }}
                  >
                    <BiExpandVertical size={12} color="var(--ezy-text-muted)" />
                  </div>
                </div>
              ))}
            </div>
          )}
          </>}
        </div>

        {/* Spacer — draggable region (disable drag when menu open so clicks close menus) */}
        <div
          className="flex-1"
          {...(!anyMenuOpen ? { "data-tauri-drag-region": true } : {})}
          onMouseDown={anyMenuOpen ? closeAllMenus : undefined}
          style={anyMenuOpen ? { cursor: "default" } : undefined}
        />

        {/* Git Status Bar — only for project tabs with workingDir */}
        {(() => {
          const at = tabs.find((t) => t.id === activeTabId);
          return at && at.workingDir && !at.isDevServerTab && !at.isServersTab && !at.isKanbanTab && !at.isSettingsTab;
        })() && (
          <GitStatusBar workingDir={tabs.find((t) => t.id === activeTabId)!.workingDir!} />
        )}

        {/* Clipboard image thumbnails */}
        <ClipboardImageStrip />

        {/* Tasks */}
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

              // Otherwise open a new browser preview
              const ds = store.devServers.find((s) => s.tabId === tab.id && s.port > 0);
              const url = ds ? `http://localhost:${ds.port}` : "http://localhost:3000";
              if (store.browserFullColumn) {
                const { layout } = store.browserSpawnLeft
                  ? addBrowserPaneLeft(tab.layout, url, 35)
                  : addBrowserPaneRight(tab.layout, url, 35);
                store.updateTabLayout(tab.id, layout);
              } else {
                const newPane = { type: "browser" as const, id: generatePaneId(), url };
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
              window.dispatchEvent(new CustomEvent("ezydev:open-game"));
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
      {colorPickerTab && (() => {
        const pickerTab = tabs.find((t) => t.id === colorPickerTab.tabId);
        if (!pickerTab) return null;
        const pickerDir = pickerTab.workingDir.replace(/\\/g, "/");
        const currentColorId = projectColors[pickerDir] ?? null;
        return (
          <>
            <div style={{ position: "fixed", inset: 0, zIndex: 299 }} onMouseDown={() => setColorPickerTab(null)} />
            <div
              className="dropdown-enter"
              style={{
                position: "fixed",
                left: colorPickerTab.x,
                top: colorPickerTab.y,
                zIndex: 300,
                backgroundColor: "var(--ezy-surface-raised)",
                border: "1px solid var(--ezy-border)",
                borderRadius: 8,
                padding: 8,
                boxShadow: "0 12px 36px rgba(0,0,0,0.5)",
              }}
            >
              <div style={{ fontSize: 10, color: "var(--ezy-text-muted)", marginBottom: 6, fontWeight: 500, letterSpacing: "0.04em" }}>
                TAB COLOR
              </div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", maxWidth: 140 }}>
                {/* None swatch */}
                <div
                  title="None"
                  onClick={() => { setProjectColor(pickerDir, null); setColorPickerTab(null); }}
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 4,
                    backgroundColor: "var(--ezy-surface)",
                    border: currentColorId === null ? "2px solid var(--ezy-text)" : "1px solid var(--ezy-border)",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 10,
                    color: "var(--ezy-text-muted)",
                  }}
                >
                  ×
                </div>
                {PROJECT_COLOR_PRESETS.map((preset) => (
                  <div
                    key={preset.id}
                    title={preset.label}
                    onClick={() => { setProjectColor(pickerDir, preset.id); setColorPickerTab(null); }}
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 4,
                      backgroundColor: preset.color,
                      border: currentColorId === preset.id ? "2px solid #fff" : "1px solid transparent",
                      cursor: "pointer",
                    }}
                  />
                ))}
              </div>
            </div>
          </>
        );
      })()}

      {/* Quit confirmation dialog */}
      {showQuitConfirm && (
        <div
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
              Quit EzyDev?
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

      {/* Template Picker modal */}
      {pendingDir && (
        <TemplatePicker
          onSelect={handleTemplateSelected}
          onClose={() => setPendingDir(null)}
          initialServerCommand={
            recentProjects.find(
              (p) => p.path.replace(/\\/g, "/") === pendingDir.dir.replace(/\\/g, "/")
            )?.serverCommand
          }
          initialNoDevServer={
            recentProjects.find(
              (p) => p.path.replace(/\\/g, "/") === pendingDir.dir.replace(/\\/g, "/")
            )?.noDevServer
          }
        />
      )}

      {/* Delayed path tooltip (2s hover on tab) */}
      {pathTooltip && (() => {
        const tt = tabs.find((t) => t.id === pathTooltip.tabId);
        if (!tt?.workingDir) return null;
        return (
          <div
            style={{
              position: "fixed",
              left: pathTooltip.x,
              top: pathTooltip.y,
              transform: "translateX(-50%)",
              zIndex: 400,
              backgroundColor: "var(--ezy-surface-raised)",
              border: "1px solid var(--ezy-border)",
              borderRadius: 6,
              padding: "4px 8px",
              fontSize: 11,
              color: "var(--ezy-text-secondary)",
              whiteSpace: "nowrap",
              pointerEvents: "none",
              boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
            }}
          >
            {tt.workingDir}
          </div>
        );
      })()}
    </>
  );
}
