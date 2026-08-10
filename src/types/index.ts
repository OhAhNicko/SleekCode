export type TerminalType = "claude" | "codex" | "gemini" | "shell" | "devserver";
export type GameType = "snake" | "2048" | "sudoku" | "crossword" | "minesweeper" | "wordle" | "ticTacToe" | "blockBreaker" | "solitaire" | "pong" | "chess" | "memory" | "flappyBird" | "spaceInvaders" | "tetris" | "asteroids" | "frogger" | "duckHunt" | "donkeyKong";
export type TerminalBackend = "wsl" | "windows" | "native" | "ssh";
/** Which terminal implementation draws a pane: the classic xterm.js pane or
 * the native (wgpu) one. Unrelated to TerminalBackend, which is about *where*
 * the PTY runs. */
export type TerminalRenderer = "native" | "xterm";

export type AuthMethod = "ssh-key" | "password";

/** How Claude Code stays signed in on a remote server. "keychain" (preferred,
 * macOS servers): unlock the login keychain in-session on every SSH login.
 * "token": export a long-lived CLAUDE_CODE_OAUTH_TOKEN instead. */
export type ClaudeRemoteAuth = "keychain" | "token";

export interface RemoteServer {
  id: string;
  name: string;
  host: string;
  username: string;
  authMethod: AuthMethod;
  sshKeyPath?: string;
  // Long-lived Claude OAuth token (`claude setup-token`). Used only when
  // claudeAuth is "token": exported as CLAUDE_CODE_OAUTH_TOKEN into remote
  // sessions so Claude Code stays logged in over SSH without the Keychain.
  claudeOauthToken?: string;
  // Absent = "keychain" (the store migration stamps it on load).
  claudeAuth?: ClaudeRemoteAuth;
  /** Absolute path on the server under which new remote projects are created
   * (e.g. /Users/me/projects). Optional — the create modal asks when unset. */
  projectsDir?: string;
  /** Probed shell/CLI facts (src/lib/remote-cli-shells.ts). Panes exec CLIs
   * through the shell that can actually resolve them; refreshed by Test
   * Connection. Absent = never probed. */
  detectedCliShells?: RemoteCliShells;
  /** Folders this server reaches over a share that are really folders on THIS
   * machine (src/lib/knowledge/remote-mirror.ts). Absent = none linked. */
  mounts?: RemoteMount[];
}

/**
 * A proven remote↔local folder correspondence.
 *
 * The server sees `remotePrefix` over a network share; the same bytes live at
 * `localPrefix` on the machine running MADE. That makes NexusMind work on an
 * SSH tab: the database and the watcher are already on the right machine, and
 * only the path needs translating.
 *
 * Only ever created by a passing probe or by an explicit manual entry —
 * a guessed mapping would attach one project's memory to a different project.
 * Direction matters: this describes a folder MADE owns and the server borrows,
 * never the reverse (a WAL database over a share is the "database is locked"
 * case `knowledge/mod.rs` keeps the DB out of the project to avoid).
 */
export interface RemoteMount {
  /** POSIX prefix on the server, no trailing slash. "/Volumes/projects" */
  remotePrefix: string;
  /** The same folder locally. "C:\\Users\\me\\Documents\\projects" */
  localPrefix: string;
  /** epoch-ms of the last passing probe. Never 0 — unproven is never stored. */
  verifiedAt: number;
  /** "probe" = the nonce round-trip passed; "manual" = typed in Settings. */
  source: "probe" | "manual";
}

/** Which shells a remote server has and which shell resolves each AI CLI. */
export interface RemoteCliShells {
  /** Login shell basename, e.g. "zsh". */
  defaultShell?: string;
  /** Shells present on the server, probe order (zsh, bash, fish). */
  shells: string[];
  /** CLI → shell whose interactive-login env resolves it. */
  cli: Partial<Record<"claude" | "codex" | "gemini", string>>;
  detectedAt: number;
}

export interface TerminalConfig {
  command: string;
  args: string[];
  label: string;
  description: string;
}

export interface TerminalInstance {
  id: string;
  type: TerminalType;
  pid?: number;
  workingDir: string;
  isActive: boolean;
  serverId?: string;
}

