/**
 * Atlassian (Jira) MCP server — detection and one-click registration.
 *
 * Without this server configured, a Jira ticket pane spawns perfectly and then
 * reports it cannot reach Jira — which reads as "the feature is broken". So
 * MADE shows the state plainly and offers to set it up.
 *
 * All three CLIs speak MCP and all three reach the same Atlassian endpoint;
 * they just keep their config in different places and different formats, and
 * their `mcp add` flags differ (Gemini defaults to PROJECT scope, Codex has no
 * scope at all). Each CLI's own writer is invoked rather than MADE editing the
 * files — see the Rust side.
 *
 * MADE does not authenticate: that handoff is an interactive browser OAuth, so
 * it stays visible to the user (`/mcp` in a pane, or `codex mcp login`).
 */

import { invoke } from "@tauri-apps/api/core";
import type { TerminalBackend } from "../types";
import { getCachedDistro } from "./wsl-cache";
import { getCachedWindowsCliPath } from "./windows-cli-cache";
import { getCachedNativeCliPath } from "./macos-cli-cache";

/** The CLIs that can carry a Jira ticket pane. */
export type JiraCli = "claude" | "codex" | "gemini";

export const JIRA_CLIS: readonly JiraCli[] = ["claude", "codex", "gemini"];

/** Narrow a session's/terminal's type to a Jira CLI. Anything else — a shell
 *  pane, or a ticket recorded before the picker existed — means Claude. */
export function jiraCliOfSession(type: string | undefined): JiraCli {
  return type === "codex" || type === "gemini" ? type : "claude";
}

export const JIRA_CLI_LABEL: Record<JiraCli, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
};

export interface JiraMcpStatus {
  configured: boolean;
  /** "user" | "local" | "project" — empty when not configured. Codex has no
   *  scopes (one global config), so it only ever reports "user". */
  scope: string;
  name: string;
  /** False when the config could not be read at all. Render "unknown", never
   *  "not set up" — telling someone to install what they already have is worse
   *  than saying nothing. */
  checked: boolean;
}

const UNKNOWN: JiraMcpStatus = { configured: false, scope: "", name: "", checked: false };

/**
 * Reject if `work` has not settled in `ms`.
 *
 * The backend bounds every command it runs, but "the backend" is itself
 * reachable only across an IPC hop into a webview, and the UI behind these
 * calls has one unrecoverable failure mode: a spinner that never stops. So the
 * frontend keeps its own, LONGER bound — long enough that a real backend error
 * always wins the race and gets shown, short enough that nothing spins forever
 * if the command never answers at all.
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

/** Reading a config file. Anything slower than this means WSL is not answering. */
const STATUS_TIMEOUT_MS = 30_000;
/** Must exceed the backend's own 45s add deadline, so its message wins. */
const INSTALL_TIMEOUT_MS = 75_000;

/**
 * How each CLI finishes the OAuth handoff MADE deliberately does not perform.
 * Claude and Gemini both do it from inside the running CLI; Codex has a
 * dedicated subcommand instead (there is no `/mcp` in its TUI).
 */
export const JIRA_MCP_AUTH_HINT: Record<JiraCli, string> = {
  claude: "Run /mcp in a Claude pane to sign in to Atlassian.",
  codex: "Run codex mcp login atlassian to sign in.",
  gemini: "Run /mcp auth atlassian in a Gemini pane to sign in.",
};

/**
 * Codex's sign-in cannot be completed on a remote host from here, and saying so
 * is the whole point: its OAuth callback binds `127.0.0.1:<random>` ON THAT
 * HOST, which your browser cannot reach. Claude and Gemini both authenticate
 * from inside the running pane, so SSH costs them nothing.
 */
export const CODEX_MCP_SSH_AUTH =
  "Registered, but codex mcp login can't finish over SSH — its callback binds to the server's own localhost.";

/** SSH needs key auth: the remote calls run with BatchMode, so there is nobody
 *  to type a password to. */
export interface JiraMcpServer {
  host: string;
  username: string;
  sshKeyPath?: string;
  authMethod?: string;
  /** Probed shell that can resolve this CLI remotely (see remote-cli-shells). */
  shellFor?: (cli: JiraCli) => string | undefined;
}

