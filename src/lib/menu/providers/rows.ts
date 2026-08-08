import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../../store";
import { hasSurfaceAction, runSurfaceAction, type SurfaceRole } from "../../surface-actions";
import { promptForInput, confirmAction } from "../../prompt-modal";
import { openUnlockKeychain } from "../../unlock-keychain-modal";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getPtyWrite } from "../../../store/terminalSlice";
import { PROJECT_COLOR_PRESETS } from "../../../store/recentProjectsSlice";
import { isSameProject } from "../../spawn-dev-server";
import {
  getBrowserPageContext,
  safeExternalUrl,
  displayUrl,
  BROWSER_SURFACE_ID,
} from "../../../browser-view/page-context";
import { registerMenuProvider } from "../registry";
import {
  knowledgeBlockedReason,
  knowledgeReadBlockedReason,
} from "../../../store/knowledgeStore";
import { knowledgeRefFor, type KnowledgeNoteType } from "../../knowledge/types";
import { MEMORY_DIR_NAME } from "../../knowledge/keys";
import type { TaskCard } from "../../../types";
import type { RowCtx } from "../context";
import type { MenuGroup, MenuItemSpec, MenuProvider } from "../types";

const copy = (t: string) => navigator.clipboard.writeText(t).catch(() => {});

function activeTerminal() {
  return Object.values(useAppStore.getState().terminals).find((t) => t.isActive);
}

function hasActiveTerminal(): boolean {
  return !!activeTerminal();
}

/** Bracketed paste for CLI panes so a multi-line selection lands as one atom. */
function sendTextToActiveTerminal(text: string): void {
  const t = activeTerminal();
  if (!t) return;
  const write = getPtyWrite(t.id);
  if (!write) return;
  const isCli = t.type === "claude" || t.type === "codex" || t.type === "gemini";
  write(isCli ? "\x1b[200~" + text + "\x1b[201~" : text);
}

/**
 * Build an item backed by a component-registered handler.
 *
 * If the owning component isn't mounted, the handler isn't registered and the
 * row comes back disabled with a reason — never a click that silently does
 * nothing.
 */
function actionItem(
  role: SurfaceRole,
  action: string,
  id: string,
  spec: Omit<MenuItemSpec, "id" | "run"> & { id: string },
): MenuItemSpec {
  const available = hasSurfaceAction(role, action);
  return {
    ...spec,
    unavailable: spec.unavailable ?? (available ? undefined : { reason: "Not available right now" }),
    run: () => runSurfaceAction(role, action, id),
  };
}

// Keys must match KanbanBoard's COLUMNS exactly — the store's TaskCard["status"]
// union is what enforces it.
const KANBAN_COLUMNS: { status: TaskCard["status"]; label: string }[] = [
  { status: "todo", label: "To Do" },
  { status: "in_progress", label: "In Progress" },
  { status: "done", label: "Done" },
];

function kanbanCard(ctx: RowCtx): MenuGroup[] {
  const s = useAppStore.getState();
  const task = s.tasks?.find((t) => t.id === ctx.id);
  const current = task?.status;
  return [
    {
      id: "target",
      items: [
        actionItem("kanban-card", "run", ctx.id, {
          id: "row.kanban.run",
          label: "Run task",
          iconId: "terminal",
        }),
        {
          id: "row.kanban.rename",
          label: "Rename task…",
          iconId: "rename",
          run: async () => {
            const title = await promptForInput({
              title: "Rename task",
              label: "Title",
              initialValue: task?.title ?? "",
              confirmLabel: "Rename",
            });
            if (title) useAppStore.getState().updateTask(ctx.id, { title });
          },
        },
      ],
    },
    {
      id: "edit",
      title: "Move to",
      items: KANBAN_COLUMNS.map((col) => ({
        id: `row.kanban.move.${col.status}`,
        label: col.label,
        checked: current === col.status,
        unavailable: current === col.status ? { reason: "Already in this column" } : undefined,
        run: () => useAppStore.getState().moveTask(ctx.id, col.status),
      })),
    },
    {
      id: "view",
      items: [
        {
          id: "row.kanban.copyTitle",
          label: "Copy title",
          iconId: "copy",
          run: () => copy(task?.title ?? ctx.label),
        },
        {
          id: "row.kanban.delete",
          label: "Delete task",
          iconId: "trash",
          danger: true,
          run: async () => {
            const ok = await confirmAction({
              title: "Delete task?",
              detail: task?.title ?? ctx.label,
              confirmLabel: "Delete",
              danger: true,
            });
            if (ok) useAppStore.getState().removeTask(ctx.id);
          },
        },
      ],
    },
  ];
}

