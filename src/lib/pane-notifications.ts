/**
 * Central pane-notification pipeline. Both producers feed this:
 *   - native panes: Rust OscNotifyScanner → subscribeNotify → PaneNotification
 *   - xterm panes:  xterm.js parser.registerOscHandler(9/99/777) → parseNotifyOsc
 *
 * `addPaneNotification` owns everything the per-pane toast used to do wrong:
 * suppression is computed from the STORE (where `terminals[id].isActive` is
 * globally unique) instead of per-pane props — App.tsx mounts a Workspace per
 * project tab, so N tabs have N panes with `isActive === true` and a pane-side
 * check silently swallowed background tabs' notifications.
 */

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { useAppStore } from "../store";
import { usePaneNotificationsStore } from "../store/paneNotificationsStore";
import { projectDisplayName } from "../store/recentProjectsSlice";
import { findAllTerminalLeaves } from "./layout-utils";
import { ensureProjectSound, playNotificationSound } from "./notification-sounds";
import { toWslPath } from "./terminal-config";
import { readSessionLastAssistantText } from "./sessions-index";
import type { TerminalBackend, TerminalType } from "../types";

/** Parity with the Rust scanner's NOTIFY_PAYLOAD_CAP. */
const PAYLOAD_CAP = 2048;

/**
 * Interpret an OSC 9 / 99 / 777 payload as a desktop notification. Pure port
 * of the Rust `finish_notify` (parser_bridge.rs) so the two renderers cannot
 * drift. `data` is the payload AFTER the numeric identifier — exactly what
 * xterm.js hands a registerOscHandler callback.
 */
export function parseNotifyOsc(
  osc: 9 | 99 | 777,
  data: string,
): { title: string; body: string } | null {
  const text = data.slice(0, PAYLOAD_CAP);
  switch (osc) {
    case 9: {
      // ConEmu progress is OSC 9;4;<state>;<pct> — a progress report, not a
      // notification. The native pane's progress bar consumes these; here we
      // only need to NOT toast them.
      if (text.startsWith("4;")) return null;
      const body = text.trim();
      if (!body) return null;
      return { title: "", body };
    }
    // urxvt/Ghostty: 777;notify;<title>;<body>
    case 777: {
      if (!text.startsWith("notify;")) return null;
      const rest = text.slice("notify;".length);
      const sep = rest.indexOf(";");
      const title = sep === -1 ? "" : rest.slice(0, sep).trim();
      const body = (sep === -1 ? rest : rest.slice(sep + 1)).trim();
      if (!title && !body) return null;
      return { title, body };
    }
    // Kitty: 99;<metadata>;<payload>. Only the single-chunk plain-text form is
    // handled; chunked/encoded variants are ignored rather than half-decoded.
    case 99: {
      const sep = text.indexOf(";");
      if (sep === -1) return null;
      const body = text.slice(sep + 1).trim();
      if (!body) return null;
      return { title: "", body };
    }
  }
}

export interface PaneNotificationSource {
  terminalId: string;
  terminalType: TerminalType;
  title: string;
  body: string;
  paneLabel?: string;
  workingDir: string;
  backend?: TerminalBackend;
  serverId?: string;
  sessionResumeId?: string;
}

/** How long to wait before the single snippet retry — end-of-turn transcript
 * appends land within seconds; one bounded retry, never an mtime-vs-now
 * comparison (WSL↔Windows clock skew). */
const SNIPPET_RETRY_MS = 1000;

/** Cached OS-notification permission — asked at most once per session.
 * Desktop Windows grants this without a prompt; the dance is for API parity. */
let osNotifGranted: boolean | null = null;

export async function sendOsToast(title: string, body: string): Promise<void> {
  try {
    if (osNotifGranted === null) {
      osNotifGranted = await isPermissionGranted();
      if (!osNotifGranted) {
        osNotifGranted = (await requestPermission()) === "granted";
      }
    }
    if (!osNotifGranted) {
      console.debug("[pane-notif] OS notification permission not granted");
      return;
    }
    sendNotification({ title, body, silent: true });
  } catch (e) {
    console.debug("[pane-notif] OS toast failed", e);
  }
}

function isSuppressed(terminalId: string, tabId: string): boolean {
  const s = useAppStore.getState();
  // The active pane of the active tab is already on screen — announcing it is
  // noise. Unless the window is minimized OR the app is unfocused: then the
  // user isn't looking at it, the card must exist (it is what the custom OS
  // popup window shows), and it survives for their return.
  return (
    s.terminals[terminalId]?.isActive === true &&
    tabId === s.activeTabId &&
    !s.windowMinimized &&
    s.appWindowFocused
  );
}

