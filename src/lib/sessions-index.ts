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
 * Resolve display name from a sessions-index entry.
 * Priority: customTitle → summary → firstPrompt (truncated) → UUID slice.
 */
export function resolveSessionName(entry: SessionIndexEntry): string {
  if (entry.customTitle) return entry.customTitle;
  if (entry.summary) return entry.summary;
  if (entry.firstPrompt) {
    const truncated = entry.firstPrompt.slice(0, 60);
    return truncated.length < entry.firstPrompt.length ? truncated + "..." : truncated;
  }
  return entry.sessionId.slice(0, 8);
}
