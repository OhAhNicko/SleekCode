import type { AppStore } from "../../store";
import type { PaneLayout } from "../../types";
import { THEMES } from "../themes";
import { WRITABLE_SETTINGS } from "./tools";

/**
 * Build a small JSON snapshot the LLM can use to resolve references like
 * "the browser pane" or "the leftmost terminal" — and to know which
 * settings, themes, and tabs exist right now.
 *
 * Keep this small: it's prepended to the user prompt on every utterance.
 */
export interface PaneSnapshot {
  id: string;
  type: PaneLayout["type"];
  /** Terminal pane: which CLI; browser pane: hostname; etc. */
  detail?: string;
}

export interface AppContextSnapshot {
  active_tab: { id: string; name: string } | null;
  tabs: { id: string; name: string; index: number }[];
  panes_in_active_tab: PaneSnapshot[];
  available_themes: { id: string; name: string }[];
  current_theme_id: string;
  writable_settings: { key: string; type: string; current_value: unknown }[];
  sidebar_open: boolean;
  language_hint: "auto" | "en" | "sv";
}

function flatten(layout: PaneLayout | null): PaneSnapshot[] {
  if (!layout) return [];
  switch (layout.type) {
    case "split":
      return [...flatten(layout.children[0]), ...flatten(layout.children[1])];
    case "terminal":
      return [{ id: layout.id, type: "terminal", detail: layout.terminalType ?? "shell" }];
    case "browser": {
      let host = "";
      try { host = new URL(layout.url).hostname; } catch { host = layout.url; }
      return [{ id: layout.id, type: "browser", detail: host }];
    }
    case "editor":
      return [{ id: layout.id, type: "editor", detail: layout.filePath.split(/[\\/]/).pop() }];
    case "kanban":
      return [{ id: layout.id, type: "kanban" }];
    case "codereview":
      return [{ id: layout.id, type: "codereview" }];
    case "fileviewer":
      return [{ id: layout.id, type: "fileviewer", detail: layout.activeFile.split(/[\\/]/).pop() }];
    case "game":
      return [{ id: layout.id, type: "game", detail: layout.game }];
  }
}

export function buildContextSnapshot(store: AppStore): AppContextSnapshot {
  const activeTab = store.tabs.find((t) => t.id === store.activeTabId) ?? null;
  const tabs = store.tabs
    .filter((t) => !t.isDevServerTab && !t.isServersTab && !t.isKanbanTab && !t.isSettingsTab)
    .map((t, i) => ({ id: t.id, name: t.name, index: i + 1 }));

  const writable = Object.entries(WRITABLE_SETTINGS).map(([key, type]) => ({
    key,
    type,
    current_value: (store as unknown as Record<string, unknown>)[key],
  }));

  return {
    active_tab: activeTab ? { id: activeTab.id, name: activeTab.name } : null,
    tabs,
    panes_in_active_tab: flatten(activeTab?.layout ?? null),
    available_themes: THEMES.map((t) => ({ id: t.id, name: t.name })),
    current_theme_id: store.themeId,
    writable_settings: writable,
    sidebar_open: store.sidebarOpen,
    language_hint: store.voiceLanguage,
  };
}
