import { useCallback, useState, useRef, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "../store";
import { THEMES, getTheme } from "../lib/themes";
import { buildLayoutFromTemplate } from "../lib/layout-utils";
import { TERMINAL_CONFIGS } from "../lib/terminal-config";
import type { RemoteServer, TerminalType } from "../types";
import type { WorkspaceTemplate } from "../lib/workspace-templates";
import RemoteFileBrowser from "./RemoteFileBrowser";
import TemplatePicker from "./TemplatePicker";

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

  const [showNewTabMenu, setShowNewTabMenu] = useState(false);
  const [showRecentMenu, setShowRecentMenu] = useState(false);
  const [browsingServer, setBrowsingServer] = useState<RemoteServer | null>(null);
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const [pendingDir, setPendingDir] = useState<{ name: string; dir: string; serverId?: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const recentMenuRef = useRef<HTMLDivElement>(null);
  const settingsMenuRef = useRef<HTMLDivElement>(null);

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

  const handleTemplateSelected = useCallback(
    (template: WorkspaceTemplate, slotTypes: TerminalType[]) => {
      if (!pendingDir) return;
      const { layout, terminalIds } = buildLayoutFromTemplate(
        template.id,
        template.cols,
        template.rows
      );

      // Batch-create all terminals
      const batch = terminalIds.map((id, i) => ({
        id,
        type: slotTypes[i] ?? ("shell" as TerminalType),
        workingDir: pendingDir.dir,
        serverId: pendingDir.serverId,
      }));
      addTerminals(batch);
      addTabWithLayout(pendingDir.name, pendingDir.dir, layout, pendingDir.serverId);
      if (!pendingDir.serverId) {
        addRecentProject({
          path: pendingDir.dir,
          name: pendingDir.name,
          template: { templateId: template.id, cols: template.cols, rows: template.rows, slotTypes },
        });
      }
      setPendingDir(null);
    },
    [pendingDir, addTerminals, addTabWithLayout, addRecentProject]
  );

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

        {/* Tabs */}
        <div style={{ display: "flex", alignItems: "stretch", minWidth: 0, overflow: "hidden" }}>
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const isSystemTab = tab.isKanbanTab || tab.isDevServerTab || tab.isServersTab;
            const isUserPinned = !!tab.isPinned;
            const isUnclosable = isSystemTab || isUserPinned;

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
                {/* Tab icon */}
                {renderTabIcon(tab, isActive)}

                {/* Label */}
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: 120,
                  }}
                >
                  {tab.name}
                </span>

                {/* Pin indicator (pinned tabs only, always visible) */}
                {!isSystemTab && isUserPinned && (
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 16 16"
                    fill="var(--ezy-accent)"
                    stroke="var(--ezy-accent)"
                    strokeWidth="1.3"
                    style={{ flexShrink: 0, cursor: "pointer", opacity: 0.7 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      togglePinTab(tab.id);
                    }}
                  >
                    <path d="M9.828 1.172a1 1 0 0 1 1.414 0l3.586 3.586a1 1 0 0 1 0 1.414L12 9l-1 5-3-3-4.293 4.293a.5.5 0 0 1-.707-.707L7 10.293l-3-3 5-1 2.828-2.828Z" />
                  </svg>
                )}

                {/* Close button — show on hover for closable tabs, or pin toggle for unpinned */}
                {!isUnclosable && (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    className={isActive ? "opacity-50 hover:opacity-100" : "opacity-0 group-hover:opacity-50 hover:!opacity-100"}
                    style={{
                      flexShrink: 0,
                      cursor: "pointer",
                      transition: "opacity 120ms ease",
                      marginLeft: -2,
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeTab(tab.id);
                    }}
                  >
                    <line x1="5" y1="5" x2="11" y2="11" />
                    <line x1="11" y1="5" x2="5" y2="11" />
                  </svg>
                )}

                {/* Pin toggle on hover (non-pinned, non-system tabs — only when no close button visible) */}
                {!isSystemTab && !isUserPinned && isUnclosable && (
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="var(--ezy-border-light)"
                    strokeWidth="1.3"
                    className="opacity-0 group-hover:opacity-100"
                    style={{ flexShrink: 0, cursor: "pointer", transition: "opacity 120ms ease" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      togglePinTab(tab.id);
                    }}
                  >
                    <path d="M9.828 1.172a1 1 0 0 1 1.414 0l3.586 3.586a1 1 0 0 1 0 1.414L12 9l-1 5-3-3-4.293 4.293a.5.5 0 0 1-.707-.707L7 10.293l-3-3 5-1 2.828-2.828Z" />
                  </svg>
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
                      const { templateId, cols, rows, slotTypes } = project.lastTemplate;
                      const { layout, terminalIds } = buildLayoutFromTemplate(templateId, cols, rows);
                      const batch = terminalIds.map((id, i) => ({
                        id,
                        type: slotTypes[i] ?? ("shell" as TerminalType),
                        workingDir: project.path,
                      }));
                      addTerminals(batch);
                      addTabWithLayout(project.name, project.path, layout);
                      addRecentProject({ path: project.path, name: project.name, template: project.lastTemplate });
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

          {/* Chevron — opens dropdown menu */}
          <div
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
              <button
                className="w-full text-left"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 12px",
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
                  setShowNewTabMenu(false);
                  window.dispatchEvent(new CustomEvent("ezydev:split-terminal", { detail: { type: "claude" } }));
                }}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="6" stroke="#e87b35" strokeWidth="1.3" />
                  <path d="M5.5 8.5L7 10l3.5-4" stroke="#e87b35" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {TERMINAL_CONFIGS.claude.label}
              </button>
              {/* Codex CLI */}
              <button
                className="w-full text-left"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 12px",
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
                  setShowNewTabMenu(false);
                  window.dispatchEvent(new CustomEvent("ezydev:split-terminal", { detail: { type: "codex" } }));
                }}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <rect x="3" y="3" width="10" height="10" rx="2" stroke="#10b981" strokeWidth="1.3" />
                  <path d="M6 8h4" stroke="#10b981" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
                {TERMINAL_CONFIGS.codex.label}
              </button>
              {/* Gemini CLI */}
              <button
                className="w-full text-left"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 12px",
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
                  setShowNewTabMenu(false);
                  window.dispatchEvent(new CustomEvent("ezydev:split-terminal", { detail: { type: "gemini" } }));
                }}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path d="M8 2L4 6l4 4-4 4" stroke="#a78bfa" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M12 6l-4 4" stroke="#a78bfa" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
                {TERMINAL_CONFIGS.gemini.label}
              </button>
              {/* Shell */}
              <button
                className="w-full text-left"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 12px",
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
                  setShowNewTabMenu(false);
                  window.dispatchEvent(new CustomEvent("ezydev:split-terminal", { detail: { type: "shell" } }));
                }}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4,4 8,8 4,12" />
                  <line x1="9" y1="12" x2="13" y2="12" />
                </svg>
                {TERMINAL_CONFIGS.shell.label}
              </button>
            </div>
          )}
        </div>

        {/* Spacer — draggable region (disable drag when menu open so clicks close menus) */}
        <div
          className="flex-1"
          {...(!anyMenuOpen ? { "data-tauri-drag-region": true } : {})}
          onMouseDown={anyMenuOpen ? closeAllMenus : undefined}
          style={anyMenuOpen ? { cursor: "default" } : undefined}
        />

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

        {/* File Viewer */}
        <div
          onClick={() => {
            // Open file dialog, then open selected file in viewer
            import("@tauri-apps/plugin-dialog").then(({ open: openDialog }) => {
              openDialog({ multiple: true, title: "Open files in viewer" }).then((selected) => {
                if (!selected) return;
                const paths = Array.isArray(selected) ? selected : [selected];
                for (const p of paths) {
                  if (typeof p === "string") {
                    window.dispatchEvent(
                      new CustomEvent("ezydev:open-fileviewer", { detail: { filePath: p } })
                    );
                  }
                }
              });
            });
          }}
          title="Open File Viewer"
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
            <rect x="2" y="2" width="12" height="12" rx="1.5" />
            <line x1="2" y1="5.5" x2="14" y2="5.5" />
            <line x1="5.5" y1="2" x2="5.5" y2="5.5" />
            <line x1="9" y1="2" x2="9" y2="5.5" />
          </svg>
        </div>

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
                backgroundColor: "var(--ezy-surface-raised)",
                border: "1px solid var(--ezy-border)",
                borderRadius: 8,
                overflow: "hidden",
                boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
                zIndex: 100,
              }}
            >
              {/* Theme section */}
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
                Theme
              </div>
              {THEMES.map((t) => {
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
                    {/* Color swatch */}
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

              {/* Behavior section */}
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
            </div>
          )}
        </div>

        {/* Separator before window controls */}
        <div style={{ width: 1, height: 16, backgroundColor: "var(--ezy-border-subtle)", alignSelf: "center", margin: "0 4px" }} />

        {/* Window controls (Warp style — subtle, integrated) */}
        <div style={{ display: "flex", alignItems: "stretch", WebkitAppRegion: "no-drag" } as React.CSSProperties}>
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
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1">
              <rect x="1" y="1" width="8" height="8" />
            </svg>
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
        />
      )}
    </>
  );
}
