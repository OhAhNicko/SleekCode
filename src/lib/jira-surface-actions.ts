import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { usePaneNotificationsStore } from "../store/paneNotificationsStore";
import { refreshJiraSnapshotSilently } from "./jira-notify";
import type { Tab } from "../types";
import type { SurfaceActions } from "./surface-actions";
import type { TicketRow } from "../hooks/useJiraTicketRows";
import { defaultNameOf, instKeyOf } from "../hooks/useJiraTicketRows";
import {
  navigateToTicket,
  duplicateJiraTicket,
  closeJiraInstanceInAllTabs,
  openJiraTicket,
  type JiraDuplicateMode,
} from "./jira-project";
import { pasteTextToTerminal } from "./terminal-paste";
import { buildJiraPrompt, buildTicketUrl, DEFAULT_JIRA_PROMPT } from "./jira";
import { chooseOption, confirmAction, promptForInput } from "./prompt-modal";
import { clearTicketForTerminal } from "./jira-session";
import { jiraCliOfSession, JIRA_CLI_LABEL } from "./jira-mcp";
import { useJiraNotifyStore } from "../store/jiraNotifyStore";
import { jiraQK, splitJiraQK, siteForTabIn } from "./jira-sites";
import {
  findJiraTermLeaf,
  removeJiraInstanceTerm,
  listJiraInstanceKeys,
  jiraBaseTicket,
} from "./jira-layout";

/**
 * Context-menu handlers for Jira ticket and assigned rows, shared by the two
 * surfaces that render them: `JiraTicketRail` (one tab) and the vertical tab
 * bar's v2 ticket tree (any number of tabs at once).
 *
 * `registerSurfaceActions` is keyed by ROLE and overwrites
 * (`surface-actions.ts` — `registry[role] = actions`), so a component that
 * renders several projects must register ONCE and resolve the owning tab from
 * the row id. That is what the resolver argument is for; the rail's resolver
 * simply always answers with its own tab.
 */

export interface JiraTicketTarget {
  row: TicketRow;
  tab: Tab;
  /** Session ids whose transcript is definitively gone. */
  missing: Set<string>;
  focusTerminal: (terminalId: string) => void;
  /** The row's primary action — same one a plain click runs. */
  openRow: (row: TicketRow) => void;
}

/** Close ONE instance's pane if it is open. The ticket's shared browser goes
 *  away only with the last instance; the canvas falls back to a sibling
 *  instance first, then any other open ticket. */
function closeTicketPair(tab: Tab, row: TicketRow): void {
  const ticket = row.session.ticket;
  if (!ticket) return;
  const store = useAppStore.getState();
  const cur = store.tabs.find((t) => t.id === tab.id);
  if (!cur?.layout) return;
  const instKey = instKeyOf(row.session);
  const leaf = findJiraTermLeaf(cur.layout, instKey);
  if (!leaf) return;
  const next = removeJiraInstanceTerm(cur.layout, instKey);
  store.removeTerminals([leaf.terminalId]);
  // Resume spawns park a name record the mint path never consumes.
  clearTicketForTerminal(leaf.terminalId);
  store.updateTabLayout(tab.id, next);
  if (cur.selectedJiraTicket === instKey) {
    const remaining = listJiraInstanceKeys(next);
    const sibling = remaining.find((k) => jiraBaseTicket(k) === ticket);
    store.setSelectedJiraTicket(tab.id, sibling ?? remaining[0]);
  }
}

