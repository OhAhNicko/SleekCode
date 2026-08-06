/**
 * Jira ticket-update notifications — the diff/emit half of the poller.
 *
 * JiraNotifyEngine invokes `runJiraPollCycle` once a minute; this module owns
 * everything after the HTTP round-trip: change detection against the persisted
 * per-ticket snapshots, notification emission (card + OS toast + sound), the
 * assigned-tickets list, and the click target of a Jira card.
 *
 * Emission deliberately bypasses `addPaneNotification`: that path hard-requires
 * a tab whose layout contains the source terminalId (its suppression and
 * click-to-focus are pane-shaped). A Jira update has no pane, so the card is
 * added directly with a synthetic `terminalId` of `jira:<KEY>` — which also
 * makes the stack's one-card-per-terminal dedupe collapse repeat updates of
 * the same ticket into one card.
 */

import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { usePaneNotificationsStore } from "../store/paneNotificationsStore";
import { useJiraNotifyStore } from "../store/jiraNotifyStore";
import type { JiraTicketSnapshot } from "../store/recentProjectsSlice";
import { sendOsToast } from "./pane-notifications";
import { ensureProjectSound, playNotificationSound } from "./notification-sounds";
import { findJiraPair, jiraBaseTicket } from "./jira-layout";
import { buildTicketUrl, jiraSiteName } from "./jira";
import { jiraCliOfSession } from "./jira-mcp";
import { openJiraTicket } from "./jira-project";
import { defaultJiraSiteIn, jiraQK, siteForDirIn, siteForTabIn, splitJiraQK } from "./jira-sites";

/** Wire shape of one ticket from the Rust `jira_poll` command. */
export interface JiraTicketState {
  key: string;
  summary: string;
  status: string;
  assigneeName?: string | null;
  assigneeAccountId?: string | null;
  updated: string;
  lastComment?: {
    id: string;
    author: string;
    authorAccountId?: string | null;
    created: string;
    snippet: string;
  } | null;
}

interface JiraPollResult {
  tickets: JiraTicketState[];
  assigned: JiraTicketState[];
}

export interface JiraApiError {
  kind: "auth" | "rate" | "network" | "http" | "config";
  status?: number;
  message: string;
}

interface SiteWatchGroup {
  keys: string[];
  dirOf: Map<string, string>;
}

/** Watched = every non-archived ticket session across ALL projects — exactly
 * the rail's row source — BUCKETED BY SITE before the per-key dedupe, so an
 * identical key on two sites survives in both buckets (the 100-key cap is per
 * site). `dirOf` remembers which project dir a key came from (per-project
 * notification sound + host tab lookup). */
export function collectWatchedTicketsBySite(): Map<string, SiteWatchGroup> {
  const s = useAppStore.getState();
  const perSite = new Map<string, { newest: Map<string, number>; dirOf: Map<string, string> }>();
  for (const [dir, rows] of Object.entries(s.projectSessions)) {
    let site: string | null = null;
    for (const r of rows ?? []) {
      if (!r.ticket || r.archived) continue;
      site ??= siteForDirIn(s, dir);
      if (!site) continue;
      let bucket = perSite.get(site);
      if (!bucket) {
        bucket = { newest: new Map(), dirOf: new Map() };
        perSite.set(site, bucket);
      }
      const prev = bucket.newest.get(r.ticket);
      if (prev === undefined || r.createdAt > prev) {
        bucket.newest.set(r.ticket, r.createdAt);
        bucket.dirOf.set(r.ticket, dir);
      }
    }
  }
  const out = new Map<string, SiteWatchGroup>();
  for (const [site, bucket] of perSite) {
    out.set(site, {
      keys: [...bucket.newest.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 100)
        .map(([k]) => k),
      dirOf: bucket.dirOf,
    });
  }
  return out;
}

/** The Jira tab ON THIS SITE whose project holds this ticket's sessions. */
function hostTabFor(key: string, siteId: string): { id: string; workingDir: string } | null {
  const s = useAppStore.getState();
  for (const t of s.tabs) {
    if (!t.isJiraProject) continue;
    if (siteForTabIn(s, t) !== siteId) continue;
    const rows = s.projectSessions[t.workingDir.replace(/\\/g, "/")] ?? [];
    if (rows.some((r) => r.ticket === key)) return { id: t.id, workingDir: t.workingDir };
  }
  return null;
}

/** Is the user looking at this ticket right now? (Mirror of isSuppressed for
 * panes: on-screen IS the notification — which now also requires the app to
 * be FOCUSED, since the custom OS popups cover the unfocused case.) */
function isViewing(key: string, siteId: string): boolean {
  const s = useAppStore.getState();
  if (s.windowMinimized || !s.appWindowFocused) return false;
  const tab = s.tabs.find((t) => t.id === s.activeTabId);
  if (!tab?.isJiraProject || !tab.selectedJiraTicket) return false;
  if (siteForTabIn(s, tab) !== siteId) return false;
  return jiraBaseTicket(tab.selectedJiraTicket) === key;
}

