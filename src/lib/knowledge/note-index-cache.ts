import { listNotes } from "./api";
import { canonicalProjectKey } from "./keys";
import type { KnowledgeNoteMeta, NoteIndexEntry } from "./types";

/**
 * Short-lived index of a project's notes, so a caller can answer "what can
 * `@note/…` complete to?" **synchronously**.
 *
 * Same idiom as `git-branch-cache.ts`, for the same reason: the surfaces that
 * need this list — a composer popup, a context menu — must be correct on their
 * FIRST painted frame. A list that arrives half a second later either pops a
 * popup open under the user's typing or resizes a menu under their pointer.
 *
 * Freshness comes from the app, not from expiry: `knowledgeStore.refresh`
 * publishes on every refresh, and refreshes are driven by the
 * `made:knowledge-changed` event, so the TTL is only a backstop for a project
 * nobody has touched.
 */

const TTL_MS = 30_000;

const cache = new Map<string, { at: number; value: NoteIndexEntry[] }>();
const inFlight = new Map<string, Promise<NoteIndexEntry[]>>();

function toEntries(notes: KnowledgeNoteMeta[]): NoteIndexEntry[] {
  return notes
    .filter((n) => !n.archived)
    .map((n) => ({
      entityId: n.id,
      slug: n.slug,
      title: n.title,
      type: n.type,
      revision: n.revision,
    }));
}

/** Publish a list fetched elsewhere — the store calls this on every refresh. */
export function publishNoteIndex(projectPath: string, notes: KnowledgeNoteMeta[]): void {
  const key = canonicalProjectKey(projectPath);
  if (!key) return;
  cache.set(key, { at: Date.now(), value: toEntries(notes) });
}

/** Cached list, or undefined when unknown/stale. Never triggers a fetch. */
export function getCachedNoteIndex(projectPath: string): NoteIndexEntry[] | undefined {
  const key = canonicalProjectKey(projectPath);
  if (!key) return undefined;
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

/**
 * Resolve and cache. Concurrent callers share one invoke, so a prewarm and a
 * real read never fire two list walks at the same project.
 */
export function warmNoteIndex(projectPath: string): Promise<NoteIndexEntry[]> {
  const key = canonicalProjectKey(projectPath);
  if (!key) return Promise.resolve([]);

  const cached = getCachedNoteIndex(projectPath);
  if (cached) return Promise.resolve(cached);

  const existing = inFlight.get(key);
  if (existing) return existing;

  const p = listNotes(projectPath)
    // An unattached or uninitialized project has no notes to offer, and the
    // popup that asked simply never opens. Caching the empty answer keeps a
    // keystroke in a non-knowledge project from re-invoking on every character.
    .catch((): KnowledgeNoteMeta[] => [])
    .then((notes) => {
      const value = toEntries(notes);
      cache.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, p);
  return p;
}

/** Drop a project's entry — used when a project detaches or fails to open. */
export function forgetNoteIndex(projectPath: string): void {
  cache.delete(canonicalProjectKey(projectPath));
}
