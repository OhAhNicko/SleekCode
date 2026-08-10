import { useEffect, useRef } from "react";
import { useAppStore } from "../store";
import type { Tab } from "../types";
import { useOverlayMenu } from "../lib/useOverlayMenu";
import type { OverlayMenuItem } from "../lib/overlay-menu-model";
import { askForTicket, openJiraTicket } from "../lib/jira-project";
import { resolveTicketColor } from "../lib/jira-colors";
import { jiraQK, siteForTabIn } from "../lib/jira-sites";
import {
  useJiraTicketRows,
  instanceOf,
  instKeyOf,
  customNameOf,
  type TicketRow,
} from "../hooks/useJiraTicketRows";
import { focusTerminalInTab } from "./VerticalTicketTree";

/**
 * A collapsed (80px) strip has no room for ticket text, so a Jira project's
 * chip opens its tickets as an anchored overlay MENU instead of a panel.
 *
 * A panel was the obvious shape and is not available: a main-webview panel is
 * painted over by the native terminal/browser panes, and the only sanctioned
 * escape — registering with `modalCoordinationSlice` — hides every native pane
 * while open, which its own scope guard reserves for whole-window modals. The
 * overlay webview is the correct host, and being `WS_EX_NOACTIVATE` it can
 * never hold a text caret. Hence: no search field here (search is an
 * expanded-mode affordance), and everything is decided at build time so the
 * menu cannot resize under the pointer.
 *
 * Renders no DOM of its own — it exists only while its flyout is open, which
 * is also the only time its data hook runs.
 */

interface VerticalTicketFlyoutProps {
  tab: Tab;
  anchorRef: { current: HTMLElement | null };
  dockedRight: boolean;
  /** True when the flyout was opened by hover, so it should close on hover-out
   *  rather than waiting for an outside click. */
  hoverTracking: boolean;
  onClose: () => void;
}

export default function VerticalTicketFlyout({
  tab,
  anchorRef,
  dockedRight,
  hoverTracking,
  onClose,
}: VerticalTicketFlyoutProps) {
  // Hover-out grace, same 160ms the horizontal bar uses: the pointer has to
  // cross a gap between the chip and the menu, and closing on the first
  // hover-out would make the menu impossible to reach.
  const hoverCloseTimer = useRef<number | null>(null);
  const cancelHoverClose = () => {
    if (hoverCloseTimer.current !== null) {
      clearTimeout(hoverCloseTimer.current);
      hoverCloseTimer.current = null;
    }
  };
  useEffect(() => cancelHoverClose, []);
  const jiraTicketColors = useAppStore((s) => s.jiraTicketColors);
  const ticketSnapshots = useAppStore((s) => s.jiraTicketSnapshots);
  const tabSite = useAppStore((s) => siteForTabIn(s, tab));

  const { activeRows, missing, sectionCounts, instanceCounts, handleRowClick } =
    useJiraTicketRows(tab, {
      onFocusTerminal: (terminalId) => focusTerminalInTab(tab.id, terminalId),
    });

  const label = (row: TicketRow) => {
    const ticket = row.session.ticket ?? "";
    const groupedHere = (sectionCounts.active.get(ticket) ?? 1) > 1;
    const siblingsAnywhere = (instanceCounts.get(ticket) ?? 1) > 1;
    const custom = customNameOf(row.session);
    if (custom) return custom;
    if (groupedHere || siblingsAnywhere) return `${ticket} #${instanceOf(row.session)}`;
    return ticket;
  };

  const toItem = (row: TicketRow): OverlayMenuItem => {
    const ticket = row.session.ticket ?? "";
    const isOpen = !!row.terminalId;
    const gone = !isOpen && missing.has(row.session.id);
    const unseen = !!ticketSnapshots?.[jiraQK(tabSite, ticket)]?.unseen;
    return {
      actionId: `ticket:${row.session.id}`,
      label: label(row),
      swatch: resolveTicketColor(ticket, jiraTicketColors) ?? undefined,
      checked: isOpen && tab.selectedJiraTicket === instKeyOf(row.session),
      // Right-aligned dim hint rather than a sublabel: a sublabel is a second
      // line, and a menu that grows a row is a menu that moves under the
      // pointer between build and paint.
      shortcut: unseen ? "updated" : undefined,
      disabled: gone,
      disabledReason: gone ? "This conversation's transcript is gone" : undefined,
    };
  };

  const open = activeRows.filter((r) => !!r.terminalId);
  const closed = activeRows.filter((r) => !r.terminalId);
  const sections = [
    // Only label the two groups when both exist — a single heading over a
    // uniform list is noise, the same rule the rail applies.
    ...(open.length > 0
      ? [{ title: closed.length > 0 ? "Open" : undefined, items: open.map(toItem) }]
      : []),
    ...(closed.length > 0
      ? [{ title: open.length > 0 ? "Closed" : undefined, items: closed.map(toItem) }]
      : []),
    {
      items: [
        {
          actionId: "new",
          label: "New ticket…",
          iconId: "file-plus",
        } as OverlayMenuItem,
      ],
    },
  ];

  useOverlayMenu({
    id: `vtabbar-tickets-${tab.id}`,
    open: true,
    anchorRef,
    payload: {
      // No side placements exist in the overlay model; anchoring the menu's
      // dock-facing edge to the chip lets it open across the content area,
      // which mirrors correctly for a right-docked strip.
      placement: dockedRight ? "below-end" : "below-start",
      width: 208,
      gap: 2,
      hoverTracking,
      sections,
    },
    onAction: (actionId) => {
      if (actionId === "__hoverin__") {
        cancelHoverClose();
        return;
      }
      if (actionId === "__hoverout__") {
        cancelHoverClose();
        hoverCloseTimer.current = window.setTimeout(onClose, 160);
        return;
      }
      if (actionId === "new") {
        void askForTicket().then((answer) => {
          if (!answer) return;
          openJiraTicket(tab.id, {
            ticket: answer.ticket,
            cli: answer.cli,
            swedish: answer.swedish,
            english: answer.english,
            model: answer.model,
          });
        });
        return;
      }
      const id = actionId.startsWith("ticket:") ? actionId.slice(7) : null;
      if (!id) return;
      const row = activeRows.find((r) => r.session.id === id);
      if (row) handleRowClick(row);
    },
    onClose,
  });

  return null;
}