function kanbanColumn(ctx: RowCtx): MenuGroup[] {
  const status = ctx.id as TaskCard["status"];
  const s = useAppStore.getState();
  const inColumn = (s.tasks ?? []).filter((t) => t.status === status);
  return [
    {
      id: "target",
      items: [
        {
          id: "row.kanbanCol.add",
          label: "Add task here…",
          iconId: "file-plus",
          run: async () => {
            const title = await promptForInput({
              title: "New task",
              label: "Title",
              confirmLabel: "Add",
            });
            if (!title) return;
            const store = useAppStore.getState();
            store.addTask(title);
            // addTask hard-codes status "todo", so a non-todo column has to
            // move the task after creating it.
            if (status !== "todo") {
              const created = useAppStore.getState().tasks?.find((t) => t.title === title);
              if (created) useAppStore.getState().moveTask(created.id, status);
            }
          },
        },
      ],
    },
    {
      id: "view",
      items: [
        {
          id: "row.kanbanCol.copy",
          label: "Copy column as markdown",
          iconId: "copy",
          unavailable: inColumn.length === 0 ? { reason: "Column is empty" } : undefined,
          run: () => copy(inColumn.map((t) => `- ${t.title}`).join("\n")),
        },
      ],
    },
  ];
}

function reviewFile(ctx: RowCtx): MenuGroup[] {
  const path = ctx.id;
  return [
    {
      id: "target",
      items: [
        actionItem("review-file", "open", path, {
          id: "row.review.open",
          label: "Open in editor",
          iconId: "external-link",
        }),
        {
          id: "row.review.reveal",
          label: "Reveal in Explorer",
          iconId: "folder-open",
          run: () => invoke("reveal_in_explorer", { path: ctx.data.ctxAbsPath || path }).catch(() => {}),
        },
      ],
    },
    {
      id: "edit",
      items: [
        actionItem("review-file", "discard", path, {
          id: "row.review.discard",
          label: "Discard changes",
          iconId: "trash",
          danger: true,
        }),
      ],
    },
    {
      id: "view",
      items: [
        { id: "row.review.copyPath", label: "Copy path", iconId: "copy", run: () => copy(path) },
      ],
    },
  ];
}

function serverRow(ctx: RowCtx): MenuGroup[] {
  const host = ctx.data.ctxHost ?? "";
  const user = ctx.data.ctxUser ?? "";
  const hasKey = ctx.data.ctxHasKey === "1";
  const server = useAppStore.getState().servers.find((s) => s.id === ctx.id);
  // Token-auth servers bypass the Keychain entirely, so unlocking it is not a
  // thing that can apply to them — hidden, not disabled.
  const usesKeychain = (server?.claudeAuth ?? "keychain") === "keychain";
  return [
    {
      id: "target",
      items: [
        actionItem("server", "test", ctx.id, {
          id: "row.server.test",
          label: "Test connection",
          iconId: "restart",
        }),
        ...(usesKeychain
          ? [
              {
                id: "row.server.unlockKeychain",
                label: "Unlock keychain…",
                iconId: "key",
                // Verification runs over `ssh -o BatchMode=yes`, which cannot
                // answer a password prompt — so it can only work with a key.
                unavailable:
                  server?.authMethod === "password"
                    ? { reason: "Requires SSH key auth" }
                    : undefined,
                run: () => openUnlockKeychain(ctx.id),
              } satisfies MenuItemSpec,
            ]
          : []),
        actionItem("server", "edit", ctx.id, {
          id: "row.server.edit",
          label: "Edit server…",
          iconId: "rename",
        }),
        // Exactly one of these can apply, so the other is HIDDEN, not disabled.
        ...(hasKey
          ? [
              actionItem("server", "copyKey", ctx.id, {
                id: "row.server.copyKey",
                label: "Copy public key",
                iconId: "copy",
              }),
            ]
          : [
              actionItem("server", "setupKey", ctx.id, {
                id: "row.server.setupKey",
                label: "Set up SSH key…",
                iconId: "branch",
              }),
            ]),
      ],
    },
    {
      id: "view",
      items: [
        {
          id: "row.server.copyHost",
          label: "Copy host",
          iconId: "copy",
          unavailable: host ? undefined : { reason: "No host configured" },
          run: () => copy(host),
        },
        {
          id: "row.server.copyUserHost",
          label: "Copy user@host",
          iconId: "copy",
          unavailable: host && user ? undefined : { reason: "No user or host configured" },
          run: () => copy(`${user}@${host}`),
        },
        actionItem("server", "delete", ctx.id, {
          id: "row.server.delete",
          label: "Delete server",
          iconId: "trash",
          danger: true,
        }),
      ],
    },
  ];
}

