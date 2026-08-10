import type { StateCreator } from "zustand";
import type { TerminalType, TerminalBackend, CommitMsgMode, ShadowAiCli, ComposerExpansion, PaneLayout, Tab } from "../types";
import { getDefaultBackend, detectBackendForPath } from "../lib/platform";
import { DEFAULT_JIRA_PROMPT, normalizeJiraBaseUrl } from "../lib/jira";

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
  /**
   * The project's PRIMARY dev-server command — a mirror of `serverCommands[0]`,
   * kept because most readers (recent menu, template picker, command
   * suggestions) only ever want "the" command. Never assign it directly:
   * `setProjectServerCommands` is the single writer and keeps the two in step.
   */
  serverCommand?: string;
  /**
   * Every dev-server command configured for this project, in panel row order.
   * A project can run several at once (web + Tauri, app + API, a second
   * instance on another port); each gets its own row and its own PTY.
   *
   * Recomputed from the live rows on every add / edit / remove rather than
   * patched slot-by-slot, so removing a row can never leave a stale index
   * pointing at the wrong command. See `syncProjectServerCommands`.
   */
  serverCommands?: string[];
  /**
   * Which of `serverCommands` the quick-open surfaces (tab-bar globe,
   * pane-header globe, browser preview) target. `undefined` falls back to the
   * first running server, then the first row.
   *
   * Matched by command STRING rather than index so removing or reordering a
   * different row can't silently re-point it. NOT the same thing as
   * `quickOpen` below, which is about the recent menu reopening a layout.
   */
  primaryServerCommand?: string;
  /**
   * The port each dev-server command last came up on, when that was NOT the
   * port the project itself names. Keyed by command string, like
   * `primaryServerCommand`, so removing or reordering a row can't re-point it.
   *
   * This is what keeps a URL stable: a project pushed off 5173 onto 5174 by a
   * sibling comes back on 5174 next launch instead of re-probing from scratch —
   * without ever editing the command text the user typed. An entry is DELETED
   * (not overwritten) when a server lands on its natural port again, so a
   * config change always wins over an old preference. See `rememberPort`.
   */
  serverPorts?: Record<string, number>;
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
  /** Jira project (ticket rail + per-ticket canvas). Reopens as a Jira tab and
   *  carries a JIRA badge in the recent menu. */
  isJira?: boolean;
  /** Which Jira site this project's tickets live on (normalized origin — the
   *  site ID). Absent on legacy projects → resolvers fall back to the default
   *  site. One site per project by design. */
  jiraSiteId?: string;
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

export type DevServerTabIconMode = "all" | "active" | "off";

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

/**
 * Notification sound presets. Metadata ONLY — the synthesis recipes live in
 * src/lib/notification-sounds.ts keyed by these ids, so a future switch to
 * bundled audio files (e.g. ElevenLabs-generated) replaces recipes without
 * touching this list, the picker, or the per-project map.
 */
export const SOUND_PRESETS = [
  { id: "chime", label: "Chime" },
  { id: "bell", label: "Bell" },
  { id: "marimba", label: "Marimba" },
  { id: "droplet", label: "Droplet" },
  { id: "pop", label: "Pop" },
  { id: "glass", label: "Glass" },
  { id: "ping", label: "Ping" },
  { id: "bloom", label: "Bloom" },
  { id: "knock", label: "Knock" },
  { id: "pulse", label: "Pulse" },
] as const;

export type ProjectSoundId = (typeof SOUND_PRESETS)[number]["id"] | null;

/** Auto-assign: pick a sound not currently used by any project. If all are
 *  taken, pick the least-used. Mirrors autoAssignColor above. */
