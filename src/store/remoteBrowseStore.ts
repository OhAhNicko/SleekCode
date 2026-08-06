/**
 * Did the sidebar's remote file tree manage to load this tab's project?
 *
 * The tree lives in the sidebar, which is only mounted while it is open and
 * showing the Remote Files pane. The RETRY affordance lives on the project tab
 * in the tab bar, which is always mounted. So the answer has to outlive the
 * component that produced it — hence a store rather than component state.
 *
 * Deliberately NOT persisted: "we could not reach the server" is a fact about
 * right now, and a stale one restored at launch would put a red retry icon on a
 * tab whose server is perfectly fine.
 */
import { create } from "zustand";
import type { RemoteServer } from "../types";
import { checkServerReachable } from "../lib/ssh-reachability";

export type RemoteBrowseState = "loading" | "ok" | "failed";

export interface RemoteBrowseEntry {
  state: RemoteBrowseState;
  /** The project directory this status is about. Kept so a failure recorded
   *  for a previous project cannot be shown against a new one. */
  rootDir: string;
  /** The ssh error, verbatim. Only set when `state` is "failed". */
  error?: string;
  /** A retry is in flight — the tab's refresh button spins and ignores clicks. */
  retrying?: boolean;
}

interface RemoteBrowseStore {
  byTab: Record<string, RemoteBrowseEntry>;
  setStatus: (tabId: string, entry: RemoteBrowseEntry) => void;
  patchStatus: (tabId: string, patch: Partial<RemoteBrowseEntry>) => void;
  clearStatus: (tabId: string) => void;
}

export const useRemoteBrowseStore = create<RemoteBrowseStore>((set) => ({
  byTab: {},

  setStatus: (tabId, entry) =>
    set((s) => ({ byTab: { ...s.byTab, [tabId]: entry } })),

  patchStatus: (tabId, patch) =>
    set((s) => {
      const prev = s.byTab[tabId];
      if (!prev) return s;
      return { byTab: { ...s.byTab, [tabId]: { ...prev, ...patch } } };
    }),

  clearStatus: (tabId) =>
    set((s) => {
      if (!(tabId in s.byTab)) return s;
      const next = { ...s.byTab };
      delete next[tabId];
      return { byTab: next };
    }),
}));

/**
 * The mounted tree's own reload function, per tab.
 *
 * A plain Map, not store state: nothing renders from it, and putting functions
 * in a Zustand store would make every mount/unmount a re-render for every
 * subscriber.
 */
const reloaders = new Map<string, () => void>();

/** Called by the mounted tree. Returns the unregister for the effect cleanup. */
export function registerRemoteReloader(
  tabId: string,
  reload: () => void,
): () => void {
  reloaders.set(tabId, reload);
  return () => {
    // Identity check: a remount may already have replaced this entry, and the
    // old cleanup must not delete the new component's reloader.
    if (reloaders.get(tabId) === reload) reloaders.delete(tabId);
  };
}

/**
 * Retry a tab's remote project, from anywhere.
 *
 * Two paths, because the tree may not be mounted when the user clicks the
 * retry button on the tab:
 *
 *  - Tree mounted → hand off to it. It owns the cache and publishes the
 *    loading/ok/failed status itself.
 *  - Tree not mounted (sidebar closed, or on the Search/Terminals pane) → the
 *    only useful thing left is to re-test the connection. If the server answers
 *    we drop the status, so the next time the tree mounts it loads clean
 *    instead of opening on a stale failure.
 */
export async function requestRemoteReload(
  tabId: string,
  server?: RemoteServer,
): Promise<void> {
  const { byTab, patchStatus } = useRemoteBrowseStore.getState();
  if (byTab[tabId]?.retrying) return;

  const reload = reloaders.get(tabId);
  if (reload) {
    reload();
    return;
  }

  if (!server) return;
  patchStatus(tabId, { retrying: true });
  const reachable = await checkServerReachable(server);
  if (reachable === false) {
    useRemoteBrowseStore.getState().patchStatus(tabId, { retrying: false });
    return;
  }
  // `true` = it answered. `null` = password auth, which BatchMode can never
  // prove either way — treat that as "worth another look" and let the tree's
  // own `ls` be the probe, rather than leaving the tab stuck on red.
  useRemoteBrowseStore.getState().clearStatus(tabId);
}