function devServerRow(ctx: RowCtx): MenuGroup[] {
  const s = useAppStore.getState();
  const server = s.devServers?.find((d) => d.id === ctx.id);
  const url = ctx.data.ctxUrl ?? "";
  // Quick-open target: only meaningful once the project runs more than one
  // server, so the row is HIDDEN rather than disabled on single-server
  // projects — there is no choice being withheld.
  const siblings = server
    ? (s.devServers ?? []).filter((d) => isSameProject(d, server.workingDir, server.serverId))
    : [];
  const project = server
    ? s.recentProjects.find((p) =>
        isSameProject({ workingDir: p.path, serverId: p.serverId }, server.workingDir, server.serverId),
      )
    : undefined;
  const isQuickOpen = !!server && project?.primaryServerCommand === server.command;
  return [
    {
      id: "target",
      items: [
        {
          id: "row.devserver.open",
          label: "Open in browser preview",
          iconId: "external-link",
          unavailable: url ? undefined : { reason: "Server hasn't reported a URL yet" },
          // inApp: the label says browser PREVIEW — without it this row
          // opened the system browser (made:open-url's default path).
          run: () => window.dispatchEvent(new CustomEvent("made:open-url", { detail: { url, inApp: true } })),
        },
        {
          id: "row.devserver.copyUrl",
          label: "Copy URL",
          iconId: "copy",
          sublabel: url || undefined,
          unavailable: url ? undefined : { reason: "Server hasn't reported a URL yet" },
          run: () => copy(url),
        },
      ],
    },
    {
      id: "edit",
      items: [
        {
          id: "row.devserver.focus",
          label: "Focus its terminal",
          iconId: "terminal",
          unavailable: server?.terminalId ? undefined : { reason: "No terminal attached" },
          run: () => server?.terminalId && useAppStore.getState().setActiveTerminal(server.terminalId),
        },
        actionItem("devserver", "restart", ctx.id, {
          id: "row.devserver.restart",
          label: "Restart",
          iconId: "restart",
        }),
        ...(siblings.length > 1
          ? [
              {
                id: "row.devserver.quickOpen",
                label: "Set as quick-open target",
                iconId: "external-link" as const,
                unavailable: isQuickOpen
                  ? { reason: "Already what the globe icons open" }
                  : undefined,
                run: () =>
                  server &&
                  useAppStore
                    .getState()
                    .setPrimaryServerCommand(server.workingDir, server.serverId, server.command),
              },
            ]
          : []),
      ],
    },
    {
      id: "view",
      items: [
        {
          id: "row.devserver.remove",
          label: "Remove dev server",
          iconId: "trash",
          danger: true,
          run: async () => {
            const ok = await confirmAction({
              title: "Remove dev server?",
              detail: server?.projectName ?? ctx.label,
              confirmLabel: "Remove",
              danger: true,
            });
            if (ok) useAppStore.getState().removeDevServer(ctx.id);
          },
        },
      ],
    },
  ];
}

function editorTab(ctx: RowCtx): MenuGroup[] {
  const path = ctx.id;
  const dirty = ctx.data.ctxDirty === "1";
  const isMarkdown = /\.mdx?$/i.test(path);
  const wordWrap = !!useAppStore.getState().editorWordWrap;
  return [
    {
      id: "edit",
      items: [
        actionItem("editor-tab", "save", path, {
          id: "row.editor.save",
          label: "Save",
          command: undefined,
          shortcut: "Ctrl+S",
          unavailable: dirty ? undefined : { reason: "No unsaved changes" },
        }),
        actionItem("editor-tab", "close", path, {
          id: "row.editor.close",
          label: "Close",
          iconId: "close-pane",
        }),
        actionItem("editor-tab", "closeOthers", path, {
          id: "row.editor.closeOthers",
          label: "Close other files",
          iconId: "close-pane",
        }),
      ],
    },
    {
      id: "view",
      items: [
        // Preview only means anything for markdown — hidden elsewhere.
        ...(isMarkdown
          ? [
              actionItem("editor-tab", "togglePreview", path, {
                id: "row.editor.preview",
                label: "Toggle markdown preview",
                iconId: "filter",
              }),
            ]
          : []),
        {
          id: "row.editor.wordWrap",
          label: "Word wrap",
          checked: wordWrap,
          sticky: true,
          run: () => useAppStore.getState().setEditorWordWrap(!useAppStore.getState().editorWordWrap),
        },
        {
          id: "row.editor.revealSidebar",
          label: "Reveal in file sidebar",
          iconId: "sidebar",
          run: () => useAppStore.getState().requestRevealFile(path),
        },
        {
          id: "row.editor.reveal",
          label: "Reveal in Explorer",
          iconId: "folder-open",
          run: () => invoke("reveal_in_explorer", { path }).catch(() => {}),
        },
        { id: "row.editor.copyPath", label: "Copy path", iconId: "copy", run: () => copy(path) },
      ],
    },
  ];
}

