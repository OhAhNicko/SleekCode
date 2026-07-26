import { useAppStore } from "../../../store";
import { PROJECT_COLOR_PRESETS } from "../../../store/recentProjectsSlice";
import { snapshotTabs, undoClose, useUndoCloseStore } from "../../../store/undoCloseStore";
import { cloneLayoutWithFreshIds } from "../../layout-utils";
import { promptForInput, confirmAction } from "../../prompt-modal";
import { runCommand } from "../../commands";
import { registerMenuProvider } from "../registry";
import type { MenuGroup, MenuProvider } from "../types";

const SYSTEM_FLAGS = ["isDevServerTab", "isServersTab", "isKanbanTab", "isSettingsTab"] as const;

function visibleTabs() {
  return useAppStore
    .getState()
    .tabs.filter((t) => !SYSTEM_FLAGS.some((f) => (t as unknown as Record<string, boolean>)[f]));
}

/** Move a tab one slot among VISIBLE tabs. */
function moveTab(tabId: string, delta: -1 | 1): void {
  const s = useAppStore.getState();
  const vis = visibleTabs();
  const i = vis.findIndex((t) => t.id === tabId);
  if (i === -1) return;
  const j = i + delta;
  if (j < 0 || j >= vis.length) return;
  // reorderTabs inserts BEFORE the given id (null = append), so moving right
  // means inserting before the tab after the target.
  const before = delta === -1 ? vis[j].id : (vis[j + 1]?.id ?? null);
  s.reorderTabs(tabId, before);
}

async function closeMany(ids: string[], title: string): Promise<void> {
  if (ids.length === 0) return;
  const ok = await confirmAction({
    title,
    detail: `${ids.length} tab${ids.length === 1 ? "" : "s"} will be closed. You can undo this.`,
    confirmLabel: "Close",
    danger: true,
  });
  if (!ok) return;
  // ONE snapshot for the whole batch — snapshotTab in a loop overwrites itself.
  snapshotTabs(ids);
  const s = useAppStore.getState();
  const before = useUndoCloseStore.getState().lastClosed;
  for (const id of ids) s.removeTab(id);
  // removeTab snapshots each tab individually, clobbering the batch snapshot;
  // put it back so Undo restores all of them.
  if (before) useUndoCloseStore.getState().setLastClosed(before);
}

