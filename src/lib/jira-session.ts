/**
 * Ticket ⇄ terminal handoff for freshly-spawned Jira panes.
 *
 * A fresh pane's Claude session id is minted inside the PTY hooks (via
 * `--session-id`), which is after the Jira flow has already handed off. So the
 * ticket key is parked against the terminal id here, and the spawn picks it up
 * to name the session.
 *
 * Deliberately separate from `jira-project.ts`: the PTY hooks call in here, and
 * they must not end up importing that module's dialog/orchestration graph.
 */

import { useAppStore } from "../store";

const ticketByTerminal = new Map<string, string>();

export function rememberTicketForTerminal(terminalId: string, ticket: string): void {
  ticketByTerminal.set(terminalId, ticket);
}

/** Read-and-delete — a terminal names its session exactly once. */
export function takeTicketForTerminal(terminalId: string): string | undefined {
  const ticket = ticketByTerminal.get(terminalId);
  if (ticket !== undefined) ticketByTerminal.delete(terminalId);
  return ticket;
}

export function clearTicketForTerminal(terminalId: string): void {
  ticketByTerminal.delete(terminalId);
}

/**
 * Called by the PTY spawn the moment a fresh Claude session id is minted: if
 * this terminal is a parked ticket, the session takes the ticket key as its
 * name and becomes a row in the Jira rail.
 *
 * `isRenamed: true` is load-bearing — `registerProjectSession`'s upsert returns
 * early for renamed sessions, and that is precisely what stops Claude's
 * auto-detected first-prompt summary from replacing `SUPPORT-24920` later.
 */
export function nameTicketSession(
  terminalId: string,
  sessionId: string,
  workingDir: string,
): void {
  const ticket = takeTicketForTerminal(terminalId);
  if (!ticket) return;
  useAppStore.getState().registerProjectSession(workingDir, {
    id: sessionId,
    name: ticket,
    type: "claude",
    createdAt: Date.now(),
    isRenamed: true,
    ticket,
  });
}
