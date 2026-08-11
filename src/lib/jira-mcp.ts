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
 * Registration is only half the setup: the server still needs a browser OAuth,
 * and MADE cannot mint that link itself (PKCE + a localhost callback owned by
 * the CLI process). So on local backends the CLI is told to run its own flow —
 * `claude|codex mcp login atlassian` opens the system browser and blocks until
 * the callback (`loginJiraMcp`), and `probeJiraMcpAuth` asks the CLI afterwards
 * whether it worked. Gemini's auth is TUI-only, so it gets a spawned pane
 * instead; on SSH the callback would bind the REMOTE host's localhost, so
 * remote projects keep the visible-hint handoff.
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
/** Must exceed the backend's 300s login deadline, so its message wins. */
const LOGIN_TIMEOUT_MS = 330_000;
/** Must exceed the backend's 20s probe deadline. */
const AUTH_PROBE_TIMEOUT_MS = 30_000;

/**
 * How to finish the OAuth handoff where MADE cannot run it for you (SSH, or a
 * probe that could not tell). Claude and Codex also have these as headless
 * subcommands — `loginJiraMcp` runs exactly them on local backends.
 */
export const JIRA_MCP_AUTH_HINT: Record<JiraCli, string> = {
  claude: "Run claude mcp login atlassian to sign in.",
  codex: "Run codex mcp login atlassian to sign in.",
  gemini: "Run /mcp auth atlassian in a Gemini pane.",
};

/**
 * Codex's sign-in cannot be completed on a remote host from here, and saying so
 * is the whole point: its OAuth callback binds `127.0.0.1:<random>` ON THAT
 * HOST, which your browser cannot reach. Claude and Gemini both authenticate
 * from inside the running pane, so SSH costs them nothing.
 */
export const CODEX_MCP_SSH_AUTH = "codex mcp login can't finish over SSH.";

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
  // Whatever the outcome, the auth answer for this CLI is stale now.
  invalidateJiraMcpAuth(cli);
  return withTimeout(
    runInstall(cli, backend, server),
    INSTALL_TIMEOUT_MS,
    `${cli} mcp add never answered — try again, or run it in a pane to see why.`,
  );
}

/** Signed in / needs sign-in / could not tell. */
export type JiraMcpAuth = boolean | null;

/**
 * Auth answers, keyed `${backend}:${cli}`. A probe spawns the CLI and
 * health-checks Atlassian over the network — far too heavy to repeat on every
 * settings render — so definitive answers stick until an install/login
 * invalidates them, and "could not tell" retries after a short TTL so one
 * transient failure doesn't pin the degraded state.
 *
 * Accepted staleness: a token that EXPIRES while a `true` is cached keeps its
 * row green until the next install/login or app restart. The ticket pane
 * itself is the real failure signal for that case.
 */
const authCache = new Map<string, { value: JiraMcpAuth; at: number }>();
const AUTH_NULL_TTL_MS = 60_000;

export function invalidateJiraMcpAuth(cli?: JiraCli): void {
  if (!cli) {
    authCache.clear();
    return;
  }
  for (const key of authCache.keys()) {
    if (key.endsWith(`:${cli}`)) authCache.delete(key);
  }
}

/**
 * Run the CLI's own browser OAuth for the registered Atlassian server. The
 * system browser opens (the CLI launches it — no in-app webview: SSO providers
 * block embedded browsers, and the user's sessions live in their real one) and
 * the call stays pending until the user finishes or the backend's 5-minute
 * deadline kills the child.
 *
 * Local backends only: on SSH the OAuth callback would bind the REMOTE host's
 * localhost. Gemini has no headless login at all — its pane flow lives in the
 * settings row.
 */
export function loginJiraMcp(
  cli: JiraCli,
  backend: TerminalBackend,
  name?: string,
): Promise<string> {
  if (cli === "gemini") {
    return Promise.reject(new Error("gemini has no headless MCP login"));
  }
  if (backend === "ssh") {
    return Promise.reject(new Error("sign-in must run on the remote host"));
  }
  const work =
    backend === "windows" || backend === "native"
      ? invoke<string>("jira_mcp_login_direct", {
          cliPath:
            (backend === "windows"
              ? getCachedWindowsCliPath(cli)
              : getCachedNativeCliPath(cli)) ?? null,
          cli,
          name: name ?? null,
        })
      : invoke<string>("jira_mcp_login", {
          distro: getCachedDistro() || null,
          cli,
          name: name ?? null,
        });
  return withTimeout(
    work,
    LOGIN_TIMEOUT_MS,
    `${cli} mcp login never answered — try Sign in again.`,
  ).finally(() => invalidateJiraMcpAuth(cli));
}

/**
 * Is the registered server signed in? Advisory tri-state: `null` ("could not
 * tell") is a first-class answer that the row must render as the old
 * green-plus-hint — never as "Sign in required". Gemini and SSH answer `null`
 * without asking (no probe exists / wrong machine to ask).
 */
export async function probeJiraMcpAuth(
  cli: JiraCli,
  backend: TerminalBackend,
  name?: string,
): Promise<JiraMcpAuth> {
  if (cli === "gemini" || backend === "ssh") return null;
  const key = `${backend}:${cli}`;
  const cached = authCache.get(key);
  if (cached && (cached.value !== null || Date.now() - cached.at < AUTH_NULL_TTL_MS)) {
    return cached.value;
  }
  const work =
    backend === "windows" || backend === "native"
      ? invoke<JiraMcpAuth>("jira_mcp_auth_probe_direct", {
          cliPath:
            (backend === "windows"
              ? getCachedWindowsCliPath(cli)
              : getCachedNativeCliPath(cli)) ?? null,
          cli,
          name: name ?? null,
        })
      : invoke<JiraMcpAuth>("jira_mcp_auth_probe", {
          distro: getCachedDistro() || null,
          cli,
          name: name ?? null,
        });
  const value = await withTimeout(work, AUTH_PROBE_TIMEOUT_MS, "timed out").catch(
    () => null,
  );
  authCache.set(key, { value: value ?? null, at: Date.now() });
  return value ?? null;
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
