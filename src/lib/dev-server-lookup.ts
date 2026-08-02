import type { AppStore } from "../store";
import type { DevServer } from "../types";
import { isSameProject } from "./spawn-dev-server";

/**
 * Picking THE dev server for a project, now that a project can have several.
 *
 * The globe icons (tab bar, vertical tab bar, pane header) and the browser
 * preview each used to `.find()` the first match and were right by accident:
 * there could only ever be one. With web + Tauri (or app + API) side by side,
 * "first in the array" means "whichever was created first", which is not a
 * decision the user made.
 *
 * So the choice is explicit — the globe marker in the dev-server panel writes
 * `RecentProject.primaryServerCommand` — with a fallback chain for the projects
 * that never touch it:
 *
 *   1. the row whose command is `primaryServerCommand`
 *   2. the first row actually running on a port
 *   3. the first row
 *
 * Steps 2 and 3 are the old behaviour exactly, so a one-server project works as
 * it always did without anyone setting anything.
 */

type LookupState = Pick<AppStore, "devServers" | "recentProjects">;

/**
 * Which project to look up. Both fields are optional and act as a union, which
 * is what the tab-bar icons need: a server spawned for a tab carries its
 * `tabId`, but one added by hand in the panel has `tabId: ""` and can only be
 * matched by directory.
 */
export interface QuickOpenTarget {
  tabId?: string;
  workingDir?: string;
  serverId?: string;
}

/** Rows belonging to the target, in panel order, deduplicated. */
function rowsFor(state: LookupState, target: QuickOpenTarget): DevServer[] {
  const { tabId, workingDir, serverId } = target;
  if (!tabId && !workingDir) return [];
  return state.devServers.filter(
    (ds) =>
      (!!tabId && ds.tabId === tabId) ||
      (!!workingDir && isSameProject(ds, workingDir, serverId)),
  );
}

/**
 * The dev server the quick-open surfaces should act on, or `undefined` when
 * there is none.
 *
 * Pass `requireRunning` when the caller can only do something useful with a
 * live server (opening a URL); it then ignores rows that have not reported a
 * port yet instead of handing back a server with nothing to open.
 */
export function getQuickOpenServer(
  state: LookupState,
  target: QuickOpenTarget,
  opts: { requireRunning?: boolean } = {},
): DevServer | undefined {
  const rows = rowsFor(state, target);
  if (rows.length === 0) return undefined;

  const live = (ds: DevServer) => ds.status === "running" && ds.port > 0;
  const pool = opts.requireRunning ? rows.filter(live) : rows;
  if (pool.length === 0) return undefined;
  if (pool.length === 1) return pool[0];

  // Every row in a group shares the project's path and host, so any of them
  // finds the entry holding the user's choice.
  const project = state.recentProjects.find((p) =>
    isSameProject(
      { workingDir: p.path, serverId: p.serverId },
      pool[0].workingDir,
      pool[0].serverId,
    ),
  );
  const primary = project?.primaryServerCommand;
  if (primary) {
    const chosen = pool.find((ds) => ds.command === primary);
    if (chosen) return chosen;
  }

  return pool.find(live) ?? pool[0];
}
