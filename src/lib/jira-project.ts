/**
 * Jira project orchestration — creating the project, and opening a ticket in it.
 *
 * Everything here is composition of machinery that already exists: the tab is an
 * ordinary project tab (flagged), the pane is created by the same
 * `made:split-terminal` path the Add-pane menu uses, the ticket's conversation is
 * an ordinary Claude/Codex/Gemini session in the existing per-project session
 * registry, and the browser is the existing one-per-tab browser pane. The only
 * genuinely new idea is that a ticket key names the session.
 */

import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import type { PaneLayout, ProjectSession } from "../types";
import { setPendingPrompt, clearPendingPrompt } from "../store/terminalSlice";
import { rememberTicketForTerminal, clearTicketForTerminal, parkedTicketName } from "./jira-session";
import { generateTerminalId } from "./layout-utils";
import {
  addJiraTermToPair,
  appendJiraPair,
  buildJiraPair,
  buildJiraTermLeaf,
  findJiraPair,
  findJiraTermLeaf,
  jiraBaseTicket,
  jiraInstanceKey,
  listJiraInstanceKeys,
  removeJiraInstanceTerm,
} from "./jira-layout";
import { requestJiraTicket } from "../components/NewJiraTicketModal";
import { buildJiraPrompt, buildTicketUrl, DEFAULT_JIRA_PROMPT } from "./jira";
import { jiraCliOfSession, type JiraCli } from "./jira-mcp";

/** The remembered new-ticket model for a CLI. Claude's is a tier alias; the
 *  other two are literal slugs, because neither CLI has aliases. */
export function rememberedModel(
  store: { jiraClaudeModel: string | null; jiraCodexModel: string | null; jiraGeminiModel: string | null },
  cli: JiraCli,
): string | null {
  if (cli === "codex") return store.jiraCodexModel;
  if (cli === "gemini") return store.jiraGeminiModel;
  return store.jiraClaudeModel;
}

/**
 * Ask for a ticket key. Also asks for the Jira base URL the first time, because
 * without it there is nowhere to point the browser and a dialog that silently
 * does half the job is worse than one extra field once.
 */
export async function askForTicket(): Promise<
  { ticket: string; swedish: boolean; english: boolean; cli: JiraCli; model: string | null } | null
> {
  // The dialog itself (NewJiraTicketModal) owns the acronym/number split,
  // remembered acronyms, the Swedish toggle and the first-run Jira address —
  // including persisting all of them.
  return requestJiraTicket();
}

/** Does `filename` already exist in `dir` (case-insensitive), locally or on a
 *  server? Best-effort: an unreadable dir reports false rather than blocking. */
export async function jiraFileExists(
  dir: string,
  filename: string,
  server?: { host: string; username: string; authMethod: string; sshKeyPath?: string } | null,
): Promise<boolean> {
  const lower = filename.toLowerCase();
  try {
    if (server) {
      const entries = await invoke<string[]>("ssh_ls", {
        host: server.host,
        username: server.username,
        path: dir,
        identityFile: server.authMethod === "ssh-key" && server.sshKeyPath ? server.sshKeyPath : null,
      });
      return entries.some((e) => e.replace(/\/$/, "").toLowerCase() === lower);
    }
    const entries = await invoke<{ name: string }[]>("list_dir", { path: dir });
    return entries.some((e) => e.name.toLowerCase() === lower);
  } catch {
    return false;
  }
}

export interface CreateJiraProjectOptions {
  /** Source folder the Jira work runs against (local path or remote absolute path). */
  path: string;
  /** Set when the folder lives on a remote server. */
  serverId?: string;
  /** Local template file copied in as CLAUDE.md. Skipped (never overwritten)
   *  when the folder already has a CLAUDE.md — Jira projects point at existing
   *  repos, so an existing file always wins. */
  claudeTemplatePath?: string;
}

export type JiraTemplateOutcome = "written" | "skipped-exists" | "none";

/**
 * Create a Jira project bound to a source folder (local or remote).
 *
 * The tab starts with a null layout — no panes at all — so the first ticket's
 * pane becomes the layout root and the browser can then be added as a proper
 * full-height right column. Seeding a browser-only layout instead would make the
 * first ticket a 50/50 grid split, which is not the arrangement we want.
 */
