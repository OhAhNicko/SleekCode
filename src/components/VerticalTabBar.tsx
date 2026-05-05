import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "../store";
import { findAllTerminalIds, findAllBrowserPanes, addBrowserPaneRight, addBrowserPaneLeft, addPaneAsGrid, removePane, generatePaneId, findKanbanPaneId, addKanbanPane } from "../lib/layout-utils";
import { getProjectColor } from "../store/recentProjectsSlice";
import { isTerminalActive } from "../lib/terminal-activity";
import ClipboardImageStrip from "./ClipboardImageStrip";
import VoiceMicButton from "./VoiceMicButton";
import { VOICE_ENABLED } from "../lib/voice/feature-flag";
import GitStatusBar from "./GitStatusBar";
import { FaXmark, FaGear, FaServer, FaPlus } from "react-icons/fa6";
import { TbBrowserPlus, TbBrowserMinus } from "react-icons/tb";
import { PiKanbanDuotone, PiGameControllerDuotone } from "react-icons/pi";
import { AiOutlinePushpin, AiFillPushpin } from "react-icons/ai";
import { BiSidebar, BiCollapseHorizontal, BiExpandHorizontal } from "react-icons/bi";

const WIDE_WIDTH = 200;
const COMPACT_WIDTH = 80;
const TAB_ROW_HEIGHT = 32;

