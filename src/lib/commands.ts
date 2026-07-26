import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { getActivePaneSearchOpener } from "./pane-search-registry";
import type { CommandId } from "./keybindings";

/**
 * The executable half of the keybinding table.
 *
 * Bodies are the statements that live in App.tsx's keydown switch today — the
 * same `made:*` dispatches — so menus and keystrokes provably do the same
 * thing. App.tsx is not rewired yet (that migration is staged separately);
 * this is what context menus call.
 *
 * `target` lets a caller name the pane/tab the action applies to. The keyboard
 * path omits it and keeps acting on whatever is focused; a context menu always
 * supplies it, because the pane you right-clicked is frequently not the pane
 * that has focus.
 */
export type CommandTarget = { terminalId?: string; tabId?: string };

export function runCommand(command: CommandId, target?: CommandTarget): void {
  const detail = target?.terminalId ? { terminalId: target.terminalId } : undefined;
  const store = useAppStore.getState();

  switch (command) {
    // ── App surfaces ──
    case "app.palette":
      window.dispatchEvent(new Event("made:open-palette"));
      return;
    case "app.toggleSidebar":
      store.toggleSidebar();
      return;
    case "app.settings":
      if (!useAppStore.getState().settingsPanelOpen) {
        useAppStore.setState({ sidebarOpen: false, devServerPanelOpen: false });
      }
      useAppStore.getState().toggleSettingsPanel();
      return;
    case "app.shortcuts":
      window.dispatchEvent(new Event("made:open-shortcuts"));
      return;
    case "app.promptSearch":
      window.dispatchEvent(new Event("made:open-prompt-search"));
      return;
    case "app.codeReview":
      window.dispatchEvent(new Event("made:open-codereview"));
      return;
    case "app.fileExplorer": {
      const s = useAppStore.getState();
      if (s.sidebarOpen && s.sidebarTab === "files") s.toggleSidebar();
      else {
        s.setSidebarTab("files");
        if (!s.sidebarOpen) s.toggleSidebar();
      }
      return;
    }
    case "app.devtools":
      invoke("open_devtools").catch(() => {});
      return;
    case "app.paneSearch":
      // No event for this one — panes register their opener directly.
      getActivePaneSearchOpener()?.();
      return;

    // ── Tabs ──
    case "tab.new":
      window.dispatchEvent(new Event("made:new-tab"));
      return;
    case "tab.close": {
      const id = target?.tabId ?? useAppStore.getState().activeTabId;
      if (id) useAppStore.getState().removeTab(id);
      return;
    }

    // ── Panes ──
    case "pane.splitRight":
      window.dispatchEvent(
        new CustomEvent("made:split-terminal", {
          detail: { type: "shell", direction: "right", targetTerminalId: target?.terminalId },
        }),
      );
      return;
    case "pane.splitDown":
      window.dispatchEvent(
        new CustomEvent("made:split-terminal", {
          detail: { type: "shell", direction: "down", targetTerminalId: target?.terminalId },
        }),
      );
      return;
    case "pane.close":
      window.dispatchEvent(new CustomEvent("made:close-pane", { detail }));
      return;
    case "pane.focusNext":
      window.dispatchEvent(new Event("made:focus-next-pane"));
      return;
    case "pane.focusPrev":
      window.dispatchEvent(new Event("made:focus-prev-pane"));
      return;

    // ── Terminal ──
    case "terminal.clear":
      window.dispatchEvent(new CustomEvent("made:clear-terminal", { detail }));
      return;
    case "terminal.zoomIn":
      window.dispatchEvent(new CustomEvent("made:font-zoom", { detail: { delta: 1 } }));
      return;
    case "terminal.zoomOut":
      window.dispatchEvent(new CustomEvent("made:font-zoom", { detail: { delta: -1 } }));
      return;
    case "terminal.zoomReset":
      window.dispatchEvent(new CustomEvent("made:font-zoom", { detail: { reset: true } }));
      return;

    default:
      // Pane- and composer-owned commands have no central implementation by
      // design; the table marks them `ownedBy` so menus display but never
      // invoke them.
      if (import.meta.env.DEV) console.warn(`[commands] no central runner for "${command}"`);
  }
}