function browserPane(ctx: RowCtx): MenuGroup[] {
  const url = ctx.data.ctxUrl ?? "";
  const canBack = ctx.data.ctxCanBack === "1";
  const canFwd = ctx.data.ctxCanForward === "1";

  // What the PAGE reported under the cursor. Untrusted — a hostile page can
  // forge every field — so URLs are scheme-checked before we offer to open or
  // copy them, and the raw values are never executed.
  const page = getBrowserPageContext(BROWSER_SURFACE_ID);
  const linkUrl = safeExternalUrl(page?.linkUrl ?? "");
  const imgUrl = safeExternalUrl(page?.imgUrl ?? "");
  const selection = page?.selText?.trim() ?? "";

  const groups: MenuGroup[] = [];

  // ── What was clicked ── shown ONLY when there is actually a link, an image
  // or a selection there. This is the difference between a browser menu and a
  // generic one: right-clicking a link should not look like right-clicking
  // empty page background.
  const onTarget: MenuItemSpec[] = [];
  if (linkUrl) {
    onTarget.push(
      {
        id: "row.browser.openLinkExternal",
        label: "Open link in default browser",
        iconId: "external-link",
        sublabel: displayUrl(linkUrl),
        run: () => void openUrl(linkUrl).catch(() => {}),
      },
      {
        id: "row.browser.copyLink",
        label: "Copy link address",
        iconId: "copy",
        run: () => copy(linkUrl),
      },
    );
    if (page?.linkText) {
      onTarget.push({
        id: "row.browser.copyLinkText",
        label: "Copy link text",
        iconId: "copy",
        run: () => copy(page.linkText),
      });
    }
  }
  if (imgUrl) {
    onTarget.push({
      id: "row.browser.copyImageUrl",
      label: "Copy image address",
      iconId: "copy",
      sublabel: displayUrl(imgUrl),
      run: () => copy(imgUrl),
    });
  }
  if (selection) {
    onTarget.push(
      {
        id: "row.browser.copySelection",
        label: "Copy",
        iconId: "copy",
        run: () => copy(selection),
      },
      {
        id: "row.browser.sendSelection",
        label: "Send selection to AI pane",
        iconId: "cli-claude",
        unavailable: hasActiveTerminal()
          ? undefined
          : { reason: "No terminal is focused" },
        run: () => sendTextToActiveTerminal(selection),
      },
    );
  }
  if (onTarget.length > 0) groups.push({ id: "selection", items: onTarget });

  // ── Navigation ──
  groups.push({
    id: "target",
    items: [
      actionItem("browser", "back", ctx.id, {
        id: "row.browser.back",
        label: "Back",
        iconId: "arrow-left",
        unavailable: canBack ? undefined : { reason: "No page to go back to" },
      }),
      actionItem("browser", "forward", ctx.id, {
        id: "row.browser.forward",
        label: "Forward",
        iconId: "arrow-right",
        unavailable: canFwd ? undefined : { reason: "No page to go forward to" },
      }),
      actionItem("browser", "reload", ctx.id, {
        id: "row.browser.reload",
        label: "Reload",
        iconId: "restart",
      }),
      actionItem("browser", "hardReload", ctx.id, {
        id: "row.browser.hardReload",
        label: "Hard reload",
        iconId: "restart",
      }),
    ],
  });

  // ── This page ──
  groups.push({
    id: "view",
    items: [
      actionItem("browser", "openExternal", ctx.id, {
        id: "row.browser.external",
        label: "Open page in default browser",
        iconId: "external-link",
        unavailable: url ? undefined : { reason: "Nothing loaded" },
      }),
      {
        id: "row.browser.copyUrl",
        label: "Copy page URL",
        iconId: "copy",
        sublabel: url ? displayUrl(url) : undefined,
        unavailable: url ? undefined : { reason: "Nothing loaded" },
        run: () => copy(url),
      },
      actionItem("browser", "devtools", ctx.id, {
        id: "row.browser.devtools",
        label: "Toggle DevTools",
        iconId: "devtools",
      }),
      {
        id: "row.browser.passthroughHint",
        label: "Use the page's own menu",
        shortcut: "Shift+Right-click",
        unavailable: {
          reason: "Hold Shift while right-clicking to let the page show its own context menu",
        },
        run: () => {},
      },
    ],
  });

  return groups;
}

/**
 * The games sidebar — one app-level surface, so every item here acts globally.
 *
 * Pause/Resume and "All games" are component-local state inside GamePane, so
 * they come through the surface-actions registry: if GamePane is somehow not
 * mounted the rows disable with a reason rather than silently doing nothing.
 * Closing is a plain store action and always available.
 */
