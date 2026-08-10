/**
 * Pasted-ticket detection for a Jira ticket browser's address bar.
 *
 * Paste `https://acme.atlassian.net/browse/SUPPORT-99` (or type `SUPPORT-99`)
 * into the browser pane of ticket SUPPORT-1 and you almost never meant "replace
 * SUPPORT-1's page" — you meant "work SUPPORT-99 too". So we open it as a
 * first-class ticket: its own pane on the default CLI, its own browser, its own
 * rail row. SUPPORT-1's pane never leaves SUPPORT-1.
 *
 * **The trigger is the address bar and nothing else.** The obvious hook is
 * `subscribeBrowserNavigated`, which Rust fires for every real navigation — but
 * then browsing a linked-issues list would spawn a CLI per click, each starting
 * a paid investigation nobody asked for. Typing into the address bar is an
 * explicit act, which is also why no rate cap is needed: the user is the cap.
 */

import { useAppStore } from "../store";
import { useJiraTicketToastStore } from "../store/jiraTicketToastStore";
import type { DetectedTicketReason } from "../store/jiraTicketToastStore";
import type { ProjectSession, Tab } from "../types";
import { isTicketKey, normalizeTicketKey, ticketProjectKey } from "./jira";
import {
  JIRA_BROWSER_PANE_PREFIX,
  findJiraPair,
  jiraBaseTicket,
  jiraInstanceKey,
  listJiraInstanceKeys,
} from "./jira-layout";
import { jiraCliOfSession } from "./jira-mcp";
import { openJiraTicket, rememberedModel } from "./jira-project";
import { siteForTab } from "./jira-sites";

/**
 * The ticket in what someone typed into the address bar, or null for "this is
 * ordinary input, navigate to it".
 *
 * Two shapes count, and only two:
 *  - a bare canonical key (`SUPPORT-99`), which the omnibox rule currently
 *    sends to a Google search — never what typing a ticket key into a Jira
 *    pane meant — but ONLY when its prefix is one this project actually uses
 *    (`knownPrefixes`). The ticket regex also matches `UTF-8`, and a search
 *    term must not spawn a paid investigation into a ticket that isn't one;
 *  - a URL **on the configured Jira site**.
 *
 * The origin check is load-bearing. `normalizeTicketKey` will happily pull
 * `ISSUE-12` out of a GitHub URL, and consuming that would hijack an ordinary
 * paste to open a ticket that does not exist. A URL needs no prefix check —
 * being on the Jira site is already proof.
 */
export function ticketFromOmniboxInput(
  raw: string,
  siteOrigins: readonly string[],
  knownPrefixes: ReadonlySet<string>,
): { key: string; siteId: string | null } | null {
  const typed = raw.trim();
  if (!typed) return null;

  const upper = typed.toUpperCase();
  if (isTicketKey(upper)) {
    // Bare keys carry no site — the caller resolves them to the SOURCE
    // pane's tab site (one site per tab).
    return knownPrefixes.has(upper.slice(0, upper.lastIndexOf("-")))
      ? { key: upper, siteId: null }
      : null;
  }

  // Everything else has to parse as a URL on one of the CONFIGURED Jira
  // sites. A schemeless `acme.atlassian.net/browse/X` is accepted the same
  // way the address bar itself accepts it. The matched site is returned so
  // the caller can enforce the one-site-per-tab rule.
  const absolute = /^https?:\/\//i.test(typed) ? typed : `https://${typed}`;
  let origin: string;
  try {
    origin = new URL(absolute).origin.toLowerCase();
  } catch {
    return null;
  }
  if (!origin || origin === "null") return null;
  const matched = siteOrigins.find((s) => {
    try {
      return new URL(s.trim()).origin.toLowerCase() === origin;
    } catch {
      return false;
    }
  });
  if (!matched) return null;

  const key = normalizeTicketKey(absolute);
  return key ? { key, siteId: matched } : null;
}

/** Ticket prefixes this project demonstrably uses: the remembered new-ticket
 *  acronyms, every prefix already on a rail row, and the source pane's own —
 *  which is a ticket by definition. Gates the BARE-key form only. */
function knownTicketPrefixes(projectKey: string, sourceTicket: string): Set<string> {
  const store = useAppStore.getState();
  const prefixes = new Set<string>();
  const add = (key: string) => prefixes.add(ticketProjectKey(key));
  for (const a of store.jiraAcronyms ?? []) prefixes.add(a.toUpperCase());
  for (const s of store.projectSessions[projectKey] ?? []) if (s.ticket) add(s.ticket);
  add(sourceTicket);
  return prefixes;
}

/** The tab whose canvas the user actually typed in. Two tabs on one project can
 *  hold the same ticket's pair, so the active tab wins; the scan is the
 *  fallback for a popped-out floating pane. */
function findOwningTab(sourceTicket: string): Tab | null {
  const { tabs, activeTabId } = useAppStore.getState();
  const active = tabs.find((t) => t.id === activeTabId);
  if (active?.isJiraProject && findJiraPair(active.layout, sourceTicket)) return active;
  return tabs.find((t) => t.isJiraProject && findJiraPair(t.layout, sourceTicket)) ?? null;
}

/** Which row of a ticket to resume when several exist: the original instance,
 *  else the most recent duplicate. */
function pickRow(rows: ProjectSession[]): ProjectSession {
  return (
    rows.find((s) => (s.ticketInstance ?? 1) === 1) ??
    [...rows].sort((a, b) => b.createdAt - a.createdAt)[0]
  );
}

