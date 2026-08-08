/**
 * The `made-knowledge` MCP server — detection and one-click registration.
 *
 * NexusMind's sidebar and `@`-references already work without any of this: the
 * frontend talks to the knowledge service directly. What the MCP server buys is
 * the other direction — Claude, Codex and Gemini READING and WRITING the same
 * memory themselves, with attribution MADE can trust. Until a CLI is registered,
 * an agent asked to "check the project state" has no way to reach it.
 *
 * All three CLIs speak MCP over stdio and all three would launch the same
 * adapter binary; they just keep their config in different places and their
 * `mcp add` flags differ (Gemini defaults to PROJECT scope, Codex has no scope
 * at all). Each CLI's own writer is invoked rather than MADE editing the files.
 *
 * Unlike the Atlassian server, there is no auth handoff: the transport is stdio
 * to a local binary, so a successful registration is the whole story.
 */

import { invoke } from "@tauri-apps/api/core";
import type { TerminalBackend } from "../../types";
import { getCachedDistro } from "../wsl-cache";
import { getCachedWindowsCliPath } from "../windows-cli-cache";
import { getCachedNativeCliPath } from "../macos-cli-cache";
import type { KnowledgeCli, KnowledgeMcpStatus } from "./types";
import { KNOWLEDGE_CLIS, KNOWLEDGE_CLI_LABEL } from "./types";

export { KNOWLEDGE_CLIS, KNOWLEDGE_CLI_LABEL };

/**
 * Full product names, for the settings rows.
 *
 * Separate from `KNOWLEDGE_CLI_LABEL` (which is the short form the sidebar and
 * toasts use) rather than a second definition of it: a settings row has space
 * to say "Claude Code" and is clearer for it, while a one-line toast naming all
 * three at full length would ellipsize.
 */
export const KNOWLEDGE_CLI_PRODUCT_NAME: Record<KnowledgeCli, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  gemini: "Gemini CLI",
};

/** The server name MADE registers under, in every CLI's config — per BUILD
 *  (debug registers `made-knowledge-dev`; live/dev isolation). Release
 *  default; the boot fetch in `KnowledgeEngine` applies the Rust-served
 *  spelling. Rust owns all real naming — this value is display/fallback only. */
export let KNOWLEDGE_MCP_SERVER_NAME = "made-nexus";

export function applyKnowledgeMcpServerName(name: unknown): void {
  if (typeof name === "string" && name) KNOWLEDGE_MCP_SERVER_NAME = name;
}

/**
 * What one CLI's config says about the server.
 *
 * Extends the plain status with the one question a bare boolean cannot answer:
 * a CLI can be configured and still be pointing at a DIFFERENT MADE install's
 * adapter — a leftover from a moved or reinstalled copy. That reads as
 * "Connected" while every tool call goes somewhere else, so it gets its own
 * state and its own repair action.
 */
export interface KnowledgeMcpRegistration extends KnowledgeMcpStatus {
  /** Adapter path this CLI has on file. Absent when not configured. */
  registeredPath?: string;
  /**
   * False only when the backend positively identified a different adapter.
   * `undefined` means the backend did not report it — which must NOT render as
   * a mismatch, for the same reason `checked:false` does not render as missing.
   */
  pathMatches?: boolean;
  /** Why this row can do nothing here, e.g. on a remote project. */
  blockedReason?: string;
}

const UNKNOWN: KnowledgeMcpRegistration = {
  configured: false,
  scope: "",
  name: KNOWLEDGE_MCP_SERVER_NAME,
  checked: false,
};

/**
 * One wording for a registration's state, shared by every surface that renders
 * it (the settings rows and the sidebar's Agents section) so the copy cannot
 * drift between them. The "MCP" prefix is load-bearing: under a row that is
 * NAMED after the CLI, a bare "Connected" reads as "the CLI is installed",
 * which is not what is known.
 *
 * `null` renders as unknown — callers that can distinguish "still checking"
 * branch on that themselves before asking for a label.
 */
