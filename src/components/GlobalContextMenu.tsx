import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  emitOverlayPopup,
  listenOverlayAction,
  type OverlayActionMsg,
} from "../lib/overlay-bridge";
import { useAppStore } from "../store";
import { warmBranch } from "../lib/git-branch-cache";
import { resolveMenuContext, type MenuContext } from "../lib/menu/context";
import { buildMenu } from "../lib/menu/registry";
import type { BuiltMenu } from "../lib/menu/types";
// Providers self-register on import. Adding a surface = adding a file here.
import "../lib/menu/providers/app";
import "../lib/menu/providers/terminal";
import "../lib/menu/providers/file";
import "../lib/menu/providers/tab";
import "../lib/menu/providers/input";
import "../lib/menu/providers/rows";
import { useDismissOnOutsidePointer } from "../lib/overlay-dismiss";

const POPUP_ID = "made:menu";

/**
 * Host for the app's context menus.
 *
 * The menu is RENDERED by the overlay webview (above the native panes, no hole
 * cut). This component stays in the main webview and owns the `contextmenu`
 * listener, the context resolution, and the action closures — closures can't
 * cross the emit/listen bridge, so the overlay sends back the chosen `actionId`
 * and we execute it here.
 *
 * What changed: this used to compute `{ x, y, isTerminal }` and hand a
 * hardcoded 13-item list to the overlay, which is why right-clicking a file in
 * the sidebar offered "Toggle Sidebar / Settings / Open DevTools". Now it
 * resolves a typed context STACK from the event target and asks the registered
 * providers what applies. Items that can never apply are never built; items
 * that belong here but aren't available right now come back disabled with a
 * reason.
 */
