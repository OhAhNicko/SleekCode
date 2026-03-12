import type { StateCreator } from "zustand";
import type { TerminalType, TerminalBackend, CommitMsgMode, ShadowAiCli, PaneLayout } from "../types";

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
  quickOpen?: boolean;
  lastLayout?: PaneLayout;
}

const MAX_RECENT_PROJECTS = 15;

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

export type CliFontSizes = Partial<Record<TerminalType, number>>;

/** Color presets for project tab underlines */
export const PROJECT_COLOR_PRESETS = [
  { id: "red", label: "Red", color: "#e55" },
  { id: "orange", label: "Orange", color: "#D97757" },
  { id: "green", label: "Green", color: "#10a37f" },
  { id: "cyan", label: "Cyan", color: "#22d3ee" },
  { id: "purple", label: "Purple", color: "#8E75B2" },
  { id: "pink", label: "Pink", color: "#ec4899" },
  { id: "white", label: "White", color: "#d4d4d4" },
  { id: "emerald", label: "Emerald", color: "#34d399" },
  { id: "coral", label: "Coral", color: "#f97066" },
  { id: "sky", label: "Sky", color: "#38bdf8" },
  { id: "lime", label: "Lime", color: "#a3e635" },
] as const;

export type ProjectColorId = (typeof PROJECT_COLOR_PRESETS)[number]["id"] | null;

/** Get the hex color for a project color ID */
export function getProjectColor(id: ProjectColorId): string | null {
  if (!id) return null;
  return PROJECT_COLOR_PRESETS.find((p) => p.id === id)?.color ?? null;
}