function sshKeyOf(server: JiraMcpServer | null | undefined): string | null {
  const key = server?.sshKeyPath?.trim();
  return key ? key : null;
}

export async function readJiraMcpStatus(
  cli: JiraCli,
  backend: TerminalBackend,
  projectPath?: string,
  server?: JiraMcpServer | null,
): Promise<JiraMcpStatus> {
  // A status read that never answers must degrade to "unknown", which is
  // already a first-class state, rather than leaving the row on "Checking…".
  // The WSL variant reaches \\wsl.localhost, which BOOTS a stopped VM and can
  // hang outright on a wedged one — the realistic way this stalls.
  return withTimeout(
    readStatus(cli, backend, projectPath, server),
    STATUS_TIMEOUT_MS,
    "timed out",
  ).catch(() => UNKNOWN);
}

async function readStatus(
  cli: JiraCli,
  backend: TerminalBackend,
  projectPath?: string,
  server?: JiraMcpServer | null,
): Promise<JiraMcpStatus> {
  try {
    if (backend === "native") {
      return await invoke<JiraMcpStatus>("jira_mcp_status_native", {
        projectPath: projectPath ?? null,
        cli,
      });
    }
    if (backend === "windows") {
      return await invoke<JiraMcpStatus>("jira_mcp_status_windows", {
        projectPath: projectPath ?? null,
        cli,
      });
    }
    // SSH panes run the CLI on the REMOTE host, so that is the only config
    // that decides whether a ticket pane can reach Jira. Key auth only: the
    // probe runs under BatchMode, with nobody to type a password to — a
    // password-auth server stays "unknown" rather than being guessed at from
    // this machine's config.
    if (backend === "ssh") {
      const key = sshKeyOf(server);
      if (!server || !key) return UNKNOWN;
      return await invoke<JiraMcpStatus>("jira_mcp_status_ssh", {
        host: server.host,
        username: server.username,
        identityFile: key,
        projectPath: projectPath ?? null,
        cli,
      });
    }
    return await invoke<JiraMcpStatus>("jira_mcp_status", {
      projectPath: projectPath ?? null,
      distro: getCachedDistro() || null,
      cli,
    });
  } catch {
    return UNKNOWN;
  }
}

/**
 * Register the server globally, so it applies to every repo. Resolves with the
 * CLI's own output, rejects with its error text — which the caller must SHOW,
 * because this is the only signal that a set-up attempt failed.
 */
export function installJiraMcp(
  cli: JiraCli,
  backend: TerminalBackend,
  server?: JiraMcpServer | null,
): Promise<string> {
  return withTimeout(
    runInstall(cli, backend, server),
    INSTALL_TIMEOUT_MS,
    `${cli} mcp add never answered — try again, or run it in a pane to see why.`,
  );
}

async function runInstall(
  cli: JiraCli,
  backend: TerminalBackend,
  server?: JiraMcpServer | null,
): Promise<string> {
  if (backend === "native") {
    return invoke<string>("jira_mcp_install_direct", {
      cliPath: getCachedNativeCliPath(cli) ?? null,
      cli,
    });
  }
  if (backend === "windows") {
    return invoke<string>("jira_mcp_install_direct", {
      cliPath: getCachedWindowsCliPath(cli) ?? null,
      cli,
    });
  }
  if (backend === "ssh") {
    const key = sshKeyOf(server);
    if (!server) throw new Error("No server for this project.");
    if (!key) {
      throw new Error(
        `${server.host} uses password auth — run "${cli} mcp add" there yourself, or add an SSH key.`,
      );
    }
    return invoke<string>("jira_mcp_install_ssh", {
      host: server.host,
      username: server.username,
      identityFile: key,
      cli,
      // The shell probed to actually resolve this CLI there; without it a
      // non-interactive login shell often cannot find the bare name.
      shell: server.shellFor?.(cli) ?? null,
    });
  }
  return invoke<string>("jira_mcp_install", { distro: getCachedDistro() || null, cli });
}
