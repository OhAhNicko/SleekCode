import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { candidatePorts } from "./port-conflict";
import { explicitPortInCommand, injectPort, resolveDefaultPort } from "./server-commands";
import { isSameProject, withTimeout } from "./spawn-dev-server";
import type { DevServer, TerminalBackend } from "../types";

/**
 * Which port a dev server actually launches on.
 *
 * MADE used to answer this by not answering it: the command was typed verbatim
 * and whatever port showed up in the output became the truth. Two Vite projects
 * both mean 5173, so they collided by construction and the loser died with
 * "Port 5173 is already in use" — with `resolveDefaultPort` (which knows the
 * project's REAL port from vite.config / .env / angular.json) and `port_check`
 * (which knows whether it is free) both sitting unused in the codebase.
 *
 * This module joins those two: resolve the port the project actually wants,
 * probe it, and step +1 to the first free one — the same move Vite and Next
 * make on their own, so the fallback ports stay familiar per framework.
 */

/**
 * Ceiling on the whole probe. `resolveDefaultPort` reads package.json and maybe
 * a config file, then each candidate is a TCP connect — all of it in front of a
 * launch the user is waiting on. Blowing the deadline runs the command
 * untouched, which is exactly the old behaviour: fail OPEN, never block a start
 * because we could not work out a port.
 */
const PROBE_BUDGET_MS = 2000;

/** How far up the ladder to look before giving up and letting it collide. */
const MAX_STEPS = 10;

export interface RunPlan {
  /** The text to type into the PTY — `ds.command` unless a port had to be forced. */
  command: string;
  /** The port this run should come up on; null when we could not work one out. */
  port: number | null;
  /**
   * What the command would have used if left alone. `rememberPort` compares
   * against this — a server that landed on its natural port has nothing worth
   * remembering. Null means unknown (remote project, or the probe timed out).
   */
  natural: number | null;
  /**
   * Whether appending `--port N` to this command is a thing we may do on our
   * own. True when the project has a package.json (so the framework, and its
   * flag, are known) or when the command already carries an explicit `--port`
   * — the user having written the flag is proof it is accepted.
   *
   * False is the `EVP_SOLVER=… cargo run` case: we can still SEE the conflict in
   * its output and still free the port for it, but inventing a `--port` flag
   * would turn a port clash into an unparseable command. Automatic paths respect
   * this; the "Another port" button overrides it, because an explicit click is
   * an instruction and its failure is visible and costs nothing.
   */
  controllable: boolean;
}

/**
 * Is anything listening on this machine's 127.0.0.1:<port>?
 *
 * A probe that THROWS reports free, not busy. Moving a server off its own port
 * because an IPC call failed would be a self-inflicted version of the bug this
 * module exists to fix.
 */
async function isPortBusy(port: number): Promise<boolean> {
  try {
    return await invoke<boolean>("port_check", { port });
  } catch {
    return false;
  }
}

/** Ports other MADE dev servers are on right now. */
function portsHeldByOthers(selfId: string): Set<number> {
  const out = new Set<number>();
  for (const ds of useAppStore.getState().devServers) {
    if (ds.id === selfId) continue;
    if (ds.port > 0 && (ds.status === "running" || ds.status === "starting")) out.add(ds.port);
  }
  return out;
}

/**
 * The port this project+command last came up on, when that differed from its
 * natural one. Keyed by command string rather than index for the same reason
 * `primaryServerCommand` is: a project can hold several servers, and removing
 * or reordering a row must not re-point the others.
 */
function rememberedPortFor(ds: Pick<DevServer, "workingDir" | "serverId" | "command">): number | undefined {
  const project = useAppStore
    .getState()
    .recentProjects.find((p) =>
      isSameProject({ workingDir: p.path, serverId: p.serverId }, ds.workingDir, ds.serverId),
    );
  return project?.serverPorts?.[ds.command];
}

/**
 * Record the port a server actually came up on, so its URL survives a restart.
 *
 * Deliberately narrow: it remembers only a port WE forced and that the server
 * then honoured. Remembering any port that merely differs from the natural one
 * looks equivalent and is not — a `cargo run` project detected on 8000 while our
 * (guessed) natural port said 5173 would be remembered as 8000, and the next
 * launch would "helpfully" run `cargo run --port 8000`. Storing only ports we
 * have already proven we can inject keeps that impossible.
 *
 * Every other outcome CLEARS the entry rather than leaving it: landing on the
 * natural port, or the server ignoring our flag, are both evidence that any
 * previous memory is no longer true.
 */
export function rememberPort(ds: DevServer, detected: number, plan: RunPlan | undefined): void {
  if (ds.serverId) return;
  const keep =
    plan?.controllable &&
    plan.port !== null &&
    plan.natural !== null &&
    plan.port !== plan.natural &&
    detected === plan.port;
  useAppStore
    .getState()
    .setProjectServerPort(ds.workingDir, ds.serverId, ds.command, keep ? detected : undefined);
}

