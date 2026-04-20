import { useEffect } from "react";
import { useAppStore } from "../store";
import type { SidebarTab } from "../types";
import FileExplorer from "./FileExplorer";
import RemoteFileExplorer from "./RemoteFileExplorer";
import GlobalSearch from "./GlobalSearch";

interface SidebarProps {
  rootDir: string;
  onOpenFile: (filePath: string, lineNumber?: number) => void;
}

export default function Sidebar({ rootDir, onOpenFile }: SidebarProps) {
  const sidebarTab = useAppStore((s) => s.sidebarTab);
  const setSidebarTab = useAppStore((s) => s.setSidebarTab);
  const terminals = useAppStore((s) => s.terminals);
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const servers = useAppStore((s) => s.servers);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeServer = activeTab?.serverId ? servers.find((s) => s.id === activeTab.serverId) : undefined;
  const isRemote = !!activeServer;

  const handleRemoteOpen = (filePath: string) => {
    if (!activeTab?.serverId) return;
    window.dispatchEvent(
      new CustomEvent("ezydev:open-remote-editor", {
        detail: { filePath, serverId: activeTab.serverId },
      })
    );
  };

  // If we switch into a remote tab while "files" is active, flip to "remote-files"
  // (and vice-versa), so the visible pane always matches the tab's nature.
  useEffect(() => {
    if (isRemote && sidebarTab === "files") setSidebarTab("remote-files");
    if (!isRemote && sidebarTab === "remote-files") setSidebarTab("files");
  }, [isRemote, sidebarTab, setSidebarTab]);

  const visibleTabs: { id: SidebarTab; label: string }[] = isRemote
    ? [
        { id: "remote-files", label: "Remote Files" },
        { id: "search", label: "Search" },
        { id: "terminals", label: "Terminals" },
      ]
    : [
        { id: "files", label: "Files" },
        { id: "search", label: "Search" },
        { id: "terminals", label: "Terminals" },
      ];

  // Render tab icon
  const renderTabIcon = (id: SidebarTab, isActive: boolean) => {
    const color = isActive ? "var(--ezy-accent)" : "var(--ezy-text-muted)";
    switch (id) {
      case "files":
        return (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.3">
            <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.879a1.5 1.5 0 0 1 1.06.44l.872.871A.5.5 0 0 0 8.665 3.5H13.5A1.5 1.5 0 0 1 15 5v7.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9Z" />
          </svg>
        );
      case "remote-files":
        return (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.3">
            <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.879a1.5 1.5 0 0 1 1.06.44l.872.871A.5.5 0 0 0 8.665 3.5H13.5A1.5 1.5 0 0 1 15 5v7.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9Z" />
            <circle cx="12" cy="12" r="2.2" fill={color} stroke="none" />
          </svg>
        );
      case "search":
        return (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round">
            <circle cx="7" cy="7" r="5" />
            <line x1="11" y1="11" x2="14" y2="14" />
          </svg>
        );
      case "terminals":
        return (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4,4 8,8 4,12" />
            <line x1="9" y1="12" x2="13" y2="12" />
          </svg>
        );
    }
  };

  // Active terminals list
  const activeTerminals = Object.values(terminals).filter((t) => t.id);

  return (
    <div
      style={{
        width: 260,
        flexShrink: 0,
        backgroundColor: "var(--ezy-surface)",
        borderRight: "1px solid var(--ezy-border-subtle)",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* Tab switcher */}
      <div
        style={{
          display: "flex",
          borderBottom: "1px solid var(--ezy-border-subtle)",
          flexShrink: 0,
        }}
      >
        {visibleTabs.map((tab) => {
          const isActive = sidebarTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setSidebarTab(tab.id)}
              title={tab.label}
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
                padding: "8px 4px",
                backgroundColor: "transparent",
                border: "none",
                borderBottom: isActive ? "2px solid var(--ezy-accent)" : "2px solid transparent",
                cursor: "pointer",
                transition: "all 120ms ease",
              }}
              onMouseEnter={(e) => {
                if (!isActive) e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.03)";
              }}
              onMouseLeave={(e) => {
                if (!isActive) e.currentTarget.style.backgroundColor = "transparent";
              }}
            >
              {renderTabIcon(tab.id, isActive)}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {sidebarTab === "files" && !isRemote && (
          <FileExplorer rootDir={rootDir} onOpenFile={(path) => onOpenFile(path)} />
        )}
        {sidebarTab === "remote-files" && activeServer && (
          <RemoteFileExplorer
            server={activeServer}
            rootDir={rootDir}
            onOpenFile={handleRemoteOpen}
          />
        )}
        {sidebarTab === "search" && (
          <GlobalSearch
            rootDir={rootDir}
            onOpenFile={onOpenFile}
            remoteServer={activeServer}
            onOpenRemoteFile={activeTab?.serverId ? handleRemoteOpen : undefined}
          />
        )}
        {sidebarTab === "terminals" && (
          <div style={{ overflowY: "auto", height: "100%" }}>
            {activeTerminals.length === 0 ? (
              <div style={{ padding: "12px", fontSize: 12, color: "var(--ezy-text-muted)" }}>
                No active terminals
              </div>
            ) : (
              activeTerminals.map((term) => {
                const typeColors: Record<string, string> = {
                  claude: "#e87b35",
                  codex: "#10b981",
                  gemini: "#a78bfa",
                  shell: "var(--ezy-text-muted)",
                };
                const typeLabels: Record<string, string> = {
                  claude: "Claude",
                  codex: "Codex",
                  gemini: "Gemini",
                  shell: "Shell",
                };
                return (
                  <div
                    key={term.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 12px",
                      fontSize: 12,
                      color: "var(--ezy-text-secondary)",
                      borderBottom: "1px solid var(--ezy-border-subtle)",
                    }}
                  >
                    <div
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        backgroundColor: typeColors[term.type] ?? "var(--ezy-text-muted)",
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ fontWeight: 500 }}>{typeLabels[term.type] ?? term.type}</span>
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        color: "var(--ezy-text-muted)",
                        fontSize: 11,
                      }}
                      title={term.workingDir}
                    >
                      {term.workingDir.split(/[\\/]/).pop() || term.workingDir}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}
