import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../../store";
import { hasSurfaceAction, runSurfaceAction, type SurfaceRole } from "../../surface-actions";
import { promptForInput, confirmAction } from "../../prompt-modal";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getPtyWrite } from "../../../store/terminalSlice";
import {
  getBrowserPageContext,
  safeExternalUrl,
  displayUrl,
  BROWSER_SURFACE_ID,
} from "../../../browser-view/page-context";
import { registerMenuProvider } from "../registry";
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
  return [
    {
      id: "target",
      items: [
        actionItem("server", "test", ctx.id, {
          id: "row.server.test",
          label: "Test connection",
          iconId: "restart",
        }),
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
  return [
    {
      id: "target",
      items: [
        {
          id: "row.devserver.open",
          label: "Open in browser preview",
          iconId: "external-link",
          unavailable: url ? undefined : { reason: "Server hasn't reported a URL yet" },
          run: () => window.dispatchEvent(new CustomEvent("made:open-url", { detail: { url } })),
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
      ],
    },
  ];
}

/**
 * A ticket row in a Jira project's rail.
 *
 * No "Rename": the row's name IS its ticket key, and letting it drift from the
 * key would break the one thing the rail is for — finding a ticket by number.
 */
function jiraTicket(ctx: RowCtx): MenuGroup[] {
  const id = ctx.id;
  const ticket = ctx.label;
  const isOpen = ctx.data.ctxOpen === "1";
  const gone = ctx.data.ctxGone === "1";
  return [
    {
      id: "target",
      items: [
        actionItem("jira-ticket", "open", id, {
          id: "row.jira.open",
          label: isOpen ? "Focus pane" : "Reopen investigation",
          unavailable: gone
            ? { reason: "This conversation's transcript is gone" }
            : undefined,
        }),
        actionItem("jira-ticket", "openInBrowser", id, {
          id: "row.jira.browser",
          label: "Show ticket in browser",
        }),
      ],
    },
    {
      id: "edit",
      items: [
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
        actionItem("jira-ticket", "forget", id, {
          id: "row.jira.forget",
          label: "Remove from list",
          iconId: "close-pane",
          danger: true,
          unavailable: isOpen ? { reason: "Close the pane first" } : undefined,
        }),
      ],
    },
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
      default:
        return [];
    }
  },
};

registerMenuProvider(rowProvider as MenuProvider);