interface UpdateFlavor {
  label: string;
  body: string;
}

/** Classify what changed, most newsworthy first. Returns null when the change
 * is only the user's own comment (still advances the snapshot). */
function classify(
  t: JiraTicketState,
  snap: JiraTicketSnapshot,
  myAccountId: string,
): UpdateFlavor | null {
  const c = t.lastComment;
  if (c && c.id && c.id !== snap.lastCommentId) {
    if (myAccountId && c.authorAccountId === myAccountId) return null;
    return { label: `New comment · ${c.author || "someone"}`, body: c.snippet || "(no text)" };
  }
  if (snap.statusName !== undefined && t.status !== snap.statusName) {
    return { label: "Status changed", body: `Status: ${snap.statusName || "—"} → ${t.status || "—"}` };
  }
  if ((snap.assigneeAccountId ?? null) !== (t.assigneeAccountId ?? null)) {
    return {
      label: "Assignee changed",
      body: `Assignee: ${snap.assigneeName ?? "Unassigned"} → ${t.assigneeName ?? "Unassigned"}`,
    };
  }
  return { label: "Ticket updated", body: t.summary || "Ticket updated" };
}

function emitNotification(
  key: string,
  siteId: string,
  flavor: UpdateFlavor,
  dirOf: Map<string, string>,
): void {
  const s = useAppStore.getState();
  if (!(s.notifEnabled ?? true) || !(s.jiraNotifEnabled ?? true)) return;

  const qk = jiraQK(siteId, key);
  const host = hostTabFor(key, siteId);
  const multiSite = (s.jiraSites ?? []).length > 1;
  const now = new Date();
  const timeHHMM = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  usePaneNotificationsStore.getState().add({
    id: `jira:${qk}:${Date.now()}`,
    // Qualified — two sites' same-keyed tickets must not evict each other's
    // card through the one-card-per-terminal dedupe.
    terminalId: `jira:${qk}`,
    tabId: host?.id ?? "",
    projectName: key,
    paneLabel: multiSite ? `${flavor.label} · ${jiraSiteName(siteId) ?? siteId}` : flavor.label,
    body: flavor.body,
    kind: "jira",
    timeHHMM,
    addedAt: Date.now(),
    clickAction: `jira-open:${qk}`,
  });

  if (s.windowMinimized && (s.notifSystemMinimized ?? true)) {
    void sendOsToast(`${key} · ${flavor.label}`, flavor.body);
  }

  if (s.notifSoundEnabled ?? true) {
    const dir =
      dirOf.get(key) ??
      host?.workingDir ??
      s.tabs.find((t) => t.isJiraProject)?.workingDir ??
      "";
    if (dir) {
      const soundId = ensureProjectSound(dir);
      // "jira" = base recipe, single hit — an external ticket update must
      // never sound like a blocked CLI (that's the permission double-hit).
      if (soundId) playNotificationSound(soundId, "jira");
    }
  }
}

/** One site's poll: fetch, diff, notify, persist. Throws JiraApiError-shaped
 * objects for the caller's per-site error handling. Returns the site's
 * qualified keep-keys for the cycle-level prune. */
async function pollOneSite(
  siteId: string,
  group: SiteWatchGroup,
  includeAssigned: boolean,
): Promise<string[]> {
  const s = useAppStore.getState();
  const snaps = s.jiraTicketSnapshots ?? {};
  const prevUpdated: Record<string, string> = {};
  for (const k of group.keys) {
    const snap = snaps[jiraQK(siteId, k)];
    if (snap) prevUpdated[k] = snap.updatedIso;
  }

  const result = await invoke<JiraPollResult>("jira_poll", {
    baseUrl: siteId,
    email: s.jiraApiEmail,
    token: s.jiraApiToken,
    keys: group.keys,
    prevUpdated,
    includeAssigned,
  });

  // Watched first (they carry lastComment); assigned entries only fill gaps —
  // a ticket both watched and assigned diffs once, with the richer data.
  const seen = new Set<string>();
  const all: JiraTicketState[] = [];
  for (const t of [...result.tickets, ...result.assigned]) {
    if (seen.has(t.key)) continue;
    seen.add(t.key);
    all.push(t);
  }

  const fresh = useAppStore.getState();
  const myAccountId = fresh.jiraMyAccountId ?? "";
  for (const t of all) {
    const qk = jiraQK(siteId, t.key);
    const snap = (fresh.jiraTicketSnapshots ?? {})[qk];
    const viewing = isViewing(t.key, siteId);
    let unseen = snap?.unseen ?? false;

    if (!snap) {
      // First sighting: baseline silently — no card, no highlight. Covers
      // fresh setup, week-long offline gaps AND the multi-site migration's
      // bare→qualified re-key without a notification storm.
      unseen = false;
    } else if (snap.updatedIso !== t.updated) {
      const flavor = classify(t, snap, myAccountId);
      if (flavor && !viewing) {
        unseen = true;
        emitNotification(t.key, siteId, flavor, group.dirOf);
      } else if (viewing) {
        unseen = false;
      }
    } else if (viewing) {
      unseen = false;
    }

    fresh.setJiraTicketSnapshot(qk, {
      updatedIso: t.updated,
      lastCommentId: t.lastComment?.id ?? snap?.lastCommentId,
      statusName: t.status,
      assigneeAccountId: t.assigneeAccountId ?? undefined,
      assigneeName: t.assigneeName ?? undefined,
      summary: t.summary || snap?.summary,
      unseen,
    });
  }

  if (includeAssigned) {
    fresh.setJiraAssignedTicketsForSite(
      siteId,
      result.assigned.map((t) => ({
        key: t.key,
        summary: t.summary,
        status: t.status,
        updatedIso: t.updated,
        siteId,
      })),
    );
  }

  return [...group.keys, ...result.assigned.map((t) => t.key)].map((k) => jiraQK(siteId, k));
}