function gameSidebar(ctx: RowCtx): MenuGroup[] {
  // Decided at build time — the menu must never resize after it opens.
  const activeGame = ctx.data.ctxGame ?? "";
  const paused = ctx.data.ctxPaused === "1";
  const items: MenuItemSpec[] = [];

  if (activeGame) {
    items.push(
      // No icon: CTX_ICONS has no play/pause glyph, and OverlayRoot silently
      // drops unknown ids — an invented one would just render blank.
      actionItem("game-sidebar", "togglePause", ctx.id, {
        id: "row.gameSidebar.togglePause",
        label: paused ? "Resume" : "Pause",
      }),
      actionItem("game-sidebar", "back", ctx.id, {
        id: "row.gameSidebar.back",
        label: "All games",
        iconId: "arrow-left",
      }),
    );
  }

  items.push({
    id: "row.gameSidebar.close",
    label: "Close games sidebar",
    iconId: "close-pane",
    run: () => useAppStore.getState().closeGameSidebar(),
  });

  return [{ id: "target", items }];
}

function sidebarBackground(ctx: RowCtx): MenuGroup[] {
  const root = ctx.data.ctxRoot ?? "";
  const mk = async (kind: "file" | "dir") => {
    const name = await promptForInput({
      title: kind === "file" ? "New file" : "New folder",
      label: "Name",
      detail: root,
      confirmLabel: "Create",
    });
    if (!name) return;
    try {
      await invoke(kind === "file" ? "fs_create_file" : "fs_create_dir", { root, dir: root, name });
      window.dispatchEvent(new Event("made:file-tree-refresh"));
    } catch (e) {
      await confirmAction({ title: "Could not create", detail: String(e), confirmLabel: "OK" });
    }
  };
  return [
    {
      id: "target",
      items: [
        {
          id: "row.sidebar.newFile",
          label: "New file…",
          iconId: "file-plus",
          unavailable: root ? undefined : { reason: "No project folder open" },
          run: () => void mk("file"),
        },
        {
          id: "row.sidebar.newFolder",
          label: "New folder…",
          iconId: "folder-plus",
          unavailable: root ? undefined : { reason: "No project folder open" },
          run: () => void mk("dir"),
        },
        {
          id: "row.sidebar.refresh",
          label: "Refresh",
          iconId: "restart",
          run: () => window.dispatchEvent(new Event("made:file-tree-refresh")),
        },
      ],
    },
    {
      id: "view",
      items: [
        {
          id: "row.sidebar.reveal",
          label: "Reveal project in Explorer",
          iconId: "folder-open",
          unavailable: root ? undefined : { reason: "No project folder open" },
          run: () => invoke("open_folder", { path: root }).catch(() => {}),
        },
        {
          id: "row.sidebar.copyRoot",
          label: "Copy project path",
          iconId: "copy",
          sublabel: root || undefined,
          unavailable: root ? undefined : { reason: "No project folder open" },
          run: () => copy(root),
        },
        {
          id: "row.sidebar.dockSide",
          label: useAppStore.getState().sidebarSide === "right" ? "Dock left" : "Dock right",
          iconId: "sidebar",
          run: () => {
            const s = useAppStore.getState();
            s.setSidebarSide(s.sidebarSide === "right" ? "left" : "right");
          },
        },
      ],
    },
  ];
}

/**
 * A ticket row in a Jira project's rail.
 *
 * Rename changes the row's DISPLAY name only — grouping, color, copy, and the
 * browser URL stay keyed to the ticket KEY (`data-ctx-ticket`), so a renamed
 * row is still findable by number. The name syncs both ways with the Claude
 * session title: `--name` on the pane's next launch pushes it to the CLI, and
 * the rail adopts CLI-side renames from the sessions index.
 */
