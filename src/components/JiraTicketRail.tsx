import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../store";
import type { ProjectSession, Tab } from "../types";
import { findAllTerminalLeaves } from "../lib/layout-utils";
import { sessionStillExists } from "../lib/session-exists";
import {
  askForTicket,
  openJiraTicket,
  navigateToTicket,
  duplicateJiraTicket,
  closeJiraInstanceInAllTabs,
  type JiraDuplicateMode,
} from "../lib/jira-project";
import { registerSurfaceActions, unregisterSurfaceActions } from "../lib/surface-actions";
import { pasteTextToTerminal } from "../lib/terminal-paste";
import { buildJiraPrompt, buildTicketUrl, jiraSiteName, DEFAULT_JIRA_PROMPT } from "../lib/jira";
import { useJiraNotifyStore } from "../store/jiraNotifyStore";
import { jiraQK, splitJiraQK, siteForTabIn } from "../lib/jira-sites";
import { chooseOption, confirmAction, promptForInput } from "../lib/prompt-modal";
import { clearTicketForTerminal, parkedTicketName } from "../lib/jira-session";
import { jiraCliOfSession, JIRA_CLI_LABEL } from "../lib/jira-mcp";
import { resolveTicketColor, contrastTextFor } from "../lib/jira-colors";
import { readSessionsIndex } from "../lib/sessions-index";
import {
  findJiraTermLeaf,
  removeJiraInstanceTerm,
  listJiraInstanceKeys,
  jiraBaseTicket,
  jiraInstanceKey,
} from "../lib/jira-layout";

/** 1 for the original row, 2+ for duplicates. */
const instanceOf = (s: ProjectSession) => s.ticketInstance ?? 1;
/** The key the canvas selection and pane ids use for this row. */
const instKeyOf = (s: ProjectSession) => jiraInstanceKey(s.ticket ?? "", s.ticketInstance);
/** The name a row would have if never edited — ticket key (+ " #n"). */
const defaultNameOf = (s: ProjectSession) =>
  parkedTicketName({ ticket: s.ticket ?? "", instance: s.ticketInstance });
/** The user-edited name, or null while the row carries a default one. Both
 *  the bare key and the numbered form count as defaults — an original is
 *  "TICKET" alone but becomes "TICKET #1" while duplicates exist. */
const customNameOf = (s: ProjectSession) => {
  if (!s.name || !s.ticket) return null;
  if (s.name === s.ticket) return null;
  if (s.name === `${s.ticket} #${s.ticketInstance ?? 1}`) return null;
  return s.name;
};

/**
 * The ticket rail down the left of a Jira project.
 *
 * Rows are Claude sessions carrying a ticket key — the SAME records whether the
 * pane is open or long since closed, which is what lets a closed ticket be
 * reopened straight back into its conversation. A row is "open" when a live pane
 * in this tab holds its session id.
 *
 * Visual language is deliberately MADE's existing chrome rather than anything
 * new: the search field is the Settings one, row height matches a pane header,
 * and the single accent is the Claude brand colour that already underlines a
 * live Claude pane — so a row and the pane it points at read as one object.
 */

const RAIL_WIDTH = 208;
const ROW_HEIGHT = 28;

/** 6px solid accent dot marking a ticket with unseen updates. Static on
 *  purpose — no pulse/ping. Cleared by viewing the ticket, never by time. */
const unseenDot = () => (
  <span
    style={{
      width: 6,
      height: 6,
      borderRadius: "50%",
      backgroundColor: "var(--ezy-accent)",
      display: "inline-block",
      flexShrink: 0,
    }}
  />
);

interface JiraTicketRailProps {
  tab: Tab;
  onFocusTerminal: (terminalId: string) => void;
}

interface TicketRow {
  session: ProjectSession;
  /** Set when a pane in this tab is currently running this session. */
  terminalId?: string;
}

