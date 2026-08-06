/**
 * Multi-site Jira resolution. THE SITE ID IS THE NORMALIZED ORIGIN
 * (`https://acme.atlassian.net`) — see `jiraSites` on the store.
 *
 * One site per Jira project tab, by design: a tab's site is its own stamp,
 * else its project's, else the default. `ProjectSession` deliberately carries
 * NO site — a project's rows all live on the project's site, so re-pointing a
 * project re-points its closed rows too (the switcher dialog says so).
 *
 * Qualified keys: everything change-detection/notification-shaped
 * (`jiraTicketSnapshots`, notification identity, `assignedPreview`) is keyed
 * `<origin>|<KEY>`. `|` can appear in neither an origin nor a ticket key, and
 * `#` (instance keys) / `:` (clickAction verbs) stay untouched.
 *
 * Store-aware on purpose — the pure URL helpers stay in lib/jira.ts. The
 * `*In(state, …)` variants take state so components subscribe reactively via
 * `useAppStore((s) => siteForTabIn(s, tab))`; the bare wrappers are for
 * imperative call sites.
 */

import { useAppStore } from "../store";
import type { RecentProject } from "../store/recentProjectsSlice";
import type { Tab } from "../types";

export const jiraQK = (siteId: string, key: string) => `${siteId}|${key}`;

/** Inverse of jiraQK. A legacy/bare key (no `|`) yields siteId "" — callers
 *  treat that as "the default site". */
export function splitJiraQK(qkey: string): { siteId: string; key: string } {
  const sep = qkey.lastIndexOf("|");
  if (sep === -1) return { siteId: "", key: qkey };
  return { siteId: qkey.slice(0, sep), key: qkey.slice(sep + 1) };
}

type SiteState = {
  jiraSites?: string[];
  jiraDefaultSiteId?: string;
  recentProjects: RecentProject[];
};

export function defaultJiraSiteIn(s: SiteState): string {
  return s.jiraDefaultSiteId || (s.jiraSites ?? [])[0] || "";
}

const normalizePath = (p: string) => p.replace(/\\/g, "/");

export function siteForDirIn(s: SiteState, dir: string, serverId?: string): string {
  const normalized = normalizePath(dir);
  const project = s.recentProjects.find(
    (p) => p.isJira && normalizePath(p.path) === normalized && p.serverId === serverId,
  );
  return project?.jiraSiteId || defaultJiraSiteIn(s);
}

export function siteForTabIn(
  s: SiteState,
  tab: Pick<Tab, "jiraSiteId" | "workingDir" | "serverId">,
): string {
  return tab.jiraSiteId || siteForDirIn(s, tab.workingDir, tab.serverId);
}

export function siteForTab(tab: Pick<Tab, "jiraSiteId" | "workingDir" | "serverId">): string {
  return siteForTabIn(useAppStore.getState(), tab);
}

export function siteForDir(dir: string, serverId?: string): string {
  return siteForDirIn(useAppStore.getState(), dir, serverId);
}

export function defaultJiraSite(): string {
  return defaultJiraSiteIn(useAppStore.getState());
}
