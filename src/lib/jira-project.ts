/**
 * Jira project orchestration — creating the project, and opening a ticket in it.
 *
 * Everything here is composition of machinery that already exists: the tab is an
 * ordinary project tab (flagged), the pane is created by the same
 * `made:split-terminal` path the Add-pane menu uses, the ticket's conversation is
 * an ordinary Claude session in the existing per-project session registry, and
 * the browser is the existing one-per-tab browser pane. The only genuinely new
 * idea is that a ticket key names the session.
 */

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../store";
import { setPendingPrompt, clearPendingPrompt } from "../store/terminalSlice";
import { rememberTicketForTerminal, clearTicketForTerminal } from "./jira-session";
import { generateTerminalId, openOrUpdateBrowserPane } from "./layout-utils";
import { promptWithOptions } from "./prompt-modal";
import {
  buildJiraPrompt,
  buildTicketUrl,
  normalizeTicketKey,
  DEFAULT_JIRA_PROMPT,
} from "./jira";

const SWEDISH_TOGGLE = "swedish";

/**
 * Ask for a ticket key. Also asks for the Jira base URL the first time, because
 * without it there is nowhere to point the browser and a dialog that silently
 * does half the job is worse than one extra field once.
 */
export async function askForTicket(): Promise<
  { ticket: string; swedish: boolean } | null
> {
  const store = useAppStore.getState();
  const needsBaseUrl = !store.jiraBaseUrl.trim();

  const result = await promptWithOptions({
    title: "New ticket",
    label: "Ticket number",
    confirmLabel: "Investigate",
    initialValue: "",
    validate: (v) =>
      normalizeTicketKey(v) ? null : "Expected a ticket key like SUPPORT-24920.",
    toggles: [
      {
        id: SWEDISH_TOGGLE,
        label: "Reply in Swedish",
        defaultOn: store.jiraReplyInSwedish,
      },
    ],
    extraField: needsBaseUrl
      ? {
          id: "baseUrl",
          label: "Jira address",
          placeholder: "https://yourcompany.atlassian.net",
          required: true,
        }
      : undefined,
  });
  if (!result) return null;

  const ticket = normalizeTicketKey(result.value);
  if (!ticket) return null;

  const swedish = !!result.toggles[SWEDISH_TOGGLE];
  // Remember the choice so the next ticket defaults to the same language.
  if (swedish !== store.jiraReplyInSwedish) store.setJiraReplyInSwedish(swedish);
  if (needsBaseUrl && result.extra) store.setJiraBaseUrl(result.extra.trim());

  return { ticket, swedish };
}

/**
 * Create a Jira project bound to a platform's source folder.
 *
 * The tab starts with a null layout — no panes at all — so the first ticket's
 * pane becomes the layout root and the browser can then be added as a proper
 * full-height right column. Seeding a browser-only layout instead would make the
 * first ticket a 50/50 grid split, which is not the arrangement we want.
 */
export async function createJiraProject(): Promise<string | null> {
  let selected: string | null = null;
  try {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: "Select the source folder for this Jira project",
    });
    if (typeof picked === "string") selected = picked;
  } catch {
    return null; // cancelled, or the dialog failed
  }
  if (!selected) return null;

  const folder = selected.split(/[\\/]/).pop() || "Jira";
  const store = useAppStore.getState();
  const tabId = store.addTabWithLayout(`Jira · ${folder}`, selected, null, undefined, {
    isJiraProject: true,
  });

  store.addRecentProject({ path: selected, name: folder });
  return tabId;
}

interface OpenTicketOptions {
  ticket: string;
  /** Omitted when reopening — the resumed conversation already has its prompt. */
  swedish?: boolean;
  /** Resume this session instead of starting a fresh conversation. */
  resumeId?: string;
}

/**
 * Open (or reopen) a ticket in a Jira project: a Claude pane in the project's
 * folder, plus the browser pointed at the ticket.
 */
export function openJiraTicket(tabId: string, opts: OpenTicketOptions): void {
  const store = useAppStore.getState();
  const tab = store.tabs.find((t) => t.id === tabId);
  if (!tab) return;

  const terminalId = generateTerminalId();
  const resuming = !!opts.resumeId;

  // Both of these must be parked BEFORE the pane is asked for: the spawn reads
  // them, and it can begin as soon as the pane mounts.
  //
  // A resumed conversation must NOT be re-prompted — it already contains the
  // investigation, and a second copy would just make Claude start over. It also
  // needs no ticket parking, because its session id is already known here.
  if (!resuming) {
    setPendingPrompt(
      terminalId,
      buildJiraPrompt(
        store.jiraPromptTemplate || DEFAULT_JIRA_PROMPT,
        opts.ticket,
        !!opts.swedish,
      ),
    );
    rememberTicketForTerminal(terminalId, opts.ticket);
  }

  // Workspace owns pane creation, layout insertion and focus. Its listener only
  // answers for the ACTIVE tab, so make sure this one is active first.
  if (store.activeTabId !== tabId) store.setActiveTab(tabId);
  window.dispatchEvent(
    new CustomEvent("made:split-terminal", {
      detail: {
        type: "claude",
        terminalId,
        sessionResumeId: opts.resumeId,
        workingDir: tab.workingDir,
      },
    }),
  );

  // If the listener never ran (no active Workspace for this tab), the pane does
  // not exist and the prompt would sit in the registry waiting to ambush an
  // unrelated pane that happens to reuse the id. Drop it.
  const spawned = !!useAppStore.getState().terminals[terminalId];
  if (!spawned) {
    clearPendingPrompt(terminalId);
    clearTicketForTerminal(terminalId);
    return;
  }

  // A reopened ticket's session id is already known, so name it now. A fresh
  // one is named by the spawn, which mints the id (see jira-session.ts).
  if (opts.resumeId) {
    store.registerProjectSession(tab.workingDir, {
      id: opts.resumeId,
      name: opts.ticket,
      type: "claude",
      createdAt: Date.now(),
      // Load-bearing: the upsert in sessionSlice returns early for renamed
      // sessions, which is what stops Claude's auto-detected summary from
      // overwriting the ticket key later.
      isRenamed: true,
      ticket: opts.ticket,
    });
  }

  navigateToTicket(tabId, opts.ticket);
}

/** Point the project's browser pane at a ticket. No-op without a base URL. */
export function navigateToTicket(tabId: string, ticket: string): void {
  const store = useAppStore.getState();
  const tab = store.tabs.find((t) => t.id === tabId);
  if (!tab) return;

  const url = buildTicketUrl(store.jiraBaseUrl, ticket);
  if (!url) return;

  // Read the layout FRESH: the pane insertion above already rewrote it, and the
  // `tab` captured earlier is the pre-insertion copy.
  const current = useAppStore.getState().tabs.find((t) => t.id === tabId);
  if (!current?.layout) return;

  const { layout } = openOrUpdateBrowserPane(current.layout, url, {
    linkedTabId: undefined, // a Jira browser follows tickets, not a dev server
    fullColumn: true,
    spawnLeft: false,
    sizePercent: 35,
  });
  store.updateTabLayout(tabId, layout);
}
