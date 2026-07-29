import type { StateCreator } from "zustand";
import type { TerminalType, TerminalBackend, CommitMsgMode, ShadowAiCli, ComposerExpansion, PaneLayout, Tab } from "../types";
import { getDefaultBackend, detectBackendForPath } from "../lib/platform";
import { DEFAULT_JIRA_PROMPT } from "../lib/jira";

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
  /**
   * "Quick open" — clicking the project in the recent menu reopens its saved
   * layout directly instead of asking for one. ON by default:
   * `undefined` means enabled, explicit `false` means the user disabled it.
   * Read through `isQuickOpenEnabled`, never truthiness (`!!quickOpen` would
   * flip the default for every project that never touched the badge).
   */
  quickOpen?: boolean;
  lastLayout?: PaneLayout;
  /** Links to RemoteServer.id when the project lives on an SSH server. Presence means remote. */
  serverId?: string;
  /** Sticky per-project terminal backend. Set on first add via path detection; user-overridable. */
  preferredBackend?: TerminalBackend;
  /**
   * Per-project override for which shell the dev server runs in.
   * `true`  → force the Windows PowerShell pane, `false` → force WSL bash,
   * `undefined` → auto-detect (Tauri projects route to Windows). See
   * `resolveDevServerBackend`.
   */
  serverInWindows?: boolean;
  /**
   * Per-project override for the SHELL pane's PowerShell launch mode,
   * toggled by the WSL/WIN badge in the pane header.
   * `true`  → plain PowerShell (Set-Location to the project),
   * `false` → PS immediately drops into WSL bash (`wsl --cd`),
   * `undefined` → follow the project's backend (wsl-backed → WSL preload).
   * See `shellPsModeFor`. Independent of `serverInWindows` (dev servers).
   */
  shellInWindows?: boolean;
}

export function isRemoteProject(p: RecentProject): boolean {
  return !!p.serverId;
}