export function knowledgeMcpStatusLabel(status: KnowledgeMcpRegistration | null): {
  label: string;
  color: string;
} {
  if (!status || !status.checked) {
    return { label: "MCP status unknown", color: "var(--ezy-text-muted)" };
  }
  if (status.configured && status.pathMatches === false) {
    return { label: "Registered elsewhere", color: "var(--ezy-red, #e55)" };
  }
  // A legacy-NAMED entry (pre made-nexus rename) is ours but stale: the Fix
  // re-registers it under the canonical name.
  if (status.configured && status.name && status.name !== KNOWLEDGE_MCP_SERVER_NAME) {
    return { label: "Update needed", color: "var(--ezy-red, #e55)" };
  }
  if (status.configured) {
    return {
      label:
        status.scope && status.scope !== "user"
          ? `MCP connected (${status.scope})`
          : "MCP connected",
      color: "#10b981",
    };
  }
  return { label: "MCP not set up", color: "var(--ezy-red, #e55)" };
}

/**
 * Cross-surface mutual exclusion for registration work.
 *
 * Two surfaces can start an install or remove — the settings row and the
 * sidebar's Agents section — and nothing on the Rust side refuses a second
 * concurrent `mcp add`: the CLIs' own writers do read-modify-write over an
 * unlocked config file, where the later writer silently discards the earlier
 * one's work. A `busy` flag inside one component cannot see the other surface,
 * so the in-flight set lives here at module level and both render from it.
 */
const mcpOpsInFlight = new Set<KnowledgeCli>();
const mcpOpListeners = new Set<() => void>();

export function isKnowledgeMcpOpBusy(cli: KnowledgeCli): boolean {
  return mcpOpsInFlight.has(cli);
}

/** Subscribe to in-flight changes; returns the unsubscribe. Pairs with
 *  `useSyncExternalStore` in the components that render busy state. */
export function subscribeKnowledgeMcpOps(cb: () => void): () => void {
  mcpOpListeners.add(cb);
  return () => {
    mcpOpListeners.delete(cb);
  };
}

/**
 * Run one CLI's registration mutation, holding that CLI's slot for as long as
 * the work genuinely takes (see `MCP_OP_SLOW_MS` — never released by a timer).
 * Rejects immediately when the CLI already has an operation in flight, which a
 * correctly-disabled button should have prevented from being requested at all.
 */
export async function runExclusiveKnowledgeMcpOp<T>(
  cli: KnowledgeCli,
  work: () => Promise<T>,
): Promise<T> {
  if (mcpOpsInFlight.has(cli)) {
    throw new Error(
      `A ${KNOWLEDGE_CLI_PRODUCT_NAME[cli]} registration is already running — wait for it to finish.`,
    );
  }
  mcpOpsInFlight.add(cli);
  for (const cb of mcpOpListeners) cb();
  try {
    return await work();
  } finally {
    mcpOpsInFlight.delete(cli);
    for (const cb of mcpOpListeners) cb();
  }
}

/** SSH panes run their CLI on another machine, and the adapter is a local
 *  binary that talks to a local service — there is nothing to register there. */
export const KNOWLEDGE_MCP_REMOTE_REASON = "Remote projects are not supported yet";

/**
 * Reject if `work` has not settled in `ms`.
 *
 * Same policy as `jira-mcp.ts` and `knowledge/api.ts`: the backend bounds its
 * own work, but reaching it crosses an IPC hop, and every UI behind these calls
 * has one unrecoverable failure mode — a spinner that never stops.
 */
function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Reading a config file. Slower than this means WSL is not answering. */
const STATUS_TIMEOUT_MS = 30_000;

/**
 * When a registration has run long enough to be worth mentioning.
 *
 * NOT a timeout, and the difference is the whole point. Registration mutates a
 * CLI's config file through that CLI's own writer, and none of them lock it: a
 * second `mcp add` racing the first is a read-modify-write over the same
 * ~/.claude.json, where the later writer silently discards whatever the first
 * one — or a live pane — put there.
 *
 * The frontend cannot cancel an `invoke`, so a deadline here could only ever
 * stop WAITING, never stop the work. Giving up on the wait while the process
 * runs is what re-enabled the button and invited exactly that second writer,
 * and the WSL path makes it reachable: the backend's 45s bound starts only
 * after VM boot and a full login+interactive profile, none of which it covers.
 *
 * So this drives a "still running" NOTICE and nothing else. The control stays
 * held until the real call settles.
 */
export const MCP_OP_SLOW_MS = 75_000;

