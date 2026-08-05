/**
 * Is an AI CLI actually installed on the backend a pane would run it on?
 *
 * Opening a Codex pane on a machine without Codex used to spawn, print
 * `zsh:1: command not found: codex`, and sit there. MADE already resolves all
 * three CLIs per backend at startup (`wsl-cache.ts`, `windows-cli-cache.ts`,
 * `macos-cli-cache.ts`) and probes every SSH server for which shell can see
 * them (`remote-cli-shells.ts`) — this module turns that into a yes/no the
 * panes and launchers can gate on, and `cli-install.ts` fixes the "no".
 *
 * # Three states, not two
 *
 * `"unknown"` is a first-class answer and it renders NOTHING. `wsl-cache.ts`
 * documents a real case where resolution came back empty on hardware where the
 * CLIs worked fine by hand, so an empty cache is not proof of absence — it is
 * a reason to ask again. Only a backend that answered and said "not there"
 * earns the install card. Telling someone to install what they already have is
 * worse than staying silent (the same rule `jira-mcp.ts` follows).
 *
 * # Cost
 *
 * The common case — cache hit — costs one localStorage read and adds nothing
 * to pane-open latency. Only a miss pays for a live `command -v`, and that
 * result is memoised per (cli, backend, distro|server) until something
 * invalidates it.
 */

import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import type { RemoteServer, TerminalBackend, TerminalType } from "../types";
import { getCachedCliPath, getCachedDistro, wslReady } from "./wsl-cache";
import { getCachedWindowsCliPath, windowsReady } from "./windows-cli-cache";
import { getCachedNativeCliPath, nativeReady } from "./macos-cli-cache";
import { ensureRemoteCliShells, pickExecShell } from "./remote-cli-shells";

/** The CLIs MADE can launch a pane with — and therefore install. */
export type AiCli = "claude" | "codex" | "gemini";

export const AI_CLIS: readonly AiCli[] = ["claude", "codex", "gemini"];

export const AI_CLI_LABEL: Record<AiCli, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  gemini: "Gemini CLI",
};

export type CliStatus = "present" | "missing" | "unknown";

/** Narrow a pane's type. Shell and dev-server panes are never gated. */
export function isAiCli(type: TerminalType | string | undefined): type is AiCli {
  return type === "claude" || type === "codex" || type === "gemini";
}

/**
 * The arguments identifying "which machine" — shared by the probe and the
 * installer so they can never disagree about what they are talking about.
 */
export interface CliTarget {
  backend: TerminalBackend;
  distro: string | null;
  host: string | null;
  username: string | null;
  identityFile: string | null;
  /** Login shell that can see the user's PATH on this server. */
  shell: string | null;
}

export function cliTarget(backend: TerminalBackend, server?: RemoteServer | null): CliTarget {
  if (backend === "ssh") {
    return {
      backend,
      distro: null,
      host: server?.host ?? null,
      username: server?.username ?? null,
      identityFile: server?.sshKeyPath ?? null,
      shell: server?.detectedCliShells?.defaultShell ?? null,
    };
  }
  return {
    backend,
    distro: backend === "wsl" ? getCachedDistro() : null,
    host: null,
    username: null,
    identityFile: null,
    shell: null,
  };
}

/** Human name for the place a CLI is missing from — the whole point of the
 *  card is that "not installed" is meaningless without it. */
export function backendLabel(backend: TerminalBackend, server?: RemoteServer | null): string {
  switch (backend) {
    case "ssh":
      return server?.name || server?.host || "this server";
    case "wsl":
      return getCachedDistro() || "WSL";
    case "windows":
      return "Windows";
    default:
      return "this machine";
  }
}

/** Look up a pane's server object the way the PTY hooks do. */
export function serverById(serverId: string | undefined): RemoteServer | null {
  if (!serverId) return null;
  return useAppStore.getState().servers.find((s) => s.id === serverId) ?? null;
}

function keyOf(cli: AiCli, backend: TerminalBackend, server?: RemoteServer | null): string {
  const where = backend === "ssh" ? (server?.id ?? "?") : backend === "wsl" ? (getCachedDistro() ?? "") : "";
  return `${cli}|${backend}|${where}`;
}

const resolved = new Map<string, CliStatus>();
const inflight = new Map<string, Promise<CliStatus>>();

/**
 * Resolve to `fallback` if `p` has not settled in `ms`.
 *
 * This gate sits in front of PANE CREATION, so a slow answer is not merely
 * inelegant — it delays the window the user is waiting for. Every wait here is
 * therefore bounded and every timeout degrades to "unknown", which spawns the
 * pane exactly as MADE did before this feature existed. The check can make a
 * pane better; it must never make one slower to appear.
 */
