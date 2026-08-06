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
  railTab: Record<string, "tickets" | "assigned">;
  setRailTab: (tabId: string, tab: "tickets" | "assigned") => void;
  /** QUALIFIED ticket key (`<origin>|<KEY>`) whose browser-only preview fills
   *  the canvas while the Assigned tab is showing (per Jira tab). */
  assignedPreview: Record<string, string | undefined>;
  setAssignedPreview: (tabId: string, qkey: string | undefined) => void;
}

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
}));
