import type { GitOverview } from "../types";

/**
 * Last-known git overview per project directory, so the tabbar's GitStatusBar
 * can paint the RIGHT tab's numbers **synchronously** on tab switch.
 *
 * Without it a switch showed the previous tab's branch and diff counts for the
 * whole fetch round trip — on a Windows-drive repo read through WSL that was
 * 17 s+ of confidently wrong data. With it, the bar snaps to the target
 * directory's last-known snapshot on the same frame as the switch, and the
 * background refresh corrects it when fresh numbers arrive.
 *
 * Deliberately NO TTL: a stale snapshot of the right directory beats both an
 * empty bar and the wrong directory's data, and every entry is refreshed by
 * the owning tab's 20 s poll + `made:git-refresh` whenever it is active.
 *
 * Persisted to localStorage so the first paint after an app restart is also
 * instant. The payload is a few numbers and branch names per project — pruned
 * to the newest MAX_ENTRIES directories.
 */
interface Entry {
  overview: GitOverview;
  fetchedAt: number;
}

const STORAGE_KEY = "made:git-status-cache:v1";
const MAX_ENTRIES = 40;

function cacheKey(dir: string, serverId?: string): string {
  return `${serverId ?? "local"}::${dir}`;
}

function load(): Map<string, Entry> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as Record<string, Entry>;
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

const cache = load();

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(cache)));
  } catch {
    // Quota/serialization failures only cost the cross-restart warm start.
  }
}

/** Last-known snapshot, or null when this directory has never been fetched. */
export function getGitOverviewSnapshot(dir: string, serverId?: string): GitOverview | null {
  if (!dir) return null;
  return cache.get(cacheKey(dir, serverId))?.overview ?? null;
}

/** Publish a fresh fetch result. Safe to call for a no-longer-active tab. */
export function setGitOverviewSnapshot(
  dir: string,
  serverId: string | undefined,
  overview: GitOverview,
): void {
  if (!dir) return;
  cache.set(cacheKey(dir, serverId), { overview, fetchedAt: Date.now() });
  if (cache.size > MAX_ENTRIES) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
    for (let i = 0; i < cache.size - MAX_ENTRIES; i++) cache.delete(oldest[i][0]);
  }
  persist();
}
