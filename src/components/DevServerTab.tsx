import { useState, useCallback, useRef, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../store";
import { getPtyWrite } from "../store/terminalSlice";
import { findAllBrowserPanes, addBrowserPaneRight, generateTerminalId } from "../lib/layout-utils";
import type { DevServer } from "../types";
import { getServerCommandSuggestions, BUILTIN_SERVER_COMMANDS, injectPort } from "../lib/server-commands";
import BrowserPreview from "./BrowserPreview";

function StatusDot({ status }: { status: DevServer["status"] }) {
  const color =
    status === "running"
      ? "var(--ezy-accent)"
      : status === "error"
        ? "var(--ezy-red)"
        : status === "stopped"
          ? "var(--ezy-red)"
          : "var(--ezy-text-muted)";
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        backgroundColor: color,
        flexShrink: 0,
      }}
    />
  );
}

function IconButton({
  title,
  onClick,
  children,
  danger,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <div
      title={title}
      style={{
        width: 28,
        height: 28,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 6,
        cursor: "pointer",
        transition: "background-color 120ms ease",
      }}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = danger
          ? "rgba(220,60,60,0.15)"
          : "var(--ezy-accent-glow)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      {children}
    </div>
  );
}

/** Open a browser preview pane on the far right of the project tab */
function openBrowserInProjectTab(tabId: string, url: string) {
  const store = useAppStore.getState();
  const tab = store.tabs.find((t) => t.id === tabId);
  if (!tab) return;

  // Check if a browser pane with this base URL already exists
  const existingBrowsers = findAllBrowserPanes(tab.layout);
  const baseUrl = url.replace(/\/$/, "");
  if (existingBrowsers.some((b) => b.url.replace(/\/$/, "") === baseUrl)) {
    // Already open — just switch to the tab
    store.setActiveTab(tabId);
    return;
  }

  // Add browser pane on the far right
  const { layout } = addBrowserPaneRight(tab.layout, url, 35);
  store.updateTabLayout(tabId, layout);
  store.setActiveTab(tabId);
}

