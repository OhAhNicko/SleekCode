import { useEffect, useRef, useCallback } from "react";
import { useAppStore } from "../store";
import { getPtyWrite, registerTerminalDataListener, unregisterTerminalDataListener } from "../store/terminalSlice";
import TerminalPane from "./TerminalPane";

// Regex to detect common dev server port patterns in terminal output
const PORT_REGEX = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/;

// Common error patterns in dev server output
const ERROR_PATTERNS = [
  /npm ERR!/,
  /Error:\s+(.{1,120})/,
  /EADDRINUSE/,
  /ENOENT/,
  /EACCES/,
  /command not found/,
  /Cannot find module/,
  /MODULE_NOT_FOUND/,
  /SyntaxError/,
  /FATAL ERROR/,
  /error TS\d+/,
  /errno\s+-?\d+/,
];

// Lock file errors — auto-retryable after a restart
const LOCK_ERROR_PATTERNS = [
  /Unable to acquire lock/i,
  /is another instance of .+ running/i,
  /EEXIST.*\.lock/i,
];

/**
 * Renders TerminalPanes for all dev servers so PTYs stay alive.
 * All terminals live in one container that is always sized.
 * When collapsed it's off-screen; when expanded it slides in as a panel.
 * Also detects ports from PTY output and updates the dev server store.
 */
