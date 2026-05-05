import { useState, useCallback, useRef, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FaFolder, FaChevronDown, FaStop, FaPlay, FaExpand, FaServer } from "react-icons/fa";
import { FaXmark, FaPlus, FaPencil } from "react-icons/fa6";
import { BiRefresh } from "react-icons/bi";
import { useAppStore } from "../store";
import ServersPanel from "./ServersPanel";
import { getPtyWrite } from "../store/terminalSlice";
import { findAllBrowserPanes, addBrowserPaneRight, generateTerminalId } from "../lib/layout-utils";
import type { DevServer } from "../types";
import { getServerCommandSuggestions, BUILTIN_SERVER_COMMANDS, injectPort } from "../lib/server-commands";

function StatusDot({ status }: { status: DevServer["status"] }) {
  const color =
    status === "running"
      ? "#4ade80"
      : status === "error"
        ? "#f87171"
        : status === "stopped"
          ? "#f87171"
          : "var(--ezy-text-muted)"; // "starting"
  return (
    <span
      style={{
        width: 6,
        height: 6,
        borderRadius: "50%",
        backgroundColor: color,
        flexShrink: 0,
        opacity: status === "starting" ? 0.6 : 1,
      }}
    />
  );
}

function SmallIconButton({
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
        width: 22,
        height: 22,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 4,
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

/** Open a browser preview pane on the far right of a tab */
function openBrowserInTab(tabId: string, url: string) {
  const store = useAppStore.getState();
  const tab = store.tabs.find((t) => t.id === tabId);
  if (!tab) return;

  if (!tab.layout) return;
  const existingBrowsers = findAllBrowserPanes(tab.layout);
  const baseUrl = url.replace(/\/$/, "");
  if (existingBrowsers.some((b) => b.url.replace(/\/$/, "") === baseUrl)) {
    store.setActiveTab(tabId);
    return;
  }

  const { layout } = addBrowserPaneRight(tab.layout, url, 35);
  store.updateTabLayout(tabId, layout);
  store.setActiveTab(tabId);
}

function DevServerRow({ server }: { server: DevServer }) {
  const removeDevServer = useAppStore((s) => s.removeDevServer);
  const updateDevServerCommand = useAppStore((s) => s.updateDevServerCommand);
  const updateDevServerStatus = useAppStore((s) => s.updateDevServerStatus);
  const updateDevServerError = useAppStore((s) => s.updateDevServerError);
  const updateDevServerPort = useAppStore((s) => s.updateDevServerPort);
  const updateProjectServerCommand = useAppStore((s) => s.updateProjectServerCommand);
  const setExpandedDevServerId = useAppStore((s) => s.setExpandedDevServerId);
  const previewInProjectTab = useAppStore((s) => s.previewInProjectTab);
  const activeTabId = useAppStore((s) => s.activeTabId);

  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(server.command);
  const [editingPort, setEditingPort] = useState(false);
  const [portValue, setPortValue] = useState(String(server.port));

  const serverUrl = server.port > 0 ? `http://localhost:${server.port}` : null;

  const handleRestart = useCallback(() => {
    const write = getPtyWrite(server.terminalId);
    if (write) {
      write("\x03");
      setTimeout(() => write("\x03"), 100);
      setTimeout(() => {
        write(server.command + "\r");
      }, 1500);
    }
    updateDevServerStatus(server.id, "starting");
    updateDevServerPort(server.id, 0);
    updateDevServerError(server.id, undefined);
  }, [server, updateDevServerStatus, updateDevServerPort, updateDevServerError]);

  const handleStop = useCallback(() => {
    const write = getPtyWrite(server.terminalId);
    if (write) {
      write("\x03");
    }
    updateDevServerStatus(server.id, "stopped");
  }, [server, updateDevServerStatus]);

  const handleStart = useCallback(() => {
    const write = getPtyWrite(server.terminalId);
    if (write) {
      write(server.command + "\r");
    }
    updateDevServerStatus(server.id, "starting");
    updateDevServerPort(server.id, 0);
    updateDevServerError(server.id, undefined);
  }, [server, updateDevServerStatus, updateDevServerPort, updateDevServerError]);

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

    if (portChanged) {
      const baseCmd = commandChanged ? trimmed : server.command;
      const cmdWithPort = injectPort(baseCmd, num);
      const write = getPtyWrite(server.terminalId);
      if (write) {
        write("\x03");
        setTimeout(() => write("\x03"), 100);
        setTimeout(() => write(cmdWithPort + "\r"), 1500);
      }
      updateDevServerStatus(server.id, "starting");
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
        e.preventDefault();
        openUrl(serverUrl).catch(() => {});
      } else {
        // Open preview in the server's project tab or the active tab
        const targetTabId = previewInProjectTab && server.tabId ? server.tabId : activeTabId;
        if (targetTabId) openBrowserInTab(targetTabId, serverUrl);
      }
    },
    [serverUrl, previewInProjectTab, server.tabId, activeTabId]
  );

  const hasError = server.status === "error" && server.errorMessage;

  return (
    <div
      style={{
        borderBottom: "1px solid var(--ezy-border-subtle)",
      }}
    >
      {/* Main row: status + name + actions */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 10px 2px",
        }}
      >
        <StatusDot status={server.status} />
        <span
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: "var(--ezy-text)",
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {server.projectName}
        </span>

        {/* Action buttons */}
        <div style={{ display: "flex", alignItems: "center", gap: 1, flexShrink: 0 }}>
          {server.status === "running" || server.status === "starting" ? (
            <SmallIconButton title="Stop" onClick={handleStop} danger>
              <FaStop size={9} color="var(--ezy-text-muted)" />
            </SmallIconButton>
          ) : (
            <SmallIconButton title="Start" onClick={handleStart}>
              <FaPlay size={9} color="var(--ezy-accent)" />
            </SmallIconButton>
          )}
          <SmallIconButton title="Restart" onClick={handleRestart}>
            <BiRefresh size={12} color="var(--ezy-text-muted)" style={{ transform: "scale(1.3)" }} />
          </SmallIconButton>
          <SmallIconButton
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
            <FaPencil size={10} color={editing ? "var(--ezy-accent)" : "var(--ezy-text-muted)"} />
          </SmallIconButton>
          <SmallIconButton
            title="Expand terminal"
            onClick={() => setExpandedDevServerId(server.id)}
          >
            <FaExpand size={10} color="var(--ezy-text-muted)" />
          </SmallIconButton>
          {(server.status === "stopped" || server.status === "error") && (
            <SmallIconButton title="Remove" onClick={() => removeDevServer(server.id)} danger>
              <FaXmark size={10} color="var(--ezy-text-muted)" />
            </SmallIconButton>
          )}
        </div>
      </div>

      {/* Second row: command + port */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0 10px 5px 22px",
        }}
      >
        {editing ? (
          <>
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
                padding: "2px 6px",
                fontSize: 11,
                fontWeight: 500,
                color: "var(--ezy-text)",
                backgroundColor: "var(--ezy-bg)",
                border: "1px solid var(--ezy-accent)",
                borderRadius: 3,
                outline: "none",
                fontFamily: "inherit",
              }}
            />
            {editingPort && (
              <input
                value={portValue}
                onChange={(e) => setPortValue(e.target.value.replace(/\D/g, ""))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveEdit();
                  if (e.key === "Escape") handleCancelEdit();
                }}
                placeholder="port"
                style={{
                  width: 44,
                  padding: "2px 4px",
                  fontSize: 11,
                  color: "var(--ezy-cyan)",
                  backgroundColor: "var(--ezy-bg)",
                  border: "1px solid var(--ezy-accent)",
                  borderRadius: 3,
                  outline: "none",
                  fontFamily: "inherit",
                  flexShrink: 0,
                }}
              />
            )}
          </>
        ) : (
          <>
            <span
              style={{
                fontSize: 11,
                color: "var(--ezy-text-muted)",
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {server.command}
            </span>
            {serverUrl ? (
              <span
                onClick={handleUrlClick}
                title={`${serverUrl} — Click for preview / Ctrl+Click to open in browser`}
                style={{
                  fontSize: 11,
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
                {serverUrl}
              </span>
            ) : server.status !== "stopped" ? (
              <span
                style={{
                  fontSize: 10,
                  color: "var(--ezy-text-muted)",
                  flexShrink: 0,
                  opacity: 0.5,
                }}
              >
                detecting...
              </span>
            ) : null}
          </>
        )}
      </div>

      {/* Error message */}
      {hasError && (
        <div
          style={{
            padding: "3px 10px 4px 22px",
            fontSize: 10,
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
  const [selectedServerId, setSelectedServerId] = useState<string | undefined>(undefined);
  const [command, setCommand] = useState("");
  const [showCmdDropdown, setShowCmdDropdown] = useState(false);
  const [showProjectDropdown, setShowProjectDropdown] = useState(false);
  const cmdInputRef = useRef<HTMLInputElement>(null);
  const projectDropdownRef = useRef<HTMLDivElement>(null);
  const cmdDropdownRef = useRef<HTMLDivElement>(null);

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
        setSelectedServerId(undefined);
        setShowProjectDropdown(false);
      }
    } catch {
      // User cancelled
    }
  }, []);

  const handleStart = useCallback(() => {
    if (!selectedPath || !command.trim()) return;
    // Skip if a dev server already exists for the same project + server
    const norm = (p: string) => p.replace(/\\/g, "/");
    const existing = useAppStore.getState().devServers.find(
      (ds) => norm(ds.workingDir) === norm(selectedPath) && ds.serverId === selectedServerId
    );
    if (existing) { onClose(); return; }

    const trimmed = command.trim();
    if (!BUILTIN_SERVER_COMMANDS.includes(trimmed)) {
      addCustomServerCommand(trimmed);
    }
    const terminalId = generateTerminalId();
    addTerminal(terminalId, "devserver", selectedPath, selectedServerId);
    addDevServer({
      id: `ds-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      terminalId,
      tabId: "",
      projectName: selectedName,
      command: trimmed,
      workingDir: selectedPath,
      port: 0,
      status: "starting",
      serverId: selectedServerId,
    });
    onClose();
  }, [selectedPath, selectedName, selectedServerId, command, addTerminal, addDevServer, addCustomServerCommand, onClose]);

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "4px 8px",
    fontSize: 12,
    color: "var(--ezy-text)",
    backgroundColor: "var(--ezy-bg)",
    border: "1px solid var(--ezy-border-light)",
    borderRadius: 4,
    outline: "none",
    fontFamily: "inherit",
    boxSizing: "border-box",
  };

  return (
    <div
      style={{
        padding: "8px 10px",
        borderBottom: "1px solid var(--ezy-border)",
        backgroundColor: "var(--ezy-surface)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--ezy-text)" }}>Add Dev Server</span>
        <FaXmark
          size={12}
          color="var(--ezy-text-muted)"
          style={{ cursor: "pointer" }}
          onClick={onClose}
        />
      </div>

      {/* Project selector */}
      <div ref={projectDropdownRef} style={{ marginBottom: 6, position: "relative" }}>
        <label style={{ fontSize: 10, color: "var(--ezy-text-muted)", marginBottom: 2, display: "block" }}>
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
            minHeight: 28,
            color: selectedPath ? "var(--ezy-text)" : "var(--ezy-text-muted)",
          }}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, fontSize: 11 }}>
            {selectedPath ? selectedName : "Select a project..."}
          </span>
          <FaChevronDown size={8} color="var(--ezy-text-muted)" style={{ flexShrink: 0, marginLeft: 4 }} />
        </div>

        {showProjectDropdown && (
          <div
            style={{
              position: "absolute",
              top: "100%",
              left: 0,
              right: 0,
              marginTop: 2,
              backgroundColor: "var(--ezy-surface)",
              border: "1px solid var(--ezy-border)",
              borderRadius: 4,
              maxHeight: 180,
              overflowY: "auto",
              zIndex: 20,
              boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
            }}
          >
            <div
              style={{
                padding: "6px 10px",
                fontSize: 12,
                color: "var(--ezy-accent)",
                cursor: "pointer",
                borderBottom: recentProjects.length > 0 ? "1px solid var(--ezy-border-subtle)" : "none",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
              onClick={handleBrowse}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
            >
              <FaFolder size={12} color="currentColor" />
              Browse...
            </div>

            {recentProjects.map((project) => (
              <div
                key={project.id}
                style={{
                  padding: "5px 10px",
                  fontSize: 12,
                  color: "var(--ezy-text)",
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  gap: 1,
                }}
                onClick={() => {
                  setSelectedPath(project.path);
                  setSelectedName(project.name);
                  setSelectedServerId(project.serverId);
                  if (project.serverCommand && !command) {
                    setCommand(project.serverCommand);
                  }
                  setShowProjectDropdown(false);
                }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
              >
                <span style={{ fontWeight: 500 }}>{project.name}</span>
                <span style={{ fontSize: 10, color: "var(--ezy-text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {project.path}
                  {project.serverCommand && <span style={{ color: "var(--ezy-accent)", marginLeft: 6 }}>{project.serverCommand}</span>}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Server command input */}
      <div ref={cmdDropdownRef} style={{ marginBottom: 8, position: "relative" }}>
        <label style={{ fontSize: 10, color: "var(--ezy-text-muted)", marginBottom: 2, display: "block" }}>
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
          <FaChevronDown
            size={8}
            color="var(--ezy-text-muted)"
            style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", cursor: "pointer" }}
            onMouseDown={(e) => {
              e.preventDefault();
              setShowCmdDropdown((v) => !v);
              cmdInputRef.current?.focus();
            }}
          />
        </div>

        {showCmdDropdown && suggestions.length > 0 && (
          <div
            style={{
              position: "absolute",
              top: "100%",
              left: 0,
              right: 0,
              marginTop: 2,
              backgroundColor: "var(--ezy-surface)",
              border: "1px solid var(--ezy-border)",
              borderRadius: 4,
              maxHeight: 140,
              overflowY: "auto",
              zIndex: 20,
              boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
            }}
          >
            {suggestions.map(({ command: cmd, isCustom }) => (
              <div
                key={cmd}
                style={{
                  padding: "5px 10px",
                  fontSize: 12,
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
                  <FaXmark
                    size={9}
                    color="var(--ezy-text-muted)"
                    className="devserver-cmd-remove"
                    style={{ flexShrink: 0, opacity: 0, transition: "opacity 100ms ease", cursor: "pointer" }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      removeCustomServerCommand(cmd);
                    }}
                  />
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
          padding: "5px 12px",
          fontSize: 12,
          fontWeight: 600,
          color: !selectedPath || !command.trim() ? "var(--ezy-text-muted)" : "#fff",
          backgroundColor: !selectedPath || !command.trim() ? "var(--ezy-border)" : "var(--ezy-accent)",
          borderRadius: 4,
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
  const [showAddForm, setShowAddForm] = useState(false);
  const [showRemoteServers, setShowRemoteServers] = useState(true);

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
      {/* Compact header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 10px",
          height: 34,
          borderBottom: "1px solid var(--ezy-border-subtle)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: "var(--ezy-text-muted)", letterSpacing: "0.04em", textTransform: "uppercase" }}>
            Dev Servers
          </span>
          {devServers.length > 0 && (
            <span style={{ fontSize: 10, color: "var(--ezy-text-muted)", opacity: 0.6 }}>
              {devServers.length}
            </span>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {/* Remote servers toggle */}
          <div
            title={showRemoteServers ? "Hide Remote Servers" : "Show Remote Servers"}
            style={{
              width: 20,
              height: 20,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 4,
              cursor: "pointer",
              transition: "background-color 120ms ease",
              backgroundColor: showRemoteServers ? "var(--ezy-accent-glow)" : "transparent",
            }}
            onClick={() => setShowRemoteServers(!showRemoteServers)}
            onMouseEnter={(e) => { if (!showRemoteServers) e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"; }}
            onMouseLeave={(e) => { if (!showRemoteServers) e.currentTarget.style.backgroundColor = "transparent"; }}
          >
            <FaServer size={9} color={showRemoteServers ? "var(--ezy-accent)" : "var(--ezy-text-muted)"} />
          </div>
          {/* Add server button */}
          <div
            title="Add dev server"
            style={{
              width: 20,
              height: 20,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 4,
              cursor: "pointer",
              transition: "background-color 120ms ease",
            }}
            onClick={() => setShowAddForm(!showAddForm)}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
          >
            <FaPlus size={10} color="var(--ezy-text-muted)" />
          </div>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {showAddForm && (
          <AddServerForm onClose={() => setShowAddForm(false)} />
        )}

        {devServers.length === 0 && !showAddForm ? (
          <div
            style={{
              padding: 16,
              textAlign: "center",
              color: "var(--ezy-text-muted)",
            }}
          >
            <svg
              width="28"
              height="28"
              viewBox="0 0 16 16"
              fill="none"
              stroke="var(--ezy-border)"
              strokeWidth="0.8"
              style={{ margin: "0 auto 8px" }}
            >
              <rect x="2" y="3" width="12" height="10" rx="1.5" />
              <circle cx="5" cy="8" r="1.2" fill="var(--ezy-border)" stroke="none" />
              <line x1="8" y1="8" x2="12" y2="8" strokeLinecap="round" />
            </svg>
            <p style={{ fontSize: 11, marginBottom: 2 }}>
              No dev servers
            </p>
            <p style={{ fontSize: 10, color: "var(--ezy-border-light)" }}>
              Click + to add one
            </p>
          </div>
        ) : (
          devServers.map((server) => (
            <DevServerRow key={server.id} server={server} />
          ))
        )}

        {/* Inline Remote Servers section */}
        {showRemoteServers && (
          <div style={{ borderTop: "1px solid var(--ezy-border-subtle)" }}>
            <ServersPanel compact />
          </div>
        )}
      </div>
    </div>
  );
}