function DevServerRow({ server, onPreview }: { server: DevServer; onPreview: (url: string) => void }) {
  const updateDevServerCommand = useAppStore((s) => s.updateDevServerCommand);
  const updateDevServerStatus = useAppStore((s) => s.updateDevServerStatus);
  const updateDevServerError = useAppStore((s) => s.updateDevServerError);
  const updateDevServerPort = useAppStore((s) => s.updateDevServerPort);
  const updateProjectServerCommand = useAppStore((s) => s.updateProjectServerCommand);
  const setExpandedDevServerId = useAppStore((s) => s.setExpandedDevServerId);

  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(server.command);
  const [editingPort, setEditingPort] = useState(false);
  const [portValue, setPortValue] = useState(String(server.port));

  const serverUrl = server.port > 0 ? `http://localhost:${server.port}` : null;


  const handleRestart = useCallback(() => {
    const write = getPtyWrite(server.terminalId);
    if (write) {
      write("\x03"); // Ctrl+C
      setTimeout(() => write("\x03"), 100); // Second Ctrl+C for stubborn processes
      setTimeout(() => {
        write(server.command + "\r");
      }, 1500);
    }
    updateDevServerStatus(server.id, "running");
    updateDevServerError(server.id, undefined);
  }, [server, updateDevServerStatus, updateDevServerError]);

  const handleStop = useCallback(() => {
    const write = getPtyWrite(server.terminalId);
    if (write) {
      write("\x03"); // Ctrl+C
    }
    updateDevServerStatus(server.id, "stopped");
  }, [server, updateDevServerStatus]);

  const handleStart = useCallback(() => {
    const write = getPtyWrite(server.terminalId);
    if (write) {
      write(server.command + "\r");
    }
    updateDevServerStatus(server.id, "running");
    updateDevServerError(server.id, undefined);
  }, [server, updateDevServerStatus, updateDevServerError]);

  const handleSaveEdit = useCallback(() => {
    const trimmed = editValue.trim();
    const commandChanged = trimmed && trimmed !== server.command;
    if (commandChanged) {
      updateDevServerCommand(server.id, trimmed);
      updateProjectServerCommand(server.workingDir, trimmed);
    }

    const num = parseInt(portValue, 10);
    const portChanged = num > 0 && num <= 65535 && num !== server.port;
    if (portChanged) {
      updateDevServerPort(server.id, num);
    }

    // Restart server if port changed (inject --port flag)
    if (portChanged) {
      const baseCmd = commandChanged ? trimmed : server.command;
      const cmdWithPort = injectPort(baseCmd, num);
      const write = getPtyWrite(server.terminalId);
      if (write) {
        write("\x03");
        setTimeout(() => write("\x03"), 100);
        setTimeout(() => write(cmdWithPort + "\r"), 1500);
      }
      updateDevServerStatus(server.id, "running");
      updateDevServerError(server.id, undefined);
    }

    setEditing(false);
    setEditingPort(false);
  }, [editValue, portValue, server, updateDevServerCommand, updateDevServerPort, updateDevServerStatus, updateDevServerError, updateProjectServerCommand]);

  const handleCancelEdit = useCallback(() => {
    setEditValue(server.command);
    setEditing(false);
    setEditingPort(false);
  }, [server.command]);

  const handleUrlClick = useCallback(
    (e: React.MouseEvent) => {
      if (!serverUrl) return;
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+Click: open in default browser
        e.preventDefault();
        openUrl(serverUrl).catch(() => {});
      } else {
        // Regular click: in-app preview
        onPreview(serverUrl);
      }
    },
    [serverUrl, onPreview]
  );

  const hasError = server.status === "error" && server.errorMessage;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        border: `1px solid ${server.status === "error" ? "var(--ezy-red)" : "var(--ezy-border)"}`,
        borderRadius: 8,
        boxSizing: "border-box",
        overflow: "hidden",
      }}
    >
      <div
        className="devserver-row"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 16px",
          height: 44,
          boxSizing: "border-box",
          containerType: "inline-size",
        }}
      >
      <StatusDot status={server.status} />

      {/* Project name */}
      <span
        style={{
          fontSize: 12,
          fontWeight: 500,
          color: "var(--ezy-text-muted)",
          flexShrink: 0,
          maxWidth: 120,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {server.projectName}
      </span>

      {editing ? (
        <input
          autoFocus
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSaveEdit();
            if (e.key === "Escape") handleCancelEdit();
          }}
          style={{
            flex: 1,
            minWidth: 0,
            padding: "3px 8px",
            fontSize: 13,
            fontWeight: 600,
            color: "var(--ezy-text)",
            backgroundColor: "var(--ezy-bg)",
            border: "1px solid var(--ezy-accent)",
            borderRadius: 4,
            outline: "none",
            fontFamily: "inherit",
          }}
        />
      ) : (
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 13,
            fontWeight: 600,
            color: "var(--ezy-text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {server.command}
        </span>
      )}

      {/* URL / port */}
      {editing && editingPort ? (
        <input
          value={portValue}
          onChange={(e) => setPortValue(e.target.value.replace(/\D/g, ""))}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSaveEdit();
            if (e.key === "Escape") handleCancelEdit();
          }}
          placeholder="port"
          style={{
            width: 60,
            padding: "2px 6px",
            fontSize: 12,
            color: "var(--ezy-cyan)",
            backgroundColor: "var(--ezy-bg)",
            border: "1px solid var(--ezy-accent)",
            borderRadius: 4,
            outline: "none",
            fontFamily: "inherit",
            flexShrink: 0,
          }}
        />
      ) : serverUrl ? (
        <span
          onClick={handleUrlClick}
          title={`${serverUrl} — Click for preview / Ctrl+Click to open in browser`}
          className="devserver-url"
          style={{
            fontSize: 12,
            color: "var(--ezy-cyan)",
            cursor: "pointer",
            flexShrink: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            borderBottom: "1px solid transparent",
            transition: "border-color 120ms ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderBottomColor = "var(--ezy-cyan)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderBottomColor = "transparent";
          }}
        >
          <span className="devserver-url-full">{serverUrl}</span>
          <span className="devserver-url-port">:{server.port}</span>
        </span>
      ) : (
        <span
          style={{
            fontSize: 11,
            color: "var(--ezy-text-muted)",
            flexShrink: 0,
            opacity: 0.5,
          }}
        >
          detecting...
        </span>
      )}

      {/* Action buttons */}
      <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
        {/* Restart */}
        <IconButton title="Restart" onClick={handleRestart}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.3" strokeLinecap="round">
            <path d="M3.5 2v4h4" />
            <path d="M3.5 6A5.5 5.5 0 1 1 2.5 8" />
          </svg>
        </IconButton>

        {/* Edit (toggle) */}
        <IconButton
          title={editing ? "Done editing" : "Edit command & port"}
          onClick={() => {
            if (editing) {
              handleSaveEdit();
            } else {
              setEditValue(server.command);
              setPortValue(String(server.port || ""));
              setEditing(true);
              setEditingPort(true);
            }
          }}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke={editing ? "var(--ezy-accent)" : "var(--ezy-text-muted)"} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11.5 1.5l3 3L5 14H2v-3z" />
            <line x1="9.5" y1="3.5" x2="12.5" y2="6.5" />
          </svg>
        </IconButton>

        {/* Stop / Play */}
        {server.status === "running" ? (
          <IconButton title="Stop" onClick={handleStop} danger>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="var(--ezy-text-muted)">
              <rect x="1" y="1" width="10" height="10" rx="1.5" />
            </svg>
          </IconButton>
        ) : (
          <IconButton title="Start" onClick={handleStart}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="var(--ezy-accent)">
              <polygon points="2,1 11,6 2,11" />
            </svg>
          </IconButton>
        )}

        {/* Expand */}
        <IconButton
          title="Expand terminal"
          onClick={() => setExpandedDevServerId(server.id)}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="10,2 14,2 14,6" />
            <line x1="14" y1="2" x2="9" y2="7" />
            <polyline points="6,14 2,14 2,10" />
            <line x1="2" y1="14" x2="7" y2="9" />
          </svg>
        </IconButton>
      </div>
    </div>

      {/* Error message row */}
      {hasError && (
        <div
          style={{
            padding: "4px 16px 6px",
            fontSize: 11,
            color: "var(--ezy-red)",
            borderTop: "1px solid var(--ezy-red)",
            backgroundColor: "rgba(220,60,60,0.06)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {server.errorMessage}
        </div>
      )}
    </div>
  );
}


