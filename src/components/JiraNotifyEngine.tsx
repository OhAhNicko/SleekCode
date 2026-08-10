/**
 * Jira update poller. Mount once (App). Polls Jira Cloud REST every minute —
 * ONE cycle sweeps EVERY configured site through the Rust `jira_poll` command
 * (lib/jira-notify owns the per-site loop, diffing, cards/toast/sound,
 * snapshots and the Assigned list).
 *
 * Deliberately NOT gated on window state: notifying while minimized is the
 * point. Chromium's background-timer throttling floors hidden timers at about
 * one tick a minute — equal to the cadence, so the poll drifts, never dies.
 *
 * Error policy is PER SITE (inside runJiraPollCycle): auth pauses that site
 * (Settings > Jira shows it; editing credentials re-arms every site), rate
 * backs that site off 60→480s, network skips silently. One site's outage
 * never stops the others.
 */
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { useJiraNotifyStore } from "../store/jiraNotifyStore";
import {
  collectWatchedTicketsBySite,
  refreshUnassignedNow,
  runJiraPollCycle,
  visibleQueuePairs,
  type JiraApiError,
  type JiraQueueKind,
} from "../lib/jira-notify";
import { jiraBaseTicket } from "../lib/jira-layout";
import { defaultJiraSiteIn, jiraQK, siteForTabIn } from "../lib/jira-sites";

const JIRA_POLL_MS = 60_000;

export default function JiraNotifyEngine() {
  const sitesKey = useAppStore((s) => (s.jiraSites ?? []).join("\n"));
  const jiraApiEmail = useAppStore((s) => s.jiraApiEmail);
  const jiraApiToken = useAppStore((s) => s.jiraApiToken);

  // Credential/site edits clear previous auth failures and re-arm every site.
  useEffect(() => {
    useJiraNotifyStore.getState().clearSiteAuthErrors();
  }, [sitesKey, jiraApiEmail, jiraApiToken]);

  // Viewing IS acknowledging: selecting an unseen ticket (or restoring the
  // window onto one) clears its rail highlight. Store-subscription, not a
  // selector — the sweep reads several slices and must never re-render.
  useEffect(() => {
    const sweep = () => {
      const s = useAppStore.getState();
      if (s.windowMinimized || !s.appWindowFocused) return;
      const tab = s.tabs.find((t) => t.id === s.activeTabId);
      if (!tab?.isJiraProject || !tab.selectedJiraTicket) return;
      const qk = jiraQK(siteForTabIn(s, tab), jiraBaseTicket(tab.selectedJiraTicket));
      if ((s.jiraTicketSnapshots ?? {})[qk]?.unseen) s.markJiraTicketSeen(qk);
    };
    sweep();
    return useAppStore.subscribe(sweep);
  }, []);

  useEffect(() => {
    let stopped = false;
    let inFlight = false;

    const tick = async () => {
      if (stopped || inFlight) return;
      const s = useAppStore.getState();
      if (!s.jiraApiEmail || !s.jiraApiToken || (s.jiraSites ?? []).length === 0) return;
      const groups = collectWatchedTicketsBySite();
      // Unassigned mode is work on its own: an unassigned-only user has no
      // watched rows and no assigned mode, and without this the cycle would
      // never fire for them at all.
      let anyWork = (s.jiraAssignedMode ?? false) || (s.jiraUnassignedMode ?? false);
      for (const g of groups.values()) if (g.keys.length > 0) anyWork = true;
      if (!anyWork) return;

      inFlight = true;
      try {
        // Own accountId filters own comments out of "new reply" cards; it is
        // ACCOUNT-global (one Atlassian account spans every site), so one
        // lazy fetch against the default site covers them all.
        if (!s.jiraMyAccountId) {
          const site = defaultJiraSiteIn(s);
          try {
            const me = await invoke<{ displayName: string; accountId: string }>(
              "jira_test_auth",
              { baseUrl: site, email: s.jiraApiEmail, token: s.jiraApiToken },
            );
            if (!stopped && me.accountId) s.setJiraMyAccountId(me.accountId);
          } catch (e) {
            const err = e as JiraApiError;
            if (err?.kind === "auth") {
              useJiraNotifyStore
                .getState()
                .setSiteAuthError(site, err.message || "Jira rejected the credentials");
            }
            // Anything else: the per-site loop below decides.
          }
        }
        await runJiraPollCycle();
      } finally {
        inFlight = false;
        if (!stopped) useJiraNotifyStore.getState().setLastPollAt(Date.now());
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), JIRA_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  // Opening the Unassigned tab fetches it immediately, bypassing the 180s
  // sub-cadence so the list is never stale-looking on arrival. Lives HERE and
  // not in the rail: the rail mounts once per Jira tab and would fire N times
  // for one flip. Fires per SITE, and only for tabs that just switched.
  useEffect(() => {
    // Which queue each Jira tab was showing last time round. A queue only
    // becomes visible by a deliberate click, so an edge here is exactly the
    // moment to fetch — waiting for the next 60s tick would leave the user
    // looking at an empty list they just asked for.
    // Keyed by tab AND kind, not tab alone: the v2 tree can have both the
    // Unassigned and the Resolved group expanded at once, which a single
    // "which view is this tab on" string cannot represent.
    let prev = new Set<string>();
    const onChange = () => {
      const s = useAppStore.getState();
      const pairs = visibleQueuePairs();
      const next = new Set(pairs.map((p) => `${p.tabId}::${p.kind}`));
      const wanted: Array<{ site: string; kind: JiraQueueKind }> = [];
      for (const p of pairs) {
        if (prev.has(`${p.tabId}::${p.kind}`)) continue;
        if (p.kind === "unassigned" && !(s.jiraUnassignedMode ?? false)) continue;
        const tab = s.tabs.find((t) => t.id === p.tabId);
        if (tab) wanted.push({ site: siteForTabIn(s, tab), kind: p.kind });
      }
      prev = next;
      if (!s.jiraApiEmail || !s.jiraApiToken) return;
      for (const w of wanted) void refreshUnassignedNow(w.site, w.kind);
    };
    onChange();
    return useJiraNotifyStore.subscribe(onChange);
  }, []);

  return null;
}
