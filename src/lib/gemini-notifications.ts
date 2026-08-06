/**
 * One-time silent seed of Gemini's desktop notifications (user decision
 * 2026-08-06). Gemini ships `general.enableNotifications` OFF; Claude and
 * Codex notify out of the box, so a Gemini pane staying silent reads as a MADE
 * bug. When the key is ABSENT the user never chose anything and MADE turns it
 * on; an explicit Gemini-side `false` is a real choice and is never
 * overridden — the Settings row (Settings > Terminal > Notifications >
 * "Gemini notifications") surfaces it as disabled with click-to-enable
 * instead.
 *
 * Called from every Gemini pane mount; the persisted `geminiNotifSeeded` flag
 * plus a session guard make it effectively once-ever.
 */

import { useAppStore } from "../store";
import { getGeminiNotifications, setGeminiNotifications } from "./sessions-index";
import type { TerminalBackend } from "../types";

let attemptedThisSession = false;

export function ensureGeminiNotificationsSeeded(backend: TerminalBackend | undefined): void {
  const b = backend ?? "wsl";
  // No remote config edit over SSH, and a serverId pane is always ssh-backed.
  if (b === "ssh") return;
  if (attemptedThisSession) return;
  attemptedThisSession = true;
  const s = useAppStore.getState();
  if (s.geminiNotifSeeded) return;
  void (async () => {
    try {
      const cur = await getGeminiNotifications(b);
      if (cur === null) await setGeminiNotifications(true, b);
      // Explicit true/false both mean the choice exists — seeding is done
      // either way; only the absent key got written above.
      useAppStore.getState().setGeminiNotifSeeded(true);
    } catch {
      // Unreadable or foreign settings.json — leave it alone entirely and
      // retry next session (the flag is deliberately NOT set on failure).
      attemptedThisSession = true;
    }
  })();
}
