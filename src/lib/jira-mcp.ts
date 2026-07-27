/**
 * Atlassian (Jira) MCP server — detection and one-click registration.
 *
 * Without this server configured in Claude Code, a Jira ticket pane spawns
 * perfectly and then reports it cannot reach Jira — which reads as "the feature
 * is broken". So MADE shows the state plainly and offers to set it up.
 *
 * MADE does not authenticate: that handoff is an interactive browser OAuth, so
 * it stays visible to the user as `/mcp` inside a Claude pane.
 */

import { invoke } from "@tauri-apps/api/core";
import type { TerminalBackend } from "../types";
import { getCachedDistro } from "./wsl-cache";
import { getCachedWindowsCliPath } from "./windows-cli-cache";
import { getCachedNativeCliPath } from "./macos-cli-cache";

export interface JiraMcpStatus {
  configured: boolean;
  /** "user" | "local" | "project" — empty when not configured. */
  scope: string;
  name: string;
  /** False when the config could not be read at all. Render "unknown", never
   *  "not set up" — telling someone to install what they already have is worse
   *  than saying nothing. */
  checked: boolean;
}

const UNKNOWN: JiraMcpStatus = { configured: false, scope: "", name: "", checked: false };

/** Run `/mcp` in a Claude pane to finish this — surfaced next to the button. */
export const JIRA_MCP_AUTH_HINT = "Run /mcp in a Claude pane to sign in to Atlassian.";

export async function readJiraMcpStatus(
  backend: TerminalBackend,
  projectPath?: string,
): Promise<JiraMcpStatus> {
  try {
    if (backend === "native") {
      return await invoke<JiraMcpStatus>("jira_mcp_status_native", {
        projectPath: projectPath ?? null,
      });
    }
    if (backend === "windows") {
      return await invoke<JiraMcpStatus>("jira_mcp_status_windows", {
        projectPath: projectPath ?? null,
      });
    }
    // SSH panes run Claude on the remote host, whose config we cannot read from
    // here. Report unknown rather than guessing from the local machine.
    if (backend === "ssh") return UNKNOWN;
    return await invoke<JiraMcpStatus>("jira_mcp_status", {
      projectPath: projectPath ?? null,
      distro: getCachedDistro() || null,
    });
  } catch {
    return UNKNOWN;
  }
}

/**
 * Register the server (scope `user`, so it applies to every repo). Resolves
 * with the CLI's own output, rejects with its error text.
 */
export async function installJiraMcp(backend: TerminalBackend): Promise<string> {
  if (backend === "native") {
    return invoke<string>("jira_mcp_install_direct", {
      cliPath: getCachedNativeCliPath("claude") ?? null,
    });
  }
  if (backend === "windows") {
    return invoke<string>("jira_mcp_install_direct", {
      cliPath: getCachedWindowsCliPath("claude") ?? null,
    });
  }
  if (backend === "ssh") {
    throw new Error("Set this up on the remote host — MADE configures the local machine only.");
  }
  return invoke<string>("jira_mcp_install", { distro: getCachedDistro() || null });
}
