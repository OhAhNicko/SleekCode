import type { StateCreator } from "zustand";
import type { TerminalType, TerminalBackend, CommitMsgMode, ShadowAiCli, ComposerExpansion, PaneLayout, Tab } from "../types";
import { getDefaultBackend } from "../lib/platform";

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
  noDevServer?: boolean;
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
  /** Path of last-focused project tab — survives when restoreLastSession is off so we know where to refocus. */
  lastActiveProjectPath: string;
  alwaysShowTemplatePicker: boolean;
  restoreLastSession: boolean;
  autoInsertClipboardImage: boolean;
  cliFontSizes: CliFontSizes;
  cliYolo: Partial<Record<TerminalType, boolean>>;
  promptComposerEnabled: boolean;
  promptComposerAlwaysVisible: boolean;
  composerExpansion: ComposerExpansion;
  panePromptHistory: Record<string, string[]>;
  globalPromptHistory: string[];
  autoStartServerCommand: boolean;
  previewInProjectTab: boolean;
  customServerCommands: string[];
  browserFullColumn: boolean;
  browserSpawnLeft: boolean;
  copyOnSelect: boolean;
  confirmQuit: boolean;
  slashCommandGhostText: boolean;
  codeReviewCollapseAll: boolean;
  showTabPath: boolean;
  setShowTabPath: (value: boolean) => void;
  openPanesInBackground: boolean;
  wideGridLayout: boolean;
  autoMinimizeGameOnAiDone: boolean;
  showMiniGamesButton: boolean;
  onboardingCompleted: boolean;
  setOnboardingCompleted: (value: boolean) => void;
  settingsPanelOpen: boolean;
  toggleSettingsPanel: () => void;
  setSettingsPanelOpen: (value: boolean) => void;
  projectsDir: string;
  defaultClaudeMdPath: string;
  defaultAgentsMdPath: string;
  setProjectsDir: (value: string) => void;
  setDefaultClaudeMdPath: (value: string) => void;
  setDefaultAgentsMdPath: (value: string) => void;
  terminalBackend: TerminalBackend;
  commitMsgMode: CommitMsgMode;
  shadowAiCli: ShadowAiCli;
  projectColors: Record<string, ProjectColorId>;
  statuslineToggles: Partial<Record<TerminalType, Record<string, boolean>>>;
  setStatuslineToggle: (cliType: TerminalType, key: string, value: boolean) => void;
  setProjectColor: (workingDir: string, colorId: ProjectColorId) => void;
  addRecentProject: (entry: { path: string; name: string; template?: RecentProjectTemplate; serverCommand?: string; noDevServer?: boolean }) => void;
  removeRecentProject: (path: string) => void;
  clearRecentProjects: () => void;
  setAlwaysShowTemplatePicker: (value: boolean) => void;
  setRestoreLastSession: (value: boolean) => void;
  setAutoInsertClipboardImage: (value: boolean) => void;
  setCliFontSize: (type: TerminalType, size: number) => void;
  setCliYolo: (type: TerminalType, value: boolean) => void;
  setPromptComposerEnabled: (value: boolean) => void;
  setPromptComposerAlwaysVisible: (value: boolean) => void;
  setComposerExpansion: (value: ComposerExpansion) => void;
  addPromptHistory: (terminalId: string, text: string) => void;
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
  setWideGridLayout: (value: boolean) => void;
  setAutoMinimizeGameOnAiDone: (value: boolean) => void;
  toggleMiniGamesButton: () => void;
  setTerminalBackend: (value: TerminalBackend) => void;
  setCommitMsgMode: (value: CommitMsgMode) => void;
  setShadowAiCli: (value: ShadowAiCli) => void;
  updateProjectTemplate: (path: string, template: RecentProjectTemplate) => void;
  updateProjectLayout: (path: string, layout: PaneLayout) => void;
  /** Save every open project tab's layout to its recentProjects.lastLayout entry. Called on app close. */
  flushTabLayoutsToRecent: (tabs: Tab[]) => void;
  setLastActiveProjectPath: (path: string) => void;
  toggleProjectQuickOpen: (path: string) => void;
}

export const createRecentProjectsSlice: StateCreator<
  RecentProjectsSlice,
  [],
  [],
  RecentProjectsSlice
