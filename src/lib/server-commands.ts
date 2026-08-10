import { invoke } from "@tauri-apps/api/core";
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
  const isScriptCmd = SCRIPT_CMD_RE.test(cleaned);
  // Check if there's already a `--` separator
  const hasSeparator = /\s+--(?:\s|$)/.test(cleaned);

  if (isScriptCmd && !hasSeparator) {
    return `${cleaned} -- --port ${port}`;
  }
  return `${cleaned} --port ${port}`;
}

/**
 * How a dev server is told to listen on every interface instead of loopback.
 *
 * There is no universal spelling, which is the whole reason this is detected
 * rather than hardcoded:
 *   vite    — `--host` (bare; binds 0.0.0.0). Covers Vite, Nuxt 3, Astro,
 *             SvelteKit, Remix and anything else built on Vite's dev server.
 *   next    — `-H 0.0.0.0` (Next rejects `--host`).
 *   cra     — `HOST=0.0.0.0` as an env PREFIX; react-scripts has no flag.
 *   angular — `--host 0.0.0.0` (the bare form is not accepted).
 */
export type HostStyle = "vite" | "next" | "cra" | "angular";

/**
 * Every host-flag spelling we might have added, for stripping on un-tick.
 *
 * These deliberately do NOT swallow a preceding `--` separator. `npm run dev --
 * --host --port 3000` must strip to `npm run dev -- --port 3000`: take the
 * separator too and `--port` becomes an argument to npm ITSELF rather than to
 * the script, which silently starts the server on the wrong port. A separator
 * left with nothing after it is cleaned up at the end of `stripHost` instead.
 */
const HOST_FLAG_RE = [
  /\s+--host(?:\s+[\w.:]+|=[\w.:]+)?(?=\s|$)/g,
  /\s+-H(?:\s+[\w.:]+|=[\w.:]+)?(?=\s|$)/g,
  /\s+--hostname(?:\s+[\w.:]+|=[\w.:]+)?(?=\s|$)/g,
];

/**
 * A package-manager script invocation, allowing leading `VAR=value` env
 * assignments — `HOST=0.0.0.0 npm start` is still an npm script, and flags for
 * it still need the `--` separator. Anchoring on `npm` alone made `injectPort`
 * drop the separator as soon as `injectHost` added a CRA-style env prefix.
 */
const SCRIPT_CMD_RE = /^(?:\w+=\S*\s+)*(?:npm|yarn|pnpm)\s+(?:run\s+)?[\w:-]+/;

/** True if `command` already asks the dev server to listen on the network. */
export function hasHostFlag(command: string): boolean {
  return /(^|\s)HOST=/.test(command) || HOST_FLAG_RE.some((re) => {
    re.lastIndex = 0;
    return re.test(command);
  });
}

/** Remove any host flag/env this module might have added. */
export function stripHost(command: string): string {
  let out = command.replace(/(^|\s)HOST=[\w.:]+\s*/g, "$1");
  for (const re of HOST_FLAG_RE) out = out.replace(re, "");
  // A `--` left with nothing after it (we removed the only forwarded flag)
  // would make npm re-parse the next token as a script argument.
  return out.replace(/\s+--\s*$/, "").trim();
}

/**
 * Add the host flag for `style`, replacing any existing one.
 *
 * Mirrors `injectPort`'s handling of npm/yarn/pnpm scripts: a flag meant for
 * the underlying binary has to cross the `--` separator, or the package manager
 * eats it itself.
 */
export function injectHost(command: string, style: HostStyle): string {
  const cleaned = stripHost(command);
  if (!cleaned) return cleaned;

  // react-scripts takes no flag at all — HOST is an environment variable, so it
  // goes in front of the command, not after it.
  if (style === "cra") return `HOST=0.0.0.0 ${cleaned}`;

  const flag =
    style === "next" ? "-H 0.0.0.0" : style === "angular" ? "--host 0.0.0.0" : "--host";

  const isScriptCmd = SCRIPT_CMD_RE.test(cleaned);
  const hasSeparator = /\s+--(?:\s|$)/.test(cleaned);
  if (isScriptCmd && !hasSeparator) return `${cleaned} -- ${flag}`;
  return `${cleaned} ${flag}`;
}

/**
 * Work out which spelling a project needs from its package.json.
 *
 * Prefers the body of the script actually being run (`npm run dev` →
 * `scripts.dev`), because that names the real binary; a project can depend on
 * both `vite` and `next`, but its dev script only runs one of them. Falls back
 * to dependencies, then to Vite's spelling — the widest-compatibility guess,
 * and the one the user can correct by editing the command directly.
 */
export function detectHostStyle(packageJson: string, command: string): HostStyle {
  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(packageJson);
  } catch {
    return "vite";
  }

  const scriptName = command.match(/^(?:npm|yarn|pnpm)\s+(?:run\s+)?([\w:-]+)/)?.[1];
  const body = (scriptName && pkg.scripts?.[scriptName]) || "";
  const fromBody = matchHostStyle(body);
  if (fromBody) return fromBody;

  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps["react-scripts"]) return "cra";
  if (deps["next"]) return "next";
  if (deps["@angular/cli"] || deps["@angular/core"]) return "angular";
  return "vite";
}

/** Read a file from a project, local or over SSH. Returns null when absent —
 *  callers probe several candidate config filenames and take the first hit. */
async function readProjectFile(
  projectPath: string,
  relPath: string,
  serverId?: string,
): Promise<string | null> {
  const path = `${projectPath.replace(/[\\/]+$/, "")}/${relPath}`;
  try {
    if (serverId) {
      const server = useAppStore.getState().servers.find((s) => s.id === serverId);
      if (!server || server.authMethod !== "ssh-key" || !server.sshKeyPath) return null;
      return await invoke<string>("ssh_read_file", {
        host: server.host,
        username: server.username,
        path,
        identityFile: server.sshKeyPath,
      });
    }
    return await invoke<string>("read_file", { path });
  } catch {
    return null;
  }
}