function jiraTicket(ctx: RowCtx): MenuGroup[] {
  const id = ctx.id;
  // Display label may carry an instance suffix ("SUPPORT-1 #2"); color and
  // copy operate on the BASE ticket the row advertises separately.
  const ticket = (ctx.data.ctxTicket as string | undefined) ?? ctx.label;
  const isOpen = ctx.data.ctxOpen === "1";
  const gone = ctx.data.ctxGone === "1";
  const archived = ctx.data.ctxArchived === "1";
  // The rail's hamburger opens a COMPACT menu — the flag rides the same
  // data-ctx channel as everything else and only exists for the synthetic
  // dispatch (see openRowMenu). Items are shared specs, so the compact menu
  // is a strict subset of the right-click menu and the two cannot drift.
  const compact = ctx.data.ctxCompact === "1";

  const rename = actionItem("jira-ticket", "rename", id, {
    id: "row.jira.rename",
    label: "Rename…",
    iconId: "rename",
  });
  const openInJira = actionItem("jira-ticket", "openInBrowser", id, {
    id: "row.jira.browser",
    label: "Open in Jira",
    iconId: "external-link",
  });
  // Sub-ticket = a second, independent Claude conversation on the same
  // ticket ("SUPPORT-1 #2"), sharing the ticket's browser pane. One entry
  // point; the fork/fresh/empty flavor is picked in a chooser dialog
  // (PromptModal) — the overlay menu has no flyouts.
  const subTicket = actionItem("jira-ticket", "duplicate", id, {
    id: "row.jira.duplicate",
    label: "Create sub-ticket…",
    iconId: "duplicate",
  });
  // Hands the pane the investigation prompt it may never have been given — an
  // empty sub-ticket, a fork, or a resumed conversation all start without one.
  // Pasted, not submitted, so it can be edited (and so a mis-click cannot fire
  // a prompt into a pane that is mid-answer).
  const sendPrompt = actionItem("jira-ticket", "sendPrompt", id, {
    id: "row.jira.sendPrompt",
    label: "Insert investigation prompt",
    unavailable: isOpen ? undefined : { reason: "Pane is not open" },
  });
  const closePane = actionItem("jira-ticket", "closePane", id, {
    id: "row.jira.closePane",
    label: "Close pane",
    iconId: "close-pane",
    unavailable: isOpen ? undefined : { reason: "Pane is not open" },
  });
  const archiveItem = actionItem("jira-ticket", "toggleArchive", id, {
    id: "row.jira.archive",
    label: archived ? "Unarchive" : "Archive ticket",
  });

  if (compact) {
    // Just the actions a user reaches for in passing. No opener (a plain
    // click on the row already opens it), no Delete (destructive stays
    // behind the deliberate right-click), no colors / copy-key.
    return [
      { id: "edit", items: [rename] },
      { id: "target", items: [openInJira, subTicket] },
      { id: "pane", items: [sendPrompt, closePane, archiveItem] },
    ];
  }

  const currentColor = ticket
    ? (useAppStore.getState().jiraTicketColors?.[ticket] ?? null)
    : null;
  return [
    {
      id: "target",
      items: [
        // An OPEN row's primary action is a plain click on the row itself, so
        // the menu carries no "Focus pane" — only closed rows get an opener.
        ...(isOpen
          ? []
          : [
              actionItem("jira-ticket", "open", id, {
                id: "row.jira.open",
                label: "Reopen investigation",
                unavailable: gone
                  ? { reason: "This conversation's transcript is gone" }
                  : archived
                    ? { reason: "Unarchive the ticket first" }
                    : undefined,
              }),
            ]),
        openInJira,
        subTicket,
      ],
    },
    {
      id: "view",
      // Keyed by TICKET, so the row edge and the pane tint always agree.
      title: "Ticket color",
      items: [],
      swatches: [
        {
          id: "row.jira.color.auto",
          color: null,
          label: "Auto",
          selected: currentColor == null,
          run: () => {
            if (ticket) useAppStore.getState().setJiraTicketColor(ticket, null);
          },
        },
        ...PROJECT_COLOR_PRESETS.map((p) => ({
          id: `row.jira.color.${p.id}`,
          color: p.color,
          label: p.label,
          selected: currentColor === p.id,
          run: () => {
            if (ticket) useAppStore.getState().setJiraTicketColor(ticket, p.id);
          },
        })),
      ],
    },
    {
      id: "edit",
      items: [
        rename,
        {
          id: "row.jira.copyKey",
          label: "Copy ticket number",
          iconId: "copy",
          sublabel: ticket || undefined,
          unavailable: ticket ? undefined : { reason: "No ticket number" },
          run: () => copy(ticket),
        },
      ],
    },
    {
      id: "pane",
      items: [
        sendPrompt,
        closePane,
        archiveItem,
        // ONE destructive row. "Remove from list" used to sit beside this
        // with a nearly identical outcome (row gone, transcript kept) — the
        // only difference was who closed the pane. Delete closes it itself.
        actionItem("jira-ticket", "del", id, {
          id: "row.jira.delete",
          label: "Delete ticket…",
          iconId: "trash",
          danger: true,
        }),
      ],
    },
  ];
}

/** Assigned-tab rows (Settings > Jira > "My assigned tickets"): tickets
 * assigned to the user, usually with no investigation yet. A plain click shows
 * the browser-only preview, so the menu carries the promotion (Investigate —
 * the ONLY path from an assigned row to a CLI pane) and the browser escape
 * hatch. Deliberately small: these rows are not sessions, so rename / color /
 * archive / delete have nothing to act on and are HIDDEN, not disabled. */
