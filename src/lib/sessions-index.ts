import { invoke } from "@tauri-apps/api/core";
import { getCachedDistro } from "./wsl-cache";
import type { TerminalBackend, SessionIndexEntry } from "../types";

/**
 * Read sessions-index.json for a project path.
 * Returns session entries sorted by modified desc, capped at 30.
 * Returns [] if the file doesn't exist or on any error.
 */
export async function readSessionsIndex(
  projectPath: string,
  backend: TerminalBackend,
): Promise<SessionIndexEntry[]> {
  try {
    let raw: string;
    if (backend === "native") {
      raw = await invoke<string>("read_sessions_index_native", { projectPath });
    } else if (backend === "windows") {
      raw = await invoke<string>("read_sessions_index_windows", { projectPath });
    } else {
      const distro = getCachedDistro();
      raw = await invoke<string>("read_sessions_index", { projectPath, distro: distro || null });
    }
    if (!raw || raw === "[]") return [];
    return JSON.parse(raw) as SessionIndexEntry[];
  } catch {
    return [];
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
): Promise<string> {
  try {
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
