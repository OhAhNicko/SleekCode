/**
 * Ticket ⇄ terminal handoff for freshly-spawned Jira panes.
 *
 * A fresh pane's Claude session id is minted inside the PTY hooks (via
 * `--session-id`), which is after the Jira flow has already handed off. So the
 * launch details are parked against the terminal id here, and the spawn picks
 * them up to build the claude args and name the session.
 *
 * Deliberately separate from `jira-project.ts`: the PTY hooks call in here, and
 * they must not end up importing that module's dialog/orchestration graph.
 */

import { useAppStore } from "../store";

export interface ParkedTicket {
  /** Base ticket key ("SUPPORT-24920") — never carries an instance suffix. */
  ticket: string;
  /** Duplicate number (2+). Absent = the original. Shapes the session name
   *  ("SUPPORT-24920 #2") and the rail grouping. */
  instance?: number;
  /** User-edited row name. When set it wins over the derived ticket name —
   *  this is how a MADE-side rename reaches the CLI (`--name`) on the pane's
   *  next launch. */
  name?: string;
  /** Claude Code `--model` alias for the pane, from the new-ticket dialog. */
  model?: string;
  /** Duplicate-as-fork: spawn with `--resume <source> --fork-session
   *  --session-id <new>` so the pane starts as an exact copy of the source
   *  conversation under a MADE-chosen fresh id. */
  fork?: { sourceSessionId: string; newSessionId: string };
}

/** Display name for a parked ticket — what `--name` gets and what the rail
 *  row shows: the user-edited name when present, else the ticket key
 *  (+ " #n" for duplicates). */
export function parkedTicketName(
  parked: Pick<ParkedTicket, "ticket" | "instance" | "name">,
): string {
  if (parked.name) return parked.name;
  return parked.instance && parked.instance > 1
    ? `${parked.ticket} #${parked.instance}`
    : parked.ticket;
}

const parkedByTerminal = new Map<string, ParkedTicket>();

export function rememberTicketForTerminal(terminalId: string, parked: ParkedTicket): void {
  parkedByTerminal.set(terminalId, parked);
}

/** Non-destructive read — the PTY spawn peeks the parked record while building
 *  the claude args (`--name`, `--model`, fork flags); `takeTicketForTerminal`
 *  still consumes the entry when the session id is minted. */
export function peekTicketForTerminal(terminalId: string): ParkedTicket | undefined {
  return parkedByTerminal.get(terminalId);
}

/** Read-and-delete — a terminal names its session exactly once. */
export function takeTicketForTerminal(terminalId: string): ParkedTicket | undefined {
  const parked = parkedByTerminal.get(terminalId);
  if (parked !== undefined) parkedByTerminal.delete(terminalId);
  return parked;
}

export function clearTicketForTerminal(terminalId: string): void {
  parkedByTerminal.delete(terminalId);
}

/**
 * Called by the PTY spawn the moment a fresh Claude session id is minted (or a
 * fork's new id is fixed): if this terminal is a parked ticket, the session
 * takes the ticket key (plus " #n" for duplicates) as its name and becomes a
 * row in the Jira rail.
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
  const parked = takeTicketForTerminal(terminalId);
  if (!parked) return;
  useAppStore.getState().registerProjectSession(workingDir, {
    id: sessionId,
    name: parkedTicketName(parked),
    type: "claude",
    createdAt: Date.now(),
    isRenamed: true,
    ticket: parked.ticket,
    ticketInstance: parked.instance,
  });
}
