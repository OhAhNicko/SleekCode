import { useState, useCallback, useRef, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import LoadingDots from "./LoadingDots";
import { registerSurfaceActions, unregisterSurfaceActions } from "../lib/surface-actions";
import { openDevServerUrlIn, wantsInAppOpen } from "../lib/open-dev-server-url";
import { FaFolder, FaChevronDown, FaStop, FaPlay, FaExpand, FaGlobe } from "react-icons/fa";
import { FaXmark, FaPlus, FaPencil } from "react-icons/fa6";
import { BiRefresh } from "react-icons/bi";
import { useAppStore } from "../store";
import { useOverlayMenu } from "../lib/useOverlayMenu";
import ServersPanel from "./ServersPanel";
import { getPtyWrite } from "../store/terminalSlice";
import { getDevServerActions } from "../lib/dev-server-actions";
import { createDevServer, isSameProject, syncProjectServerCommands } from "../lib/spawn-dev-server";
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

/**
 * Row action handlers, keyed by dev-server id.
 *
 * `registerSurfaceActions` holds ONE entry per surface role, so a row that
 * registers itself overwrites every other row — whichever mounted last answered
 * for all of them, and the context menu's Restart hit the wrong server. That was
 * survivable while a project had one server; it is the common case now. Rows
 * publish here instead and the panel registers once, dispatching by the id the
 * user actually right-clicked.
 */
const rowRestartHandlers = new Map<string, () => void>();

/** Left inset of a row's text column, so line 2 lines up under the command. */
function textIndent(showMarker: boolean): number {
  //  row padding + dot + gap  (+ marker + gap)
  return 16 + 6 + 6 + (showMarker ? 12 + 6 : 0);
}

/**
 * The command / port / network-access editor, shared by a row's edit mode and
 * the draft row that adds another server to a project.
 *
 * Both write the port and the host flag INTO the command text rather than
 * keeping them as separate fields, which is what makes the panel's promise —
 * what you see is what will run — literally true.
 */
function CommandEditor({
  value,
  onChange,
  onCommit,
  onCancel,
  workingDir,
  serverId,
  indent,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  workingDir: string;
  serverId?: string;
  indent: number;
  placeholder?: string;
}) {
  const [editingPort, setEditingPort] = useState(false);
  const [portValue, setPortValue] = useState("");
  // Host-flag spelling and default port for THIS project, resolved only while
  // the editor is open — a sidebar of idle dev servers should not each go read
  // a package.json, still less a config file over SSH.
  const [hostStyle, setHostStyle] = useState<HostStyle>("vite");
  // null = not resolved yet. Starting at a number would flash a WRONG default
  // (3000) before correcting to, say, 5173 — a badge that lies briefly is worse
  // than one that admits it is still looking.
  const [defaultPort, setDefaultPort] = useState<number | null>(null);
  const [defaultPortSource, setDefaultPortSource] = useState<"framework" | "config">("framework");

  useEffect(() => {
    let cancelled = false;
    void detectHostStyleForProject(workingDir, value, serverId).then((s) => {
      if (!cancelled) setHostStyle(s);
    });
    void resolveDefaultPort(workingDir, value, serverId).then((r) => {
      if (cancelled) return;
      setDefaultPort(r.port);
      setDefaultPortSource(r.fromConfig ? "config" : "framework");
    });
    return () => { cancelled = true; };
    // `value` is deliberately not a dep: re-reading package.json and a config
    // file on every keystroke would be several SSH round trips per character on
    // a remote project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workingDir, serverId]);

  /** A port this command was explicitly given, as opposed to the framework's. */
  const customPort = explicitPortInCommand(value);

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: `0 10px 5px ${indent}px`,
        }}
      >
        <input
          autoFocus
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCommit();
            if (e.key === "Escape") onCancel();
          }}
          style={{
            flex: 1,
            minWidth: 0,
            padding: "2px 6px",
            fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
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
                onChange(n > 0 && n <= 65535 ? injectPort(value, n) : stripPort(value));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") onCommit();
                if (e.key === "Escape") onCancel();
              }}
              placeholder={defaultPort === null ? "port" : String(defaultPort)}
              style={{
                width: 44,
                padding: "2px 4px",
                fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
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
                onChange(stripPort(value));
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
                fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
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
                  ? <LoadingDots>Default</LoadingDots>
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
      </div>

      {/* Network access. Same rule as the create form: the flag goes into the
          command text, so committing runs it exactly as shown. */}
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: `0 10px 5px ${indent}px`,
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <input
          type="checkbox"
          checked={hasHostFlag(value)}
          onChange={() => onChange(hasHostFlag(value) ? stripHost(value) : injectHost(value, hostStyle))}
          style={{ flexShrink: 0 }}
        />
        <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 10px)", color: "var(--ezy-text-muted)" }}>
          Reachable from other devices
        </span>
      </label>
    </>
  );
}

