// Single click contract for dev-server URLs, shared by every surface that
// offers one (sidebar row, pane-header icon, project-tab icon):
//
//   plain click        -> external (OS default) browser
//   Ctrl/Cmd + click   -> MADE browser pane, linked to the tab so it live-
//                         tracks the dev server URL and its waiting state
//
// This matches how links inside terminals behave. Keep all callers on this
// helper so the mapping can never drift apart per surface again.

import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../store";
import { openOrUpdateBrowserPane } from "./layout-utils";
import type { DevServer } from "../types";

export function devServerUrl(server: DevServer): string | null {
  return server.port > 0 ? `http://localhost:${server.port}` : null;
}

/** True when the mouse event asks for the in-app MADE browser pane. */
export function wantsInAppOpen(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return e.ctrlKey || e.metaKey;
}

export function openDevServerUrl(server: DevServer, opts: { inApp: boolean }): void {
  const url = devServerUrl(server);
  if (!url) return;
  openDevServerUrlIn(server, url, opts);
}

/** URL variant for surfaces that also offer non-localhost addresses
 * (LAN/Tailscale rows in the sidebar's address card). Same click contract. */
export function openDevServerUrlIn(
  server: DevServer,
  url: string,
  opts: { inApp: boolean },
): void {
  if (!opts.inApp) {
    void openUrl(url).catch(() => {});
    return;
  }

  const store = useAppStore.getState();
  // Servers added by hand in the panel have tabId "" — those fall back to the
  // active tab, same as the sidebar always did.
  const targetTabId =
    store.previewInProjectTab && server.tabId ? server.tabId : store.activeTabId;
  if (!targetTabId) return;
  const tab = store.tabs.find((t) => t.id === targetTabId);
  if (!tab || !tab.layout) return;

  // linkedTabId keeps the one-pane-per-tab invariant AND the live URL binding
  // (BrowserPreview swaps in the current dev-server URL once running).
  const { layout } = openOrUpdateBrowserPane(tab.layout, url, {
    linkedTabId: targetTabId,
    sizePercent: 35,
    fullColumn: store.browserFullColumn,
    spawnLeft: store.browserSpawnLeft,
    wideGridLayout: store.wideGridLayout,
  });
  store.updateTabLayout(targetTabId, layout);
  store.setActiveTab(targetTabId);
}
