import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../store";
import type { ProjectSession, Tab } from "../types";
import { findAllTerminalLeaves } from "../lib/layout-utils";
import { sessionStillExists } from "../lib/session-exists";
import { openJiraTicket } from "../lib/jira-project";
import { jiraSiteName } from "../lib/jira";
import { siteForTabIn } from "../lib/jira-sites";
import { jiraCliOfSession } from "../lib/jira-mcp";
import { readSessionsIndex } from "../lib/sessions-index";
import { jiraInstanceKey } from "../lib/jira-layout";
import { parkedTicketName } from "../lib/jira-session";
import { useJiraNotifyStore } from "../store/jiraNotifyStore";
import {
  DEFAULT_JIRA_ROW_META_SHOW,
  DEFAULT_JIRA_ROW_TITLE_FIELDS,
  DEFAULT_JIRA_SORT,
} from "../store/recentProjectsSlice";
import { groupIssues, sortIssues } from "../lib/jira-row-sort";
import { buildStatusColorMap, resolveStatusColor } from "../lib/jira-status-colors";
import { fieldLabel } from "../lib/jira-fields";

/**
 * The ticket rail's data layer, lifted out of JiraTicketRail so the vertical
 * tab bar's ticket TREE can show the same rows without reimplementing any of
 * it. Everything here is a faithful move — the instance/group/naming rules are
 * subtle enough (numbers survive archiving, a lone survivor folds back to the
 * bare key, CLI-side renames are adopted only when they changed) that a second
 * implementation would drift within a release.
 *
 * `enabled` gates the two polling effects. Several trees can be expanded at
 * once in the tab bar, and a transcript probe per project per render would
 * multiply SSH round-trips for lists nobody is looking at.
 */

/** 1 for the original row, 2+ for duplicates. */
export const instanceOf = (s: ProjectSession) => s.ticketInstance ?? 1;
/** The key the canvas selection and pane ids use for this row. */
export const instKeyOf = (s: ProjectSession) =>
  jiraInstanceKey(s.ticket ?? "", s.ticketInstance);
/** The name a row would have if never edited — ticket key (+ " #n"). */
export const defaultNameOf = (s: ProjectSession) =>
  parkedTicketName({ ticket: s.ticket ?? "", instance: s.ticketInstance });
/** The user-edited name, or null while the row carries a default one. Both
 *  the bare key and the numbered form count as defaults — an original is
 *  "TICKET" alone but becomes "TICKET #1" while duplicates exist. */
export const customNameOf = (s: ProjectSession) => {
  if (!s.name || !s.ticket) return null;
  if (s.name === s.ticket) return null;
  if (s.name === `${s.ticket} #${s.ticketInstance ?? 1}`) return null;
  return s.name;
};

export interface TicketRow {
  session: ProjectSession;
  /** Set when a pane in this tab is currently running this session. */
  terminalId?: string;
}

export interface UseJiraTicketRowsOptions {
  /** Focus a pane once a row resolves to a live terminal. */
  onFocusTerminal: (terminalId: string) => void;
  /** False while the list is collapsed/hidden — suspends the polling effects. */
  enabled?: boolean;
}