export async function createJiraProjectAt(
  opts: CreateJiraProjectOptions,
): Promise<{ tabId: string; template: JiraTemplateOutcome }> {
  const store = useAppStore.getState();
  const server = opts.serverId ? store.servers.find((s) => s.id === opts.serverId) : null;

  let template: JiraTemplateOutcome = "none";
  if (opts.claudeTemplatePath) {
    if (await jiraFileExists(opts.path, "CLAUDE.md", server)) {
      template = "skipped-exists";
    } else {
      const content = await invoke<string>("read_file", { path: opts.claudeTemplatePath });
      if (server) {
        await invoke("ssh_write_file", {
          host: server.host,
          username: server.username,
          path: `${opts.path.replace(/\/+$/, "")}/CLAUDE.md`,
          content,
          identityFile: server.authMethod === "ssh-key" && server.sshKeyPath ? server.sshKeyPath : null,
        });
      } else {
        const sep = opts.path.includes("\\") ? "\\" : "/";
        await invoke("write_file", { path: `${opts.path}${sep}CLAUDE.md`, content });
      }
      template = "written";
    }
  }

  const folder = opts.path.split(/[\\/]/).filter(Boolean).pop() || "Jira";
  const tabId = store.addTabWithLayout(`Jira · ${folder}`, opts.path, null, opts.serverId, {
    isJiraProject: true,
  });

  store.addRecentProject({ path: opts.path, name: folder, serverId: opts.serverId, isJira: true });
  return { tabId, template };
}

interface OpenTicketOptions {
  ticket: string;
  /** Which CLI runs the ticket pane. Defaults to Claude — every ticket opened
   *  before the picker existed is a Claude conversation. */
  cli?: JiraCli;
  /** Omitted when reopening — the resumed conversation already has its prompt.
   *  Mutually exclusive with `english` (the dialog enforces it). */
  swedish?: boolean;
  english?: boolean;
  /** Model for the fresh pane: a Claude `--model` alias ("fable" | "opus" |
   *  "sonnet" | "haiku"), or a literal `-m` slug for Codex/Gemini, which have
   *  no aliases. Omitted/null = the CLI's own default. Fresh conversations
   *  only — a resumed session keeps whatever it ran on. */
  model?: string | null;
  /** Duplicate number (2+): names the session "TICKET #n" and nests the pane
   *  into the base ticket's pair, sharing its browser. Absent = the original. */
  instance?: number;
  /** Fresh conversation WITHOUT the investigation prompt (duplicate "empty"). */
  noPrompt?: boolean;
  /** Duplicate-as-fork: the fresh pane starts as an exact copy of this source
   *  conversation (`--resume <id> --fork-session`). No prompt is sent. */
  forkFromSessionId?: string;
  /** Resume this session instead of starting a fresh conversation. */
  resumeId?: string;
  /** Whether the canvas switches to the ticket being opened. Default true —
   *  every human-initiated open (rail click, new-ticket dialog, duplicate)
   *  means "show me this". Only the pasted-ticket detector in manual mode
   *  passes false, and it must be a flag rather than a select-then-restore:
   *  restoring afterwards would flash the canvas through the new pair. */
  select?: boolean;
}

/**
 * Open (or reopen) a ticket in a Jira project: an AI pane in the project's
 * folder, plus the browser pointed at the ticket.
 */
