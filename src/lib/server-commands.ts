import { useAppStore } from "../store";

export const BUILTIN_SERVER_COMMANDS = [
  "npm run dev",
  "npm start",
  "npm run tauri:dev",
  "yarn dev",
  "pnpm dev",
];

/**
 * Strip any existing --port / -p flag from a command, then append the new port.
 * Works with npm/yarn/pnpm scripts (adds `-- --port`) and direct CLI commands (adds `--port`).
 */
export function injectPort(command: string, port: number): string {
  // Remove existing --port/-p flags (with or without =)
  let cleaned = command
    .replace(/\s+--port(?:\s+\d+|=\d+)/g, "")
    .replace(/\s+-p(?:\s+\d+|=\d+)/g, "")
    .replace(/\s+--\s+--port(?:\s+\d+|=\d+)/g, "")
    .replace(/\s+--\s+-p(?:\s+\d+|=\d+)/g, "")
    .trim();

  // npm/yarn/pnpm script commands need `-- --port` to forward the flag
  const isScriptCmd = /^(?:npm|yarn|pnpm)\s+(?:run\s+)?\w+/.test(cleaned);
  // Check if there's already a `--` separator
  const hasSeparator = /\s+--(?:\s|$)/.test(cleaned);

  if (isScriptCmd && !hasSeparator) {
    return `${cleaned} -- --port ${port}`;
  }
  return `${cleaned} --port ${port}`;
}

/**
 * Returns a merged + sorted list of server command suggestions.
 * Order: recently used (from recentProjects) first, then custom, then built-in.
 * Each entry includes whether it's user-added (removable).
 */
export function getServerCommandSuggestions(filter?: string): Array<{ command: string; isCustom: boolean }> {
  const state = useAppStore.getState();
  const customCommands = state.customServerCommands ?? [];

  // Collect recently used commands from projects, ordered by lastOpenedAt desc
  const recentCommands: string[] = [];
  for (const p of state.recentProjects) {
    if (p.serverCommand && !recentCommands.includes(p.serverCommand)) {
      recentCommands.push(p.serverCommand);
    }
  }

  const seen = new Set<string>();
  const result: Array<{ command: string; isCustom: boolean }> = [];

  // Recently used first
  for (const cmd of recentCommands) {
    if (seen.has(cmd)) continue;
    seen.add(cmd);
    result.push({ command: cmd, isCustom: customCommands.includes(cmd) });
  }

  // Custom commands
  for (const cmd of customCommands) {
    if (seen.has(cmd)) continue;
    seen.add(cmd);
    result.push({ command: cmd, isCustom: true });
  }

  // Built-in commands
  for (const cmd of BUILTIN_SERVER_COMMANDS) {
    if (seen.has(cmd)) continue;
    seen.add(cmd);
    result.push({ command: cmd, isCustom: false });
  }

  if (filter) {
    const lower = filter.toLowerCase();
    return result.filter((s) => s.command.toLowerCase().includes(lower));
  }

  return result;
}
