import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../store";
import type { Tab } from "../types";
import { askForTicket, openJiraTicket } from "../lib/jira-project";
import { jiraSiteName } from "../lib/jira";
import { jiraQK, siteForTabIn } from "../lib/jira-sites";
import { chooseOption } from "../lib/prompt-modal";
import { resolveTicketColor } from "../lib/jira-colors";
import { requestTypeDisplay } from "../lib/jira-groups";
import { openCompactRowMenu } from "../lib/compact-row-menu";
import { isTerminalActive } from "../lib/terminal-activity";
import { refreshUnassignedNow } from "../lib/jira-notify";
import { useJiraNotifyStore } from "../store/jiraNotifyStore";
import {
  useJiraTicketRows,
  instanceOf,
  instKeyOf,
  customNameOf,
  type TicketRow,
} from "../hooks/useJiraTicketRows";
import type { JiraListTicket } from "../store/recentProjectsSlice";
import JiraStatusBadge, { statusBadgeWidth } from "./jira/JiraStatusBadge";
import JiraRowMeta, { JiraTitleFacts, buildRowCells } from "./jira/JiraRowMeta";

/**
 * A Jira project's tickets, nested under its row in the v2 vertical tab bar.
 *
 * This is the ticket RAIL's content re-laid-out as a tree: same rows, same
 * grouping, same context menus, from the same `useJiraTicketRows` hook — only
 * the presentation differs. It exists so a portrait workspace has one vertical
 * strip instead of two (see `Workspace.withRail`, which stands down while the
 * v2 strip is mounted).
 *
 * Differences from the rail, all deliberate:
 *  - no "Closed" section heading — a filled vs hollow dot already says it, and
 *    at 24px rows a heading over three items is noise;
 *  - Assigned and Archived are collapsed sub-groups rather than a header tab
 *    and a trailing section;
 *  - the site switcher rides the search row instead of a header.
 *
 * The parent owns the `jira-ticket` / `jira-assigned` surface registrations —
 * `registerSurfaceActions` is keyed by role and overwrites, so several open
 * trees registering would clobber each other. Each tree publishes itself into
 * the parent's registry through `register`.
 */

const ROW_HEIGHT = 24;
const SUB_ROW_HEIGHT = 22;
/** List row with a meta line. Tighter than the rail's 42 — 9px meta text. */
const ROW_HEIGHT_META = 34;
/** Strip width at or above which a status BADGE fits beside the ticket key. */
const BADGE_MIN_WIDTH = 240;

/** What a tree publishes so the parent can answer a context menu for it.
 *  Getters, not values: registration happens once per mounted tree, but a menu
 *  opens much later and must see the rows as they are then. */
export interface TicketTreeEntry {
  getTab: () => Tab;
  getRows: () => TicketRow[];
  getMissing: () => Set<string>;
  openRow: (row: TicketRow) => void;
}

interface VerticalTicketTreeProps {
  tab: Tab;
  /** Publish/withdraw this tree in the parent's action registry. */
  register: (tabId: string, entry: TicketTreeEntry | null) => void;
}

/** Focus a pane that lives in `tabId`, switching to that tab first. The
 *  Workspace listener ignores events aimed at a background tab, so the switch
 *  has to land before the dispatch — one frame is enough and imperceptible. */
export function focusTerminalInTab(tabId: string, terminalId: string): void {
  const store = useAppStore.getState();
  if (store.activeTabId !== tabId) store.setActiveTab(tabId);
  requestAnimationFrame(() => {
    window.dispatchEvent(
      new CustomEvent("made:focus-terminal", {
        detail: { terminalId, takeFocus: true },
      }),
    );
  });
}

