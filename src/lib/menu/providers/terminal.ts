import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../../store";
import { runCommand } from "../../commands";
import { pasteTextToTerminal } from "../../terminal-paste";
import { getActivePaneSearchOpener } from "../../pane-search-registry";
import { getTerminalActions } from "../../terminal-actions";
import {
  getNativeTermIdForTerminal,
  nativeTermCopySelection,
  nativeTermPasteClipboard,
} from "../../native-term-bridge";
import { registerMenuProvider } from "../registry";
import type { TerminalCtx } from "../context";
import type { MenuGroup, MenuItemSpec, MenuProvider } from "../types";

function copySelection(ctx: TerminalCtx): void {
  // Native panes: fully Rust-side. While the pane HWND owns OS focus (the
  // steady state right after a right-click on it), navigator.clipboard
  // rejects with "document is not focused" — the JS path below can never
  // work there. The Rust command also reads the LIVE selection instead of
  // the mirrored snapshot.
  if (ctx.renderer === "native") {
    const nid = getNativeTermIdForTerminal(ctx.terminalId);
    if (nid != null) {
      void nativeTermCopySelection(nid).catch(() => {});
      return;
    }
  }
  if (!ctx.selection) return;
  navigator.clipboard.writeText(ctx.selection).catch(() => {});
}

async function pasteFromClipboard(ctx: TerminalCtx): Promise<void> {
  // Same focus story as copySelection — Rust reads the clipboard and writes
  // the PTY with the pane's real bracketed-paste state.
  if (ctx.renderer === "native") {
    const nid = getNativeTermIdForTerminal(ctx.terminalId);
    if (nid != null) {
      void nativeTermPasteClipboard(nid).catch(() => {});
      return;
    }
  }
  try {
    const text = await navigator.clipboard.readText();
    if (text) pasteTextToTerminal(ctx.terminalId, text);
  } catch {
    // Clipboard read can be denied; nothing sensible to do but skip.
  }
}

function splitItem(
  dir: "right" | "left" | "down" | "up",
  ctx: TerminalCtx,
): MenuItemSpec {
  const meta = {
    right: { label: "Split pane right", iconId: "split-right", command: "pane.splitRight" as const },
    left: { label: "Split pane left", iconId: "split-left", command: undefined },
    down: { label: "Split pane down", iconId: "split-down", command: "pane.splitDown" as const },
    up: { label: "Split pane up", iconId: "split-up", command: undefined },
  }[dir];
  return {
    id: `terminal.split.${dir}`,
    label: meta.label,
    iconId: meta.iconId,
    command: meta.command,
    run: () =>
      window.dispatchEvent(
        new CustomEvent("made:split-terminal", {
          detail: { type: "shell", direction: dir, targetTerminalId: ctx.terminalId },
        }),
      ),
  };
}

/**
 * Terminal pane menu.
 *
 * Every action names `ctx.terminalId` explicitly. That is the whole point: the
 * old menu dispatched bare events that `Workspace` resolved against
 * `activeTerminalId`, so right-clicking an unfocused pane and choosing "Close
 * Pane" closed a different pane.
 */