export default function JiraTicketRail({ tab, onFocusTerminal }: JiraTicketRailProps) {
  const [query, setQuery] = useState("");
  const [missing, setMissing] = useState<Set<string>>(new Set());
  // Ticket keys whose duplicate-group rows are folded away, toggled by
  // clicking the group title. Session-local on purpose: a fold is a reading
  // aid, not workspace state worth persisting. A live search bypasses the
  // fold so a match can never hide behind a collapsed group.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  /** Session ids whose conversation TEXT matches the query (sessions-index
   *  summaries + first prompts) — null while empty query / loading. */
  const [contentMatches, setContentMatches] = useState<Set<string> | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const jiraTicketColors = useAppStore((s) => s.jiraTicketColors);
  const fullColor = useAppStore((s) => s.jiraRowFullColor ?? false);
  // Assigned-tickets mode (Settings > Jira). The rail tab lives in the
  // session-only jiraNotifyStore so a notification click can switch it.
  const assignedMode = useAppStore((s) => s.jiraAssignedMode ?? false);
  const assignedTickets = useAppStore((s) => s.jiraAssignedTickets);
  const jiraSites = useAppStore((s) => s.jiraSites ?? []);
  const tabSite = useAppStore((s) => siteForTabIn(s, tab));
  const siteName = useMemo(() => jiraSiteName(tabSite), [tabSite]);
  const ticketSnapshots = useAppStore((s) => s.jiraTicketSnapshots);
  const railTab = useJiraNotifyStore((s) => (assignedMode ? (s.railTab[tab.id] ?? "tickets") : "tickets"));
  const assignedPreview = useJiraNotifyStore((s) => s.assignedPreview[tab.id]);

  const projectKey = tab.workingDir.replace(/\\/g, "/");
  // Select the raw slice and derive below — filtering inside the selector
  // returns a new array every render and spins the store.
  const allSessions = useAppStore((s) => s.projectSessions[projectKey]);
  const activeTerminalId = useAppStore((s) => s.terminals);

  const rows = useMemo<TicketRow[]>(() => {
    const tickets = (allSessions ?? []).filter((s) => !!s.ticket);
    const liveBySession = new Map<string, string>();
    if (tab.layout) {
      for (const leaf of findAllTerminalLeaves(tab.layout)) {
        if (leaf.sessionResumeId) liveBySession.set(leaf.sessionResumeId, leaf.terminalId);
      }
    }
    const mapped = tickets.map((session) => ({
      session,
      terminalId: liveBySession.get(session.id),
    }));
    // Duplicates stay ATTACHED to their original: rows group by base ticket
    // (instances in #1..#n order), and groups sort like rows used to — any-
    // instance-open first, then most recently started. A group with one open
    // and one closed instance therefore sits, whole, in the open section.
    const groups = new Map<string, TicketRow[]>();
    for (const r of mapped) {
      const key = r.session.ticket!;
      const g = groups.get(key);
      if (g) g.push(r);
      else groups.set(key, [r]);
    }
    const groupList = [...groups.values()];
    for (const g of groupList) g.sort((a, b) => instanceOf(a.session) - instanceOf(b.session));
    groupList.sort((a, b) => {
      const aOpen = a.some((r) => !!r.terminalId);
      const bOpen = b.some((r) => !!r.terminalId);
      if (aOpen !== bOpen) return aOpen ? -1 : 1;
      const aT = Math.max(...a.map((r) => r.session.createdAt));
      const bT = Math.max(...b.map((r) => r.session.createdAt));
      return bT - aT;
    });
    return groupList.flat();
    // `activeTerminalId` (the terminals map) is a dependency because a pane
    // appearing or dying changes which rows count as open.
  }, [allSessions, tab.layout, activeTerminalId]);

  // Instance counts across ALL rows (incl. archived) — this is the NAMING
  // truth: session names keep their "#n" while any sibling exists anywhere,
  // so numbers never collide when an archived instance comes back.
  const instanceCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const t = r.session.ticket!;
      m.set(t, (m.get(t) ?? 0) + 1);
    }
    return m;
  }, [rows]);

  // DISPLAY grouping is per section: a ticket renders as a titled group only
  // where more than one of its instances is visible. Archiving #1 leaves #2
  // alone in the active list, and a lone row must read as a plain ticket —
  // no group title, no "#n" — even though its session keeps the number.
  // Counted over unfiltered rows so a live search never reshapes the groups.
  const sectionCounts = useMemo(() => {
    const active = new Map<string, number>();
    const archived = new Map<string, number>();
    for (const r of rows) {
      const t = r.session.ticket!;
      const m = r.session.archived ? archived : active;
      m.set(t, (m.get(t) ?? 0) + 1);
    }
    return { active, archived };
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        (r.session.ticket ?? "").includes(q) ||
        (customNameOf(r.session) ?? "").toUpperCase().includes(q) ||
        (contentMatches?.has(r.session.id) ?? false),
    );
  }, [rows, query, contentMatches]);

  const activeRows = useMemo(() => filtered.filter((r) => !r.session.archived), [filtered]);
  const archivedRows = useMemo(() => filtered.filter((r) => !!r.session.archived), [filtered]);
  // The "Closed" heading sits before the first row of the first fully-closed
  // GROUP — a closed duplicate attached to an open original stays above it.
  const firstClosedIdx = useMemo(() => {
    const openTickets = new Set(
      activeRows.filter((r) => r.terminalId).map((r) => r.session.ticket!),
    );
    return activeRows.findIndex((r) => !openTickets.has(r.session.ticket!));
  }, [activeRows]);

  // Content search: match the query against each session's conversation text
  // as Claude indexes it (summary, custom title, first prompt) — debounced,
  // works for local and SSH projects through the same sessions-index reader.
  useEffect(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) {
      setContentMatches(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const entries = await readSessionsIndex(tab.workingDir, tab.backend ?? "wsl", tab.serverId);
        if (cancelled) return;
        const hits = new Set<string>();
        for (const e of entries) {
          const hay = `${e.summary}\n${e.customTitle}\n${e.firstPrompt}`.toLowerCase();
          if (hay.includes(q)) hits.add(e.sessionId);
        }
        setContentMatches(hits);
      } catch {
        if (!cancelled) setContentMatches(null);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, tab.workingDir, tab.backend, tab.serverId]);

  // A closed session can only be reopened if its transcript still exists.
  // sessionStillExists fails open, so a row is marked unavailable only when the
  // file is definitively gone — better a failed resume than hiding live work.
  useEffect(() => {
    let cancelled = false;
    const closed = rows.filter((r) => !r.terminalId).map((r) => r.session);
    if (closed.length === 0) {
      setMissing((prev) => (prev.size ? new Set() : prev));
      return;
    }
    void (async () => {
      const gone = new Set<string>();
      for (const session of closed) {
        const ok = await sessionStillExists(
          // Per row, NOT a hardcoded "claude": a Codex thread id has no
          // ~/.claude transcript, so checking it as Claude would definitively
          // report it gone and leave the row permanently unclickable.
          jiraCliOfSession(session.type),
          session.id,
          tab.workingDir,
          tab.backend ?? "wsl",
          tab.serverId,
        );
        if (!ok) gone.add(session.id);
      }
      if (!cancelled) setMissing(gone);
    })();
    return () => {
      cancelled = true;
    };
  }, [rows, tab.workingDir, tab.backend, tab.serverId]);

  // Group collapse: when a duplicate group shrinks to ONE remaining row
  // (siblings deleted/forgotten — closing a pane keeps its row), the survivor
  // folds back into a regular ticket. Its default "TICKET #n" name reverts to
  // the plain key (custom names are kept), reaching the Claude title via
  // --name on the pane's next launch; the instance number is dropped once the
  // pane is closed (never while open — the live pane's layout key carries it).
  useEffect(() => {
    const store = useAppStore.getState();
    for (const r of rows) {
      const ticket = r.session.ticket;
      if (!ticket) continue;
      if ((instanceCounts.get(ticket) ?? 1) > 1) continue; // still a group
      const inst = r.session.ticketInstance ?? 1;
      // The numbered default ("TICKET #1" on the original, "TICKET #2" on a
      // surviving duplicate) folds back to the plain key; custom names are
      // kept. The Claude title follows via --name at the pane's next launch.
      if (r.session.name === `${ticket} #${inst}`) {
        store.renameProjectSession(tab.workingDir, r.session.id, ticket);
      }
      if (inst > 1 && !r.terminalId) {
        store.clearTicketInstance(tab.workingDir, r.session.id);
      }
    }
  }, [rows, instanceCounts, tab.workingDir]);

  // CLI → rail name sync. A rename made INSIDE Claude Code lands in the
  // sessions-index as `customTitle`; adopt it when it changed since the last
  // sync (adoptCliSessionTitle ignores unchanged titles, so MADE-side renames
  // are never clobbered by the stale CLI title they haven't reached yet — the
  // rail → CLI direction rides `--name` on the pane's next launch). Polled
  // while this tab is active; SSH projects go through the same index reader.
  useEffect(() => {
    let cancelled = false;
    const sync = async () => {
      if (useAppStore.getState().activeTabId !== tab.id) return;
      try {
        const entries = await readSessionsIndex(tab.workingDir, tab.backend ?? "wsl", tab.serverId);
        if (cancelled) return;
        const titleById = new Map(entries.map((e) => [e.sessionId, e.customTitle]));
        const store = useAppStore.getState();
        const sessions = store.projectSessions[projectKey] ?? [];
        const counts = new Map<string, number>();
        for (const s of sessions) {
          if (s.ticket) counts.set(s.ticket, (counts.get(s.ticket) ?? 0) + 1);
        }
        for (const s of sessions) {
          if (!s.ticket) continue;
          const title = titleById.get(s.id)?.trim();
          if (!title) continue;
          // CLI → row adoption is single-pane-only for now: a duplicated
          // ticket keeps its "#n" naming whatever happens CLI-side. The
          // snapshot still advances, so when the group later collapses the
          // poll doesn't adopt a stale CLI title over the folded-back name.
          store.adoptCliSessionTitle(
            tab.workingDir,
            s.id,
            title,
            (counts.get(s.ticket) ?? 1) > 1,
          );
        }
      } catch {
        // Index unreadable — leave names alone.
      }
    };
    void sync();
    const iv = setInterval(sync, 20_000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [tab.id, tab.workingDir, tab.backend, tab.serverId, projectKey]);

  const assignedFiltered = useMemo(() => {
    if (railTab !== "assigned") return [];
    const q = query.trim().toLowerCase();
    if (!q) return assignedTickets;
    return assignedTickets.filter(
      (t) =>
        t.key.toLowerCase().includes(q) ||
        t.summary.toLowerCase().includes(q) ||
        (jiraSiteName(t.siteId) ?? "").toLowerCase().includes(q),
    );
  }, [railTab, assignedTickets, query]);

  const toggleGroupCollapsed = (ticket: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(ticket)) next.delete(ticket);
      else next.add(ticket);
      return next;
    });
  };

  const handleRowClick = (row: TicketRow) => {
    const ticket = row.session.ticket;
    if (!ticket) return;
    if (row.session.archived) return; // unarchive via context menu first
    if (row.terminalId) {
      // Open ticket: switch the canvas to this instance's pane (the ticket's
      // shared browser is already parked on its page — no re-navigation, and
      // switching between instances of one ticket never touches it).
      useAppStore.getState().setSelectedJiraTicket(tab.id, instKeyOf(row.session));
      onFocusTerminal(row.terminalId);
      return;
    }
    if (missing.has(row.session.id)) return;
    openJiraTicket(tab.id, {
      ticket,
      // Reopen on the CLI the conversation belongs to — resuming a Codex
      // thread with Claude would resume nothing at all.
      cli: jiraCliOfSession(row.session.type),
      resumeId: row.session.id,
      instance: row.session.ticketInstance,
    });
  };
  // The surface registration below is set up once, so it reaches the current
  // click handler through a ref rather than re-registering on every render.
  const handleRowClickRef = useRef(handleRowClick);
  handleRowClickRef.current = handleRowClick;

  // Context-menu handlers. Registered per surface (not per row) — the provider
  // disables its items when nothing is registered, so a menu can never render an
  // action that silently does nothing.
  const rowsRef = useRef(filtered);
  rowsRef.current = filtered;
  // The registration effect below binds once per tab, so the sub-ticket
  // chooser reads the missing-transcript set through a ref to stay fresh.
  const missingRef = useRef(missing);
  missingRef.current = missing;
  useEffect(() => {
    const find = (id: string) => rowsRef.current.find((r) => r.session.id === id);
    registerSurfaceActions("jira-ticket", {
      open: (id) => {
        const row = find(id);
        if (row) handleRowClickRef.current(row);
      },
      openInBrowser: (id) => {
        const ticket = find(id)?.session.ticket;
        if (ticket) navigateToTicket(tab.id, ticket);
      },
      closePane: (id) => {
        const row = find(id);
        if (row?.terminalId) closeTicketPair(row);
      },
      // The investigation prompt a fresh ticket is opened WITH. Panes that
      // never got one — an empty sub-ticket, a fork, a resumed conversation —
      // can ask for it here. Pasted, never submitted: a menu click must not
      // fire a prompt into a pane that is mid-answer, and this way the wording
      // can still be edited before it goes.
      sendPrompt: (id) => {
        const row = find(id);
        if (!row?.terminalId || !row.session.ticket) return;
        const store = useAppStore.getState();
        pasteTextToTerminal(
          row.terminalId,
          buildJiraPrompt(
            store.jiraPromptTemplate || DEFAULT_JIRA_PROMPT,
            row.session.ticket,
            store.jiraReplyInSwedish ? "sv" : store.jiraReplyInEnglish ? "en" : undefined,
          ),
        );
        onFocusTerminal(row.terminalId);
      },
      rename: (id) => {
        const row = find(id);
        if (!row?.session.ticket) return;
        const ticket = row.session.ticket;
        // Reset target is group-aware: while duplicates exist the default is
        // the numbered form, so an emptied name rejoins the "#n" convention.
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
            "Shown in the rail, and set as the Claude session name (--name) the next time this pane launches. Leave empty to reset to the ticket key.",
        }).then((value) => {
          if (value === null) return; // cancelled
          const name = value.trim() || fallback;
          if (name === row.session.name) return;
          useAppStore.getState().renameProjectSession(tab.workingDir, id, name);
        });
      },
      duplicate: (id) => {
        const row = find(id);
        if (!row?.session.ticket) return;
        const ticket = row.session.ticket;
        // Forking replays the source transcript, so it needs the file to
        // still exist; an open pane always has one.
        const gone = !row.terminalId && missingRef.current.has(row.session.id);
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
        const row = find(id);
        if (!row) return;
        // All-tabs close, not closeTicketPair: a second tab on the same
        // project can hold this instance's pane, and a pane that survives
        // archiving resumes from the persisted layout on the next launch.
        if (!row.session.archived) {
          closeJiraInstanceInAllTabs(tab.workingDir, instKeyOf(row.session));
        }
        useAppStore
          .getState()
          .setProjectSessionArchived(tab.workingDir, id, !row.session.archived);
      },
      del: (id) => {
        const row = find(id);
        if (!row) return;
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
    });
    return () => unregisterSurfaceActions("jira-ticket");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, tab.workingDir]);

  // Assigned-tab rows are their own surface: not sessions, so almost none of
  // the ticket-row actions apply. Investigate is the promotion path — the ONLY
  // way an assigned ticket ever spawns a CLI pane.
  useEffect(() => {
    registerSurfaceActions("jira-assigned", {
      investigate: (qkey) => {
        const { siteId, key } = splitJiraQK(qkey);
        const store = useAppStore.getState();
        const site = siteId || siteForTabIn(store, tab);
        // One site per tab: a foreign-site row can't grow a pane HERE. The
        // menu already disables it with a reason — this is belt-and-braces.
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
      openInBrowser: (qkey) => {
        const { siteId, key } = splitJiraQK(qkey);
        const store = useAppStore.getState();
        const url = buildTicketUrl(siteId || siteForTabIn(store, tab), key);
        if (url) window.open(url);
      },
    });
    return () => unregisterSurfaceActions("jira-assigned");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  /** Close ONE instance's pane if it is open. The ticket's shared browser
   *  goes away only with the last instance; the canvas falls back to a
   *  sibling instance first, then any other open ticket. */
  function closeTicketPair(row: TicketRow): void {
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

  const handleNewTicket = async () => {
    const answer = await askForTicket();
    if (!answer) return;
    openJiraTicket(tab.id, {
      ticket: answer.ticket,
      cli: answer.cli,
      swedish: answer.swedish,
      english: answer.english,
      model: answer.model,
    });
  };

  return (
    <div
      data-ctx-surface="jira-rail"
      style={{
        width: RAIL_WIDTH,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        backgroundColor: "var(--ezy-bg)",
        borderRight: "1px solid var(--ezy-border)",
        color: "var(--ezy-text)",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 6,
          height: ROW_HEIGHT,
          padding: "0 6px 0 10px",
          flexShrink: 0,
        }}
      >
        {assignedMode ? (
          // Two-segment switcher — same 10px uppercase voice as the plain
          // heading; the active segment simply carries the text color.
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            {(["tickets", "assigned"] as const).map((seg) => {
              const active = railTab === seg;
              const dot =
                seg === "assigned" &&
                assignedTickets.some(
                  (t) => ticketSnapshots?.[jiraQK(t.siteId, t.key)]?.unseen,
                );
              return (
                <span
                  key={seg}
                  role="tab"
                  aria-selected={active}
                  tabIndex={0}
                  onClick={() => useJiraNotifyStore.getState().setRailTab(tab.id, seg)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      useJiraNotifyStore.getState().setRailTab(tab.id, seg);
                    }
                  }}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: active ? "var(--ezy-text)" : "var(--ezy-text-muted)",
                    cursor: "pointer",
                    userSelect: "none",
                    outline: "none",
                  }}
                >
                  {seg === "tickets" ? "Tickets" : "Assigned"}
                  {dot && unseenDot()}
                </span>
              );
            })}
          </div>
        ) : (
          <span
            style={{
              fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--ezy-text-muted)",
            }}
          >
            Tickets
          </span>
        )}
        {/* Site name — which Jira this TAB's tickets live on. With more than
            one site configured it is the per-project switcher. */}
        {siteName && (
          <span
            data-tooltip={jiraSites.length > 1 ? `Switch Jira site (now ${tabSite})` : tabSite}
            role={jiraSites.length > 1 ? "button" : undefined}
            tabIndex={jiraSites.length > 1 ? 0 : undefined}
            onClick={
              jiraSites.length > 1
                ? () => {
                    void chooseOption({
                      title: "Jira site",
                      detail:
                        "Applies to new tickets in this project. Open tickets keep the site they were opened on.",
                      choices: jiraSites.map((origin) => ({
                        id: origin,
                        label: jiraSiteName(origin) ?? origin,
                        detail: origin,
                      })),
                    }).then((picked) => {
                      if (!picked || picked === tabSite) return;
                      const store = useAppStore.getState();
                      store.setTabJiraSite(tab.id, picked);
                      store.setProjectJiraSite(tab.workingDir, tab.serverId, picked);
                    });
                  }
                : undefined
            }
            onMouseEnter={
              jiraSites.length > 1
                ? (e) => (e.currentTarget.style.color = "var(--ezy-text)")
                : undefined
            }
            onMouseLeave={
              jiraSites.length > 1
                ? (e) => (e.currentTarget.style.color = "var(--ezy-text-muted)")
                : undefined
            }
            style={{
              marginLeft: "auto",
              marginRight: 6,
              maxWidth: 64,
              fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
              color: "var(--ezy-text-muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flexShrink: 1,
              cursor: jiraSites.length > 1 ? "pointer" : undefined,
              outline: "none",
            }}
          >
            {siteName}
          </span>
        )}
        {/* Bare svg, not a button: a <button> inherits line-height 1.5 and
            silently inflates a 28px header to 36px. */}
        <svg
          onClick={handleNewTicket}
          role="button"
          tabIndex={0}
          aria-label="New ticket"
          data-tooltip="New ticket"
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              void handleNewTicket();
            }
          }}
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          style={{ color: "var(--ezy-text-muted)", cursor: "pointer", flexShrink: 0 }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--ezy-text)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--ezy-text-muted)")}
        >
          <line x1="8" y1="3.5" x2="8" y2="12.5" />
          <line x1="3.5" y1="8" x2="12.5" y2="8" />
        </svg>
      </div>

      {/* Search — same field as Settings, so the two read as one system. */}
      <div style={{ padding: "0 8px 8px", flexShrink: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            height: 22,
            padding: "0 6px",
            borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
            backgroundColor: "var(--ezy-surface)",
            gap: 6,
          }}
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ color: "var(--ezy-text-muted)", flexShrink: 0 }}
          >
            <circle cx="7" cy="7" r="5" />
            <path d="m11 11 3 3" />
          </svg>
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            placeholder="Search tickets"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setQuery("");
                searchInputRef.current?.blur();
              }
            }}
            style={{
              flex: 1,
              minWidth: 0,
              background: "transparent",
              border: "none",
              outline: "none",
              padding: 0,
              fontFamily: "inherit",
              fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
              color: "var(--ezy-text)",
            }}
          />
        </div>
      </div>

      {/* List */}
      {railTab === "assigned" ? (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingBottom: 8 }}>
          {assignedFiltered.length === 0 && (
            <div
              style={{
                padding: "8px 10px",
                fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                lineHeight: 1.5,
                color: "var(--ezy-text-muted)",
              }}
            >
              {assignedTickets.length === 0
                ? "No assigned tickets. They appear here once Jira credentials are set in Settings > Jira."
                : "No assigned ticket matches that search."}
            </div>
          )}
          {assignedFiltered.map(renderAssignedRow)}
        </div>
      ) : (
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingBottom: 8 }}>
        {filtered.length === 0 && (
          <div
            style={{
              padding: "8px 10px",
              fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
              lineHeight: 1.5,
              color: "var(--ezy-text-muted)",
            }}
          >
            {rows.length === 0
              ? "No tickets yet. Add one to start investigating."
              : "No ticket matches that search."}
          </div>
        )}
        {activeRows.map((row, i) => {
          // Only label the groups when both exist — a single heading over a
          // uniform list is noise.
          const showClosedHeading = firstClosedIdx > 0 && i === firstClosedIdx;
          const t = row.session.ticket!;
          const grouped = (sectionCounts.active.get(t) ?? 1) > 1;
          // A duplicated ticket renders as a titled group: a "SUPPORT-24920"
          // heading (click to fold/unfold), then its instances at equal
          // indentation — hidden while the group is folded.
          const groupStart =
            grouped && (i === 0 || activeRows[i - 1].session.ticket !== t);
          const folded = grouped && !query.trim() && collapsedGroups.has(t);
          return (
            <div key={row.session.id}>
              {showClosedHeading && <div style={sectionHeadingStyle}>Closed</div>}
              {groupStart && renderGroupTitle(t)}
              {!folded && renderRow(row)}
            </div>
          );
        })}
        {archivedRows.length > 0 && (
          <>
            <div style={sectionHeadingStyle}>Archived</div>
            {archivedRows.map((row, i) => {
              const t = row.session.ticket!;
              const grouped = (sectionCounts.archived.get(t) ?? 1) > 1;
              const groupStart =
                grouped && (i === 0 || archivedRows[i - 1].session.ticket !== t);
              const folded = grouped && !query.trim() && collapsedGroups.has(t);
              return (
                <div key={row.session.id}>
                  {groupStart && renderGroupTitle(t)}
                  {!folded && renderRow(row)}
                </div>
              );
            })}
          </>
        )}
      </div>
      )}
    </div>
  );

  /** Open the row's COMPACT menu from its hamburger: synthesize a contextmenu
   *  event on the row element, anchored under the anchor icon. Same event path
   *  and providers as a real right-click — the temporary data-ctx-compact flag
   *  is all that differs, and the provider answers it with a strict subset of
   *  the full menu, so the two cannot drift. The flag comes off right after
   *  the dispatch (menu build is synchronous inside it), so an actual
   *  right-click on the row still gets the full menu. */
  function openRowMenu(anchor: Element): void {
    // Both rail surfaces — ticket rows and assigned rows — share this path.
    const rowEl = anchor.closest("[data-ctx-surface]");
    if (!rowEl) return;
    const r = anchor.getBoundingClientRect();
    rowEl.setAttribute("data-ctx-compact", "1");
    try {
      rowEl.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: Math.round(r.left),
          clientY: Math.round(r.bottom + 2),
        }),
      );
    } finally {
      rowEl.removeAttribute("data-ctx-compact");
    }
  }

  /** Heading over a duplicated ticket's instance rows — always the plain
   *  ticket key, whatever the instances are renamed to. Clicking it folds the
   *  group's rows away; the chevron shows the state. While a search is live
   *  the fold is bypassed (matches must stay visible), so the chevron reads
   *  expanded then too. */
  function renderGroupTitle(ticket: string) {
    const color = resolveTicketColor(ticket, jiraTicketColors);
    const paintFull = fullColor && !!color;
    const folded = collapsedGroups.has(ticket) && !query.trim();
    return (
      <div
        role="button"
        tabIndex={0}
        aria-expanded={!folded}
        aria-label={`${ticket} — ${folded ? "expand" : "collapse"} group`}
        onClick={() => toggleGroupCollapsed(ticket)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleGroupCollapsed(ticket);
          }
        }}
        // Hover feedback lives on the CHEVRON alone — no row-surface tint on
        // the title. It grows slightly and (on neutral rows) brightens; the
        // transform composes with the fold rotation so hovering never undoes
        // the expanded state. Full-color rows keep their contrast color — a
        // brightened gray could vanish against an arbitrary ticket color.
        onMouseEnter={(e) => {
          const ch = e.currentTarget.querySelector("svg");
          if (!ch) return;
          ch.style.transform = folded ? "scale(1.25)" : "rotate(90deg) scale(1.25)";
          if (!paintFull) ch.style.color = "var(--ezy-text)";
        }}
        onMouseLeave={(e) => {
          const ch = e.currentTarget.querySelector("svg");
          if (!ch) return;
          ch.style.transform = folded ? "" : "rotate(90deg)";
          ch.style.color = "";
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          height: 22,
          padding: "0 10px 0 8px",
          cursor: "pointer",
          userSelect: "none",
          outline: "none",
          backgroundColor: paintFull ? color! : undefined,
          borderLeft: `2px solid ${paintFull ? "transparent" : color ?? "transparent"}`,
          color: paintFull ? contrastTextFor(color!) : "var(--ezy-text-muted)",
        }}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            flexShrink: 0,
            transform: folded ? undefined : "rotate(90deg)",
            transition: "transform 0.15s ease, color 0.15s ease",
          }}
        >
          <path d="m6 3.5 5 4.5-5 4.5" />
        </svg>
        <span
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
            fontWeight: 600,
            fontVariantNumeric: "tabular-nums",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {ticket}
        </span>
        {ticketSnapshots?.[jiraQK(tabSite, ticket)]?.unseen && unseenDot()}
      </div>
    );
  }

  function renderRow(row: TicketRow) {
    const isOpen = !!row.terminalId;
    const archived = !!row.session.archived;
    const unavailable = !isOpen && missing.has(row.session.id);
    const ticket = row.session.ticket;
    const color = ticket ? resolveTicketColor(ticket, jiraTicketColors) : null;
    const paintFull = fullColor && !!color;
    // Under a group title the rows simplify to "#1" / "#2" at one shared
    // indentation — the title above carries the ticket key. A user-edited
    // name wins outright (the span ellipses when it overruns the rail). The
    // context menu still gets the FULL name so "#2" never appears without
    // its ticket. Claude-side session names stay "TICKET #n" — a bare "#2"
    // would be meaningless in the CLI's own resume picker.
    // Three label tiers. Grouped in THIS section → "#n" under the group
    // title. Alone in this section but with siblings elsewhere (e.g. the
    // other instance is archived) → the full "TICKET #n", so the instance
    // identity never disappears and two sections can't show identical rows.
    // No siblings anywhere → the bare ticket key.
    const groupedHere =
      ((archived ? sectionCounts.archived : sectionCounts.active).get(ticket ?? "") ?? 1) > 1;
    const siblingsAnywhere = (instanceCounts.get(ticket ?? "") ?? 1) > 1;
    const custom = customNameOf(row.session);
    const numbered = `${ticket} #${instanceOf(row.session)}`;
    const label =
      custom ?? (groupedHere ? `#${instanceOf(row.session)}` : siblingsAnywhere ? numbered : ticket);
    const menuLabel = custom ?? (siblingsAnywhere ? numbered : ticket);
    // The row whose pane the canvas is currently showing.
    const isActive = isOpen && !archived && tab.selectedJiraTicket === instKeyOf(row.session);
    const restingBg = paintFull ? color! : isActive ? "var(--ezy-surface)" : undefined;
    const restingFilter = archived
      ? "grayscale(0.8)"
      : paintFull && isActive
        ? "brightness(1.12)"
        : undefined;
    const textColor = paintFull
      ? contrastTextFor(color!)
      : isOpen
        ? "var(--ezy-text)"
        : "var(--ezy-text-muted)";
    return (
      <div
        data-ctx-surface="jira-ticket"
        data-ctx-id={row.session.id}
        data-ctx-label={menuLabel}
        data-ctx-ticket={ticket}
        data-ctx-open={isOpen ? "1" : undefined}
        data-ctx-gone={unavailable ? "1" : undefined}
        data-ctx-archived={archived ? "1" : undefined}
        onClick={() => handleRowClick(row)}
        data-tooltip={
          unavailable
            ? "This conversation's transcript is gone — it can't be reopened."
            : archived
              ? "Archived — unarchive from the right-click menu to reopen."
              : undefined
        }
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: ROW_HEIGHT,
          padding: `0 10px 0 ${groupedHere ? 18 : 8}px`,
          cursor: unavailable || archived ? "default" : "pointer",
          opacity: unavailable ? 0.4 : archived ? 0.5 : 1,
          filter: restingFilter,
          // Each ticket's own color — the same one tinting its Claude pane —
          // so the rail doubles as a legend for the canvas. In full-color mode
          // the whole row carries it and the text flips for contrast. The
          // ACTIVE row (the pane pair the canvas shows) keeps the hover
          // surface permanently plus an accent edge on the canvas side.
          backgroundColor: restingBg,
          borderLeft: `2px solid ${paintFull ? "transparent" : color ?? "transparent"}`,
          boxShadow: isActive ? "inset -2px 0 0 var(--ezy-accent)" : undefined,
          color: textColor,
        }}
        onMouseEnter={(e) => {
          if (!unavailable && !archived && !paintFull) {
            e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
          }
          if (paintFull && !archived) e.currentTarget.style.filter = "brightness(1.12)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = restingBg ?? "transparent";
          e.currentTarget.style.filter = restingFilter ?? "";
        }}
      >
        {ticket && ticketSnapshots?.[jiraQK(tabSite, ticket)]?.unseen && unseenDot()}
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
            fontWeight:
              isOpen || (ticket && ticketSnapshots?.[jiraQK(tabSite, ticket)]?.unseen)
                ? 600
                : 400,
            fontVariantNumeric: "tabular-nums",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
        {/* Hamburger — opens a COMPACT subset of the right-click menu through
            the same synthesized contextmenu path (see openRowMenu), so the
            items can never drift from the full menu's.
            Styled like the browser pane header's NavButton (rounded pill,
            bg transparent → var(--ezy-border) on hover); a div role=button
            has no <button> line-height inflation. Revealed on row hover via
            .jira-row-menu, pinned visible on the active row. */}
        <div
          className="jira-row-menu"
          role="button"
          tabIndex={0}
          aria-label="Ticket options"
          data-tooltip="Ticket options"
          onClick={(e) => {
            e.stopPropagation(); // a menu click must not open/focus the row
            openRowMenu(e.currentTarget);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              openRowMenu(e.currentTarget);
            }
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = "var(--ezy-border)";
            // Full-color rows keep the row's contrast color — a fixed gray
            // could vanish against an arbitrary ticket color.
            if (!paintFull) e.currentTarget.style.color = "var(--ezy-text)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = "transparent";
            if (!paintFull) e.currentTarget.style.color = "var(--ezy-text-muted)";
          }}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 22,
            height: 22,
            borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
            cursor: "pointer",
            color: paintFull ? undefined : "var(--ezy-text-muted)",
            backgroundColor: "transparent",
            // Includes opacity — an inline transition list replaces the
            // .jira-row-menu class's, which owns the hover fade-in.
            transition: "background-color 0.15s, color 0.15s, opacity 100ms ease",
            outline: "none",
            flexShrink: 0,
            opacity: isActive ? 1 : undefined,
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <line x1="3" y1="4.5" x2="13" y2="4.5" />
            <line x1="3" y1="8" x2="13" y2="8" />
            <line x1="3" y1="11.5" x2="13" y2="11.5" />
          </svg>
        </div>
      </div>
    );
  }

  /** Assigned-tab row: a ticket assigned to the user with (usually) no
   *  investigation yet. Click shows the browser-only preview — the ONLY way
   *  it grows a CLI pane is the menu's explicit Investigate. */
  function renderAssignedRow(t: {
    key: string;
    summary: string;
    status: string;
    updatedIso: string;
    siteId: string;
  }) {
    const qk = jiraQK(t.siteId, t.key);
    const unseen = !!ticketSnapshots?.[qk]?.unseen;
    const isActive = assignedPreview === qk;
    const foreign = t.siteId !== tabSite;
    return (
      <div
        key={qk}
        data-ctx-surface="jira-assigned"
        data-ctx-id={qk}
        data-ctx-label={t.key}
        data-ctx-ticket={t.key}
        data-ctx-foreign={foreign ? "1" : undefined}
        onClick={() => {
          useJiraNotifyStore.getState().setAssignedPreview(tab.id, qk);
          useAppStore.getState().markJiraTicketSeen(qk);
        }}
        data-tooltip={t.summary || undefined}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          height: ROW_HEIGHT,
          padding: "0 10px 0 8px",
          cursor: "pointer",
          backgroundColor: isActive ? "var(--ezy-surface)" : undefined,
          boxShadow: isActive ? "inset -2px 0 0 var(--ezy-accent)" : undefined,
          color: "var(--ezy-text)",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = isActive
            ? "var(--ezy-surface)"
            : "transparent";
        }}
      >
        {unseen && unseenDot()}
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
            fontWeight: unseen ? 600 : 400,
            fontVariantNumeric: "tabular-nums",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {t.key}
        </span>
        {jiraSites.length > 1 && (
          <span
            data-tooltip={t.siteId}
            style={{
              fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
              color: "var(--ezy-text-muted)",
              flexShrink: 0,
              maxWidth: 48,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {jiraSiteName(t.siteId) ?? t.siteId}
          </span>
        )}
        <span
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
            color: "var(--ezy-text-muted)",
            flexShrink: 0,
            maxWidth: 72,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {t.status}
        </span>
        <div
          className="jira-row-menu"
          role="button"
          tabIndex={0}
          aria-label="Ticket options"
          data-tooltip="Ticket options"
          onClick={(e) => {
            e.stopPropagation();
            openRowMenu(e.currentTarget);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              openRowMenu(e.currentTarget);
            }
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = "var(--ezy-border)";
            e.currentTarget.style.color = "var(--ezy-text)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = "transparent";
            e.currentTarget.style.color = "var(--ezy-text-muted)";
          }}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 22,
            height: 22,
            borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
            cursor: "pointer",
            color: "var(--ezy-text-muted)",
            backgroundColor: "transparent",
            transition: "background-color 0.15s, color 0.15s, opacity 100ms ease",
            outline: "none",
            flexShrink: 0,
            opacity: isActive ? 1 : undefined,
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <line x1="3" y1="4.5" x2="13" y2="4.5" />
            <line x1="3" y1="8" x2="13" y2="8" />
            <line x1="3" y1="11.5" x2="13" y2="11.5" />
          </svg>
        </div>
      </div>
    );
  }
}

const sectionHeadingStyle: React.CSSProperties = {
  padding: "10px 10px 4px",
  fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--ezy-text-muted)",
};
