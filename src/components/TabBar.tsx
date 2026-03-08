import { useCallback, useState, useRef, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "../store";
import { THEMES, getTheme } from "../lib/themes";
import { buildLayoutFromTemplate, stampTerminalTypes, findAllTerminalIds, findAllBrowserPanes, addBrowserPaneRight, removePane, generatePaneId, generateTerminalId, findKanbanPaneId, addKanbanPane } from "../lib/layout-utils";
import { TERMINAL_CONFIGS } from "../lib/terminal-config";
import { DEFAULT_CLI_FONT_SIZE } from "../store/recentProjectsSlice";
import { isTerminalActive } from "../lib/terminal-activity";
import type { RemoteServer, TerminalType } from "../types";
import type { WorkspaceTemplate } from "../lib/workspace-templates";
import RemoteFileBrowser from "./RemoteFileBrowser";
import TemplatePicker, { type ExtraPaneType } from "./TemplatePicker";
import ClipboardImageStrip from "./ClipboardImageStrip";

export default function TabBar() {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const addTabWithLayout = useAppStore((s) => s.addTabWithLayout);
  const addTerminals = useAppStore((s) => s.addTerminals);
  const removeTab = useAppStore((s) => s.removeTab);
  const togglePinTab = useAppStore((s) => s.togglePinTab);
  const themeId = useAppStore((s) => s.themeId);
  const setTheme = useAppStore((s) => s.setTheme);
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const recentProjects = useAppStore((s) => s.recentProjects);
  const addRecentProject = useAppStore((s) => s.addRecentProject);
  const removeRecentProject = useAppStore((s) => s.removeRecentProject);
  const alwaysShowTemplatePicker = useAppStore((s) => s.alwaysShowTemplatePicker);
  const setAlwaysShowTemplatePicker = useAppStore((s) => s.setAlwaysShowTemplatePicker);
  const restoreLastSession = useAppStore((s) => s.restoreLastSession);
  const setRestoreLastSession = useAppStore((s) => s.setRestoreLastSession);
  const autoInsertClipboardImage = useAppStore((s) => s.autoInsertClipboardImage);
  const setAutoInsertClipboardImage = useAppStore((s) => s.setAutoInsertClipboardImage);
  const cliFontSizes = useAppStore((s) => s.cliFontSizes);
  const setCliFontSize = useAppStore((s) => s.setCliFontSize);
  const claudeYolo = useAppStore((s) => s.claudeYolo);
  const setClaudeYolo = useAppStore((s) => s.setClaudeYolo);
  const promptComposerEnabled = useAppStore((s) => s.promptComposerEnabled);
  const setPromptComposerEnabled = useAppStore((s) => s.setPromptComposerEnabled);
  const promptComposerAlwaysVisible = useAppStore((s) => s.promptComposerAlwaysVisible);
  const setPromptComposerAlwaysVisible = useAppStore((s) => s.setPromptComposerAlwaysVisible);
  const setAutoStartServerCommand = useAppStore((s) => s.setAutoStartServerCommand);
  const devServers = useAppStore((s) => s.devServers);

  const [isMaximized, setIsMaximized] = useState(false);
  const [showNewTabMenu, setShowNewTabMenu] = useState(false);
  const [showRecentMenu, setShowRecentMenu] = useState(false);
  const [browsingServer, setBrowsingServer] = useState<RemoteServer | null>(null);
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const [showServersTab, setShowServersTab] = useState(false);
  const [pendingDir, setPendingDir] = useState<{ name: string; dir: string; serverId?: string } | null>(null);
  const [expandedCli, setExpandedCli] = useState<Record<string, boolean>>({});
  const [themeExpanded, setThemeExpanded] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const recentMenuRef = useRef<HTMLDivElement>(null);
  const settingsMenuRef = useRef<HTMLDivElement>(null);

  // Poll terminal activity every 1s to update active pane counts
  const [activityTick, setActivityTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setActivityTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const anyMenuOpen = showNewTabMenu || showRecentMenu || showSettingsMenu;
  const closeAllMenus = useCallback(() => {
    setShowNewTabMenu(false);
    setShowRecentMenu(false);
    setShowSettingsMenu(false);
  }, []);

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
    (template: WorkspaceTemplate, slotTypes: TerminalType[], serverCommand?: string, extraPanes?: ExtraPaneType[]) => {
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
          // Wrap current layout + extra pane in a horizontal split
          // Give the terminal layout 70% and the extra pane 30%
          finalLayout = {
            type: "split" as const,
            id: generatePaneId(),
            direction: "horizontal" as const,
            children: [finalLayout, extraNode] as [import("../types").PaneLayout, import("../types").PaneLayout],
            sizes: [70, 30] as [number, number],
          };
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

  const theme = getTheme(themeId);

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
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.3" style={{ flexShrink: 0 }}>
          <rect x="2" y="3" width="12" height="10" rx="1.5" />
          <circle cx="5" cy="8" r="1" fill={color} stroke="none" />
          <line x1="8" y1="8" x2="12" y2="8" strokeLinecap="round" />
        </svg>
      );
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
          borderBottom: "1px solid var(--ezy-border-subtle)",
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
          onClick={() => { closeAllMenus(); toggleSidebar(); }}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-surface)"}
          onMouseLeave={(e) => {
            if (!sidebarOpen) e.currentTarget.style.backgroundColor = "transparent";
          }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={sidebarOpen ? "var(--ezy-accent)" : "var(--ezy-text-muted)"} strokeWidth="1.3" strokeLinecap="round">
            <rect x="1.5" y="2" width="13" height="12" rx="2" />
            <line x1="6" y1="2" x2="6" y2="14" />
          </svg>
        </div>

        {/* Dev Servers icon button */}
        {(() => {
          const isDevActive = activeTabId === "dev-server-tab";
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
                borderRight: "1px solid var(--ezy-border-subtle)",
              }}
              onClick={() => { closeAllMenus(); setActiveTab("dev-server-tab"); }}
              onMouseEnter={(e) => { if (!isDevActive) e.currentTarget.style.backgroundColor = "var(--ezy-surface)"; }}
              onMouseLeave={(e) => { if (!isDevActive) e.currentTarget.style.backgroundColor = "transparent"; }}
            >
              {/* Rocket/activity icon */}
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke={isDevActive ? "var(--ezy-accent)" : "var(--ezy-text-muted)"} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 1c0 0-5 3-5 8l2 3h6l2-3c0-5-5-8-5-8z" />
                <circle cx="8" cy="7" r="1.5" />
                <path d="M5 12l-1.5 3" />
                <path d="M11 12l1.5 3" />
              </svg>
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

        {/* Tabs */}
        <div style={{ display: "flex", alignItems: "stretch", minWidth: 0, overflow: "hidden" }}>
          {tabs.filter((t) => !t.isDevServerTab && !t.isKanbanTab && (!t.isServersTab || showServersTab)).map((tab) => {
            const isActive = tab.id === activeTabId;
            const isSystemTab = tab.isKanbanTab || tab.isDevServerTab || tab.isServersTab;
            const isUserPinned = !!tab.isPinned;

            return (
              <button
                key={tab.id}
                role="tab"
                aria-selected={isActive}
                onClick={() => { closeAllMenus(); setActiveTab(tab.id); }}
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
                  cursor: "pointer",
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
                }}
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
                {(tab.isKanbanTab || tab.isServersTab || tab.isDevServerTab || tab.serverId) && renderTabIcon(tab, isActive)}

                {/* Label with pane count and activity indicator */}
                {!tab.isServersTab && (
                <span
                  style={{
                    overflow: "hidden",
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
                    const termIds = findAllTerminalIds(tab.layout);
                    const cliCount = termIds.length;
                    // activityTick is read to trigger re-render on poll
                    void activityTick;
                    const activeCount = termIds.filter((id) => isTerminalActive(id)).length;
                    return (
                      <>
                        <span>{tab.name}{cliCount > 1 ? ` ${cliCount}` : ""}</span>
                        {activeCount > 0 && (
                          <span style={{ opacity: 0.6, fontSize: "0.85em" }}>({activeCount})</span>
                        )}
                      </>
                    );
                  })()}
                </span>
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
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        className="opacity-0 group-hover:opacity-40 hover:!opacity-100"
                        style={{
                          cursor: "pointer",
                          transition: "opacity 120ms ease",
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          removeTab(tab.id);
                        }}
                      >
                        <line x1="4" y1="4" x2="12" y2="12" />
                        <line x1="12" y1="4" x2="4" y2="12" />
                      </svg>
                    )}
                    {/* Pin toggle — hover only for both states */}
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 16 16"
                      fill={isUserPinned ? "var(--ezy-accent)" : "none"}
                      stroke={isUserPinned ? "var(--ezy-accent)" : "currentColor"}
                      strokeWidth="1.3"
                      className="opacity-0 group-hover:opacity-40 hover:!opacity-100"
                      style={{
                        cursor: "pointer",
                        transition: "opacity 120ms ease",
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        togglePinTab(tab.id);
                      }}
                    >
                      <path d="M9.828 1.172a1 1 0 0 1 1.414 0l3.586 3.586a1 1 0 0 1 0 1.414L12 9l-1 5-3-3-4.293 4.293a.5.5 0 0 1-.707-.707L7 10.293l-3-3 5-1 2.828-2.828Z" />
                    </svg>
                  </div>
                )}
              </button>
            );
          })}
        </div>

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
              setShowSettingsMenu(false);
              if (recentProjects.length > 0) {
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
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke={showRecentMenu ? "var(--ezy-text)" : "var(--ezy-text-muted)"} strokeWidth="1.5" strokeLinecap="round">
              <line x1="8" y1="3" x2="8" y2="13" />
              <line x1="3" y1="8" x2="13" y2="8" />
            </svg>
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
              {recentProjects.map((project) => (
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
                    if (!alwaysShowTemplatePicker && project.lastTemplate) {
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
                      // Auto-start saved server command
                      if (project.serverCommand && autoStartServerCommand) {
                        spawnDevServer(tabId, project.name, project.path, project.serverCommand);
                      }
                    } else {
                      setPendingDir({ name: project.name, dir: project.path });
                    }
                  }}
                >
                  {/* Folder icon */}
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.3" style={{ flexShrink: 0 }}>
                    <path d="M2 4v8a1 1 0 001 1h10a1 1 0 001-1V6a1 1 0 00-1-1H8L6.5 3.5A1 1 0 005.79 3H3a1 1 0 00-1 1z" />
                  </svg>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 500, color: "var(--ezy-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {project.name}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--ezy-text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {truncatePath(project.path)}
                    </div>
                  </div>
                  {/* Remove button */}
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="var(--ezy-text-muted)"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    className="opacity-0 group-hover:opacity-50 hover:!opacity-100"
                    style={{ flexShrink: 0, cursor: "pointer", transition: "opacity 120ms ease" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeRecentProject(project.path);
                    }}
                  >
                    <line x1="5" y1="5" x2="11" y2="11" />
                    <line x1="11" y1="5" x2="5" y2="11" />
                  </svg>
                </div>
              ))}
              {/* Divider + Browse */}
              <div style={{ height: 1, backgroundColor: "var(--ezy-border)", margin: "2px 0" }} />
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
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.5" strokeLinecap="round">
                  <line x1="8" y1="3" x2="8" y2="13" />
                  <line x1="3" y1="8" x2="13" y2="8" />
                </svg>
                Browse for Folder...
              </button>
            </div>
          )}

          {/* Chevron — opens dropdown menu (only when a project is open) */}
          {tabs.some(t => !t.isKanbanTab && !t.isDevServerTab && !t.isServersTab) && <><div
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
              setShowSettingsMenu(false);
              setShowNewTabMenu((v) => !v);
            }}
            onMouseEnter={(e) => {
              if (!showNewTabMenu) e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
            }}
            onMouseLeave={(e) => {
              if (!showNewTabMenu) e.currentTarget.style.backgroundColor = "transparent";
            }}
          >
            <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke={showNewTabMenu ? "var(--ezy-text)" : "var(--ezy-text-muted)"} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1,2.5 4,5.5 7,2.5" />
            </svg>
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
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <circle cx="8" cy="8" r="6" stroke="#e87b35" strokeWidth="1.3" />
                    <path d="M5.5 8.5L7 10l3.5-4" stroke="#e87b35" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )},
                { type: "codex" as const, icon: (
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <rect x="3" y="3" width="10" height="10" rx="2" stroke="#10b981" strokeWidth="1.3" />
                    <path d="M6 8h4" stroke="#10b981" strokeWidth="1.3" strokeLinecap="round" />
                  </svg>
                )},
                { type: "gemini" as const, icon: (
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <path d="M8 2L4 6l4 4-4 4" stroke="#a78bfa" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M12 6l-4 4" stroke="#a78bfa" strokeWidth="1.3" strokeLinecap="round" />
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
                    {type === "claude" && claudeYolo && (
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
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.3">
                      <rect x="1" y="2" width="14" height="12" rx="1" />
                      <line x1="1" y1="8" x2="15" y2="8" />
                    </svg>
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

        {/* Clipboard image thumbnails */}
        <ClipboardImageStrip />

        {/* Tasks */}
        <div
          onClick={() => {
            const store = useAppStore.getState();
            const tab = store.tabs.find((t) => t.id === activeTabId);
            if (!tab || tab.isDevServerTab || tab.isServersTab || tab.isKanbanTab) return;

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
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.3">
            <rect x="1" y="2" width="4" height="12" rx="1" />
            <rect x="6" y="4" width="4" height="10" rx="1" />
            <rect x="11" y="1" width="4" height="13" rx="1" />
          </svg>
        </div>

        {/* Code Review */}
        <div
          onClick={() => window.dispatchEvent(new Event("ezydev:open-codereview"))}
          title="Code Review (Ctrl+Shift+G)"
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
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5.5 3.5C5.5 4.88 4.38 6 3 6V10c1.38 0 2.5 1.12 2.5 2.5" />
            <path d="M10.5 3.5C10.5 4.88 11.62 6 13 6V10c-1.38 0-2.5 1.12-2.5 2.5" />
            <circle cx="3" cy="3" r="1.5" fill="var(--ezy-text-muted)" stroke="none" />
            <circle cx="13" cy="3" r="1.5" fill="var(--ezy-text-muted)" stroke="none" />
            <circle cx="3" cy="13" r="1.5" fill="var(--ezy-text-muted)" stroke="none" />
            <circle cx="13" cy="13" r="1.5" fill="var(--ezy-text-muted)" stroke="none" />
          </svg>
        </div>

        {/* Browser Preview — only for project tabs */}
        {(() => {
          const at = tabs.find((t) => t.id === activeTabId);
          return at && !at.isDevServerTab && !at.isServersTab && !at.isKanbanTab;
        })() && (
          <div
            onClick={() => {
              const store = useAppStore.getState();
              const tab = store.tabs.find((t) => t.id === store.activeTabId);
              if (!tab || tab.isDevServerTab || tab.isServersTab || tab.isKanbanTab) return;

              // If browser pane already exists, remove it (toggle off)
              const existing = findAllBrowserPanes(tab.layout);
              if (existing.length > 0) {
                let newLayout = tab.layout;
                for (const bp of existing) {
                  const result = removePane(newLayout, bp.id);
                  if (result) newLayout = result;
                }
                store.updateTabLayout(tab.id, newLayout);
                return;
              }

              // Otherwise open a new browser preview
              const ds = store.devServers.find((s) => s.tabId === tab.id && s.port > 0);
              const url = ds ? `http://localhost:${ds.port}` : "http://localhost:3000";
              const { layout } = addBrowserPaneRight(tab.layout, url, 35);
              store.updateTabLayout(tab.id, layout);
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
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <rect x="1" y="2" width="14" height="12" rx="1.5" />
              <line x1="1" y1="5.5" x2="15" y2="5.5" />
              <circle cx="3.5" cy="3.8" r="0.7" fill="var(--ezy-text-muted)" stroke="none" />
              <circle cx="5.8" cy="3.8" r="0.7" fill="var(--ezy-text-muted)" stroke="none" />
            </svg>
          </div>
        )}

        {/* Settings */}
        <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
          <div
            onClick={() => {
              setShowNewTabMenu(false);
              setShowRecentMenu(false);
              setShowSettingsMenu((v) => !v);
            }}
            title="Settings"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 34,
              height: 26,
              cursor: "pointer",
              borderRadius: 4,
              backgroundColor: showSettingsMenu ? "var(--ezy-surface)" : "transparent",
              transition: "background-color 120ms ease",
            }}
            onMouseEnter={(e) => {
              if (!showSettingsMenu) e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
            }}
            onMouseLeave={(e) => {
              if (!showSettingsMenu) e.currentTarget.style.backgroundColor = "transparent";
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={showSettingsMenu ? "var(--ezy-text)" : "var(--ezy-text-muted)"} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="8" cy="8" r="2" />
              <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M2.93 2.93l1.06 1.06M11.01 11.01l1.06 1.06M13.07 2.93l-1.06 1.06M4.99 11.01l-1.06 1.06" />
            </svg>
          </div>

          {showSettingsMenu && (
            <div
              ref={settingsMenuRef}
              className="dropdown-enter"
              style={{
                position: "absolute",
                top: "100%",
                right: 0,
                marginTop: 6,
                width: 220,
                maxHeight: "calc(100vh - 60px)",
                overflowY: "auto",
                backgroundColor: "var(--ezy-surface-raised)",
                border: "1px solid var(--ezy-border)",
                borderRadius: 8,
                boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
                zIndex: 100,
              }}
            >
              {/* Behavior section */}
              <div
                style={{
                  padding: "6px 10px",
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "var(--ezy-text-muted)",
                  borderBottom: "1px solid var(--ezy-border)",
                }}
              >
                Behavior
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "8px 10px",
                  cursor: "pointer",
                }}
                onClick={() => setAlwaysShowTemplatePicker(!alwaysShowTemplatePicker)}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
              >
                <span style={{ fontSize: 12, color: "var(--ezy-text-secondary)" }}>
                  Always show layout picker
                </span>
                {/* Toggle switch */}
                <div
                  style={{
                    width: 32,
                    height: 18,
                    borderRadius: 9,
                    backgroundColor: alwaysShowTemplatePicker ? "var(--ezy-accent)" : "transparent",
                    border: alwaysShowTemplatePicker ? "none" : "1px solid var(--ezy-border-light)",
                    position: "relative",
                    transition: "background-color 150ms ease",
                    flexShrink: 0,
                  }}
                >
                  <div
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: "50%",
                      backgroundColor: alwaysShowTemplatePicker ? "#fff" : "var(--ezy-text-muted)",
                      position: "absolute",
                      top: 2,
                      left: alwaysShowTemplatePicker ? 16 : 2,
                      transition: "left 150ms ease",
                    }}
                  />
                </div>
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "8px 10px",
                  cursor: "pointer",
                }}
                onClick={() => setRestoreLastSession(!restoreLastSession)}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
              >
                <span style={{ fontSize: 12, color: "var(--ezy-text-secondary)" }}>
                  Restore last session
                </span>
                {/* Toggle switch */}
                <div
                  style={{
                    width: 32,
                    height: 18,
                    borderRadius: 9,
                    backgroundColor: restoreLastSession ? "var(--ezy-accent)" : "transparent",
                    border: restoreLastSession ? "none" : "1px solid var(--ezy-border-light)",
                    position: "relative",
                    transition: "background-color 150ms ease",
                    flexShrink: 0,
                  }}
                >
                  <div
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: "50%",
                      backgroundColor: restoreLastSession ? "#fff" : "var(--ezy-text-muted)",
                      position: "absolute",
                      top: 2,
                      left: restoreLastSession ? 16 : 2,
                      transition: "left 150ms ease",
                    }}
                  />
                </div>
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "8px 10px",
                  cursor: "pointer",
                }}
                onClick={() => setAutoInsertClipboardImage(!autoInsertClipboardImage)}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
              >
                <span style={{ fontSize: 12, color: "var(--ezy-text-secondary)" }}>
                  Auto-paste screenshots
                </span>
                {/* Toggle switch */}
                <div
                  style={{
                    width: 32,
                    height: 18,
                    borderRadius: 9,
                    backgroundColor: autoInsertClipboardImage ? "var(--ezy-accent)" : "transparent",
                    border: autoInsertClipboardImage ? "none" : "1px solid var(--ezy-border-light)",
                    position: "relative",
                    transition: "background-color 150ms ease",
                    flexShrink: 0,
                  }}
                >
                  <div
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: "50%",
                      backgroundColor: autoInsertClipboardImage ? "#fff" : "var(--ezy-text-muted)",
                      position: "absolute",
                      top: 2,
                      left: autoInsertClipboardImage ? 16 : 2,
                      transition: "left 150ms ease",
                    }}
                  />
                </div>
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "8px 10px",
                  cursor: "pointer",
                }}
                onClick={() => setPromptComposerEnabled(!promptComposerEnabled)}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
              >
                <span style={{ fontSize: 12, color: "var(--ezy-text-secondary)" }}>
                  Prompt composer (Ctrl+I)
                </span>
                {/* Toggle switch */}
                <div
                  style={{
                    width: 32,
                    height: 18,
                    borderRadius: 9,
                    backgroundColor: promptComposerEnabled ? "var(--ezy-accent)" : "transparent",
                    border: promptComposerEnabled ? "none" : "1px solid var(--ezy-border-light)",
                    position: "relative",
                    transition: "background-color 150ms ease",
                    flexShrink: 0,
                  }}
                >
                  <div
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: "50%",
                      backgroundColor: promptComposerEnabled ? "#fff" : "var(--ezy-text-muted)",
                      position: "absolute",
                      top: 2,
                      left: promptComposerEnabled ? 16 : 2,
                      transition: "left 150ms ease",
                    }}
                  />
                </div>
              </div>

              {/* Always-visible composer (sub-option, only when composer is enabled) */}
              {promptComposerEnabled && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "8px 10px 8px 22px",
                  cursor: "pointer",
                }}
                onClick={() => setPromptComposerAlwaysVisible(!promptComposerAlwaysVisible)}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
              >
                <span style={{ fontSize: 12, color: "var(--ezy-text-secondary)" }}>
                  Always visible
                </span>
                <div
                  style={{
                    width: 32,
                    height: 18,
                    borderRadius: 9,
                    backgroundColor: promptComposerAlwaysVisible ? "var(--ezy-accent)" : "transparent",
                    border: promptComposerAlwaysVisible ? "none" : "1px solid var(--ezy-border-light)",
                    position: "relative",
                    transition: "background-color 150ms ease",
                    flexShrink: 0,
                  }}
                >
                  <div
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: "50%",
                      backgroundColor: promptComposerAlwaysVisible ? "#fff" : "var(--ezy-text-muted)",
                      position: "absolute",
                      top: 2,
                      left: promptComposerAlwaysVisible ? 16 : 2,
                      transition: "left 150ms ease",
                    }}
                  />
                </div>
              </div>
              )}

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "8px 10px",
                  cursor: "pointer",
                }}
                onClick={() => setAutoStartServerCommand(!autoStartServerCommand)}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
              >
                <span style={{ fontSize: 12, color: "var(--ezy-text-secondary)" }}>
                  Auto-start server cmd
                </span>
                <div
                  style={{
                    width: 32,
                    height: 18,
                    borderRadius: 9,
                    backgroundColor: autoStartServerCommand ? "var(--ezy-accent)" : "transparent",
                    border: autoStartServerCommand ? "none" : "1px solid var(--ezy-border-light)",
                    position: "relative",
                    transition: "background-color 150ms ease",
                    flexShrink: 0,
                  }}
                >
                  <div
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: "50%",
                      backgroundColor: autoStartServerCommand ? "#fff" : "var(--ezy-text-muted)",
                      position: "absolute",
                      top: 2,
                      left: autoStartServerCommand ? 16 : 2,
                      transition: "left 150ms ease",
                    }}
                  />
                </div>
              </div>

              {/* CLI Options section */}
              <div style={{ height: 1, backgroundColor: "var(--ezy-border)" }} />
              <div
                style={{
                  padding: "6px 10px",
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "var(--ezy-text-muted)",
                  borderBottom: "1px solid var(--ezy-border)",
                }}
              >
                CLI Options
              </div>
              {(["claude", "codex", "gemini"] as TerminalType[]).map((cliType) => {
                const isExpanded = !!expandedCli[cliType];
                const currentSize = cliFontSizes[cliType] ?? DEFAULT_CLI_FONT_SIZE;
                const label = TERMINAL_CONFIGS[cliType].label;
                return (
                  <div key={cliType}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "7px 10px",
                        cursor: "pointer",
                      }}
                      onClick={() => setExpandedCli((prev) => ({ ...prev, [cliType]: !prev[cliType] }))}
                      onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"}
                      onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                    >
                      <span style={{ fontSize: 12, color: "var(--ezy-text-secondary)" }}>{label}</span>
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 10 10"
                        fill="none"
                        stroke="var(--ezy-text-muted)"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{ transition: "transform 150ms ease", transform: isExpanded ? "rotate(180deg)" : "rotate(0deg)" }}
                      >
                        <polyline points="2,3.5 5,6.5 8,3.5" />
                      </svg>
                    </div>
                    {isExpanded && (
                      <div style={{ padding: "4px 10px 8px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                          <span style={{ fontSize: 11, color: "var(--ezy-text-muted)" }}>Font size</span>
                          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <div
                              onClick={() => setCliFontSize(cliType, Math.max(10, currentSize - 1))}
                              style={{
                                width: 20,
                                height: 20,
                                borderRadius: 4,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                cursor: currentSize <= 10 ? "default" : "pointer",
                                opacity: currentSize <= 10 ? 0.3 : 1,
                                backgroundColor: "transparent",
                                border: "1px solid var(--ezy-border-light)",
                                color: "var(--ezy-text-secondary)",
                                fontSize: 13,
                                lineHeight: 1,
                                transition: "background-color 120ms ease",
                              }}
                              onMouseEnter={(e) => { if (currentSize > 10) e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"; }}
                              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
                            >
                              -
                            </div>
                            <span style={{ fontSize: 12, color: "var(--ezy-text)", minWidth: 20, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
                              {currentSize}
                            </span>
                            <div
                              onClick={() => setCliFontSize(cliType, Math.min(24, currentSize + 1))}
                              style={{
                                width: 20,
                                height: 20,
                                borderRadius: 4,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                cursor: currentSize >= 24 ? "default" : "pointer",
                                opacity: currentSize >= 24 ? 0.3 : 1,
                                backgroundColor: "transparent",
                                border: "1px solid var(--ezy-border-light)",
                                color: "var(--ezy-text-secondary)",
                                fontSize: 13,
                                lineHeight: 1,
                                transition: "background-color 120ms ease",
                              }}
                              onMouseEnter={(e) => { if (currentSize < 24) e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"; }}
                              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
                            >
                              +
                            </div>
                          </div>
                        </div>
                        {cliType === "claude" && (
                          <div
                            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}
                            onClick={() => setClaudeYolo(!claudeYolo)}
                          >
                            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                              {claudeYolo ? (
                                <span
                                  style={{
                                    fontSize: 9,
                                    fontWeight: 700,
                                    padding: "1px 4px",
                                    borderRadius: 3,
                                    backgroundColor: "var(--ezy-red, #e55)",
                                    color: "#fff",
                                    lineHeight: 1,
                                    letterSpacing: "0.06em",
                                  }}
                                >
                                  YOLO
                                </span>
                              ) : (
                                <span style={{ fontSize: 11, color: "var(--ezy-text-muted)" }}>YOLO</span>
                              )}
                              <span style={{ fontSize: 11, color: "var(--ezy-text-muted)" }}>mode</span>
                            </div>
                            <div
                              style={{
                                width: 28,
                                height: 16,
                                borderRadius: 8,
                                backgroundColor: claudeYolo ? "var(--ezy-red, #e55)" : "transparent",
                                border: claudeYolo ? "none" : "1px solid var(--ezy-border-light)",
                                position: "relative",
                                transition: "background-color 150ms ease",
                                flexShrink: 0,
                              }}
                            >
                              <div
                                style={{
                                  width: 12,
                                  height: 12,
                                  borderRadius: "50%",
                                  backgroundColor: claudeYolo ? "#fff" : "var(--ezy-text-muted)",
                                  position: "absolute",
                                  top: 2,
                                  left: claudeYolo ? 14 : 2,
                                  transition: "left 150ms ease",
                                }}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Theme section */}
              <div style={{ height: 1, backgroundColor: "var(--ezy-border)" }} />
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "6px 10px",
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "var(--ezy-text-muted)",
                  borderBottom: themeExpanded ? "1px solid var(--ezy-border)" : "none",
                  cursor: "pointer",
                }}
                onClick={() => setThemeExpanded((v) => !v)}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
              >
                <span>Theme</span>
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  fill="none"
                  stroke="var(--ezy-text-muted)"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ transition: "transform 150ms ease", transform: themeExpanded ? "rotate(180deg)" : "rotate(0deg)" }}
                >
                  <polyline points="2,3.5 5,6.5 8,3.5" />
                </svg>
              </div>
              {themeExpanded && THEMES.map((t) => {
                const isSelected = t.id === themeId;
                return (
                  <button
                    key={t.id}
                    className="w-full text-left"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "7px 10px",
                      backgroundColor: isSelected ? "var(--ezy-accent-glow)" : "transparent",
                      border: "none",
                      cursor: "pointer",
                      fontSize: 13,
                      fontWeight: isSelected ? 600 : 400,
                      color: isSelected ? "var(--ezy-text)" : "var(--ezy-text-secondary)",
                      fontFamily: "inherit",
                    }}
                    onMouseEnter={(e) => {
                      if (!isSelected) e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)";
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected) e.currentTarget.style.backgroundColor = "transparent";
                    }}
                    onClick={() => {
                      setTheme(t.id);
                    }}
                  >
                    <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
                      <div style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: t.surface.bg }} />
                      <div style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: t.surface.accent }} />
                      <div style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: t.surface.cyan }} />
                    </div>
                    <span>{t.name}</span>
                    {isSelected && (
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke={theme.surface.accent} strokeWidth="2" strokeLinecap="round" style={{ marginLeft: "auto" }}>
                        <polyline points="2,8 6,12 14,4" />
                      </svg>
                    )}
                  </button>
                );
              })}

              {/* Remote Servers */}
              <div style={{ height: 1, backgroundColor: "var(--ezy-border)" }} />
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 10px",
                  cursor: "pointer",
                }}
                onClick={() => {
                  setShowSettingsMenu(false);
                  if (showServersTab) {
                    setShowServersTab(false);
                    const other = tabs.find((t) => !t.isServersTab && !t.isKanbanTab && !t.isDevServerTab);
                    if (other) setActiveTab(other.id);
                  } else {
                    setShowServersTab(true);
                    const srv = tabs.find((t) => t.isServersTab);
                    if (srv) setActiveTab(srv.id);
                  }
                }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="var(--ezy-cyan)" strokeWidth="1.3">
                  <rect x="2" y="1" width="12" height="6" rx="1.5" />
                  <rect x="2" y="9" width="12" height="6" rx="1.5" />
                  <circle cx="5" cy="4" r="1" fill="var(--ezy-cyan)" stroke="none" />
                  <circle cx="5" cy="12" r="1" fill="var(--ezy-cyan)" stroke="none" />
                </svg>
                <span style={{ fontSize: 12, color: "var(--ezy-text-secondary)" }}>Remote Servers</span>
              </div>

              {/* Snippets */}
              <div style={{ height: 1, backgroundColor: "var(--ezy-border)" }} />
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 10px",
                  cursor: "pointer",
                }}
                onClick={() => {
                  setShowSettingsMenu(false);
                  window.dispatchEvent(new Event("ezydev:open-snippets"));
                }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.3" strokeLinecap="round">
                  <path d="M5.5 2H3a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1V3a1 1 0 00-1-1h-2.5" />
                  <path d="M5 5l2 2-2 2" />
                  <line x1="8" y1="10" x2="12" y2="10" />
                </svg>
                <span style={{ fontSize: 12, color: "var(--ezy-text-secondary)" }}>Snippets</span>
              </div>
            </div>
          )}
        </div>

        {/* Separator before window controls */}
        <div style={{ width: 1, height: 16, backgroundColor: "var(--ezy-border-subtle)", alignSelf: "center", margin: "0 4px" }} />

        {/* Window controls (Warp style — subtle, integrated) */}
        <div style={{ display: "flex", alignItems: "stretch" }}>
          {/* Minimize */}
          <div
            onClick={() => getCurrentWindow().minimize()}
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
            onClick={() => getCurrentWindow().close()}
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
        />
      )}
    </>
  );
}