function DevServerRow({
  server,
  showQuickOpenMarker,
  isQuickOpen,
  onSetQuickOpen,
}: {
  server: DevServer;
  /** Only shown when the project has a choice to make (more than one server). */
  showQuickOpenMarker: boolean;
  isQuickOpen: boolean;
  onSetQuickOpen: () => void;
}) {
  const removeDevServer = useAppStore((s) => s.removeDevServer);
  const updateDevServerCommand = useAppStore((s) => s.updateDevServerCommand);
  const updateDevServerStatus = useAppStore((s) => s.updateDevServerStatus);
  const setExpandedDevServerId = useAppStore((s) => s.setExpandedDevServerId);

  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(server.command);
  // Drives the quick-open marker on non-primary rows: the slot is always there
  // (so nothing shifts) but the globe only appears under the pointer.
  const [hovered, setHovered] = useState(false);

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

  // Start / Restart live in DevServerTerminalHost — it owns the PTY panes AND
  // the port-detection refs, and both have to move together. This row used to
  // reimplement them with a bare getPtyWrite(): the command ran, but the refs
  // stayed set, so no detection listener was ever re-registered and the row sat
  // on "detecting…" forever (the panel's buttons had this exact bug fixed in
  // docs/learnings/2026-03-09-devserver-stopped-detection.md — this copy never
  // got the fix). It also could not notice a DEAD PTY, so after a WSL restart
  // it typed the command into a corpse and flipped the row to "starting"
  // regardless. Both are the host's job now; see lib/dev-server-actions.ts.
  const handleRestart = useCallback(() => {
    getDevServerActions(server.id)?.restart();
  }, [server.id]);

  // Publish this row's Restart for the context menu, keyed by id so the menu
  // acts on the row that was right-clicked rather than the last one mounted.
  useEffect(() => {
    rowRestartHandlers.set(server.id, handleRestart);
    return () => { rowRestartHandlers.delete(server.id); };
  }, [server.id, handleRestart]);

  const handleStop = useCallback(() => {
    const write = getPtyWrite(server.terminalId);
    if (write) {
      write("\x03");
    }
    updateDevServerStatus(server.id, "stopped");
  }, [server, updateDevServerStatus]);

  // Remove forgets this server's command (Stop keeps it). The project's OTHER
  // servers must survive, so the saved list is recomputed from the rows that
  // are left rather than cleared — clearing it here used to be right only
  // because a project could not have a second row to lose.
  const handleRemove = useCallback(() => {
    removeDevServer(server.id);
    syncProjectServerCommands(server.workingDir, server.serverId);
  }, [server, removeDevServer]);

  const handleStart = useCallback(() => {
    getDevServerActions(server.id)?.start();
  }, [server.id]);

  const handleSaveEdit = useCallback(() => {
    const trimmed = editValue.trim();
    const commandChanged = trimmed && trimmed !== server.command;
    if (commandChanged) {
      updateDevServerCommand(server.id, trimmed);
      // If this row was the project's quick-open target, the pointer has to
      // follow the rename — it matches on the command string.
      const wasQuickOpen = isQuickOpen;
      syncProjectServerCommands(server.workingDir, server.serverId);
      if (wasQuickOpen) {
        useAppStore
          .getState()
          .setPrimaryServerCommand(server.workingDir, server.serverId, trimmed);
      }
    }

    // The port now rides IN the command text (`-- --port 3001`), the same way
    // the network flag does, so "did the port change" is a question about the
    // command rather than about a separate field. Restarting is still gated on
    // the PORT changing, not on any command edit — fixing a typo in a running
    // server's command should not kill it.
    const prevPort = explicitPortInCommand(server.command);
    const nextPort = explicitPortInCommand(trimmed);
    if (nextPort !== prevPort) {
      // The restart zeroes the port for us — "unknown, re-detect from output",
      // which is exactly true across a restart and what keeps the dot from
      // claiming "running" on a port that no longer exists. It re-reads the
      // command from the store, so the edit committed just above is what runs.
      getDevServerActions(server.id)?.restart();
    }

    setEditing(false);
  }, [editValue, server, isQuickOpen, updateDevServerCommand]);

  const handleCancelEdit = useCallback(() => {
    setEditValue(server.command);
    setEditing(false);
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
  const indent = textIndent(showQuickOpenMarker);

  return (
    <div
      data-ctx-surface="devserver"
      data-ctx-id={server.id}
      data-ctx-label={server.projectName}
      data-ctx-url={serverUrl ?? ""}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ borderBottom: "1px solid var(--ezy-border-subtle)" }}
    >
      {/* Main row: status + quick-open marker + command + actions.
          The project name lives on the group header now, so the COMMAND is
          what identifies a row — a project can have several. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "3px 10px 2px 16px",
        }}
      >
        <StatusDot status={server.status} />

        {/* Quick-open marker. Only rendered when the project has more than one
            server: with one there is nothing to choose, and a permanent badge
            on every row would be noise. The slot keeps its width whether or not
            the globe is visible, so nothing shifts under the pointer. */}
        {showQuickOpenMarker && (
          <span
            role="button"
            aria-label={isQuickOpen ? "Quick-open target" : "Make this the quick-open target"}
            data-tooltip={
              isQuickOpen
                ? "Quick-open target — the globe icons open this server"
                : "Open this server from the tab and pane globes"
            }
            onClick={(e) => {
              e.stopPropagation();
              if (!isQuickOpen) onSetQuickOpen();
            }}
            style={{
              width: 12,
              height: 12,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: isQuickOpen ? "default" : "pointer",
              opacity: isQuickOpen ? 1 : hovered ? 0.55 : 0,
              transition: "opacity 120ms ease",
            }}
          >
            <FaGlobe size={9} color={isQuickOpen ? "var(--ezy-accent)" : "var(--ezy-text-muted)"} />
          </span>
        )}

        <span
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
            fontWeight: 500,
            color: "var(--ezy-text)",
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {server.command}
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
                setEditing(true);
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

      {editing ? (
        <CommandEditor
          value={editValue}
          onChange={setEditValue}
          onCommit={handleSaveEdit}
          onCancel={handleCancelEdit}
          workingDir={server.workingDir}
          serverId={server.serverId}
          indent={indent}
        />
      ) : (
        /* Second line: where this server can be reached, aligned under the
           command it belongs to. */
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: `0 10px 5px ${indent}px`,
          }}
        >
          {serverUrl ? (
            <span
              ref={urlSpanRef}
              onClick={handleUrlClick}
              data-tooltip={
                networkUrls.length > 0
                  ? `${serverUrl} \u2014 Click to open in browser / Ctrl+Click for preview\nHover 3s to see ${networkUrls.length} network address${networkUrls.length === 1 ? "" : "es"}`
                  : `${serverUrl} \u2014 Click to open in browser / Ctrl+Click for preview`
              }
              style={{
                fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
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
          ) : server.status === "starting" && server.stalledSince !== undefined ? (
            <span
              data-tooltip="Nothing has printed for 30+ seconds — the launch may be wedged. Restart kills and respawns the terminal."
              style={{
                fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
                color: "var(--ezy-red)",
                flexShrink: 0,
              }}
            >
              no output
            </span>
          ) : server.status !== "stopped" ? (
            <span
              style={{
                fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
                color: "var(--ezy-text-muted)",
                flexShrink: 0,
                opacity: 0.5,
              }}
            >
              <LoadingDots>detecting</LoadingDots>
            </span>
          ) : null}
        </div>
      )}

      {/* Error message — solid surface, not a tinted wash (UI rules), and it
          WRAPS. It used to be one nowrap line with an ellipsis, which cut off
          exactly the part of a startup failure worth reading. */}
      {hasError && (
        <div
          data-tooltip={server.errorMessage}
          style={{
            margin: `1px 10px 5px ${indent}px`,
            padding: "4px 7px",
            fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
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

/**
 * The "add another server to this project" row.
 *
 * It is a draft, not a server: nothing is created until a command is committed.
 * Creating the row first and letting the user fill it in would spawn a PTY with
 * an empty command and leave a half-real server in the list if they changed
 * their mind.
 */
function NewServerDraftRow({
  projectName,
  workingDir,
  serverId,
  tabId,
  existingCommands,
  onClose,
}: {
  projectName: string;
  workingDir: string;
  serverId?: string;
  tabId: string;
  existingCommands: string[];
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const addCustomServerCommand = useAppStore((s) => s.addCustomServerCommand);

  const trimmed = value.trim();
  // The project already running this exact command is the one case where a
  // second server is certainly a mistake — createDevServer would dedupe it away
  // anyway, so say so instead of appearing to do nothing.
  const duplicate = existingCommands.includes(trimmed);

  const handleCommit = useCallback(() => {
    const cmd = value.trim();
    if (!cmd || existingCommands.includes(cmd)) return;
    if (!BUILTIN_SERVER_COMMANDS.includes(cmd)) addCustomServerCommand(cmd);
    createDevServer({ tabId, projectName, workingDir, command: cmd, serverId });
    onClose();
  }, [value, existingCommands, addCustomServerCommand, tabId, projectName, workingDir, serverId, onClose]);

  return (
    <div style={{ borderBottom: "1px solid var(--ezy-border-subtle)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "3px 10px 2px 16px",
        }}
      >
        <span
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
            fontWeight: 600,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            color: "var(--ezy-text-muted)",
            flex: 1,
            minWidth: 0,
          }}
        >
          New server
        </span>
        <SmallIconButton title="Cancel" onClick={onClose}>
          <FaXmark size={10} color="var(--ezy-text-muted)" />
        </SmallIconButton>
      </div>

      <CommandEditor
        value={value}
        onChange={setValue}
        onCommit={handleCommit}
        onCancel={onClose}
        workingDir={workingDir}
        serverId={serverId}
        indent={16}
        placeholder="npm run dev"
      />

      {duplicate && (
        <div
          style={{
            margin: "0 10px 5px 16px",
            padding: "3px 7px",
            fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
            lineHeight: 1.35,
            color: "#fff",
            backgroundColor: "var(--ezy-red)",
            borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
          }}
        >
          This project already runs that command. Give the new server a different
          one, or set another port.
        </div>
      )}
    </div>
  );
}

/**
 * One project's servers: a header naming the project, then a row per server.
 *
 * The header exists even when a project has a single server, so "+" is always
 * in the same place and a project reads as one block whether it runs one server
 * or four.
 */
function DevServerGroup({ servers }: { servers: DevServer[] }) {
  const [adding, setAdding] = useState(false);
  const setPrimaryServerCommand = useAppStore((s) => s.setPrimaryServerCommand);
  const first = servers[0];
  const quickOpenCommand = useAppStore((s) => {
    const project = s.recentProjects.find((p) =>
      isSameProject({ workingDir: p.path, serverId: p.serverId }, first.workingDir, first.serverId),
    );
    return project?.primaryServerCommand;
  });

  // Which row the globes act on. Mirrors getQuickOpenServer's fallback so the
  // marker never points somewhere different from what the globes actually open.
  const resolvedQuickOpen =
    servers.find((ds) => ds.command === quickOpenCommand) ??
    servers.find((ds) => ds.status === "running" && ds.port > 0) ??
    first;
  const showMarker = servers.length > 1;

  return (
    <div>
      {/* Group header: the project, and the only place a server is added to it.
          The rule runs from the name to the button, binding the rows below to
          the name above without spending a heavier divider on it. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 6px 3px 10px",
        }}
      >
        <span
          // The name is ambiguous across two checkouts of the same repo — the
          // path is what tells them apart. TooltipHost suppresses tooltips that
          // merely echo unclipped visible text, so this only ever adds
          // information.
          data-tooltip={first.workingDir}
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
            fontWeight: 600,
            color: "var(--ezy-text)",
            flexShrink: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {first.projectName}
        </span>
        <span
          aria-hidden
          style={{ flex: 1, height: 1, backgroundColor: "var(--ezy-border-subtle)", minWidth: 8 }}
        />
        <SmallIconButton
          title={`Add another dev server to ${first.projectName}`}
          onClick={() => setAdding(true)}
        >
          <FaPlus size={9} color="var(--ezy-text-muted)" />
        </SmallIconButton>
      </div>

      {servers.map((server) => (
        <DevServerRow
          key={server.id}
          server={server}
          showQuickOpenMarker={showMarker}
          isQuickOpen={server.id === resolvedQuickOpen.id}
          onSetQuickOpen={() =>
            setPrimaryServerCommand(server.workingDir, server.serverId, server.command)
          }
        />
      ))}

      {adding && (
        <NewServerDraftRow
          projectName={first.projectName}
          workingDir={first.workingDir}
          serverId={first.serverId}
          tabId={first.tabId}
          existingCommands={servers.map((s) => s.command)}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}

/**
 * Group the flat dev-server list by project, preserving creation order.
 *
 * The key is the project, not the first server: keying a group by a row id
 * would remount the whole group — discarding a half-typed draft row — the
 * moment that row was removed.
 */
function groupByProject(servers: DevServer[]): [string, DevServer[]][] {
  const groups = new Map<string, DevServer[]>();
  for (const ds of servers) {
    const key = `${ds.workingDir.replace(/\\/g, "/")}|${ds.serverId ?? ""}`;
    const group = groups.get(key);
    if (group) group.push(ds);
    else groups.set(key, [ds]);
  }
  return [...groups.entries()];
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
  const addCustomServerCommand = useAppStore((s) => s.addCustomServerCommand);
  const removeCustomServerCommand = useAppStore((s) => s.removeCustomServerCommand);
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
    const trimmed = command.trim();
    if (!BUILTIN_SERVER_COMMANDS.includes(trimmed)) {
      addCustomServerCommand(trimmed);
    }
    // The project entry has to exist before the server is created: persisting
    // the command list writes into recentProjects, and a browsed-new directory
    // isn't in there yet.
    const norm = (p: string) => p.replace(/\\/g, "/");
    const exists = useAppStore.getState().recentProjects.some(
      (p) => norm(p.path) === norm(selectedPath) && p.serverId === selectedServerId,
    );
    if (!exists) {
      addRecentProject({ path: selectedPath, name: selectedName, serverId: selectedServerId });
    }
    // createDevServer owns backend resolution and persistence. This site used
    // to build the DevServer by hand and forgot `resolveDevServerBackend`,
    // which left a permanently black pane — no PTY, no command, no error, just
    // a row stuck on "detecting..." — and looked intermittent only because the
    // other creation path did resolve it. Duplicating it once cost that bug.
    createDevServer({
      tabId: "",
      projectName: selectedName,
      workingDir: selectedPath,
      command: trimmed,
      serverId: selectedServerId,
    });
    onClose();
  }, [selectedPath, selectedName, selectedServerId, command, addCustomServerCommand, addRecentProject, onClose]);

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "4px 8px",
    fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
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
        <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 11px)", fontWeight: 600, color: "var(--ezy-text)" }}>Add Dev Server</span>
        <FaXmark
          size={12}
          color="var(--ezy-text-muted)"
          style={{ cursor: "pointer" }}
          onClick={onClose}
        />
      </div>

      {/* Project selector */}
      <div ref={projectDropdownRef} style={{ marginBottom: 6, position: "relative" }}>
        <label style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 10px)", color: "var(--ezy-text-muted)", marginBottom: 2, display: "block" }}>
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
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, fontSize: "calc(var(--ezy-font-scale, 1) * 11px)" }}>
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
                fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
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
                  fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
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
                <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 10px)", color: "var(--ezy-text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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
        <label style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 10px)", color: "var(--ezy-text-muted)", marginBottom: 2, display: "block" }}>
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
                  fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
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
          <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-text)" }}>
            Reachable from other devices
          </div>
          <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 10px)", color: "var(--ezy-text-muted)", marginTop: 1, lineHeight: 1.3 }}>
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
          fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
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

  // One registration for the whole panel, dispatching to the row that was
  // right-clicked (see `rowRestartHandlers`).
  useEffect(() => {
    registerSurfaceActions("devserver", {
      restart: (id) => rowRestartHandlers.get(id)?.(),
    });
    return () => unregisterSurfaceActions("devserver");
  }, []);

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
          <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 11px)", fontWeight: 600, color: "var(--ezy-text-muted)", letterSpacing: "0.04em", textTransform: "uppercase" }}>
            Dev Servers
          </span>
          {devServers.length > 0 && (
            <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 10px)", color: "var(--ezy-text-muted)", opacity: 0.6 }}>
              {devServers.length}
            </span>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
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
            <p style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 11px)", marginBottom: 2 }}>
              No dev servers
            </p>
            <p style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 10px)", color: "var(--ezy-border-light)" }}>
              Click + to add one
            </p>
          </div>
        ) : (
          groupByProject(devServers).map(([key, group]) => (
            <DevServerGroup key={key} servers={group} />
          ))
        )}

        {/* Inline Remote Servers section — always mounted now that the fold
            control lives on its own REMOTE header. Unmounting it here would
            take the control away with it. */}
        <div style={{ borderTop: "1px solid var(--ezy-border-subtle)" }}>
          <ServersPanel
            compact
            collapsed={!showRemoteServers}
            onToggleCollapsed={() => setShowRemoteServers((v) => !v)}
          />
        </div>
      </div>
    </div>
  );
}