export default function DevServerTerminalHost() {
  const devServers = useAppStore((s) => s.devServers);
  const expandedDevServerId = useAppStore((s) => s.expandedDevServerId);
  const setExpandedDevServerId = useAppStore((s) => s.setExpandedDevServerId);
  const updateDevServerStatus = useAppStore((s) => s.updateDevServerStatus);
  const updateDevServerError = useAppStore((s) => s.updateDevServerError);

  // Track which servers have had their command written
  const commandSentRef = useRef<Set<string>>(new Set());
  // Track which servers have had their port detected (avoid repeated scans)
  const portDetectedRef = useRef<Set<string>>(new Set());
  // Track which servers have been resolved (port found or error detected)
  const resolvedRef = useRef<Set<string>>(new Set());
  // Track retry attempts for lock errors (serverId → attempt count)
  const lockRetryRef = useRef<Map<string, number>>(new Map());

  const handlePtyReady = useCallback(
    (serverId: string, terminalId: string, command: string) => {
      if (commandSentRef.current.has(serverId)) return;
      commandSentRef.current.add(serverId);
      setTimeout(() => {
        const write = getPtyWrite(terminalId);
        if (write) {
          write(command + "\r");
        }
      }, 300);
    },
    []
  );

  // Handle PTY exit — set status to error if no port was detected
  const handlePtyExit = useCallback(
    (serverId: string, exitCode: number) => {
      if (resolvedRef.current.has(serverId)) {
        // Port was already detected — mark as stopped (server was running, then exited)
        updateDevServerStatus(serverId, "stopped");
        return;
      }
      resolvedRef.current.add(serverId);
      if (exitCode !== 0) {
        updateDevServerError(serverId, `Process exited with code ${exitCode}`);
      } else {
        updateDevServerStatus(serverId, "stopped");
      }
    },
    [updateDevServerStatus, updateDevServerError]
  );

  /** Send Ctrl+C (twice for stubborn processes), wait, then re-run the command. */
  const restartServer = useCallback(
    (serverId: string, terminalId: string, command: string, delayMs = 1500) => {
      const write = getPtyWrite(terminalId);
      if (!write) return;
      write("\x03");
      // Second Ctrl+C after 100ms for processes that need confirmation
      setTimeout(() => write("\x03"), 100);
      // Re-enable detection
      resolvedRef.current.delete(serverId);
      portDetectedRef.current.delete(serverId);
      updateDevServerStatus(serverId, "running");
      updateDevServerError(serverId, undefined);
      setTimeout(() => write(command + "\r"), delayMs);
    },
    [updateDevServerStatus, updateDevServerError]
  );

  // Timers for grace-period unregistration after port detection
  const graceTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Register data listeners for port detection + error detection
  useEffect(() => {
    for (const ds of devServers) {
      if (resolvedRef.current.has(ds.id)) continue;

      const textDecoder = new TextDecoder();
      let buffer = "";
      let portFound = false;

      registerTerminalDataListener(ds.terminalId, (data) => {
        buffer += textDecoder.decode(data, { stream: true });
        // Only scan last 4KB to avoid memory buildup
        if (buffer.length > 4096) buffer = buffer.slice(-4096);

        // Strip ANSI escape codes for cleaner matching
        const cleanBuffer = buffer.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

        // ALWAYS check for lock errors first — even after port detection
        for (const pattern of LOCK_ERROR_PATTERNS) {
          if (pattern.test(cleanBuffer)) {
            // Cancel any grace timer
            const graceTimer = graceTimersRef.current.get(ds.id);
            if (graceTimer) {
              clearTimeout(graceTimer);
              graceTimersRef.current.delete(ds.id);
            }
            portFound = false;
            portDetectedRef.current.delete(ds.id);

            const attempts = lockRetryRef.current.get(ds.id) ?? 0;
            if (attempts < 2) {
              lockRetryRef.current.set(ds.id, attempts + 1);
              resolvedRef.current.delete(ds.id);
              unregisterTerminalDataListener(ds.terminalId);
              const delay = 2000 + attempts * 1500; // 2s, then 3.5s
              restartServer(ds.id, ds.terminalId, ds.command, delay);
              return;
            }
            // Max retries exhausted — show error
            resolvedRef.current.add(ds.id);
            updateDevServerError(ds.id, "Lock file conflict — close other instances manually");
            unregisterTerminalDataListener(ds.terminalId);
            return;
          }
        }

        // Skip port/error checks if already resolved
        if (resolvedRef.current.has(ds.id)) return;

        // Check for port
        if (!portFound) {
          const match = buffer.match(PORT_REGEX);
          if (match) {
            const port = parseInt(match[1], 10);
            if (port > 0 && port <= 65535) {
              portFound = true;
              portDetectedRef.current.add(ds.id);
              lockRetryRef.current.delete(ds.id);
              updateDevServerStatus(ds.id, "running");
              updateDevServerError(ds.id, undefined);
              // Update port in store
              const store = useAppStore.getState();
              const current = store.devServers.find((s) => s.id === ds.id);
              if (current && current.port !== port) {
                useAppStore.setState({
                  devServers: store.devServers.map((srv) =>
                    srv.id === ds.id ? { ...srv, port } : srv
                  ),
                });
              }
              // Keep listening for lock errors for 8 seconds, then resolve
              const timer = setTimeout(() => {
                resolvedRef.current.add(ds.id);
                graceTimersRef.current.delete(ds.id);
                unregisterTerminalDataListener(ds.terminalId);
              }, 8000);
              graceTimersRef.current.set(ds.id, timer);
              return;
            }
          }
        }

        // Check for other error patterns (only if port not yet found)
        if (!portFound) {
          for (const pattern of ERROR_PATTERNS) {
            const errMatch = cleanBuffer.match(pattern);
            if (errMatch) {
              resolvedRef.current.add(ds.id);
              const msg = errMatch[1]?.trim() || errMatch[0].trim();
              updateDevServerError(ds.id, msg);
              unregisterTerminalDataListener(ds.terminalId);
              return;
            }
          }
        }
      });
    }

    return () => {
      for (const ds of devServers) {
        unregisterTerminalDataListener(ds.terminalId);
      }
    };
  }, [devServers, updateDevServerStatus, updateDevServerError, restartServer]);

  // Clean up tracked state when servers are removed, or re-enable detection
  // when a server is restarted (status changed back to "running" without a port)
  useEffect(() => {
    const currentIds = new Set(devServers.map((ds) => ds.id));
    for (const id of commandSentRef.current) {
      if (!currentIds.has(id)) commandSentRef.current.delete(id);
    }
    for (const id of portDetectedRef.current) {
      if (!currentIds.has(id)) portDetectedRef.current.delete(id);
    }
    for (const id of resolvedRef.current) {
      if (!currentIds.has(id)) resolvedRef.current.delete(id);
    }
    for (const id of lockRetryRef.current.keys()) {
      if (!currentIds.has(id)) lockRetryRef.current.delete(id);
    }
    for (const [id, timer] of graceTimersRef.current.entries()) {
      if (!currentIds.has(id)) {
        clearTimeout(timer);
        graceTimersRef.current.delete(id);
      }
    }
    // Re-enable detection for servers that were restarted
    for (const ds of devServers) {
      if (ds.status === "running" && !ds.errorMessage && ds.port === 0) {
        resolvedRef.current.delete(ds.id);
        portDetectedRef.current.delete(ds.id);
        const graceTimer = graceTimersRef.current.get(ds.id);
        if (graceTimer) {
          clearTimeout(graceTimer);
          graceTimersRef.current.delete(ds.id);
        }
      }
    }
  }, [devServers]);

  // Trigger xterm refit when panel opens + ESC to close
  useEffect(() => {
    if (expandedDevServerId) {
      const timer = setTimeout(() => {
        window.dispatchEvent(new Event("resize"));
      }, 50);
      const handleKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") setExpandedDevServerId(null);
      };
      window.addEventListener("keydown", handleKey);
      return () => { clearTimeout(timer); window.removeEventListener("keydown", handleKey); };
    }
  }, [expandedDevServerId, setExpandedDevServerId]);

  const isOpen = !!expandedDevServerId;
  const expandedServer = expandedDevServerId
    ? devServers.find((ds) => ds.id === expandedDevServerId)
    : null;

  if (devServers.length === 0) return null;

  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div
          style={{
            position: "fixed",
            top: 38,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(0,0,0,0.4)",
            zIndex: 300,
          }}
          onClick={() => setExpandedDevServerId(null)}
        />
      )}

      {/* Panel container — always sized, off-screen when collapsed */}
      <div
        style={{
          position: "fixed",
          top: isOpen ? 38 : 0,
          right: isOpen ? 0 : undefined,
          left: isOpen ? undefined : -9999,
          bottom: isOpen ? 0 : undefined,
          width: isOpen ? "55%" : 800,
          minWidth: isOpen ? 400 : undefined,
          height: isOpen ? undefined : 400,
          backgroundColor: "var(--ezy-bg)",
          borderLeft: isOpen ? "1px solid var(--ezy-border)" : "none",
          zIndex: isOpen ? 301 : -1,
          display: "flex",
          flexDirection: "column",
          boxShadow: isOpen ? "-8px 0 32px rgba(0,0,0,0.4)" : "none",
          overflow: "hidden",
          pointerEvents: isOpen ? "auto" : "none",
        }}
      >
        {/* Panel header */}
        {expandedServer && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 16px",
              borderBottom: "1px solid var(--ezy-border)",
              backgroundColor: "var(--ezy-surface)",
              flexShrink: 0,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  backgroundColor:
                    expandedServer.status === "running"
                      ? "var(--ezy-accent)"
                      : "var(--ezy-red)",
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--ezy-text)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {expandedServer.command}
              </span>
              <span style={{ fontSize: 12, color: "var(--ezy-text-muted)", flexShrink: 0 }}>
                {expandedServer.projectName}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
              {/* Restart */}
              <div
                title="Restart"
                style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6, cursor: "pointer", transition: "background-color 120ms ease" }}
                onClick={() => {
                  restartServer(expandedServer.id, expandedServer.terminalId, expandedServer.command);
                }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.3" strokeLinecap="round">
                  <path d="M3.5 2v4h4" />
                  <path d="M3.5 6A5.5 5.5 0 1 1 2.5 8" />
                </svg>
              </div>

              {/* Stop / Play */}
              {expandedServer.status === "running" ? (
                <div
                  title="Stop"
                  style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6, cursor: "pointer", transition: "background-color 120ms ease" }}
                  onClick={() => {
                    const write = getPtyWrite(expandedServer.terminalId);
                    if (write) write("\x03");
                    updateDevServerStatus(expandedServer.id, "stopped");
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "rgba(220,60,60,0.15)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="var(--ezy-text-muted)">
                    <rect x="1" y="1" width="10" height="10" rx="1.5" />
                  </svg>
                </div>
              ) : (
                <div
                  title="Start"
                  style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6, cursor: "pointer", transition: "background-color 120ms ease" }}
                  onClick={() => {
                    const write = getPtyWrite(expandedServer.terminalId);
                    if (write) write(expandedServer.command + "\r");
                    updateDevServerStatus(expandedServer.id, "running");
                    updateDevServerError(expandedServer.id, undefined);
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="var(--ezy-accent)">
                    <polygon points="2,1 11,6 2,11" />
                  </svg>
                </div>
              )}

            </div>
          </div>
        )}

        {/* Terminal container */}
        <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
          {devServers.map((ds) => (
            <div
              key={ds.id}
              style={{
                position: "absolute",
                inset: 0,
                display: ds.id === expandedDevServerId ? "block" : "none",
              }}
            >
              <TerminalPane
                terminalId={ds.terminalId}
                terminalType="devserver"
                workingDir={ds.workingDir}
                isActive={ds.id === expandedDevServerId}
                paneCount={99}
                hideChrome
                onClose={() => {}}
                onSplit={() => {}}
                onChangeType={() => {}}
                onFocus={() => {}}
                onPtyReady={() => handlePtyReady(ds.id, ds.terminalId, ds.command)}
                onPtyExit={(code) => handlePtyExit(ds.id, code)}
              />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
