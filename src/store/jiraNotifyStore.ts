import { create } from "zustand";

/**
 * Session-only state for the Jira update notifier (JiraNotifyEngine) and the
 * ticket rail's Assigned tab. Deliberately NOT persisted: an auth error should
 * re-verify on next launch, and which rail tab / preview ticket was open is a
 * glance, not workspace state (same argument as the rail's fold state).
 *
 * Persistent siblings live in recentProjectsSlice: jiraSites +
 * jiraDefaultSiteId (site id = normalized origin), jiraApiEmail/Token,
 * jiraMyAccountId, jiraNotifEnabled, jiraAssignedMode, jiraAssignedTickets
 * (site-tagged, so the Assigned tab renders instantly on boot) and
 * jiraTicketSnapshots (the change-detection baseline, QUALIFIED keys).
 */
interface JiraNotifyStore {
  /** Per-site auth failure messages — a site is paused while its entry is
   *  set, WITHOUT stopping the other sites' polling. Shown under the
   *  Settings > Jira credentials row. Cleared when creds change. */
  siteAuthErrors: Record<string, string>;
  setSiteAuthError: (siteId: string, msg: string | null) => void;
  clearSiteAuthErrors: () => void;
  /** Per-site rate-limit backoff (429): the site is skipped until `until`. */
  siteBackoff: Record<string, { ms: number; until: number }>;
  setSiteBackoff: (siteId: string, b: { ms: number; until: number } | null) => void;
  /** Epoch ms of the last completed poll cycle (ok or failed) — Settings hint. */
  lastPollAt: number | null;
  setLastPollAt: (at: number) => void;
  /** Which rail tab each Jira tab shows. Absent = "tickets". External to the
   *  rail component so a notification click can switch it. */
  railTab: Record<string, JiraRailTab>;
  setRailTab: (tabId: string, tab: JiraRailTab) => void;
  /** QUALIFIED ticket key (`<origin>|<KEY>`) whose browser-only preview fills
   *  the canvas while the Assigned OR Unassigned tab is showing (per Jira tab).
   *  One preview slot for both — a rail only ever shows one of them at a time. */
  assignedPreview: Record<string, string | undefined>;
  setAssignedPreview: (tabId: string, qkey: string | undefined) => void;
  /** Which half of the Assigned tab a Jira tab is showing. Session-only, like
   *  railTab — which sub-list you last glanced at is not workspace state. */
  assignedScope: Record<string, "open" | "done">;
  setAssignedScope: (tabId: string, scope: "open" | "done") => void;
  /** Browse-only queues an expanded ticket TREE is showing, keyed
   *  `<tabId>::<kind>`. The v2 tree has no tab strip, so `railTab` cannot
   *  express this — and without it the poll cycle's visibility gate never sees
   *  the tree at all, so its queues fetch once on expand (at best) and then go
   *  stale, or never fill. Sparse: absent means not showing. */
  treeQueues: Record<string, boolean>;
  setTreeQueue: (tabId: string, kind: string, open: boolean) => void;
  /** Per-site failure message for the browse-only QUEUE fetches (unassigned,
   *  assigned-done). Kept apart from siteAuthErrors on purpose: a 403 here is
   *  far more likely "no Browse permission on that project" than "bad
   *  credentials", and pausing the whole site for it would silently kill the
   *  watched-ticket notifications. */
  unassignedErrors: Record<string, string>;
  setUnassignedError: (siteId: string, msg: string | null) => void;
  /** Epoch ms of the last unassigned fetch per site — the 180s sub-cadence
   *  clock. Rides the existing 60s poll timer rather than a second interval;
   *  a second setInterval would double the background-throttle problem. */
  lastUnassignedAt: Record<string, number>;
  markUnassignedPolled: (siteId: string) => void;
}

export type JiraRailTab = "tickets" | "assigned" | "unassigned";

export const useJiraNotifyStore = create<JiraNotifyStore>((set) => ({
  siteAuthErrors: {},
  setSiteAuthError: (siteId, msg) =>
    set((s) => {
      const next = { ...s.siteAuthErrors };
      if (msg === null) delete next[siteId];
      else next[siteId] = msg;
      return { siteAuthErrors: next };
    }),
  clearSiteAuthErrors: () => set({ siteAuthErrors: {} }),
  siteBackoff: {},
  setSiteBackoff: (siteId, b) =>
    set((s) => {
      const next = { ...s.siteBackoff };
      if (b === null) delete next[siteId];
      else next[siteId] = b;
      return { siteBackoff: next };
    }),
  lastPollAt: null,
  setLastPollAt: (at) => set({ lastPollAt: at }),
  railTab: {},
  setRailTab: (tabId, tab) =>
    set((s) => ({ railTab: { ...s.railTab, [tabId]: tab } })),
  assignedPreview: {},
  setAssignedPreview: (tabId, qkey) =>
    set((s) => ({ assignedPreview: { ...s.assignedPreview, [tabId]: qkey } })),
  assignedScope: {},
  setAssignedScope: (tabId, scope) =>
    set((s) => ({ assignedScope: { ...s.assignedScope, [tabId]: scope } })),
  treeQueues: {},
  setTreeQueue: (tabId, kind, open) =>
    set((s) => {
      const next = { ...s.treeQueues };
      if (open) next[`${tabId}::${kind}`] = true;
      else delete next[`${tabId}::${kind}`];
      return { treeQueues: next };
    }),
  unassignedErrors: {},
  setUnassignedError: (siteId, msg) =>
    set((s) => {
      const next = { ...s.unassignedErrors };
      if (msg === null) delete next[siteId];
      else next[siteId] = msg;
      return { unassignedErrors: next };
    }),
  lastUnassignedAt: {},
  markUnassignedPolled: (siteId) =>
    set((s) => ({ lastUnassignedAt: { ...s.lastUnassignedAt, [siteId]: Date.now() } })),
}));