export interface DevServer {
  id: string;
  terminalId: string;
  tabId: string;
  projectName: string;
  command: string;
  workingDir: string;
  port: number;
  status: "starting" | "running" | "stopped" | "error";
  errorMessage?: string;
  /**
   * The port a "port is already in use" failure named. Its presence is what
   * turns the row's red banner into something actionable — "Another port" and
   * "Kill <port>" — instead of a dead end the user has to leave the app to fix.
   *
   * Written only by `updateDevServerError`, alongside the message, so a
   * conflict port with no error (or an error whose conflict port belongs to the
   * previous failure) is unrepresentable.
   */
  conflictPort?: number;
  /** When set, the dev server PTY is spawned via SSH against this RemoteServer. */
  serverId?: string;
  /** Additional non-local addresses parsed from server output (e.g. LAN / Tailscale IPs). */
  networkUrls?: string[];
  /**
   * Resolved spawn backend for this server's PTY. `undefined` means "still
   * resolving" — DevServerTerminalHost waits for it before mounting the pane so
   * we never spawn a throwaway WSL shell first. "windows" → real PowerShell
   * pane (Tauri projects, or a user override) so `npm run tauri:dev` uses the
   * Windows toolchain instead of failing inside WSL bash.
   */
  backend?: TerminalBackend;
  /**
   * Epoch ms of the last PTY byte before the launch went silent. Set by
   * DevServerTerminalHost's stall sweep while status is "starting"; cleared the
   * moment any output arrives. A wedged launch (e.g. the WSL→PowerShell interop
   * hop never printing) is indistinguishable from a long compile without this —
   * the 2026-08-07 frozen `tauri:dev` report.
   */
  stalledSince?: number;
}

// Recursive pane layout tree
export type PaneLayout = PaneLeaf | PaneSplit | PaneBrowser | PaneEditor | PaneKanban | PaneCodeReview | PaneFileViewer | PaneGame;

export interface PaneLeaf {
  type: "terminal";
  id: string;
  terminalId: string;
  terminalType?: TerminalType;
  sessionResumeId?: string;
  /** Per-pane renderer choice. Absent => follow the global
   * `useNativeTerminalRenderer` setting. Persisted with the layout, so a pane
   * opened as native comes back native. See TerminalPane.tsx for precedence. */
  renderer?: TerminalRenderer;
}

export interface ProjectSession {
  id: string;          // session resume ID (UUID)
  name: string;        // user-given name or auto-detected from CLI
  type: TerminalType;  // claude | codex | gemini
  createdAt: number;
  isRenamed: boolean;   // true = user manually renamed, prevents auto-name override
  /** Jira ticket key (`SUPPORT-24920`) when this session was opened from a Jira
   *  project. Its presence is what makes the session a ticket row in the rail —
   *  an ordinary Claude session in the same repo has none and never shows up
   *  there. `name` mirrors it, so the pane header shows the key for free. */
  ticket?: string;
  /** Jira: which duplicate of the ticket this session is. Absent/1 = the
   *  original; 2+ = duplicates ("SUPPORT-24920 #2"). Duplicates group under
   *  the original in the rail and share its browser pane. */
  ticketInstance?: number;
  /** Jira: the CLI-side session title (sessions-index `customTitle`) as of the
   *  last sync. Rail names adopt a CLI title only when it CHANGED since this
   *  snapshot — so a rename made in MADE is never clobbered by the stale CLI
   *  title it hasn't received yet (it flows to the CLI via `--name` on the
   *  pane's next launch). */
  cliTitle?: string;
  /** Jira: archived tickets live grayed-out in their own rail section and
   *  can't be opened from there until unarchived. */
  archived?: boolean;
}

/** Entry from Claude CLI's sessions-index.json */
export interface SessionIndexEntry {
  sessionId: string;
  summary: string;
  customTitle: string;
  firstPrompt: string;
  messageCount: number;
  created: string;   // ISO datetime
  modified: string;  // ISO datetime
  gitBranch: string;
  isSidechain: boolean;
}

export interface PaneBrowser {
  type: "browser";
  id: string;
  url: string;
  /** When set, the browser pane displays the live dev-server URL of this tab.
   *  While the dev server isn't running yet (port=0 or status!="running"), the
   *  pane shows a "Waiting for dev server" placeholder and only loads the iframe
   *  once the URL is reachable. Avoids "can't reach page" race on app boot. */
  linkedTabId?: string;
}

export interface PaneEditor {
  type: "editor";
  id: string;
  filePath: string;
  language?: string;
  /** When set, file I/O routes through ssh_read_file / ssh_write_file against this RemoteServer. */
  serverId?: string;
}