function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}

/** Long enough for a WSL VM that is merely booting, short enough that a wedged
 *  one does not hold a pane hostage. */
const READY_TIMEOUT_MS = 6_000;
/** The Rust side bounds the probe at 45s; this is the UI's patience for it. */
const PROBE_TIMEOUT_MS = 12_000;

/** The cached path for `cli` on a local backend, if the startup resolution
 *  found one. */
function cachedPath(cli: AiCli, backend: TerminalBackend): string | null {
  if (backend === "wsl") return getCachedCliPath(cli);
  if (backend === "windows") return getCachedWindowsCliPath(cli);
  return getCachedNativeCliPath(cli);
}

/**
 * The answer we can give without awaiting anything — a memoised result, a warm
 * startup cache, or an SSH server that has already been probed.
 *
 * This is what keeps the common case free: a pane whose CLI is already known
 * to exist never enters a "checking" state at all, so nothing about its
 * creation is deferred.
 */
export function peekCliStatusSync(
  cli: AiCli,
  backend: TerminalBackend,
  server?: RemoteServer | null,
): CliStatus | null {
  const known = resolved.get(keyOf(cli, backend, server));
  if (known) return known;
  if (backend === "ssh") {
    const info = server?.detectedCliShells;
    if (!info) return null;
    return pickExecShell(info, cli) ? "present" : "missing";
  }
  return cachedPath(cli, backend) ? "present" : null;
}

async function resolveStatus(
  cli: AiCli,
  backend: TerminalBackend,
  server?: RemoteServer | null,
): Promise<CliStatus> {
  const sync = peekCliStatusSync(cli, backend, server);
  if (sync) return sync;

  if (backend === "ssh") {
    if (!server) return "unknown";
    // The probe already answers this exact question for all three CLIs in one
    // round-trip, and Test Connection refreshes it — no second mechanism.
    const info = await ensureRemoteCliShells(server);
    if (!info) return "unknown";
    return pickExecShell(info, cli) ? "present" : "missing";
  }

  // Ride the startup resolution rather than racing it — the PTY hooks await
  // these same promises before spawning. They resolve on failure too, so the
  // deadline only covers a promise that never settles at all.
  const ready =
    backend === "wsl" ? wslReady : backend === "windows" ? windowsReady : nativeReady;
  const settled = await withDeadline(ready.then(() => true), READY_TIMEOUT_MS, false);
  if (!settled) return "unknown";

  if (cachedPath(cli, backend)) return "present";

  // Empty cache is a question, not an answer — wsl-cache.ts has shipped an
  // empty result on a machine where all three CLIs worked. Ask directly.
  try {
    const path = await withDeadline<string | null>(
      invoke<string>("cli_probe", { cli, ...cliTarget(backend, server) }),
      PROBE_TIMEOUT_MS,
      null,
    );
    if (path === null) return "unknown";
    return path.trim() ? "present" : "missing";
  } catch {
    return "unknown";
  }
}

/** Cached status, resolving on first use. Concurrent callers share one probe. */
export function cliStatus(
  cli: AiCli,
  backend: TerminalBackend,
  server?: RemoteServer | null,
): Promise<CliStatus> {
  const key = keyOf(cli, backend, server);
  const known = resolved.get(key);
  if (known) return Promise.resolve(known);

  const existing = inflight.get(key);
  if (existing) return existing;

  const p = resolveStatus(cli, backend, server)
    .then((status) => {
      // "unknown" is deliberately NOT cached: it means we failed to ask, and
      // the next caller deserves a fresh attempt rather than an inherited
      // shrug.
      if (status !== "unknown") resolved.set(key, status);
      return status;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

/** Status already known without asking — for render paths that cannot await. */
export function peekCliStatus(
  cli: AiCli,
  backend: TerminalBackend,
  server?: RemoteServer | null,
): CliStatus | null {
  return resolved.get(keyOf(cli, backend, server)) ?? null;
}

/**
 * Forget what we know. Called after an install and by the card's Recheck
 * button; with no arguments it clears everything (the distro changed, so every
 * WSL answer belongs to a different machine).
 */
export function invalidateCliStatus(
  cli?: AiCli,
  backend?: TerminalBackend,
  server?: RemoteServer | null,
): void {
  if (!cli || !backend) {
    resolved.clear();
    return;
  }
  resolved.delete(keyOf(cli, backend, server));
}