/**
 * Ingest one CLI notification. Resolves the body (transcript snippet for
 * finished turns, OSC status text otherwise) BEFORE creating the card, so
 * cards never change size on screen.
 */
export async function addPaneNotification(src: PaneNotificationSource): Promise<void> {
  // Master switch (Settings > Terminal > Notifications). `?? true` because the
  // field is new — an older persisted store simply has no value yet.
  if (!(useAppStore.getState().notifEnabled ?? true)) return;
  const body = src.body.trim();
  if (!body) return;

  // Stamp receipt time before any async work — the card shows when the pane
  // finished, not when the transcript read completed.
  const now = new Date();
  const timeHHMM = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  const state = useAppStore.getState();
  const tab = state.tabs.find(
    (t) =>
      t.layout &&
      findAllTerminalLeaves(t.layout).some((l) => l.terminalId === src.terminalId),
  );
  if (!tab) return;

  if (isSuppressed(src.terminalId, tab.id)) return;

  // Permission prompts carry their meaning in the OSC text itself ("Claude
  // needs your permission to use Bash") — there is no reply to snippet yet.
  const kind: "permission" | "finished" = /permission/i.test(body)
    ? "permission"
    : "finished";

  let displayBody = body;
  if (
    kind === "finished" &&
    src.terminalType === "claude" &&
    src.sessionResumeId &&
    src.backend !== "ssh" &&
    !src.serverId
  ) {
    // wsl is the default backend; Claude's project key is built from the Unix
    // path, so the Windows workingDir must be converted first (the
    // TerminalHeader idiom — TuiScrollbar's raw-path call is a known bug).
    const backend: TerminalBackend = src.backend ?? "wsl";
    const projectPath = backend === "wsl" ? toWslPath(src.workingDir) : src.workingDir;
    let snippet = await readSessionLastAssistantText(projectPath, backend, src.sessionResumeId);
    if (!snippet) {
      await new Promise((r) => setTimeout(r, SNIPPET_RETRY_MS));
      snippet = await readSessionLastAssistantText(projectPath, backend, src.sessionResumeId);
    }
    if (snippet) displayBody = snippet;
  }

  // The user may have focused the pane while the snippet was being read.
  if (isSuppressed(src.terminalId, tab.id)) return;

  const fresh = useAppStore.getState();
  const projectName = projectDisplayName(
    fresh.recentProjects,
    tab.workingDir || src.workingDir,
    tab.serverId,
  );
  usePaneNotificationsStore.getState().add({
    id: `${src.terminalId}:${Date.now()}`,
    terminalId: src.terminalId,
    tabId: tab.id,
    projectName,
    paneLabel: src.paneLabel,
    body: displayBody,
    kind,
    timeHHMM,
    addedAt: Date.now(),
  });

  // OS toast while minimized: the in-app card is invisible then, so the
  // system notification is the right channel. Silent — the per-project chime
  // below is the only audio, or Windows would ding on top of it. Informational
  // only: desktop toast clicks don't deep-link (plugin actions are
  // mobile-only); restoring via taskbar + auto-switch covers navigation.
  if (fresh.windowMinimized && (fresh.notifSystemMinimized ?? true)) {
    void sendOsToast(
      src.paneLabel ? `${projectName} · ${src.paneLabel}` : projectName,
      displayBody,
    );
  }

  // Per-project sound, resolved lazily on first notification. Deliberately
  // AFTER add() — the sound announces a card that actually exists. Minimized
  // is NOT suppressed (isSuppressed exempts it — that's the point). Toggle
  // off skips even the lazy assignment. The kind doubles the hit for
  // permission prompts — blocked-on-input must be tellable by ear.
  if (fresh.notifSoundEnabled ?? true) {
    const soundId = ensureProjectSound(tab.workingDir || src.workingDir);
    if (soundId) playNotificationSound(soundId, kind);
  }

  // Auto-switch while minimized (Settings > Terminal > Notifications):
  // re-target the tab/pane internally so it's front when the user restores the
  // window. takeFocus:false is load-bearing — no DOM/Win32 focus claim while
  // minimized, and the window itself is NEVER restored.
  if (fresh.notifAutoSwitchMinimized && fresh.windowMinimized) {
    if (fresh.activeTabId !== tab.id) fresh.setActiveTab(tab.id);
    window.dispatchEvent(
      new CustomEvent("made:focus-terminal", {
        detail: { terminalId: src.terminalId, takeFocus: false },
      }),
    );
  }
}