const terminalProvider: MenuProvider<"terminal"> = {
  id: "terminal",
  surface: "terminal",
  order: 10,
  build({ ctx }): MenuGroup[] {
    const groups: MenuGroup[] = [];
    const target = { terminalId: ctx.terminalId };
    const hasSelection = ctx.selection.length > 0;

    // ── Clipboard ──
    groups.push({
      id: "edit",
      items: [
        {
          id: "terminal.copy",
          label: "Copy",
          iconId: "copy",
          command: "terminal.copy",
          // Previously this ran document.execCommand("copy"), which reads the
          // WEBVIEW's DOM selection — always empty over a native pane, so the
          // item silently copied nothing. It now reads the pane-state mirror.
          unavailable: hasSelection ? undefined : { reason: "Nothing is selected" },
          run: (c) => copySelection(c as TerminalCtx),
        },
        {
          id: "terminal.paste",
          label: "Paste",
          iconId: "paste",
          command: "terminal.paste",
          unavailable: ctx.exited ? { reason: "This pane has exited" } : undefined,
          run: (c) => void pasteFromClipboard(c as TerminalCtx),
        },
      ],
    });

    // ── Terminal ──
    const viewItems: MenuItemSpec[] = [
      {
        id: "terminal.find",
        label: "Find in terminal…",
        iconId: "search",
        command: "app.paneSearch",
        run: () => getActivePaneSearchOpener()?.(),
      },
    ];
    // The alternate screen has no scrollback, so there is nothing to scroll to
    // — these can never apply here and are hidden rather than disabled.
    if (!ctx.altScreen) {
      const actions = getTerminalActions(ctx.terminalId);
      const noActions = actions ? undefined : { reason: "This pane is still starting up" };
      viewItems.push(
        {
          id: "terminal.scrollTop",
          label: "Scroll to top",
          iconId: "scroll-top",
          command: "terminal.scrollTop",
          unavailable: noActions,
          run: () => getTerminalActions(ctx.terminalId)?.scrollToTop(),
        },
        {
          id: "terminal.scrollBottom",
          label: "Scroll to bottom",
          iconId: "scroll-bottom",
          command: "terminal.scrollBottom",
          unavailable: noActions,
          run: () => getTerminalActions(ctx.terminalId)?.scrollToBottom(),
        },
      );
    }
    viewItems.push(
      {
        id: "terminal.clear",
        label: "Clear terminal",
        iconId: "clear",
        command: "terminal.clear",
        unavailable: ctx.exited ? { reason: "This pane has exited" } : undefined,
        run: () => runCommand("terminal.clear", target),
      },
      {
        id: "terminal.restart",
        label: "Restart pane",
        iconId: "restart",
        unavailable: getTerminalActions(ctx.terminalId)
          ? undefined
          : { reason: "This pane is still starting up" },
        run: () => getTerminalActions(ctx.terminalId)?.restart(),
      },
    );
    groups.push({ id: "view", items: viewItems });

    // ── Copy context ──
    groups.push({
      id: "target",
      items: [
        {
          id: "terminal.copyCwd",
          label: "Copy working directory",
          iconId: "copy",
          sublabel: ctx.workingDir || undefined,
          unavailable: ctx.workingDir ? undefined : { reason: "This pane has no working directory" },
          run: (c) => {
            const t = c as TerminalCtx;
            if (t.workingDir) navigator.clipboard.writeText(t.workingDir).catch(() => {});
          },
        },
        {
          id: "terminal.copyBranch",
          label: "Copy git branch",
          iconId: "branch",
          // The branch name shows as a sublabel — but ONLY when it is already
          // known as this menu is built. A sublabel is a second line, so one
          // arriving from an async pass would grow the row and resize the menu
          // after it had painted under the pointer. The cache is what makes it
          // known: GitStatusBar publishes into it for the active tab's
          // directory, and the right-button press prewarms anything else.
          sublabel: ctx.gitBranch,
          // undefined => not resolved yet; false => not a repo.
          unavailable:
            ctx.isRepo === false
              ? { reason: "Not a git repository" }
              : ctx.gitBranch
                ? undefined
                : { reason: "Reading branch…" },
          run: (c) => {
            const t = c as TerminalCtx;
            if (t.gitBranch) navigator.clipboard.writeText(t.gitBranch).catch(() => {});
          },
        },
        {
          id: "terminal.openFolder",
          label: "Open folder in Explorer",
          iconId: "folder-open",
          unavailable: ctx.serverId
            ? { reason: "Remote pane — the path is not on this machine" }
            : ctx.workingDir
              ? undefined
              : { reason: "This pane has no working directory" },
          run: (c) => {
            const t = c as TerminalCtx;
            invoke("open_folder", { path: t.workingDir }).catch(() => {});
          },
        },
      ],
    });

    // ── Panes ──
    groups.push({
      id: "layout",
      items: [
        splitItem("right", ctx),
        splitItem("left", ctx),
        splitItem("down", ctx),
        splitItem("up", ctx),
        {
          id: "terminal.close",
          label: "Close pane",
          iconId: "close-pane",
          command: "pane.close",
          danger: true,
          run: () => runCommand("pane.close", target),
        },
      ],
    });

    // ── The inverted right-click rule, taught in place ──
    // Only shown when a TUI actually has mouse reporting on, i.e. exactly when
    // the user might wonder why their right-click no longer reaches the app.
    if (ctx.mouseReporting) {
      groups.push({
        id: "app",
        items: [
          {
            id: "terminal.shiftHint",
            label: "Send right-click to the app",
            shortcut: "Shift+Right-click",
            unavailable: { reason: "Hold Shift while right-clicking to forward the click to the program running here" },
            run: () => {},
          },
        ],
      });
    }

    return groups;
  },
};

registerMenuProvider(terminalProvider as MenuProvider);

/** Pane-level items for non-terminal panes (editor, browser, kanban, review). */
const paneProvider: MenuProvider<"pane"> = {
  id: "pane",
  surface: "pane",
  order: 20,
  build({ ctx, stack }): MenuGroup[] {
    // A terminal already contributed richer pane items; don't duplicate them.
    if (stack.some((c) => c.kind === "terminal")) return [];
    const s = useAppStore.getState();
    return [
      {
        id: "layout",
        items: [
          {
            id: "pane.expand",
            label: ctx.paneMode === "expanded" ? "Restore pane" : "Expand pane",
            iconId: "expand",
            unavailable:
              ctx.paneCount <= 1 && ctx.paneMode !== "expanded"
                ? { reason: "This is the tab's only pane" }
                : undefined,
            run: () =>
              ctx.paneMode === "expanded" ? s.minimizePane(ctx.paneId) : s.expandPane(ctx.paneId),
          },
          {
            id: "pane.popout",
            label: ctx.paneMode === "float" ? "Return to grid" : "Pop out pane",
            iconId: "popout",
            run: () =>
              ctx.paneMode === "float" ? s.minimizePane(ctx.paneId) : s.popoutPane(ctx.paneId),
          },
        ],
      },
    ];
  },
};

registerMenuProvider(paneProvider as MenuProvider);
