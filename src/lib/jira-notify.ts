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
import type {
  JiraListTicket,
  JiraStatusCategoryKey,
  JiraTicketSnapshot,
} from "../store/recentProjectsSlice";
import { sendOsToast } from "./pane-notifications";
import { ensureProjectSound, playNotificationSound } from "./notification-sounds";
import { findJiraPair, jiraBaseTicket } from "./jira-layout";
import { buildTicketUrl, jiraSiteName, ticketProjectKey } from "./jira";
import { DEFAULT_JIRA_SORT } from "../store/recentProjectsSlice";
import { jiraCliOfSession } from "./jira-mcp";
import { openJiraTicket } from "./jira-project";
import { defaultJiraSiteIn, jiraQK, siteForDirIn, siteForTabIn, splitJiraQK } from "./jira-sites";
import { fieldSpecFor } from "./jira-fields";

/** Wire shape of one ticket from the Rust `jira_poll` command.
 *
 *  Everything past the original five is OPTIONAL even though Rust always emits
 *  it: the same shape is mapped straight into the PERSISTED rail rows, and a
 *  store written by an older build carries none of these. */
export interface JiraTicketState {
  key: string;
  summary: string;
  status: string;
  /** `statusCategory.key` — the coarse To do / In progress / Done bucket. */
  statusCategory?: JiraStatusCategoryKey | null;
  assigneeName?: string | null;
  assigneeAccountId?: string | null;
  reporterName?: string | null;
  priorityName?: string | null;
  priorityId?: string | null;
  /** JSM "Organizations" — the customer company that raised the ticket. Only
   *  populated once the site's custom-field id has been discovered. */
  organization?: string | null;
  /** JSM "Request Type" — which request form the ticket came in on. */
  requestType?: string | null;
  /** User-picked extra fields, keyed by Jira field id, already flattened. */
  extra?: Record<string, string> | null;
  created?: string;
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

/** Wire row → persisted rail row. One place, so the Assigned and Unassigned
 *  lists can never drift apart in shape. */
export function toJiraListTicket(t: JiraTicketState, siteId: string): JiraListTicket {
  return {
    key: t.key,
    summary: t.summary,
    status: t.status,
    statusCategory: t.statusCategory ?? undefined,
    updatedIso: t.updated,
    createdIso: t.created || undefined,
    priorityName: t.priorityName ?? undefined,
    priorityId: t.priorityId ?? undefined,
    reporterName: t.reporterName ?? undefined,
    organization: t.organization ?? undefined,
    requestType: t.requestType ?? undefined,
    extra: t.extra ?? undefined,
    siteId,
  };
}


export interface JiraApiError {
  kind: "auth" | "rate" | "network" | "http" | "config";
  status?: number;
  message: string;
}

interface SiteWatchGroup {
  keys: string[];
  dirOf: Map<string, string>;
  /** Distinct Jira PROJECT keys seen on this site ("SUPPORT", "DEV") — what
   *  scopes the unassigned query. Collected BEFORE the 100-key cap, so a busy
   *  sibling project can't crowd a quiet one out of the queue entirely. */
  projectKeys: string[];
}

/** Watched = every non-archived ticket session across ALL projects — exactly
 * the rail's row source — BUCKETED BY SITE before the per-key dedupe, so an
 * identical key on two sites survives in both buckets (the 100-key cap is per
 * site). `dirOf` remembers which project dir a key came from (per-project
 * notification sound + host tab lookup). */
export function collectWatchedTicketsBySite(): Map<string, SiteWatchGroup> {
  const s = useAppStore.getState();
  const perSite = new Map<
    string,
    { newest: Map<string, number>; dirOf: Map<string, string>; projects: Set<string> }
  >();
  for (const [dir, rows] of Object.entries(s.projectSessions)) {
    let site: string | null = null;
    for (const r of rows ?? []) {
      if (!r.ticket || r.archived) continue;
      site ??= siteForDirIn(s, dir);
      if (!site) continue;
      let bucket = perSite.get(site);
      if (!bucket) {
        bucket = { newest: new Map(), dirOf: new Map(), projects: new Set() };
        perSite.set(site, bucket);
      }
      bucket.projects.add(ticketProjectKey(r.ticket));
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
      projectKeys: [...bucket.projects],
    });
  }
  return out;
}

/** Project keys to scope one site's unassigned query: whatever its ticket rows
 *  imply, plus the per-site override. The override is what covers a brand-new
 *  Jira tab with no rows yet — the user who most wants an unassigned queue and
 *  would otherwise get a permanently empty one. */