function AddServerForm({ onClose }: { onClose: () => void }) {
  const recentProjects = useAppStore((s) => s.recentProjects);
  const addTerminal = useAppStore((s) => s.addTerminal);
  const addDevServer = useAppStore((s) => s.addDevServer);
  const addCustomServerCommand = useAppStore((s) => s.addCustomServerCommand);
  const removeCustomServerCommand = useAppStore((s) => s.removeCustomServerCommand);

  const [selectedPath, setSelectedPath] = useState("");
  const [selectedName, setSelectedName] = useState("");
  const [command, setCommand] = useState("");
  const [showCmdDropdown, setShowCmdDropdown] = useState(false);
  const [showProjectDropdown, setShowProjectDropdown] = useState(false);
  const cmdInputRef = useRef<HTMLInputElement>(null);
  const projectDropdownRef = useRef<HTMLDivElement>(null);
  const cmdDropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdowns on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (showProjectDropdown && projectDropdownRef.current && !projectDropdownRef.current.contains(e.target as Node)) {
        setShowProjectDropdown(false);
      }
      if (showCmdDropdown && cmdDropdownRef.current && !cmdDropdownRef.current.contains(e.target as Node)) {
        setShowCmdDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showProjectDropdown, showCmdDropdown]);

  const suggestions = getServerCommandSuggestions(command.trim() || undefined);

  const handleBrowse = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select Project Directory",
      });
      if (selected && typeof selected === "string") {
        const name = selected.split(/[\\/]/).pop() || "Project";
        setSelectedPath(selected);
        setSelectedName(name);
        setShowProjectDropdown(false);
      }
    } catch {
      // User cancelled
    }
  }, []);

  const handleStart = useCallback(() => {
    if (!selectedPath || !command.trim()) return;
    const trimmed = command.trim();
    // Add to custom commands if not a built-in
    if (!BUILTIN_SERVER_COMMANDS.includes(trimmed)) {
      addCustomServerCommand(trimmed);
    }
    const terminalId = generateTerminalId();
    addTerminal(terminalId, "devserver", selectedPath);
    addDevServer({
      id: `ds-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      terminalId,
      tabId: "",
      projectName: selectedName,
      command: trimmed,
      workingDir: selectedPath,
      port: 0,
      status: "running",
    });
    onClose();
  }, [selectedPath, selectedName, command, addTerminal, addDevServer, addCustomServerCommand, onClose]);

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "6px 10px",
    fontSize: 13,
    color: "var(--ezy-text)",
    backgroundColor: "var(--ezy-bg)",
    border: "1px solid var(--ezy-border-light)",
    borderRadius: 6,
    outline: "none",
    fontFamily: "inherit",
    boxSizing: "border-box",
  };

  return (
    <div
      style={{
        border: "1px solid var(--ezy-border)",
        borderRadius: 8,
        padding: 16,
        backgroundColor: "var(--ezy-surface)",
        marginBottom: 12,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ezy-text)" }}>Add Dev Server</span>
        <svg
          width="14" height="14" viewBox="0 0 16 16"
          fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.5" strokeLinecap="round"
          style={{ cursor: "pointer" }}
          onClick={onClose}
        >
          <line x1="4" y1="4" x2="12" y2="12" />
          <line x1="12" y1="4" x2="4" y2="12" />
        </svg>
      </div>

      {/* Project selector */}
      <div ref={projectDropdownRef} style={{ marginBottom: 10, position: "relative" }}>
        <label style={{ fontSize: 11, color: "var(--ezy-text-muted)", marginBottom: 4, display: "block" }}>
          Project directory
        </label>
        <div
          onClick={() => setShowProjectDropdown(!showProjectDropdown)}
          style={{
            ...inputStyle,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            minHeight: 32,
            color: selectedPath ? "var(--ezy-text)" : "var(--ezy-text-muted)",
          }}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
            {selectedPath ? `${selectedName} — ${selectedPath}` : "Select a project..."}
          </span>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.2" strokeLinecap="round" style={{ flexShrink: 0, marginLeft: 8 }}>
            <polyline points="2,3.5 5,6.5 8,3.5" />
          </svg>
        </div>

        {showProjectDropdown && (
          <div
            style={{
              position: "absolute",
              top: "100%",
              left: 0,
              right: 0,
              marginTop: 4,
              backgroundColor: "var(--ezy-surface)",
              border: "1px solid var(--ezy-border)",
              borderRadius: 6,
              maxHeight: 200,
              overflowY: "auto",
              zIndex: 20,
              boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
            }}
          >
            {/* Browse option */}
            <div
              style={{
                padding: "8px 12px",
                fontSize: 13,
                color: "var(--ezy-accent)",
                cursor: "pointer",
                borderBottom: recentProjects.length > 0 ? "1px solid var(--ezy-border-subtle)" : "none",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
              onClick={handleBrowse}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                <path d="M2 4v8a1 1 0 001 1h10a1 1 0 001-1V6a1 1 0 00-1-1H8L6.5 3.5A1 1 0 005.79 3H3a1 1 0 00-1 1z" />
              </svg>
              Browse...
            </div>

            {/* Recent projects */}
            {recentProjects.map((project) => (
              <div
                key={project.id}
                style={{
                  padding: "8px 12px",
                  fontSize: 13,
                  color: "var(--ezy-text)",
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                }}
                onClick={() => {
                  setSelectedPath(project.path);
                  setSelectedName(project.name);
                  if (project.serverCommand && !command) {
                    setCommand(project.serverCommand);
                  }
                  setShowProjectDropdown(false);
                }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
              >
                <span style={{ fontWeight: 500 }}>{project.name}</span>
                <span style={{ fontSize: 11, color: "var(--ezy-text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {project.path}
                  {project.serverCommand && <span style={{ color: "var(--ezy-accent)", marginLeft: 8 }}>{project.serverCommand}</span>}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Server command input */}
      <div ref={cmdDropdownRef} style={{ marginBottom: 14, position: "relative" }}>
        <label style={{ fontSize: 11, color: "var(--ezy-text-muted)", marginBottom: 4, display: "block" }}>
          Server command
        </label>
        <div style={{ position: "relative" }}>
          <input
            ref={cmdInputRef}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onFocus={() => setShowCmdDropdown(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { handleStart(); }
              if (e.key === "Escape") { setShowCmdDropdown(false); cmdInputRef.current?.blur(); }
            }}
            placeholder="e.g. npm run dev"
            style={inputStyle}
          />
          <svg
            width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.2" strokeLinecap="round"
            style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", cursor: "pointer" }}
            onMouseDown={(e) => {
              e.preventDefault(); // prevent input blur
              setShowCmdDropdown((v) => !v);
              cmdInputRef.current?.focus();
            }}
          >
            <polyline points="2,3.5 5,6.5 8,3.5" />
          </svg>
        </div>

        {showCmdDropdown && suggestions.length > 0 && (
          <div
            style={{
              position: "absolute",
              top: "100%",
              left: 0,
              right: 0,
              marginTop: 4,
              backgroundColor: "var(--ezy-surface)",
              border: "1px solid var(--ezy-border)",
              borderRadius: 6,
              maxHeight: 160,
              overflowY: "auto",
              zIndex: 20,
              boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
            }}
          >
            {suggestions.map(({ command: cmd, isCustom }) => (
              <div
                key={cmd}
                style={{
                  padding: "6px 12px",
                  fontSize: 13,
                  color: "var(--ezy-text)",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setCommand(cmd);
                  setShowCmdDropdown(false);
                }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
              >
                <span>{cmd}</span>
                {isCustom && (
                  <svg
                    width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.3" strokeLinecap="round"
                    className="devserver-cmd-remove"
                    style={{ flexShrink: 0, opacity: 0, transition: "opacity 100ms ease", cursor: "pointer" }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      removeCustomServerCommand(cmd);
                    }}
                  >
                    <line x1="2" y1="2" x2="8" y2="8" />
                    <line x1="8" y1="2" x2="2" y2="8" />
                  </svg>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Start button */}
      <div
        onClick={handleStart}
        style={{
          padding: "7px 16px",
          fontSize: 13,
          fontWeight: 600,
          color: !selectedPath || !command.trim() ? "var(--ezy-text-muted)" : "#fff",
          backgroundColor: !selectedPath || !command.trim() ? "var(--ezy-border)" : "var(--ezy-accent)",
          borderRadius: 6,
          cursor: !selectedPath || !command.trim() ? "default" : "pointer",
          textAlign: "center",
          transition: "background-color 120ms ease",
          opacity: !selectedPath || !command.trim() ? 0.5 : 1,
        }}
      >
        Start Server
      </div>
    </div>
  );
}

export default function DevServerTab() {
  const devServers = useAppStore((s) => s.devServers);
  const previewInProjectTab = useAppStore((s) => s.previewInProjectTab);
  const setPreviewInProjectTab = useAppStore((s) => s.setPreviewInProjectTab);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const handlePreview = useCallback(
    (url: string) => {
      if (previewInProjectTab) {
        // Find the server's tab and open browser there
        const server = devServers.find(
          (ds) => ds.port > 0 && `http://localhost:${ds.port}` === url
        );
        if (server) openBrowserInProjectTab(server.tabId, url);
      } else {
        setPreviewUrl(url);
      }
    },
    [previewInProjectTab, devServers]
  );

  const serverList = (
    <>
      {/* Header */}
      <div
        className="flex items-center justify-between select-none"
        style={{
          height: 48,
          padding: "0 20px",
          borderBottom: "1px solid var(--ezy-border)",
          backgroundColor: "var(--ezy-surface)",
        }}
      >
        <div className="flex items-center gap-3">
          <svg
            width="18"
            height="18"
            viewBox="0 0 16 16"
            fill="none"
            stroke="var(--ezy-accent)"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M8 1c0 0-5 3-5 8l2 3h6l2-3c0-5-5-8-5-8z" />
            <circle cx="8" cy="7" r="1.5" />
            <path d="M5 12l-1.5 3" />
            <path d="M11 12l1.5 3" />
          </svg>
          <span
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--ezy-text)",
              letterSpacing: "0.02em",
            }}
          >
            Dev Servers
          </span>
          <span style={{ fontSize: 12, color: "var(--ezy-text-muted)" }}>
            {devServers.length} active
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {/* Add server button */}
        <div
          title="Add dev server"
          style={{
            width: 26,
            height: 26,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 6,
            cursor: "pointer",
            border: "1px solid var(--ezy-border-light)",
            transition: "background-color 120ms ease",
          }}
          onClick={() => setShowAddForm(!showAddForm)}
          onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.5" strokeLinecap="round">
            <line x1="6" y1="1" x2="6" y2="11" />
            <line x1="1" y1="6" x2="11" y2="6" />
          </svg>
        </div>

        {/* Preview location toggle */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            cursor: "pointer",
          }}
          onClick={() => setPreviewInProjectTab(!previewInProjectTab)}
          title={previewInProjectTab ? "Preview opens in project tab" : "Preview opens here"}
        >
          <span style={{ fontSize: 11, color: "var(--ezy-text-muted)" }}>
            {previewInProjectTab ? "Preview in project" : "Preview here"}
          </span>
          <div
            style={{
              width: 32,
              height: 18,
              borderRadius: 9,
              backgroundColor: previewInProjectTab ? "var(--ezy-accent)" : "transparent",
              border: previewInProjectTab ? "none" : "1px solid var(--ezy-border-light)",
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
                backgroundColor: previewInProjectTab ? "#fff" : "var(--ezy-text-muted)",
                position: "absolute",
                top: 2,
                left: previewInProjectTab ? 16 : 2,
                transition: "left 150ms ease",
              }}
            />
          </div>
        </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-auto" style={{ padding: 20 }}>
        {showAddForm && (
          <AddServerForm onClose={() => setShowAddForm(false)} />
        )}

        {devServers.length === 0 && !showAddForm ? (
          <div
            className="flex flex-col items-center justify-center h-full"
            style={{ color: "var(--ezy-text-muted)" }}
          >
            <svg
              width="48"
              height="48"
              viewBox="0 0 16 16"
              fill="none"
              stroke="var(--ezy-border)"
              strokeWidth="0.8"
              style={{ marginBottom: 16 }}
            >
              <rect x="2" y="3" width="12" height="10" rx="1.5" />
              <circle cx="5" cy="8" r="1.2" fill="var(--ezy-border)" stroke="none" />
              <line x1="8" y1="8" x2="12" y2="8" strokeLinecap="round" />
            </svg>
            <p style={{ fontSize: 14, marginBottom: 4 }}>
              No dev servers running
            </p>
            <p style={{ fontSize: 12, color: "var(--ezy-border-light)" }}>
              Click + above to add a server, or set a command when creating a project tab
            </p>
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(460px, 1fr))",
              gap: 8,
            }}
          >
            {devServers.map((server) => (
              <DevServerRow key={server.id} server={server} onPreview={handlePreview} />
            ))}
          </div>
        )}
      </div>
    </>
  );

  // When preview is shown inline (Dev Servers tab mode), split the view
  if (previewUrl && !previewInProjectTab) {
    return (
      <div className="h-full w-full flex workspace-enter" style={{ backgroundColor: "var(--ezy-bg)" }}>
        <div className="flex flex-col" style={{ width: "40%", minWidth: 280, borderRight: "1px solid var(--ezy-border)" }}>
          {serverList}
        </div>
        <div className="flex-1 min-w-0">
          <BrowserPreview
            initialUrl={previewUrl}
            onClose={() => setPreviewUrl(null)}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      className="h-full w-full flex flex-col workspace-enter"
      style={{ backgroundColor: "var(--ezy-bg)" }}
    >
      {serverList}
    </div>
  );
}