/** Auto-assign: pick a color not currently used by any project. If all are taken, pick the least-used. */
export function autoAssignColor(existing: Record<string, ProjectColorId>): ProjectColorId {
  const usedIds = Object.values(existing).filter(Boolean) as string[];
  const usedSet = new Set(usedIds);

  // First: pick from colors not used at all
  const unused = PROJECT_COLOR_PRESETS.filter((p) => !usedSet.has(p.id));
  if (unused.length > 0) {
    return unused[Math.floor(Math.random() * unused.length)].id;
  }

  // All colors used — pick the least-used one
  const counts = new Map<string, number>();
  for (const id of usedIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  let minCount = Infinity;
  for (const c of counts.values()) if (c < minCount) minCount = c;
  const leastUsed = PROJECT_COLOR_PRESETS.filter((p) => (counts.get(p.id) ?? 0) === minCount);
  return leastUsed[Math.floor(Math.random() * leastUsed.length)].id;
}

export const DEFAULT_CLI_FONT_SIZE = 15;

export interface RecentProjectsSlice {
  recentProjects: RecentProject[];
  alwaysShowTemplatePicker: boolean;
  restoreLastSession: boolean;
  autoInsertClipboardImage: boolean;
  cliFontSizes: CliFontSizes;
  cliYolo: Partial<Record<TerminalType, boolean>>;
  promptComposerEnabled: boolean;
  promptComposerAlwaysVisible: boolean;
  promptHistory: string[];
  autoStartServerCommand: boolean;
  previewInProjectTab: boolean;
  customServerCommands: string[];
  browserFullColumn: boolean;
  browserSpawnLeft: boolean;
  copyOnSelect: boolean;
  confirmQuit: boolean;
  slashCommandGhostText: boolean;
  codeReviewCollapseAll: boolean;
  openPanesInBackground: boolean;
  terminalBackend: TerminalBackend;
  commitMsgMode: CommitMsgMode;
  shadowAiCli: ShadowAiCli;
  projectColors: Record<string, ProjectColorId>;
  setProjectColor: (workingDir: string, colorId: ProjectColorId) => void;
  addRecentProject: (entry: { path: string; name: string; template?: RecentProjectTemplate; serverCommand?: string }) => void;
  removeRecentProject: (path: string) => void;
  clearRecentProjects: () => void;
  setAlwaysShowTemplatePicker: (value: boolean) => void;
  setRestoreLastSession: (value: boolean) => void;
  setAutoInsertClipboardImage: (value: boolean) => void;
  setCliFontSize: (type: TerminalType, size: number) => void;
  setCliYolo: (type: TerminalType, value: boolean) => void;
  setPromptComposerEnabled: (value: boolean) => void;
  setPromptComposerAlwaysVisible: (value: boolean) => void;
  addPromptHistory: (text: string) => void;
  setAutoStartServerCommand: (value: boolean) => void;
  setPreviewInProjectTab: (value: boolean) => void;
  addCustomServerCommand: (command: string) => void;
  removeCustomServerCommand: (command: string) => void;
  updateProjectServerCommand: (path: string, command: string) => void;
  setBrowserFullColumn: (value: boolean) => void;
  setBrowserSpawnLeft: (value: boolean) => void;
  setCopyOnSelect: (value: boolean) => void;
  setConfirmQuit: (value: boolean) => void;
  setSlashCommandGhostText: (value: boolean) => void;
  setCodeReviewCollapseAll: (value: boolean) => void;
  setOpenPanesInBackground: (value: boolean) => void;
  setTerminalBackend: (value: TerminalBackend) => void;
  setCommitMsgMode: (value: CommitMsgMode) => void;
  setShadowAiCli: (value: ShadowAiCli) => void;
  updateProjectTemplate: (path: string, template: RecentProjectTemplate) => void;
  updateProjectLayout: (path: string, layout: PaneLayout) => void;
  toggleProjectQuickOpen: (path: string) => void;
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
  cliYolo: {},
  promptComposerEnabled: false,
  promptComposerAlwaysVisible: false,
  promptHistory: [],
  autoStartServerCommand: true,
  previewInProjectTab: true,
  customServerCommands: [],
  browserFullColumn: true,
  browserSpawnLeft: false,
  copyOnSelect: false,
  confirmQuit: true,
  slashCommandGhostText: false,
  codeReviewCollapseAll: false,
  openPanesInBackground: false,
  terminalBackend: "wsl",
  commitMsgMode: "simple",
  shadowAiCli: "claude",
  projectColors: {},

  setProjectColor: (workingDir, colorId) => {
    const key = normalizePath(workingDir);
    set((state) => ({
      projectColors: { ...state.projectColors, [key]: colorId },
    }));
  },

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

  setCliYolo: (type, value) => {
    set((s) => ({ cliYolo: { ...s.cliYolo, [type]: value } }));
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

  setBrowserFullColumn: (value) => {
    set({ browserFullColumn: value });
  },

  setBrowserSpawnLeft: (value) => {
    set({ browserSpawnLeft: value });
  },

  setCopyOnSelect: (value) => {
    set({ copyOnSelect: value });
  },

  setConfirmQuit: (value) => {
    set({ confirmQuit: value });
  },

  setSlashCommandGhostText: (value) => {
    set({ slashCommandGhostText: value });
  },

  setCodeReviewCollapseAll: (value) => {
    set({ codeReviewCollapseAll: value });
  },

  setOpenPanesInBackground: (value) => {
    set({ openPanesInBackground: value });
  },

  setTerminalBackend: (value) => {
    set({ terminalBackend: value });
  },
  setCommitMsgMode: (value) => {
    set({ commitMsgMode: value });
  },
  setShadowAiCli: (value) => {
    set({ shadowAiCli: value });
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

  updateProjectTemplate: (path, template) => {
    const normalized = normalizePath(path);
    set((state) => ({
      recentProjects: state.recentProjects.map((p) =>
        normalizePath(p.path) === normalized
          ? { ...p, lastTemplate: template }
          : p
      ),
    }));
  },

  updateProjectLayout: (path, layout) => {
    const normalized = normalizePath(path);
    set((state) => ({
      recentProjects: state.recentProjects.map((p) =>
        normalizePath(p.path) === normalized
          ? { ...p, lastLayout: layout }
          : p
      ),
    }));
  },

  toggleProjectQuickOpen: (path) => {
    const normalized = normalizePath(path);
    set((state) => ({
      recentProjects: state.recentProjects.map((p) =>
        normalizePath(p.path) === normalized
          ? { ...p, quickOpen: !p.quickOpen }
          : p
      ),
    }));
  },
});
