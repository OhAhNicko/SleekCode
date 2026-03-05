import type { StateCreator } from "zustand";
import type { TerminalType } from "../types";

export interface RecentProjectTemplate {
  templateId: string;
  cols: number;
  rows: number;
  slotTypes: TerminalType[];
}

export interface RecentProject {
  id: string;
  path: string;
  name: string;
  lastOpenedAt: number;
  openCount: number;
  lastTemplate?: RecentProjectTemplate;
}

const MAX_RECENT_PROJECTS = 15;

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

export interface RecentProjectsSlice {
  recentProjects: RecentProject[];
  alwaysShowTemplatePicker: boolean;
  addRecentProject: (entry: { path: string; name: string; template?: RecentProjectTemplate }) => void;
  removeRecentProject: (path: string) => void;
  clearRecentProjects: () => void;
  setAlwaysShowTemplatePicker: (value: boolean) => void;
}

export const createRecentProjectsSlice: StateCreator<
  RecentProjectsSlice,
  [],
  [],
  RecentProjectsSlice
> = (set) => ({
  recentProjects: [],
  alwaysShowTemplatePicker: false,

  addRecentProject: ({ path, name, template }) => {
    const normalized = normalizePath(path);
    set((state) => {
      const existing = state.recentProjects.find(
        (p) => normalizePath(p.path) === normalized
      );
      const now = Date.now();
      let updated: RecentProject[];
      if (existing) {
        // Update existing: bump timestamp, count, template
        updated = state.recentProjects.map((p) =>
          normalizePath(p.path) === normalized
            ? { ...p, lastOpenedAt: now, openCount: p.openCount + 1, lastTemplate: template ?? p.lastTemplate, name }
            : p
        );
      } else {
        // Add new
        const newEntry: RecentProject = {
          id: `rp-${now}-${Math.random().toString(36).slice(2, 6)}`,
          path,
          name,
          lastOpenedAt: now,
          openCount: 1,
          lastTemplate: template,
        };
        updated = [newEntry, ...state.recentProjects];
      }
      // Sort by lastOpenedAt desc, cap at max
      updated.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
      if (updated.length > MAX_RECENT_PROJECTS) {
        updated = updated.slice(0, MAX_RECENT_PROJECTS);
      }
      return { recentProjects: updated };
    });
  },

  removeRecentProject: (path) => {
    const normalized = normalizePath(path);
    set((state) => ({
      recentProjects: state.recentProjects.filter(
        (p) => normalizePath(p.path) !== normalized
      ),
    }));
  },

  clearRecentProjects: () => {
    set({ recentProjects: [] });
  },

  setAlwaysShowTemplatePicker: (value) => {
    set({ alwaysShowTemplatePicker: value });
  },
});