export default function VerticalTicketTree({ tab, register }: VerticalTicketTreeProps) {
  const [showAssigned, setShowAssigned] = useState(false);
  const [showUnassigned, setShowUnassigned] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const jiraTicketColors = useAppStore((s) => s.jiraTicketColors);
  const ticketSnapshots = useAppStore((s) => s.jiraTicketSnapshots);
  const cliGroups = useAppStore((s) => s.jiraCliGroups ?? []);
  const requestTypeGroups = useAppStore((s) => s.jiraRequestTypeGroups ?? {});
  const jiraSites = useAppStore((s) => s.jiraSites ?? []);
  const tabSite = useAppStore((s) => siteForTabIn(s, tab));
  const siteName = useMemo(() => jiraSiteName(tabSite), [tabSite]);
  const assignedTickets = useAppStore((s) => s.jiraAssignedTickets);
  const stripWidth = useAppStore((s) => s.verticalTabBarWidth ?? BADGE_MIN_WIDTH);
  // Below this the strip cannot hold a key AND a badge, so the badge becomes a
  // dot (see renderListRow). Raising the strip's own minimum instead would move
  // every non-Jira row in the tab bar.
  const roomForBadge = stripWidth >= BADGE_MIN_WIDTH;
  const badgeW = statusBadgeWidth(stripWidth + 40);

  const {
    query,
    setQuery,
    missing,
    rows,
    filtered,
    activeRows,
    archivedRows,
    instanceCounts,
    sectionCounts,
    collapsedGroups,
    toggleGroupCollapsed,
    showSummary,
    handleRowClick: openRowInTab,
    assignedSorted,
    assignedDoneSorted,
    unassignedSorted,
    statusColorOf,
    statusIndicator,
    metaShow,
    rowTitleFields,
    rowExtraFields,
    labelForField,
    assignedMode,
    unassignedMode,
  } = useJiraTicketRows(tab, {
    onFocusTerminal: (terminalId) => focusTerminalInTab(tab.id, terminalId),
  });

  // Several projects' trees can be open at once, so a row click may target a
  // BACKGROUND project. Switch to it first: the rail could never hit this case
  // (it only ever showed the active tab), and without the switch a closed
  // ticket would resume its conversation into a tab the user cannot see.
  const handleRowClick = (row: TicketRow) => {
    const store = useAppStore.getState();
    if (store.activeTabId !== tab.id) store.setActiveTab(tab.id);
    openRowInTab(row);
  };

  // Live views of the render-time values, so the entry registered once on
  // mount never hands the menu a stale row set.
  const liveRef = useRef({ tab, filtered, missing, handleRowClick });
  liveRef.current = { tab, filtered, missing, handleRowClick };

  useEffect(() => {
    register(tab.id, {
      getTab: () => liveRef.current.tab,
      getRows: () => liveRef.current.filtered,
      getMissing: () => liveRef.current.missing,
      openRow: (r) => liveRef.current.handleRowClick(r),
    });
    return () => register(tab.id, null);
  }, [tab.id, register]);

  /**
   * Expand/collapse a browse-only queue group.
   *
   * Publishing the open state is what puts the tree on the poll cycle's
   * visibility gate — the rail does this through `railTab`, which the tree has
   * no equivalent of. Without it these lists fetch once (at best) and then go
   * stale for as long as they stay open.
   */
  const toggleQueueGroup = (
    kind: "unassigned" | "assignedDone",
    isOpen: boolean,
    setOpen: (v: boolean) => void,
  ) => {
    const next = !isOpen;
    setOpen(next);
    useJiraNotifyStore.getState().setTreeQueue(tab.id, kind, next);
    // The engine's edge-detector also fires on this store change; calling here
    // as well makes the fetch immediate even if this tree is the only surface.
    if (next) void refreshUnassignedNow(tabSite, kind);
  };

  // A collapsed tree must not keep its queues on the gate — withdraw on unmount
  // so a closed project stops costing requests.
  useEffect(() => {
    return () => {
      const notify = useJiraNotifyStore.getState();
      notify.setTreeQueue(tab.id, "unassigned", false);
      notify.setTreeQueue(tab.id, "assignedDone", false);
    };
  }, [tab.id]);

  const handleNewTicket = async () => {
    const answer = await askForTicket(tab);
    if (!answer) return;
    openJiraTicket(tab.id, {
      ticket: answer.ticket,
      cli: answer.cli,
      swedish: answer.swedish,
      english: answer.english,
      model: answer.model,
      cwd: answer.cwd,
    });
  };

  const chooseSite = () => {
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
  };

  const chevron = (open: boolean) => (
    <svg
      width="9"
      height="9"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        flexShrink: 0,
        transform: open ? "rotate(90deg)" : "none",
        transition: "transform 140ms ease-out",
      }}
    >
      <path d="M6 3l5 5-5 5" />
    </svg>
  );

  /** Section toggle — "Assigned 3" / "Archived 7". */
  const subGroup = (label: string, count: number, open: boolean, toggle: () => void) => (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={toggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        height: SUB_ROW_HEIGHT,
        padding: "0 8px 0 14px",
        cursor: "pointer",
        color: "var(--ezy-text-muted)",
        fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        userSelect: "none",
        outline: "none",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.color = "var(--ezy-text-secondary)")}
      onMouseLeave={(e) => (e.currentTarget.style.color = "var(--ezy-text-muted)")}
    >
      {chevron(open)}
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </span>
      <span style={{ fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{count}</span>
    </div>
  );

  const hamburger = (label: string) => (
    <svg
      role="button"
      tabIndex={-1}
      aria-label={`${label} actions`}
      className="jira-row-menu"
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      onClick={(e) => {
        e.stopPropagation();
        openCompactRowMenu(e.currentTarget);
      }}
      style={{ color: "var(--ezy-text-muted)", cursor: "pointer", flexShrink: 0 }}
    >
      <line x1="3" y1="5" x2="13" y2="5" />
      <line x1="3" y1="8" x2="13" y2="8" />
      <line x1="3" y1="11" x2="13" y2="11" />
    </svg>
  );

  /** Ticket-state dot: filled = a live pane, hollow = closed, accent = the
   *  pane's CLI is mid-answer. Replaces the rail's "Closed" heading. */
  const stateDot = (open: boolean, working: boolean, color: string | null) => (
    <span
      style={{
        width: 7,
        height: 7,
        borderRadius: "50%",
        flexShrink: 0,
        backgroundColor: working
          ? "var(--ezy-accent)"
          : open
            ? (color ?? "var(--ezy-text-secondary)")
            : "transparent",
        border: open || working ? "none" : "1px solid var(--ezy-text-muted)",
      }}
    />
  );

  const renderRow = (row: TicketRow) => {
    const ticket = row.session.ticket ?? "";
    const archived = !!row.session.archived;
    const isOpen = !!row.terminalId;
    const working = !!row.terminalId && isTerminalActive(row.terminalId);
    const gone = !isOpen && missing.has(row.session.id);
    const color = ticket ? resolveTicketColor(ticket, jiraTicketColors) : null;
    const unseen = !!ticketSnapshots?.[jiraQK(tabSite, ticket)]?.unseen;
    // Three label tiers, same rules as the rail: grouped in THIS section →
    // "#n" under the group title; alone here but with siblings elsewhere →
    // the full "TICKET #n"; no siblings anywhere → the bare key.
    const groupedHere =
      ((archived ? sectionCounts.archived : sectionCounts.active).get(ticket) ?? 1) > 1;
    const siblingsAnywhere = (instanceCounts.get(ticket) ?? 1) > 1;
    const custom = customNameOf(row.session);
    const numbered = `${ticket} #${instanceOf(row.session)}`;
    const label =
      custom ?? (groupedHere ? `#${instanceOf(row.session)}` : siblingsAnywhere ? numbered : ticket);
    const menuLabel = custom ?? (siblingsAnywhere ? numbered : ticket);
    const isSelected = isOpen && !archived && tab.selectedJiraTicket === instKeyOf(row.session);

    return (
      <div
        key={row.session.id}
        className="group"
        role="button"
        tabIndex={0}
        // Attributes the jira-ticket provider reads (menu/providers/rows.ts).
        data-ctx-surface="jira-ticket"
        data-ctx-id={row.session.id}
        data-ctx-label={menuLabel}
        data-ctx-ticket={ticket}
        data-ctx-open={isOpen ? "1" : "0"}
        data-ctx-gone={gone ? "1" : "0"}
        data-ctx-archived={archived ? "1" : "0"}
        data-tooltip={gone ? "This conversation's transcript is gone" : menuLabel}
        onClick={() => handleRowClick(row)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleRowClick(row);
          }
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          height: ROW_HEIGHT,
          padding: `0 6px 0 ${groupedHere ? 28 : 18}px`,
          cursor: archived || gone ? "default" : "pointer",
          opacity: gone ? 0.45 : archived ? 0.6 : 1,
          backgroundColor: isSelected ? "var(--ezy-surface)" : "transparent",
          color: isSelected ? "var(--ezy-text)" : "var(--ezy-text-muted)",
          fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
          fontVariantNumeric: "tabular-nums",
          transition: "background-color 120ms ease, color 120ms ease",
          outline: "none",
          userSelect: "none",
        }}
        onMouseEnter={(e) => {
          if (!isSelected) {
            e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.03)";
            e.currentTarget.style.color = "var(--ezy-text-secondary)";
          }
        }}
        onMouseLeave={(e) => {
          if (!isSelected) {
            e.currentTarget.style.backgroundColor = "transparent";
            e.currentTarget.style.color = "var(--ezy-text-muted)";
          }
        }}
      >
        {stateDot(isOpen, working, color)}
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {label}
        </span>
        {unseen && (
          <span
            data-tooltip="Updated in Jira since you last looked"
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              backgroundColor: "var(--ezy-accent)",
              flexShrink: 0,
            }}
          />
        )}
        {hamburger(menuLabel)}
      </div>
    );
  };

  /** Heading over a duplicated ticket's instance rows — always the plain key,
   *  whatever the instances are renamed to. A live search bypasses the fold so
   *  a match can never hide behind it. */
  const renderGroupTitle = (ticket: string) => {
    const folded = collapsedGroups.has(ticket) && !query.trim();
    const color = resolveTicketColor(ticket, jiraTicketColors);
    return (
      <div
        key={`grp-${ticket}`}
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
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          height: SUB_ROW_HEIGHT,
          padding: "0 6px 0 14px",
          cursor: "pointer",
          color: "var(--ezy-text-muted)",
          fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
          userSelect: "none",
          outline: "none",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--ezy-text-secondary)")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--ezy-text-muted)")}
      >
        {chevron(!folded)}
        {color && (
          <span style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: color, flexShrink: 0 }} />
        )}
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {ticket}
        </span>
      </div>
    );
  };

  /**
   * One Assigned / Unassigned row, at tree metrics.
   *
   * Same content as the rail's, minus what will not fit. Below BADGE_MIN_WIDTH
   * the strip has roughly 140px for key + status + hamburger, so the badge
   * degrades to a 7px dot in the status colour (the file's own `stateDot`
   * idiom) and the status NAME moves down to the meta line. That is a
   * width-driven degradation, not an oversight: raising the strip's shared
   * minimum would move every non-Jira row in the tab bar too.
   */
  const renderListRow = (t: JiraListTicket, kind: "assigned" | "unassigned") => {
    const qk = jiraQK(t.siteId, t.key);
    const unseen = !!ticketSnapshots?.[qk]?.unseen;
    const foreign = t.siteId !== tabSite;
    const color = t.status ? statusColorOf(t.status) : null;
    const showStripe = statusIndicator !== "badge";
    const showBadge = statusIndicator !== "stripe";
    // Global setting, not per-row state: summaries are all-or-nothing.
    const expanded = showSummary && !!t.summary;
    const cells = buildRowCells(
      {
        updatedIso: t.updatedIso,
        createdIso: t.createdIso,
        priorityName: t.priorityName,
        reporterName: t.reporterName,
        organization: t.organization,
        // A request type linked to a CLI group shows the GROUP's name here.
        requestType: requestTypeDisplay(cliGroups, requestTypeGroups, t.requestType),
        extra: t.extra,
        // At tree width the status name only fits down here when the badge
        // has been dropped for a dot. It leads the meta line's right cluster,
        // whose flexShrink:0 keeps it visible where the "who" phrase would
        // have ellipsed it away.
        statusText: roomForBadge ? undefined : t.status || undefined,
      },
      metaShow,
      rowTitleFields,
      rowExtraFields,
      labelForField,
    );
    // Reserved-but-empty columns don't count — no blank 42px rows.
    const hasMeta =
      cells.metaLeft.some((c) => c.text !== "") || cells.metaRight.length > 0;
    return (
      <div
        key={qk}
        className="group"
        role="button"
        tabIndex={0}
        data-ctx-surface={kind === "assigned" ? "jira-assigned" : "jira-unassigned"}
        // Composite id: the parent registry resolves several projects' trees
        // at once, so the row has to name its own tab.
        data-ctx-id={`${tab.id}::${qk}`}
        data-ctx-label={t.key}
        data-ctx-ticket={t.key}
        data-ctx-foreign={foreign ? "1" : "0"}
        data-tooltip={expanded ? undefined : t.summary || t.key}
        onClick={() => {
          useJiraNotifyStore.getState().setAssignedPreview(tab.id, qk);
          useAppStore.getState().markJiraTicketSeen(qk);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            useJiraNotifyStore.getState().setAssignedPreview(tab.id, qk);
            useAppStore.getState().markJiraTicketSeen(qk);
          }
        }}
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 1,
          height: expanded
            ? undefined
            : `calc(var(--ezy-font-scale, 1) * ${hasMeta ? ROW_HEIGHT_META : ROW_HEIGHT}px)`,
          padding: expanded ? "5px 6px 6px 16px" : "0 6px 0 16px",
          borderLeft: `2px solid ${showStripe ? (color ?? "transparent") : "transparent"}`,
          cursor: "pointer",
          color: "var(--ezy-text-muted)",
          fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
          fontVariantNumeric: "tabular-nums",
          transition: "background-color 120ms ease, color 120ms ease",
          outline: "none",
          userSelect: "none",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.03)";
          e.currentTarget.style.color = "var(--ezy-text-secondary)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = "transparent";
          e.currentTarget.style.color = "var(--ezy-text-muted)";
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          {/* Before the key, rail-parity: parked after the badge it made the
              badge column jump 12px on exactly the rows the dot marks. */}
          {unseen && (
            <span style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: "var(--ezy-accent)", flexShrink: 0 }} />
          )}
          <span style={{ flexShrink: 0, whiteSpace: "nowrap" }}>{t.key}</span>
          <span style={{ flex: 1, minWidth: 0 }} />
          <JiraTitleFacts cells={cells.title} fontPx={9} />
          {showBadge && t.status && color && (
            roomForBadge ? (
              <JiraStatusBadge status={t.status} color={color} width={badgeW} />
            ) : (
              <span
                data-tooltip={t.status}
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  backgroundColor: color,
                  flexShrink: 0,
                }}
              />
            )
          )}
          {hamburger(t.key)}
        </div>
        {/* No reserved lead-in slots at tree width (every px is spoken for),
            so no leftInset; rightInset ends the cluster under the hamburger's
            left edge: 12px svg + gap 6. */}
        {hasMeta && (
          <JiraRowMeta left={cells.metaLeft} right={cells.metaRight} fontPx={9} rightInset={18} />
        )}
        {expanded && t.summary && (
          <div
            style={{
              fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
              lineHeight: 1.45,
              color: "var(--ezy-text-secondary)",
              whiteSpace: "normal",
              overflowWrap: "anywhere",
            }}
          >
            {t.summary}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ paddingBottom: 4 }}>
      {/* Search + site switcher. A real input, in the main webview — the strip
          is ordinary DOM, so unlike an overlay menu it can hold focus. */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 6px 4px 14px" }}>
        <div
          style={{
            flex: 1,
            minWidth: 0,
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
            ref={searchRef}
            type="text"
            value={query}
            placeholder="Search tickets"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setQuery("");
                searchRef.current?.blur();
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
              fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
              color: "var(--ezy-text)",
            }}
          />
        </div>
        {siteName && (
          <span
            role={jiraSites.length > 1 ? "button" : undefined}
            tabIndex={jiraSites.length > 1 ? 0 : undefined}
            data-tooltip={jiraSites.length > 1 ? `Switch Jira site (now ${tabSite})` : tabSite}
            onClick={jiraSites.length > 1 ? chooseSite : undefined}
            onMouseEnter={jiraSites.length > 1 ? (e) => (e.currentTarget.style.color = "var(--ezy-text)") : undefined}
            onMouseLeave={jiraSites.length > 1 ? (e) => (e.currentTarget.style.color = "var(--ezy-text-muted)") : undefined}
            style={{
              maxWidth: 52,
              fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
              color: "var(--ezy-text-muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flexShrink: 0,
              cursor: jiraSites.length > 1 ? "pointer" : undefined,
              outline: "none",
            }}
          >
            {siteName}
          </span>
        )}
      </div>

      {filtered.length === 0 && (
        <div
          style={{
            padding: "2px 8px 6px 18px",
            fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
            lineHeight: 1.5,
            color: "var(--ezy-text-muted)",
          }}
        >
          {rows.length === 0 ? "No tickets yet." : "No ticket matches that search."}
        </div>
      )}

      {activeRows.map((row, i) => {
        const t = row.session.ticket!;
        const grouped = (sectionCounts.active.get(t) ?? 1) > 1;
        const groupStart = grouped && (i === 0 || activeRows[i - 1].session.ticket !== t);
        const folded = grouped && !query.trim() && collapsedGroups.has(t);
        return (
          <div key={row.session.id}>
            {groupStart && renderGroupTitle(t)}
            {!folded && renderRow(row)}
          </div>
        );
      })}

      {/* New ticket — the tree owns this now that the rail's header is gone. */}
      <div
        role="button"
        tabIndex={0}
        onClick={handleNewTicket}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            void handleNewTicket();
          }
        }}
        data-tooltip="New ticket"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          height: ROW_HEIGHT,
          padding: "0 6px 0 18px",
          cursor: "pointer",
          color: "var(--ezy-text-muted)",
          fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
          transition: "background-color 120ms ease, color 120ms ease",
          outline: "none",
          userSelect: "none",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.03)";
          e.currentTarget.style.color = "var(--ezy-text)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = "transparent";
          e.currentTarget.style.color = "var(--ezy-text-muted)";
        }}
      >
        <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0 }}>
          <line x1="8" y1="3" x2="8" y2="13" />
          <line x1="3" y1="8" x2="13" y2="8" />
        </svg>
        <span>New ticket</span>
      </div>

      {assignedMode && assignedTickets.length > 0 && (
        <>
          {/* Count of what is actually RENDERED — a search shrinks the list, so
              the unfiltered total would disagree with the rows under it. */}
          {subGroup("Assigned", assignedSorted.length, showAssigned, () => setShowAssigned((v) => !v))}
          {showAssigned && assignedSorted.map((t) => renderListRow(t, "assigned"))}
        </>
      )}

      {/* Assigned AND resolved. The rail shows this as an Open/Done mini tab;
          the tree has no tab strip, so it takes the same shape as Archived —
          a collapsed sub-group. Opening it is what triggers the fetch. */}
      {/* Both queues render their header even when EMPTY, unlike Archived:
          they are fetched only while visible, so gating the header on a
          non-empty list is a deadlock — hidden because empty, empty because
          nothing ever asked for it. */}
      {assignedMode && (
        <>
          {subGroup("Resolved", assignedDoneSorted.length, showResolved, () =>
            toggleQueueGroup("assignedDone", showResolved, setShowResolved),
          )}
          {showResolved && assignedDoneSorted.map((t) => renderListRow(t, "assigned"))}
        </>
      )}

      {unassignedMode && (
        <>
          {subGroup("Unassigned", unassignedSorted.length, showUnassigned, () =>
            toggleQueueGroup("unassigned", showUnassigned, setShowUnassigned),
          )}
          {showUnassigned && unassignedSorted.map((t) => renderListRow(t, "unassigned"))}
        </>
      )}

      {archivedRows.length > 0 && (
        <>
          {subGroup("Archived", archivedRows.length, showArchived, () => setShowArchived((v) => !v))}
          {showArchived &&
            archivedRows.map((row, i) => {
              const t = row.session.ticket!;
              const grouped = (sectionCounts.archived.get(t) ?? 1) > 1;
              const groupStart = grouped && (i === 0 || archivedRows[i - 1].session.ticket !== t);
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
  );
}