> = (set) => ({
  recentProjects: [],
  lastActiveProjectPath: "",
  alwaysShowTemplatePicker: false,
  restoreLastSession: true,
  autoInsertClipboardImage: false,
  cliFontSizes: {},
  cliYolo: {},
  promptComposerEnabled: false,
  promptComposerAlwaysVisible: false,
  composerExpansion: "up" as ComposerExpansion,
  panePromptHistory: {},
  globalPromptHistory: [],
  autoStartServerCommand: true,
  previewInProjectTab: true,
  customServerCommands: [],
  browserFullColumn: true,
  browserSpawnLeft: false,
  copyOnSelect: false,
  confirmQuit: true,
  slashCommandGhostText: false,
  codeReviewCollapseAll: false,
  showTabPath: false,
  setShowTabPath: (value) => set({ showTabPath: value }),
  openPanesInBackground: false,
  wideGridLayout: true,
  autoMinimizeGameOnAiDone: false,
  showMiniGamesButton: false,
  onboardingCompleted: false,
  setOnboardingCompleted: (value) => set({ onboardingCompleted: value }),
  settingsPanelOpen: false,
  toggleSettingsPanel: () => set((s) => ({ settingsPanelOpen: !s.settingsPanelOpen })),
  setSettingsPanelOpen: (value) => set({ settingsPanelOpen: value }),
  projectsDir: "",
  defaultClaudeMdPath: "",
  defaultAgentsMdPath: "",
  setProjectsDir: (value) => set({ projectsDir: value }),
  setDefaultClaudeMdPath: (value) => set({ defaultClaudeMdPath: value }),
  setDefaultAgentsMdPath: (value) => set({ defaultAgentsMdPath: value }),
  terminalBackend: getDefaultBackend(),
  commitMsgMode: "simple",
  shadowAiCli: "claude",
  projectColors: {},
  statuslineToggles: {},

  setStatuslineToggle: (cliType, key, value) => {
    set((state) => ({
      statuslineToggles: {
        ...state.statuslineToggles,
        [cliType]: { ...state.statuslineToggles[cliType], [key]: value },
      },
    }));
  },

  setProjectColor: (workingDir, colorId) => {
    const key = normalizePath(workingDir);
    set((state) => ({
      projectColors: { ...state.projectColors, [key]: colorId },
    }));
  },

  addRecentProject: ({ path, name, template, serverCommand, noDevServer }) => {
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
            ? { ...p, lastOpenedAt: now, openCount: p.openCount + 1, lastTemplate: template ?? p.lastTemplate, name, serverCommand: noDevServer ? undefined : (serverCommand ?? p.serverCommand), noDevServer: noDevServer ?? p.noDevServer }
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
          serverCommand: noDevServer ? undefined : serverCommand,
          noDevServer,
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

  setComposerExpansion: (value) => {
    set({ composerExpansion: value });
  },

  addPromptHistory: (terminalId, text) => {
    set((state) => {
      const paneHist = state.panePromptHistory[terminalId] ?? [];
      const globalHist = state.globalPromptHistory;

      // Avoid consecutive duplicates on both
      const paneChanged = paneHist[0] !== text;
      const globalChanged = globalHist[0] !== text;
      if (!paneChanged && !globalChanged) return state;

      const result: Partial<typeof state> = {};
      if (paneChanged) {
        const updatedPane = [text, ...paneHist];
        if (updatedPane.length > 50) updatedPane.length = 50;
        result.panePromptHistory = { ...state.panePromptHistory, [terminalId]: updatedPane };
      }
      if (globalChanged) {
        const updatedGlobal = [text, ...globalHist];
        if (updatedGlobal.length > 100) updatedGlobal.length = 100;
        result.globalPromptHistory = updatedGlobal;
      }
      return result;
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

  setWideGridLayout: (value) => {
    set({ wideGridLayout: value });
  },

  setAutoMinimizeGameOnAiDone: (value) => {
    set({ autoMinimizeGameOnAiDone: value });
  },

  toggleMiniGamesButton: () => {
    set((state) => ({ showMiniGamesButton: !state.showMiniGamesButton }));
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

  /** Persist every open project tab's layout tree onto its recentProjects.lastLayout.
   *  Single atomic set() to guarantee synchronous localStorage write via Zustand persist. */
  flushTabLayoutsToRecent: (tabs) => {
    const latestByPath = new Map<string, PaneLayout>();
    for (const tab of tabs) {
      if (tab.isDevServerTab || tab.isServersTab || tab.isKanbanTab || tab.isSettingsTab) continue;
      if (!tab.workingDir) continue;
      // Later tabs for the same project win — matches "last-used" intent
      latestByPath.set(normalizePath(tab.workingDir), tab.layout);
    }
    if (latestByPath.size === 0) return;
    set((state) => ({
      recentProjects: state.recentProjects.map((p) => {
        const layout = latestByPath.get(normalizePath(p.path));
        return layout ? { ...p, lastLayout: layout } : p;
      }),
    }));
  },

  setLastActiveProjectPath: (path) => {
    set({ lastActiveProjectPath: path });
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