function tabInitials(name: string): string {
  const cleaned = name.trim().replace(/[_\-./\\]+/g, " ");
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export default function VerticalTabBar() {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const removeTab = useAppStore((s) => s.removeTab);
  const togglePinTab = useAppStore((s) => s.togglePinTab);
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const devServers = useAppStore((s) => s.devServers);
  const devServerPanelOpen = useAppStore((s) => s.devServerPanelOpen);
  const toggleDevServerPanel = useAppStore((s) => s.toggleDevServerPanel);
  const projectColors = useAppStore((s) => s.projectColors);
  const settingsPanelOpen = useAppStore((s) => s.settingsPanelOpen);
  const showMiniGamesButton = useAppStore((s) => s.showMiniGamesButton ?? false);
  const showKanbanButton = useAppStore((s) => s.showKanbanButton ?? true);
  const confirmQuit = useAppStore((s) => s.confirmQuit);
  const compact = useAppStore((s) => s.verticalTabBarCompact);
  const setCompact = useAppStore((s) => s.setVerticalTabBarCompact);
  const stripWidth = compact ? COMPACT_WIDTH : WIDE_WIDTH;

  const [isMaximized, setIsMaximized] = useState(false);
  useEffect(() => {
    const win = getCurrentWindow();
    win.isMaximized().then(setIsMaximized);
    let unlisten: (() => void) | undefined;
    win.onResized(async () => setIsMaximized(await win.isMaximized())).then((u) => {
      unlisten = u;
    });
    return () => { unlisten?.(); };
  }, []);

  // Poll terminal-activity state once per second so the per-tab WIP badge
  // updates while AI CLIs (Claude/Codex/Gemini) are streaming output.
  // Mirrors horizontal TabBar's activityTick — without it, isTerminalActive()
  // values are read once at mount and never refreshed.
  const [, setActivityTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setActivityTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const handleMinimize = async () => {
    const win = getCurrentWindow();
    if (await win.isMaximized()) {
      const { invoke } = await import("@tauri-apps/api/core");
      invoke("minimize_from_maximized").catch(() => win.minimize());
    } else {
      win.minimize();
    }
  };

  const handleMaximizeToggle = async () => {
    const win = getCurrentWindow();
    if (await win.isMaximized()) win.unmaximize();
    else win.maximize();
  };

  const handleClose = () => {
    if (confirmQuit) {
      const ok = window.confirm("Quit EzyDev?");
      if (!ok) return;
    }
    getCurrentWindow().close();
  };

  const visibleTabs = tabs.filter(
    (t) => !t.isDevServerTab && !t.isKanbanTab && !t.isServersTab && !t.isSettingsTab
  );
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeIsProject =
    !!activeTab &&
    !activeTab.isDevServerTab &&
    !activeTab.isServersTab &&
    !activeTab.isKanbanTab &&
    !activeTab.isSettingsTab;

  const runningDevCount = devServers.filter(
    (s) => s.status === "running" || s.status === "starting"
  ).length;

  const handleSidebarClick = () => {
    if (!sidebarOpen) useAppStore.getState().setSettingsPanelOpen(false);
    toggleSidebar();
  };

  const handleDevServersClick = () => {
    if (!devServerPanelOpen) useAppStore.getState().setSettingsPanelOpen(false);
    toggleDevServerPanel();
  };

  const handleSettingsClick = () => {
    if (!settingsPanelOpen) {
      useAppStore.setState({ sidebarOpen: false, devServerPanelOpen: false });
    }
    useAppStore.getState().toggleSettingsPanel();
  };

  const handleTasksClick = () => {
    const store = useAppStore.getState();
    const tab = store.tabs.find((t) => t.id === store.activeTabId);
    if (!tab || !tab.layout || tab.isDevServerTab || tab.isServersTab || tab.isKanbanTab || tab.isSettingsTab) return;
    const existingId = findKanbanPaneId(tab.layout);
    if (existingId) {
      const newLayout = removePane(tab.layout, existingId);
      if (newLayout) store.updateTabLayout(tab.id, newLayout);
      return;
    }
    const newLayout = addKanbanPane(tab.layout);
    if (newLayout) store.updateTabLayout(tab.id, newLayout);
  };

  const handleBrowserClick = () => {
    const store = useAppStore.getState();
    const tab = store.tabs.find((t) => t.id === store.activeTabId);
    if (!tab || !tab.layout || tab.isDevServerTab || tab.isServersTab || tab.isKanbanTab || tab.isSettingsTab) return;
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
  };

  const activeHasBrowser = activeTab?.layout
    ? findAllBrowserPanes(activeTab.layout).length > 0
    : false;

  return (
    <div
      style={{
        width: stripWidth,
        flexShrink: 0,
        height: "100%",
        backgroundColor: "var(--ezy-bg)",
        borderRight: "1px solid var(--ezy-border)",
        display: "flex",
        flexDirection: "column",
        position: "relative",
        zIndex: 60,
      }}
    >
      {/* TOP — window controls row, then nav buttons */}
      <div style={{ display: "flex", flexDirection: "column", flexShrink: 0 }}>
        {/* Window controls: [X] [maximize] [minimize] [drag region] */}
        <div
          style={{
            display: "flex",
            alignItems: "stretch",
            height: 32,
            borderBottom: "1px solid var(--ezy-border-subtle)",
          }}
        >
          {/* Close (far left) */}
          <div
            onClick={handleClose}
            title="Close"
            style={{
              width: compact ? 20 : 40,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              transition: "background-color 120ms ease",
              flexShrink: 0,
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

          {/* Maximize / Restore */}
          <div
            onClick={handleMaximizeToggle}
            title={isMaximized ? "Restore" : "Maximize"}
            style={{
              width: compact ? 20 : 40,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              transition: "background-color 120ms ease",
              flexShrink: 0,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.06)")}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
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

          {/* Minimize */}
          <div
            onClick={handleMinimize}
            title="Minimize"
            style={{
              width: compact ? 20 : 40,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              transition: "background-color 120ms ease",
              flexShrink: 0,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.06)")}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <line x1="1" y1="5" x2="9" y2="5" stroke="var(--ezy-text-muted)" strokeWidth="1" />
            </svg>
          </div>

          {/* Draggable spacer — only meaningful in wide mode (compact has no leftover width) */}
          {!compact && <div data-tauri-drag-region style={{ flex: 1, cursor: "default" }} />}

          {/* New tab (far right of controls row) */}
          <div
            onClick={() => window.dispatchEvent(new Event("ezydev:new-tab"))}
            title="New tab"
            style={{
              width: compact ? 20 : 32,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              transition: "background-color 120ms ease",
              flexShrink: 0,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.06)")}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
          >
            <FaPlus size={11} color="var(--ezy-text-muted)" />
          </div>
        </div>

        {/* Sidebar toggle */}
        <div
          title="Toggle sidebar"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: compact ? "center" : "flex-start",
            gap: 10,
            height: 36,
            padding: compact ? "0 6px" : "0 12px",
            cursor: "pointer",
            backgroundColor: sidebarOpen ? "var(--ezy-surface)" : "transparent",
            color: sidebarOpen ? "var(--ezy-accent)" : "var(--ezy-text-muted)",
            fontSize: 12,
            transition: "background-color 120ms ease, color 120ms ease",
          }}
          onClick={handleSidebarClick}
          onMouseEnter={(e) => {
            if (!sidebarOpen) e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
          }}
          onMouseLeave={(e) => {
            if (!sidebarOpen) e.currentTarget.style.backgroundColor = "transparent";
          }}
        >
          <BiSidebar size={14} color="currentColor" />
          {!compact && <span>Sidebar</span>}
        </div>

        {/* Browser Preview — only meaningful for project tabs, but always visible for symmetry */}
        <div
          onClick={activeIsProject ? handleBrowserClick : undefined}
          title="Browser Preview"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: compact ? "center" : "flex-start",
            gap: 10,
            height: 36,
            padding: compact ? "0 6px" : "0 12px",
            cursor: activeIsProject ? "pointer" : "not-allowed",
            backgroundColor: activeHasBrowser ? "var(--ezy-surface)" : "transparent",
            color: activeHasBrowser ? "var(--ezy-accent)" : "var(--ezy-text-muted)",
            opacity: activeIsProject ? 1 : 0.4,
            fontSize: 12,
            transition: "background-color 120ms ease, color 120ms ease",
          }}
          onMouseEnter={(e) => {
            if (!activeHasBrowser && activeIsProject) e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
          }}
          onMouseLeave={(e) => {
            if (!activeHasBrowser) e.currentTarget.style.backgroundColor = "transparent";
          }}
        >
          {activeHasBrowser ? (
            <TbBrowserMinus size={14} color="currentColor" style={{ transform: "scale(1.1)" }} />
          ) : (
            <TbBrowserPlus size={14} color="currentColor" style={{ transform: "scale(1.1)" }} />
          )}
          {!compact && <span>Browser</span>}
        </div>

        {/* Dev Servers */}
        <div
          title="Dev Servers"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: compact ? "center" : "flex-start",
            gap: 10,
            height: 36,
            padding: compact ? "0 6px" : "0 12px",
            cursor: "pointer",
            position: "relative",
            backgroundColor: devServerPanelOpen ? "var(--ezy-surface)" : "transparent",
            color: devServerPanelOpen ? "var(--ezy-accent)" : "var(--ezy-text-muted)",
            fontSize: 12,
            borderBottom: "1px solid var(--ezy-border-subtle)",
            transition: "background-color 120ms ease, color 120ms ease",
          }}
          onClick={handleDevServersClick}
          onMouseEnter={(e) => {
            if (!devServerPanelOpen) e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
          }}
          onMouseLeave={(e) => {
            if (!devServerPanelOpen) e.currentTarget.style.backgroundColor = "transparent";
          }}
        >
          <FaServer size={13} color="currentColor" />
          {!compact && <span>Servers</span>}
          {runningDevCount > 0 && (
            <span
              style={{
                marginLeft: compact ? 4 : "auto",
                minWidth: 14,
                height: 14,
                borderRadius: 7,
                backgroundColor: "var(--ezy-accent)",
                border: "1px solid var(--ezy-bg)",
                fontSize: 9,
                fontWeight: 700,
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                lineHeight: 1,
                padding: "0 4px",
              }}
            >
              {runningDevCount}
            </span>
          )}
        </div>
      </div>

      {/* MIDDLE — scrollable tabs + git status + per-tab actions */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          overflowX: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Tabs list */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          {visibleTabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const isUserPinned = !!tab.isPinned;
            const dirKey = (tab.workingDir ?? "").replace(/\\/g, "/");
            const colorId = projectColors[dirKey];
            const tabColor = colorId ? getProjectColor(colorId) : null;
            const termIds = tab.layout ? findAllTerminalIds(tab.layout) : [];
            const cliCount = termIds.length;
            const activeCount = termIds.filter((id) => isTerminalActive(id)).length;
            const label = tab.customName ?? tab.name;

            return (
              <button
                key={tab.id}
                role="tab"
                aria-selected={isActive}
                onClick={() => setActiveTab(tab.id)}
                className="group"
                title={compact ? label : undefined}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: compact ? "center" : "flex-start",
                  gap: compact ? 4 : 6,
                  padding: compact ? "0 6px" : "0 10px 0 12px",
                  height: TAB_ROW_HEIGHT,
                  position: "relative",
                  backgroundColor: isActive ? "var(--ezy-surface)" : "transparent",
                  backgroundImage: isUserPinned
                    ? "repeating-linear-gradient(135deg, transparent, transparent 4px, rgba(255,255,255,0.05) 4px, rgba(255,255,255,0.05) 8px)"
                    : undefined,
                  border: "none",
                  borderRight: tabColor ? `2px solid ${tabColor}` : "2px solid transparent",
                  borderBottom: "1px solid var(--ezy-border-subtle)",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: isActive ? 500 : 400,
                  color: isActive ? "var(--ezy-text)" : "var(--ezy-text-muted)",
                  fontFamily: "inherit",
                  transition: "background-color 120ms ease, color 120ms ease",
                  outline: "none",
                  textAlign: "left",
                  width: "100%",
                  userSelect: "none",
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
                {compact ? (
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 26,
                      height: 22,
                      borderRadius: 4,
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: "0.02em",
                      backgroundColor: tabColor ?? "var(--ezy-surface-raised)",
                      color: tabColor ? "#fff" : "var(--ezy-text-secondary)",
                      flexShrink: 0,
                    }}
                  >
                    {tabInitials(label)}
                  </span>
                ) : (
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {label}
                  </span>
                )}

                {!compact && cliCount > 1 && (
                  <span
                    style={{
                      fontSize: 9,
                      fontWeight: 600,
                      lineHeight: 1,
                      padding: "1px 4px",
                      borderRadius: 4,
                      position: "relative",
                      backgroundColor: "var(--ezy-surface-raised)",
                      border: "1px solid var(--ezy-border)",
                      color: "var(--ezy-text-secondary)",
                      flexShrink: 0,
                    }}
                  >
                    {cliCount}
                    {activeCount > 0 && (
                      <span
                        style={{
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
                        }}
                      >
                        {activeCount}
                      </span>
                    )}
                  </span>
                )}

                {/* Compact-mode WIP dot — small accent overlay on the right edge of the row */}
                {compact && activeCount > 0 && (
                  <span
                    title={`${activeCount} working`}
                    style={{
                      position: "absolute",
                      top: 4,
                      right: 4,
                      width: 8,
                      height: 8,
                      borderRadius: 4,
                      backgroundColor: "var(--ezy-accent)",
                      border: "1px solid var(--ezy-bg)",
                    }}
                  />
                )}

                {/* Compact-mode close-on-hover (top-left overlay) */}
                {compact && !isUserPinned && (
                  <span
                    role="button"
                    aria-label="Close tab"
                    className="opacity-0 group-hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeTab(tab.id);
                    }}
                    style={{
                      position: "absolute",
                      top: 2,
                      left: 2,
                      width: 14,
                      height: 14,
                      borderRadius: 3,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: "var(--ezy-bg)",
                      border: "1px solid var(--ezy-border)",
                      cursor: "pointer",
                      transition: "opacity 120ms ease",
                    }}
                  >
                    <FaXmark size={8} color="var(--ezy-text-muted)" />
                  </span>
                )}

                <div
                  style={{
                    display: compact ? "none" : "flex",
                    alignItems: "center",
                    gap: 6,
                    flexShrink: 0,
                  }}
                >
                  {!isUserPinned && (
                    <FaXmark
                      size={10}
                      color="currentColor"
                      className="opacity-0 group-hover:opacity-40 hover:!opacity-100"
                      style={{ cursor: "pointer", transition: "opacity 120ms ease" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        removeTab(tab.id);
                      }}
                    />
                  )}
                  {isUserPinned ? (
                    <AiFillPushpin
                      size={10}
                      color="var(--ezy-accent)"
                      className="opacity-0 group-hover:opacity-40 hover:!opacity-100"
                      style={{ cursor: "pointer", transition: "opacity 120ms ease" }}
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
                      style={{ cursor: "pointer", transition: "opacity 120ms ease" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        togglePinTab(tab.id);
                      }}
                    />
                  )}
                </div>
              </button>
            );
          })}
        </div>

        {/* GitStatusBar — only for project tabs with workingDir */}
        {activeTab && activeTab.workingDir && activeIsProject && (
          <div style={{ padding: compact ? "6px 6px" : "6px 10px", borderTop: "1px solid var(--ezy-border-subtle)" }}>
            <GitStatusBar workingDir={activeTab.workingDir} compact={compact} />
          </div>
        )}

        {/* Per-tab toggles row (Tasks/Browser/Games) — only for project tabs */}
        {activeIsProject && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-around",
              padding: compact ? "6px 4px" : "6px 8px",
              borderTop: "1px solid var(--ezy-border-subtle)",
            }}
          >
            {showKanbanButton && (
              <div
                onClick={handleTasksClick}
                title="Tasks"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 34,
                  height: 26,
                  cursor: "pointer",
                  borderRadius: 4,
                  transition: "background-color 120ms ease",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--ezy-surface)")}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
              >
                <PiKanbanDuotone size={14} color="var(--ezy-text-muted)" style={{ transform: "scale(1.5)" }} />
              </div>
            )}

            {showMiniGamesButton && (
              <div
                onClick={() => window.dispatchEvent(new CustomEvent("ezydev:open-game"))}
                title="Mini Games"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 34,
                  height: 26,
                  cursor: "pointer",
                  borderRadius: 4,
                  transition: "background-color 120ms ease",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--ezy-surface)")}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
              >
                <PiGameControllerDuotone size={14} color="var(--ezy-text-muted)" style={{ transform: "scale(1.5)" }} />
              </div>
            )}
          </div>
        )}

        {/* Draggable filler — empty space below tabs is grabbable to move the window */}
        <div data-tauri-drag-region style={{ flex: 1, minHeight: 24 }} />
      </div>

      {/* BOTTOM — voice mic, snip + thumbnails (wrap), divider, Settings */}
      <div style={{ flexShrink: 0, borderTop: "1px solid var(--ezy-border)" }}>
        {VOICE_ENABLED && (
          <div style={{ display: "flex", justifyContent: "center", padding: "8px 0 4px" }}>
            <VoiceMicButton size="vertical" />
          </div>
        )}
        <div style={{ padding: "6px 4px" }}>
          <ClipboardImageStrip orientation="vertical" />
        </div>
        {/* Settings + compact toggle, side by side */}
        <div
          style={{
            display: "flex",
            alignItems: "stretch",
            height: 36,
            borderTop: "1px solid var(--ezy-border-subtle)",
          }}
        >
          <div
            title="Settings"
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: compact ? "center" : "flex-start",
              gap: 10,
              padding: compact ? "0 6px" : "0 12px",
              cursor: "pointer",
              backgroundColor: settingsPanelOpen ? "var(--ezy-surface)" : "transparent",
              color: settingsPanelOpen ? "var(--ezy-accent)" : "var(--ezy-text-muted)",
              fontSize: 12,
              transition: "background-color 120ms ease, color 120ms ease",
            }}
            onClick={handleSettingsClick}
            onMouseEnter={(e) => {
              if (!settingsPanelOpen) e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
            }}
            onMouseLeave={(e) => {
              if (!settingsPanelOpen) e.currentTarget.style.backgroundColor = "transparent";
            }}
          >
            <FaGear size={13} color="currentColor" />
            {!compact && <span>Settings</span>}
          </div>

          {/* Compact-mode toggle — collapses (200→80) or expands (80→200) the strip */}
          <div
            onClick={() => setCompact(!compact)}
            title={compact ? "Expand sidebar" : "Collapse sidebar"}
            style={{
              width: compact ? 28 : 36,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              borderLeft: "1px solid var(--ezy-border-subtle)",
              color: "var(--ezy-text-muted)",
              transition: "background-color 120ms ease, color 120ms ease",
              flexShrink: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
              e.currentTarget.style.color = "var(--ezy-text)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "transparent";
              e.currentTarget.style.color = "var(--ezy-text-muted)";
            }}
          >
            {compact ? (
              <BiExpandHorizontal size={14} color="currentColor" />
            ) : (
              <BiCollapseHorizontal size={14} color="currentColor" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
