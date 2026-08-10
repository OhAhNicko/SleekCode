import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../store";
import type { Tab } from "../types";
import {
  DEFAULT_JIRA_RAIL_WIDTHS,
  DEFAULT_JIRA_SORT,
  type JiraListTicket,
  type JiraRailWidths,
  type JiraSortDir,
  type JiraSortKey,
} from "../store/recentProjectsSlice";
import { JIRA_SORT_KEYS, JIRA_SORT_LABEL, type JiraRowGroup } from "../lib/jira-row-sort";
import { useOverlayMenu } from "../lib/useOverlayMenu";
import { refreshJiraNow } from "../lib/jira-notify";
import { relativeShort } from "../lib/relative-time";
import JiraStatusBadge, { statusBadgeWidth } from "./jira/JiraStatusBadge";
import JiraRowMeta, { buildRowMeta } from "./jira/JiraRowMeta";
import { askForTicket, openJiraTicket } from "../lib/jira-project";
import { registerSurfaceActions, unregisterSurfaceActions } from "../lib/surface-actions";
import {
  buildJiraTicketActions,
  buildJiraAssignedActions,
  buildJiraUnassignedActions,
} from "../lib/jira-surface-actions";
import { jiraSiteName } from "../lib/jira";
import { useJiraNotifyStore } from "../store/jiraNotifyStore";
import { jiraQK, siteForTabIn } from "../lib/jira-sites";
import { chooseOption } from "../lib/prompt-modal";
import { resolveTicketColor, contrastTextFor } from "../lib/jira-colors";
import { openCompactRowMenu } from "../lib/compact-row-menu";
import {
  useJiraTicketRows,
  instanceOf,
  instKeyOf,
  customNameOf,
  type TicketRow,
} from "../hooks/useJiraTicketRows";

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

/** Header row height. Pinned to a PANE header's 28px on purpose — a rail row
 *  and the pane it points at are meant to read as one object. */
const ROW_HEIGHT = 28;
/** Row height with the meta line on. Both are font-scaled at the use site;
 *  raw px here would clip at --ezy-font-scale > 1. */
const ROW_HEIGHT_META = 42;

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

/** The three list flavours the rail can render. "assignedDone" reuses the
 *  assigned surface for menus — a resolved ticket is still one of yours. */
type JiraListKind = "assigned" | "assignedDone" | "unassigned";

interface JiraTicketRailProps {
  tab: Tab;
  onFocusTerminal: (terminalId: string) => void;
}