/** One full poll cycle over EVERY configured site. Per-site failures are
 * isolated: auth pauses THAT site (Settings shows it), rate backs THAT site
 * off, network skips silently — the other sites keep polling. Sequential
 * awaits are the stagger. */
export async function runJiraPollCycle(): Promise<void> {
  const s = useAppStore.getState();
  const groups = collectWatchedTicketsBySite();
  const includeAssigned = s.jiraAssignedMode ?? false;
  const sites = s.jiraSites ?? [];
  const notify = useJiraNotifyStore.getState();

  // Prune ONLY after a fully clean cycle: a paused/failed site's baselines
  // must not be wiped by the union of the others.
  let allClean = sites.length > 0;
  const keepUnion: string[] = [];

  for (const siteId of sites) {
    if (notify.siteAuthErrors[siteId]) {
      allClean = false;
      continue;
    }
    const bo = notify.siteBackoff[siteId];
    if (bo && Date.now() < bo.until) {
      allClean = false;
      continue;
    }
    const group = groups.get(siteId) ?? { keys: [], dirOf: new Map<string, string>() };
    if (group.keys.length === 0 && !includeAssigned) continue;
    try {
      keepUnion.push(...(await pollOneSite(siteId, group, includeAssigned)));
      if (bo) notify.setSiteBackoff(siteId, null);
    } catch (e) {
      allClean = false;
      const err = e as JiraApiError;
      if (err?.kind === "auth") {
        notify.setSiteAuthError(siteId, err.message || "Jira rejected the credentials");
      } else if (err?.kind === "rate") {
        const ms = Math.min((bo?.ms ?? 60_000) * 2, 480_000);
        notify.setSiteBackoff(siteId, { ms, until: Date.now() + ms });
      }
      // network/http/config: silent skip — next cycle retries.
    }
  }

  if (allClean) useAppStore.getState().pruneJiraTicketSnapshots(keepUnion);
}

/**
 * Where a Jira card's click lands, best target first: the open pair, a
 * reopenable session row, the Assigned tab's browser preview, the OS browser.
 * Takes the QUALIFIED key (`<origin>|<KEY>`); every scan filters by the
 * ticket's own site so a same-keyed ticket on another site can't hijack it.
 */
export function openTicketFromNotification(qkey: string): void {
  const s = useAppStore.getState();
  const split = splitJiraQK(qkey);
  const key = split.key;
  const siteId = split.siteId || defaultJiraSiteIn(s);
  const qk = jiraQK(siteId, key);

  for (const t of s.tabs) {
    if (!t.isJiraProject || siteForTabIn(s, t) !== siteId) continue;
    if (t.layout && findJiraPair(t.layout, key)) {
      if (s.activeTabId !== t.id) s.setActiveTab(t.id);
      s.setSelectedJiraTicket(t.id, key);
      s.markJiraTicketSeen(qk);
      return;
    }
  }

  for (const t of s.tabs) {
    if (!t.isJiraProject || siteForTabIn(s, t) !== siteId) continue;
    const rows = s.projectSessions[t.workingDir.replace(/\\/g, "/")] ?? [];
    const row = rows.find((r) => r.ticket === key && !r.archived);
    if (row) {
      if (s.activeTabId !== t.id) s.setActiveTab(t.id);
      openJiraTicket(t.id, { ticket: key, cli: jiraCliOfSession(row.type), resumeId: row.id });
      s.markJiraTicketSeen(qk);
      return;
    }
  }

  const jiraTab = s.tabs.find((t) => t.isJiraProject && siteForTabIn(s, t) === siteId)
    ?? s.tabs.find((t) => t.isJiraProject);
  if (jiraTab && (s.jiraAssignedMode ?? false)) {
    if (s.activeTabId !== jiraTab.id) s.setActiveTab(jiraTab.id);
    const notify = useJiraNotifyStore.getState();
    notify.setRailTab(jiraTab.id, "assigned");
    notify.setAssignedPreview(jiraTab.id, qk);
    s.markJiraTicketSeen(qk);
    return;
  }

  const url = buildTicketUrl(siteId, key);
  if (url) window.open(url);
  s.markJiraTicketSeen(qk);
}
