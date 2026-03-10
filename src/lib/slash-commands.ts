import { invoke } from "@tauri-apps/api/core";

export interface SlashCommand {
  name: string;        // actual value inserted into textarea (e.g. "prompts:test")
  label?: string;      // display name shown in popup and used for filtering (e.g. "test")
  description: string;
}

export const SLASH_COMMANDS: Partial<Record<string, SlashCommand[]>> = {
  claude: [
    { name: "add-dir",            description: "Add a new working directory to the current session" },
    { name: "agents",             description: "Manage agent configurations" },
    { name: "chrome",             description: "Configure Claude in Chrome settings" },
    { name: "clear",              description: "Clear conversation history and free up context" },
    { name: "compact",            description: "Compact conversation with optional focus instructions" },
    { name: "config",             description: "Open the Settings interface (Config tab)" },
    { name: "context",            description: "Visualize current context usage as a colored grid" },
    { name: "copy",               description: "Copy the last assistant response to clipboard" },
    { name: "cost",               description: "Show token usage statistics" },
    { name: "desktop",            description: "Continue the current session in the Claude Code Desktop app" },
    { name: "diff",               description: "Open an interactive diff viewer for uncommitted changes and per-turn diffs" },
    { name: "doctor",             description: "Diagnose and verify your Claude Code installation and settings" },
    { name: "exit",               description: "Exit the CLI" },
    { name: "export",             description: "Export the current conversation as plain text" },
    { name: "extra-usage",        description: "Configure extra usage to keep working when rate limits are hit" },
    { name: "fast",               description: "Toggle fast mode on or off" },
    { name: "feedback",           description: "Submit feedback about Claude Code" },
    { name: "fork",               description: "Create a fork of the current conversation at this point" },
    { name: "help",               description: "Show help and available commands" },
    { name: "hooks",              description: "Manage hook configurations for tool events" },
    { name: "ide",                description: "Manage IDE integrations and show status" },
    { name: "init",               description: "Initialize project with CLAUDE.md guide" },
    { name: "insights",           description: "Generate a report analyzing your Claude Code sessions" },
    { name: "install-github-app", description: "Set up the Claude GitHub Actions app for a repository" },
    { name: "install-slack-app",  description: "Install the Claude Slack app via OAuth" },
    { name: "keybindings",        description: "Open or create your keybindings configuration file" },
    { name: "login",              description: "Sign in to your Anthropic account" },
    { name: "logout",             description: "Sign out from your Anthropic account" },
    { name: "mcp",                description: "Manage MCP server connections and OAuth authentication" },
    { name: "memory",             description: "Edit CLAUDE.md files, enable or disable auto-memory" },
    { name: "mobile",             description: "Show QR code to download the Claude mobile app" },
    { name: "model",              description: "Select or change the AI model" },
    { name: "output-style",       description: "Switch between output styles (Default, Explanatory, Learning)" },
    { name: "passes",             description: "Share a free week of Claude Code with friends" },
    { name: "permissions",        description: "View or update tool permissions" },
    { name: "plan",               description: "Enter plan mode directly from the prompt" },
    { name: "plugin",             description: "Manage Claude Code plugins" },
    { name: "pr-comments",        description: "Fetch and display comments from a GitHub pull request" },
    { name: "privacy-settings",   description: "View and update your privacy settings (Pro and Max only)" },
    { name: "release-notes",      description: "View the full changelog" },
    { name: "reload-plugins",     description: "Reload all active plugins without restarting" },
    { name: "remote-control",     description: "Make this session available for remote control from claude.ai" },
    { name: "remote-env",         description: "Configure the default remote environment for teleport sessions" },
    { name: "rename",             description: "Rename the current session" },
    { name: "resume",             description: "Resume a conversation by ID or name, or open the session picker" },
    { name: "review",             description: "Review a pull request for code quality, security, and test coverage" },
    { name: "rewind",             description: "Rewind the conversation and/or code to a previous point" },
    { name: "sandbox",            description: "Toggle sandbox mode" },
    { name: "security-review",    description: "Analyze pending changes on the current branch for security vulnerabilities" },
    { name: "skills",             description: "List available skills" },
    { name: "stats",              description: "Visualize daily usage, session history, streaks, and model preferences" },
    { name: "status",             description: "Open the Settings interface (Status tab) showing version and connectivity" },
    { name: "statusline",         description: "Configure Claude Code's status line" },
    { name: "stickers",           description: "Order Claude Code stickers" },
    { name: "tasks",              description: "List and manage background tasks" },
    { name: "terminal-setup",     description: "Configure terminal keybindings for Shift+Enter and other shortcuts" },
    { name: "theme",              description: "Change the color theme" },
    { name: "upgrade",            description: "Open the upgrade page to switch to a higher plan tier" },
    { name: "usage",              description: "Show plan usage limits and rate limit status" },
    { name: "vim",                description: "Toggle between Vim and Normal editing modes" },
  ],
  codex: [
    { name: "agent",                description: "Switch the active agent thread" },
    { name: "apps",                 description: "Browse apps (connectors) and insert them into your prompt" },
    { name: "clear",                description: "Clear the terminal and start a fresh chat" },
    { name: "compact",              description: "Summarize the visible conversation to free tokens" },
    { name: "copy",                 description: "Copy the latest completed Codex output" },
    { name: "debug-config",         description: "Print config layer and requirements diagnostics" },
    { name: "diff",                 description: "Show the Git diff, including files Git isn't tracking yet" },
    { name: "exit",                 description: "Exit the CLI session" },
    { name: "experimental",         description: "Toggle experimental features" },
    { name: "feedback",             description: "Send logs to the Codex maintainers" },
    { name: "fork",                 description: "Fork the current conversation into a new thread" },
    { name: "init",                 description: "Generate an AGENTS.md scaffold in the current directory" },
    { name: "logout",               description: "Sign out of Codex" },
    { name: "mcp",                  description: "List configured Model Context Protocol (MCP) tools" },
    { name: "mention",              description: "Attach a file to the conversation" },
    { name: "model",                description: "Choose the active model (and reasoning effort, when available)" },
    { name: "new",                  description: "Start a new conversation inside the same CLI session" },
    { name: "permissions",          description: "Set what Codex can do without asking first" },
    { name: "personality",          description: "Choose a communication style for responses" },
    { name: "plan",                 description: "Switch to plan mode and optionally send a prompt" },
    { name: "ps",                   description: "Show experimental background terminals and their recent output" },
    { name: "quit",                 description: "Exit the CLI" },
    { name: "resume",               description: "Resume a saved conversation from your session list" },
    { name: "review",               description: "Ask Codex to review your working tree" },
    { name: "sandbox-add-read-dir", description: "Grant read access to directories on Windows" },
    { name: "status",               description: "Display session configuration and token usage" },
    { name: "statusline",           description: "Configure TUI status-line fields interactively" },
  ],
  gemini: [
    { name: "about",          description: "Show version info; share when filing issues" },
    { name: "auth",           description: "Change the authentication method via a dialog" },
    { name: "bug",            description: "File an issue; text after /bug becomes the issue title" },
    { name: "chat",           description: "Alias for /resume; exposes session browser and checkpoints" },
    { name: "clear",          description: "Clear the terminal screen, session history, and scrollback" },
    { name: "commands",       description: "Manage custom slash commands (reload subcommand for .toml files)" },
    { name: "compress",       description: "Replace the entire chat context with a summary" },
    { name: "copy",           description: "Copy the last output to your clipboard" },
    { name: "directory",      description: "Manage workspace directories (add/show subcommands)" },
    { name: "docs",           description: "Open the Gemini CLI documentation in your browser" },
    { name: "editor",         description: "Open a dialog for selecting supported editors" },
    { name: "extensions",     description: "Manage extensions (install, enable, disable, update)" },
    { name: "help",           description: "Display help information about Gemini CLI" },
    { name: "hooks",          description: "Manage hooks that intercept CLI behavior at lifecycle events" },
    { name: "ide",            description: "Manage IDE integration (status, install, enable, disable)" },
    { name: "init",           description: "Generate a tailored GEMINI.md by analyzing your directory" },
    { name: "mcp",            description: "Manage MCP servers (auth, list, refresh subcommands)" },
    { name: "memory",         description: "Manage GEMINI.md context (add, list, show subcommands)" },
    { name: "model",          description: "Manage model configuration (manage and set subcommands)" },
    { name: "permissions",    description: "Manage folder trust settings and other permissions" },
    { name: "policies",       description: "Manage policies; list subcommand shows active policies by mode" },
    { name: "privacy",        description: "Display privacy notice and opt-in to data collection" },
    { name: "quit",           description: "Exit Gemini CLI" },
    { name: "resume",         description: "Browse previous sessions, manage checkpoints, and resume" },
    { name: "rewind",         description: "Navigate backward through conversation history to review and revert" },
    { name: "settings",       description: "Open the settings editor to view and modify settings" },
    { name: "shells",         description: "Toggle the background shells view for long-running processes" },
    { name: "shortcuts",      description: "Display keyboard shortcuts" },
    { name: "setup-github",   description: "Set up GitHub Actions to triage issues and review PRs" },
    { name: "skills",         description: "Manage Agent Skills (enable, disable, list, reload)" },
    { name: "stats",          description: "Display detailed session statistics with model and tool breakdowns" },
    { name: "terminal-setup", description: "Configure terminal keybindings for multiline input" },
    { name: "theme",          description: "Open a dialog to change the visual theme" },
    { name: "tools",          description: "Display a list of tools currently available in Gemini CLI" },
    { name: "vim",            description: "Toggle vim mode for vim-style navigation in the input area" },
  ],
};