export function buildJiraTicketActions(
  resolve: (id: string) => JiraTicketTarget | null,
): SurfaceActions {
  return {
    open: (id) => {
      const t = resolve(id);
      if (t) t.openRow(t.row);
    },
    openInBrowser: (id) => {
      const t = resolve(id);
      const ticket = t?.row.session.ticket;
      if (t && ticket) navigateToTicket(t.tab.id, ticket);
    },
    closePane: (id) => {
      const t = resolve(id);
      if (t?.row.terminalId) closeTicketPair(t.tab, t.row);
    },
    // The investigation prompt a fresh ticket is opened WITH. Panes that never
    // got one — an empty sub-ticket, a fork, a resumed conversation — can ask
    // for it here. Pasted, never submitted: a menu click must not fire a prompt
    // into a pane that is mid-answer, and this way the wording can still be
    // edited before it goes.
    sendPrompt: (id) => {
      const t = resolve(id);
      if (!t?.row.terminalId || !t.row.session.ticket) return;
      const store = useAppStore.getState();
      pasteTextToTerminal(
        t.row.terminalId,
        buildJiraPrompt(
          store.jiraPromptTemplate || DEFAULT_JIRA_PROMPT,
          t.row.session.ticket,
          store.jiraReplyInSwedish ? "sv" : store.jiraReplyInEnglish ? "en" : undefined,
        ),
      );
      t.focusTerminal(t.row.terminalId);
    },
    rename: (id) => {
      const t = resolve(id);
      if (!t?.row.session.ticket) return;
      const { tab, row } = t;
      const ticket = row.session.ticket!;
      const projectKey = tab.workingDir.replace(/\\/g, "/");
      // Reset target is group-aware: while duplicates exist the default is the
      // numbered form, so an emptied name rejoins the "#n" convention.
      const grouped =
        (useAppStore.getState().projectSessions[projectKey] ?? []).filter(
          (s) => s.ticket === ticket,
        ).length > 1;
      const fallback = grouped
        ? `${ticket} #${row.session.ticketInstance ?? 1}`
        : defaultNameOf(row.session);
      const current = row.session.name || fallback;
      void promptForInput({
        title: "Rename ticket",
        label: "Name",
        initialValue: current,
        confirmLabel: "Rename",
        detail:
          "Shown in the ticket list, and set as the Claude session name (--name) the next time this pane launches. Leave empty to reset to the ticket key.",
      }).then((value) => {
        if (value === null) return; // cancelled
        const name = value.trim() || fallback;
        if (name === row.session.name) return;
        useAppStore.getState().renameProjectSession(tab.workingDir, id, name);
      });
    },
    duplicate: (id) => {
      const t = resolve(id);
      if (!t?.row.session.ticket) return;
      const { tab, row, missing } = t;
      const ticket = row.session.ticket!;
      // Forking replays the source transcript, so it needs the file to still
      // exist; an open pane always has one.
      const gone = !row.terminalId && missing.has(row.session.id);
      // `--fork-session` is a Claude flag; Codex and Gemini have nothing
      // equivalent, so the option is HIDDEN on their rows rather than shown
      // greyed — it can never apply there, it isn't merely unavailable now.
      const cli = jiraCliOfSession(row.session.type);
      void chooseOption({
        title: "Create sub-ticket",
        detail: `${ticket}: a second, independent ${JIRA_CLI_LABEL[cli]} session on the same ticket. Both share the ticket's browser pane.`,
        choices: [
          ...(cli === "claude"
            ? [
                {
                  id: "fork",
                  label: "Fork conversation",
                  detail: "Starts from a copy of this conversation so far.",
                  unavailable: gone
                    ? { reason: "This conversation's transcript is gone" }
                    : undefined,
                },
              ]
            : []),
          {
            id: "prompt",
            label: "Fresh investigation",
            detail: "New conversation — the investigation prompt is sent again.",
          },
          {
            id: "empty",
            label: "Empty pane",
            detail: "New conversation — nothing is sent.",
          },
        ],
      }).then((mode) => {
        if (mode) duplicateJiraTicket(tab.id, row.session, mode as JiraDuplicateMode);
      });
    },
    toggleArchive: (id) => {
      const t = resolve(id);
      if (!t) return;
      const { tab, row } = t;
      // All-tabs close, not closeTicketPair: a second tab on the same project
      // can hold this instance's pane, and a pane that survives archiving
      // resumes from the persisted layout on the next launch.
      if (!row.session.archived) {
        closeJiraInstanceInAllTabs(tab.workingDir, instKeyOf(row.session));
      }
      useAppStore
        .getState()
        .setProjectSessionArchived(tab.workingDir, id, !row.session.archived);
    },
    del: (id) => {
      const t = resolve(id);
      if (!t) return;
      const { tab, row } = t;
      const ticket = row.session.ticket ?? "this ticket";
      void confirmAction({
        title: "Delete ticket",
        detail: `${ticket}: closes its panes and removes it from MADE entirely. The conversation file on disk is kept.`,
        confirmLabel: "Delete",
        danger: true,
      }).then((ok) => {
        if (!ok) return;
        // All tabs, same reasoning as archive: a leaf surviving in another
        // tab's layout would respawn a session whose row no longer exists.
        closeJiraInstanceInAllTabs(tab.workingDir, instKeyOf(row.session));
        useAppStore.getState().removeProjectSession(tab.workingDir, id);
      });
    },
  };
}

/**
 * Assigned-tab rows are their own surface: not sessions, so almost none of the
 * ticket-row actions apply. Investigate is the promotion path — the ONLY way an
 * assigned ticket ever spawns a CLI pane.
 *
 * The resolver turns the row id back into a tab plus the qualified ticket key,
 * because the tree renders assigned rows under several projects at once.
 */
export function buildJiraAssignedActions(
  resolve: (id: string) => { tab: Tab; qkey: string } | null,
): SurfaceActions {
  return {
    investigate: (id) => {
      const t = resolve(id);
      if (!t) return;
      const { tab, qkey } = t;
      const { siteId, key } = splitJiraQK(qkey);
      const store = useAppStore.getState();
      const site = siteId || siteForTabIn(store, tab);
      // One site per tab: a foreign-site row can't grow a pane HERE. The menu
      // already disables it with a reason — this is belt-and-braces.
      if (site !== siteForTabIn(store, tab)) return;
      openJiraTicket(tab.id, {
        ticket: key,
        cli: store.jiraCli ?? "claude",
        swedish: store.jiraReplyInSwedish,
        english: store.jiraReplyInEnglish,
      });
      store.markJiraTicketSeen(jiraQK(site, key));
      const notify = useJiraNotifyStore.getState();
      notify.setRailTab(tab.id, "tickets");
      notify.setAssignedPreview(tab.id, undefined);
    },
    openInBrowser: (id) => {
      const t = resolve(id);
      if (!t) return;
      const { siteId, key } = splitJiraQK(t.qkey);
      const store = useAppStore.getState();
      const url = buildTicketUrl(siteId || siteForTabIn(store, t.tab), key);
      if (url) window.open(url);
    },
  };
}