export default function JiraTicketRail({ tab, onFocusTerminal }: JiraTicketRailProps) {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sortBtnRef = useRef<HTMLDivElement>(null);
  const [showSort, setShowSort] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
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
  const railWidths = useAppStore((s) => s.jiraRailWidths ?? DEFAULT_JIRA_RAIL_WIDTHS);
  const setJiraRailWidth = useAppStore((s) => s.setJiraRailWidth);
  const setJiraListSort = useAppStore((s) => s.setJiraListSort);
  const unassignedError = useJiraNotifyStore((s) => s.unassignedErrors[tabSite]);
  const lastPollAt = useJiraNotifyStore((s) => s.lastPollAt);
  const assignedPreview = useJiraNotifyStore((s) => s.assignedPreview[tab.id]);

  const {
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
    assignedGroups,
    assignedSorted,
    assignedDoneGroups,
    assignedDoneSorted,
    assignedDoneTickets,
    assignedScope,
    unassignedGroups,
    unassignedSorted,
    unassignedTickets,
    statusColorOf,
    statusIndicator,
    metaShow,
    rowExtraFields,
    labelForField,
    listGrouping,
    sort,
    railTab,
    unassignedMode,
  } = useJiraTicketRows(tab, { onFocusTerminal });

  // Assigned and Unassigned carry a badge column and a meta line, so they get
  // their own (wider) persisted width; the plain Tickets list keeps a narrow
  // one. Same rail, two remembered sizes.
  const widthKey: keyof JiraRailWidths = railTab === "tickets" ? "tickets" : "list";
  const railWidth = railWidths[widthKey] ?? DEFAULT_JIRA_RAIL_WIDTHS[widthKey];
  const badgeW = statusBadgeWidth(railWidth);
  const listTab = railTab === "assigned" || railTab === "unassigned";
  const sortFor = railTab === "unassigned" ? "unassigned" : "assigned";
  const activeSort = sort[sortFor] ?? DEFAULT_JIRA_SORT[sortFor];

  // Drag-to-resize. Pointer capture on the handle, so a fast drag that leaves
  // the 4px strip keeps resizing instead of dropping the gesture.
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const onResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startW: railWidth };
  };
  const onResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    // The rail is on the LEFT of the canvas, so rightward drag widens it.
    setJiraRailWidth(widthKey, d.startW + (e.clientX - d.startX));
  };
  const endResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  // Sort menu. Every row is `sticky` so picking a field applies it and leaves
  // the menu open — pick, watch it reorder, flip the direction, dismiss.
  useOverlayMenu({
    id: `jira-rail-sort-${tab.id}`,
    open: showSort,
    anchorRef: sortBtnRef,
    payload: showSort
      ? {
          placement: "below-end",
          width: 190,
          sections: [
            {
              title: "Sort by",
              items: JIRA_SORT_KEYS.map((k) => ({
                actionId: `field:${k}`,
                label: JIRA_SORT_LABEL[k],
                checked: activeSort.key === k,
                sticky: true,
              })),
            },
            {
              items: (
                [
                  ["desc", "Newest first"],
                  ["asc", "Oldest first"],
                ] as const
              ).map(([d, label]) => ({
                actionId: `dir:${d}`,
                label,
                checked: activeSort.dir === d,
                sticky: true,
              })),
            },
          ],
        }
      : null,
    onAction: (actionId) => {
      const [kind, value] = actionId.split(":");
      if (kind === "field") setJiraListSort(sortFor, { key: value as JiraSortKey });
      else if (kind === "dir") setJiraListSort(sortFor, { dir: value as JiraSortDir });
    },
    onClose: () => setShowSort(false),
  });

  // Context-menu handlers. Registered per surface (not per row) — the provider
  // disables its items when nothing is registered, so a menu can never render an
  // action that silently does nothing. The bodies live in lib/jira-surface-
  // actions.ts, shared with the v2 tab bar's ticket tree.
  useEffect(() => {
    registerSurfaceActions(
      "jira-ticket",
      buildJiraTicketActions((id) => {
        const row = rowsRef.current.find((r) => r.session.id === id);
        if (!row) return null;
        return {
          row,
          tab,
          missing: missingRef.current,
          focusTerminal: onFocusTerminal,
          openRow: (r) => handleRowClickRef.current(r),
        };
      }),
    );
    return () => unregisterSurfaceActions("jira-ticket");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, tab.workingDir]);

  // The rail only ever shows ONE tab's tickets, so the list resolvers hand
  // back this tab and the row id verbatim.
  useEffect(() => {
    registerSurfaceActions(
      "jira-assigned",
      buildJiraAssignedActions((qkey) => ({ tab, qkey })),
    );
    registerSurfaceActions(
      "jira-unassigned",
      buildJiraUnassignedActions((qkey) => ({ tab, qkey })),
    );
    return () => {
      unregisterSurfaceActions("jira-assigned");
      unregisterSurfaceActions("jira-unassigned");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);


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
        width: railWidth,
        flexShrink: 0,
        position: "relative",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        backgroundColor: "var(--ezy-bg)",
        borderRight: "1px solid var(--ezy-border)",
        color: "var(--ezy-text)",
      }}
    >
      {/* Resize handle. 4px of grab area sitting ON the border, so the border
          itself stays a 1px hairline — a visibly thick divider would read as
          chrome rather than an edge. */}
      <div
        role="separator"
        aria-label="Resize ticket list"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onDoubleClick={() => setJiraRailWidth(widthKey, DEFAULT_JIRA_RAIL_WIDTHS[widthKey])}
        data-tooltip="Drag to resize · double-click to reset"
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          right: -2,
          width: 4,
          cursor: "col-resize",
          zIndex: 2,
        }}
      />
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
        {assignedMode || unassignedMode ? (
          // Segment switcher — same 10px uppercase voice as the plain heading;
          // the active segment simply carries the text color. `flex: 1` +
          // overflow hidden so three segments at --ezy-font-scale > 1 ellipse
          // instead of shoving the "+" off the edge.
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
            }}
          >
            {(
              [
                "tickets",
                ...(assignedMode ? (["assigned"] as const) : []),
                ...(unassignedMode ? (["unassigned"] as const) : []),
              ] as const
            ).map((seg) => {
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
                  aria-label={seg === "tickets" ? "CLI tickets" : undefined}
                  data-tooltip={
                    seg === "tickets"
                      ? "Tickets you have a CLI conversation on"
                      : seg === "assigned"
                        ? "Jira tickets assigned to you"
                        : "Open tickets nobody has picked up"
                  }
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
                    // The ACTIVE segment never gives up room; the others
                    // ellipse first. Losing "Unassigned" to "Unassign…" while
                    // reading Tickets costs nothing.
                    minWidth: 0,
                    flexShrink: active ? 0 : 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {seg === "tickets" ? "CLI" : seg === "assigned" ? "Assigned" : "Unassigned"}
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
            {/* Alone in the header there is room for the full label; beside
                Assigned/Unassigned it shortens to "CLI". */}
            CLI tickets
          </span>
        )}
        {/* The site name used to sit here. Three segments plus a site name plus
            the "+" overflow a 28px header well before the minimum rail width,
            so the site switcher moved down onto the search row — which is also
            where the v2 ticket tree has always kept it. */}
        <div style={{ marginLeft: "auto" }} />
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

      {/* Search — same field as Settings, so the two read as one system.
          Shares its row with the site switcher and (on the list tabs) the
          sort control, both of which cost no vertical space here. */}
      <div
        style={{
          padding: "0 8px 8px",
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            flex: 1,
            minWidth: 0,
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
        {/* Open / Done inside Assigned. A fourth TOP-LEVEL tab would not fit —
            three already forced the site name off the header — and these are
            two halves of one list rather than a third thing. */}
        {railTab === "assigned" && (
          <div
            role="tablist"
            aria-label="Assigned scope"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 2,
              flexShrink: 0,
              padding: 2,
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
              backgroundColor: "var(--ezy-surface)",
            }}
          >
            {(
              [
                ["open", "Open"],
                ["done", "Done"],
              ] as const
            ).map(([scope, label]) => {
              const active = assignedScope === scope;
              return (
                <span
                  key={scope}
                  role="tab"
                  aria-selected={active}
                  tabIndex={0}
                  data-tooltip={
                    scope === "open" ? "Assigned and still open" : "Assigned and resolved"
                  }
                  onClick={() => useJiraNotifyStore.getState().setAssignedScope(tab.id, scope)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      useJiraNotifyStore.getState().setAssignedScope(tab.id, scope);
                    }
                  }}
                  style={{
                    padding: "1px 6px",
                    borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
                    fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    whiteSpace: "nowrap",
                    cursor: "pointer",
                    userSelect: "none",
                    outline: "none",
                    color: active ? "var(--ezy-text)" : "var(--ezy-text-muted)",
                    backgroundColor: active ? "var(--ezy-border)" : "transparent",
                  }}
                >
                  {label}
                </span>
              );
            })}
          </div>
        )}
        {/* Refresh. The background cadence is 60s (180s for Unassigned) which
            is right for a notifier and wrong for the moment you know something
            just changed in Jira. Disabled + dimmed while in flight rather than
            spun — a spinner in a 22px slot is noise. */}
        <div
          role="button"
          tabIndex={refreshing ? -1 : 0}
          aria-label="Refresh from Jira"
          aria-busy={refreshing}
          data-tooltip={
            refreshing
              ? "Refreshing…"
              : lastPollAt
                ? `Refresh from Jira · last checked ${relativeShort(lastPollAt)}`
                : "Refresh from Jira"
          }
          onClick={() => {
            if (refreshing) return;
            setRefreshing(true);
            void refreshJiraNow(tabSite).finally(() => setRefreshing(false));
          }}
          onKeyDown={(e) => {
            if (refreshing) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setRefreshing(true);
              void refreshJiraNow(tabSite).finally(() => setRefreshing(false));
            }
          }}
          onMouseEnter={(e) => {
            if (!refreshing) e.currentTarget.style.color = "var(--ezy-text)";
          }}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--ezy-text-muted)")}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 22,
            height: 22,
            flexShrink: 0,
            borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
            color: "var(--ezy-text-muted)",
            opacity: refreshing ? 0.4 : 1,
            cursor: refreshing ? "default" : "pointer",
            outline: "none",
          }}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
            <path d="M13.5 2.5V6H10" />
          </svg>
        </div>
        {/* Sort — list tabs only. The current sort lives in the tooltip and as
            the menu's checkmark; a 240px rail has no room for a text
            affordance, and the same rows are on the rail's right-click menu. */}
        {listTab && (
          <div
            ref={sortBtnRef}
            role="button"
            tabIndex={0}
            aria-label="Sort tickets"
            data-tooltip={`Sort: ${JIRA_SORT_LABEL[activeSort.key]}, ${
              activeSort.dir === "desc" ? "newest first" : "oldest first"
            }`}
            onClick={() => setShowSort((v) => !v)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setShowSort((v) => !v);
              }
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--ezy-text)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--ezy-text-muted)")}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 22,
              height: 22,
              flexShrink: 0,
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
              color: "var(--ezy-text-muted)",
              cursor: "pointer",
              outline: "none",
            }}
          >
            {/* Descending-bars glyph, mirrored when ascending. Inline SVG, not
                a "▼" — every chevron in this app is drawn, never typed. */}
            <svg
              width="13"
              height="13"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              style={{
                transform: activeSort.dir === "asc" ? "scaleY(-1)" : undefined,
                transition: "transform 0.15s ease",
              }}
            >
              <line x1="3" y1="4" x2="13" y2="4" />
              <line x1="3" y1="8" x2="10" y2="8" />
              <line x1="3" y1="12" x2="7" y2="12" />
            </svg>
          </div>
        )}
      </div>

      {/* List */}
      {listTab ? (
        railTab === "unassigned"
          ? renderList("unassigned", unassignedGroups, unassignedSorted.length)
          : assignedScope === "done"
            ? renderList("assignedDone", assignedDoneGroups, assignedDoneSorted.length)
            : renderList("assigned", assignedGroups, assignedSorted.length)
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

  /** Open the row's COMPACT menu from its hamburger. Both rail surfaces —
   *  ticket rows and assigned rows — share this path with the v2 tab bar's
   *  ticket tree; see lib/compact-row-menu.ts for why it is a synthesized
   *  contextmenu rather than a second menu definition. */
  function openRowMenu(anchor: Element): void {
    openCompactRowMenu(anchor);
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
    // The Tickets tab's issue-side facts come from the ticket's SNAPSHOT —
    // these rows are sessions, not Jira issues, so there is nothing else to
    // read them from.
    const snap = ticket ? ticketSnapshots?.[jiraQK(tabSite, ticket)] : undefined;
    const statusColor = snap?.statusName ? statusColorOf(snap.statusName) : null;
    // NOTE the deliberate asymmetry with the list tabs: this row's LEFT STRIPE
    // stays the ticket's own identity colour — the same one tinting its Claude
    // pane, which is what lets the rail work as a legend for the canvas — so
    // only the badge follows the status here. On Assigned/Unassigned, where
    // status is the organising principle, stripe and badge share one colour.
    const showBadge = statusIndicator !== "stripe";
    const expanded = expandedRows.has(row.session.id);
    const metaCells = buildRowMeta(
      {
        updatedIso: snap?.updatedIso,
        createdIso: snap?.createdIso,
        priorityName: snap?.priorityName,
        reporterName: snap?.reporterName,
        organization: snap?.organization,
        requestType: snap?.requestType,
        extra: snap?.extra,
      },
      metaShow,
      rowExtraFields,
      labelForField,
    );
    const hasMeta = metaCells.length > 0;
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
          flexDirection: "column",
          justifyContent: "center",
          gap: 2,
          height: expanded
            ? undefined
            : `calc(var(--ezy-font-scale, 1) * ${hasMeta ? ROW_HEIGHT_META : ROW_HEIGHT}px)`,
          padding: expanded
            ? `6px 10px 8px ${groupedHere ? 18 : 8}px`
            : `0 10px 0 ${groupedHere ? 18 : 8}px`,
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
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        {snap?.summary && expandChevron(expanded, () => toggleRowExpanded(row.session.id))}
        {snap?.unseen && unseenDot()}
        <span
          style={{
            // A renamed row can be arbitrarily long, so unlike the list tabs
            // this label DOES ellipse — a custom name is the user's own text,
            // not a fixed-width identifier they need to read in full.
            flex: custom ? 1 : "0 1 auto",
            minWidth: 0,
            fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
            fontWeight: isOpen || snap?.unseen ? 600 : 400,
            fontVariantNumeric: "tabular-nums",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
        <span style={{ flex: 1, minWidth: 0 }} />
        {showBadge && snap?.statusName && statusColor && (
          <JiraStatusBadge
            status={snap.statusName}
            color={statusColor}
            width={badgeW}
            // Archived rows go neutral rather than inheriting the row's
            // opacity — a dimmed colour chip reads as a translucent badge.
            dim={archived}
            // On a full-colour row the badge and the row can land on the same
            // hue; an inset hairline keeps the chip readable either way.
            ring={paintFull ? contrastTextFor(color!) : undefined}
          />
        )}
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
        {hasMeta && <JiraRowMeta cells={metaCells} muted={!paintFull} />}
        {expanded && snap?.summary && (
          <div
            style={{
              fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
              lineHeight: 1.45,
              color: paintFull ? undefined : "var(--ezy-text-secondary)",
              opacity: paintFull ? 0.85 : 1,
              whiteSpace: "normal",
              overflowWrap: "anywhere",
            }}
          >
            {snap.summary}
          </div>
        )}
      </div>
    );
  }

  /**
   * The Assigned / Unassigned list.
   *
   * One renderer for both: the rows are the same Jira issues, differing only in
   * whether they already have an assignee. Keeping them one function is what
   * stops the two tabs drifting into slightly different rows.
   */
  function renderList(kind: JiraListKind, groups: JiraRowGroup[], total: number) {
    const grouped = listGrouping !== "flat";
    const sourceEmpty =
      kind === "assigned"
        ? assignedTickets.length === 0
        : kind === "assignedDone"
          ? (assignedDoneTickets ?? []).length === 0
          : (unassignedTickets ?? []).length === 0;
    return (
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingBottom: 8 }}>
        {/* A failed unassigned query keeps the last good rows and says so —
            silently showing a stale list would be worse than either. */}
        {kind === "unassigned" && unassignedError && (
          <div
            style={{
              padding: "6px 10px",
              fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
              lineHeight: 1.5,
              color: "var(--ezy-text-muted)",
            }}
            data-tooltip={unassignedError}
          >
            Couldn't refresh the queue — check the project's Browse permission.
          </div>
        )}
        {total === 0 && (
          <div
            style={{
              padding: "8px 10px",
              fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
              lineHeight: 1.5,
              color: "var(--ezy-text-muted)",
            }}
          >
            {!sourceEmpty
              ? "No ticket matches that search."
              : kind === "assigned"
                ? "No assigned tickets. They appear here once Jira credentials are set in Settings > Jira."
                : kind === "assignedDone"
                  ? "Nothing you were assigned has been resolved yet."
                  : "Nothing unassigned in this project's ticket prefixes right now."}
          </div>
        )}
        {groups.map((g) => {
          // Same rule the duplicate-ticket folds use: a live search bypasses
          // every fold, so a match can never hide inside a collapsed group.
          const folded = grouped && !query.trim() && collapsedBuckets.has(g.id);
          return (
            <div key={g.id || "all"}>
              {grouped && renderBucketTitle(g, folded)}
              {!folded && g.rows.map((t) => renderListRow(t, kind))}
            </div>
          );
        })}
      </div>
    );
  }

  /** Collapsible header over a status / category bucket.
   *
   *  ONE saturated element — an 8px square in the status colour — with neutral
   *  type beside it. A full-width colour band across six stacked statuses would
   *  read as rainbow chrome; the square says the same thing at a twentieth of
   *  the area. Categories have no colour of their own, so they get no square. */
  function renderBucketTitle(g: JiraRowGroup, folded: boolean) {
    const color = g.status ? statusColorOf(g.status) : null;
    return (
      <div
        role="button"
        tabIndex={0}
        aria-expanded={!folded}
        aria-label={`${g.label} — ${folded ? "expand" : "collapse"} group`}
        data-ctx-surface="jira-rail"
        onClick={() => toggleBucketCollapsed(g.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleBucketCollapsed(g.id);
          }
        }}
        onMouseEnter={(e) => {
          const ch = e.currentTarget.querySelector("svg");
          if (ch) ch.style.color = "var(--ezy-text)";
        }}
        onMouseLeave={(e) => {
          const ch = e.currentTarget.querySelector("svg");
          if (ch) ch.style.color = "";
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          height: 22,
          padding: "0 10px 0 8px",
          marginTop: 6,
          cursor: "pointer",
          userSelect: "none",
          outline: "none",
          fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--ezy-text)",
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
            color: "var(--ezy-text-muted)",
            transform: folded ? undefined : "rotate(90deg)",
            transition: "transform 0.15s ease, color 0.15s ease",
          }}
        >
          <path d="m6 3.5 5 4.5-5 4.5" />
        </svg>
        {color && (
          <span
            style={{
              width: 8,
              height: 8,
              flexShrink: 0,
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 2px)",
              backgroundColor: color,
            }}
          />
        )}
        <span
          style={{
            minWidth: 0,
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {g.label}
        </span>
        <span
          style={{
            flexShrink: 0,
            color: "var(--ezy-text-muted)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {g.rows.length}
        </span>
      </div>
    );
  }

  /**
   * One Assigned / Unassigned row.
   *
   * Line 1 is identity: the ticket KEY, never truncated, and the status badge
   * in a fixed-width cell so every badge on the list starts at the same x. The
   * key gets `flexShrink: 0` and a flexible spacer sits between them, so when a
   * very long key runs out of room the SPACER collapses and then the badge
   * clips — the key itself is the last thing to give.
   *
   * Line 2 is context (updated / sent / priority / reporter), muted and free to
   * ellipse. Line 3 is the full summary, only while the row is expanded.
   *
   * Clicking the row shows the browser-only preview. The only way one of these
   * grows a CLI pane is the menu's explicit Investigate.
   */
  function renderListRow(t: JiraListTicket, kind: JiraListKind) {
    const qk = jiraQK(t.siteId, t.key);
    const unseen = !!ticketSnapshots?.[qk]?.unseen;
    const isActive = assignedPreview === qk;
    const foreign = t.siteId !== tabSite;
    const color = t.status ? statusColorOf(t.status) : null;
    const showStripe = statusIndicator !== "badge";
    const showBadge = statusIndicator !== "stripe";
    const expanded = expandedRows.has(qk);
    const metaCells = buildRowMeta(
      {
        updatedIso: t.updatedIso,
        createdIso: t.createdIso,
        priorityName: t.priorityName,
        reporterName: t.reporterName,
        organization: t.organization,
        requestType: t.requestType,
        extra: t.extra,
        siteName: jiraSites.length > 1 ? (jiraSiteName(t.siteId) ?? t.siteId) : undefined,
      },
      metaShow,
      rowExtraFields,
      labelForField,
    );
    const hasMeta = metaCells.length > 0;
    const height = expanded
      ? undefined
      : `calc(var(--ezy-font-scale, 1) * ${hasMeta ? ROW_HEIGHT_META : ROW_HEIGHT}px)`;
    return (
      <div
        key={qk}
        data-ctx-surface={kind === "unassigned" ? "jira-unassigned" : "jira-assigned"}
        data-ctx-id={qk}
        data-ctx-label={t.key}
        data-ctx-ticket={t.key}
        data-ctx-foreign={foreign ? "1" : undefined}
        onClick={() => {
          useJiraNotifyStore.getState().setAssignedPreview(tab.id, qk);
          useAppStore.getState().markJiraTicketSeen(qk);
        }}
        data-tooltip={expanded ? undefined : t.summary || undefined}
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 2,
          height,
          padding: expanded ? "6px 10px 8px 8px" : "0 10px 0 8px",
          cursor: "pointer",
          backgroundColor: isActive ? "var(--ezy-surface)" : undefined,
          borderLeft: `2px solid ${showStripe ? (color ?? "transparent") : "transparent"}`,
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
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          {t.summary && expandChevron(expanded, () => toggleRowExpanded(qk))}
          {unseen && unseenDot()}
          <span
            style={{
              flexShrink: 0,
              fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
              fontWeight: unseen ? 600 : 400,
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
            }}
          >
            {t.key}
          </span>
          {/* The elastic gap: this is what gives, so the key never does and the
              badge's left edge stays on one column down the whole list. */}
          <span style={{ flex: 1, minWidth: 0 }} />
          {showBadge && t.status && color && (
            <JiraStatusBadge status={t.status} color={color} width={badgeW} />
          )}
          {rowMenuButton(isActive)}
        </div>
        {hasMeta && <JiraRowMeta cells={metaCells} />}
        {expanded && t.summary && (
          <div
            style={{
              fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
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
  }

  /** Fold/unfold a row's summary. Deliberately its own hit target rather than
   *  the row: clicking the row means "preview this ticket", and overloading
   *  that would make one of the two actions unreachable. */
  function expandChevron(expanded: boolean, toggle: () => void) {
    return (
      <span
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={expanded ? "Hide summary" : "Show summary"}
        data-tooltip={expanded ? "Hide summary" : "Show summary"}
        onClick={(e) => {
          e.stopPropagation();
          toggle();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            toggle();
          }
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--ezy-text)")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--ezy-text-muted)")}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          width: 10,
          color: "var(--ezy-text-muted)",
          cursor: "pointer",
          outline: "none",
        }}
      >
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
            transform: expanded ? "rotate(90deg)" : undefined,
            transition: "transform 0.15s ease, color 0.15s ease",
          }}
        >
          <path d="m6 3.5 5 4.5-5 4.5" />
        </svg>
      </span>
    );
  }

  /** The row's hamburger. Same markup on every rail row — a div role=button so
   *  it escapes <button>'s line-height inflation, revealed on row hover by
   *  .jira-row-menu and pinned open on the active row. */
  function rowMenuButton(pinned: boolean) {
    return (
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
          opacity: pinned ? 1 : undefined,
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