/**
 * Read one CLI's registration, degrading to "unknown" rather than to "missing".
 *
 * The distinction is the whole contract of this function. Telling someone to
 * install what they already have is worse than saying nothing, and a CLI that
 * is not on this machine produces the same unreadable-config signal as one whose
 * config we simply failed to reach.
 */
export async function readKnowledgeMcpStatus(
  cli: KnowledgeCli,
  backend: TerminalBackend,
  projectPath?: string,
): Promise<KnowledgeMcpRegistration> {
  if (backend === "ssh") {
    return { ...UNKNOWN, blockedReason: KNOWLEDGE_MCP_REMOTE_REASON };
  }
  return withTimeout(readStatus(cli, backend, projectPath), STATUS_TIMEOUT_MS, "timed out").catch(
    () => UNKNOWN,
  );
}

async function readStatus(
  cli: KnowledgeCli,
  backend: TerminalBackend,
  projectPath?: string,
): Promise<KnowledgeMcpRegistration> {
  try {
    if (backend === "native") {
      return normalize(
        await invoke("knowledge_mcp_status_native", { projectPath: projectPath ?? null, cli }),
      );
    }
    if (backend === "windows") {
      return normalize(
        await invoke("knowledge_mcp_status_windows", { projectPath: projectPath ?? null, cli }),
      );
    }
    return normalize(
      await invoke("knowledge_mcp_status", {
        projectPath: projectPath ?? null,
        distro: getCachedDistro() || null,
        cli,
      }),
    );
  } catch {
    // Includes "command not found" while the Rust half is still being built.
    return UNKNOWN;
  }
}

/**
 * Shape-tolerant parsing, matching `knowledge/api.ts`.
 *
 * A field the backend has not shipped yet must read as its safe default, not
 * leak `undefined` into a render — and for `pathMatches` the safe default is
 * "not reported", which shows no mismatch warning at all.
 */
function normalize(raw: unknown): KnowledgeMcpRegistration {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    configured: r.configured === true,
    scope: typeof r.scope === "string" ? r.scope : "",
    name: typeof r.name === "string" && r.name ? r.name : KNOWLEDGE_MCP_SERVER_NAME,
    checked: r.checked === true,
    registeredPath: typeof r.registeredPath === "string" ? r.registeredPath : undefined,
    pathMatches: typeof r.pathMatches === "boolean" ? r.pathMatches : undefined,
  };
}

/**
 * Register the server at USER scope, so one registration serves every project —
 * the adapter resolves which project it is in from its own working directory.
 *
 * Resolves with the CLI's own output and rejects with its error text, which the
 * caller must SHOW: it is the only signal that a set-up attempt failed.
 *
 * Deliberately UNBOUNDED — see `MCP_OP_SLOW_MS`. The returned promise settles
 * when the registration is genuinely over, which is the only moment it is safe
 * to let anyone start another one.
 */
export function installKnowledgeMcp(
  cli: KnowledgeCli,
  backend: TerminalBackend,
): Promise<string> {
  if (backend === "ssh") return Promise.reject(new Error(KNOWLEDGE_MCP_REMOTE_REASON));
  return runInstall(cli, backend);
}

function runInstall(cli: KnowledgeCli, backend: TerminalBackend): Promise<string> {
  if (backend === "native") {
    return invoke<string>("knowledge_mcp_install_direct", {
      cliPath: getCachedNativeCliPath(cli) ?? null,
      cli,
    });
  }
  if (backend === "windows") {
    return invoke<string>("knowledge_mcp_install_direct", {
      cliPath: getCachedWindowsCliPath(cli) ?? null,
      cli,
    });
  }
  return invoke<string>("knowledge_mcp_install", { distro: getCachedDistro() || null, cli });
}

/**
 * Which registration to remove.
 *
 * Both fields identify an entry that ALREADY EXISTS, so they must come from
 * detection rather than from what MADE would have written. MADE registers as
 * `made-knowledge` at user scope, but the matcher also recognises an entry
 * under any name whose command points at our adapter, and Gemini's own
 * `mcp add` defaults to PROJECT scope — so the thing on disk is regularly not
 * the thing we would have created. Removing at the assumed name and scope
 * simply found nothing, reported success, and left the row showing the
 * registration it had just claimed to delete.
 *
 * Omit either one to accept the Rust default (`made-knowledge` / `user`).
 * Never pass an empty string: that is `Some("")`, which matches no entry and
 * fails the per-CLI scope validation, rather than meaning "unspecified".
 */