function jiraAssigned(ctx: RowCtx): MenuGroup[] {
  // ctx.id is the QUALIFIED key (`<origin>|<KEY>`) — the surface actions
  // split it. The bare key rides data-ctx-ticket for copy/sublabel.
  const qkey = ctx.id;
  const bare = (ctx.data.ctxTicket as string | undefined) ?? ctx.label;
  // One site per tab: a foreign-site row can only be investigated from a tab
  // on its own site (the row advertises it — see renderAssignedRow).
  const foreign = ctx.data.ctxForeign === "1";
  return [
    {
      id: "target",
      items: [
        actionItem("jira-assigned", "investigate", qkey, {
          id: "row.jiraAssigned.investigate",
          label: "Investigate ticket",
          unavailable: foreign
            ? { reason: "This ticket lives on another Jira site — open a project on that site first" }
            : undefined,
        }),
        actionItem("jira-assigned", "openInBrowser", qkey, {
          id: "row.jiraAssigned.browser",
          label: "Open in Jira",
          iconId: "external-link",
        }),
      ],
    },
    {
      id: "edit",
      items: [
        {
          id: "row.jiraAssigned.copyKey",
          label: "Copy ticket number",
          iconId: "copy",
          sublabel: bare || undefined,
          run: () => copy(bare),
        },
      ],
    },
  ];
}

// ── NexusMind knowledge sidebar ─────────────────────────────────────────────
//
// Two surfaces: a note row and the panel background. Both resolve their project
// from the ACTIVE tab, because the knowledge sidebar is a single app-level
// instance bound to that tab — there is never a second one showing a different
// project.

function knowledgeProjectPath(): string {
  const s = useAppStore.getState();
  return s.tabs.find((t) => t.id === s.activeTabId)?.workingDir ?? "";
}

/** The agent pane an "insert" would target, or why there is none. */
function knowledgeAgentReason(): string | null {
  const t = activeTerminal();
  if (!t) return "No active agent pane";
  const isAgent = t.type === "claude" || t.type === "codex" || t.type === "gemini";
  return isAgent ? null : "No active agent pane";
}

function knowledgeNoteRows(ctx: RowCtx): MenuGroup[] {
  const path = knowledgeProjectPath();
  const writeBlocked = knowledgeBlockedReason(path);
  const readBlocked = knowledgeReadBlockedReason(path);
  const isCore = ctx.data.ctxCore === "1";
  const type = (ctx.data.ctxType ?? "note") as KnowledgeNoteType;
  const slug = ctx.data.ctxSlug ?? "";
  const reference = knowledgeRefFor(type, slug);
  const filePath = ctx.data.ctxPath ?? "";

  return [
    {
      id: "target",
      items: [
        actionItem("knowledge-note", "open", ctx.id, {
          id: "row.knote.open",
          label: "Open",
          unavailable: filePath ? undefined : { reason: "This note has no file on disk yet" },
        }),
        actionItem("knowledge-note", "openPreview", ctx.id, {
          id: "row.knote.openPreview",
          label: "Open preview",
          iconId: "filter",
          unavailable: filePath ? undefined : { reason: "This note has no file on disk yet" },
        }),
        actionItem("knowledge-note", "insertIntoAgent", ctx.id, {
          id: "row.knote.insert",
          // Same verb as the note panel's button — one action, one name.
          label: "Send to agent",
          iconId: "terminal",
          unavailable: readBlocked
            ? { reason: readBlocked }
            : knowledgeAgentReason()
              ? { reason: knowledgeAgentReason() as string }
              : undefined,
        }),
        {
          id: "row.knote.copyRef",
          label: "Copy reference",
          iconId: "copy",
          sublabel: reference,
          // A note with no slug has nothing addressable yet; copying "@note/"
          // would put a reference in the clipboard that resolves to nothing.
          unavailable:
            type === "note" && !slug ? { reason: "This note has no reference yet" } : undefined,
          run: () => copy(reference),
        },
      ],
    },
    {
      id: "view",
      items: [
        actionItem("knowledge-note", "rename", ctx.id, {
          id: "row.knote.rename",
          label: "Rename…",
          iconId: "rename",
          unavailable: isCore
            ? { reason: "Core memory files can't be renamed" }
            : writeBlocked
              ? { reason: writeBlocked }
              : undefined,
        }),
        actionItem("knowledge-note", "archive", ctx.id, {
          id: "row.knote.archive",
          label: "Archive",
          iconId: "archive",
          unavailable: isCore
            ? { reason: "Core memory files can't be archived" }
            : writeBlocked
              ? { reason: writeBlocked }
              : undefined,
        }),
        actionItem("knowledge-note", "history", ctx.id, {
          id: "row.knote.history",
          label: "History…",
          iconId: "history",
          unavailable: readBlocked ? { reason: readBlocked } : undefined,
        }),
        // File-row parity (user, 2026-08-08): a knowledge note IS a file, so
        // it answers the same questions the Files tab answers — where is it,
        // and give me its path.
        actionItem("knowledge-note", "reveal", ctx.id, {
          id: "row.knote.reveal",
          label: "Reveal in Explorer",
          iconId: "folder-open",
          unavailable: filePath ? undefined : { reason: "This note has no file on disk yet" },
        }),
        {
          id: "row.knote.copyPath",
          label: "Copy path",
          iconId: "copy",
          unavailable: filePath ? undefined : { reason: "This note has no file on disk yet" },
          run: () => copy(filePath),
        },
      ],
    },
  ];
}