export function useJiraTicketRows(tab: Tab, opts: UseJiraTicketRowsOptions) {
  const { onFocusTerminal, enabled = true } = opts;
  const [query, setQuery] = useState("");
  const [missing, setMissing] = useState<Set<string>>(new Set());
  // Ticket keys whose duplicate-group rows are folded away. Session-local on
  // purpose: a fold is a reading aid, not workspace state worth persisting. A
  // live search bypasses the fold so a match can never hide behind one.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  // Folded STATUS/CATEGORY buckets. A second Set rather than sharing
  // collapsedGroups: that one is keyed by ticket key, and a project literally
  // named DONE would otherwise collide with the Done bucket.
  const [collapsedBuckets, setCollapsedBuckets] = useState<Set<string>>(new Set());
  // Rows whose summary is unfolded. Also session-local — an expanded row is a
  // glance, not workspace state.
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  /** Session ids whose conversation TEXT matches the query — null while the
   *  query is empty or the index is still loading. */
  const [contentMatches, setContentMatches] = useState<Set<string> | null>(null);

  const assignedMode = useAppStore((s) => s.jiraAssignedMode ?? false);
  const unassignedMode = useAppStore((s) => s.jiraUnassignedMode ?? false);
  const assignedTickets = useAppStore((s) => s.jiraAssignedTickets);
  const unassignedTickets = useAppStore((s) => s.jiraUnassignedTickets);
  const assignedDoneTickets = useAppStore((s) => s.jiraAssignedDoneTickets);
  const listSort = useAppStore((s) => s.jiraListSort);
  const listGrouping = useAppStore((s) => s.jiraListGrouping ?? "flat");
  const statusIndicator = useAppStore((s) => s.jiraStatusIndicator ?? "both");
  const rowMetaShow = useAppStore((s) => s.jiraRowMetaShow);
  const rowTitleFieldsRaw = useAppStore((s) => s.jiraRowTitleFields);
  const statusColorMode = useAppStore((s) => s.jiraStatusColorMode ?? "auto");
  const statusColorOverrides = useAppStore((s) => s.jiraStatusColors);
  const ticketSnapshots = useAppStore((s) => s.jiraTicketSnapshots);
  const tabSite = useAppStore((s) => siteForTabIn(s, tab));
  const siteFields = useAppStore((s) => s.jiraSiteFields);
  const sitePriorities = useAppStore((s) => s.jiraSitePriorities);
  const extraFields = useAppStore((s) => s.jiraExtraFields);
  const assignedScope = useJiraNotifyStore((s) => s.assignedScope[tab.id] ?? "open");
  const railTab = useJiraNotifyStore((s) => {
    const t = s.railTab[tab.id] ?? "tickets";
    // A mode turned off must not leave a tab stranded on a list with no source.
    if (t === "assigned" && !assignedMode) return "tickets";
    if (t === "unassigned" && !unassignedMode) return "tickets";
    return t;
  });

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
    if (!enabled) return;
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
  }, [rows, tab.workingDir, tab.backend, tab.serverId, enabled]);

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
    if (!enabled) return;
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
  }, [tab.id, tab.workingDir, tab.backend, tab.serverId, projectKey, enabled]);

  // Filtered unconditionally — the rail shows these only while its header tab
  // is on "Assigned", but the v2 tree has no header tab and reaches for them
  // from a collapsed sub-group instead. Consumers decide when to render.
  const assignedFiltered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return assignedTickets;
    return assignedTickets.filter(
      (t) =>
        t.key.toLowerCase().includes(q) ||
        t.summary.toLowerCase().includes(q) ||
        (jiraSiteName(t.siteId) ?? "").toLowerCase().includes(q),
    );
  }, [assignedTickets, query]);

  const unassignedFiltered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return unassignedTickets ?? [];
    return (unassignedTickets ?? []).filter(
      (t) =>
        t.key.toLowerCase().includes(q) ||
        t.summary.toLowerCase().includes(q) ||
        (t.reporterName ?? "").toLowerCase().includes(q) ||
        (jiraSiteName(t.siteId) ?? "").toLowerCase().includes(q),
    );
  }, [unassignedTickets, query]);

  const assignedDoneFiltered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = assignedDoneTickets ?? [];
    if (!q) return all;
    return all.filter(
      (t) =>
        t.key.toLowerCase().includes(q) ||
        t.summary.toLowerCase().includes(q) ||
        (jiraSiteName(t.siteId) ?? "").toLowerCase().includes(q),
    );
  }, [assignedDoneTickets, query]);

  const sort = listSort ?? DEFAULT_JIRA_SORT;
  const priorityOrder = sitePriorities?.[tabSite];
  const assignedSorted = useMemo(() => {
    const s = sort.assigned ?? DEFAULT_JIRA_SORT.assigned;
    return sortIssues(assignedFiltered, s.key, s.dir, priorityOrder);
  }, [assignedFiltered, sort.assigned, priorityOrder]);
  const unassignedSorted = useMemo(() => {
    const s = sort.unassigned ?? DEFAULT_JIRA_SORT.unassigned;
    return sortIssues(unassignedFiltered, s.key, s.dir, priorityOrder);
  }, [unassignedFiltered, sort.unassigned, priorityOrder]);

  const assignedDoneSorted = useMemo(() => {
    const c = sort.assigned ?? DEFAULT_JIRA_SORT.assigned;
    return sortIssues(assignedDoneFiltered, c.key, c.dir, priorityOrder);
  }, [assignedDoneFiltered, sort.assigned, priorityOrder]);

  const assignedGroups = useMemo(
    () => groupIssues(assignedSorted, listGrouping),
    [assignedSorted, listGrouping],
  );
  const assignedDoneGroups = useMemo(
    () => groupIssues(assignedDoneSorted, listGrouping),
    [assignedDoneSorted, listGrouping],
  );
  const unassignedGroups = useMemo(
    () => groupIssues(unassignedSorted, listGrouping),
    [unassignedSorted, listGrouping],
  );

  // ONE color map across all three tabs, built from the union of every status
  // the app currently knows about — a status seen in Assigned must render the
  // same color in Unassigned and in a pane header, or the color stops being
  // information. The union also keeps collision-probing stable as a user moves
  // between tabs.
  const statusColors = useMemo(() => {
    const names: string[] = [];
    for (const t of assignedTickets ?? []) if (t.status) names.push(t.status);
    for (const t of unassignedTickets ?? []) if (t.status) names.push(t.status);
    for (const t of assignedDoneTickets ?? []) if (t.status) names.push(t.status);
    for (const snap of Object.values(ticketSnapshots ?? {})) {
      if (snap?.statusName) names.push(snap.statusName);
    }
    return buildStatusColorMap(names);
  }, [assignedTickets, unassignedTickets, assignedDoneTickets, ticketSnapshots]);

  const statusColorOf = useMemo(
    () => (status: string) =>
      resolveStatusColor(status, statusColors, statusColorMode, statusColorOverrides),
    [statusColors, statusColorMode, statusColorOverrides],
  );

  // MERGE the defaults, don't substitute them: a store persisted before a key
  // existed carries the object WITHOUT that key, so a plain `?? DEFAULT` would
  // leave the new column reading `undefined` and silently off forever.
  const rowTitleFields = rowTitleFieldsRaw ?? DEFAULT_JIRA_ROW_TITLE_FIELDS;
  const metaShow = useMemo(
    () => ({ ...DEFAULT_JIRA_ROW_META_SHOW, ...(rowMetaShow ?? {}) }),
    [rowMetaShow],
  );

  // Extra Jira fields the user added as row columns, narrowed to ones THIS
  // site actually has — a field picked while a different site was active would
  // otherwise render a permanently blank column.
  const siteFieldList = siteFields?.[tabSite];
  const rowExtraFields = useMemo(() => {
    const picked = extraFields?.rows ?? [];
    if (picked.length === 0) return [];
    const known = new Set((siteFieldList ?? []).map((f) => f.id));
    return known.size === 0 ? picked : picked.filter((id) => known.has(id));
  }, [extraFields?.rows, siteFieldList]);
  const labelForField = useMemo(
    () => (id: string) => fieldLabel(siteFieldList, id),
    [siteFieldList],
  );

  const toggleGroupCollapsed = (ticket: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(ticket)) next.delete(ticket);
      else next.add(ticket);
      return next;
    });
  };

  const toggleBucketCollapsed = (id: string) => {
    setCollapsedBuckets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleRowExpanded = (id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /**
   * Opening a Jira tab that has never had a ticket selected lands on the top
   * row instead of an empty canvas.
   *
   * Once per mount (the ref), ACTIVE tab only, and it prefers a row whose pane
   * is already live — `handleRowClick` on a closed row resumes its CLI, and
   * merely switching to a tab must not silently spawn one. If nothing is open
   * it falls back to the top row, which is what "auto-open the top one" asks
   * for; the group sort already puts open tickets first, so that fallback only
   * happens when the whole project is closed.
   */
  const autoOpenedRef = useRef(false);
  const isActiveTab = useAppStore((s) => s.activeTabId === tab.id);
  useEffect(() => {
    if (autoOpenedRef.current || !enabled || !isActiveTab) return;
    if (railTab !== "tickets") return;
    // Already has a selection — remember that and never auto-open for this
    // mount, so closing the last pane doesn't immediately reopen something.
    if (tab.selectedJiraTicket) {
      autoOpenedRef.current = true;
      return;
    }
    // Rows arrive a tick after mount; keep waiting rather than giving up.
    if (activeRows.length === 0) return;
    autoOpenedRef.current = true;
    const target = activeRows.find((r) => !!r.terminalId) ?? activeRows[0];
    if (!missing.has(target.session.id)) handleRowClickRef.current(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, isActiveTab, railTab, tab.selectedJiraTicket, activeRows, missing]);

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
  // Consumers register surface actions once, so they reach the current click
  // handler through a ref rather than re-registering on every render.
  const handleRowClickRef = useRef(handleRowClick);
  handleRowClickRef.current = handleRowClick;
  const rowsRef = useRef(filtered);
  rowsRef.current = filtered;
  const missingRef = useRef(missing);
  missingRef.current = missing;

  return {
    query,
    setQuery,
    missing,
    missingRef,
    rows,
    rowsRef,
    filtered,
    activeRows,
    archivedRows,
    instanceCounts,
    sectionCounts,
    firstClosedIdx,
    collapsedGroups,
    toggleGroupCollapsed,
    collapsedBuckets,
    toggleBucketCollapsed,
    expandedRows,
    toggleRowExpanded,
    handleRowClick,
    handleRowClickRef,
    assignedFiltered,
    assignedSorted,
    assignedGroups,
    assignedDoneSorted,
    assignedDoneGroups,
    assignedDoneTickets,
    assignedScope,
    unassignedFiltered,
    unassignedSorted,
    unassignedGroups,
    unassignedTickets,
    statusColorOf,
    statusIndicator,
    metaShow,
    rowTitleFields,
    rowExtraFields,
    labelForField,
    tabSite,
    listGrouping,
    sort,
    railTab,
    assignedMode,
    unassignedMode,
    projectKey,
  };
}
