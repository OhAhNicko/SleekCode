import type { StateCreator } from "zustand";
import type { TerminalType } from "../types";

export interface RecentProjectTemplate {
  templateId: string;
  cols: number;
  rows: number;
  paneCount?: number;
  slotTypes: TerminalType[];
}

export interface RecentProject {
  id: string;
  path: string;
  name: string;
  lastOpenedAt: number;
  openCount: number;
  lastTemplate?: RecentProjectTemplate;
  serverCommand?: string;
}

const MAX_RECENT_PROJECTS = 15;

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

export type CliFontSizes = Partial<Record<TerminalType, number>>;

export const DEFAULT_CLI_FONT_SIZE = 15;

export interface RecentProjectsSlice {
  recentProjects: RecentProject[];
  alwaysShowTemplatePicker: boolean;
  restoreLastSession: boolean;
  autoInsertClipboardImage: boolean;
  cliFontSizes: CliFontSizes;
  claudeYolo: boolean;
  promptComposerEnabled: boolean;
  promptComposerAlwaysVisible: boolean;
  promptHistory: string[];
  autoStartServerCommand: boolean;
  previewInProjectTab: boolean;
  customServerCommands: string[];
  addRecentProject: (entry: { path: string; name: string; template?: RecentProjectTemplate; serverCommand?: string }) => void;
  removeRecentProject: (path: string) => void;
  clearRecentProjects: () => void;
  setAlwaysShowTemplatePicker: (value: boolean) => void;
  setRestoreLastSession: (value: boolean) => void;
  setAutoInsertClipboardImage: (value: boolean) => void;
  setCliFontSize: (type: TerminalType, size: number) => void;
  setClaudeYolo: (value: boolean) => void;
  setPromptComposerEnabled: (value: boolean) => void;
  setPromptComposerAlwaysVisible: (value: boolean) => void;
  addPromptHistory: (text: string) => void;
  setAutoStartServerCommand: (value: boolean) => void;
  setPreviewInProjectTab: (value: boolean) => void;
  addCustomServerCommand: (command: string) => void;
  removeCustomServerCommand: (command: string) => void;
  updateProjectServerCommand: (path: string, command: string) => void;
}

export const createRecentProjectsSlice: StateCreator<
  RecentProjectsSlice,
  [],
  [],
  RecentProjectsSlice
> = (set) => ({
  recentProjects: [],
  alwaysShowTemplatePicker: false,
  restoreLastSession: false,
  autoInsertClipboardImage: false,
  cliFontSizes: {},
  claudeYolo: false,
  promptComposerEnabled: false,
  promptComposerAlwaysVisible: false,
  promptHistory: [],
  autoStartServerCommand: true,
  previewInProjectTab: true,
  customServerCommands: [],

  addRecentProject: ({ path, name, template, serverCommand }) => {
    const normalized = normalizePath(path);
    set((state) => {
      const existing = state.recentProjects.find(
        (p) => normalizePath(p.path) === normalized
      );
      const now = Date.now();
      let updated: RecentProject[];
      if (existing) {
        // Update existing: bump timestamp, count, template, serverCommand
        updated = state.recentProjects.map((p) =>
          normalizePath(p.path) === normalized
            ? { ...p, lastOpenedAt: now, openCount: p.openCount + 1, lastTemplate: template ?? p.lastTemplate, name, serverCommand: serverCommand ?? p.serverCommand }
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
          serverCommand,
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

  setRestoreLastSession: (value) => {
    set({ restoreLastSession: value });
  },

  setAutoInsertClipboardImage: (value) => {
    set({ autoInsertClipboardImage: value });
  },

  setCliFontSize: (type, size) => {
    set((state) => ({
      cliFontSizes: { ...state.cliFontSizes, [type]: size },
    }));
  },

  setClaudeYolo: (value) => {
    set({ claudeYolo: value });
  },

  setPromptComposerEnabled: (value) => {
    set({ promptComposerEnabled: value });
  },

  setPromptComposerAlwaysVisible: (value) => {
    set({ promptComposerAlwaysVisible: value });
  },

  addPromptHistory: (text) => {
    set((state) => {
      // Avoid consecutive duplicates
      if (state.promptHistory[0] === text) return state;
      const updated = [text, ...state.promptHistory];
      if (updated.length > 50) updated.length = 50;
      return { promptHistory: updated };
    });
  },

  setAutoStartServerCommand: (value) => {
    set({ autoStartServerCommand: value });
  },

  setPreviewInProjectTab: (value) => {
    set({ previewInProjectTab: value });
  },

  addCustomServerCommand: (command) => {
    set((state) => {
      const trimmed = command.trim();
      if (!trimmed || state.customServerCommands.includes(trimmed)) return state;
      return { customServerCommands: [...state.customServerCommands, trimmed] };
    });
  },

  removeCustomServerCommand: (command) => {
    set((state) => ({
      customServerCommands: state.customServerCommands.filter((c) => c !== command),
    }));
  },

  updateProjectServerCommand: (path, command) => {
    const normalized = normalizePath(path);
    set((state) => ({
      recentProjects: state.recentProjects.map((p) =>
        normalizePath(p.path) === normalized
          ? { ...p, serverCommand: command }
          : p
      ),
    }));
  },
});
