import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { useAppStore } from "../store";
import { buildContextMenuSections } from "../lib/context-menu-model";
import {
  emitOverlayPopup,
  listenOverlayAction,
  type OverlayActionMsg,
} from "../lib/overlay-bridge";

const POPUP_ID = "global-context-menu";

/**
 * Global right-click context menu — Phase 1 overlay migration.
 *
 * The menu is now RENDERED by the overlay webview (above the native panes, no
 * hole cut). This component stays in the main webview and owns:
 *   - the `contextmenu` listener (compute position + terminal context),
 *   - the action closures (dispatch window events / call the store) — they can't
 *     cross the emit/listen bridge, so the overlay sends back the chosen
 *     `actionId` and we execute it here,
 *   - F12 / Escape handling.
 * It emits the display model to the overlay via `overlay:popup` and listens for
 * `overlay:action` to run the picked item (or dismiss).
 */
export default function GlobalContextMenu() {
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    isTerminal: boolean;
  } | null>(null);
  // Keep the latest `isTerminal` for the action executor (which runs from an
  // event callback, outside React's render).
  const isTerminalRef = useRef(false);

  // Emit open/close + model to the overlay whenever the menu state changes.
  // Re-emit as a ~750ms keepalive while open: the overlay's ghost-sweep
  // drops any popup whose owner goes silent for 2.5s (bus is fire-and-
  // forget), and this menu doesn't use the keepalive-equipped hooks.
  useEffect(() => {
    if (!menu) {
      emitOverlayPopup({ id: POPUP_ID, kind: "context-menu", open: false, rect: null });
      return;
    }
    isTerminalRef.current = menu.isTerminal;
    const send = () => {
      emitOverlayPopup({
        id: POPUP_ID,
        kind: "context-menu",
        open: true,
        rect: { x: menu.x, y: menu.y, width: 0, height: 0 },
        payload: { sections: buildContextMenuSections(menu.isTerminal) },
      });
    };
    send();
    const iv = setInterval(send, 750);
    return () => clearInterval(iv);
  }, [menu]);

  // Run the action the overlay reports back.
  useEffect(() => {
    let un: UnlistenFn | undefined;
    let disposed = false;
    listenOverlayAction((msg: OverlayActionMsg) => {
      if (msg.id !== POPUP_ID) return;
      runAction(msg.action);
      setMenu(null);
    }).then((u) => {
      if (disposed) u();
      else un = u;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  // Open on right-click (bubble phase; skip if another handler claimed it).
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      e.preventDefault();
      const target = e.target as HTMLElement;
      const isTerminal = !!target.closest?.("[data-terminal-id]");
      setMenu({ x: e.clientX, y: e.clientY, isTerminal });
    };
    window.addEventListener("contextmenu", handler);
    return () => window.removeEventListener("contextmenu", handler);
  }, []);

  // Global F12 → DevTools (capture phase so panes can't swallow it).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "F12" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        e.preventDefault();
        invoke("open_devtools").catch(() => {});
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  // Escape dismisses the open menu.
  useEffect(() => {
    if (!menu) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setMenu(null);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [menu]);

  // This component no longer renders the menu — the overlay does.
  return null;
}

/** actionId -> effect. Must stay in sync with `buildContextMenuSections`. */
function runAction(actionId: string): void {
  switch (actionId) {
    case "__dismiss__":
      break; // just close
    case "copy":
      document.execCommand("copy");
      break;
    case "paste":
      navigator.clipboard
        .readText()
        .then((text) => {
          window.dispatchEvent(
            new CustomEvent("made:paste-text", { detail: { text } }),
          );
        })
        .catch(() => {});
      break;
    case "clear":
      window.dispatchEvent(new Event("made:clear-terminal"));
      break;
    case "split-right":
      window.dispatchEvent(
        new CustomEvent("made:split-terminal", { detail: { type: "shell" } }),
      );
      break;
    case "split-down":
      window.dispatchEvent(
        new CustomEvent("made:split-terminal", {
          detail: { type: "shell", direction: "vertical" },
        }),
      );
      break;
    case "close-pane":
      window.dispatchEvent(new Event("made:close-pane"));
      break;
    case "new-tab":
      window.dispatchEvent(new Event("made:new-tab"));
      break;
    case "palette":
      window.dispatchEvent(new Event("made:open-palette"));
      break;
    case "toggle-sidebar":
      useAppStore.getState().toggleSidebar();
      break;
    case "settings":
      useAppStore.getState().toggleSettingsPanel();
      break;
    case "prompt-search":
      window.dispatchEvent(new Event("made:open-prompt-search"));
      break;
    case "shortcuts":
      window.dispatchEvent(new Event("made:open-shortcuts"));
      break;
    case "devtools":
      invoke("open_devtools").catch(() => {});
      break;
    default:
      break;
  }
}
