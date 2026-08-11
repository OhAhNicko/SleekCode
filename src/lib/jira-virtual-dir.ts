/**
 * Virtual working directories for KEYED Jira projects.
 *
 * A keyed Jira project (site + project key, no folder yet) still needs a
 * `Tab.workingDir` / `RecentProject.path`: the session registry, recents
 * dedupe, and site resolution are all plain string maps keyed on it. So the
 * tab's identity is a virtual path — `jira://<site-host>/<KEY>` — which those
 * maps treat as any other opaque string.
 *
 * The string must never reach the filesystem. The two places it could —
 * terminal spawn cwd (terminalSlice.addTerminal/addTerminals) and the ticket
 * rail's transcript probes (useJiraTicketRows) — translate it through
 * `jiraFsCwd` first. Folder handling proper for Jira CLI panes is a follow-up;
 * until then panes spawn in the projects dir (or home).
 *
 * Kept pure (no store imports): terminalSlice imports this module, and pulling
 * the store in here would create an import cycle.
 */

export const JIRA_VIRTUAL_SCHEME = "jira://";

export function isJiraVirtualDir(dir: string): boolean {
  return dir.startsWith(JIRA_VIRTUAL_SCHEME);
}

/** `https://acme.atlassian.net` + `SUPPORT` → `jira://acme.atlassian.net/SUPPORT`. */
export function makeJiraVirtualDir(siteId: string, projectKey: string): string {
  const host = siteId.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `${JIRA_VIRTUAL_SCHEME}${host}/${projectKey}`;
}

/** Display form: `acme.atlassian.net/SUPPORT` (identity for non-virtual dirs). */
export function jiraVirtualDirLabel(dir: string): string {
  return isJiraVirtualDir(dir) ? dir.slice(JIRA_VIRTUAL_SCHEME.length) : dir;
}

/** The REAL directory to use where a virtual dir would hit the filesystem. */
export function jiraFsCwd(dir: string, fallback: string): string {
  return isJiraVirtualDir(dir) ? fallback : dir;
}

// Home-dir cache with a SYNC accessor: the spawn path (openJiraTicket →
// addTerminal) is synchronous and cannot await. Prefetched from main.tsx at
// boot, long before any ticket pane can exist.
let cachedHome = "";

export function prefetchHomeDir(): void {
  void import("@tauri-apps/api/path")
    .then(({ homeDir }) => homeDir())
    .then((h) => {
      cachedHome = h;
    })
    .catch(() => {
      /* keep "" — jiraFsCwd callers fall through to the PTY's default cwd */
    });
}

export function cachedHomeDir(): string {
  return cachedHome;
}
