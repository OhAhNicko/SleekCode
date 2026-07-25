import { invoke } from "@tauri-apps/api/core";
import { getCachedDistro } from "./wsl-cache";
import { useAppStore } from "../store";
import type { TerminalBackend, SessionIndexEntry } from "../types";

/**
 * List a project's Claude sessions, newest first, capped at 30.
 *
 * Named for `sessions-index.json`, but local backends no longer depend on it:
 * Claude stopped writing that file in early 2026, so the backend enumerates the
 * `<project>/*.jsonl` transcripts and uses a surviving index only to enrich a
 * row. SSH is the exception — it still needs the remote index.
 *
 * Returns [] if the project has no session directory, or on any error.
 *
 * For SSH projects, pass `backend = "ssh"` and the linked `serverId`. The
 * `projectPath` should be the REMOTE Unix path (the same cwd Claude sees on
 * the remote host), since the project-key encoding happens server-side.
 */
export async function readSessionsIndex(
  projectPath: string,
  backend: TerminalBackend,
  serverId?: string,
): Promise<SessionIndexEntry[]> {
  try {
    let raw: string;
    if (backend === "ssh") {
      const server = serverId
        ? useAppStore.getState().servers.find((s) => s.id === serverId)
        : undefined;
      if (!server || server.authMethod !== "ssh-key" || !server.sshKeyPath) return [];
      raw = await invoke<string>("read_sessions_index_ssh", {
        host: server.host,
        username: server.username,
        identityFile: server.sshKeyPath,
        remoteProjectPath: projectPath,
      });
    } else if (backend === "native") {
      raw = await invoke<string>("read_sessions_index_native", { projectPath });
    } else if (backend === "windows") {
      raw = await invoke<string>("read_sessions_index_windows", { projectPath });
    } else {
      const distro = getCachedDistro();
      raw = await invoke<string>("read_sessions_index", { projectPath, distro: distro || null });
    }
    if (!raw || raw === "[]") return [];
    const entries = JSON.parse(raw) as SessionIndexEntry[];
    // Self-heal the registry now that the picker is looking at this project.
    // Panes used to register ids Claude never used, and those rows sort ABOVE
    // the real ones in the picker — see pruneProjectSessions. Fire-and-forget:
    // the list is what the picker is here for, the prune is a side-benefit.
    if (backend !== "ssh") void pruneDeadSessions(projectPath, backend);
    return entries;
  } catch {
    return [];
  }
}

/**
 * Grace period before a registered session with no transcript is treated as
 * dead. Claude writes the transcript once the conversation has content, so a
 * pane opened moments ago is legitimately absent from disk.
 */
const PRUNE_MIN_AGE_MS = 10 * 60_000;

/**
 * Drop registry rows whose transcript is gone.
 *
 * Deliberately asks for the COMPLETE id list rather than reusing the entries
 * above: those are capped at the 30 most recent for display, and treating a
 * truncated list as "everything that exists" would delete real sessions from
 * projects with more than 30 of them.
 */
async function pruneDeadSessions(projectPath: string, backend: TerminalBackend): Promise<void> {
  try {
    let ids: string[];
    if (backend === "native") {
      ids = await invoke<string[]>("claude_session_ids_native", { projectPath });
    } else if (backend === "windows") {
      ids = await invoke<string[]>("claude_session_ids_windows", { projectPath });
    } else {
      const distro = getCachedDistro();
      ids = await invoke<string[]>("claude_session_ids", { projectPath, distro: distro || null });
    }
    // An empty list means "could not look" as often as "nothing there", so the
    // store action treats it as a no-op rather than a licence to wipe.
    useAppStore.getState().pruneProjectSessions(projectPath, ids, PRUNE_MIN_AGE_MS);
  } catch {
    // Never let registry hygiene break the session list.
  }
}

/**
 * Read the first user prompt from a session's JSONL file.
 * Used as a fallback when sessions-index.json is missing.
 * Returns empty string if the file doesn't exist or on any error.
 */
