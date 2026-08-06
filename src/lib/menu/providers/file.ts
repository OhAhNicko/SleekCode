import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../../../store";
import { getPtyWrite } from "../../../store/terminalSlice";
import { promptForInput, confirmAction } from "../../prompt-modal";
import { isImagePath, openImageFileInViewer } from "../../screenshots";
import { registerMenuProvider } from "../registry";
import type { FileCtx } from "../context";
import type { MenuGroup, MenuItemSpec, MenuProvider } from "../types";

const copy = (text: string) => navigator.clipboard.writeText(text).catch(() => {});

function relativePath(ctx: FileCtx): string {
  if (!ctx.rootDir || !ctx.path.startsWith(ctx.rootDir)) return ctx.path;
  return ctx.path.slice(ctx.rootDir.length).replace(/^[\\/]+/, "");
}

/** Tell the sidebar to re-read a directory after a mutation. */
function refreshTree(): void {
  window.dispatchEvent(new Event("made:file-tree-refresh"));
}

async function doRename(ctx: FileCtx): Promise<void> {
  const name = await promptForInput({
    title: ctx.isDir ? "Rename folder" : "Rename file",
    label: "New name",
    initialValue: ctx.name,
    confirmLabel: "Rename",
  });
  if (!name || name === ctx.name) return;
  try {
    await invoke<string>("fs_rename", { root: ctx.rootDir, path: ctx.path, newName: name });
    refreshTree();
  } catch (e) {
    await confirmAction({ title: "Rename failed", detail: String(e), confirmLabel: "OK" });
  }
}

async function doDelete(ctx: FileCtx): Promise<void> {
  const ok = await confirmAction({
    title: ctx.isDir ? "Delete folder?" : "Delete file?",
    detail: `${ctx.path}\n\nThis moves it to the Recycle Bin.`,
    confirmLabel: "Delete",
    danger: true,
    // A folder delete takes everything inside it — make that deliberate.
    requireTyped: ctx.isDir ? ctx.name : undefined,
  });
  if (!ok) return;
  try {
    await invoke("fs_delete_to_trash", { root: ctx.rootDir, path: ctx.path });
    refreshTree();
  } catch (e) {
    await confirmAction({ title: "Delete failed", detail: String(e), confirmLabel: "OK" });
  }
}

async function doCreate(ctx: FileCtx, kind: "file" | "dir"): Promise<void> {
  // Creating "inside" a file means creating beside it, in its folder.
  const dir = ctx.isDir ? ctx.path : ctx.path.replace(/[\\/][^\\/]+$/, "");
  const name = await promptForInput({
    title: kind === "file" ? "New file" : "New folder",
    label: "Name",
    detail: dir,
    confirmLabel: "Create",
  });
  if (!name) return;
  try {
    await invoke<string>(kind === "file" ? "fs_create_file" : "fs_create_dir", {
      root: ctx.rootDir,
      dir,
      name,
    });
    refreshTree();
  } catch (e) {
    await confirmAction({ title: "Could not create", detail: String(e), confirmLabel: "OK" });
  }
}

/**
 * Attach the path to the focused pane's prompt, so an AI CLI can act on it.
 * Uses bracketed paste for CLI panes for the same reason image paths do —
 * the TUI must ingest it as one atom.
 */
function attachAsContext(ctx: FileCtx): void {
  const s = useAppStore.getState();
  const active = Object.values(s.terminals).find((t) => t.isActive);
  if (!active) return;
  const write = getPtyWrite(active.id);
  if (!write) return;
  const isCli = active.type === "claude" || active.type === "codex" || active.type === "gemini";
  const rel = relativePath(ctx);
  if (isCli) write("\x1b[200~" + rel + "\x1b[201~");
  else write(`"${rel}" `);
}

function hasActiveTerminal(): boolean {
  return Object.values(useAppStore.getState().terminals).some((t) => t.isActive);
}

const fileProvider: MenuProvider<"file"> = {
  id: "file",
  surface: "file",
  order: 10,
  build({ ctx }): MenuGroup[] {
    const isRoot = ctx.path === ctx.rootDir;
    const open: MenuItemSpec[] = [];

    if (!ctx.isDir) {
      // For images the viewer is the primary open — the file pane reads UTF-8
      // and can only show an error for them.
      if (isImagePath(ctx.path)) {
        open.push({
          id: "file.openImageViewer",
          label: "Open in screenshot viewer",
          iconId: "image",
          run: (c) => void openImageFileInViewer((c as FileCtx).path),
        });
      }
      open.push(
        {
          id: "file.open",
          label: "Open",
          iconId: "external-link",
          run: (c) =>
            window.dispatchEvent(
              new CustomEvent("made:open-file", { detail: { filePath: (c as FileCtx).path } }),
            ),
        },
        {
          id: "file.openDefaultApp",
          label: "Open with default app",
          iconId: "external-link",
          run: (c) => void openUrl(`file://${(c as FileCtx).path}`).catch(() => {}),
        },
      );
    } else {
      open.push({
        id: "file.openTerminalHere",
        label: "Open terminal here",
        iconId: "terminal",
        run: (c) =>
          window.dispatchEvent(
            new CustomEvent("made:split-terminal", {
              detail: { type: "shell", workingDir: (c as FileCtx).path },
            }),
          ),
      });
    }

    open.push({
      id: "file.reveal",
      label: ctx.isDir ? "Open folder in Explorer" : "Reveal in Explorer",
      iconId: "folder-open",
      run: (c) => {
        const f = c as FileCtx;
        // reveal_in_explorer SELECTS a file inside its folder; open_folder
        // opens a directory. Using the wrong one on a folder opens its parent.
        invoke(f.isDir ? "open_folder" : "reveal_in_explorer", { path: f.path }).catch(() => {});
      },
    });

    const mutate: MenuItemSpec[] = [
      {
        id: "file.newFile",
        label: "New file…",
        iconId: "file-plus",
        run: (c) => void doCreate(c as FileCtx, "file"),
      },
      {
        id: "file.newFolder",
        label: "New folder…",
        iconId: "folder-plus",
        run: (c) => void doCreate(c as FileCtx, "dir"),
      },
      {
        id: "file.rename",
        label: "Rename…",
        iconId: "rename",
        unavailable: isRoot ? { reason: "Cannot rename the project root" } : undefined,
        run: (c) => void doRename(c as FileCtx),
      },
      {
        id: "file.delete",
        label: "Delete",
        iconId: "trash",
        danger: true,
        unavailable: isRoot ? { reason: "Cannot delete the project root" } : undefined,
        run: (c) => void doDelete(c as FileCtx),
      },
    ];

    return [
      { id: "target", items: open },
      { id: "edit", items: mutate },
      {
        id: "selection",
        items: [
          {
            id: "file.attach",
            label: "Attach as context",
            iconId: "attach",
            unavailable: hasActiveTerminal() ? undefined : { reason: "No terminal is focused" },
            run: (c) => attachAsContext(c as FileCtx),
          },
        ],
      },
      {
        id: "view",
        items: [
          { id: "file.copyPath", label: "Copy path", iconId: "copy", run: (c) => copy((c as FileCtx).path) },
          {
            id: "file.copyRelPath",
            label: "Copy relative path",
            iconId: "copy",
            sublabel: relativePath(ctx),
            run: (c) => copy(relativePath(c as FileCtx)),
          },
          { id: "file.copyName", label: "Copy file name", iconId: "copy", run: (c) => copy((c as FileCtx).name) },
        ],
      },
    ];
  },
};

registerMenuProvider(fileProvider as MenuProvider);
