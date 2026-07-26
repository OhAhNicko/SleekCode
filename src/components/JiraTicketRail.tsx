import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../store";
import type { ProjectSession, Tab } from "../types";
import { findAllTerminalLeaves } from "../lib/layout-utils";
import { sessionStillExists } from "../lib/session-exists";
import { askForTicket, openJiraTicket, navigateToTicket } from "../lib/jira-project";
import { registerSurfaceActions, unregisterSurfaceActions } from "../lib/surface-actions";
import { confirmAction } from "../lib/prompt-modal";
import { CLI_BRAND_COLORS } from "./TerminalHeader";

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
  const searchInputRef = useRef<HTMLInputElement>(null);

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
    return tickets
      .map((session) => ({ session, terminalId: liveBySession.get(session.id) }))
      .sort((a, b) => {
        // Open tickets first, then most recently started.
        if (!!a.terminalId !== !!b.terminalId) return a.terminalId ? -1 : 1;
        return b.session.createdAt - a.session.createdAt;
      });
    // `activeTerminalId` (the terminals map) is a dependency because a pane
    // appearing or dying changes which rows count as open.
  }, [allSessions, tab.layout, activeTerminalId]);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return rows;
    return rows.filter((r) => (r.session.ticket ?? "").includes(q));
  }, [rows, query]);

  const openCount = filtered.filter((r) => r.terminalId).length;

  // A closed session can only be reopened if its transcript still exists.
  // sessionStillExists fails open, so a row is marked unavailable only when the
  // file is definitively gone — better a failed resume than hiding live work.
  useEffect(() => {
    let cancelled = false;
    const closed = rows.filter((r) => !r.terminalId).map((r) => r.session.id);
    if (closed.length === 0) {
      setMissing((prev) => (prev.size ? new Set() : prev));
      return;
    }
    void (async () => {
      const gone = new Set<string>();
      for (const id of closed) {
        const ok = await sessionStillExists(
          "claude",
          id,
          tab.workingDir,
          tab.backend ?? "wsl",
          tab.serverId,
        );
        if (!ok) gone.add(id);
      }
      if (!cancelled) setMissing(gone);
    })();
    return () => {
      cancelled = true;
    };
  }, [rows, tab.workingDir, tab.backend, tab.serverId]);

  const handleRowClick = (row: TicketRow) => {
    const ticket = row.session.ticket;
    if (!ticket) return;
    if (row.terminalId) {
      onFocusTerminal(row.terminalId);
      navigateToTicket(tab.id, ticket);
      return;
    }
    if (missing.has(row.session.id)) return;
    openJiraTicket(tab.id, { ticket, resumeId: row.session.id });
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
      forget: (id) => {
        const ticket = find(id)?.session.ticket ?? "this ticket";
        void confirmAction({
          title: "Remove from list",
          detail: `${ticket} disappears from the rail. The conversation itself is not deleted.`,
          confirmLabel: "Remove",
          danger: true,
        }).then((ok) => {
          if (ok) useAppStore.getState().removeProjectSession(tab.workingDir, id);
        });
      },
    });
    return () => unregisterSurfaceActions("jira-ticket");
  }, [tab.id, tab.workingDir]);

  const handleNewTicket = async () => {
    const answer = await askForTicket();
    if (!answer) return;
    openJiraTicket(tab.id, { ticket: answer.ticket, swedish: answer.swedish });
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
        <span
          style={{
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--ezy-text-muted)",
          }}
        >
          Tickets
        </span>
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
            borderRadius: 4,
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
              fontSize: 12,
              color: "var(--ezy-text)",
            }}
          />
        </div>
      </div>

      {/* List */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingBottom: 8 }}>
        {filtered.length === 0 && (
          <div
            style={{
              padding: "8px 10px",
              fontSize: 11,
              lineHeight: 1.5,
              color: "var(--ezy-text-muted)",
            }}
          >
            {rows.length === 0
              ? "No tickets yet. Add one to start investigating."
              : "No ticket matches that search."}
          </div>
        )}
        {filtered.map((row, i) => {
          const isOpen = !!row.terminalId;
          const unavailable = !isOpen && missing.has(row.session.id);
          // Only label the groups when both exist — a single heading over a
          // uniform list is noise.
          const showClosedHeading =
            !isOpen && openCount > 0 && i === openCount;
          return (
            <div key={row.session.id}>
              {showClosedHeading && (
                <div
                  style={{
                    padding: "10px 10px 4px",
                    fontSize: 10,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: "var(--ezy-text-muted)",
                  }}
                >
                  Closed
                </div>
              )}
              <div
                data-ctx-surface="jira-ticket"
                data-ctx-id={row.session.id}
                data-ctx-label={row.session.ticket}
                data-ctx-open={isOpen ? "1" : undefined}
                data-ctx-gone={unavailable ? "1" : undefined}
                onClick={() => handleRowClick(row)}
                title={
                  unavailable
                    ? "This conversation's transcript is gone — it can't be reopened."
                    : row.session.ticket
                }
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  height: ROW_HEIGHT,
                  padding: "0 10px 0 8px",
                  cursor: unavailable ? "default" : "pointer",
                  opacity: unavailable ? 0.4 : 1,
                  borderLeft: `2px solid ${isOpen ? CLI_BRAND_COLORS.claude : "transparent"}`,
                  color: isOpen ? "var(--ezy-text)" : "var(--ezy-text-muted)",
                }}
                onMouseEnter={(e) => {
                  if (!unavailable) {
                    e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "transparent";
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: isOpen ? 600 : 400,
                    fontVariantNumeric: "tabular-nums",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {row.session.ticket}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