async function planRunInner(ds: DevServer, avoid?: number, force?: boolean): Promise<RunPlan> {
  // An explicit `--port` in the command is an instruction, not a default: it
  // outranks both the config file and anything we remembered — and it is also
  // proof that this command accepts the flag at all, which is what lets us
  // rewrite it later without reading a package.json we may not have.
  const explicit = explicitPortInCommand(ds.command);
  let natural: number;
  let controllable: boolean;
  if (explicit !== null) {
    natural = explicit;
    controllable = true;
  } else {
    const resolved = await resolveDefaultPort(ds.workingDir, ds.command, ds.serverId);
    natural = resolved.port;
    controllable = force === true || resolved.hasManifest;
  }
  if (!controllable) {
    // We can watch it fail and we can free its port for it, but we will not
    // invent a flag for a command we cannot read.
    return { command: ds.command, port: natural, natural: null, controllable: false };
  }
  const preferred = explicit ?? rememberedPortFor(ds) ?? natural;

  const taken = portsHeldByOthers(ds.id);
  if (avoid !== undefined) taken.add(avoid);

  // A port this row is CURRENTLY holding is not an obstacle to this row: a
  // restart types into a shell that has just been ^C'd, so the port is either
  // already free or the last heartbeat of the process we killed. Probing it
  // would read that corpse as a conflict and shunt the server one port higher
  // on every single restart, climbing forever.
  //
  // Only while it holds it, though. A STOPPED row keeps its last port in the
  // store, and in the meantime another project may have taken it — claiming it
  // unprobed would walk this feature straight back into the collision it exists
  // to prevent.
  const holdsOwnPort =
    ds.port > 0 && (ds.status === "running" || ds.status === "starting") && ds.port !== avoid;

  let chosen: number | null = null;
  for (const port of candidatePorts(preferred, taken, MAX_STEPS)) {
    if (holdsOwnPort && port === ds.port) {
      chosen = port;
      break;
    }
    if (!(await isPortBusy(port))) {
      chosen = port;
      break;
    }
  }

  if (chosen === null) {
    // Ten ports up and everything is busy. Run it as written and let the
    // runtime path report the conflict — refusing to start would be worse than
    // starting and failing visibly.
    console.warn(`[DevServer] no free port near ${preferred} for "${ds.command}"`);
    return { command: ds.command, port: natural, natural, controllable };
  }
  // Only rewrite when the port is NOT what the command would have done anyway,
  // so an uncontested start still runs exactly the text the row displays.
  return {
    command: chosen === natural ? ds.command : injectPort(ds.command, chosen),
    port: chosen,
    natural,
    controllable,
  };
}

/** What we run when we have no business changing anything: the command itself. */
function unplanned(ds: DevServer): RunPlan {
  const explicit = explicitPortInCommand(ds.command);
  return { command: ds.command, port: explicit, natural: null, controllable: explicit !== null };
}

/**
 * Work out the command to type for this run.
 *
 * `ds` must be the row as it was BEFORE `markStarting` zeroed its port — the
 * own-port rule above depends on knowing which port this server is vacating.
 *
 * `avoid` excludes a port just proven unusable (the runtime-conflict retry and
 * the "Another port" button). `force` overrides the `controllable` gate, for the
 * one case where the user asked for a different port in so many words.
 */
export async function planRun(
  ds: DevServer,
  opts?: { avoid?: number; force?: boolean },
): Promise<RunPlan> {
  // Remote projects: `port_check` probes THIS machine, and the server's ports
  // are on the far end of an SSH connection. A probe here would be answering a
  // question about the wrong computer, so don't ask it — the output-based
  // retry still covers remote conflicts.
  if (ds.serverId) return unplanned(ds);
  try {
    return await withTimeout(
      planRunInner(ds, opts?.avoid, opts?.force),
      PROBE_BUDGET_MS,
      "dev-server port probe",
    );
  } catch (e) {
    console.warn(`[DevServer] port probe failed for "${ds.command}" — running as written`, e);
    return unplanned(ds);
  }
}

/**
 * A shell one-liner that frees `port`, for the backend the dev server runs in.
 *
 * Typed into the server's OWN pty rather than run from Rust, which is what makes
 * it land on the right machine: a WSL-backed server kills inside the distro, an
 * SSH server kills on the remote host. A Windows-side kill of a WSL listener
 * would shoot the localhost-forwarding relay instead of the server.
 *
 * `fuser` is missing (or takes different arguments) on macOS, which several SSH
 * targets are, hence the `lsof` fallback — the `||` fires both when fuser is
 * absent and when it found nothing.
 */
export function killPortCommand(port: number, backend?: TerminalBackend): string {
  if (backend === "windows") {
    return (
      `$p = Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | ` +
      `Select-Object -ExpandProperty OwningProcess -Unique; ` +
      `if ($p) { $p | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }; ` +
      `Start-Sleep -Seconds 1`
    );
  }
  return `(fuser -k ${port}/tcp 2>/dev/null || lsof -ti tcp:${port} 2>/dev/null | xargs kill -9 2>/dev/null); sleep 1`;
}