export default function GlobalContextMenu() {
  const [built, setBuilt] = useState<BuiltMenu | null>(null);
  // The executor runs from an event callback, outside React's render.
  const builtRef = useRef<BuiltMenu | null>(null);
  builtRef.current = built;

  const close = useCallback(() => setBuilt(null), []);

  // Outside-click dismissal. This component emits its popup DIRECTLY instead of
  // going through useOverlayMenu, so it has to subscribe itself — the overlay's
  // full-screen backdrop used to do this job and no longer exists
  // (src/lib/overlay-dismiss.ts).
  useDismissOnOutsidePointer(built !== null, close);

  /** Cursor point the menu is anchored to, captured at right-click time. */
  const anchorRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Emit open/close + model to the overlay. Re-emit as a ~750ms keepalive
  // while open: the overlay's ghost-sweep drops any popup whose owner goes
  // silent for 2.5s (the bus is fire-and-forget).
  useEffect(() => {
    if (!built) {
      emitOverlayPopup({ id: POPUP_ID, kind: "anchored-menu", open: false, rect: null });
      return;
    }
    const rect = { x: anchorRef.current.x, y: anchorRef.current.y, width: 0, height: 0 };
    const send = () => {
      emitOverlayPopup({
        id: POPUP_ID,
        kind: "anchored-menu",
        open: true,
        rect,
        payload: built.payload,
      });
    };
    send();
    const iv = setInterval(send, 750);
    return () => clearInterval(iv);
  }, [built]);

  // Run whatever the overlay reports back.
  useEffect(() => {
    let un: UnlistenFn | undefined;
    let disposed = false;
    listenOverlayAction((msg: OverlayActionMsg) => {
      if (msg.id !== POPUP_ID) return;
      const current = builtRef.current;
      if (msg.action !== "__dismiss__" && current) {
        const run = current.runners.get(msg.action);
        const ctx = current.contexts.get(msg.action);
        if (run && ctx) {
          try {
            run(ctx, msg.data as { ctrl: boolean } | undefined);
          } catch (err) {
            if (import.meta.env.DEV) console.error(`[menu] action "${msg.action}" threw`, err);
          }
        }
      }
      setBuilt(null);
    }).then((u) => {
      if (disposed) u();
      else un = u;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  /**
   * Warm the git cache for NEXT time — deliberately without touching the open
   * menu.
   *
   * An earlier version patched the live popup once git answered. That is
   * exactly what made the menu resize half a second after opening: the branch
   * name arrived as a sublabel, which is a second line, so the row and the
   * whole menu grew under the user's pointer.
   *
   * So the rule is now simply: whatever the menu knows when it opens is what it
   * shows, for as long as it is open. The cache is what makes "what it knows"
   * almost always complete — GitStatusBar publishes the active tab's branch on
   * every fetch, and the right-button press prewarms any other directory. This
   * only runs in the rare cold case, and its benefit lands on the next
   * right-click.
   */
  const enrich = useCallback(async (stack: MenuContext[]) => {
    const term = stack.find((c): c is Extract<MenuContext, { kind: "terminal" }> => c.kind === "terminal");
    if (!term?.workingDir) return;
    if (term.isRepo !== undefined) return; // already known — nothing to do
    await warmBranch(term.workingDir, term.serverId);
  }, []);

  // Open on right-click.
  //
  // Bubble phase, and still bails on `defaultPrevented`, so any surface that
  // has not been migrated to a provider yet keeps its own bespoke menu. Moving
  // this to capture phase would break every one of them at once.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      e.preventDefault();
      const stack: MenuContext[] = resolveMenuContext(e);
      anchorRef.current = { x: e.clientX, y: e.clientY };
      const next = buildMenu(stack, "sync", { width: 240 });
      // A stack with nothing to offer should open nothing at all rather than
      // an empty panel.
      if (next.payload.sections.length === 0) {
        setBuilt(null);
        return;
      }
      setBuilt(next);
      void enrich(stack);
    };
    // Prewarm on right-button PRESS. Chromium fires `contextmenu` on button-UP,
    // so this buys ~120-250ms — enough for the git lookup to land before the
    // menu is built, which is what keeps it from resizing after it opens.
    // (Native panes swallow the press in their HWND, so their first right-click
    // in a directory still resolves via the enrichment pass.)
    const prewarm = (e: MouseEvent) => {
      if (e.button !== 2) return;
      const el = (e.target as HTMLElement | null)?.closest?.("[data-terminal-id]") as HTMLElement | null;
      const id = el?.dataset?.terminalId;
      if (!id) return;
      const term = useAppStore.getState().terminals[id];
      const dir = term?.workingDir;
      if (dir) void warmBranch(dir, term?.serverId);
    };

    window.addEventListener("pointerdown", prewarm, true);
    window.addEventListener("contextmenu", handler);
    return () => {
      window.removeEventListener("pointerdown", prewarm, true);
      window.removeEventListener("contextmenu", handler);
    };
  }, [enrich]);

  // Keep the git cache warm for whichever pane is focused.
  //
  // This is what makes "Copy git branch" show the branch the instant the menu
  // opens. The right-button prewarm alone is not enough for NATIVE panes: their
  // child HWND swallows the press, so JS never sees a pointerdown there. Pane
  // focus is a signal both renderers do produce, and it fires long before any
  // right-click. `warmBranch` dedups in-flight calls and caches for 30s, so
  // this costs at most one git process per directory per half-minute.
  useEffect(() => {
    let lastDir: string | undefined;
    const warmActive = () => {
      const s = useAppStore.getState();
      const active = Object.values(s.terminals).find((t) => t.isActive);
      const dir = active?.workingDir || s.tabs.find((t) => t.id === s.activeTabId)?.workingDir;
      // The subscription fires on every store write; only act when the
      // directory actually changed.
      if (!dir || dir === lastDir) return;
      lastDir = dir;
      void warmBranch(dir, active?.serverId);
    };
    warmActive();
    return useAppStore.subscribe(warmActive);
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

  // Escape dismisses. Handled here in MAIN, because the overlay window is
  // WS_EX_NOACTIVATE and never receives keystrokes.
  useEffect(() => {
    if (!built) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [built, close]);

  // The overlay renders the menu; nothing to paint here.
  return null;
}