export function unassignedProjectsFor(siteId: string, derived: string[]): string[] {
  const s = useAppStore.getState();
  const override = (s.jiraUnassignedProjects ?? {})[siteId] ?? [];
  return [...new Set([...derived, ...override.map((k) => k.toUpperCase())])];
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
    fields: await fieldSpecFor(siteId),
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
      // Meta-line facts for the Tickets tab. Fall back to the previous
      // snapshot so a partial response never blanks a column.
      statusCategory: t.statusCategory ?? snap?.statusCategory,
      createdIso: t.created || snap?.createdIso,
      priorityName: t.priorityName ?? snap?.priorityName,
      priorityId: t.priorityId ?? snap?.priorityId,
      reporterName: t.reporterName ?? snap?.reporterName,
      organization: t.organization ?? snap?.organization,
      requestType: t.requestType ?? snap?.requestType,
      extra: t.extra ?? snap?.extra,
    });
  }

  if (includeAssigned) {
    fresh.setJiraAssignedTicketsForSite(
      siteId,
      result.assigned.map((t) => toJiraListTicket(t, siteId)),
    );
  }

  return [...group.keys, ...result.assigned.map((t) => t.key)].map((k) => jiraQK(siteId, k));
}

/**
 * The unassigned queue for ONE site.
 *
 * Deliberately not folded into pollOneSite: a 400 here (bad project key, no
 * Browse permission) must cost nothing but this list. It writes NO snapshots,
 * runs NO change detection and emits NO cards — and that is load-bearing, not
 * an omission. Snapshots are pruned to the union of the keys pollOneSite
 * returns, so an unassigned key writing one would be wiped every clean cycle
 * and rewritten on the next poll, churning persisted state forever.
 */
async function pollQueueForSite(
  siteId: string,
  kind: JiraQueueKind,
  projectKeys: string[],
): Promise<void> {
  const s = useAppStore.getState();
  const sortFor = kind === "unassigned" ? "unassigned" : "assigned";
  const sort = (s.jiraListSort ?? DEFAULT_JIRA_SORT)[sortFor] ?? DEFAULT_JIRA_SORT[sortFor];
  const rows = await invoke<JiraTicketState[]>("jira_search_queue", {
    baseUrl: siteId,
    email: s.jiraApiEmail,
    token: s.jiraApiToken,
    kind,
    projectKeys,
    sortKey: sort.key,
    sortDir: sort.dir,
    fields: await fieldSpecFor(siteId),
  });
  const mapped = rows.map((t) => toJiraListTicket(t, siteId));
  const fresh = useAppStore.getState();
  if (kind === "unassigned") {
    fresh.setJiraUnassignedTicketsForSite(siteId, mapped);
    announceUnassigned(siteId, rows);
  } else {
    // No announce: a ticket YOU resolved is not news.
    fresh.setJiraAssignedDoneTicketsForSite(siteId, mapped);
  }
}

/**
 * Announce tickets that have just appeared in the unassigned queue.
 *
 * Uses its own `jiraUnassignedSeen` set rather than the snapshot map — see that
 * store field for why a snapshot here would re-announce the same ticket every
 * poll, forever.
 *
 * FIRST SIGHTING IS SILENT. The first poll of a site (or the first after the
 * queue is switched on) would otherwise fire one card per open ticket; instead
 * that whole batch is baselined and only genuinely new arrivals notify. Same
 * rule the watched-ticket path uses, for the same reason.
 */
function announceUnassigned(siteId: string, rows: JiraTicketState[]): void {
  const s = useAppStore.getState();
  const qkeys = rows.map((t) => jiraQK(siteId, t.key));
  const seen = new Set(s.jiraUnassignedSeen ?? []);
  const fresh = rows.filter((t) => !seen.has(jiraQK(siteId, t.key)));

  const siteBaselined = (s.jiraUnassignedSeen ?? []).some((k) => k.startsWith(`${siteId}|`));
  const notifyOn =
    (s.notifEnabled ?? true)
    && (s.jiraNotifEnabled ?? true)
    && (s.jiraUnassignedNotify ?? true);

  if (siteBaselined && notifyOn) {
    for (const t of fresh) {
      emitNotification(
        t.key,
        siteId,
        { label: "Unassigned ticket", body: t.summary || "Nobody has picked this up yet." },
        new Map(),
      );
    }
  }
  // Marked seen even when notifications are off, so switching them on later
  // announces what arrives NEXT rather than the whole standing queue.
  useAppStore.getState().markJiraUnassignedSeen(qkeys);
}

export type JiraQueueKind = "unassigned" | "assignedDone";

