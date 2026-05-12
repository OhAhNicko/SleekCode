import { useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { getPtyWrite, registerTerminalDataListener, unregisterTerminalDataListener } from "../store/terminalSlice";
import { injectPort } from "../lib/server-commands";
import TerminalPane from "./TerminalPane";

/**
 * For remote (SSH) dev servers we open an `ssh -N -L <local>:localhost:<remote>`
 * tunnel so the user can hit `http://localhost:<port>` on their machine without
 * touching `--host`, Tailscale IPs, or remote firewall config. The lifecycle is
 * managed below — start on port detection, stop on restart/exit/removal.
 */
async function startSshForward(
  serverId: string,
  remotePort: number,
): Promise<{ handleId: number; localPort: number } | null> {
  const server = useAppStore.getState().servers.find((s) => s.id === serverId);
  if (!server) return null;
  try {
    const result = await invoke<{ handle_id: number; local_port: number }>(
      "ssh_forward_port_start",
      {
        host: server.host,
        username: server.username,
        identityFile: server.authMethod === "ssh-key" && server.sshKeyPath ? server.sshKeyPath : null,
        remotePort,
        preferredLocalPort: remotePort,
      },
    );
    return { handleId: result.handle_id, localPort: result.local_port };
  } catch (e) {
    console.error("[DevServer] ssh_forward_port_start failed:", e);
    return null;
  }
}

async function stopSshForward(handleId: number): Promise<void> {
  try {
    await invoke("ssh_forward_port_stop", { handleId });
  } catch (e) {
    console.error("[DevServer] ssh_forward_port_stop failed:", e);
  }
}

// Regex to detect common dev server port patterns in terminal output
const PORT_REGEX = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/;
// Find every http(s) URL with a port — used to harvest "Network: http://192.168.x.x:port" lines etc.
const ALL_URLS_REGEX = /https?:\/\/(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:]+\]):\d{2,5}\/?/g;

/**
 * Pull all addresses from a chunk of dev-server output and split them into
 * the local URL (used to set `port`) and any remote URLs (LAN, Tailscale, …)
 * surfaced to the user via the hover popup on the URL link.
 */
function extractAddresses(buf: string): { networkUrls: string[] } {
  const seen = new Set<string>();
  const network: string[] = [];
  const matches = buf.match(ALL_URLS_REGEX);
  if (!matches) return { networkUrls: network };
  for (const raw of matches) {
    const url = raw.replace(/\/$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    // skip local addresses — those are represented by the localhost link in the UI
    if (/^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::|$)/.test(url)) continue;
    network.push(url);
    if (network.length >= 6) break;
  }
  return { networkUrls: network };
}

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

/** Guess the default port a framework uses based on the command string. */
function guessDefaultPort(command: string): number {
  if (/\bnext\b/.test(command)) return 3000;
  if (/\bvite\b/.test(command)) return 5173;
  if (/\breact-scripts\b/.test(command)) return 3000;
  if (/\bng\s+serve\b|\bangular\b/.test(command)) return 4200;
  if (/\bgatsby\b/.test(command)) return 8000;
  return 3000;
}

