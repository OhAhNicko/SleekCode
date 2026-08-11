/**
 * OsToastHost — main-webview driver of the custom OS notification popup (the
 * "toast" window: transparent, always-on-top, ownerless, at the work-area
 * corner).
 *
 * THE one notification surface (user decision 2026-08-11): cards show at the
 * work-area corner whether MADE is focused, unfocused or minimized, and there
 * is no separate in-app stack — the old two-surface model presented the same
 * card twice (OS popup while away, in-app again on return), which read as
 * duplicate notifications. The toast window self-measures and places itself
 * (toast_window_place); this side owns the card feed and the HIDE edge (cards
 * emptying), and routes card clicks back through the shared handler after
 * restoring the main window (a no-op when MADE is already foreground).
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
  const notifEnabled = useAppStore((s) => s.notifEnabled ?? true);
  const popupsEnabled = useAppStore((s) => s.notifOsPopupsEnabled ?? true);

  const show = notifEnabled && popupsEnabled && cards.length > 0;

  useEffect(() => {
    // Breadcrumb next to the toast webview's own lines in the debug log —
    // together they say whether a missing toast died on THIS side (show
    // gate) or inside the popup window (event → measure → place).
    void invoke("debug_log_line", {
      line: `[os-toast] show=${show} cards=${cards.length}`,
    }).catch(() => {});
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
          jiraStatus: c.jiraStatus,
          jiraActor: c.jiraActor,
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