const tabProvider: MenuProvider<"tab"> = {
  id: "tab",
  surface: "tab",
  order: 10,
  build({ ctx }): MenuGroup[] {
    // System tabs (dev servers, servers, tasks, settings) can't be closed,
    // renamed, coloured or saved — removeTab hard-returns for them. A menu of
    // rows that all silently no-op is worse than no menu.
    if (ctx.isSystemTab) return [];

    const vis = visibleTabs();
    const others = vis.filter((t) => t.id !== ctx.tabId && !t.isPinned).map((t) => t.id);
    const toRight = vis
      .slice(ctx.visibleIndex + 1)
      .filter((t) => !t.isPinned)
      .map((t) => t.id);
    const canUndo = !!useUndoCloseStore.getState().lastClosed;
    // projectColors is keyed by the working dir with separators normalised to
    // forward slashes — the same normalisation TabBar applied.
    const colorKey = ctx.workingDir.replace(/\\/g, "/");
    const currentColor = useAppStore.getState().projectColors?.[colorKey] ?? null;

    return [
      {
        id: "target",
        items: [
          {
            id: "tab.copyTitle",
            label: "Copy tab title",
            iconId: "copy",
            run: () => {
              const t = useAppStore.getState().tabs.find((x) => x.id === ctx.tabId);
              if (t) navigator.clipboard.writeText(t.customName ?? t.name).catch(() => {});
            },
          },
          {
            id: "tab.copyPath",
            label: "Copy project path",
            iconId: "copy",
            sublabel: ctx.workingDir || undefined,
            unavailable: ctx.workingDir ? undefined : { reason: "This tab has no folder" },
            run: () => navigator.clipboard.writeText(ctx.workingDir).catch(() => {}),
          },
        ],
      },
      {
        id: "edit",
        items: [
          {
            id: "tab.rename",
            label: "Rename tab…",
            iconId: "rename",
            run: async () => {
              const t = useAppStore.getState().tabs.find((x) => x.id === ctx.tabId);
              const name = await promptForInput({
                title: "Rename tab",
                label: "Tab name",
                initialValue: t?.customName ?? t?.name ?? "",
                confirmLabel: "Rename",
              });
              if (name) useAppStore.getState().renameTab(ctx.tabId, name);
            },
          },
          {
            id: "tab.moveLeft",
            label: "Move tab left",
            iconId: "arrow-left",
            unavailable: ctx.visibleIndex <= 0 ? { reason: "Already the first tab" } : undefined,
            run: () => moveTab(ctx.tabId, -1),
          },
          {
            id: "tab.moveRight",
            label: "Move tab right",
            iconId: "arrow-right",
            unavailable:
              ctx.visibleIndex >= ctx.visibleCount - 1 ? { reason: "Already the last tab" } : undefined,
            run: () => moveTab(ctx.tabId, 1),
          },
          {
            id: "tab.duplicate",
            label: "Duplicate tab",
            iconId: "duplicate",
            unavailable: ctx.hasLayout ? undefined : { reason: "Empty tab — nothing to duplicate" },
            run: () => {
              const s = useAppStore.getState();
              const t = s.tabs.find((x) => x.id === ctx.tabId);
              if (!t?.layout) return;
              // Fresh pane/terminal ids, or both tabs would drive one PTY.
              s.addTabWithLayout(
                `${t.customName ?? t.name} copy`,
                t.workingDir,
                cloneLayoutWithFreshIds(t.layout).layout,
                t.serverId,
              );
            },
          },
          {
            id: "tab.pin",
            label: ctx.isPinned ? "Unpin tab" : "Pin tab",
            iconId: "pin",
            run: () => useAppStore.getState().togglePinTab(ctx.tabId),
          },
        ],
      },
      {
        id: "pane",
        items: [
          {
            id: "tab.close",
            label: "Close tab",
            iconId: "close-pane",
            command: "tab.close",
            danger: true,
            // removeTab silently returns for pinned tabs — say so instead of
            // firing an action that does nothing.
            unavailable: ctx.isPinned ? { reason: "Tab is pinned — unpin it first" } : undefined,
            run: () => runCommand("tab.close", { tabId: ctx.tabId }),
          },
          {
            id: "tab.closeOthers",
            label: "Close other tabs",
            iconId: "close-pane",
            danger: true,
            unavailable: others.length === 0 ? { reason: "No other closable tabs" } : undefined,
            run: () => void closeMany(others, "Close other tabs?"),
          },
          {
            id: "tab.closeRight",
            label: "Close tabs to the right",
            iconId: "close-pane",
            danger: true,
            unavailable: toRight.length === 0 ? { reason: "No tabs to the right" } : undefined,
            run: () => void closeMany(toRight, "Close tabs to the right?"),
          },
          {
            id: "tab.reopen",
            label: "Reopen closed tab",
            iconId: "duplicate",
            unavailable: canUndo ? undefined : { reason: "Nothing to reopen" },
            run: () => undoClose(),
          },
        ],
      },
      {
        id: "layout",
        items: [
          {
            id: "tab.saveConfig",
            label: "Save as new config…",
            iconId: "save-config",
            unavailable: ctx.hasLayout ? undefined : { reason: "Empty tab — nothing to save" },
            run: async () => {
              const t = useAppStore.getState().tabs.find((x) => x.id === ctx.tabId);
              const name = await promptForInput({
                title: "Save layout as config",
                label: "Config name",
                initialValue: t?.customName ?? t?.name ?? "",
                confirmLabel: "Save",
              });
              if (name) useAppStore.getState().saveLaunchConfig(name, ctx.tabId);
            },
          },
        ],
      },
      {
        id: "view",
        // Keyed by working DIR, not tab id — two tabs on one project always
        // share a colour. Saying "PROJECT COLOR" makes that a stated rule
        // rather than a bug report waiting to happen.
        title: "Project color",
        items: [],
        swatches: [
          {
            id: "tab.color.none",
            color: null,
            label: "No color",
            selected: currentColor == null,
            run: () => useAppStore.getState().setProjectColor(colorKey, null),
          },
          ...PROJECT_COLOR_PRESETS.map((p) => ({
            id: `tab.color.${p.id}`,
            color: p.color,
            label: p.label,
            selected: currentColor === p.id,
            run: () => useAppStore.getState().setProjectColor(colorKey, p.id),
          })),
        ],
      },
    ];
  },
};

registerMenuProvider(tabProvider as MenuProvider);

const tabstripProvider: MenuProvider<"tabstrip"> = {
  id: "tabstrip",
  surface: "tabstrip",
  order: 10,
  build(): MenuGroup[] {
    const canUndo = !!useUndoCloseStore.getState().lastClosed;
    return [
      {
        id: "target",
        items: [
          {
            id: "tabstrip.newTab",
            label: "New tab",
            iconId: "new-tab",
            command: "tab.new",
            run: () => runCommand("tab.new"),
          },
          {
            id: "tabstrip.reopen",
            label: "Reopen closed tab",
            iconId: "duplicate",
            unavailable: canUndo ? undefined : { reason: "Nothing to reopen" },
            run: () => undoClose(),
          },
        ],
      },
    ];
  },
};

registerMenuProvider(tabstripProvider as MenuProvider);
