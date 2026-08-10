import { useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import LoadingDots from "./LoadingDots";
import { useAppStore } from "../store";
import { getPtyWrite, registerTerminalDataListener, unregisterTerminalDataListener } from "../store/terminalSlice";
import { detectPortConflict } from "../lib/port-conflict";
import { killPortCommand, planRun, rememberPort, type RunPlan } from "../lib/dev-server-ports";
import { isSameProject, resolveDevServerBackend } from "../lib/spawn-dev-server";
import { getDefaultBackend } from "../lib/platform";
import { getPaneState } from "../lib/pane-state-registry";
import { getTerminalActions } from "../lib/terminal-actions";
import { registerDevServerActions, unregisterDevServerActions } from "../lib/dev-server-actions";
import { FaStop, FaPlay } from "react-icons/fa";
import { FaXmark } from "react-icons/fa6";
import { BiRefresh } from "react-icons/bi";
import type { DevServer } from "../types";
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

/** Comfortably past `resolveDevServerBackend`'s own 3s internal deadline, so
 *  this only ever fires for a resolve that broke its contract entirely. */
const BACKEND_RESOLVE_WATCHDOG_MS = 5000;

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

// Common error patterns in dev server output.
//
// Port conflicts are NOT here: `detectPortConflict` runs earlier and owns them,
// because they are the one failure with an automatic way out (retry a port up,
// or free the port). Matching EADDRINUSE here as well would just be a race to
// declare the same failure unrecoverable.
const ERROR_PATTERNS = [
  /npm ERR!/,
  /Error:\s+(.{1,120})/,
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
 * Silent-launch feedback (the 2026-08-07 frozen `tauri:dev` report: the command
 * chain wedged at the WSL→PowerShell interop hop before printing a byte, and
 * nothing anywhere said so).
 *
 * STALL: while "starting", a launch that has printed nothing for this long gets
 * a "no output" hint on the row and panel header. 30s clears every legitimate
 * quiet phase we've measured (npm install cold cache, a cargo link step) while
 * still catching a wedge the same minute it happens. Any PTY byte clears it.
 *
 * WRITE LIVENESS: start/restart are *typed text* into the existing shell. A
 * wedged foreground process ignores ^C, echoes nothing, and swallows the typed
 * command invisibly — so after writing we wait this long for ANY byte, and a
 * dead-silent PTY is escalated to a full pane respawn (`relaunchServer`), the
 * escape hatch the 2026-08-05 fix only gave to already-dead PTYs.
 *
 * PROMPT SETTLE: a shell prompt sitting at the end of the buffer for this long
 * with no port ever scraped means the command exited — status goes to error
 * instead of eternal grey "detecting…". Debounced so a chunk boundary that
 * merely *looks* like a prompt self-cancels when the rest of the line arrives.
 */
const STALL_AFTER_MS = 30_000;
const STALL_SWEEP_MS = 5_000;
const START_ECHO_LIVENESS_MS = 1_500;
const PROMPT_SETTLE_MS = 3_000;

/** Shell prompt at the very end of the (ANSI-stripped) buffer.
 *  Bash/zsh convention matches the existing stopped-monitor; the PS alternative
 *  is anchored to a line starting "PS " so `> made@0.2.16 tauri:dev`-style npm
 *  banners can never match. */
function promptAtEnd(cleanBuffer: string): boolean {
  return /[\$%#] $/.test(cleanBuffer) || /(?:^|\n)PS [^\n]*> $/.test(cleanBuffer);
}

/**
 * Build a shell one-liner that kills old processes and removes framework lock
 * files.
 *
 * `basePort` is the port THIS server was planned onto (`planRun`), not a guess.
 * It used to come from a `guessDefaultPort(command)` that tested the command
 * TEXT for a framework name — and `npm run dev` contains no "vite", so it
 * answered 3000 for almost every project and this prefix fired
 * `fuser -k 3000/tcp` at whatever unrelated project owned 3000. That is MADE
 * itself causing the "dev servers fight over ports" report, and it is the same
 * bug `server-commands.ts` documents for the sibling function it replaced.
 * Zero means "we never worked one out" — then nothing is swept.
 *
 * `sweepBasePort` exists because the base-port kill still clears a stale
 * instance of THIS server that never reported its port. When the project runs
 * several dev servers on the same framework that base may belong to a sibling —
 * restarting the Tauri server would shoot the web server sitting on 5173. With a
 * sibling present we only kill the port this server actually reported, which is
 * the one we know is ours.
 */
/**
 * True when the shell that would run the command no longer exists, so writing
 * to it would vanish.
 *
 * A dev server's start/restart has always been *typed text*: ^C, then the
 * command again. That only works while the PTY is alive — and a dev server
 * routinely outlives its PTY. `wsl --shutdown` (Settings › Danger Zone, or WSL
 * falling over on its own) takes the whole VM down: bash reports its foreground
 * job killed ("Terminated"), the wsl.exe child exits, and `pty.rs` drops the
 * session from its map. The row, the pane and its LAST PAINTED FRAME all
 * survive — so nothing on screen says the terminal is a corpse, and every
 * button silently wrote into a pty id the backend no longer knows (`pty_write`
 * → `Err("PTY not found")`, an unhandled rejection), while still flipping the
 * row to "starting". That is the "can't restart it, it's just stuck" report:
 * a grey dot on "detecting…" with no way back short of removing the server.
 *
 * Both renderers publish `exited` when their PTY dies, and the write registry
 * goes with the pane, so either answer means "respawn, don't type".
 */
function isPtyGone(terminalId: string): boolean {
  return getPaneState(terminalId).exited || !getPtyWrite(terminalId);
}

function buildCleanupPrefix(
  command: string,
  detectedPort: number,
  basePort: number,
  backend?: string,
  sweepBasePort = true,
): string {
  const parts: string[] = [];
  const sweepBase = sweepBasePort && basePort > 0;

  if (backend === "windows") {
    // PowerShell cleanup: kill processes by port
    const killPort = (port: number) =>
      `$p = Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; if ($p) { $p | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }`;
    if (sweepBase) parts.push(killPort(basePort));
    if (detectedPort > 0 && (detectedPort !== basePort || !sweepBase)) {
      parts.push(killPort(detectedPort));
    }
    if (/\bnext\b/.test(command)) {
      parts.push("Remove-Item -Force .next\\dev\\lock -ErrorAction SilentlyContinue");
    }
    parts.push("Start-Sleep -Seconds 1");
    return parts.join("; ");
  }

  // WSL/Linux cleanup
  // Kill this server's own base port first — the stale instance is typically here
  if (sweepBase) parts.push(`fuser -k ${basePort}/tcp 2>/dev/null`);
  // Also kill the detected port if it differs (auto-incremented by framework)
  if (detectedPort > 0 && (detectedPort !== basePort || !sweepBase)) {
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
 * How far the header's control cluster is held off the panel's right edge.
 *
 * The panel is `right: 0`, so its right edge IS the window's right edge — and
 * so is the right edge of whatever workspace pane sits behind it. That pane's
 * header parks up to four 20px buttons (prompt history / expand / restart /
 * close) at 2px gaps behind 6px root padding plus the cluster's 6px expanded
 * padding, i.e. a band from 6px to 92px inboard. The cluster is collapsed to
 * zero width until the pane header is hovered (`.ezy-header-controls`,
 * index.css) — so nothing there is hit-testable while the panel is up — but
 * that doesn't defuse the trap: the first click closes the panel, the panel
 * vanishes, the cursor is now hovering the pane header underneath, and the
 * cluster slides in within 150ms — the second click of a double-click lands
 * on a freshly-materialized (possibly mid-slide) pane button, worst of all
 * the rightmost close. Clearing the whole band is what keeps the panel's
 * controls off it — not just the ✕, since whichever control ends up rightmost
 * inherits the problem.
 */
const HEADER_RIGHT_GUTTER_PX = 96;

/**
 * One metric for every control in the panel header.
 *
 * The four actions used to be three hand-rolled inline SVGs plus a react-icons
 * ✕, in 28px boxes beside the 24px shell toggle, with ink ranging from a 10px
 * solid square down to a 5px cross — the "various alignments and sizes" report.
 * They now share a box, a radius and an icon set with the dev-server SIDEBAR
 * row and with the pane header (`TerminalHeader`), so one action looks the same
 * everywhere it appears instead of three surfaces each inventing a size.
 *
 * A `<button>`, not the `<div onClick>` two of them were: keyboard-reachable
 * and labelled. The line-height zeroing that stops a button from inflating a
 * compact header (CLAUDE.md's CSS gotchas) was already solved on the ✕ here —
 * this just applies it to all four.
 */
function HeaderIconButton({
  label,
  tooltip,
  onClick,
  danger,
  children,
}: {
  label: string;
  tooltip?: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      data-tooltip={tooltip ?? label}
      onClick={onClick}
      style={{
        width: 24,
        height: 24,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
        cursor: "pointer",
        transition: "background-color 120ms ease",
        padding: 0,
        margin: 0,
        border: "none",
        background: "transparent",
        lineHeight: 0,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = danger
          ? "rgba(220,60,60,0.15)"
          : "var(--ezy-accent-glow)";
      }}
      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
    >
      {children}
    </button>
  );
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
  const setDevServerBackend = useAppStore((s) => s.setDevServerBackend);
  const setProjectServerInWindows = useAppStore((s) => s.setProjectServerInWindows);
  const setDevServerStalled = useAppStore((s) => s.setDevServerStalled);

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
  // Timers for grace-period unregistration after port detection
  const graceTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Consecutive failed port probes per dev server (liveness poll below)
  const portFailuresRef = useRef<Map<string, number>>(new Map());
  // Cumulative PTY bytes per dev server — monotonic across respawns, so a
  // snapshot taken before a write can tell "anything at all arrived since".
  const bytesSeenRef = useRef<Map<string, number>>(new Map());
  // Epoch ms of the most recent PTY byte (or command send) per dev server.
  const lastOutputAtRef = useRef<Map<string, number>>(new Map());
  // bytesSeen snapshot taken when the command was last written. Presence arms
  // the prompt-without-port scan; deleted on reset so a fresh spawn's banner
  // prompt can never be mistaken for "the command exited".
  const bytesAtSendRef = useRef<Map<string, number>>(new Map());
  // Pending prompt-settle timers (fix: exited-without-port), keyed by ds.id.
  const promptTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Pending write-liveness timers (start/restart into a possibly-wedged shell).
  const livenessTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Servers currently flagged stalled — mirror of ds.stalledSince, so the data
  // listener can clear on the first byte without a store read per chunk.
  const stalledIdsRef = useRef<Set<string>>(new Set());
  // Runtime port-conflict retries spent, per dev server. Budget is 1: the
  // pre-flight probe already covers the ordinary case, so a conflict here means
  // the port was taken between probe and bind. One silent re-run absorbs that
  // race; a second failure is a real fight the user should see and decide.
  const portRetryRef = useRef<Map<string, number>>(new Map());
  /**
   * What was last typed for this server and which port it was aimed at.
   *
   * Three readers, none of which can recompute it: the conflict branch (a
   * failure message that names no port falls back to the port we aimed for),
   * `rememberPort` (only a port that differs from the project's natural one is
   * worth persisting), and kill-and-retry (which must re-run the EXACT text that
   * failed, not `ds.command`, or an auto-retry's injected `--port` is lost).
   * Deliberately NOT cleared by `resetDetectionState` — it describes the last
   * write, and every write overwrites it.
   */
  const runPlanRef = useRef<Map<string, RunPlan>>(new Map());

  /** Arm the silence trackers for a just-written command: the stall clock
   *  starts now, and the prompt-without-port scan measures output from here. */
  const markCommandSent = useCallback((dsId: string) => {
    bytesAtSendRef.current.set(dsId, bytesSeenRef.current.get(dsId) ?? 0);
    lastOutputAtRef.current.set(dsId, Date.now());
  }, []);

  /**
   * Stop the prompt-without-port scan from judging the gap before a re-run.
   *
   * A retry (lock or port conflict) types ^C, then re-runs some ms later — and
   * `planRun` can spend up to 2s on the port probe in between. Meanwhile the ^C
   * leaves a fresh shell prompt at the end of the buffer while the PREVIOUS
   * run's send snapshot is still armed, which is exactly the signature of
   * "the command exited" — so the 3s settle timer fires mid-retry and parks a
   * bogus "Exited without reporting a port" on a server that is about to start
   * perfectly well. `markCommandSent` re-arms it when the command actually goes.
   *
   * `resetDetectionState` does this too, but the retry paths cannot call that:
   * it also clears the retry counters they are using to bound themselves.
   */
  const disarmPromptScan = useCallback((dsId: string) => {
    bytesAtSendRef.current.delete(dsId);
    const pending = promptTimersRef.current.get(dsId);
    if (pending) {
      clearTimeout(pending);
      promptTimersRef.current.delete(dsId);
    }
  }, []);

  /**
   * The one place a dev-server command is typed.
   *
   * Decides the port first (`planRun`: the project's own port from its config,
   * probed, stepping +1 to the first free one) and types the result. Every
   * launch path goes through here — first spawn, start, restart, the lock retry,
   * the conflict retry — because "which port" was previously nobody's decision
   * at all: the command went out verbatim and whatever appeared in the output
   * became the truth, so two Vite projects both meant 5173 and collided.
   *
   * Async, so callers MUST do their synchronous work (`resetDetectionState`,
   * `markStarting`) before awaiting this, per the sync-before-render rule in
   * dev-server-actions.ts. `ds` must be the row as it was BEFORE `markStarting`
   * zeroed its port — `planRun` needs to know which port this server is
   * vacating, or a restart climbs one port every time.
   *
   * Returns false when the PTY's write function vanished mid-plan; the caller
   * decides whether that is a respawn or an error.
   */
  const writePlannedCommand = useCallback(
    async (
      ds: DevServer,
      opts?: { avoid?: number; force?: boolean; prefix?: string; command?: string },
    ): Promise<boolean> => {
      let plan: RunPlan;
      if (opts?.command !== undefined) {
        // The caller already knows what must run. Kill-and-retry is the reason:
        // it frees a port in the same typed line, so probing here would read the
        // port as still busy and move the server off the one we just cleared.
        const prev = runPlanRef.current.get(ds.id);
        plan = {
          command: opts.command,
          port: prev?.port ?? null,
          natural: prev?.natural ?? null,
          controllable: prev?.controllable ?? false,
        };
      } else {
        plan = await planRun(ds, { avoid: opts?.avoid, force: opts?.force });
      }
      const write = getPtyWrite(ds.terminalId);
      if (!write) return false;
      runPlanRef.current.set(ds.id, plan);
      write((opts?.prefix ? `${opts.prefix}; ` : "") + plan.command + "\r");
      markCommandSent(ds.id);
      return true;
    },
    [markCommandSent],
  );

  /** Accumulated PTY text per dev server, for the port/error scan.
   *
   *  MUST live outside the detection effect. The effect depends on `devServers`
   *  and there are ~35 places that mutate it, so it re-runs constantly — and it
   *  used to declare `let buffer = ""` inside, meaning every re-run threw away
   *  everything scanned so far and re-registered a fresh listener. A port line
   *  split across two PTY chunks with any store update in between was lost for
   *  good: the intermittent "detecting..." forever. Keyed by dev-server id so a
   *  re-registration picks up exactly where the previous one left off. */
  const scanBuffersRef = useRef<Map<string, string>>(new Map());

  /** Dev servers we've already kicked a backend resolve for, so the effect
   *  below doesn't re-fire while `devServers` churns. */
  const backendResolveRef = useRef<Set<string>>(new Set());

  // Backstop: never leave a dev server without a backend.
  //
  // The pane is not rendered at all until `ds.backend` is set, so a server that
  // never gets one shows a permanently black terminal — no PTY, no command, no
  // error, and a sidebar row stuck on "detecting...". The create-dialog path in
  // DevServerTab.tsx did exactly that for every server it made. That call site
  // is fixed, but "every creation path must remember to resolve the backend" is
  // the kind of rule a new call site quietly breaks, and the failure is silent.
  // Resolving here covers all of them, including ones not written yet.
  useEffect(() => {
    for (const ds of devServers) {
      if (ds.backend !== undefined || backendResolveRef.current.has(ds.id)) continue;
      backendResolveRef.current.add(ds.id);

      // …and a watchdog under the backstop, because the backstop only helps if
      // the promise it starts actually settles. Both branches above set a
      // backend, so the one remaining way to land in the blank state is a
      // resolve that never finishes — and the id is latched in
      // `backendResolveRef` by then, so nothing retries it. That is exactly
      // what a dev server reported stuck on "detecting..." looked like: an
      // expand panel with no terminal and no shell toggle (the toggle only
      // renders once `backend` is set), so the UI could not even say which
      // shell it was waiting for.
      const watchdog = setTimeout(() => {
        const current = useAppStore.getState().devServers.find((d) => d.id === ds.id);
        if (!current || current.backend !== undefined) return;
        const fallback = useAppStore.getState().terminalBackend ?? getDefaultBackend();
        console.warn(
          `[DevServer] backend resolve never settled for ${ds.workingDir} — forcing "${fallback}"`,
        );
        setDevServerBackend(ds.id, fallback);
      }, BACKEND_RESOLVE_WATCHDOG_MS);

      resolveDevServerBackend(ds.workingDir, ds.serverId)
        .then((backend) => setDevServerBackend(ds.id, backend))
        .catch(() => {
          const fallback = useAppStore.getState().terminalBackend ?? getDefaultBackend();
          setDevServerBackend(ds.id, fallback);
        })
        .finally(() => clearTimeout(watchdog));
    }
  }, [devServers, setDevServerBackend]);

  const handlePtyReady = useCallback(
    (serverId: string, terminalId: string, command: string) => {
      if (commandSentRef.current.has(serverId)) return;
      commandSentRef.current.add(serverId);
      // onPtyReady fires from usePty's onSpawned — the PTY process exists, so
      // write() delivers. (It used to fire at React MOUNT, seconds before the
      // spawn resolved on cold boot; write() drops data until then, so every
      // auto-started server got a bare shell and "detecting..." forever.)
      // The 300ms gives the shell a beat to start reading stdin. The retry
      // loop is a backstop for the write registry only: if the write fn never
      // materialises, say so in the sidebar instead of staying "detecting...".
      const giveUp = () => {
        // Allow a manual restart / backend switch to try again.
        commandSentRef.current.delete(serverId);
        updateDevServerError(serverId, "Auto-start failed — terminal never became ready");
      };
      const attempt = (triesLeft: number) => {
        if (getPtyWrite(terminalId)) {
          // Re-read the row rather than trusting the `command` argument: the
          // port pre-flight needs the whole DevServer (project path for the
          // config read, backend, current port), and this is a fresh spawn so
          // nothing of ours is holding a port yet.
          const ds = useAppStore.getState().devServers.find((d) => d.id === serverId);
          if (!ds) {
            const write = getPtyWrite(terminalId);
            if (write) { write(command + "\r"); markCommandSent(serverId); }
            return;
          }
          void writePlannedCommand(ds).then((ok) => { if (!ok) giveUp(); });
          return;
        }
        if (triesLeft > 0) {
          setTimeout(() => attempt(triesLeft - 1), 500);
          return;
        }
        giveUp();
      };
      setTimeout(() => attempt(10), 300);
    },
    [updateDevServerError, markCommandSent, writePlannedCommand]
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
      // A dead PTY can't be stalled, and its pending settle/liveness timers
      // must not fire against whatever replaces it.
      stalledIdsRef.current.delete(serverId);
      setDevServerStalled(serverId, undefined);
      const promptTimer = promptTimersRef.current.get(serverId);
      if (promptTimer) {
        clearTimeout(promptTimer);
        promptTimersRef.current.delete(serverId);
      }
      const livenessTimer = livenessTimersRef.current.get(serverId);
      if (livenessTimer) {
        clearTimeout(livenessTimer);
        livenessTimersRef.current.delete(serverId);
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
    [updateDevServerStatus, updateDevServerError, setDevServerStalled]
  );

  /**
   * Forget everything the port/error scanner remembers about the previous run.
   *
   * MUST be called synchronously BEFORE the store update that triggers the
   * re-render. A ref mutation does not re-render, so clearing these in a later
   * effect is too late: the main effect has already read `resolvedRef`, skipped
   * both the unregister and the re-register, and nothing will ever run it again
   * — the row then sits on "detecting…" while the server is perfectly healthy
   * (docs/learnings/2026-03-09-devserver-stopped-detection.md, "Bug 2").
   */
  const resetDetectionState = useCallback((serverId: string) => {
    resolvedRef.current.delete(serverId);
    portDetectedRef.current.delete(serverId);
    stoppedMonitorRef.current.delete(serverId);
    lockRetryRef.current.delete(serverId);
    // A deliberate re-launch earns a fresh conflict-retry budget: the user has
    // acted (start, restart, "Another port", "Kill <port>"), so the next
    // collision is a new fight, not a continuation of the last one.
    portRetryRef.current.delete(serverId);
    // Disarm the silence trackers: prompt-without-port must not re-arm off the
    // PREVIOUS run's send snapshot (a fresh spawn's banner ends in a prompt),
    // and pending settle/liveness timers belong to the run being torn down.
    bytesAtSendRef.current.delete(serverId);
    stalledIdsRef.current.delete(serverId);
    const promptTimer = promptTimersRef.current.get(serverId);
    if (promptTimer) {
      clearTimeout(promptTimer);
      promptTimersRef.current.delete(serverId);
    }
    const livenessTimer = livenessTimersRef.current.get(serverId);
    if (livenessTimer) {
      clearTimeout(livenessTimer);
      livenessTimersRef.current.delete(serverId);
    }
    // Stale output must not be re-scanned: it still holds the previous run's
    // port line, which would be "detected" before the new server even starts.
    scanBuffersRef.current.delete(serverId);
    const graceTimer = graceTimersRef.current.get(serverId);
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimersRef.current.delete(serverId);
    }
    // Tear down any active SSH tunnel; a fresh one will spawn on next port detect
    const tunnel = tunnelHandlesRef.current.get(serverId);
    if (tunnel !== undefined) {
      tunnelHandlesRef.current.delete(serverId);
      stopSshForward(tunnel);
    }
  }, []);

  /** The store half of "this server is coming up": no port, no error, no URLs. */
  const markStarting = useCallback(
    (serverId: string) => {
      updateDevServerStatus(serverId, "starting");
      updateDevServerPort(serverId, 0);
      updateDevServerError(serverId, undefined);
      setDevServerNetworkUrls(serverId, []);
      setDevServerStalled(serverId, undefined);
    },
    [updateDevServerStatus, updateDevServerPort, updateDevServerError, setDevServerNetworkUrls, setDevServerStalled]
  );

  /**
   * Bring a dead terminal back and re-run the command in it (see `isPtyGone`).
   *
   * Respawning goes through the pane's OWN restart action — the same one the
   * pane header and the post-`wsl --shutdown` sweep use — so there is exactly
   * one respawn implementation per renderer rather than a dev-server-specific
   * copy. `commandSentRef` is cleared so the fresh PTY's `onPtyReady` re-sends
   * the command, which is how it got there on the very first spawn.
   *
   * If no pane registered an action there is nothing to respawn, and saying so
   * beats a "starting" the row can never leave.
   */
  const relaunchServer = useCallback(
    (ds: DevServer) => {
      const actions = getTerminalActions(ds.terminalId);
      if (!actions) {
        updateDevServerError(
          ds.id,
          "Terminal is gone — remove this server and add it again",
        );
        return;
      }
      resetDetectionState(ds.id);
      commandSentRef.current.delete(ds.id);
      markStarting(ds.id);
      actions.restart();
    },
    [resetDetectionState, markStarting, updateDevServerError]
  );

  /**
   * A typed write only worked if the shell answered. Called after writing into
   * a live-looking PTY: if not one byte arrives within the grace period, the
   * foreground process is wedged (it isn't echoing, so ^C and the command both
   * vanished invisibly — the 2026-08-07 frozen `tauri:dev`) and the only real
   * escape is the same respawn a dead PTY gets.
   */
  const escalateIfSilent = useCallback(
    (dsId: string, bytesBefore: number, graceMs: number) => {
      const prev = livenessTimersRef.current.get(dsId);
      if (prev) clearTimeout(prev);
      livenessTimersRef.current.set(
        dsId,
        setTimeout(() => {
          livenessTimersRef.current.delete(dsId);
          const cur = useAppStore.getState().devServers.find((d) => d.id === dsId);
          if (!cur || cur.status !== "starting") return;
          if ((bytesSeenRef.current.get(dsId) ?? 0) !== bytesBefore) return;
          console.warn(
            `[DevServer] no PTY output ${graceMs}ms after write — respawning wedged terminal for ${cur.command}`,
          );
          relaunchServer(cur);
        }, graceMs),
      );
    },
    [relaunchServer],
  );

  /** Run the command. Respawns the terminal first when the PTY is gone. */
  const startServer = useCallback(
    (ds: DevServer) => {
      if (isPtyGone(ds.terminalId)) {
        relaunchServer(ds);
        return;
      }
      // Both synchronous and both before the await, so the refs are clear by the
      // time `markStarting`'s store write triggers the re-render.
      resetDetectionState(ds.id);
      markStarting(ds.id);
      // `ds`, not the store copy: markStarting has just zeroed the port there,
      // and the port this row is vacating is what stops the pre-flight probe
      // reading its own dying instance as a conflict.
      void writePlannedCommand(ds).then((ok) => {
        // Measured from the write, not from before the port probe — the grace
        // period is about the shell answering, not about how long we spent
        // deciding what to send it.
        if (ok) escalateIfSilent(ds.id, bytesSeenRef.current.get(ds.id) ?? 0, START_ECHO_LIVENESS_MS);
      });
    },
    [relaunchServer, resetDetectionState, markStarting, escalateIfSilent, writePlannedCommand]
  );

  /** Send Ctrl+C (twice for stubborn processes), wait, then re-run the command. */
  const restartServer = useCallback(
    (ds: DevServer, delayMs = 1500) => {
      if (isPtyGone(ds.terminalId)) {
        relaunchServer(ds);
        return;
      }
      const write = getPtyWrite(ds.terminalId);
      if (!write) return;
      const bytesBefore = bytesSeenRef.current.get(ds.id) ?? 0;
      write("\x03");
      // Second Ctrl+C after 100ms for processes that need confirmation
      setTimeout(() => write("\x03"), 100);
      resetDetectionState(ds.id);
      markStarting(ds.id);
      // The retype is gated on the ^C having produced SOMETHING. A responsive
      // shell echoes a fresh prompt (or the dying server's teardown) well
      // within the delay; a wedged one stays byte-silent and gets respawned
      // instead of having a second command typed into the void.
      const timer = setTimeout(() => {
        livenessTimersRef.current.delete(ds.id);
        const cur = useAppStore.getState().devServers.find((d) => d.id === ds.id);
        if (!cur || cur.status !== "starting") return;
        if ((bytesSeenRef.current.get(ds.id) ?? 0) === bytesBefore) {
          console.warn(
            `[DevServer] no PTY output ${delayMs}ms after ^C — respawning wedged terminal for ${cur.command}`,
          );
          relaunchServer(cur);
          return;
        }
        // Planned here rather than before the ^C: by now the old instance has
        // let go of its port, so the probe sees the truth and the server goes
        // straight back onto the port it was already using.
        // `cur` carries a command the user may have just edited; `ds.port`
        // carries the port being vacated, which the store copy no longer has.
        void writePlannedCommand({ ...cur, port: ds.port }).then((ok) => {
          if (!ok) relaunchServer(cur);
        });
      }, delayMs);
      const prev = livenessTimersRef.current.get(ds.id);
      if (prev) clearTimeout(prev);
      livenessTimersRef.current.set(ds.id, timer);
    },
    [relaunchServer, resetDetectionState, markStarting, writePlannedCommand]
  );

  /**
   * Re-run this server somewhere else, skipping the port that just refused it.
   *
   * Backs the "Another port" button on the row's error banner. Goes through the
   * normal planner with the bad port excluded, so it lands on the next free step
   * of the same +1 ladder rather than a second, ad-hoc idea of what "another
   * port" means.
   */
  const retryOnAnotherPort = useCallback(
    (ds: DevServer) => {
      if (isPtyGone(ds.terminalId)) {
        relaunchServer(ds);
        return;
      }
      resetDetectionState(ds.id);
      markStarting(ds.id);
      // `force`: the user asked for another port in so many words, so we append
      // `--port` even to a command we could not have reasoned about on our own.
      // If it turns out the command rejects the flag, that failure is visible,
      // costs one restart, and never touched the stored command text.
      void writePlannedCommand(ds, { avoid: ds.conflictPort, force: true }).then((ok) => {
        if (!ok) relaunchServer(ds);
      });
    },
    [relaunchServer, resetDetectionState, markStarting, writePlannedCommand]
  );

  /**
   * Free the contested port, then re-run exactly what failed.
   *
   * The kill is TYPED INTO THIS SERVER'S OWN SHELL rather than run from Rust,
   * which is what puts it on the right machine: a WSL-backed server kills inside
   * the distro, an SSH server kills on the remote host. Killing from the Windows
   * side would shoot WSL's localhost-forwarding relay instead of the server.
   *
   * `command` is the last text we actually sent, not `ds.command` — if an
   * earlier auto-retry injected `--port 5174` and 5174 is what is contested,
   * re-running the stored command would quietly aim at 5173 instead.
   */
  const killPortAndRetry = useCallback(
    (ds: DevServer) => {
      const port = ds.conflictPort;
      if (!port) return;
      if (isPtyGone(ds.terminalId)) {
        relaunchServer(ds);
        return;
      }
      const backend = ds.backend ?? useAppStore.getState().terminalBackend ?? getDefaultBackend();
      const lastRun = runPlanRef.current.get(ds.id)?.command ?? ds.command;
      resetDetectionState(ds.id);
      markStarting(ds.id);
      void writePlannedCommand(ds, {
        prefix: killPortCommand(port, backend),
        command: lastRun,
      }).then((ok) => {
        if (!ok) relaunchServer(ds);
      });
    },
    [relaunchServer, resetDetectionState, markStarting, writePlannedCommand]
  );

  /**
   * Publish both actions per row so every OTHER surface — the sidebar's ▶ / ↻,
   * the row context menu, the port-edit restart — drives the same code instead
   * of reimplementing it without access to the refs above.
   *
   * The server is re-read from the store at call time: `handleSaveEdit` commits
   * the new command and then restarts, so the closure's copy would re-run the
   * command the user just edited away.
   */
  useEffect(() => {
    for (const ds of devServers) {
      const current = () => useAppStore.getState().devServers.find((d) => d.id === ds.id);
      registerDevServerActions(ds.id, {
        start: () => { const cur = current(); if (cur) startServer(cur); },
        restart: () => { const cur = current(); if (cur) restartServer(cur); },
        retryOtherPort: () => { const cur = current(); if (cur) retryOnAnotherPort(cur); },
        killConflictPort: () => { const cur = current(); if (cur) killPortAndRetry(cur); },
      });
    }
    return () => {
      for (const ds of devServers) unregisterDevServerActions(ds.id);
    };
  }, [devServers, startServer, restartServer, retryOnAnotherPort, killPortAndRetry]);


  /**
   * Switch a (local) dev server between the WSL bash and Windows PowerShell
   * shells. Persists the choice as a per-project override, clears all detection
   * state so the remounted pane re-sends the command, and flips ds.backend —
   * which changes the TerminalPane key and remounts it in the new shell.
   */
  const switchBackend = useCallback(
    (ds: DevServer, target: "wsl" | "windows") => {
      if (ds.backend === target) return;
      // Remember the choice for next time (overrides Tauri auto-detect).
      setProjectServerInWindows(ds.workingDir, ds.serverId, target === "windows");
      // Clear detection state so the fresh pane re-sends + re-detects cleanly.
      commandSentRef.current.delete(ds.id);
      resolvedRef.current.delete(ds.id);
      portDetectedRef.current.delete(ds.id);
      stoppedMonitorRef.current.delete(ds.id);
      lockRetryRef.current.delete(ds.id);
      scanBuffersRef.current.delete(ds.id);
      const graceTimer = graceTimersRef.current.get(ds.id);
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimersRef.current.delete(ds.id);
      }
      unregisterTerminalDataListener(ds.terminalId);
      updateDevServerStatus(ds.id, "starting");
      updateDevServerPort(ds.id, 0);
      updateDevServerError(ds.id, undefined);
      setDevServerNetworkUrls(ds.id, []);
      setDevServerBackend(ds.id, target);
    },
    [setProjectServerInWindows, setDevServerBackend, updateDevServerStatus, updateDevServerPort, updateDevServerError, setDevServerNetworkUrls]
  );

  // Register data listeners for port detection + error detection
  useEffect(() => {
    for (const ds of devServers) {
      if (resolvedRef.current.has(ds.id)) continue;

      const textDecoder = new TextDecoder();

      registerTerminalDataListener(ds.terminalId, (data) => {
        // Silence trackers first: every byte proves the launch is alive, so it
        // feeds the stall sweep, the write-liveness gates, and clears any
        // standing "no output" flag before the scan below does anything.
        bytesSeenRef.current.set(
          ds.id,
          (bytesSeenRef.current.get(ds.id) ?? 0) + data.byteLength,
        );
        lastOutputAtRef.current.set(ds.id, Date.now());
        if (stalledIdsRef.current.delete(ds.id)) setDevServerStalled(ds.id, undefined);
        const chunk = textDecoder.decode(data, { stream: true });
        let buffer = (scanBuffersRef.current.get(ds.id) ?? "") + chunk;
        // Only scan last 4KB to avoid memory buildup
        if (buffer.length > 4096) buffer = buffer.slice(-4096);
        scanBuffersRef.current.set(ds.id, buffer);

        // Strip ANSI escape codes for cleaner matching.
        //
        // The OSC strip must accept BOTH terminators. It previously required a
        // BEL (\x07), but modern dev servers emit OSC 8 hyperlinks terminated by
        // ST (\x1b\\) — and because the payload class was greedy over everything
        // except BEL, one ST-terminated hyperlink followed later by any
        // BEL-terminated sequence made this delete the entire span between them,
        // URL and port included. Excluding ESC from the payload keeps each
        // sequence self-contained.
        const cleanBuffer = buffer
          .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
          .replace(/\x1b\][^\x1b\x07]*(?:\x07|\x1b\\)/g, "");

        // ALWAYS check for lock errors first — even after port detection
        for (const pattern of LOCK_ERROR_PATTERNS) {
          if (pattern.test(cleanBuffer)) {
            // Cancel any grace timer
            const graceTimer = graceTimersRef.current.get(ds.id);
            if (graceTimer) {
              clearTimeout(graceTimer);
              graceTimersRef.current.delete(ds.id);
            }
            portDetectedRef.current.delete(ds.id);
            portDetectedRef.current.delete(ds.id);
            // Clear the scan text. It now survives re-registration (that is the
            // whole point), so leaving the lock-error line in it would match
            // again on the very next chunk and retry in a loop.
            scanBuffersRef.current.delete(ds.id);

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
              disarmPromptScan(ds.id);
              write("\x03");
              setTimeout(() => write("\x03"), 100);

              updateDevServerStatus(ds.id, "starting");
              updateDevServerPort(ds.id, 0);
              updateDevServerError(ds.id, undefined);

              // Use the server's resolved backend so a Windows-routed dev server
              // gets the PowerShell cleanup (Get-NetTCPConnection), not WSL fuser.
              const backend = ds.backend ?? useAppStore.getState().terminalBackend ?? "wsl";
              // Sweeping this server's base port is only safe while this is the
              // project's only server — otherwise it may be a sibling's port.
              const hasSiblings =
                useAppStore
                  .getState()
                  .devServers.filter((o) => isSameProject(o, ds.workingDir, ds.serverId)).length > 1;
              // The port the last launch was PLANNED onto — a fact, where the
              // old `guessDefaultPort(command)` was a guess that answered 3000
              // for every `npm run dev` and swept an unrelated project's server.
              const plan = runPlanRef.current.get(ds.id);
              const basePort = plan?.port ?? plan?.natural ?? 0;
              const cleanup = buildCleanupPrefix(ds.command, ds.port, basePort, backend, !hasSiblings);

              if (attempts === 0) {
                // First retry: free this server's own ports + remove the lock, then the same command
                setTimeout(() => { void writePlannedCommand(ds, { prefix: cleanup }); }, 2500);
              } else {
                // Second retry: somewhere else entirely, off the port that keeps failing
                setTimeout(() => {
                  void writePlannedCommand(ds, { prefix: cleanup, avoid: basePort || undefined });
                }, 2500);
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

        // ── Port conflict ──
        //
        // Checked BEFORE port detection, not after, for a reason that has
        // nothing to do with priority: Kestrel prints "Failed to bind to address
        // http://127.0.0.1:5000: address already in use", and PORT_REGEX would
        // read that as a successful bind and paint the row green on a server
        // that never started. Anything that says "taken" has to be ruled out
        // before anything that says "listening" is believed.
        //
        // One silent retry, then hand it to the user. The pre-flight probe
        // already covers the ordinary collision, so reaching here means the port
        // went between probe and bind — worth absorbing once, not worth looping
        // over while two projects fight.
        {
          const conflict = detectPortConflict(cleanBuffer);
          if (conflict) {
            const busy = conflict.port ?? runPlanRef.current.get(ds.id)?.port ?? 0;
            const attempts = portRetryRef.current.get(ds.id) ?? 0;
            // The conflict line survives re-registration otherwise, and would
            // match again on the next chunk — the same loop the lock path guards.
            scanBuffersRef.current.delete(ds.id);
            unregisterTerminalDataListener(ds.terminalId);

            // Only retry automatically when we can actually change the outcome.
            // For a command we may not append `--port` to (no package.json, no
            // explicit flag of its own) a retry would re-run the identical line
            // and fail identically — so go straight to the banner, where "Kill
            // <port>" still works and "Another port" is the user's call to make.
            const canMove = runPlanRef.current.get(ds.id)?.controllable ?? false;
            const write = attempts < 1 && canMove ? getPtyWrite(ds.terminalId) : undefined;
            if (write) {
              portRetryRef.current.set(ds.id, attempts + 1);
              // Deleted, not added: markStarting's store write re-renders, the
              // main effect finds this server unresolved and hands it a fresh
              // listener. That is how the lock retry gets its scanner back too.
              resolvedRef.current.delete(ds.id);
              disarmPromptScan(ds.id);
              write("\x03");
              setTimeout(() => write("\x03"), 100);
              markStarting(ds.id);
              setTimeout(() => {
                const cur = useAppStore.getState().devServers.find((d) => d.id === ds.id);
                if (!cur || cur.status !== "starting") return;
                void writePlannedCommand(
                  { ...cur, port: ds.port },
                  { avoid: busy > 0 ? busy : undefined },
                );
              }, 2500);
              return;
            }

            resolvedRef.current.add(ds.id);
            updateDevServerError(
              ds.id,
              busy > 0 ? `Port ${busy} is already in use` : "That port is already in use",
              busy > 0 ? busy : undefined,
            );
            return;
          }
        }

        // Check for port
        if (!portDetectedRef.current.has(ds.id)) {
          const match = cleanBuffer.match(PORT_REGEX);
          if (match) {
            const port = parseInt(match[1], 10);
            if (port > 0 && port <= 65535) {
              portDetectedRef.current.add(ds.id);
              lockRetryRef.current.delete(ds.id);
              updateDevServerError(ds.id, undefined);

              // For remote dev servers, start an SSH tunnel and surface the
              // *local* port to the UI so opening the browser just works.
              // Status goes green HERE and nowhere else, so "running" always
              // implies a reachable port.
              //
              // It used to be set the moment the port was SCRAPED, before the
              // port was published — and for SSH that is an async tunnel-bind
              // later, while `setPort` also returns silently when the entry is
              // missing from the store. Either way the UI ended up green while
              // still showing "detecting...", and BrowserPreview (which requires
              // `status === "running" && port > 0`) sat on its waiting overlay
              // forever. A green dot next to "detecting..." is a contradiction
              // the user has to debug for us; make it unrepresentable instead.
              const setPort = (p: number) => {
                const store = useAppStore.getState();
                const current = store.devServers.find((s) => s.id === ds.id);
                if (!current) return;
                if (current.port !== p) {
                  useAppStore.setState({
                    devServers: store.devServers.map((srv) =>
                      srv.id === ds.id ? { ...srv, port: p } : srv
                    ),
                  });
                }
                updateDevServerStatus(ds.id, "running");
                // Remember the port ONLY when it isn't the one the project
                // names anyway — a server pushed onto 5174 by a sibling comes
                // back on 5174 next launch instead of re-fighting for 5173,
                // while one that landed on its own port clears the entry so a
                // later config change is never overruled by an old preference.
                rememberPort(ds, p, runPlanRef.current.get(ds.id));
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
                graceTimersRef.current.delete(ds.id);
                // The liveness poll may have already declared this server
                // stopped — registering a monitor then would REPLACE nothing
                // (the listener slot is empty) but would sit forever waiting
                // for a prompt on a dead server.
                const cur = useAppStore.getState().devServers.find((d) => d.id === ds.id);
                if (!cur || cur.status === "stopped" || cur.status === "error") return;
                resolvedRef.current.add(ds.id);
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
        if (!portDetectedRef.current.has(ds.id)) {
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

        // Exited without a port: the shell prompt is back at the end of the
        // buffer and nothing above matched. ERROR_PATTERNS is a finite list —
        // cargo's lowercase `error:` and Tauri's colon-less `Error The
        // "beforeDevCommand" terminated…` both slip through it, and the PTY
        // never dies (the shell survives its child), so without this the row
        // sat on grey "detecting…" forever with the failure only in the
        // scrollback. Armed only once real output followed the command echo,
        // so the pre-command prompt and the echo itself can never trip it; the
        // settle timer is cleared on every later chunk, so a chunk boundary
        // that merely resembles a prompt self-cancels.
        const pendingPrompt = promptTimersRef.current.get(ds.id);
        if (pendingPrompt) {
          clearTimeout(pendingPrompt);
          promptTimersRef.current.delete(ds.id);
        }
        const sentAt = bytesAtSendRef.current.get(ds.id);
        const armed =
          sentAt !== undefined &&
          (bytesSeenRef.current.get(ds.id) ?? 0) - sentAt > ds.command.length + 32;
        if (armed && promptAtEnd(cleanBuffer)) {
          promptTimersRef.current.set(
            ds.id,
            setTimeout(() => {
              promptTimersRef.current.delete(ds.id);
              if (portDetectedRef.current.has(ds.id) || resolvedRef.current.has(ds.id)) return;
              const cur = useAppStore.getState().devServers.find((d) => d.id === ds.id);
              if (!cur || cur.status !== "starting") return;
              resolvedRef.current.add(ds.id);
              stalledIdsRef.current.delete(ds.id);
              setDevServerStalled(ds.id, undefined);
              updateDevServerError(ds.id, "Exited without reporting a port — see terminal output");
              unregisterTerminalDataListener(ds.terminalId);
            }, PROMPT_SETTLE_MS),
          );
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
  }, [devServers, updateDevServerStatus, updateDevServerPort, updateDevServerError, setDevServerNetworkUrls, setDevServerStalled, restartServer, markStarting, writePlannedCommand, disarmPromptScan]);

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
    for (const id of scanBuffersRef.current.keys()) {
      if (!currentIds.has(id)) scanBuffersRef.current.delete(id);
    }
    for (const id of resolvedRef.current) {
      if (!currentIds.has(id)) resolvedRef.current.delete(id);
    }
    for (const id of lockRetryRef.current.keys()) {
      if (!currentIds.has(id)) lockRetryRef.current.delete(id);
    }
    for (const id of portRetryRef.current.keys()) {
      if (!currentIds.has(id)) portRetryRef.current.delete(id);
    }
    for (const id of runPlanRef.current.keys()) {
      if (!currentIds.has(id)) runPlanRef.current.delete(id);
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
    // Silence trackers for removed servers
    for (const id of bytesSeenRef.current.keys()) {
      if (!currentIds.has(id)) bytesSeenRef.current.delete(id);
    }
    for (const id of lastOutputAtRef.current.keys()) {
      if (!currentIds.has(id)) lastOutputAtRef.current.delete(id);
    }
    for (const id of bytesAtSendRef.current.keys()) {
      if (!currentIds.has(id)) bytesAtSendRef.current.delete(id);
    }
    for (const id of stalledIdsRef.current) {
      if (!currentIds.has(id)) stalledIdsRef.current.delete(id);
    }
    for (const [id, timer] of promptTimersRef.current.entries()) {
      if (!currentIds.has(id)) {
        clearTimeout(timer);
        promptTimersRef.current.delete(id);
      }
    }
    for (const [id, timer] of livenessTimersRef.current.entries()) {
      if (!currentIds.has(id)) {
        clearTimeout(timer);
        livenessTimersRef.current.delete(id);
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

  // ── Stall sweep: "starting" with zero PTY output is a wedge, not a compile ──
  //
  // A launch chain can freeze without its PTY dying (the 2026-08-07 report:
  // `tauri:dev` wedged at the WSL→PowerShell interop hop — pane alive, byte
  // count zero, row on "detecting…" indefinitely). The screen alone cannot
  // distinguish that from a long `npm install`, so this sweep flags any
  // starting server whose command was sent and whose PTY has been silent for
  // STALL_AFTER_MS. The flag is pure feedback (row + panel header hint); the
  // first byte to arrive clears it in the data listener.
  useEffect(() => {
    const sweep = setInterval(() => {
      const now = Date.now();
      for (const ds of useAppStore.getState().devServers) {
        if (ds.status !== "starting") continue;
        if (stalledIdsRef.current.has(ds.id)) continue;
        // Only once a command was written — a pane still resolving its backend
        // has nothing to be silent about.
        if (!bytesAtSendRef.current.has(ds.id)) continue;
        const last = lastOutputAtRef.current.get(ds.id);
        if (last === undefined || now - last < STALL_AFTER_MS) continue;
        stalledIdsRef.current.add(ds.id);
        useAppStore.getState().setDevServerStalled(ds.id, last);
      }
    }, STALL_SWEEP_MS);
    return () => clearInterval(sweep);
  }, []);

  // ── Liveness poll: the authoritative "is it still up" for LOCAL servers ──
  //
  // The output-based stopped-detection watches for the shell prompt at the
  // END of the buffer — and loses the race when the dying server prints
  // stragglers AFTER the prompt (`concurrently` echoes "[web] … exited with
  // code SIGTERM" once bash has already prompted). No further output ever
  // arrives, so the buffer never ends with a prompt again and the sidebar +
  // header stayed green on a dead server. `status === "running"` always
  // implies a detected port (see setPort), so poll the port itself: whatever
  // killed the server — Ctrl+C, SIGTERM, a crash, kill -9 — the socket closes.
  //
  // Local servers only. An SSH dev server's local port is our own tunnel:
  // ssh keeps accepting local connects even after the remote process died, so
  // a probe would test the tunnel, not the server. Those keep the output
  // heuristic.
  //
  // Two consecutive failures before declaring death: one failed probe can be
  // a restart-in-progress or a transiently exhausted accept queue.
  useEffect(() => {
    const timer = setInterval(() => {
      for (const ds of useAppStore.getState().devServers) {
        if (ds.serverId) continue;
        if (ds.status !== "running" || !(ds.port > 0)) {
          portFailuresRef.current.delete(ds.id);
          continue;
        }
        void invoke<boolean>("port_check", { port: ds.port })
          .then((alive) => {
            // Re-read: the server may have been restarted or re-ported while
            // the probe was in flight — a verdict about the OLD port must not
            // touch the new state.
            const cur = useAppStore.getState().devServers.find((d) => d.id === ds.id);
            if (!cur || cur.status !== "running" || cur.port !== ds.port) {
              portFailuresRef.current.delete(ds.id);
              return;
            }
            if (alive) {
              portFailuresRef.current.delete(ds.id);
              return;
            }
            const fails = (portFailuresRef.current.get(ds.id) ?? 0) + 1;
            portFailuresRef.current.set(ds.id, fails);
            if (fails < 2) return;
            portFailuresRef.current.delete(ds.id);
            // Retire ALL detection machinery for this server, exactly as the
            // prompt path does: resolved (so the scan effect never
            // re-registers), no monitor, no grace timer, no stray listener.
            const grace = graceTimersRef.current.get(ds.id);
            if (grace) {
              clearTimeout(grace);
              graceTimersRef.current.delete(ds.id);
            }
            stoppedMonitorRef.current.delete(ds.id);
            unregisterTerminalDataListener(ds.terminalId);
            resolvedRef.current.add(ds.id);
            updateDevServerStatus(ds.id, "stopped");
          })
          .catch(() => {});
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [updateDevServerStatus]);

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
        data-native-occluder={isOpen ? "expanded" : undefined}
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
              // Asymmetric on purpose — see HEADER_RIGHT_GUTTER_PX.
              padding: `10px ${HEADER_RIGHT_GUTTER_PX}px 10px 16px`,
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
                  fontSize: "calc(var(--ezy-font-scale, 1) * 13px)",
                  fontWeight: 600,
                  color: "var(--ezy-text)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {expandedServer.command}
              </span>
              <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-text-muted)", flexShrink: 0 }}>
                {expandedServer.projectName}
              </span>
              {expandedServer.status === "starting" && expandedServer.stalledSince !== undefined && (
                <span
                  data-tooltip="Nothing has printed for 30+ seconds — the launch may be wedged. Restart kills and respawns the terminal."
                  style={{
                    fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                    color: "var(--ezy-red)",
                    flexShrink: 0,
                  }}
                >
                  no output
                </span>
              )}
            </div>
            {/* gap 2 matches the pane header's `gap-0.5`; every control in this
                row is 24px tall, the shell toggle included, so the row has one
                baseline instead of 28px boxes beside a 24px group. */}
            <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
              {/* Shell toggle — local servers on a Windows host only. Lets the user
                  override the Tauri auto-detection (WSL bash ⇄ Windows PowerShell). */}
              {!expandedServer.serverId &&
                (expandedServer.backend === "wsl" || expandedServer.backend === "windows") && (
                <div
                  role="group"
                  aria-label="Dev server shell"
                  data-tooltip="Which shell the dev server runs in. Tauri projects default to Windows so `npm run tauri:dev` uses the Windows toolchain instead of failing in WSL."
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    height: 24,
                    // Wider than the 2px between the action buttons: "which
                    // shell" is a different question from "do something".
                    marginRight: 8,
                    border: "1px solid var(--ezy-border)",
                    borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
                    overflow: "hidden",
                    userSelect: "none",
                  }}
                >
                  {(["wsl", "windows"] as const).map((mode) => {
                    const active = expandedServer.backend === mode;
                    return (
                      <div
                        key={mode}
                        data-tooltip={mode === "windows" ? "Run in Windows PowerShell" : "Run in WSL bash"}
                        onClick={() => switchBackend(expandedServer, mode)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          height: "100%",
                          padding: "0 8px",
                          fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                          fontWeight: 600,
                          letterSpacing: 0.2,
                          cursor: active ? "default" : "pointer",
                          backgroundColor: active ? "var(--ezy-accent)" : "transparent",
                          color: active ? "#fff" : "var(--ezy-text-muted)",
                          transition: "background-color 120ms ease, color 120ms ease",
                        }}
                        onMouseEnter={(e) => { if (!active) e.currentTarget.style.color = "var(--ezy-text)"; }}
                        onMouseLeave={(e) => { if (!active) e.currentTarget.style.color = "var(--ezy-text-muted)"; }}
                      >
                        {mode === "windows" ? "Win" : "WSL"}
                      </div>
                    );
                  })}
                </div>
              )}
              {/* Sizes here are set by measured INK, not by nominal `size` —
                  these three glyphs come from three icon sets and fill their
                  viewBoxes by wildly different amounts, which is how the old
                  header ended up with a 6.3px ✕ beside a 10px square. Rendered
                  widths: Restart 10.8, Stop 8.7, ✕ 9.0. Restart runs ~1.25×
                  the filled marks on purpose — an outlined glyph reads lighter
                  than a solid one of the same width.

                  BiRefresh needs no `scale()` here (the pane header's 1.3× is
                  correcting a nominal 12 in a 28px-tall header); at 13 its own
                  viewBox padding lands it exactly where it should be. */}
              <HeaderIconButton
                label="Restart"
                tooltip="Restart the dev server"
                onClick={() => { restartServer(expandedServer); }}
              >
                <BiRefresh size={13} color="var(--ezy-text-muted)" />
              </HeaderIconButton>

              {/* Stop / Start */}
              {expandedServer.status === "running" || expandedServer.status === "starting" ? (
                <HeaderIconButton
                  label="Stop"
                  tooltip="Stop the dev server"
                  danger
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
                >
                  <FaStop size={10} color="var(--ezy-text-muted)" />
                </HeaderIconButton>
              ) : (
                <HeaderIconButton
                  label="Start"
                  tooltip="Start the dev server"
                  onClick={() => { startServer(expandedServer); }}
                >
                  <FaPlay size={10} color="var(--ezy-accent)" />
                </HeaderIconButton>
              )}

              {/* The two questions this row answers are not the same question.
                  Restart and Stop act on the SERVER; ✕ only puts the panel away
                  and leaves the server running. That distinction was carried
                  solely by ✕ declining Stop's red hover — invisible until you
                  hover it. One hairline says it up front. */}
              <span
                aria-hidden
                style={{
                  width: 1,
                  height: 14,
                  margin: "0 6px",
                  backgroundColor: "var(--ezy-border)",
                  flexShrink: 0,
                }}
              />

              {/* Close — the panel only. The server keeps running, which is why
                  this borrows the neutral hover rather than Stop's red. Escape
                  already closes, and so does a click on the backdrop, but
                  neither is discoverable. */}
              <HeaderIconButton
                label="Close"
                tooltip="Close. The dev server keeps running."
                onClick={() => setExpandedDevServerId(null)}
              >
                <FaXmark size={14} color="var(--ezy-text-muted)" />
              </HeaderIconButton>
            </div>
          </div>
        )}

        {/* Terminal container */}
        <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
          {devServers.map((ds) => {
            // Wait for the spawn backend to resolve (Tauri auto-detect / project
            // override) before mounting — otherwise we'd spawn a throwaway WSL
            // shell that runs the command and fails before the correct PowerShell
            // pane takes over.
            //
            // Say so rather than rendering nothing. An empty black pane is
            // indistinguishable from "the server started and printed nothing",
            // which is precisely what made this hard to diagnose. The effect
            // above guarantees this state is transient.
            if (ds.backend === undefined) {
              if (ds.id !== expandedDevServerId) return null;
              return (
                <div
                  key={ds.id}
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                    color: "var(--ezy-text-muted)",
                  }}
                >
                  <LoadingDots>Preparing terminal</LoadingDots>
                </div>
              );
            }
            return (
              <div
                key={ds.id}
                style={{
                  position: "absolute",
                  inset: 0,
                  visibility: ds.id === expandedDevServerId ? "visible" : "hidden",
                }}
              >
                <TerminalPane
                  // Remount when the backend changes (header toggle) so usePty
                  // re-reads it — backendRef is only initialised at mount.
                  key={ds.backend}
                  terminalId={ds.terminalId}
                  terminalType="devserver"
                  workingDir={ds.workingDir}
                  serverId={ds.serverId}
                  backend={ds.backend}
                  isActive={ds.id === expandedDevServerId}
                  // Same expression, and deliberately so. `isTabActive` means
                  // "is this pane's surface actually on screen" — for dev-server
                  // panes that is exactly `expanded`, since this host is global
                  // rather than per-tab and parks every non-expanded pane behind
                  // `visibility: hidden`. Unlike the Workspace case there is only
                  // ever ONE expanded dev server, so `isActive` is already
                  // globally unique here; passing it twice keeps the keyboard
                  // -focus guard honest instead of relying on that coincidence.
                  isTabActive={ds.id === expandedDevServerId}
                  paneCount={99}
                  hideChrome
                  onClose={() => {}}
                  onChangeType={() => {}}
                  onFocus={() => {}}
                  onPtyReady={() => handlePtyReady(ds.id, ds.terminalId, ds.command)}
                  onPtyExit={(code) => handlePtyExit(ds.id, code)}
                />
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