/** The port a framework serves on when nothing overrides it. */
export function defaultPortForStyle(style: HostStyle): number {
  switch (style) {
    case "vite": return 5173;
    case "angular": return 4200;
    default: return 3000; // next, cra
  }
}

/** An explicit `--port N` / `-p N` the command already carries, if any. A
 *  command with one is not on the default — that IS the manual port. */
export function explicitPortInCommand(command: string): number | null {
  const m = command.match(/(?:--port|-p)(?:\s+|=)(\d{2,5})\b/);
  const n = m ? parseInt(m[1], 10) : NaN;
  return n > 0 && n <= 65535 ? n : null;
}

/** Remove any `--port` / `-p` flag, leaving the command on its default. */
export function stripPort(command: string): string {
  return command
    .replace(/\s+--port(?:\s+\d+|=\d+)/g, "")
    .replace(/\s+-p(?:\s+\d+|=\d+)/g, "")
    .replace(/\s+--\s*$/, "")
    .trim();
}

/** Config files that can override the framework default, per style. Only the
 *  matching style's candidates are probed — each miss is an SSH round trip on
 *  a remote project. */
const PORT_CONFIG_CANDIDATES: Record<HostStyle, string[]> = {
  vite: ["vite.config.ts", "vite.config.js", "vite.config.mjs"],
  angular: ["angular.json"],
  next: [".env.local", ".env"],
  cra: [".env.local", ".env"],
};

/** Pull an explicit port out of a config file's text. */
function portFromConfig(text: string, style: HostStyle): number | null {
  // .env style: PORT=3001
  if (style === "next" || style === "cra") {
    const m = text.match(/^\s*PORT\s*=\s*"?(\d{2,5})"?\s*$/m);
    return m ? parseInt(m[1], 10) : null;
  }
  // angular.json: "options": { … "port": 4300 } under the serve target
  if (style === "angular") {
    const m = text.match(/"port"\s*:\s*(\d{2,5})/);
    return m ? parseInt(m[1], 10) : null;
  }
  // vite.config: server: { port: 5174 }. Anchored on the `server` block so a
  // `preview.port` or a proxy target's port can't be mistaken for it.
  const server = text.match(/server\s*:\s*\{[\s\S]{0,400}?\}/);
  const m = (server?.[0] ?? "").match(/\bport\s*:\s*(\d{2,5})/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * The port this dev server will actually use when the command names none.
 *
 * Framework default, overridden by an explicit port in the project's config.
 * Deliberately NOT the old `guessDefaultPort`, which tested the COMMAND text
 * for a framework name — `npm run dev` contains no "vite", so every Vite
 * project reported 3000 when its real default is 5173.
 */
export async function resolveDefaultPort(
  projectPath: string,
  command: string,
  serverId?: string,
): Promise<{ port: number; style: HostStyle; fromConfig: boolean; hasManifest: boolean }> {
  const pkg = await readProjectFile(projectPath, "package.json", serverId);
  // No package.json means `style` below is a guess, not a detection — and so is
  // the port it implies. Callers that ACT on the port (the launcher's pre-flight,
  // which appends `--port N`) need to know the difference: `cargo run --port
  // 5174` is not a fallback, it is a broken command. Callers that merely DISPLAY
  // it (the row editor's "Default 5173" badge) can keep using the guess.
  const hasManifest = pkg !== null;
  const style = pkg ? detectHostStyle(pkg, command) : "vite";
  for (const candidate of PORT_CONFIG_CANDIDATES[style]) {
    const text = await readProjectFile(projectPath, candidate, serverId);
    if (text === null) continue;
    const port = portFromConfig(text, style);
    if (port && port > 0 && port <= 65535) return { port, style, fromConfig: true, hasManifest };
    break; // the config exists but names no port — the framework default stands
  }
  return { port: defaultPortForStyle(style), style, fromConfig: false, hasManifest };
}

/**
 * `detectHostStyle` for a project on disk — local or on a remote server.
 *
 * Falls back to Vite's spelling on any failure (no package.json, unreachable
 * host, a project that isn't Node at all). A wrong guess is visible and
 * editable: the flag is written into the command field, not hidden behind the
 * checkbox, so the user can correct it in place.
 */
export async function detectHostStyleForProject(
  projectPath: string,
  command: string,
  serverId?: string,
): Promise<HostStyle> {
  const path = `${projectPath.replace(/[\\/]+$/, "")}/package.json`;
  try {
    let content: string;
    if (serverId) {
      const server = useAppStore.getState().servers.find((s) => s.id === serverId);
      if (!server || server.authMethod !== "ssh-key" || !server.sshKeyPath) return "vite";
      content = await invoke<string>("ssh_read_file", {
        host: server.host,
        username: server.username,
        path,
        identityFile: server.sshKeyPath,
      });
    } else {
      content = await invoke<string>("read_file", { path });
    }
    return detectHostStyle(content, command);
  } catch {
    return "vite";
  }
}

function matchHostStyle(scriptBody: string): HostStyle | null {
  if (/\breact-scripts\b/.test(scriptBody)) return "cra";
  if (/\bnext\b/.test(scriptBody)) return "next";
  if (/\bng\s+serve\b/.test(scriptBody)) return "angular";
  if (/\b(?:vite|nuxt|astro|remix|svelte-kit|tauri)\b/.test(scriptBody)) return "vite";
  return null;
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