/** At most one queue fetch per site per UNASSIGNED_MIN_MS. An unassigned
 *  support queue changes on the order of minutes, and the rows feed no
 *  notifications, so there is nothing to gain from matching the 60s tick. */
const UNASSIGNED_MIN_MS = 180_000;

/** Is any Jira tab actually showing its Unassigned list right now? The third
 *  cost gate: these rows are only ever looked at, never diffed, so fetching
 *  them while nothing displays them buys nothing. (The assigned list can't do
 *  this — it feeds notifications.) */
/** Every (tab, queue) pair currently ON SCREEN, from BOTH ticket surfaces:
 *  the rail's tab strip + Open/Done mini tab, and the v2 tree's expanded
 *  sub-groups. The tree half is not optional — without it the tree's queues
 *  never fill, because `railTab` is only ever set by the rail. */
export function visibleQueuePairs(): Array<{ tabId: string; kind: JiraQueueKind }> {
  const tabs = useAppStore.getState().tabs;
  const { railTab, assignedScope, treeQueues } = useJiraNotifyStore.getState();
  const out: Array<{ tabId: string; kind: JiraQueueKind }> = [];
  const seen = new Set<string>();
  const add = (tabId: string, kind: JiraQueueKind) => {
    const id = `${tabId}::${kind}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ tabId, kind });
  };
  for (const t of tabs) {
    if (!t.isJiraProject) continue;
    if (railTab[t.id] === "unassigned") add(t.id, "unassigned");
    // The Done half only fetches while it is the one on screen — the open
    // Assigned list is already in the main cycle and costs nothing extra.
    if (railTab[t.id] === "assigned" && assignedScope[t.id] === "done") {
      add(t.id, "assignedDone");
    }
    if (treeQueues[`${t.id}::unassigned`]) add(t.id, "unassigned");
    if (treeQueues[`${t.id}::assignedDone`]) add(t.id, "assignedDone");
  }
  return out;
}

function visibleQueues(): Set<JiraQueueKind> {
  return new Set(visibleQueuePairs().map((p) => p.kind));
}

/**
 * Poll everything NOW, for the Refresh button.
 *
 * The background cadence is deliberately unhurried (60s, and 180s for
 * unassigned), which is right for a notifier and wrong for the moment you know
 * something just changed in Jira and want to see it. This bypasses BOTH the
 * sub-cadence and the visibility gate for the named site, and clears that
 * site's backoff/auth pause first — a manual refresh is also how a user retries
 * after fixing their credentials.
 *
 * Resolves when the sweep is done so the button can show it finished.
 */
export async function refreshJiraNow(siteId?: string): Promise<void> {
  const notify = useJiraNotifyStore.getState();
  if (siteId) {
    notify.setSiteAuthError(siteId, null);
    notify.setSiteBackoff(siteId, null);
  } else {
    notify.clearSiteAuthErrors();
  }
  await runJiraPollCycle();
  if (siteId) {
    // Whatever queue is on screen right now, refreshed too — the cycle above
    // respects the 180s sub-cadence and an explicit Refresh must not.
    for (const kind of visibleQueues()) {
      if (kind === "unassigned" && !(useAppStore.getState().jiraUnassignedMode ?? false)) continue;
      await refreshUnassignedNow(siteId, kind);
    }
  }
  useJiraNotifyStore.getState().setLastPollAt(Date.now());
}

/** One immediate unassigned fetch, bypassing the sub-cadence — used when the
 *  user opens the tab, so the list is never stale-looking on arrival. */
export async function refreshUnassignedNow(
  siteId: string,
  kind: JiraQueueKind = "unassigned",
): Promise<void> {
  const notify = useJiraNotifyStore.getState();
  if (notify.siteAuthErrors[siteId]) return;
  const derived = collectWatchedTicketsBySite().get(siteId)?.projectKeys ?? [];
  const projectKeys = unassignedProjectsFor(siteId, derived);
  // Only the unassigned queue is project-scoped; assigned-done is site-wide.
  if (kind === "unassigned" && projectKeys.length === 0) return;
  try {
    await pollQueueForSite(siteId, kind, projectKeys);
    notify.setUnassignedError(siteId, null);
    notify.markUnassignedPolled(siteId);
  } catch (e) {
    notify.setUnassignedError(siteId, (e as JiraApiError)?.message || "Queue query failed");
  }
}

/** One full poll cycle over EVERY configured site. Per-site failures are
 * isolated: auth pauses THAT site (Settings shows it), rate backs THAT site
 * off, network skips silently — the other sites keep polling. Sequential
 * awaits are the stagger. */
export async function runJiraPollCycle(): Promise<void> {
  const s = useAppStore.getState();
  const groups = collectWatchedTicketsBySite();
  const includeAssigned = s.jiraAssignedMode ?? false;
  // Three gates, cheapest first: the setting (default off, so the common
  // configuration pays nothing), then "is anyone looking", then the cadence.
  const queuesWanted = visibleQueues();
  if (!(s.jiraUnassignedMode ?? false)) queuesWanted.delete("unassigned");
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
    const group = groups.get(siteId)
      ?? { keys: [], dirOf: new Map<string, string>(), projectKeys: [] };
    const projectKeys = unassignedProjectsFor(siteId, group.projectKeys);
    const dueForQueue =
      Date.now() - (notify.lastUnassignedAt[siteId] ?? 0) >= UNASSIGNED_MIN_MS;
    const queues = [...queuesWanted].filter(
      (k) => dueForQueue && (k !== "unassigned" || projectKeys.length > 0),
    );
    if (group.keys.length === 0 && !includeAssigned && queues.length === 0) continue;

    if (group.keys.length > 0 || includeAssigned) {
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

    // SECOND, INDEPENDENT try: a queue failure must never reach the block
    // above, whose results are the notifications people depend on.
    for (const kind of queues) {
      try {
        await pollQueueForSite(siteId, kind, projectKeys);
        notify.setUnassignedError(siteId, null);
        notify.markUnassignedPolled(siteId);
      } catch (e) {
        const err = e as JiraApiError;
        // 401 ONLY, deliberately narrower than the 401|403 above: a 403 on
        // THIS query is far more likely "no Browse permission on that project"
        // than bad credentials, and pausing the site for it would silently
        // kill the watched-ticket notifications.
        if (err?.kind === "auth" && err.status === 401) {
          notify.setSiteAuthError(siteId, err.message || "Jira rejected the credentials");
        } else if (err?.kind === "rate") {
          const ms = Math.min((notify.siteBackoff[siteId]?.ms ?? 60_000) * 2, 480_000);
          notify.setSiteBackoff(siteId, { ms, until: Date.now() + ms });
        } else {
          notify.setUnassignedError(siteId, err?.message || "Queue query failed");
        }
        // Deliberately does NOT clear allClean: a permanently mis-typed
        // project key would otherwise freeze snapshot pruning forever. The
        // last good rows are kept — a blip must not erase a list being read.
      }
    }
  }

  if (allClean) useAppStore.getState().pruneJiraTicketSnapshots(keepUnion);
}

/**
 * Re-read ONE ticket and write its snapshot with no diffing and no card.
 *
 * Used right after MADE itself writes to Jira (assign-to-me): the PUT bumps the
 * issue's `updated`, so the next ordinary cycle would classify the user's own
 * click as a change and notify them about themselves.
 */
export async function refreshJiraSnapshotSilently(siteId: string, key: string): Promise<void> {
  const s = useAppStore.getState();
  if (!s.jiraApiEmail || !s.jiraApiToken) return;
  try {
    const result = await invoke<JiraPollResult>("jira_poll", {
      baseUrl: siteId,
      email: s.jiraApiEmail,
      token: s.jiraApiToken,
      keys: [key],
      // Claim the current value as already-seen so no comment fetch is spent.
      prevUpdated: {},
      includeAssigned: false,
      fields: await fieldSpecFor(siteId),
    });
    const t = result.tickets.find((x) => x.key === key);
    if (!t) return;
    const qk = jiraQK(siteId, key);
    const fresh = useAppStore.getState();
    const snap = (fresh.jiraTicketSnapshots ?? {})[qk];
    fresh.setJiraTicketSnapshot(qk, {
      ...snap,
      updatedIso: t.updated,
      statusName: t.status,
      assigneeAccountId: t.assigneeAccountId ?? undefined,
      assigneeName: t.assigneeName ?? undefined,
      summary: t.summary || snap?.summary,
      statusCategory: t.statusCategory ?? snap?.statusCategory,
      createdIso: t.created || snap?.createdIso,
      priorityName: t.priorityName ?? snap?.priorityName,
      priorityId: t.priorityId ?? snap?.priorityId,
      reporterName: t.reporterName ?? snap?.reporterName,
      organization: t.organization ?? snap?.organization,
      requestType: t.requestType ?? snap?.requestType,
      extra: t.extra ?? snap?.extra,
      unseen: false,
    });
  } catch {
    // Best effort. Worst case the next cycle shows one "assignee changed"
    // card for the user's own action — noise, not breakage.
  }
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