export async function readSessionFirstPrompt(
  projectPath: string,
  backend: TerminalBackend,
  sessionId: string,
  serverId?: string,
): Promise<string> {
  try {
    if (backend === "ssh") {
      const server = serverId
        ? useAppStore.getState().servers.find((s) => s.id === serverId)
        : undefined;
      if (!server || server.authMethod !== "ssh-key" || !server.sshKeyPath) return "";
      return await invoke<string>("read_session_first_prompt_ssh", {
        host: server.host,
        username: server.username,
        identityFile: server.sshKeyPath,
        remoteProjectPath: projectPath,
        sessionId,
      });
    }
    if (backend === "native") {
      return await invoke<string>("read_session_first_prompt_native", { projectPath, sessionId });
    } else if (backend === "windows") {
      return await invoke<string>("read_session_first_prompt_windows", { projectPath, sessionId });
    } else {
      const distro = getCachedDistro();
      return await invoke<string>("read_session_first_prompt", { projectPath, sessionId, distro: distro || null });
    }
  } catch {
    return "";
  }
}

/**
 * Claude's notification channel — which escape sequence it emits when it wants
 * attention. Written into the user's `~/.claude/settings.json`.
 *
 * MADE parses OSC 9 / 99 / 777, so any of iterm2 / kitty / ghostty produce a
 * toast; `ghostty` is the richest, being the only one that carries a title as
 * well as a body. `bell` is intentionally NOT useful here — a BEL has no
 * message to show.
 */
export type ClaudeNotifChannel =
  | "auto"
  | "iterm2"
  | "bell"
  | "kitty"
  | "ghostty"
  | "iterm2+bell"
  | "none";

/** Writes `notifChannel` into Claude's settings.json, preserving everything
 * else. Resolves to the path written. Throws with a readable message when the
 * file exists but is not parseable — in that case nothing is modified. */
export async function setClaudeNotifChannel(
  channel: ClaudeNotifChannel,
  backend: TerminalBackend,
): Promise<string> {
  if (backend === "native") {
    return await invoke<string>("set_claude_notif_channel_native", { channel });
  } else if (backend === "windows") {
    return await invoke<string>("set_claude_notif_channel_windows", { channel });
  }
  const distro = getCachedDistro();
  return await invoke<string>("set_claude_notif_channel", { channel, distro: distro || null });
}

/**
 * Every user prompt in a session, oldest first (truncated to 200 chars each).
 *
 * Used to give the fullscreen-TUI scrollbar an EXACT position: Claude renders
 * a "sticky prompt" at the top of the screen naming the message you are inside,
 * so matching it against this list yields "message 7 of 20". That is immune to
 * Claude's wheel acceleration, which makes notch-counting inherently
 * approximate.
 *
 * SSH is intentionally unsupported — the scrollbar falls back to dead
 * reckoning there rather than paying a round-trip per sample.
 */
export async function readSessionPrompts(
  projectPath: string,
  sessionId: string,
  backend: TerminalBackend,
): Promise<string[]> {
  try {
    if (backend === "ssh") return [];
    if (backend === "native") {
      return await invoke<string[]>("read_session_prompts_native", { projectPath, sessionId });
    } else if (backend === "windows") {
      return await invoke<string[]>("read_session_prompts_windows", { projectPath, sessionId });
    } else {
      const distro = getCachedDistro();
      return await invoke<string[]>("read_session_prompts", { projectPath, sessionId, distro: distro || null });
    }
  } catch {
    return [];
  }
}

/**
 * Turn a prompt string into a short kebab-case slug, e.g. "color-change-feed-page".
 * Keeps at most 4 words, lowercased, stripped of non-alphanumeric chars.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join("-");
}

/**
 * Resolve display name from a sessions-index entry.
 * Priority: customTitle → summary → firstPrompt (as kebab slug) → UUID slice.
 */
export function resolveSessionName(entry: SessionIndexEntry): string {
  if (entry.customTitle) return entry.customTitle;
  if (entry.summary) return entry.summary;
  if (entry.firstPrompt) {
    const slug = slugify(entry.firstPrompt);
    return slug || entry.sessionId.slice(0, 8);
  }
  return entry.sessionId.slice(0, 8);
}