export function openJiraTicket(tabId: string, opts: OpenTicketOptions): void {
  const store = useAppStore.getState();
  const tab = store.tabs.find((t) => t.id === tabId);
  if (!tab) return;

  const cli: JiraCli = opts.cli ?? "claude";
  const instance = opts.instance && opts.instance > 1 ? opts.instance : undefined;
  const instKey = jiraInstanceKey(opts.ticket, instance);
  const terminalId = generateTerminalId();
  const resuming = !!opts.resumeId;
  const fork = opts.forkFromSessionId
    ? { sourceSessionId: opts.forkFromSessionId, newSessionId: crypto.randomUUID() }
    : undefined;

  // Everything the spawn needs must be parked BEFORE the pane is asked for:
  // the spawn reads it, and it can begin as soon as the pane mounts.
  //
  // A resumed conversation must NOT be re-prompted — it already contains the
  // investigation, and a second copy would just make Claude start over. It also
  // needs no ticket parking, because its session id is already known here.
  // A fork carries the source conversation, so it gets no prompt either.
  if (!resuming) {
    if (!opts.noPrompt && !fork) {
      setPendingPrompt(
        terminalId,
        buildJiraPrompt(
          store.jiraPromptTemplate || DEFAULT_JIRA_PROMPT,
          opts.ticket,
          opts.swedish ? "sv" : opts.english ? "en" : undefined,
        ),
      );
    }
    rememberTicketForTerminal(terminalId, {
      ticket: opts.ticket,
      instance,
      cli,
      model: opts.model ?? undefined,
      fork,
    });
  } else {
    // Resumes park too, but only the name-bearing fields: the spawn re-asserts
    // the row's (possibly user-edited) name via `--name`, which is how a MADE-
    // side rename reaches the CLI title. Fork/mint stay off because the pane's
    // leaf carries the resume id.
    const rowName = (store.projectSessions[tab.workingDir.replace(/\\/g, "/")] ?? []).find(
      (s) => s.id === opts.resumeId,
    )?.name;
    rememberTicketForTerminal(terminalId, {
      ticket: opts.ticket,
      instance,
      cli,
      name: rowName,
    });
  }

  // Per-ticket canvas: the ticket gets its own fixed pair (Claude pane + own
  // browser on the ticket URL) appended to the tab layout; the canvas then
  // switches to it. No made:split-terminal round-trip — the pair is built
  // directly, so this works even when the tab wasn't active yet.
  const select = opts.select !== false;
  if (select && store.activeTabId !== tabId) store.setActiveTab(tabId);

  if (findJiraTermLeaf(tab.layout, instKey)) {
    // This instance is already open (e.g. rail double-fire) — just switch.
    clearPendingPrompt(terminalId);
    clearTicketForTerminal(terminalId);
    if (select) store.setSelectedJiraTicket(tabId, instKey);
    return;
  }

  store.addTerminal(terminalId, cli, tab.workingDir, tab.serverId);
  const term = buildJiraTermLeaf(instKey, terminalId, opts.resumeId, cli);
  const basePair = findJiraPair(tab.layout, opts.ticket);
  if (basePair && tab.layout) {
    // The ticket is already on the canvas — nest this instance's pane next to
    // its existing terminal(s). The ticket's single browser stays where it is,
    // shared by every instance.
    store.updateTabLayout(tabId, addJiraTermToPair(tab.layout, opts.ticket, term));
  } else {
    const url = buildTicketUrl(store.jiraBaseUrl, opts.ticket) ?? "about:blank";
    const pair = buildJiraPair(opts.ticket, term, url, store.jiraClaudeSide ?? "left");
    store.updateTabLayout(tabId, appendJiraPair(tab.layout, pair));
  }
  // `select: false` still selects when the tab has nothing selected: a canvas
  // with panes and no selection renders empty, which is worse than switching.
  if (select || !tab.selectedJiraTicket) store.setSelectedJiraTicket(tabId, instKey);

  // A reopened ticket's session id is already known, so name it now. A fresh
  // one is named by the spawn, which mints the id (see jira-session.ts).
  if (opts.resumeId) {
    store.registerProjectSession(tab.workingDir, {
      id: opts.resumeId,
      name: parkedTicketName({ ticket: opts.ticket, instance }),
      type: cli,
      createdAt: Date.now(),
      // Load-bearing: the upsert in sessionSlice returns early for renamed
      // sessions, which is what stops Claude's auto-detected summary from
      // overwriting the ticket key later.
      isRenamed: true,
      ticket: opts.ticket,
      ticketInstance: instance,
    });
  }
}

export type JiraDuplicateMode = "fork" | "prompt" | "empty";

/**
 * Duplicate a ticket row into a new instance ("SUPPORT-24920 #2"): a second,
 * independent conversation on the same ticket, nested into the ticket's pair so
 * both instances share its browser pane. Three flavors:
 * - `fork`   — exact copy of the source conversation (`--fork-session`)
 * - `prompt` — fresh conversation, investigation prompt re-sent
 * - `empty`  — fresh conversation, nothing sent
 *
 * The copy runs the SOURCE row's CLI, not the dialog's current pick: a
 * duplicate of a Codex conversation that came back as Claude would be a
 * different conversation wearing the same ticket number. `fork` is Claude-only
 * (no other CLI can fork a session) and the rail hides it elsewhere.
 */
export function duplicateJiraTicket(
  tabId: string,
  source: ProjectSession,
  mode: JiraDuplicateMode,
): void {
  const store = useAppStore.getState();
  const tab = store.tabs.find((t) => t.id === tabId);
  if (!tab || !source.ticket) return;
  const ticket = source.ticket;
  // Next free instance number across ALL rows of this ticket (open, closed,
  // archived) — numbers are never reused, or two rows could share a name.
  const siblings = (store.projectSessions[tab.workingDir.replace(/\\/g, "/")] ?? []).filter(
    (s) => s.ticket === ticket,
  );
  const instance = Math.max(1, ...siblings.map((s) => s.ticketInstance ?? 1)) + 1;
  // Once a group forms, every sibling carries the numbered convention: rows
  // still named with the bare ticket key are renumbered ("SUPPORT-1" →
  // "SUPPORT-1 #1"), in the rail at once and in the Claude title via --name
  // the next time that pane launches (a RUNNING pane can't be renamed from
  // outside). Custom names are left alone; the collapse effect in the rail
  // reverses this when the group shrinks back to one row.
  for (const s of siblings) {
    if (s.name === ticket) {
      store.renameProjectSession(tab.workingDir, s.id, `${ticket} #${s.ticketInstance ?? 1}`);
    }
  }
  const cli = jiraCliOfSession(source.type);
  openJiraTicket(tabId, {
    ticket,
    instance,
    cli,
    // Fresh duplicates reuse the remembered dialog defaults for that CLI; a
    // fork keeps whatever model the source conversation was already running on.
    model: mode === "fork" ? undefined : rememberedModel(store, cli),
    swedish: store.jiraReplyInSwedish,
    english: store.jiraReplyInEnglish,
    noPrompt: mode === "empty",
    forkFromSessionId: mode === "fork" ? source.id : undefined,
  });
}