/** Build a shell one-liner that kills old processes and removes framework lock files. */
function buildCleanupPrefix(command: string, detectedPort: number, backend?: string): string {
  const parts: string[] = [];
  const defaultPort = guessDefaultPort(command);

  if (backend === "windows") {
    // PowerShell cleanup: kill processes by port
    const killPort = (port: number) =>
      `$p = Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; if ($p) { $p | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }`;
    parts.push(killPort(defaultPort));
    if (detectedPort > 0 && detectedPort !== defaultPort) {
      parts.push(killPort(detectedPort));
    }
    if (/\bnext\b/.test(command)) {
      parts.push("Remove-Item -Force .next\\dev\\lock -ErrorAction SilentlyContinue");
    }
    parts.push("Start-Sleep -Seconds 1");
    return parts.join("; ");
  }

  // WSL/Linux cleanup
  // Always kill the default port first — the stale instance is typically here
  parts.push(`fuser -k ${defaultPort}/tcp 2>/dev/null`);
  // Also kill the detected port if it differs (auto-incremented by framework)
  if (detectedPort > 0 && detectedPort !== defaultPort) {
    parts.push(`fuser -k ${detectedPort}/tcp 2>/dev/null`);
  }
  // Remove framework lock files
  if (/\bnext\b/.test(command)) {
    parts.push("rm -f .next/dev/lock 2>/dev/null");
  }
  parts.push("sleep 1");
  return parts.join("; ");
}

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
  const updateDevServerPort = useAppStore((s) => s.updateDevServerPort);
  const updateDevServerError = useAppStore((s) => s.updateDevServerError);
  const setDevServerNetworkUrls = useAppStore((s) => s.setDevServerNetworkUrls);

  // Track which servers have had their command written
  const commandSentRef = useRef<Set<string>>(new Set());
  // Track which servers have had their port detected (avoid repeated scans)
  const portDetectedRef = useRef<Set<string>>(new Set());
  // Track which servers have been resolved (port found or error detected)
  const resolvedRef = useRef<Set<string>>(new Set());
  // Track retry attempts for lock errors (serverId → attempt count)
  const lockRetryRef = useRef<Map<string, number>>(new Map());
  // Track active stopped-detection monitors (serverId → terminalId)
  const stoppedMonitorRef = useRef<Map<string, string>>(new Map());
  // Active SSH port-forward tunnels keyed by dev-server id
  const tunnelHandlesRef = useRef<Map<string, number>>(new Map());

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
      // Process is gone — tear down its SSH tunnel if any
      const tunnel = tunnelHandlesRef.current.get(serverId);
      if (tunnel !== undefined) {
        tunnelHandlesRef.current.delete(serverId);
        stopSshForward(tunnel);
      }
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
      // Re-enable detection — clear all resolved state BEFORE triggering re-render
      resolvedRef.current.delete(serverId);
      portDetectedRef.current.delete(serverId);
      stoppedMonitorRef.current.delete(serverId);
      // Tear down any active SSH tunnel; a fresh one will spawn on next port detect
      const tunnel = tunnelHandlesRef.current.get(serverId);
      if (tunnel !== undefined) {
        tunnelHandlesRef.current.delete(serverId);
        stopSshForward(tunnel);
      }
      updateDevServerStatus(serverId, "starting");
      updateDevServerPort(serverId, 0);
      updateDevServerError(serverId, undefined);
      setDevServerNetworkUrls(serverId, []);
      setTimeout(() => write(command + "\r"), delayMs);
    },
    [updateDevServerStatus, updateDevServerPort, updateDevServerError, setDevServerNetworkUrls]
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
        const chunk = textDecoder.decode(data, { stream: true });
        buffer += chunk;
        // Only scan last 4KB to avoid memory buildup
        if (buffer.length > 4096) buffer = buffer.slice(-4096);

        // Strip ANSI escape codes for cleaner matching
        const cleanBuffer = buffer.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

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
              // Drop any tunnel from a previous (failed) attempt
              const tunnel = tunnelHandlesRef.current.get(ds.id);
              if (tunnel !== undefined) {
                tunnelHandlesRef.current.delete(ds.id);
                stopSshForward(tunnel);
              }

              const write = getPtyWrite(ds.terminalId);
              if (!write) return;
              write("\x03");
              setTimeout(() => write("\x03"), 100);

              updateDevServerStatus(ds.id, "starting");
              updateDevServerPort(ds.id, 0);
              updateDevServerError(ds.id, undefined);

              const backend = useAppStore.getState().terminalBackend ?? "wsl";
              const cleanup = buildCleanupPrefix(ds.command, ds.port, backend);

              if (attempts === 0) {
                // First retry: kill old process on default port + remove lock, then same command
                const delay = 2500;
                setTimeout(() => write(`${cleanup}; ${ds.command}\r`), delay);
              } else {
                // Second retry: try on a different port (default + 1)
                const fallbackPort = guessDefaultPort(ds.command) + 1;
                const cmdWithPort = injectPort(ds.command, fallbackPort);
                const delay = 2500;
                setTimeout(() => write(`${cleanup}; ${cmdWithPort}\r`), delay);
              }
              return;
            }
            // Max retries exhausted — show error
            resolvedRef.current.add(ds.id);
            updateDevServerError(ds.id, "Lock file conflict — close other instances manually");
            unregisterTerminalDataListener(ds.terminalId);
            return;
          }
        }

        // Skip if fully resolved — stopped monitor (registered by grace timer) handles remaining detection
        if (resolvedRef.current.has(ds.id)) return;

        // If port already detected (still in grace period), watch for early server stop
        if (portDetectedRef.current.has(ds.id)) {
          const cleanChunk = chunk
            .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
            .replace(/\x1b\][^\x07]*\x07/g, "");
          // Shell prompt: $, %, or # followed by a space — server returned to shell
          if (/[\$%#] $/.test(cleanChunk)) {
            const graceTimer = graceTimersRef.current.get(ds.id);
            if (graceTimer) { clearTimeout(graceTimer); graceTimersRef.current.delete(ds.id); }
            resolvedRef.current.add(ds.id);
            updateDevServerStatus(ds.id, "stopped");
            unregisterTerminalDataListener(ds.terminalId);
          }
          return;
        }

        // Check for port
        if (!portFound) {
          const match = cleanBuffer.match(PORT_REGEX);
          if (match) {
            const port = parseInt(match[1], 10);
            if (port > 0 && port <= 65535) {
              portFound = true;
              portDetectedRef.current.add(ds.id);
              lockRetryRef.current.delete(ds.id);
              updateDevServerStatus(ds.id, "running");
              updateDevServerError(ds.id, undefined);

              // For remote dev servers, start an SSH tunnel and surface the
              // *local* port to the UI so opening the browser just works.
              const setPort = (p: number) => {
                const store = useAppStore.getState();
                const current = store.devServers.find((s) => s.id === ds.id);
                if (current && current.port !== p) {
                  useAppStore.setState({
                    devServers: store.devServers.map((srv) =>
                      srv.id === ds.id ? { ...srv, port: p } : srv
                    ),
                  });
                }
              };

              // Harvest LAN / Tailscale / 0.0.0.0 addresses printed alongside the localhost line
              setDevServerNetworkUrls(ds.id, extractAddresses(cleanBuffer).networkUrls);

              if (ds.serverId) {
                // SSH dev servers: do NOT set `port` to the remote port even
                // optimistically — `http://localhost:<remotePort>` doesn't
                // resolve locally and would briefly flash "can't reach page"
                // in the browser pane before the tunnel binds. Only publish
                // the port once we have the *local* forwarded port, so any
                // observer (BrowserPreview, dev-server panel URL link) sees
                // a port that's actually reachable.
                startSshForward(ds.serverId, port).then((res) => {
                  if (!res) {
                    // Tunnel failed — surface it so the dev-server panel and
                    // BrowserPreview show an error instead of spinning forever.
                    updateDevServerError(ds.id, "SSH tunnel failed to start");
                    return;
                  }
                  const cur = useAppStore.getState().devServers.find((s) => s.id === ds.id);
                  if (!cur || cur.status === "stopped" || cur.status === "error") {
                    stopSshForward(res.handleId);
                    return;
                  }
                  // Drop any older tunnel for this dev server (race-safe)
                  const prev = tunnelHandlesRef.current.get(ds.id);
                  if (prev !== undefined && prev !== res.handleId) {
                    stopSshForward(prev);
                  }
                  tunnelHandlesRef.current.set(ds.id, res.handleId);
                  setPort(res.localPort);
                });
              } else {
                setPort(port);
              }
              // After grace period, replace with a lightweight stopped-detection listener
              const timer = setTimeout(() => {
                resolvedRef.current.add(ds.id);
                graceTimersRef.current.delete(ds.id);
                stoppedMonitorRef.current.set(ds.id, ds.terminalId);
                let monBuf = "";
                const monDec = new TextDecoder();
                registerTerminalDataListener(ds.terminalId, (rawData) => {
                  monBuf += monDec.decode(rawData, { stream: true });
                  if (monBuf.length > 2048) monBuf = monBuf.slice(-2048);
                  const clean = monBuf
                    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
                    .replace(/\x1b\][^\x07]*\x07/g, "");
                  // Late-arriving Network: lines (e.g. Vite prints them after the local URL)
                  const late = extractAddresses(clean).networkUrls;
                  if (late.length) setDevServerNetworkUrls(ds.id, late);
                  // Shell prompt: $, %, or # followed by a space
                  if (/[\$%#] $/.test(clean)) {
                    stoppedMonitorRef.current.delete(ds.id);
                    updateDevServerStatus(ds.id, "stopped");
                    unregisterTerminalDataListener(ds.terminalId);
                  }
                });
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
        // Skip resolved servers — they have a stopped monitor active; don't tear it down
        if (!resolvedRef.current.has(ds.id)) {
          unregisterTerminalDataListener(ds.terminalId);
        }
      }
    };
  }, [devServers, updateDevServerStatus, updateDevServerPort, updateDevServerError, setDevServerNetworkUrls, restartServer]);

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
    // Clean up stopped monitors for removed servers
    for (const [serverId, terminalId] of stoppedMonitorRef.current.entries()) {
      if (!currentIds.has(serverId)) {
        unregisterTerminalDataListener(terminalId);
        stoppedMonitorRef.current.delete(serverId);
      }
    }
    // Tear down SSH tunnels for removed servers
    for (const [serverId, handle] of tunnelHandlesRef.current.entries()) {
      if (!currentIds.has(serverId)) {
        tunnelHandlesRef.current.delete(serverId);
        stopSshForward(handle);
      }
    }
    // Re-enable detection for servers that were restarted
    for (const ds of devServers) {
      if (ds.status === "starting" && !ds.errorMessage) {
        resolvedRef.current.delete(ds.id);
        portDetectedRef.current.delete(ds.id);
        // Clear stopped monitor entry (listener itself was already unregistered
        // by the main effect cleanup, which runs before this cleanup effect)
        stoppedMonitorRef.current.delete(ds.id);
        const graceTimer = graceTimersRef.current.get(ds.id);
        if (graceTimer) {
          clearTimeout(graceTimer);
          graceTimersRef.current.delete(ds.id);
        }
      }
    }
  }, [devServers]);

  // ESC to close. Previously this effect also fired a synthetic window resize
  // event to trigger an xterm refit when the panel opened, but TerminalPane
  // refits via its own ResizeObserver on the container element — the synthetic
  // window event was a no-op for refit (TerminalPane has no window.resize
  // listener) and only caused Workspace's browser-slot syncer to do extra
  // forced-reflow work. Removed to keep the resize storm bounded.
  useEffect(() => {
    if (expandedDevServerId) {
      const handleKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") setExpandedDevServerId(null);
      };
      window.addEventListener("keydown", handleKey);
      return () => { window.removeEventListener("keydown", handleKey); };
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
                      ? "#4ade80"
                      : expandedServer.status === "starting"
                        ? "var(--ezy-text-muted)"
                        : "#f87171",
                  opacity: expandedServer.status === "starting" ? 0.6 : 1,
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
              {expandedServer.status === "running" || expandedServer.status === "starting" ? (
                <div
                  title="Stop"
                  style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6, cursor: "pointer", transition: "background-color 120ms ease" }}
                  onClick={() => {
                    const write = getPtyWrite(expandedServer.terminalId);
                    if (write) write("\x03");
                    const tunnel = tunnelHandlesRef.current.get(expandedServer.id);
                    if (tunnel !== undefined) {
                      tunnelHandlesRef.current.delete(expandedServer.id);
                      stopSshForward(tunnel);
                    }
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
                    // Clear resolved state BEFORE triggering re-render so main effect re-registers listener
                    resolvedRef.current.delete(expandedServer.id);
                    portDetectedRef.current.delete(expandedServer.id);
                    stoppedMonitorRef.current.delete(expandedServer.id);
                    const write = getPtyWrite(expandedServer.terminalId);
                    if (write) write(expandedServer.command + "\r");
                    updateDevServerStatus(expandedServer.id, "starting");
                    updateDevServerPort(expandedServer.id, 0);
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
                visibility: ds.id === expandedDevServerId ? "visible" : "hidden",
              }}
            >
              <TerminalPane
                terminalId={ds.terminalId}
                terminalType="devserver"
                workingDir={ds.workingDir}
                serverId={ds.serverId}
                isActive={ds.id === expandedDevServerId}
                paneCount={99}
                hideChrome
                onClose={() => {}}
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
