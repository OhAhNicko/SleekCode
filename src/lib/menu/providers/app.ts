import { runCommand } from "../../commands";
import { registerMenuProvider } from "../registry";
import type { MenuGroup, MenuProvider } from "../types";

/**
 * App-wide fallback items — the tail of every menu.
 *
 * `order: 1000` and the app context always sitting last in the stack put these
 * at the bottom, under whatever the clicked surface contributed.
 *
 * Copy/Paste deliberately do NOT live here. They used to: the old menu offered
 * them on every right-click, including over a file tree row and empty chrome
 * where `document.execCommand("copy")` had nothing to act on. They belong to
 * the surfaces that can actually perform them — the terminal and text inputs.
 */
const appProvider: MenuProvider<"app"> = {
  id: "app",
  surface: "app",
  order: 1000,
  build({ ctx }): MenuGroup[] {
    return [
      {
        id: "app",
        items: [
          {
            id: "app.newTab",
            label: "New tab",
            iconId: "new-tab",
            command: "tab.new",
            run: () => runCommand("tab.new"),
          },
          {
            id: "app.palette",
            label: "Command palette",
            iconId: "palette",
            command: "app.palette",
            run: () => runCommand("app.palette"),
          },
          {
            id: "app.toggleSidebar",
            label: ctx.sidebarOpen ? "Hide file sidebar" : "Show file sidebar",
            iconId: "sidebar",
            command: "app.toggleSidebar",
            run: () => runCommand("app.toggleSidebar"),
          },
          {
            id: "app.settings",
            label: "Settings",
            iconId: "settings",
            command: "app.settings",
            run: () => runCommand("app.settings"),
          },
        ],
      },
      {
        id: "view",
        items: [
          {
            id: "app.promptSearch",
            label: "Search prompt history",
            iconId: "search",
            command: "app.promptSearch",
            // Prompt history is per-terminal; with no terminal open there is
            // nothing to search, and the panel would open empty.
            unavailable: ctx.hasTerminal ? undefined : { reason: "No terminals open yet" },
            run: () => runCommand("app.promptSearch"),
          },
          {
            id: "app.shortcuts",
            label: "Keyboard shortcuts",
            iconId: "keyboard",
            command: "app.shortcuts",
            run: () => runCommand("app.shortcuts"),
          },
          {
            id: "app.devtools",
            label: "Open DevTools",
            iconId: "devtools",
            command: "app.devtools",
            run: () => runCommand("app.devtools"),
          },
        ],
      },
    ];
  },
};

registerMenuProvider(appProvider as MenuProvider);
