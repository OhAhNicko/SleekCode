import type { StateCreator } from "zustand";
import type { ProjectSession, TerminalType } from "../types";

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

export interface SessionSlice {
  projectSessions: Record<string, ProjectSession[]>;

  registerProjectSession: (projectPath: string, session: ProjectSession) => void;
  renameProjectSession: (projectPath: string, sessionId: string, newName: string) => void;
  removeProjectSession: (projectPath: string, sessionId: string) => void;
  updateProjectSessionAutoName: (projectPath: string, sessionId: string, name: string) => void;
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
        // Upsert: only preserve old name if user explicitly renamed in EzyDev.
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

  getProjectSessionsByType: (projectPath, type) => {
    const key = normalizePath(projectPath);
    const all = get().projectSessions[key] ?? [];
    return all.filter((s) => s.type === type);
  },
});