export interface PaneSplit {
  type: "split";
  id: string;
  direction: "horizontal" | "vertical";
  children: [PaneLayout, PaneLayout];
  sizes?: [number, number];
}

export interface PaneKanban {
  type: "kanban";
  id: string;
  vertical?: boolean;
}

export interface PaneCodeReview {
  type: "codereview";
  id: string;
}

export interface PaneFileViewer {
  type: "fileviewer";
  id: string;
  files: string[];
  activeFile: string;
}

export interface PaneGame {
  type: "game";
  id: string;
  game?: GameType; // undefined = show game selector
  startPaused?: boolean;
}

export interface CrosswordClue {
  number: number;
  clue: string;
  answer: string;
  row: number;
  col: number;
}

export interface CrosswordPuzzle {
  id: string;
  grid: string[][]; // '#' = black cell, letter = white cell
  clues: {
    across: CrosswordClue[];
    down: CrosswordClue[];
  };
}

export interface Tab {
  id: string;
  name: string;
  workingDir: string;
  layout: PaneLayout | null;
  isDevServerTab?: boolean;
  isServersTab?: boolean;
  isKanbanTab?: boolean;
  isSettingsTab?: boolean;
  /** Jira project: an ORDINARY project tab (real workingDir, real layout,
   *  normal restore) that additionally shows the ticket rail and keeps a
   *  browser pinned right. Deliberately not a system tab like the four above —
   *  those are fixed-id singletons without a workingDir, and are filtered out
   *  of the project render path, which is the opposite of what this needs. */
  isJiraProject?: boolean;
  /** Jira project: which ticket's pane pair the canvas currently shows. */
  selectedJiraTicket?: string;
  /** Jira project: the site this tab's tickets live on (normalized origin —
   *  the site ID). Absent on legacy tabs → siteForTab falls back to the
   *  project's site, then the default site. One site per tab by design. */
  jiraSiteId?: string;
  isPinned?: boolean;
  customName?: string;
  serverId?: string;
  serverCommand?: string;
  /** Terminal backend stamped at tab creation time. Determines WSL vs Windows for all panes in this tab. */
  backend?: TerminalBackend;
  /** Hibernated: layout (incl. sessionResumeIds) is kept but the terminals are
   *  removed and their PTYs killed, freeing the WSL processes. Waking (tab
   *  activation) respawns the layout — Claude panes via `--resume`. Persisted,
   *  so a tab hibernated at quit stays asleep across app restarts. */
  isHibernated?: boolean;
  hibernatedAt?: number;
}

export interface TaskCard {
  id: string;
  title: string;
  description: string;
  status: "todo" | "in_progress" | "done";
  agentType?: TerminalType;
  command?: string;
  terminalId?: string;
  createdAt: number;
  order: number;
}

export interface FileEntry {
  name: string;
  path: string;
  is_directory: boolean;
  size: number;
}

export interface SearchResult {
  file_path: string;
  file_name: string;
  line_number: number;
  line_content: string;
}

export type SidebarTab = "files" | "remote-files" | "search" | "terminals" | "knowledge";

/** Visual placement of a pane: in the grid, full-screen overlay, or free-floating window. */
export type PaneMode = "grid" | "expanded" | "float";

/** Position + size of a floating pane in viewport coordinates. */
export interface FloatRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AppState {
  tabs: Tab[];
  activeTabId: string;
  terminals: Record<string, TerminalInstance>;
  devServers: DevServer[];
}

export type ComparisonMode = "uncommitted" | "vs-main" | "vs-branch";

export interface GitFileStatus {
  path: string;
  status: string;
  oldPath?: string;
}

export interface GitBranchInfo {
  current: string;
  branches: string[];
}

export interface GitDiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
  rawPatch: string;
}

export interface DiffLine {
  type: "add" | "remove" | "context";
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface FileDiff {
  filePath: string;
  status: string;
  hunks: DiffHunk[];
  rawDiff: string;
}

export type CommitMsgMode = "empty" | "simple" | "advanced";
export type ShadowAiCli = "claude" | "codex";
export type ComposerExpansion = "up" | "down" | "scroll";

export interface GitAheadBehind {
  ahead: number;
  behind: number;
  hasRemote: boolean;
}

/** Everything the git status bar needs, from ONE `git_overview` invoke. */
export interface GitOverview {
  isRepo: boolean;
  current: string;
  branches: string[];
  filesChanged: number;
  insertions: number;
  deletions: number;
  ahead: number;
  behind: number;
  hasRemote: boolean;
}
