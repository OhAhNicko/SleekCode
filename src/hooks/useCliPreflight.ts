import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "../store";
import type { RemoteServer, TerminalBackend, TerminalType } from "../types";
import {
  cliStatus,
  invalidateCliStatus,
  isAiCli,
  peekCliStatusSync,
  serverById,
} from "../lib/cli-availability";
import { checkServerReachable } from "../lib/ssh-reachability";

/**
 * Does this pane's CLI exist on the machine the pane will run it on?
 *
 * Answered BEFORE the pane spawns, because the alternative is what users
 * actually saw: a terminal that opens on `zsh:1: command not found: codex` and
 * then sits there. Both renderers gate on this — the native one must not even
 * CREATE its child HWND while blocked, since a DOM card can never be drawn over
 * a child window at any z-index.
 *
 * `"ok"` is the answer for every non-CLI pane, for a CLI that resolves, AND for
 * a backend that failed to answer. Only a definite "not there" blocks: an
 * unreachable host must not be reported as a missing install.
 *
 * `"offline"` is the SSH-only fourth state. The "missing" verdict for a remote
 * server comes from `detectedCliShells` — persisted the last time the
 * connection WORKED — so on its own it cannot distinguish "Codex is not on Job"
 * from "Job is unreachable right now". A remote "missing" is therefore only
 * shown after a live reachability probe confirms the server answers; a server
 * that does not becomes "offline", and the pane says "no connection" instead
 * of offering an install that cannot run.
 */
export type CliGate = "checking" | "ok" | "missing" | "offline";

export interface CliPreflight {
  gate: CliGate;
  /** The server this pane runs on, when it is a remote pane. */
  server: RemoteServer | null;
  /** The backend the check ran against — what the card names. */
  backend: TerminalBackend;
  /** Ask again (the user may have installed it in another window). */
  recheck: () => void;
  /** Stop blocking and spawn — "Open anyway", or a finished install. */
  allow: () => void;
}

export function useCliPreflight(opts: {
  terminalType: TerminalType;
  backend?: TerminalBackend;
  serverId?: string;
}): CliPreflight {
  const { terminalType, serverId } = opts;
  const storeBackend = useAppStore((s) => s.terminalBackend);
  const backend: TerminalBackend = serverId
    ? "ssh"
    : (opts.backend ?? storeBackend ?? "wsl");
  const server = useAppStore((s) => s.servers.find((x) => x.id === serverId) ?? null);

  const gated = isAiCli(terminalType);
  // Start from what is already known WITHOUT awaiting. On the normal path —
  // the startup resolution has run and found the CLI — this is "present" on
  // the very first render, so the pane creates its surface exactly as fast as
  // it did before this check existed. Only an unknown CLI ever waits.
  const [gate, setGate] = useState<CliGate>(() => {
    if (!isAiCli(terminalType)) return "ok";
    const known = peekCliStatusSync(terminalType, backend, serverById(serverId));
    // A remote "missing" is a stale fact until the reachability probe in the
    // effect confirms the server answers — starting at "missing" would flash
    // the install card before the probe can say "offline".
    if (known === "missing") return backend === "ssh" ? "checking" : "missing";
    return known ? "ok" : "checking";
  });
  /** Bumped by recheck; also re-runs the effect. */
  const [attempt, setAttempt] = useState(0);
  /** Latched by "Open anyway" / a successful install so a later re-check can
   *  never take the pane away again. */
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    if (!isAiCli(terminalType) || allowed) {
      setGate("ok");
      return;
    }
    let alive = true;
    // Only announce "checking" when the answer really is unknown — flipping a
    // resolved pane back to checking would tear down its surface.
    if (!peekCliStatusSync(terminalType, backend, serverById(serverId))) setGate("checking");
    void cliStatus(terminalType, backend, serverById(serverId))
      .then(async (status) => {
        if (!alive) return;
        const server = serverById(serverId);
        if (status === "missing" && backend === "ssh" && server) {
          // The remote "missing" verdict is persisted from the last successful
          // probe — verify the server answers TODAY before repeating it. Only
          // a probe that says "reachable, and still missing" earns the install
          // card; `null` (can't tell) falls back to "missing" so an unprovable
          // server keeps the old behavior rather than a false "offline".
          const reachable = await checkServerReachable(server);
          if (alive) setGate(reachable === false ? "offline" : "missing");
          return;
        }
        setGate(status === "missing" ? "missing" : "ok");
      })
      .catch(() => {
        // Could not ask — spawn as before rather than accusing the machine of
        // missing something.
        if (alive) setGate("ok");
      });
    return () => {
      alive = false;
    };
  }, [gated, allowed, terminalType, backend, serverId, attempt]);

  const recheck = useCallback(() => {
    if (!isAiCli(terminalType)) return;
    invalidateCliStatus(terminalType, backend, serverById(serverId));
    setAttempt((n) => n + 1);
  }, [terminalType, backend, serverId]);

  const allow = useCallback(() => setAllowed(true), []);

  return { gate, server, backend, recheck, allow };
}
