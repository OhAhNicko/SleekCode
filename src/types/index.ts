export type TerminalType = "claude" | "codex" | "gemini" | "shell" | "devserver";
export type GameType = "snake" | "2048" | "sudoku" | "crossword" | "minesweeper" | "wordle" | "ticTacToe" | "blockBreaker" | "solitaire" | "pong" | "chess" | "memory" | "flappyBird" | "spaceInvaders" | "tetris" | "asteroids" | "frogger" | "duckHunt" | "donkeyKong";
export type TerminalBackend = "wsl" | "windows" | "native";

export type AuthMethod = "ssh-key" | "password";

export interface RemoteServer {
  id: string;
  name: string;
  host: string;
  username: string;
  authMethod: AuthMethod;
  sshKeyPath?: string;
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
}

// Recursive pane layout tree
export type PaneLayout = PaneLeaf | PaneSplit | PaneBrowser | PaneEditor | PaneKanban | PaneCodeReview | PaneFileViewer | PaneGame;

export interface PaneLeaf {
  type: "terminal";
  id: string;
  terminalId: string;
  terminalType?: TerminalType;
  sessionResumeId?: string;
}

export interface ProjectSession {
  id: string;          // session resume ID (UUID)
  name: string;        // user-given name or auto-detected from CLI
  type: TerminalType;  // claude | codex | gemini
  createdAt: number;
  isRenamed: boolean;   // true = user manually renamed, prevents auto-name override
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
  isPinned?: boolean;
  customName?: string;
  serverId?: string;
  serverCommand?: string;
  /** Terminal backend stamped at tab creation time. Determines WSL vs Windows for all panes in this tab. */
  backend?: TerminalBackend;
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

export type SidebarTab = "files" | "remote-files" | "search" | "terminals";

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
