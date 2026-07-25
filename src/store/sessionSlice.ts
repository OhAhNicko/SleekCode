import type { StateCreator } from "zustand";
import type { ProjectSession, TerminalType } from "../types";

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * One comparable form for a directory that different layers spell differently:
 * panes register under the Windows path (`C:\Users\x\p`), while anything that
 * talks to Claude uses the WSL one (`/mnt/c/Users/x/p`).
 */
function canonicalPath(p: string): string {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const m = s.match(/^\/mnt\/([a-z])\/(.*)$/);
  return m ? `${m[1]}:/${m[2]}` : s;
}

export interface SessionSlice {
  projectSessions: Record<string, ProjectSession[]>;

  registerProjectSession: (projectPath: string, session: ProjectSession) => void;
  renameProjectSession: (projectPath: string, sessionId: string, newName: string) => void;
  removeProjectSession: (projectPath: string, sessionId: string) => void;
  updateProjectSessionAutoName: (projectPath: string, sessionId: string, name: string) => void;
  pruneProjectSessions: (projectPath: string, liveIds: string[], minAgeMs: number) => void;
  getProjectSessionsByType: (projectPath: string, type: TerminalType) => ProjectSession[];
}

export const createSessionSlice: StateCreator<
  SessionSlice,
  [],
  [],
  SessionSlice
> = (set, get) => ({
  projectSessions: {},

  registerProjectSession: (projectPath, session) => {
    const key = normalizePath(projectPath);
    set((state) => {
      const existing = state.projectSessions[key] ?? [];
      const idx = existing.findIndex((s) => s.id === session.id);
      if (idx >= 0) {
        // Upsert: only preserve old name if user explicitly renamed in MADE.
        // Auto-names from old sessions must NOT carry over to new panes.
        const prev = existing[idx];
        if (prev.isRenamed) return state;
        const updated = [...existing];
        updated[idx] = { ...prev, ...session, name: session.name, isRenamed: false };
        return { projectSessions: { ...state.projectSessions, [key]: updated } };
      }
      return { projectSessions: { ...state.projectSessions, [key]: [...existing, session] } };
    });
  },

  renameProjectSession: (projectPath, sessionId, newName) => {
    const key = normalizePath(projectPath);
    set((state) => {
      const existing = state.projectSessions[key];
      if (!existing) return state;
      return {
        projectSessions: {
          ...state.projectSessions,
          [key]: existing.map((s) =>
            s.id === sessionId ? { ...s, name: newName, isRenamed: true } : s
          ),
        },
      };
    });
  },

  removeProjectSession: (projectPath, sessionId) => {
    const key = normalizePath(projectPath);
    set((state) => {
      const existing = state.projectSessions[key];
      if (!existing) return state;
      return {
        projectSessions: {
          ...state.projectSessions,
          [key]: existing.filter((s) => s.id !== sessionId),
        },
      };
    });
  },

  updateProjectSessionAutoName: (projectPath, sessionId, name) => {
    const key = normalizePath(projectPath);
    set((state) => {
      const existing = state.projectSessions[key];
      if (!existing) return state;
      return {
        projectSessions: {
          ...state.projectSessions,
          [key]: existing.map((s) =>
            s.id === sessionId && !s.isRenamed ? { ...s, name } : s
          ),
        },
      };
    });
  },

  /**
   * Drop Claude sessions this project no longer has a transcript for.
   *
   * For months MADE registered a session id that Claude never used (the pooled
   * spawn dropped `--session-id`), so this registry filled up with ids that
   * name nothing — 70% of stored rows on this machine when the bug was found.
   * They render at the TOP of the session picker and do nothing when clicked,
   * so they have to go, not just stop being created.
   *
   * Deliberately conservative:
   *  - only `type === "claude"` — `liveIds` comes from Claude's transcript dir,
   *    so codex/gemini rows are not evidence-of-absence, they are out of scope;
   *  - only entries older than `minAgeMs`, because a session that was just
   *    created has no transcript yet and is not dead, merely young;
   *  - callers must pass a POSITIVE read (a non-empty `liveIds`). An empty list
   *    means "could not look", and pruning on that would wipe the registry.
   */
  pruneProjectSessions: (projectPath, liveIds, minAgeMs) => {
    if (!liveIds.length) return;
    set((state) => {
      const target = canonicalPath(projectPath);
      const key = Object.keys(state.projectSessions).find((k) => canonicalPath(k) === target);
      if (!key) return state;
      const existing = state.projectSessions[key];
      if (!existing?.length) return state;
      const live = new Set(liveIds);
      const cutoff = Date.now() - minAgeMs;
      const kept = existing.filter(
        (s) => s.type !== "claude" || live.has(s.id) || s.createdAt > cutoff
      );
      if (kept.length === existing.length) return state;
      return { projectSessions: { ...state.projectSessions, [key]: kept } };
    });
  },

  getProjectSessionsByType: (projectPath, type) => {
    const key = normalizePath(projectPath);
    const all = get().projectSessions[key] ?? [];
    return all.filter((s) => s.type === type);
  },
});