export interface KnowledgeMcpTarget {
  name?: string;
  scope?: string;
}

/**
 * Unregister. Same contract as install, including the deliberate absence of a
 * deadline: a remove that is still running is a writer on the same file, and
 * "Update registration" fires an install the moment this settles.
 */
export function removeKnowledgeMcp(
  cli: KnowledgeCli,
  backend: TerminalBackend,
  target: KnowledgeMcpTarget = {},
): Promise<string> {
  if (backend === "ssh") return Promise.reject(new Error(KNOWLEDGE_MCP_REMOTE_REASON));
  return runRemove(cli, backend, target);
}

function runRemove(
  cli: KnowledgeCli,
  backend: TerminalBackend,
  target: KnowledgeMcpTarget,
): Promise<string> {
  // `|| null` rather than `?? null`: an empty string is what detection yields
  // for "not reported", and it must reach Rust as absent, not as a literal "".
  const name = target.name || null;
  const scope = target.scope || null;
  if (backend === "native") {
    return invoke<string>("knowledge_mcp_remove_direct", {
      cliPath: getCachedNativeCliPath(cli) ?? null,
      cli,
      name,
      scope,
    });
  }
  if (backend === "windows") {
    return invoke<string>("knowledge_mcp_remove_direct", {
      cliPath: getCachedWindowsCliPath(cli) ?? null,
      cli,
      name,
      scope,
    });
  }
  return invoke<string>("knowledge_mcp_remove", {
    distro: getCachedDistro() || null,
    cli,
    name,
    scope,
  });
}

/**
 * Where THIS MADE's adapter binary lives.
 *
 * Only used to explain a mismatch — "registered to X, this MADE is at Y" — so a
 * failed read costs a tooltip, never a wrong state. Cached because the answer
 * cannot change while the app is running.
 */
let adapterPath: string | null | undefined;
export async function readAdapterPath(): Promise<string | null> {
  if (adapterPath !== undefined) return adapterPath;
  adapterPath = await invoke<string>("knowledge_adapter_path").catch(() => null);
  return adapterPath;
}

/** One live adapter connection, as `knowledge_mcp_connections` reports it. */
export interface KnowledgeMcpConnection {
  agentKind: KnowledgeCli;
  /** "stdio" today; the field exists because the wire allows for more later. */
  transport: string;
  /** True when this connection may write, i.e. it owns a writable project. */
  writable: boolean;
  projectPath?: string;
  paneId?: string;
  connectedAt?: number;
}

/**
 * Adapters currently attached to this MADE instance.
 *
 * Distinct from the rows above, and the distinction is the useful part: a CLI
 * can be correctly *registered* and still not be *connected* — because no pane
 * has started it since, or because it was registered to another MADE. This is
 * the list that answers "is it actually working right now?".
 */
export async function readKnowledgeMcpConnections(): Promise<KnowledgeMcpConnection[]> {
  const raw = await withTimeout(
    invoke<unknown>("knowledge_mcp_connections"),
    STATUS_TIMEOUT_MS,
    "timed out",
  ).catch(() => null);
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): KnowledgeMcpConnection[] => {
    const r = (entry ?? {}) as Record<string, unknown>;
    const kind = r.agentKind;
    if (kind !== "claude" && kind !== "codex" && kind !== "gemini") return [];
    return [
      {
        agentKind: kind,
        transport: typeof r.transport === "string" && r.transport ? r.transport : "stdio",
        // Rust serializes `mode: "rw" | "ro"` (McpConnectionInfo); accept a plain
        // `writable` boolean too so neither side is pinned to the other's spelling.
        writable: r.writable === true || r.mode === "rw",
        projectPath: typeof r.projectPath === "string" ? r.projectPath : undefined,
        paneId: typeof r.paneId === "string" ? r.paneId : undefined,
        connectedAt: typeof r.connectedAt === "number" ? r.connectedAt : undefined,
      },
    ];
  });
}

/** "Claude Code · connected · stdio · read/write" (spec §7.9). */
export function connectionLine(c: KnowledgeMcpConnection): string {
  return `${KNOWLEDGE_CLI_PRODUCT_NAME[c.agentKind]} · connected · ${c.transport} · ${
    c.writable ? "read/write" : "read only"
  }`;
}
