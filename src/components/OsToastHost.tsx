/**
 * OsToastHost — main-webview driver of the custom OS notification popup (the
 * "toast" window: opaque, always-on-top, ownerless, at the work-area corner).
 *
 * Shows the SAME cards as the in-app stack, exactly when that stack is
 * invisible: main window minimized OR the app unfocused. The toast window
 * self-measures and places itself (toast_window_place); this side owns the
 * card feed and the HIDE edge, and routes card clicks back through the shared
 * handler after restoring the main window (the click is the user asking to
 * come back).
 *
 * A card click must never be lost to a race: restore-then-act, both
 * fire-and-forget — handleNotifCardAction reads live store state, which is
 * valid regardless of the window's restore progress.
 */

import { useEffect } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { usePaneNotificationsStore } from "../store/paneNotificationsStore";
import { handleNotifCardAction } from "../lib/notif-actions";

export default function OsToastHost() {
  const cards = usePaneNotificationsStore((s) => s.cards);
  const windowMinimized = useAppStore((s) => s.windowMinimized);
  const appWindowFocused = useAppStore((s) => s.appWindowFocused);
  const notifEnabled = useAppStore((s) => s.notifEnabled ?? true);
  const popupsEnabled = useAppStore((s) => s.notifOsPopupsEnabled ?? true);

  const show =
    notifEnabled &&
    popupsEnabled &&
    cards.length > 0 &&
    (windowMinimized || !appWindowFocused);

  useEffect(() => {
    if (show) {
      // The toast window measures the rendered column and places itself —
      // sending the cards IS the show command.
      void emitTo("toast", "made:os-toast-cards", {
        cards: cards.map((c) => ({
          id: c.id,
          projectName: c.projectName,
          paneLabel: c.paneLabel ?? "",
          timeHHMM: c.timeHHMM,
          body: c.body,
          kind: c.kind,
          hasAction: !!c.clickAction,
        })),
      });
    } else {
      void invoke("toast_window_hide").catch(() => {});
      // Clear the toast's card state too, so a stale column can never flash
      // on the next show before the fresh payload lands.
      void emitTo("toast", "made:os-toast-cards", { cards: [] });
    }
  }, [show, cards]);

  useEffect(() => {
    let un: (() => void) | undefined;
    let disposed = false;
    listen<{ action: string }>("made:os-toast-action", (e) => {
      const action = e.payload.action;
      const verb = action.slice(0, Math.max(0, action.indexOf(":")));
      if (verb === "focus" || verb === "open") {
        // Acting on a card = come back to MADE. Restore/foreground FIRST so
        // the tab/pane switch the handler performs lands on a visible window.
        void invoke("main_window_restore_focus").catch(() => {});
      }
      handleNotifCardAction(action);
    }).then((u) => {
      if (disposed) u();
      else un = u;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  return null;
}