function knowledgeBackground(ctx: RowCtx): MenuGroup[] {
  const path = knowledgeProjectPath();
  const writeBlocked = knowledgeBlockedReason(path);
  const readBlocked = knowledgeReadBlockedReason(path);
  const agentReason = knowledgeAgentReason();
  const alreadyIgnored = ctx.data.ctxGitignored === "1";
  const initialized = !readBlocked;

  return [
    {
      id: "target",
      items: [
        actionItem("knowledge", "newNote", ctx.id, {
          id: "row.knowledge.newNote",
          label: "New note…",
          iconId: "file-plus",
          unavailable: writeBlocked ? { reason: writeBlocked } : undefined,
        }),
        actionItem("knowledge", "createHandoff", ctx.id, {
          id: "row.knowledge.createHandoff",
          label: "Create handoff",
          iconId: "arrow-right",
          unavailable: writeBlocked ? { reason: writeBlocked } : undefined,
        }),
        actionItem("knowledge", "continueHandoff", ctx.id, {
          id: "row.knowledge.continueHandoff",
          label: "Continue from latest handoff",
          iconId: "terminal",
          unavailable: readBlocked
            ? { reason: readBlocked }
            : agentReason
              ? { reason: agentReason }
              : undefined,
        }),
      ],
    },
    {
      id: "view",
      items: [
        actionItem("knowledge", "refresh", ctx.id, {
          id: "row.knowledge.refresh",
          label: "Refresh",
          iconId: "restart",
          unavailable: readBlocked ? { reason: readBlocked } : undefined,
        }),
        actionItem("knowledge", "revealFolder", ctx.id, {
          id: "row.knowledge.reveal",
          label: `Reveal ${MEMORY_DIR_NAME} in Explorer`,
          iconId: "folder-open",
          unavailable: initialized
            ? undefined
            : { reason: readBlocked ?? "Knowledge is not initialized for this project" },
        }),
        actionItem("knowledge", "addGitignore", ctx.id, {
          id: "row.knowledge.gitignore",
          label: `Add ${MEMORY_DIR_NAME} to .gitignore`,
          iconId: "branch",
          unavailable: alreadyIgnored
            ? { reason: "Already ignored" }
            : writeBlocked
              ? { reason: writeBlocked }
              : undefined,
        }),
      ],
    },
    // Only when there is a workspace to remove: the init panel, a remote tab
    // and a still-loading project HIDE the row (it can never apply there),
    // while a read-only follower instance shows it DISABLED with the reason —
    // the owner instance is the one allowed to delete.
    ...(ctx.data.ctxStatus === "ready" || ctx.data.ctxStatus === "readonly"
      ? [
          {
            id: "edit" as const,
            items: [
              actionItem("knowledge", "removeProject", ctx.id, {
                id: "row.knowledge.remove",
                label: "Remove NexusMind from project…",
                iconId: "trash",
                danger: true,
                unavailable: writeBlocked ? { reason: writeBlocked } : undefined,
              }),
            ],
          },
        ]
      : []),
  ];
}

const rowProvider: MenuProvider<"row"> = {
  id: "row",
  surface: "row",
  order: 10,
  build({ ctx }): MenuGroup[] {
    switch (ctx.role) {
      case "kanban-card":
        return kanbanCard(ctx);
      case "kanban-col":
        return kanbanColumn(ctx);
      case "review-file":
        return reviewFile(ctx);
      case "server":
        return serverRow(ctx);
      case "devserver":
        return devServerRow(ctx);
      case "editor-tab":
        return editorTab(ctx);
      case "browser":
        return browserPane(ctx);
      case "sidebar":
        return sidebarBackground(ctx);
      case "jira-ticket":
        return jiraTicket(ctx);
      case "jira-assigned":
        return jiraAssigned(ctx);
      case "game-sidebar":
        return gameSidebar(ctx);
      case "knowledge-note":
        return knowledgeNoteRows(ctx);
      case "knowledge":
        return knowledgeBackground(ctx);
      default:
        return [];
    }
  },
};

registerMenuProvider(rowProvider as MenuProvider);