export function autoAssignSound(existing: Record<string, ProjectSoundId>): ProjectSoundId {
  const usedIds = Object.values(existing).filter(Boolean) as string[];
  const usedSet = new Set(usedIds);

  const unused = SOUND_PRESETS.filter((p) => !usedSet.has(p.id));
  if (unused.length > 0) {
    return unused[Math.floor(Math.random() * unused.length)].id;
  }

  const counts = new Map<string, number>();
  for (const id of usedIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  let minCount = Infinity;
  for (const c of counts.values()) if (c < minCount) minCount = c;
  const leastUsed = SOUND_PRESETS.filter((p) => (counts.get(p.id) ?? 0) === minCount);
  return leastUsed[Math.floor(Math.random() * leastUsed.length)].id;
}

export const DEFAULT_CLI_FONT_SIZE = 16;

/** User-registered .md scaffold template (besides built-in CLAUDE/AGENTS/GEMINI). */
/** Last-observed state of one Jira ticket — the diff baseline for update
 *  notifications. See jiraTicketSnapshots on the slice. */
export interface JiraTicketSnapshot {
  updatedIso: string;
  lastCommentId?: string;
  statusName?: string;
  assigneeAccountId?: string;
  assigneeName?: string;
  /** Ticket title — shown in the pane header, refreshed every poll. */
  summary?: string;
  /** True while there are updates the user hasn't viewed — rail highlight. */
  unseen?: boolean;
  /** Facts behind the Tickets tab's meta line. Those rows are SESSIONS, not
   *  issues, so this snapshot is where their issue-side data lives. Absent on
   *  every snapshot written before these fields existed; the next poll fills
   *  them in. Deliberately NOT part of change detection — a "priority raised"
   *  card would need its own classify() branch, added together or not at all. */
  statusCategory?: JiraStatusCategoryKey;
  createdIso?: string;
  priorityName?: string;
  priorityId?: string;
  reporterName?: string;
  /** JSM "Organizations" — the customer company that raised the ticket. */
  organization?: string;
  /** JSM "Request Type" — which request form the ticket came in on. */
  requestType?: string;
  /** User-picked extra fields, keyed by Jira field id. */
  extra?: Record<string, string>;
}

/** Jira's coarse status bucket. Rides inside the issue's `status` object. */
export type JiraStatusCategoryKey = "new" | "indeterminate" | "done";

/** One field a Jira site exposes (wire shape of `jira_site_meta`). */
export interface JiraFieldMeta {
  id: string;
  name: string;
  custom: boolean;
  /** `schema.custom` when present, else `schema.type`. */
  kind?: string;
}

/**
 * One row of the Assigned / Unassigned rail lists.
 *
 * Every field past the original five is OPTIONAL, and must stay that way:
 * rows persisted by builds before this shape existed carry only
 * key/summary/status/updatedIso/siteId, and they have to keep rendering (and
 * sorting, undefined-last) without a store migration. Narrowing any of them to
 * required later means writing a `merge` entry in store/index.ts.
 */
export interface JiraListTicket {
  key: string;
  summary: string;
  status: string;
  statusCategory?: JiraStatusCategoryKey;
  updatedIso: string;
  createdIso?: string;
  priorityName?: string;
  priorityId?: string;
  reporterName?: string;
  organization?: string;
  requestType?: string;
  extra?: Record<string, string>;
  siteId: string;
}

/** Which live-Jira elements a ticket's CLI pane header shows. */
export interface JiraHeaderShow {
  status: boolean;
  summary: boolean;
  assignee: boolean;
  /** The customer company that raised the ticket (JSM Organizations). */
  organization: boolean;
  /** JSM Request type — which request form the ticket came in on. */
  requestType: boolean;
  priority: boolean;
  reporter: boolean;
  updated: boolean;
}

export const DEFAULT_JIRA_HEADER_SHOW: JiraHeaderShow = {
  status: true,
  summary: true,
  assignee: false,
  // On by default: in a support workflow "who is this for" is the first thing
  // you want off a pane header, and it is absent on non-JSM sites anyway.
  organization: true,
  requestType: true,
  priority: false,
  reporter: false,
  updated: false,
};

/** Which facts the rail rows' second line carries. */
export interface JiraRowMetaShow {
  updated: boolean;
  created: boolean;
  priority: boolean;
  reporter: boolean;
  organization: boolean;
  requestType: boolean;
}

export const DEFAULT_JIRA_ROW_META_SHOW: JiraRowMetaShow = {
  updated: true,
  created: true,
  priority: true,
  reporter: false,
  organization: true,
  requestType: true,
};

/** Sortable columns of the Assigned / Unassigned lists. Mirrors the Rust
 *  `order_clause` whitelist — the two must stay in step, since the sort is
 *  applied server-side (the result page is truncated, so a client-only sort
 *  would reorder the wrong 50 rows). */
export type JiraSortKey = "updated" | "created" | "priority" | "status" | "key" | "summary";
export type JiraSortDir = "asc" | "desc";
export type JiraSortList = "assigned" | "unassigned";

/** Assigned wants "what moved", unassigned wants "what's new" — genuinely
 *  different natural orders, so the two lists sort independently. */
export const DEFAULT_JIRA_SORT: Record<JiraSortList, { key: JiraSortKey; dir: JiraSortDir }> = {
  assigned: { key: "updated", dir: "desc" },
  unassigned: { key: "created", dir: "desc" },
};

/** Ticket-list width per rail tab. Assigned/Unassigned carry a meta line and a
 *  status badge, so they need more room than the plain Tickets list — one
 *  width for both of them, one for Tickets. */
export interface JiraRailWidths {
  tickets: number;
  list: number;
}

export const DEFAULT_JIRA_RAIL_WIDTHS: JiraRailWidths = { tickets: 240, list: 360 };
export const JIRA_RAIL_MIN_WIDTH = 200;
export const JIRA_RAIL_MAX_WIDTH = 560;

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
  /** Dev-server quick-open on project tabs (while running): the tab NAME is
   *  the click target, underlined on hover like a link.
   *  "all" = every tab with a running server, "active" = active tab only,
   *  "off" = never. Off + header toggle off = feature fully disabled. */
  devServerTabIcon: DevServerTabIconMode;
  setDevServerTabIcon: (value: DevServerTabIconMode) => void;
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
  /** Master switch for pane notification cards. Default ON; off disables the
   *  whole pipeline (no cards, no auto-switch) and clears any visible stack. */
  notifEnabled: boolean;
  setNotifEnabled: (value: boolean) => void;
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
  /** Show a Windows toast for pane notifications while the window is
   *  minimized (in-app cards are invisible then). Default ON. Runs ALONGSIDE
   *  the custom popups below — its job is the Action Center history entry. */
  notifSystemMinimized: boolean;
  setNotifSystemMinimized: (value: boolean) => void;
  /** MADE's own notification popups (the corner "toast" window) while the app
   *  is minimized or unfocused. Default ON. */
  notifOsPopupsEnabled: boolean;
  setNotifOsPopupsEnabled: (value: boolean) => void;
  /** Play a per-project sound when a notification card is added. Default ON. */
  notifSoundEnabled: boolean;
  setNotifSoundEnabled: (value: boolean) => void;
  /** One-time Gemini notification seed already ran (lib/gemini-notifications).
   *  Gemini ships desktop notifications OFF; MADE turns them on ONCE when the
   *  key is absent — an explicit Gemini-side `false` is a user choice and is
   *  never overridden, so this flag stops every later silent write. */
  geminiNotifSeeded: boolean;
  setGeminiNotifSeeded: (value: boolean) => void;
  /** Notification sound volume, 0-100. Default 50. */
  notifSoundVolume: number;
  setNotifSoundVolume: (value: number) => void;
  /** Per-project notification sound. Key = workingDir with `\`→`/` — PATH
   *  ONLY, no serverId, the same identity rule as projectColors (two tabs on
   *  one project share the sound; see tab.ts's colorKey comment). A key that
   *  is absent = never assigned (auto-assign on first use); `null` = the user
   *  explicitly chose "No sound" and it stays silent. */
  projectSounds: Record<string, ProjectSoundId>;
  setProjectSound: (workingDir: string, soundId: ProjectSoundId) => void;
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
  /** Configured Jira site origins, add order. THE SITE ID IS THE ORIGIN
   *  (normalized, e.g. `https://acme.atlassian.net`) — self-describing, and
   *  `|` can appear in neither an origin nor a ticket key, so qualified keys
   *  (`<origin>|<KEY>`, lib/jira-sites.ts) are unambiguous. Grown from the
   *  Settings list editor, the ticket dialog's first run, or the browser
   *  pane's auto-learn. */
  jiraSites: string[];
  /** Normalize → dedupe → append. The FIRST site added also becomes the
   *  default. */
  addJiraSite: (raw: string) => void;
  /** Default falls back to the first remaining site (or "") when the default
   *  itself is removed. Snapshots of a removed site rebaseline silently if it
   *  is ever re-added — no cleanup needed here. */
  removeJiraSite: (siteId: string) => void;
  /** "" until a site exists. New Jira projects are born on this site. */
  jiraDefaultSiteId: string;
  setJiraDefaultSite: (siteId: string) => void;
  /** Re-point a project's site (rail-header switcher). Applies to NEW
   *  tickets; open pairs keep the browser URLs persisted in their layout. */
  setProjectJiraSite: (path: string, serverId: string | undefined, siteId: string) => void;
  /** Investigation prompt sent when a ticket pane opens. `{ticket}` is the
   *  placeholder. Editable so the wording can be tuned without a release. */
  jiraPromptTemplate: string;
  setJiraPromptTemplate: (value: string) => void;
  /** Remembered state of the ticket dialog's Swedish checkbox. */
  jiraReplyInSwedish: boolean;
  setJiraReplyInSwedish: (value: boolean) => void;
  /** Remembered state of the ticket dialog's English checkbox (mutually
   *  exclusive with Swedish — the dialog enforces it). */
  jiraReplyInEnglish: boolean;
  setJiraReplyInEnglish: (value: boolean) => void;
  /** Which side the Claude pane sits on in a Jira ticket view (browser takes
   *  the other side). Jira projects only. */
  jiraClaudeSide: "left" | "right";
  setJiraClaudeSide: (value: "left" | "right") => void;
  /** Remembered model pick of the new-ticket dialog, as a Claude Code `--model`
   *  alias ("fable" | "opus" | "sonnet" | "haiku" — the CLI resolves aliases to
   *  the latest release). `null` = no flag, Claude Code's own default. */
  jiraClaudeModel: string | null;
  setJiraClaudeModel: (value: string | null) => void;
  /** Which CLI a new ticket pane runs. Remembered from the new-ticket dialog. */
  jiraCli: "claude" | "codex" | "gemini";
  setJiraCli: (value: "claude" | "codex" | "gemini") => void;
  /** Remembered model pick for a Codex ticket pane, as a literal `-m` slug
   *  ("gpt-5.6-sol", …). Codex has NO tier aliases — the slugs are versioned
   *  and its config even ships a migration table for retired ones — so this is
   *  free text, not a fixed list that would rot. `null` = no flag. */
  jiraCodexModel: string | null;
  setJiraCodexModel: (value: string | null) => void;
  /** Same for Gemini ("gemini-3.1-pro-preview", …). Also alias-free. */
  jiraGeminiModel: string | null;
  setJiraGeminiModel: (value: string | null) => void;
  /** Jira mode (on by default): declutter the tab bars while a Jira project
   *  tab is active — the dev server and file-sidebar buttons hide there.
   *  Ordinary project tabs are unaffected. */
  jiraMode: boolean;
  setJiraMode: (value: boolean) => void;
  /** Ticket-key prefixes ("SUPPORT", "DEV", …) the user has used, most recent
   *  first. The new-ticket dialog pre-fills [0] so usually only the number
   *  needs typing. */
  jiraAcronyms: string[];
  addJiraAcronym: (acronym: string) => void;
  /** How often each acronym was used — ranks the dialog's quick-pick tiles. */
  jiraAcronymCounts: Record<string, number>;
  /** Per-ticket color overrides (context menu). Absent = deterministic hash. */
  jiraTicketColors: Record<string, ProjectColorId>;
  setJiraTicketColor: (ticket: string, colorId: ProjectColorId) => void;
  /** Paint the whole ticket row in its color (text adapts for contrast). */
  jiraRowFullColor: boolean;
  setJiraRowFullColor: (value: boolean) => void;
  /** How a ticket's sub-tickets share its canvas. "default" shows ONE instance
   *  at a time — the rail swaps between them. "stacked" shows every instance of
   *  the selected ticket at once, stacked vertically beside the shared browser,
   *  each collapsible to its header. Applied at DISPLAY time, so flipping it
   *  reorients every open ticket at once (same rule as `jiraClaudeSide`). */
  jiraSubticketMode: "default" | "stacked";
  setJiraSubticketMode: (value: "default" | "stacked") => void;
  /** Stacked mode: which instance panes are collapsed to their header, keyed
   *  `<tabId>:<instanceKey>`. A sparse set — absent means expanded. */
  jiraStackCollapsed: Record<string, true>;
  toggleJiraStackCollapsed: (tabId: string, instKey: string) => void;
  /** Stacked mode: dragged divider positions for a ticket's stack, keyed
   *  `<tabId>:<ticket>`. Absent = equal share. Percentages, one per EXPANDED
   *  pane in stack order — the collapsed ones are pinned and take no share. */
  jiraStackSizes: Record<string, number[]>;
  setJiraStackSizes: (tabId: string, ticket: string, sizes: number[]) => void;
  /** Pasting a ticket URL (or typing a bare key) into a Jira ticket browser's
   *  address bar opens that ticket as its own ticket instead of navigating this
   *  ticket's browser away. Address bar ONLY — clicking a ticket link inside
   *  the page still just navigates, or browsing a linked-issues list would
   *  spawn a paid investigation per click. Off restores plain navigation. */
  jiraDetectPastedTickets: boolean;
  setJiraDetectPastedTickets: (value: boolean) => void;
  /** Whether a detected ticket takes the canvas ("auto") or opens in the
   *  background behind a toast with a Switch button ("manual"). */
  jiraAutoSwitchToDetected: "auto" | "manual";
  setJiraAutoSwitchToDetected: (value: "auto" | "manual") => void;
  /** What a detected ticket does when its only rows are ARCHIVED: unarchive and
   *  resume the conversation, or leave the archive alone and start a fresh one.
   *  Either way the toast says so — an unarchive undoes a deliberate act and
   *  must never be silent. */
  jiraArchivedTicketAction: "resume" | "new";
  setJiraArchivedTicketAction: (value: "resume" | "new") => void;
  /** Jira REST credentials for the background update poller (JiraNotifyEngine).
   *  Basic auth = account email + API token (id.atlassian.com). Stored in the
   *  persisted store like the rest of the Jira settings — the token is
   *  revocable per-token at Atlassian's end (precedent: RemoteServer's
   *  claudeOauthToken persists the same way). */
  jiraApiEmail: string;
  setJiraApiEmail: (value: string) => void;
  jiraApiToken: string;
  setJiraApiToken: (value: string) => void;
  /** Own Atlassian accountId (captured via jira_test_auth) — filters own
   *  comments out of the "new reply" notifications. */
  jiraMyAccountId: string;
  setJiraMyAccountId: (value: string) => void;
  /** Master switch for Jira ticket-update notifications (cards/toast/sound).
   *  Polling itself also serves the Assigned tab, so this gates EMISSION only. */
  jiraNotifEnabled: boolean;
  setJiraNotifEnabled: (value: boolean) => void;
  /** "My assigned tickets" mode: adds an Assigned tab to the ticket rail.
   *  Assigned rows open browser-only previews — never a CLI pane. */
  jiraAssignedMode: boolean;
  setJiraAssignedMode: (value: boolean) => void;
  /** Last-known assignee=currentUser() list, ALL sites merged (sorted by
   *  updatedIso desc, each row tagged with its site) — persisted so the
   *  Assigned tab renders instantly on boot; polls refresh it per site. */
  jiraAssignedTickets: JiraListTicket[];
  /** Replace ONE site's rows, keep every other site's — a per-site poll must
   *  never clobber the merged list. */
  setJiraAssignedTicketsForSite: (siteId: string, value: JiraListTicket[]) => void;
  /** "Unassigned queue" mode: adds an Unassigned tab listing open tickets in
   *  the tab's own Jira project(s) that nobody has picked up.
   *
   *  ON by default. It is safe to be on because the query is gated on
   *  VISIBILITY in jira-notify.ts — it only runs while a rail is actually
   *  showing the tab, and then at most once per 180s. So an enabled but
   *  unviewed Unassigned tab costs exactly zero extra requests.
   *
   *  Those gates are not optional. Ungated this is ~1440 background JQL
   *  searches/day/site. Nothing is billed — Jira Cloud's REST API is not
   *  metered — but it IS rate-limited, and JQL search draws down the per-app
   *  budget faster than cheap calls, so it would surface as intermittent 429s
   *  throttling the WHOLE integration, notifications included. */
  jiraUnassignedMode: boolean;
  setJiraUnassignedMode: (value: boolean) => void;
  /** Last-known unassigned queue, ALL sites merged. Unlike the assigned list
   *  these rows write NO snapshots and raise NO notifications — see
   *  pollQueueForSite. */
  jiraUnassignedTickets: JiraListTicket[];
  setJiraUnassignedTicketsForSite: (siteId: string, value: JiraListTicket[]) => void;
  /** Assigned to you AND resolved/closed — the Assigned tab's "Done" mini tab.
   *  The open assigned query excludes statusCategory Done, so these would
   *  otherwise be invisible. Browse-only: like the unassigned queue it writes
   *  no snapshots and raises no notifications, and it is fetched only while
   *  the mini tab is actually showing. */
  jiraAssignedDoneTickets: JiraListTicket[];
  setJiraAssignedDoneTicketsForSite: (siteId: string, value: JiraListTicket[]) => void;
  /** Per-site project-key override for the unassigned query, e.g.
   *  `{"https://x.atlassian.net": ["SUPPORT"]}`. Unioned with the keys derived
   *  from the tab's own ticket rows — which is what covers a brand-new Jira tab
   *  that has no rows yet and would otherwise get a permanently empty queue. */
  jiraUnassignedProjects: Record<string, string[]>;
  setJiraUnassignedProjects: (siteId: string, keys: string[]) => void;
  /** Notify when a ticket appears in the unassigned queue. */
  jiraUnassignedNotify: boolean;
  setJiraUnassignedNotify: (value: boolean) => void;
  /** QUALIFIED keys already seen in the unassigned queue, so a ticket announces
   *  itself ONCE.
   *
   *  Deliberately its own set rather than reusing jiraTicketSnapshots: that map
   *  is pruned every clean cycle to the keys `pollOneSite` returns, and an
   *  unassigned key is never among them — so a snapshot written here would be
   *  wiped and rewritten forever, re-announcing the same ticket every poll.
   *  Bounded, because an untended queue is unbounded. */
  jiraUnassignedSeen: string[];
  markJiraUnassignedSeen: (qkeys: string[]) => void;
  /** Ticket-rail width per tab (see JiraRailWidths). Clamped in the setter. */
  jiraRailWidths: JiraRailWidths;
  setJiraRailWidth: (which: keyof JiraRailWidths, px: number) => void;
  /** Where a ticket's status colour shows on its row: the left stripe, the
   *  badge, or both. */
  jiraStatusIndicator: "both" | "stripe" | "badge";
  setJiraStatusIndicator: (value: "both" | "stripe" | "badge") => void;
  /** Collapsible grouping for the rail lists: one long list, one group per
   *  status, or one group per coarse status category. */
  jiraListGrouping: "flat" | "status" | "category";
  setJiraListGrouping: (value: "flat" | "status" | "category") => void;
  /** Sort key + direction per list. Applied SERVER-SIDE (it goes into the JQL)
   *  because the result page is truncated — see JiraSortKey. */
  jiraListSort: Record<JiraSortList, { key: JiraSortKey; dir: JiraSortDir }>;
  setJiraListSort: (
    list: JiraSortList,
    patch: Partial<{ key: JiraSortKey; dir: JiraSortDir }>,
  ) => void;
  /** Which facts the rail rows' second line carries. */
  jiraRowMetaShow: JiraRowMetaShow;
  setJiraRowMetaShow: (patch: Partial<JiraRowMetaShow>) => void;
  /** "auto" derives every status colour from its name; "manual" lets
   *  jiraStatusColors pin them. */
  jiraStatusColorMode: "auto" | "manual";
  setJiraStatusColorMode: (value: "auto" | "manual") => void;
  /** Per-status colour overrides, keyed by NORMALIZED status name (see
   *  lib/jira-status-colors.ts). Free-form hex, not a palette id — the Settings
   *  picker offers a custom colour. Only consulted in "manual" mode. */
  jiraStatusColors: Record<string, string>;
  setJiraStatusColor: (status: string, hex: string | null) => void;
  /** Per-site field catalogue from `jira_site_meta`, cached for the life of
   *  the store. Locates Organizations / Request type by schema kind (their ids
   *  differ per site) AND populates the Settings pickers. An empty array is a
   *  valid cached answer — see lib/jira-fields.ts. */
  jiraSiteFields: Record<string, JiraFieldMeta[]>;
  setJiraSiteFields: (siteId: string, fields: JiraFieldMeta[]) => void;
  /** Priority NAMES in the site's OWN order, most urgent first — Jira's
   *  authoritative ranking, so the client sort stops guessing from names. */
  jiraSitePriorities: Record<string, string[]>;
  setJiraSitePriorities: (siteId: string, names: string[]) => void;
  /** Extra Jira fields the user added as columns, by field id — separately
   *  for the ticket LIST rows and the ticket PANE HEADER, because the two have
   *  very different room. */
  jiraExtraFields: { rows: string[]; header: string[] };
  setJiraExtraFields: (where: "rows" | "header", ids: string[]) => void;
  /** Change-detection baseline per QUALIFIED ticket key
   *  (`<origin>|<KEY>`, lib/jira-sites.ts). `unseen` drives the rail
   *  highlight and survives restarts; a key with no entry notifies nothing on
   *  its first poll (baseline write, storm-proof). */
  jiraTicketSnapshots: Record<string, JiraTicketSnapshot>;
  setJiraTicketSnapshot: (key: string, snap: JiraTicketSnapshot) => void;
  markJiraTicketSeen: (key: string) => void;
  pruneJiraTicketSnapshots: (keep: string[]) => void;
  /** Per-element visibility for the ticket pane header's live-Jira segment.
   *  Defaults: status/summary/myTickets on, assignee off (least value per
   *  pixel — the summary usually implies the owner context). */
  jiraHeaderShow: JiraHeaderShow;
  setJiraHeaderShow: (patch: Partial<JiraHeaderShow>) => void;
  projectsDir: string;
  defaultClaudeMdPath: string;
  defaultAgentsMdPath: string;
  defaultGeminiMdPath: string;
  /** Template copied into a Jira project's source folder as CLAUDE.md (skipped
   *  when the folder already has one). Separate from defaultClaudeMdPath —
   *  Jira work wants different guidelines than fresh projects. */
  defaultJiraClaudeMdPath: string;
  defaultUseSingleSourcePointers: boolean;
  customScaffolds: CustomScaffold[];
  setProjectsDir: (value: string) => void;
  setDefaultClaudeMdPath: (value: string) => void;
  setDefaultJiraClaudeMdPath: (value: string) => void;
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
  /** Tab "AI working" badge: true = detect from the CLI's live status line
   *  (stream markers + bursts), false = byte-rate bursts with hysteresis. */
  aiWorkingMarkerDetection: boolean;
  setAiWorkingMarkerDetection: (value: boolean) => void;
  projectColors: Record<string, ProjectColorId>;
  statuslineToggles: Partial<Record<TerminalType, Record<string, boolean>>>;
  setStatuslineToggle: (cliType: TerminalType, key: string, value: boolean) => void;
  setProjectColor: (workingDir: string, colorId: ProjectColorId) => void;
  addRecentProject: (entry: { path: string; name: string; template?: RecentProjectTemplate; serverCommand?: string; noDevServer?: boolean; serverId?: string; isJira?: boolean; jiraSiteId?: string }) => void;
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
  setProjectServerCommands: (path: string, serverId: string | undefined, commands: string[], primary?: string) => void;
  setPrimaryServerCommand: (path: string, serverId: string | undefined, command: string | undefined) => void;
  /** Remember (or, with `port: undefined`, forget) the port one dev-server
   *  command lands on. See `RecentProject.serverPorts`. */
  setProjectServerPort: (path: string, serverId: string | undefined, command: string, port: number | undefined) => void;
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
  devServerTabIcon: "active" as DevServerTabIconMode,
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
  notifEnabled: true,
  setNotifEnabled: (value) => set({ notifEnabled: value }),
  notifAutoDismiss: false,
  setNotifAutoDismiss: (value) => set({ notifAutoDismiss: value }),
  notifAutoDismissSeconds: 30,
  setNotifAutoDismissSeconds: (value) => set({ notifAutoDismissSeconds: value }),
  notifAutoSwitchMinimized: false,
  setNotifAutoSwitchMinimized: (value) => set({ notifAutoSwitchMinimized: value }),
  notifSystemMinimized: true,
  setNotifSystemMinimized: (value) => set({ notifSystemMinimized: value }),
  notifOsPopupsEnabled: true,
  setNotifOsPopupsEnabled: (value) => set({ notifOsPopupsEnabled: value }),
  notifSoundEnabled: true,
  setNotifSoundEnabled: (value) => set({ notifSoundEnabled: value }),
  notifSoundVolume: 50,
  setNotifSoundVolume: (value) => set({ notifSoundVolume: value }),
  geminiNotifSeeded: false,
  setGeminiNotifSeeded: (value) => set({ geminiNotifSeeded: value }),
  projectSounds: {},
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
  jiraSites: [],
  addJiraSite: (raw) =>
    set((state) => {
      const origin = normalizeJiraBaseUrl(raw).trim();
      if (!origin) return {};
      const sites = state.jiraSites ?? [];
      if (sites.includes(origin)) return {};
      return {
        jiraSites: [...sites, origin],
        jiraDefaultSiteId: state.jiraDefaultSiteId || origin,
      };
    }),
  removeJiraSite: (siteId) =>
    set((state) => {
      const sites = (state.jiraSites ?? []).filter((s) => s !== siteId);
      return {
        jiraSites: sites,
        jiraDefaultSiteId:
          state.jiraDefaultSiteId === siteId ? (sites[0] ?? "") : state.jiraDefaultSiteId,
      };
    }),
  jiraDefaultSiteId: "",
  setJiraDefaultSite: (siteId) => set({ jiraDefaultSiteId: siteId }),
  setProjectJiraSite: (path, serverId, siteId) => {
    const normalized = normalizePath(path);
    set((state) => ({
      recentProjects: state.recentProjects.map((p) =>
        normalizePath(p.path) === normalized && p.serverId === serverId
          ? { ...p, jiraSiteId: siteId }
          : p,
      ),
    }));
  },
  jiraPromptTemplate: DEFAULT_JIRA_PROMPT,
  setJiraPromptTemplate: (value) => set({ jiraPromptTemplate: value }),
  jiraReplyInSwedish: false,
  setJiraReplyInSwedish: (value) => set({ jiraReplyInSwedish: value }),
  jiraReplyInEnglish: false,
  setJiraReplyInEnglish: (value) => set({ jiraReplyInEnglish: value }),
  jiraClaudeSide: "left",
  setJiraClaudeSide: (value) => set({ jiraClaudeSide: value }),
  jiraClaudeModel: null,
  setJiraClaudeModel: (value) => set({ jiraClaudeModel: value }),
  jiraCli: "claude",
  setJiraCli: (value) => set({ jiraCli: value }),
  jiraCodexModel: null,
  setJiraCodexModel: (value) => set({ jiraCodexModel: value }),
  jiraGeminiModel: null,
  setJiraGeminiModel: (value) => set({ jiraGeminiModel: value }),
  jiraMode: true,
  setJiraMode: (value) => set({ jiraMode: value }),
  jiraTicketColors: {},
  setJiraTicketColor: (ticket, colorId) =>
    set((state) => {
      const next = { ...(state.jiraTicketColors ?? {}) };
      if (colorId === null) delete next[ticket];
      else next[ticket] = colorId;
      return { jiraTicketColors: next };
    }),
  jiraRowFullColor: false,
  setJiraRowFullColor: (value) => set({ jiraRowFullColor: value }),
  jiraSubticketMode: "default",
  setJiraSubticketMode: (value) => set({ jiraSubticketMode: value }),
  jiraStackCollapsed: {},
  toggleJiraStackCollapsed: (tabId, instKey) =>
    set((state) => {
      const key = `${tabId}:${instKey}`;
      const next = { ...(state.jiraStackCollapsed ?? {}) };
      if (next[key]) delete next[key];
      else next[key] = true;
      return { jiraStackCollapsed: next };
    }),
  jiraStackSizes: {},
  setJiraStackSizes: (tabId, ticket, sizes) =>
    set((state) => ({
      jiraStackSizes: { ...(state.jiraStackSizes ?? {}), [`${tabId}:${ticket}`]: sizes },
    })),
  jiraDetectPastedTickets: true,
  setJiraDetectPastedTickets: (value) => set({ jiraDetectPastedTickets: value }),
  jiraAutoSwitchToDetected: "auto",
  setJiraAutoSwitchToDetected: (value) => set({ jiraAutoSwitchToDetected: value }),
  jiraArchivedTicketAction: "resume",
  setJiraArchivedTicketAction: (value) => set({ jiraArchivedTicketAction: value }),
  jiraApiEmail: "",
  setJiraApiEmail: (value) => set({ jiraApiEmail: value }),
  jiraApiToken: "",
  setJiraApiToken: (value) => set({ jiraApiToken: value }),
  jiraMyAccountId: "",
  setJiraMyAccountId: (value) => set({ jiraMyAccountId: value }),
  jiraNotifEnabled: true,
  setJiraNotifEnabled: (value) => set({ jiraNotifEnabled: value }),
  jiraAssignedMode: false,
  setJiraAssignedMode: (value) => set({ jiraAssignedMode: value }),
  jiraAssignedTickets: [],
  setJiraAssignedTicketsForSite: (siteId, value) =>
    set((state) => ({
      jiraAssignedTickets: [
        ...(state.jiraAssignedTickets ?? []).filter((t) => t.siteId !== siteId),
        ...value,
      ].sort((a, b) => (a.updatedIso < b.updatedIso ? 1 : -1)),
    })),
  jiraUnassignedMode: true,
  setJiraUnassignedMode: (value) => set({ jiraUnassignedMode: value }),
  jiraUnassignedTickets: [],
  // Canonical persisted order is created-desc; the user's own sort is applied
  // at render (and, authoritatively, in the JQL) rather than at write time, so
  // changing the sort control never needs a re-poll to take visible effect.
  setJiraUnassignedTicketsForSite: (siteId, value) =>
    set((state) => ({
      jiraUnassignedTickets: [
        ...(state.jiraUnassignedTickets ?? []).filter((t) => t.siteId !== siteId),
        ...value,
      ].sort((a, b) => ((a.createdIso ?? "") < (b.createdIso ?? "") ? 1 : -1)),
    })),
  jiraAssignedDoneTickets: [],
  setJiraAssignedDoneTicketsForSite: (siteId, value) =>
    set((state) => ({
      jiraAssignedDoneTickets: [
        ...(state.jiraAssignedDoneTickets ?? []).filter((t) => t.siteId !== siteId),
        ...value,
      ].sort((a, b) => (a.updatedIso < b.updatedIso ? 1 : -1)),
    })),
  jiraUnassignedProjects: {},
  setJiraUnassignedProjects: (siteId, keys) =>
    set((state) => ({
      jiraUnassignedProjects: { ...(state.jiraUnassignedProjects ?? {}), [siteId]: keys },
    })),
  jiraUnassignedNotify: true,
  setJiraUnassignedNotify: (value) => set({ jiraUnassignedNotify: value }),
  jiraUnassignedSeen: [],
  markJiraUnassignedSeen: (qkeys) =>
    set((state) => {
      const cur = state.jiraUnassignedSeen ?? [];
      const add = qkeys.filter((k) => !cur.includes(k));
      if (add.length === 0) return {};
      // Newest last, oldest trimmed. 500 is far above any real queue, and the
      // trim is what stops a long-lived store growing without bound.
      return { jiraUnassignedSeen: [...cur, ...add].slice(-500) };
    }),
  jiraRailWidths: DEFAULT_JIRA_RAIL_WIDTHS,
  // Clamp in the SETTER, not at the read sites: a hand-edited persisted blob
  // must not be able to make the rail unusable (layoutSlice's convention).
  setJiraRailWidth: (which, px) =>
    set((state) => ({
      jiraRailWidths: {
        ...DEFAULT_JIRA_RAIL_WIDTHS,
        ...(state.jiraRailWidths ?? {}),
        [which]: Math.min(JIRA_RAIL_MAX_WIDTH, Math.max(JIRA_RAIL_MIN_WIDTH, Math.round(px))),
      },
    })),
  jiraStatusIndicator: "both",
  setJiraStatusIndicator: (value) => set({ jiraStatusIndicator: value }),
  jiraListGrouping: "flat",
  setJiraListGrouping: (value) => set({ jiraListGrouping: value }),
  jiraListSort: DEFAULT_JIRA_SORT,
  // Nested object + a shallow persist merge means a persisted value wins
  // wholesale, so defaults are re-applied HERE rather than trusting the blob
  // to carry every list (same shape as setJiraHeaderShow below).
  setJiraListSort: (list, patch) =>
    set((state) => ({
      jiraListSort: {
        ...DEFAULT_JIRA_SORT,
        ...(state.jiraListSort ?? {}),
        [list]: {
          ...DEFAULT_JIRA_SORT[list],
          ...(state.jiraListSort?.[list] ?? {}),
          ...patch,
        },
      },
    })),
  jiraRowMetaShow: DEFAULT_JIRA_ROW_META_SHOW,
  setJiraRowMetaShow: (patch) =>
    set((state) => ({
      jiraRowMetaShow: {
        ...DEFAULT_JIRA_ROW_META_SHOW,
        ...(state.jiraRowMetaShow ?? {}),
        ...patch,
      },
    })),
  jiraStatusColorMode: "auto",
  setJiraStatusColorMode: (value) => set({ jiraStatusColorMode: value }),
  jiraStatusColors: {},
  setJiraStatusColor: (status, hex) =>
    set((state) => {
      const next = { ...(state.jiraStatusColors ?? {}) };
      // null = "back to automatic". Delete rather than store a sentinel, so
      // the map only ever holds colours the user actually chose.
      if (hex === null) delete next[status];
      else next[status] = hex;
      return { jiraStatusColors: next };
    }),
  jiraSiteFields: {},
  setJiraSiteFields: (siteId, fields) =>
    set((state) => ({
      jiraSiteFields: { ...(state.jiraSiteFields ?? {}), [siteId]: fields },
    })),
  jiraSitePriorities: {},
  setJiraSitePriorities: (siteId, names) =>
    set((state) => ({
      jiraSitePriorities: { ...(state.jiraSitePriorities ?? {}), [siteId]: names },
    })),
  jiraExtraFields: { rows: [], header: [] },
  setJiraExtraFields: (where, ids) =>
    set((state) => ({
      jiraExtraFields: {
        rows: state.jiraExtraFields?.rows ?? [],
        header: state.jiraExtraFields?.header ?? [],
        [where]: ids,
      },
    })),
  jiraTicketSnapshots: {},
  setJiraTicketSnapshot: (key, snap) =>
    set((state) => ({
      jiraTicketSnapshots: { ...(state.jiraTicketSnapshots ?? {}), [key]: snap },
    })),
  markJiraTicketSeen: (key) =>
    set((state) => {
      const cur = (state.jiraTicketSnapshots ?? {})[key];
      if (!cur?.unseen) return {};
      return {
        jiraTicketSnapshots: {
          ...state.jiraTicketSnapshots,
          [key]: { ...cur, unseen: false },
        },
      };
    }),
  pruneJiraTicketSnapshots: (keep) =>
    set((state) => {
      const cur = state.jiraTicketSnapshots ?? {};
      const keepSet = new Set(keep);
      const stale = Object.keys(cur).filter((k) => !keepSet.has(k));
      if (stale.length === 0) return {};
      const next = { ...cur };
      for (const k of stale) delete next[k];
      return { jiraTicketSnapshots: next };
    }),
  jiraHeaderShow: DEFAULT_JIRA_HEADER_SHOW,
  setJiraHeaderShow: (patch) =>
    set((state) => ({
      jiraHeaderShow: {
        // Defaults re-applied here, not just spread from the blob: a store
        // written before these keys existed would otherwise leave the new
        // ones undefined and every `!== false` read would silently flip on.
        ...DEFAULT_JIRA_HEADER_SHOW,
        ...(state.jiraHeaderShow ?? {}),
        ...patch,
      },
    })),
  jiraAcronyms: [],
  jiraAcronymCounts: {},
  addJiraAcronym: (acronym) =>
    set((state) => ({
      jiraAcronyms: [acronym, ...(state.jiraAcronyms ?? []).filter((a) => a !== acronym)].slice(0, 12),
      jiraAcronymCounts: {
        ...(state.jiraAcronymCounts ?? {}),
        [acronym]: ((state.jiraAcronymCounts ?? {})[acronym] ?? 0) + 1,
      },
    })),
  projectsDir: "",
  defaultClaudeMdPath: "",
  defaultAgentsMdPath: "",
  defaultGeminiMdPath: "",
  defaultJiraClaudeMdPath: "",
  defaultUseSingleSourcePointers: false,
  customScaffolds: [],
  setProjectsDir: (value) => set({ projectsDir: value }),
  setDefaultClaudeMdPath: (value) => set({ defaultClaudeMdPath: value }),
  setDefaultJiraClaudeMdPath: (value) => set({ defaultJiraClaudeMdPath: value }),
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
  aiWorkingMarkerDetection: false,
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

  setProjectSound: (workingDir, soundId) => {
    const key = normalizePath(workingDir);
    set((state) => ({
      projectSounds: { ...state.projectSounds, [key]: soundId },
    }));
  },

  addRecentProject: ({ path, name, template, serverCommand, noDevServer, serverId, isJira, jiraSiteId }) => {
    const normalized = normalizePath(path);
    const matches = (p: RecentProject) =>
      normalizePath(p.path) === normalized && p.serverId === serverId;
    set((state) => {
      const existing = state.recentProjects.find(matches);
      const now = Date.now();
      let updated: RecentProject[];
      if (existing) {
        // Update existing: bump timestamp, count, template, serverCommand
        updated = state.recentProjects.map((p) => {
          if (!matches(p)) return p;
          // serverCommand names the PRIMARY command only. Any additional
          // commands the project has (second dev server) survive untouched —
          // overwriting the whole list here would silently delete the extra
          // rows every time the project is reopened.
          const nextCommand = noDevServer ? undefined : (serverCommand ?? p.serverCommand);
          const rest = (p.serverCommands ?? []).filter(
            (c) => c !== nextCommand && c !== p.serverCommand,
          );
          return {
            ...p,
            lastOpenedAt: now,
            openCount: p.openCount + 1,
            lastTemplate: template ?? p.lastTemplate,
            name,
            serverCommand: nextCommand,
            serverCommands: nextCommand ? [nextCommand, ...rest] : undefined,
            noDevServer: noDevServer ?? p.noDevServer,
            isJira: isJira ?? p.isJira,
            jiraSiteId: jiraSiteId ?? p.jiraSiteId,
          };
        });
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
          serverCommands: noDevServer || !serverCommand ? undefined : [serverCommand],
          noDevServer,
          serverId,
          preferredBackend,
          isJira,
          jiraSiteId,
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

  setDevServerTabIcon: (value) => {
    set({ devServerTabIcon: value });
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
  setAiWorkingMarkerDetection: (value) => {
    set({ aiWorkingMarkerDetection: value });
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

  /**
   * The single writer for a project's dev-server commands. `commands` is the
   * complete list, in row order — callers recompute it from the live rows
   * rather than patching one slot (see `syncProjectServerCommands`), so this
   * only has to mirror `[0]` into the legacy `serverCommand` field and keep
   * the quick-open pointer honest.
   */
  setProjectServerCommands: (path, serverId, commands, primary) => {
    const normalized = normalizePath(path);
    set((state) => ({
      recentProjects: state.recentProjects.map((p) => {
        if (normalizePath(p.path) !== normalized || p.serverId !== serverId) return p;
        // A pointer at a command that is no longer in the list is dropped, not
        // kept: the fallback (first running row, then first row) always names
        // a live server, a dangling string never would.
        const nextPrimary = primary ?? p.primaryServerCommand;
        // Same rule for the remembered ports: an edited or removed command
        // leaves a key nothing will ever read again, and keeping it would send
        // a future command that happens to reuse the string to a stale port.
        const ports = p.serverPorts
          ? Object.fromEntries(Object.entries(p.serverPorts).filter(([cmd]) => commands.includes(cmd)))
          : undefined;
        return {
          ...p,
          serverCommands: commands.length > 0 ? commands : undefined,
          serverCommand: commands[0],
          serverPorts: ports && Object.keys(ports).length > 0 ? ports : undefined,
          primaryServerCommand:
            nextPrimary && commands.includes(nextPrimary) ? nextPrimary : undefined,
        };
      }),
    }));
  },

  setProjectServerPort: (path, serverId, command, port) => {
    const normalized = normalizePath(path);
    set((state) => ({
      recentProjects: state.recentProjects.map((p) => {
        if (normalizePath(p.path) !== normalized || p.serverId !== serverId) return p;
        const next = { ...(p.serverPorts ?? {}) };
        if (port === undefined) delete next[command];
        else next[command] = port;
        return { ...p, serverPorts: Object.keys(next).length > 0 ? next : undefined };
      }),
    }));
  },

  setPrimaryServerCommand: (path, serverId, command) => {
    const normalized = normalizePath(path);
    set((state) => ({
      recentProjects: state.recentProjects.map((p) =>
        normalizePath(p.path) === normalized && p.serverId === serverId
          ? { ...p, primaryServerCommand: command }
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