/**
 * Argument placeholder hints shown as ghost text after a command is accepted.
 * Displayed when the textarea value is exactly "/<cmd> " (command + one space, nothing typed yet).
 * Disappears as soon as the user types the first character of the argument.
 */
export const SLASH_ARG_HINTS: Partial<Record<string, Record<string, string>>> = {
  claude: {
    rename: "[name]",
  },
};

// Module-level cache so we only call homeDir() once per app session
let _cachedHomeDir: string | null | undefined = undefined;

async function getHomeDir(): Promise<string | null> {
  if (_cachedHomeDir !== undefined) return _cachedHomeDir;
  try {
    const { homeDir } = await import("@tauri-apps/api/path");
    _cachedHomeDir = await homeDir();
  } catch {
    _cachedHomeDir = null;
  }
  return _cachedHomeDir;
}

interface FileEntry {
  name: string;
  is_directory: boolean;
}

interface CliCustomCommandConfig {
  /** Path relative to ~ for global commands. */
  globalDir: string;
  /** Path relative to project root for project-scoped commands (omit if not supported). */
  projectDir?: string;
  /** Prefix prepended to the filename to form the slash command name, e.g. "prompts:" → /prompts:test */
  namePrefix?: string;
}

const CLI_CUSTOM_COMMANDS: Partial<Record<string, CliCustomCommandConfig>> = {
  claude: { globalDir: ".claude/commands", projectDir: ".claude/commands" },
  codex:  { globalDir: ".codex/prompts",   namePrefix: "prompts:" },
  gemini: { globalDir: ".gemini/commands", projectDir: ".gemini/commands" },
};

