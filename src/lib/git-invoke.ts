import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import type {
  GitAheadBehind,
  GitBranchInfo,
  GitDiffStats,
  GitFileStatus,
} from "../types";

/**
 * Read-only git that works for LOCAL and REMOTE (SSH) projects alike.
 *
 * Every git command in lib.rs runs as a local process — `run_git` has a WSL
 * branch for `\\wsl.localhost\…` paths and a plain local spawn otherwise, and
 * neither reaches another machine. A remote project's `workingDir` is a path on
 * the SSH host, so the local commands executed against a directory that does
 * not exist here: the status bar silently rendered nothing and the review pane
 * came up empty.
 *
 * Callers pass `(workingDir, serverId)` and get the right backend. `serverId`
 * is `undefined` for local projects, which is exactly what every tab, terminal
 * and dev server already carries — no new state.
 *
 * WHY ONLY READS. Mutating git over SSH would run on the remote box under the
 * REMOTE machine's git identity and credentials, so commits would carry the
 * wrong author and pushes the wrong keys. That is a silent correctness problem,
 * not a missing feature, so `commit`/`push`/`pull`/`discard`/`revert-hunk` stay
 * local-only and their UI is hidden for remote projects. The user has a
 * terminal on that host.
 *
 * COST. There is no SSH connection multiplexing anywhere in MADE, so each call
 * is a fresh `ssh` process and handshake. Safe here because GitStatusBar polls
 * sequentially (it waits for a cycle to finish before scheduling the next), so
 * a slow link degrades into a slower refresh rather than a pile-up of
 * processes. If it ever feels sluggish, `ControlMaster`/`ControlPersist` in
 * `run_ssh_remote` would fix it for the file browser and grep at the same time.
 */

/** Connection fields the `*_ssh` commands expect, or null if the server is gone. */
function sshTarget(
  serverId: string,
): { host: string; username: string; identityFile: string | null } | null {
  const server = useAppStore.getState().servers.find((s) => s.id === serverId);
  if (!server) return null;
  return {
    host: server.host,
    username: server.username,
    // Same rule as the SSH tunnel and file browser: only send a key when the
    // server is actually configured for key auth.
    identityFile:
      server.authMethod === "ssh-key" && server.sshKeyPath ? server.sshKeyPath : null,
  };
}

/**
 * Reject rather than fall through to the local command when a serverId names a
 * server that no longer exists. Falling through would run git against the
 * remote path ON THIS MACHINE — which normally just fails, but on a host where
 * that path happens to exist would report a completely unrelated repository's
 * branch and status as if it were the remote's.
 */
function missingServer(serverId: string): Promise<never> {
  return Promise.reject(new Error(`No such server: ${serverId}`));
}

export function gitIsRepo(directory: string, serverId?: string): Promise<boolean> {
  if (!serverId) return invoke<boolean>("git_is_repo", { directory });
  const t = sshTarget(serverId);
  return t
    ? invoke<boolean>("git_is_repo_ssh", { ...t, directory })
    : missingServer(serverId);
}

export function gitStatus(directory: string, serverId?: string): Promise<GitFileStatus[]> {
  if (!serverId) return invoke<GitFileStatus[]>("git_status", { directory });
  const t = sshTarget(serverId);
  return t
    ? invoke<GitFileStatus[]>("git_status_ssh", { ...t, directory })
    : missingServer(serverId);
}

export function gitBranches(directory: string, serverId?: string): Promise<GitBranchInfo> {
  if (!serverId) return invoke<GitBranchInfo>("git_branches", { directory });
  const t = sshTarget(serverId);
  return t
    ? invoke<GitBranchInfo>("git_branches_ssh", { ...t, directory })
    : missingServer(serverId);
}

export function gitDiffStats(directory: string, serverId?: string): Promise<GitDiffStats> {
  if (!serverId) return invoke<GitDiffStats>("git_diff_stats", { directory });
  const t = sshTarget(serverId);
  return t
    ? invoke<GitDiffStats>("git_diff_stats_ssh", { ...t, directory })
    : missingServer(serverId);
}

export function gitAheadBehind(directory: string, serverId?: string): Promise<GitAheadBehind> {
  if (!serverId) return invoke<GitAheadBehind>("git_ahead_behind", { directory });
  const t = sshTarget(serverId);
  return t
    ? invoke<GitAheadBehind>("git_ahead_behind_ssh", { ...t, directory })
    : missingServer(serverId);
}

export function gitDiff(
  directory: string,
  filePath: string | null,
  compareTo: string | null,
  serverId?: string,
): Promise<string> {
  if (!serverId) return invoke<string>("git_diff", { directory, filePath, compareTo });
  const t = sshTarget(serverId);
  return t
    ? invoke<string>("git_diff_ssh", { ...t, directory, filePath, compareTo })
    : missingServer(serverId);
}