/** Quick open defaults to ON — see the `quickOpen` field doc. */
export function isQuickOpenEnabled(p: Pick<RecentProject, "quickOpen">): boolean {
  return p.quickOpen !== false;
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

/**
 * Ink presets for screenshot markup — the project palette plus yellow.
 *
 * Yellow is here because a see-through yellow highlighter is the whole point of
 * the marker tool and `PROJECT_COLOR_PRESETS` has no yellow; it leads the list
 * for the same reason. These are literal hexes for USER CONTENT, which is why
 * they sidestep the `--ezy-*` rule and the amber/yellow/blue ban (that governs
 * Tailwind classes on app chrome — this array already ships `sky: #38bdf8`).
 */
export const MARKUP_INK_PRESETS = [
  { id: "yellow", label: "Yellow", color: "#fbbf24" },
  ...PROJECT_COLOR_PRESETS,
] as const;

export type MarkupInkId = (typeof MARKUP_INK_PRESETS)[number]["id"];

/** Get the hex color for a project color ID */
export function getProjectColor(id: ProjectColorId): string | null {
  if (!id) return null;
  return PROJECT_COLOR_PRESETS.find((p) => p.id === id)?.color ?? null;
}

/** Display name for the project at `workingDir`: the recentProjects entry's
 *  name when one matches (backslash-normalized path + serverId — the same
 *  identity rule as tabSlice's resolveBackend), else the path basename. */
export function projectDisplayName(
  recentProjects: RecentProject[],
  workingDir: string,
  serverId?: string,
): string {
  const norm = workingDir.replace(/\\/g, "/");
  const match = recentProjects.find(
    (p) => p.path.replace(/\\/g, "/") === norm && p.serverId === serverId,
  );
  if (match?.name) return match.name;
  return norm.split("/").filter(Boolean).pop() ?? workingDir;
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

export const DEFAULT_CLI_FONT_SIZE = 16;

/** User-registered .md scaffold template (besides built-in CLAUDE/AGENTS/GEMINI). */
export interface CustomScaffold {
  id: string;
  /** Destination filename inside the new project, e.g. "STYLE.md" */
  filename: string;
  /** Absolute path to a template file. Empty string → create empty destination file. */
  templatePath: string;
  /** Pre-check this scaffold in the new-project dialog. */
  enabledByDefault: boolean;
}

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
  maskImagePathsInTerminal: boolean;
  /** Watch the OS Screenshots folder so snips that never hit the clipboard still show up. */
  watchScreenshotsFolder: boolean;
  /** Optional override for the Screenshots folder. Empty = use the OS-detected one. */
  screenshotsFolderOverride: string;
  /** Keep the screenshot viewer's size and position between openings. */
  rememberScreenshotWindow: boolean;
  /** Last viewer geometry, in CSS px. Only restored when the flag above is on. */
  screenshotWindowRect: { x: number; y: number; w: number; h: number } | null;
  panePromptHistory: Record<string, string[]>;
  globalPromptHistory: string[];
  autoStartServerCommand: boolean;
  previewInProjectTab: boolean;
  /** Dev-server quick-open icon in every terminal pane header (while running). */
  devServerButtonInHeader: boolean;
  setDevServerButtonInHeader: (value: boolean) => void;
  /** Dev-server quick-open icon on the active project tab (while running). */
  devServerButtonOnTab: boolean;
  setDevServerButtonOnTab: (value: boolean) => void;
  customServerCommands: string[];
  browserFullColumn: boolean;
  browserSpawnLeft: boolean;
  copyOnSelect: boolean;
  /** false = suppress ALL hover tooltips (chrome data-tooltip chips AND
   *  terminal file-link tooltips). Links stay underlined and clickable. */
  hoverTooltips: boolean;
  setHoverTooltips: (value: boolean) => void;
  confirmQuit: boolean;
  /** Ask before the Settings sidebar's Reload button reloads every pane.
   *  The modal's "Remember" checkbox clears this; the Behavior toggle restores it. */
  confirmReloadPanes: boolean;
  /** Last notification channel MADE wrote into Claude's own settings.json.
   *  A local mirror purely so the Settings dropdown can show what is set —
   *  there is no read-back command, only setters. "" = never applied. */
  claudeNotifChannel: string;
  slashCommandGhostText: boolean;
  codeReviewCollapseAll: boolean;
  /**
   * false (default): the text editor is a GLOBAL surface — opening a file opens
   * it in every project tab, and the pane's X closes it everywhere at once.
   * true: each project tab owns an independent editor — files open only in the
   * active project and the X closes only that project's pane.
   */
  perProjectEditor: boolean;
  setPerProjectEditor: (value: boolean) => void;
  /**
   * Soft-wrap long lines in the editor's SOURCE view (the markdown preview
   * always wraps). On by default — panes are typically ~30% of the window, so
   * without it the tail of every long line sits off-screen behind a horizontal
   * scrollbar.
   */
  editorWordWrap: boolean;
  setEditorWordWrap: (value: boolean) => void;
  showTabPath: boolean;
  setShowTabPath: (value: boolean) => void;
  /** Auto-hibernate idle background tabs (kill PTYs, keep layout; wake on
   *  activation). Default OFF — the manual tab-menu action is always there. */
  autoHibernateEnabled: boolean;
  setAutoHibernateEnabled: (value: boolean) => void;
  /** How long EVERY idle signal must stay quiet before a tab auto-hibernates. */
  autoHibernateMinutes: number;
  setAutoHibernateMinutes: (value: number) => void;
  /** Auto-dismiss pane notification cards. Default OFF — a finished pane is
   *  actionable state, so cards persist until clicked/dismissed. */
  notifAutoDismiss: boolean;
  setNotifAutoDismiss: (value: boolean) => void;
  /** Seconds before a card auto-dismisses (only when notifAutoDismiss is on). */
  notifAutoDismissSeconds: number;
  setNotifAutoDismissSeconds: (value: number) => void;
  /** While the window is minimized, a pane notification re-targets the active
   *  tab/pane in the background (window is never restored). Default OFF. */
  notifAutoSwitchMinimized: boolean;
  setNotifAutoSwitchMinimized: (value: boolean) => void;
  openPanesInBackground: boolean;
  wideGridLayout: boolean;
  redistributeOnClose: boolean;
  /** Topbar add-pane chevron opens its menu on hover (click still toggles). Default OFF. */
  hoverOpenAddPaneMenu: boolean;
  autoMinimizeGameOnAiDone: boolean;
  showMiniGamesButton: boolean;
  showKanbanButton: boolean;
  setShowKanbanButton: (value: boolean) => void;
  onboardingCompleted: boolean;
  setOnboardingCompleted: (value: boolean) => void;
  showChangelogOnUpdate: boolean;
  setShowChangelogOnUpdate: (value: boolean) => void;
  pullWithRebase: boolean;
  setPullWithRebase: (value: boolean) => void;
  lastSeenVersion: string | null;
  setLastSeenVersion: (value: string | null) => void;
  pendingChangelog: { version: string; notes: string } | null;
  setPendingChangelog: (value: { version: string; notes: string } | null) => void;
  settingsPanelOpen: boolean;
  toggleSettingsPanel: () => void;
  setSettingsPanelOpen: (value: boolean) => void;
  /** Jira site origin, e.g. `https://acme.atlassian.net`. "" until set by hand
   *  or learned from the browser pane's first navigation to a Jira page. */
  jiraBaseUrl: string;
  setJiraBaseUrl: (value: string) => void;
  /** Investigation prompt sent when a ticket pane opens. `{ticket}` is the
   *  placeholder. Editable so the wording can be tuned without a release. */
  jiraPromptTemplate: string;
  setJiraPromptTemplate: (value: string) => void;
  /** Remembered state of the ticket dialog's Swedish checkbox. */
  jiraReplyInSwedish: boolean;
  setJiraReplyInSwedish: (value: boolean) => void;
  projectsDir: string;
  defaultClaudeMdPath: string;
  defaultAgentsMdPath: string;
  defaultGeminiMdPath: string;
  defaultUseSingleSourcePointers: boolean;
  customScaffolds: CustomScaffold[];
  setProjectsDir: (value: string) => void;
  setDefaultClaudeMdPath: (value: string) => void;
  setDefaultAgentsMdPath: (value: string) => void;
  setDefaultGeminiMdPath: (value: string) => void;
  setDefaultUseSingleSourcePointers: (value: boolean) => void;
  addCustomScaffold: () => void;
  updateCustomScaffold: (id: string, patch: Partial<Omit<CustomScaffold, "id">>) => void;
  removeCustomScaffold: (id: string) => void;
  terminalBackend: TerminalBackend;
  /**
   * WSL distro override for everything MADE runs inside WSL (pane spawns,
   * pool warm, helper commands). `null` = wsl.exe's default distro
   * (`wsl --set-default`). Applies to NEW panes; open panes keep theirs.
   */
  wslDistro: string | null;
  commitMsgMode: CommitMsgMode;
  shadowAiCli: ShadowAiCli;
  projectColors: Record<string, ProjectColorId>;
  statuslineToggles: Partial<Record<TerminalType, Record<string, boolean>>>;
  setStatuslineToggle: (cliType: TerminalType, key: string, value: boolean) => void;
  setProjectColor: (workingDir: string, colorId: ProjectColorId) => void;
  addRecentProject: (entry: { path: string; name: string; template?: RecentProjectTemplate; serverCommand?: string; noDevServer?: boolean; serverId?: string }) => void;
  removeRecentProject: (path: string, serverId?: string) => void;
  clearRecentProjects: () => void;
  setAlwaysShowTemplatePicker: (value: boolean) => void;
  setRestoreLastSession: (value: boolean) => void;
  setAutoInsertClipboardImage: (value: boolean) => void;
  setCliFontSize: (type: TerminalType, size: number) => void;
  setCliYolo: (type: TerminalType, value: boolean) => void;
  setPromptComposerEnabled: (value: boolean) => void;
  setPromptComposerAlwaysVisible: (value: boolean) => void;
  setComposerExpansion: (value: ComposerExpansion) => void;
  setMaskImagePathsInTerminal: (value: boolean) => void;
  setWatchScreenshotsFolder: (value: boolean) => void;
  setScreenshotsFolderOverride: (value: string) => void;
  setRememberScreenshotWindow: (value: boolean) => void;
  setScreenshotWindowRect: (
    value: { x: number; y: number; w: number; h: number } | null,
  ) => void;
  addPromptHistory: (terminalId: string, text: string) => void;
  setAutoStartServerCommand: (value: boolean) => void;
  setPreviewInProjectTab: (value: boolean) => void;
  addCustomServerCommand: (command: string) => void;
  removeCustomServerCommand: (command: string) => void;
  updateProjectServerCommand: (path: string, command: string | undefined, serverId?: string) => void;
  setBrowserFullColumn: (value: boolean) => void;
  setBrowserSpawnLeft: (value: boolean) => void;
  setCopyOnSelect: (value: boolean) => void;
  setConfirmQuit: (value: boolean) => void;
  setConfirmReloadPanes: (value: boolean) => void;
  setClaudeNotifChannelPref: (value: string) => void;
  setSlashCommandGhostText: (value: boolean) => void;
  setCodeReviewCollapseAll: (value: boolean) => void;
  setOpenPanesInBackground: (value: boolean) => void;
  setWideGridLayout: (value: boolean) => void;
  setRedistributeOnClose: (value: boolean) => void;
  setHoverOpenAddPaneMenu: (value: boolean) => void;
  setAutoMinimizeGameOnAiDone: (value: boolean) => void;
  toggleMiniGamesButton: () => void;
  setTerminalBackend: (value: TerminalBackend) => void;
  setWslDistro: (value: string | null) => void;
  setProjectBackend: (path: string, serverId: string | undefined, backend: TerminalBackend) => void;
  /** Set the per-project dev-server shell override. `undefined` clears it (back to auto-detect). */
  setProjectServerInWindows: (path: string, serverId: string | undefined, value: boolean | undefined) => void;
  /** Set the per-project SHELL-pane PowerShell mode override (WSL/WIN badge). `undefined` clears it. */
  setProjectShellInWindows: (path: string, serverId: string | undefined, value: boolean | undefined) => void;
  setCommitMsgMode: (value: CommitMsgMode) => void;
  setShadowAiCli: (value: ShadowAiCli) => void;
  updateProjectTemplate: (path: string, template: RecentProjectTemplate, serverId?: string) => void;
  updateProjectLayout: (path: string, layout: PaneLayout, serverId?: string) => void;
  /** Save every open project tab's layout to its recentProjects.lastLayout entry. Called on app close. */
  flushTabLayoutsToRecent: (tabs: Tab[]) => void;
  setLastActiveProjectPath: (path: string) => void;
  toggleProjectQuickOpen: (path: string, serverId?: string) => void;
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
  maskImagePathsInTerminal: false,
  watchScreenshotsFolder: false,
  screenshotsFolderOverride: "",
  rememberScreenshotWindow: false,
  screenshotWindowRect: null,
  panePromptHistory: {},
  globalPromptHistory: [],
  autoStartServerCommand: true,
  previewInProjectTab: true,
  devServerButtonInHeader: false,
  devServerButtonOnTab: true,
  customServerCommands: [],
  browserFullColumn: true,
  browserSpawnLeft: false,
  copyOnSelect: false,
  hoverTooltips: true,
  confirmQuit: true,
  confirmReloadPanes: true,
  claudeNotifChannel: "",
  slashCommandGhostText: false,
  codeReviewCollapseAll: false,
  perProjectEditor: false,
  setPerProjectEditor: (value) => set({ perProjectEditor: value }),
  editorWordWrap: true,
  setEditorWordWrap: (value) => set({ editorWordWrap: value }),
  showTabPath: false,
  setShowTabPath: (value) => set({ showTabPath: value }),
  autoHibernateEnabled: false,
  setAutoHibernateEnabled: (value) => set({ autoHibernateEnabled: value }),
  autoHibernateMinutes: 30,
  setAutoHibernateMinutes: (value) => set({ autoHibernateMinutes: value }),
  notifAutoDismiss: false,
  setNotifAutoDismiss: (value) => set({ notifAutoDismiss: value }),
  notifAutoDismissSeconds: 30,
  setNotifAutoDismissSeconds: (value) => set({ notifAutoDismissSeconds: value }),
  notifAutoSwitchMinimized: false,
  setNotifAutoSwitchMinimized: (value) => set({ notifAutoSwitchMinimized: value }),
  openPanesInBackground: false,
  wideGridLayout: true,
  redistributeOnClose: true,
  hoverOpenAddPaneMenu: false,
  autoMinimizeGameOnAiDone: false,
  showMiniGamesButton: false,
  showKanbanButton: false,
  setShowKanbanButton: (value) => set({ showKanbanButton: value }),
  onboardingCompleted: false,
  setOnboardingCompleted: (value) => set({ onboardingCompleted: value }),
  showChangelogOnUpdate: true,
  setShowChangelogOnUpdate: (value) => set({ showChangelogOnUpdate: value }),
  pullWithRebase: false,
  setPullWithRebase: (value) => set({ pullWithRebase: value }),
  lastSeenVersion: null,
  setLastSeenVersion: (value) => set({ lastSeenVersion: value }),
  pendingChangelog: null,
  setPendingChangelog: (value) => set({ pendingChangelog: value }),
  settingsPanelOpen: false,
  toggleSettingsPanel: () => set((s) => ({ settingsPanelOpen: !s.settingsPanelOpen })),
  setSettingsPanelOpen: (value) => set({ settingsPanelOpen: value }),
  jiraBaseUrl: "",
  setJiraBaseUrl: (value) => set({ jiraBaseUrl: value }),
  jiraPromptTemplate: DEFAULT_JIRA_PROMPT,
  setJiraPromptTemplate: (value) => set({ jiraPromptTemplate: value }),
  jiraReplyInSwedish: false,
  setJiraReplyInSwedish: (value) => set({ jiraReplyInSwedish: value }),
  projectsDir: "",
  defaultClaudeMdPath: "",
  defaultAgentsMdPath: "",
  defaultGeminiMdPath: "",
  defaultUseSingleSourcePointers: false,
  customScaffolds: [],
  setProjectsDir: (value) => set({ projectsDir: value }),
  setDefaultClaudeMdPath: (value) => set({ defaultClaudeMdPath: value }),
  setDefaultAgentsMdPath: (value) => set({ defaultAgentsMdPath: value }),
  setDefaultGeminiMdPath: (value) => set({ defaultGeminiMdPath: value }),
  setDefaultUseSingleSourcePointers: (value) => set({ defaultUseSingleSourcePointers: value }),
  addCustomScaffold: () =>
    set((state) => ({
      customScaffolds: [
        ...state.customScaffolds,
        {
          id: `cs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          filename: "",
          templatePath: "",
          enabledByDefault: false,
        },
      ],
    })),
  updateCustomScaffold: (id, patch) =>
    set((state) => ({
      customScaffolds: state.customScaffolds.map((s) =>
        s.id === id ? { ...s, ...patch } : s,
      ),
    })),
  removeCustomScaffold: (id) =>
    set((state) => ({
      customScaffolds: state.customScaffolds.filter((s) => s.id !== id),
    })),
  terminalBackend: getDefaultBackend(),
  wslDistro: null,
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

  addRecentProject: ({ path, name, template, serverCommand, noDevServer, serverId }) => {
    const normalized = normalizePath(path);
    const matches = (p: RecentProject) =>
      normalizePath(p.path) === normalized && p.serverId === serverId;
    set((state) => {
      const existing = state.recentProjects.find(matches);
      const now = Date.now();
      let updated: RecentProject[];
      if (existing) {
        // Update existing: bump timestamp, count, template, serverCommand
        updated = state.recentProjects.map((p) =>
          matches(p)
            ? { ...p, lastOpenedAt: now, openCount: p.openCount + 1, lastTemplate: template ?? p.lastTemplate, name, serverCommand: noDevServer ? undefined : (serverCommand ?? p.serverCommand), noDevServer: noDevServer ?? p.noDevServer }
            : p
        );
      } else {
        // Add new — auto-detect backend from path; falls back to current global setting.
        // Remote (SSH) projects don't use the local backend split, so leave it undefined.
        const preferredBackend = serverId
          ? undefined
          : detectBackendForPath(path, state.terminalBackend);
        const newEntry: RecentProject = {
          id: `rp-${now}-${Math.random().toString(36).slice(2, 6)}`,
          path,
          name,
          lastOpenedAt: now,
          openCount: 1,
          lastTemplate: template,
          serverCommand: noDevServer ? undefined : serverCommand,
          noDevServer,
          serverId,
          preferredBackend,
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

  removeRecentProject: (path, serverId) => {
    const normalized = normalizePath(path);
    set((state) => ({
      recentProjects: state.recentProjects.filter(
        (p) => !(normalizePath(p.path) === normalized && p.serverId === serverId)
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

  setMaskImagePathsInTerminal: (value) => {
    set({ maskImagePathsInTerminal: value });
  },

  setWatchScreenshotsFolder: (value) => {
    set({ watchScreenshotsFolder: value });
  },

  setScreenshotsFolderOverride: (value) => {
    set({ screenshotsFolderOverride: value });
  },

  setRememberScreenshotWindow: (value) => {
    set({ rememberScreenshotWindow: value });
  },

  setScreenshotWindowRect: (value) => {
    set({ screenshotWindowRect: value });
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

  setDevServerButtonInHeader: (value) => {
    set({ devServerButtonInHeader: value });
  },

  setDevServerButtonOnTab: (value) => {
    set({ devServerButtonOnTab: value });
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

  setHoverTooltips: (value) => {
    set({ hoverTooltips: value });
  },

  setConfirmQuit: (value) => {
    set({ confirmQuit: value });
  },

  setConfirmReloadPanes: (value) => {
    set({ confirmReloadPanes: value });
  },

  setClaudeNotifChannelPref: (value) => {
    set({ claudeNotifChannel: value });
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

  setRedistributeOnClose: (value) => {
    set({ redistributeOnClose: value });
  },

  setHoverOpenAddPaneMenu: (value) => {
    set({ hoverOpenAddPaneMenu: value });
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
  setWslDistro: (value) => {
    set({ wslDistro: value });
  },
  setProjectBackend: (path, serverId, backend) => {
    const normalized = normalizePath(path);
    set((state) => ({
      recentProjects: state.recentProjects.map((p) =>
        normalizePath(p.path) === normalized && p.serverId === serverId
          ? { ...p, preferredBackend: backend }
          : p
      ),
    }));
  },
  setProjectServerInWindows: (path, serverId, value) => {
    const normalized = normalizePath(path);
    set((state) => ({
      recentProjects: state.recentProjects.map((p) =>
        normalizePath(p.path) === normalized && p.serverId === serverId
          ? { ...p, serverInWindows: value }
          : p
      ),
    }));
  },
  setProjectShellInWindows: (path, serverId, value) => {
    const normalized = normalizePath(path);
    set((state) => ({
      recentProjects: state.recentProjects.map((p) =>
        normalizePath(p.path) === normalized && p.serverId === serverId
          ? { ...p, shellInWindows: value }
          : p
      ),
    }));
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

  updateProjectServerCommand: (path, command, serverId) => {
    const normalized = normalizePath(path);
    set((state) => ({
      recentProjects: state.recentProjects.map((p) =>
        normalizePath(p.path) === normalized && p.serverId === serverId
          ? { ...p, serverCommand: command }
          : p
      ),
    }));
  },

  updateProjectTemplate: (path, template, serverId) => {
    const normalized = normalizePath(path);
    set((state) => ({
      recentProjects: state.recentProjects.map((p) =>
        normalizePath(p.path) === normalized && p.serverId === serverId
          ? { ...p, lastTemplate: template }
          : p
      ),
    }));
  },

  updateProjectLayout: (path, layout, serverId) => {
    const normalized = normalizePath(path);
    set((state) => ({
      recentProjects: state.recentProjects.map((p) =>
        normalizePath(p.path) === normalized && p.serverId === serverId
          ? { ...p, lastLayout: layout }
          : p
      ),
    }));
  },

  /** Persist every open project tab's layout tree onto its recentProjects.lastLayout.
   *  Single atomic set() to guarantee synchronous localStorage write via Zustand persist. */
  flushTabLayoutsToRecent: (tabs) => {
    // Key includes serverId so local and remote projects at the same path don't collide
    const key = (path: string, serverId?: string) => `${normalizePath(path)}|${serverId ?? ""}`;
    const latestByKey = new Map<string, PaneLayout>();
    for (const tab of tabs) {
      if (tab.isDevServerTab || tab.isServersTab || tab.isKanbanTab || tab.isSettingsTab) continue;
      if (!tab.workingDir) continue;
      if (!tab.layout) continue; // empty tab — don't overwrite saved layout with null
      // Later tabs for the same project win — matches "last-used" intent
      latestByKey.set(key(tab.workingDir, tab.serverId), tab.layout);
    }
    if (latestByKey.size === 0) return;
    set((state) => ({
      recentProjects: state.recentProjects.map((p) => {
        const layout = latestByKey.get(key(p.path, p.serverId));
        return layout ? { ...p, lastLayout: layout } : p;
      }),
    }));
  },

  setLastActiveProjectPath: (path) => {
    set({ lastActiveProjectPath: path });
  },

  toggleProjectQuickOpen: (path, serverId) => {
    const normalized = normalizePath(path);
    set((state) => ({
      recentProjects: state.recentProjects.map((p) =>
        normalizePath(p.path) === normalized && p.serverId === serverId
          ? { ...p, quickOpen: !isQuickOpenEnabled(p) }
          : p
      ),
    }));
  },
});