/**
 * Dynamically load user-defined custom commands for the given CLI.
 * Scans the global (~/) and optional project-level directories for *.md files.
 * The filename (without .md) becomes the command name, optionally prefixed.
 * The first line of the file is used as the description.
 */
export async function loadUserSkills(terminalType: string, workingDir: string): Promise<SlashCommand[]> {
  const config = CLI_CUSTOM_COMMANDS[terminalType];
  if (!config) return [];

  const home = await getHomeDir();
  const dirs: string[] = [];
  if (home) dirs.push(home + "/" + config.globalDir);
  if (workingDir && config.projectDir) dirs.push(workingDir + "/" + config.projectDir);

  const namePrefix = config.namePrefix ?? "";

  const skills: SlashCommand[] = [];
  const seen = new Set<string>();

  for (const dir of dirs) {
    let entries: FileEntry[];
    try {
      entries = await invoke<FileEntry[]>("list_dir", { path: dir });
    } catch {
      continue; // directory doesn't exist — skip
    }

    for (const entry of entries) {
      if (entry.is_directory || !entry.name.endsWith(".md")) continue;
      const baseName = entry.name.slice(0, -3);
      if (seen.has(baseName)) continue; // project-level takes precedence over global
      seen.add(baseName);

      let description = "Custom command";
      try {
        const content = await invoke<string>("read_file", { path: dir + "/" + entry.name });
        const firstLine = content.split("\n")[0].trim().replace(/^#+\s*/, "");
        if (firstLine) description = firstLine;
      } catch {
        // Use fallback description
      }
      skills.push({
        name: namePrefix + baseName,
        label: namePrefix ? baseName : undefined,
        description,
      });
    }
  }

  return skills;
}