/**
 * Close ONE instance's pane in EVERY tab of this project — the archive/delete
 * safety net. The rail's own close only searches the clicked tab, but a second
 * tab on the same project can hold the same ticket's pane, and whatever stays
 * in a persisted layout is respawned (`claude --resume`) on the next launch —
 * an archived ticket left open elsewhere would resume forever.
 */
export function closeJiraInstanceInAllTabs(projectDir: string, instKey: string): void {
  const store = useAppStore.getState();
  const projectKey = projectDir.replace(/\\/g, "/");
  const ticket = jiraBaseTicket(instKey);
  for (const t of store.tabs) {
    if (!t.layout) continue;
    if ((t.workingDir ?? "").replace(/\\/g, "/") !== projectKey) continue;
    const leaf = findJiraTermLeaf(t.layout, instKey);
    if (!leaf) continue;
    const next = removeJiraInstanceTerm(t.layout, instKey);
    store.removeTerminals([leaf.terminalId]);
    // Resume spawns park a name record the mint path never consumes.
    clearTicketForTerminal(leaf.terminalId);
    store.updateTabLayout(t.id, next);
    if (t.selectedJiraTicket === instKey) {
      const remaining = listJiraInstanceKeys(next);
      const sibling = remaining.find((k) => jiraBaseTicket(k) === ticket);
      store.setSelectedJiraTicket(t.id, sibling ?? remaining[0]);
    }
  }
}

/**
 * Startup safety net: prune every ARCHIVED session's pane from every tab
 * layout. Called from main.tsx BEFORE the first render — i.e. before any pane
 * mounts and respawns `claude --resume` — so stale persisted state (an
 * archive-time close that missed, or layouts written by older builds) can
 * never resume an archived conversation. Self-healing: whatever the gap that
 * let the pair survive, it is gone by the time anything can spawn from it.
 */
export function pruneArchivedJiraPanes(): void {
  const store = useAppStore.getState();
  for (const t of store.tabs) {
    if (!t.isJiraProject || !t.layout) continue;
    const sessions = store.projectSessions[(t.workingDir ?? "").replace(/\\/g, "/")] ?? [];
    const archivedIds = new Set(sessions.filter((s) => s.archived).map((s) => s.id));
    if (archivedIds.size === 0) continue;
    let layout: PaneLayout | null = t.layout;
    const doomed: string[] = [];
    for (const instKey of listJiraInstanceKeys(layout)) {
      const leaf = findJiraTermLeaf(layout, instKey);
      // A leaf without a resume id is a pane mid-mint — it cannot belong to
      // an archived row, whose session id is known by definition.
      if (!leaf?.sessionResumeId || !archivedIds.has(leaf.sessionResumeId)) continue;
      doomed.push(leaf.terminalId);
      clearTicketForTerminal(leaf.terminalId);
      layout = removeJiraInstanceTerm(layout, instKey);
    }
    if (doomed.length === 0) continue;
    store.removeTerminals(doomed);
    store.updateTabLayout(t.id, layout);
    if (t.selectedJiraTicket && !listJiraInstanceKeys(layout).includes(t.selectedJiraTicket)) {
      store.setSelectedJiraTicket(t.id, listJiraInstanceKeys(layout)[0]);
    }
  }
}

/** Show a ticket's Jira page. In the per-ticket canvas each ticket owns its
 *  browser pane, so this just selects the ticket's pair when it exists —
 *  NEVER openOrUpdateBrowserPane into a pair layout (a stray browser pane
 *  would make the migration effect read it as a legacy grid and rebuild). */
export function navigateToTicket(tabId: string, ticket: string): void {
  const store = useAppStore.getState();
  const tab = store.tabs.find((t) => t.id === tabId);
  if (!tab) return;

  if (findJiraPair(tab.layout, ticket)) {
    store.setSelectedJiraTicket(tabId, ticket);
    return;
  }
  // No pair open for this ticket (closed session row) — open it externally
  // rather than mutating the pair layout.
  const url = buildTicketUrl(store.jiraBaseUrl, ticket);
  if (url) window.open(url, "_blank", "noopener,noreferrer");
}