/** The user's own Atlassian accountId, fetching it if this session has never
 *  needed it. It is only captured by the Settings "Test" button or lazily by
 *  the poll engine behind an any-work gate, so a user with credentials, one
 *  Jira tab and no ticket rows can legitimately reach an assign click with it
 *  still blank. */
async function ensureMyAccountId(siteId: string): Promise<string> {
  const store = useAppStore.getState();
  if (store.jiraMyAccountId) return store.jiraMyAccountId;
  const me = await invoke<{ displayName: string; accountId: string }>("jira_test_auth", {
    baseUrl: siteId,
    email: store.jiraApiEmail,
    token: store.jiraApiToken,
  });
  if (me.accountId) useAppStore.getState().setJiraMyAccountId(me.accountId);
  return me.accountId;
}

/** Report a Jira write failure. There is no toast primitive here, so this
 *  reuses the notification stack the poller already posts Jira cards to.
 *
 *  Jira's OWN message goes out verbatim: it deliberately conflates 404
 *  "no such issue" with "you lack Browse permission" (to avoid leaking issue
 *  existence), so paraphrasing it as "not found" would mislead. */
function reportJiraWriteFailure(qk: string, key: string, action: string, e: unknown): void {
  const err = e as { message?: string } | undefined;
  const now = new Date();
  usePaneNotificationsStore.getState().add({
    id: `jira:${qk}:${Date.now()}`,
    terminalId: `jira:${qk}`,
    tabId: "",
    projectName: key,
    paneLabel: `${action} failed`,
    body: err?.message || "Jira rejected the request.",
    kind: "jira",
    timeHHMM: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
    addedAt: Date.now(),
    clickAction: `jira-open:${qk}`,
  });
}

/**
 * Unassigned-queue rows. Same shape as the assigned ones — these are Jira
 * issues, not MADE sessions — plus the one action that is the whole point of
 * the tab: taking a ticket.
 */
export function buildJiraUnassignedActions(
  resolve: (id: string) => { tab: Tab; qkey: string } | null,
): SurfaceActions {
  const assigned = buildJiraAssignedActions(resolve);
  return {
    ...assigned,
    assignToMe: (id) => {
      const t = resolve(id);
      if (!t) return;
      const { siteId, key } = splitJiraQK(t.qkey);
      const store = useAppStore.getState();
      const site = siteId || siteForTabIn(store, t.tab);
      // Confirm first: this is an externally visible write, and everyone
      // watching the ticket sees it land. (SurfaceActions is `(id) => void`,
      // hence the `void …then()` shape rather than an async handler.)
      const qk = jiraQK(site, key);
      void confirmAction({
        title: `Assign ${key} to me`,
        detail:
          "This writes to Jira — everyone watching the ticket sees the change.",
        confirmLabel: "Assign",
      }).then(async (ok) => {
        if (!ok) return;
        try {
          const accountId = await ensureMyAccountId(site);
          if (!accountId) {
            reportJiraWriteFailure(qk, key, "Assign", {
              message: "Jira did not return an account id for these credentials.",
            });
            return;
          }
          await invoke("jira_assign_issue", {
            baseUrl: site,
            email: store.jiraApiEmail,
            token: store.jiraApiToken,
            key,
            accountId,
          });
          // Move the row across optimistically — the next poll confirms it
          // either way, but a queue that still lists a ticket you just took
          // reads as a failed click.
          const fresh = useAppStore.getState();
          const row = (fresh.jiraUnassignedTickets ?? []).find(
            (r) => r.key === key && r.siteId === site,
          );
          fresh.setJiraUnassignedTicketsForSite(
            site,
            (fresh.jiraUnassignedTickets ?? []).filter(
              (r) => !(r.key === key && r.siteId === site),
            ),
          );
          if (row) {
            fresh.setJiraAssignedTicketsForSite(site, [
              ...(fresh.jiraAssignedTickets ?? []).filter((r) => r.siteId === site),
              row,
            ]);
          }
          // The PUT bumps the issue's `updated`, so without this the next
          // cycle classifies the user's own click as a change and notifies
          // them about themselves.
          await refreshJiraSnapshotSilently(site, key);
        } catch (e) {
          reportJiraWriteFailure(qk, key, "Assign", e);
        }
      });
    },
  };
}
