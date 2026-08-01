import { useState, useCallback, useRef, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { registerSurfaceActions, unregisterSurfaceActions } from "../lib/surface-actions";
import { openDevServerUrlIn, wantsInAppOpen } from "../lib/open-dev-server-url";
import { FaFolder, FaChevronDown, FaStop, FaPlay, FaExpand, FaServer } from "react-icons/fa";
import { FaXmark, FaPlus, FaPencil } from "react-icons/fa6";
import { BiRefresh } from "react-icons/bi";
import { useAppStore } from "../store";
import { useOverlayMenu } from "../lib/useOverlayMenu";
import ServersPanel from "./ServersPanel";
import { getPtyWrite } from "../store/terminalSlice";
import { generateTerminalId } from "../lib/layout-utils";
import { resolveDevServerBackend } from "../lib/spawn-dev-server";
import { getDefaultBackend } from "../lib/platform";
import type { DevServer } from "../types";
import {
  getServerCommandSuggestions,
  BUILTIN_SERVER_COMMANDS,
  injectPort,
  stripPort,
  explicitPortInCommand,
  resolveDefaultPort,
  injectHost,
  stripHost,
  hasHostFlag,
  detectHostStyleForProject,
  type HostStyle,
} from "../lib/server-commands";

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
      data-tooltip={title}
      style={{
        width: 22,
        height: 22,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
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

/** Tag a captured Network URL — Tailscale (100.64.0.0/10), private LAN, or generic. */
function classifyHost(url: string): string {
  const m = url.match(/^https?:\/\/([^:/]+)/);
  const host = m ? m[1] : url;
  if (/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return "Tailscale";
  if (/^192\.168\./.test(host) || /^10\./.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) return "LAN";
  return "Network";
}

/**
 * Card that floats above the URL link after a 3s hover, listing every
 * known address (Local + LAN/Tailscale/etc.) so the user can pick one.
 * Anchored via getBoundingClientRect so it can escape the sidebar's
 * overflow:hidden, and rendered through a portal for the same reason.
 */

function DevServerRow({ server }: { server: DevServer }) {
  const removeDevServer = useAppStore((s) => s.removeDevServer);
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
  // Host-flag spelling and default port for THIS project, resolved only while
  // the row is being edited — a sidebar of idle dev servers should not each go
  // read a package.json, still less a config file over SSH.
  const [hostStyle, setHostStyle] = useState<HostStyle>("vite");
  // null = not resolved yet. Starting at a number would flash a WRONG default
  // (3000) before correcting to, say, 5173 — a badge that lies briefly is worse
  // than one that admits it is still looking.
  const [defaultPort, setDefaultPort] = useState<number | null>(null);
  const [defaultPortSource, setDefaultPortSource] = useState<"framework" | "config">("framework");
  useEffect(() => {
    if (!editing) return;
    let cancelled = false;
    void detectHostStyleForProject(server.workingDir, editValue, server.serverId).then((s) => {
      if (!cancelled) setHostStyle(s);
    });
    void resolveDefaultPort(server.workingDir, editValue, server.serverId).then((r) => {
      if (cancelled) return;
      setDefaultPort(r.port);
      setDefaultPortSource(r.fromConfig ? "config" : "framework");
    });
    return () => { cancelled = true; };
    // editValue is deliberately not a dep: re-reading package.json and a config
    // file on every keystroke would be several SSH round trips per character on
    // a remote project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, server.workingDir, server.serverId]);

  /** A port this server was explicitly given, as opposed to the framework's. */
  const customPort = explicitPortInCommand(editValue);

  const serverUrl = server.port > 0 ? `http://localhost:${server.port}` : null;
  const networkUrls = server.networkUrls ?? [];

  // 3-second-hover popover that lists every detected address (Local + LAN/Tailscale).
  const urlSpanRef = useRef<HTMLSpanElement>(null);
  const [popoverRect, setPopoverRect] = useState<DOMRect | null>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelOpenTimer = useCallback(() => {
    if (openTimerRef.current) { clearTimeout(openTimerRef.current); openTimerRef.current = null; }
  }, []);
  const cancelCloseTimer = useCallback(() => {
    if (closeTimerRef.current) { clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
  }, []);
  const scheduleOpen = useCallback(() => {
    if (networkUrls.length === 0) return; // nothing extra to show
    cancelCloseTimer();
    cancelOpenTimer();
    openTimerRef.current = setTimeout(() => {
      const rect = urlSpanRef.current?.getBoundingClientRect();
      if (rect) setPopoverRect(rect);
    }, 3000);
  }, [networkUrls.length, cancelOpenTimer, cancelCloseTimer]);
  const scheduleClose = useCallback(() => {
    // Only cancels a PENDING open. Once open, the popover is an overlay
    // backdrop menu — outside click / Escape / selection dismiss it (the
    // old 180ms hover-close would kill it before the pointer arrived, since
    // the overlay webview can't cancel this timer).
    cancelOpenTimer();
    cancelCloseTimer();
  }, [cancelOpenTimer, cancelCloseTimer]);

  useEffect(() => () => { cancelOpenTimer(); cancelCloseTimer(); }, [cancelOpenTimer, cancelCloseTimer]);
  // URL popover — overlay-rendered (kind "anchored-menu"); Ctrl+click state
  // rides back in the action's data ({ ctrl }) for open-in-external-browser.
  useOverlayMenu({
    id: "dev-server-tab-urls",
    open: !!popoverRect && !!serverUrl,
    anchorRect:
      popoverRect
        ? {
            x: popoverRect.left,
            y: popoverRect.top,
            width: popoverRect.width,
            height: popoverRect.height,
          }
        : null,
    payload:
      popoverRect && serverUrl
        ? {
            placement: "above-end",
            gap: 8,
            sections: [
              {
                title: "Server addresses",
                items: [
                  { actionId: "url:0", label: serverUrl, shortcut: "LOCAL" },
                  ...networkUrls.map((u, i) => ({
                    actionId: `url:${i + 1}`,
                    label: u,
                    shortcut: classifyHost(u),
                  })),
                ],
              },
            ],
          }
        : null,
    onAction: (actionId, data) => {
      if (!actionId.startsWith("url:") || !serverUrl) return;
      const urls = [serverUrl, ...networkUrls];
      const url = urls[Number(actionId.slice(4))];
      if (url) {
        const ctrl = !!(data as { ctrl?: boolean } | undefined)?.ctrl;
        openServerUrl(url, ctrl);
      }
    },
    onClose: () => setPopoverRect(null),
  });


  // Drop the popover if the URL list changes out from under it
  useEffect(() => { if (networkUrls.length === 0) setPopoverRect(null); }, [networkUrls.length]);

  const restartRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    // Each DevServerTab renders ONE server, so the registry entry is replaced
    // by whichever row mounted last; the handler is re-pointed per id below.
    registerSurfaceActions("devserver", {
      restart: (id) => { if (id === server.id) restartRef.current?.(); },
    });
    return () => unregisterSurfaceActions("devserver");
  }, [server.id]);

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
  restartRef.current = handleRestart;

  const handleStop = useCallback(() => {
    const write = getPtyWrite(server.terminalId);
    if (write) {
      write("\x03");
    }
    updateDevServerStatus(server.id, "stopped");
  }, [server, updateDevServerStatus]);

  // Remove forgets the saved command (Stop keeps it): clear the persisted
  // project command so it won't be restored on next launch.
  const handleRemove = useCallback(() => {
    removeDevServer(server.id);
    updateProjectServerCommand(server.workingDir, undefined, server.serverId);
  }, [server, removeDevServer, updateProjectServerCommand]);

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
      updateProjectServerCommand(server.workingDir, trimmed, server.serverId);
    }

    // The port now rides IN the command text (`-- --port 3001`), the same way
    // the network flag does, so "did the port change" is a question about the
    // command rather than about a separate field. Restarting is still gated on
    // the PORT changing, not on any command edit — fixing a typo in a running
    // server's command should not kill it.
    const prevPort = explicitPortInCommand(server.command);
    const nextPort = explicitPortInCommand(trimmed);
    if (nextPort !== prevPort) {
      // 0 = "unknown, re-detect from output" — which is exactly true across a
      // restart, and what keeps the dot from claiming "running" on a port that
      // no longer exists.
      updateDevServerPort(server.id, nextPort ?? 0);
      const write = getPtyWrite(server.terminalId);
      if (write) {
        write("\x03");
        setTimeout(() => write("\x03"), 100);
        setTimeout(() => write(trimmed + "\r"), 1500);
      }
      updateDevServerStatus(server.id, "starting");
      updateDevServerError(server.id, undefined);
    }

    setEditing(false);
    setEditingPort(false);
  }, [editValue, server, updateDevServerCommand, updateDevServerPort, updateDevServerStatus, updateDevServerError, updateProjectServerCommand]);

  const handleCancelEdit = useCallback(() => {
    setEditValue(server.command);
    setEditing(false);
    setEditingPort(false);
  }, [server.command]);

  // Unified click contract (2026-07-29): plain click = external browser,
  // Ctrl/Cmd+Click = MADE browser pane — the same mapping as terminal links
  // and the header/tab quick-open icons. (This used to be inverted here.)
  const openServerUrl = useCallback(
    (url: string, inApp: boolean) => {
      openDevServerUrlIn(server, url, { inApp });
    },
    [server]
  );

  const handleUrlClick = useCallback(
    (e: React.MouseEvent) => {
      if (!serverUrl) return;
      if (e.ctrlKey || e.metaKey) e.preventDefault();
      openServerUrl(serverUrl, wantsInAppOpen(e));
    },
    [serverUrl, openServerUrl]
  );

  const hasError = server.status === "error" && server.errorMessage;

  return (
    <div
      data-ctx-surface="devserver"
      data-ctx-id={server.id}
      data-ctx-label={server.projectName}
      data-ctx-url={serverUrl ?? ""}
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
                setPortValue("");
                setEditing(true);
                // Start on the badge. The free-type field is behind its own
                // pencil now, so the common case (leave the port alone) needs
                // no interaction at all.
                setEditingPort(false);
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
            <SmallIconButton title="Remove" onClick={handleRemove} danger>
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
                borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
                outline: "none",
                fontFamily: "inherit",
              }}
            />
            {editingPort ? (
              <>
                <input
                  autoFocus
                  value={portValue}
                  onChange={(e) => {
                    const digits = e.target.value.replace(/\D/g, "").slice(0, 5);
                    setPortValue(digits);
                    // Write straight into the command, so the field above always
                    // shows what will actually run.
                    const n = parseInt(digits, 10);
                    setEditValue((c) =>
                      n > 0 && n <= 65535 ? injectPort(c, n) : stripPort(c),
                    );
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveEdit();
                    if (e.key === "Escape") handleCancelEdit();
                  }}
                  placeholder={defaultPort === null ? "port" : String(defaultPort)}
                  style={{
                    width: 44,
                    padding: "2px 4px",
                    fontSize: 11,
                    color: "var(--ezy-cyan)",
                    backgroundColor: "var(--ezy-bg)",
                    border: "1px solid var(--ezy-accent)",
                    borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
                    outline: "none",
                    fontFamily: "inherit",
                    flexShrink: 0,
                  }}
                />
                <SmallIconButton
                  title={defaultPort === null ? "Use the default port" : `Use the default port (${defaultPort})`}
                  onClick={() => {
                    setEditValue((c) => stripPort(c));
                    setPortValue("");
                    setEditingPort(false);
                  }}
                >
                  <BiRefresh size={12} color="var(--ezy-text-muted)" style={{ transform: "scale(1.2)" }} />
                </SmallIconButton>
              </>
            ) : (
              <>
                <span
                  data-tooltip={
                    customPort
                      ? `Port ${customPort}, set for this server`
                      : defaultPort === null
                        ? "Working out this project's default port…"
                        : defaultPortSource === "config"
                          ? `Default port ${defaultPort}, from this project's config`
                          : `Default port ${defaultPort} for this project's framework`
                  }
                  style={{
                    flexShrink: 0,
                    padding: "2px 6px",
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: "0.02em",
                    color: customPort ? "#fff" : "var(--ezy-text)",
                    backgroundColor: customPort ? "var(--ezy-accent)" : "var(--ezy-border)",
                    borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
                    whiteSpace: "nowrap",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {customPort
                    ? `Port ${customPort}`
                    : defaultPort === null
                      ? "Default \u2026"
                      : `Default ${defaultPort}`}
                </span>
                <SmallIconButton
                  title="Set a port manually"
                  onClick={() => {
                    setPortValue(String(customPort ?? ""));
                    setEditingPort(true);
                  }}
                >
                  <FaPencil size={9} color="var(--ezy-text-muted)" />
                </SmallIconButton>
              </>
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
                ref={urlSpanRef}
                onClick={handleUrlClick}
                data-tooltip={
                  networkUrls.length > 0
                    ? `${serverUrl} — Click to open in browser / Ctrl+Click for preview\nHover 3s to see ${networkUrls.length} network address${networkUrls.length === 1 ? "" : "es"}`
                    : `${serverUrl} — Click to open in browser / Ctrl+Click for preview`
                }
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
                  scheduleOpen();
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderBottomColor = "transparent";
                  scheduleClose();
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

      {/* Network access, while editing. Same rule as the create form: the flag
          goes into the command text, so Save restarts with it exactly as
          shown. */}
      {editing && (
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "0 10px 5px 22px",
            cursor: "pointer",
            userSelect: "none",
          }}
        >
          <input
            type="checkbox"
            checked={hasHostFlag(editValue)}
            onChange={() =>
              setEditValue((c) => (hasHostFlag(c) ? stripHost(c) : injectHost(c, hostStyle)))
            }
            style={{ flexShrink: 0 }}
          />
          <span style={{ fontSize: 10, color: "var(--ezy-text-muted)" }}>
            Reachable from other devices
          </span>
        </label>
      )}

      {/* Error message — solid surface, not a tinted wash (UI rules), and it
          WRAPS. It used to be one nowrap line with an ellipsis, which cut off
          exactly the part of a startup failure worth reading. */}
      {hasError && (
        <div
          data-tooltip={server.errorMessage}
          style={{
            margin: "1px 10px 5px 22px",
            padding: "4px 7px",
            fontSize: 10,
            lineHeight: 1.35,
            color: "#fff",
            backgroundColor: "var(--ezy-red)",
            borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
            overflowWrap: "anywhere",
            display: "-webkit-box",
            WebkitBoxOrient: "vertical",
            WebkitLineClamp: 3,
            overflow: "hidden",
          }}
        >
          {server.errorMessage}
        </div>
      )}

      {/* URL popover — overlay-rendered (useOverlayMenu above). */}
    </div>
  );
}


/** The flag the tickbox will add, shown so the change is never a mystery. */
function hostStylePreview(style: HostStyle): string {
  switch (style) {
    case "next": return "-H 0.0.0.0";
    case "cra": return "HOST=0.0.0.0";
    case "angular": return "--host 0.0.0.0";
    default: return "--host";
  }
}

function AddServerForm({ onClose }: { onClose: () => void }) {
  const recentProjects = useAppStore((s) => s.recentProjects);
  const addTerminal = useAppStore((s) => s.addTerminal);
  const addDevServer = useAppStore((s) => s.addDevServer);
  const setDevServerBackend = useAppStore((s) => s.setDevServerBackend);
  const addCustomServerCommand = useAppStore((s) => s.addCustomServerCommand);
  const removeCustomServerCommand = useAppStore((s) => s.removeCustomServerCommand);
  const updateProjectServerCommand = useAppStore((s) => s.updateProjectServerCommand);
  const addRecentProject = useAppStore((s) => s.addRecentProject);

  const [selectedPath, setSelectedPath] = useState("");
  const [selectedName, setSelectedName] = useState("");
  const [selectedServerId, setSelectedServerId] = useState<string | undefined>(undefined);
  const [command, setCommand] = useState("");
  const [showCmdDropdown, setShowCmdDropdown] = useState(false);
  const [showProjectDropdown, setShowProjectDropdown] = useState(false);
  // Which host-flag spelling this project needs (vite/next/cra/angular),
  // resolved from its package.json when a project is picked. Held here rather
  // than looked up on toggle so ticking the box is instant.
  const [hostStyle, setHostStyle] = useState<HostStyle>("vite");
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

  // Re-resolve the flag spelling whenever the project or command changes. The
  // command matters because the script BODY is the best evidence: a project can
  // depend on both vite and next, but `npm run dev` only runs one of them.
  useEffect(() => {
    if (!selectedPath) return;
    let cancelled = false;
    void detectHostStyleForProject(selectedPath, command, selectedServerId).then((style) => {
      if (!cancelled) setHostStyle(style);
    });
    return () => { cancelled = true; };
  }, [selectedPath, selectedServerId, command]);

  const networkOn = hasHostFlag(command);
  const toggleNetwork = useCallback(() => {
    setCommand((c) => (hasHostFlag(c) ? stripHost(c) : injectHost(c, hostStyle)));
  }, [hostStyle]);

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
    const devServerId = `ds-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    addTerminal(terminalId, "devserver", selectedPath, selectedServerId);
    addDevServer({
      id: devServerId,
      terminalId,
      tabId: "",
      projectName: selectedName,
      command: trimmed,
      workingDir: selectedPath,
      port: 0,
      status: "starting",
      serverId: selectedServerId,
    });
    // Resolve the spawn backend, exactly as spawn-dev-server.ts does for the
    // quick-open / auto-start / boot-restore path.
    //
    // This site never did, and `backend: undefined` is not a neutral default:
    // DevServerTerminalHost renders NOTHING for a dev server without one, so a
    // server created here got a permanently black pane — no PTY, no command,
    // no error, just a row that says "detecting..." forever. It looked
    // intermittent only because the OTHER creation path resolves it.
    resolveDevServerBackend(selectedPath, selectedServerId)
      .then((backend) => setDevServerBackend(devServerId, backend))
      .catch(() => {
        const fallback = useAppStore.getState().terminalBackend ?? getDefaultBackend();
        setDevServerBackend(devServerId, fallback);
      });
    // Persist the command onto the project so it's remembered across restart.
    // Upsert: a browsed-new dir may not be in recentProjects yet.
    const exists = useAppStore.getState().recentProjects.some(
      (p) => norm(p.path) === norm(selectedPath) && p.serverId === selectedServerId,
    );
    if (exists) {
      updateProjectServerCommand(selectedPath, trimmed, selectedServerId);
    } else {
      addRecentProject({ path: selectedPath, name: selectedName, serverCommand: trimmed, serverId: selectedServerId });
    }
    onClose();
  }, [selectedPath, selectedName, selectedServerId, command, addTerminal, addDevServer, setDevServerBackend, addCustomServerCommand, updateProjectServerCommand, addRecentProject, onClose]);

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "4px 8px",
    fontSize: 12,
    color: "var(--ezy-text)",
    backgroundColor: "var(--ezy-bg)",
    border: "1px solid var(--ezy-border-light)",
    borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
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
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
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
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
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

      {/* Network access. The flag is written into the command field rather than
          held as hidden state — the user sees exactly what will run, can edit
          it, and it rides along with the command MADE already remembers per
          project. */}
      <label
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 7,
          marginBottom: 8,
          padding: "6px 8px",
          border: "1px solid var(--ezy-border)",
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
          backgroundColor: "var(--ezy-surface)",
          cursor: command.trim() ? "pointer" : "default",
          userSelect: "none",
          opacity: command.trim() ? 1 : 0.5,
        }}
      >
        <input
          type="checkbox"
          checked={networkOn}
          disabled={!command.trim()}
          onChange={toggleNetwork}
          style={{ marginTop: 1 }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, color: "var(--ezy-text)" }}>
            Reachable from other devices
          </div>
          <div style={{ fontSize: 10, color: "var(--ezy-text-muted)", marginTop: 1, lineHeight: 1.3 }}>
            {networkOn
              ? "Open it from another machine using this one's IP, over Tailscale or the local network."
              : `Adds ${hostStylePreview(hostStyle)} so the server listens beyond localhost.`}
          </div>
        </div>
      </label>

      {/* Start button */}
      <div
        onClick={handleStart}
        style={{
          padding: "5px 12px",
          fontSize: 12,
          fontWeight: 600,
          color: !selectedPath || !command.trim() ? "var(--ezy-text-muted)" : "#fff",
          backgroundColor: !selectedPath || !command.trim() ? "var(--ezy-border)" : "var(--ezy-accent)",
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
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
            data-tooltip={showRemoteServers ? "Hide Remote Servers" : "Show Remote Servers"}
            style={{
              width: 20,
              height: 20,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
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
            data-tooltip="Add dev server"
            style={{
              width: 20,
              height: 20,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
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