/** Raise the toast, working out whether a Switch button is meaningful by
 *  reading the state AFTER the open — in auto mode the canvas is already
 *  there and a Switch button would be a no-op button. */
function announce(
  tabId: string,
  ticket: string,
  instKey: string,
  reason: DetectedTicketReason,
): void {
  const tab = useAppStore.getState().tabs.find((t) => t.id === tabId);
  useJiraTicketToastStore.getState().show({
    ticket,
    instKey,
    tabId,
    reason,
    canSwitch: tab?.selectedJiraTicket !== instKey,
  });
}

/**
 * Handle address-bar input in a Jira ticket browser.
 *
 * Returns **true** when the input was consumed — the caller must NOT navigate,
 * and should put the address bar back on the page it is showing. Returns false
 * for everything else, which is today's behaviour unchanged.
 */
export function consumeJiraTicketPaste(paneId: string | undefined, raw: string): boolean {
  if (!paneId?.startsWith(JIRA_BROWSER_PANE_PREFIX)) return false;

  const store = useAppStore.getState();
  if (!store.jiraDetectPastedTickets) return false;

  // The owning tab is resolved BEFORE the input is parsed: the bare-key form is
  // gated on prefixes this project uses, which only the project can supply —
  // and the tab is what carries the site (one site per tab).
  const sourceTicket = paneId.slice(JIRA_BROWSER_PANE_PREFIX.length);
  const tab = findOwningTab(sourceTicket);
  if (!tab?.workingDir) return false;
  const projectKey = tab.workingDir.replace(/\\/g, "/");

  // Without a site there is nowhere to point the new ticket's browser, and a
  // pair on about:blank is worse than a plain navigation.
  const tabSite = siteForTab(tab);
  if (!tabSite) return false;

  const result = ticketFromOmniboxInput(
    raw,
    store.jiraSites ?? [],
    knownTicketPrefixes(projectKey, sourceTicket),
  );
  if (!result) return false;
  // A URL from ANOTHER configured site is a plain navigation, never a ticket
  // open — opening it here would violate one-site-per-tab.
  if (result.siteId && result.siteId !== tabSite) return false;
  const ticket = result.key;

  // This pane's own ticket is "go home", not a new ticket.
  if (ticket === sourceTicket) return false;

  const manual = store.jiraAutoSwitchToDetected === "manual";
  const select = !manual;

  // 1. Already on the canvas — switch to it, never a second pair.
  const openKey = listJiraInstanceKeys(tab.layout).find((k) => jiraBaseTicket(k) === ticket);
  if (openKey) {
    if (select) store.setSelectedJiraTicket(tab.id, openKey);
    else announce(tab.id, ticket, openKey, "already-open");
    return true;
  }

  const rows = (store.projectSessions[projectKey] ?? []).filter((s) => s.ticket === ticket);
  const live = rows.filter((s) => !s.archived);

  // 2. A live row — resume it, exactly as clicking the rail row does. On the
  //    row's OWN cli: resuming a Codex thread as Claude resumes nothing.
  //
  //    Deliberately NOT gated on `sessionStillExists`: that check is async and
  //    this must answer the keydown synchronously (consume, or navigate — there
  //    is no third answer to give the address bar). A vanished transcript
  //    therefore surfaces as a failed resume in the new pane, the same way the
  //    rail behaves when its own best-effort check fails open.
  if (live.length > 0) {
    const row = pickRow(live);
    openJiraTicket(tab.id, {
      ticket,
      cli: jiraCliOfSession(row.type),
      resumeId: row.id,
      instance: row.ticketInstance,
      select,
    });
    if (manual) announce(tab.id, ticket, jiraInstanceKey(ticket, row.ticketInstance), "resumed");
    return true;
  }

  // 3. Only archived rows. Both outcomes are announced in BOTH modes —
  //    unarchiving undoes something the user did on purpose, and refusing to
  //    is equally worth knowing.
  if (rows.length > 0) {
    if (store.jiraArchivedTicketAction === "resume") {
      const row = pickRow(rows);
      store.setProjectSessionArchived(tab.workingDir, row.id, false);
      openJiraTicket(tab.id, {
        ticket,
        cli: jiraCliOfSession(row.type),
        resumeId: row.id,
        instance: row.ticketInstance,
        select,
      });
      announce(tab.id, ticket, jiraInstanceKey(ticket, row.ticketInstance), "archived-resumed");
      return true;
    }
    // Start fresh and leave the archive alone. The archived rows already own
    // instance numbers, so this takes the next free one rather than colliding
    // with a name that is still in the rail's archived section.
    const instance = Math.max(1, ...rows.map((s) => s.ticketInstance ?? 1)) + 1;
    const cli = store.jiraCli ?? "claude";
    openJiraTicket(tab.id, {
      ticket,
      instance,
      cli,
      model: rememberedModel(store, cli),
      swedish: store.jiraReplyInSwedish,
      english: store.jiraReplyInEnglish,
      select,
    });
    announce(tab.id, ticket, jiraInstanceKey(ticket, instance), "archived-new");
    return true;
  }

  // 4. Never seen — a fresh ticket on the same defaults the new-ticket dialog
  //    remembers, investigation prompt included.
  const cli = store.jiraCli ?? "claude";
  openJiraTicket(tab.id, {
    ticket,
    cli,
    model: rememberedModel(store, cli),
    swedish: store.jiraReplyInSwedish,
    english: store.jiraReplyInEnglish,
    select,
  });
  if (manual) announce(tab.id, ticket, ticket, "opened");
  return true;
}
