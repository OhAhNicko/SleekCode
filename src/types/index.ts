export type TerminalType = "claude" | "codex" | "gemini" | "shell" | "devserver";

export type AuthMethod = "ssh-key" | "password";

export interface RemoteServer {
  id: string;
  name: string;
  localIp: string;
  tailscaleHostname: string;
  username: string;
  authMethod: AuthMethod;
  sshKeyPath?: string;
  defaultDirectory?: string;
  preferTailscale: boolean;
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
export type PaneLayout = PaneLeaf | PaneSplit | PaneBrowser | PaneEditor | PaneKanban | PaneCodeReview | PaneFileViewer;

export interface PaneLeaf {
  type: "terminal";
  id: string;
  terminalId: string;
  terminalType?: TerminalType;
  sessionResumeId?: string;
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

export interface Tab {
  id: string;
  name: string;
  workingDir: string;
  layout: PaneLayout;
  isDevServerTab?: boolean;
  isServersTab?: boolean;
  isKanbanTab?: boolean;
  isPinned?: boolean;
  serverId?: string;
  serverCommand?: string;
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

export type SidebarTab = "files" | "search" | "terminals";

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
