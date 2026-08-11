import { invoke } from "@tauri-apps/api/core";
import { useAppStore, type AppStore } from "../store";
import type { RecentProject } from "../store/recentProjectsSlice";

/**
 * Debug-build safety net: import `debug-reset-seed.json` from the app's local
 * data dir into the store, once, then move the file to the Recycle Bin.
 *
 * Exists because a debug reset once destroyed the dev world's projects on
 * disk (WebView2 committed a localStorage clear but not the follow-up
 * rewrite — see DebugResetModal). The seed file is how lost project state is
 * handed back in: drop a JSON file with any of the preserved keys next to
 * EBWebView, restart made_debug, and the projects are back. Missing file is
 * the normal case on every boot and exits silently.
 *
 * Merge rules: existing store entries always win — the seed only appends
 * projects/servers not already present and fills Jira fields that are empty.
 * A seed with `"replace": true` instead SETS every seeded field exactly
 * (missing keys become empty) — the repair mode for a store that holds WRONG
 * entries, e.g. content that leaked across the dev/live world split. Debug
 * and production MADE never share content, and that includes recovery: a
 * debug seed is built from debug-world evidence, never from the prod blob.
 */

const SEED_FILENAME = "debug-reset-seed.json";

interface DebugResetSeed {
  replace?: boolean;
  recentProjects?: RecentProject[];
  /** Surgical repairs: shallow-merge `set` into entries matching path+serverId.
   *  Runs in every mode and touches nothing else — for fixing a wrong flag on
   *  an entry without replacing the list or the Jira fields. */
  patchRecentProjects?: Array<{
    path: string;
    serverId?: string;
    set: Partial<RecentProject>;
  }>;
  servers?: AppStore["servers"];
  jiraSites?: string[];
  jiraDefaultSiteId?: string;
  jiraApiEmail?: string;
  jiraApiToken?: string;
  jiraMyAccountId?: string;
  jiraSiteAccounts?: AppStore["jiraSiteAccounts"];
}

const projectKey = (p: Pick<RecentProject, "path" | "serverId">) =>
  `${(p.path ?? "").replace(/\\/g, "/").toLowerCase()}|${p.serverId ?? ""}`;

let ran = false;

export async function importDebugResetSeed(): Promise<void> {
  if (!import.meta.env.DEV || ran) return;
  ran = true;

  let dir: string;
  let path: string;
  let seed: DebugResetSeed;
  try {
    const { appLocalDataDir, join } = await import("@tauri-apps/api/path");
    dir = await appLocalDataDir();
    path = await join(dir, SEED_FILENAME);
    seed = JSON.parse(await invoke<string>("read_file", { path })) as DebugResetSeed;
  } catch {
    return; // no seed file — the normal case
  }

  useAppStore.setState((state) => {
    const next: Partial<AppStore> = {};

    if (Array.isArray(seed.patchRecentProjects) && seed.patchRecentProjects.length) {
      next.recentProjects = state.recentProjects.map((p) => {
        const patch = seed.patchRecentProjects!.find(
          (t) => projectKey(t) === projectKey(p),
        );
        return patch ? { ...p, ...patch.set } : p;
      });
    }

    if (seed.replace) {
      next.recentProjects = Array.isArray(seed.recentProjects) ? seed.recentProjects : [];
      next.servers = Array.isArray(seed.servers) ? seed.servers : [];
      next.jiraSites = Array.isArray(seed.jiraSites) ? seed.jiraSites : [];
      next.jiraDefaultSiteId = seed.jiraDefaultSiteId ?? "";
      next.jiraApiEmail = seed.jiraApiEmail ?? "";
      next.jiraApiToken = seed.jiraApiToken ?? "";
      next.jiraMyAccountId = seed.jiraMyAccountId ?? "";
      next.jiraSiteAccounts = seed.jiraSiteAccounts ?? {};
      return next;
    }

    if (Array.isArray(seed.recentProjects) && seed.recentProjects.length) {
      const have = new Set(state.recentProjects.map(projectKey));
      const added = seed.recentProjects.filter((p) => p?.path && !have.has(projectKey(p)));
      if (added.length) next.recentProjects = [...state.recentProjects, ...added];
    }
    if (Array.isArray(seed.servers) && seed.servers.length) {
      const have = new Set(state.servers.map((s) => s.id));
      const added = seed.servers.filter((s) => s?.id && !have.has(s.id));
      if (added.length) next.servers = [...state.servers, ...added];
    }
    if (Array.isArray(seed.jiraSites) && seed.jiraSites.length && state.jiraSites.length === 0) {
      next.jiraSites = seed.jiraSites;
      if (seed.jiraDefaultSiteId && !state.jiraDefaultSiteId) {
        next.jiraDefaultSiteId = seed.jiraDefaultSiteId;
      }
    }
    if (seed.jiraApiEmail && !state.jiraApiEmail) next.jiraApiEmail = seed.jiraApiEmail;
    if (seed.jiraApiToken && !state.jiraApiToken) next.jiraApiToken = seed.jiraApiToken;
    if (seed.jiraMyAccountId && !state.jiraMyAccountId) next.jiraMyAccountId = seed.jiraMyAccountId;
    if (
      seed.jiraSiteAccounts &&
      Object.keys(state.jiraSiteAccounts ?? {}).length === 0 &&
      Object.keys(seed.jiraSiteAccounts).length > 0
    ) {
      next.jiraSiteAccounts = seed.jiraSiteAccounts;
    }

    return next;
  });

  console.log(
    `[debug-reset-seed] imported ${seed.recentProjects?.length ?? 0} projects from ${path}`,
  );
  try {
    await invoke("fs_delete_to_trash", { root: dir, path });
  } catch (err) {
    console.warn("[debug-reset-seed] could not remove seed file:", err);
  }
}
