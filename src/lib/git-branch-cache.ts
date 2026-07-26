import { invoke } from "@tauri-apps/api/core";

/**
 * Short-lived git branch cache, so a context menu can answer "is this a repo,
 * and what branch?" **synchronously** while it builds.
 *
 * Without it the menu opened with "Checking repository…" and flipped ~½ second
 * later, which visibly changed the menu. Right-click menus must be stable from
 * their first painted frame — the pointer is already sitting over the rows.
 *
 * `warm()` is called on right-button *press*; Chromium fires `contextmenu` on
 * button-UP, so there is typically 120–250 ms of head start and the menu opens
 * with the answer already in hand.
 *
 * Native panes are the exception: their child HWND swallows the press, so the
 * first right-click in a given directory can still miss. It resolves on the
 * enrichment pass and every later right-click within the TTL is instant.
 */
export interface BranchInfo {
  isRepo: boolean;
  branch?: string;
}

// Long-ish, because the cache is actively kept fresh: GitStatusBar publishes
// on every fetch and on every `made:git-refresh`, so a stale entry is refreshed
// by the app's own git activity rather than by expiry.
const TTL_MS = 30_000;

const cache = new Map<string, { at: number; value: BranchInfo }>();
const inFlight = new Map<string, Promise<BranchInfo>>();

/**
 * Publish a result fetched elsewhere.
 *
 * `GitStatusBar` already runs `git_is_repo` + `git_branches` for the active
 * tab's directory on mount and on every `made:git-refresh`. Feeding that into
 * this cache is what makes the context menu's branch row instant in the normal
 * case — no extra git process, no waiting.
 */
export function setCachedBranch(dir: string, value: BranchInfo): void {
  if (!dir) return;
  cache.set(dir, { at: Date.now(), value });
}

/** Cached answer, or undefined when unknown/stale. Never triggers a fetch. */
export function getCachedBranch(dir: string): BranchInfo | undefined {
  if (!dir) return undefined;
  const hit = cache.get(dir);
  if (!hit) return undefined;
  if (Date.now() - hit.at > TTL_MS) {
    cache.delete(dir);
    return undefined;
  }
  return hit.value;
}

/**
 * Resolve and cache. Concurrent callers share one invoke — a right-click
 * prewarm and the enrichment pass must not fire two git processes.
 */
export function warmBranch(dir: string): Promise<BranchInfo> {
  if (!dir) return Promise.resolve({ isRepo: false });

  const cached = getCachedBranch(dir);
  if (cached) return Promise.resolve(cached);

  const existing = inFlight.get(dir);
  if (existing) return existing;

  const p = (async (): Promise<BranchInfo> => {
    try {
      const isRepo = await invoke<boolean>("git_is_repo", { directory: dir });
      if (!isRepo) return { isRepo: false };
      const info = await invoke<{ current?: string }>("git_branches", { directory: dir });
      return { isRepo: true, branch: info?.current };
    } catch {
      // Treat a failed lookup as "not a repo" rather than caching nothing —
      // otherwise every right-click in a broken directory re-spawns git.
      return { isRepo: false };
    }
  })()
    .then((value) => {
      cache.set(dir, { at: Date.now(), value });
      return value;
    })
    .finally(() => {
      inFlight.delete(dir);
    });

  inFlight.set(dir, p);
  return p;
}
