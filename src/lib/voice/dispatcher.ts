import { useAppStore } from "../../store";
import type { AppStore } from "../../store";
import type { PaneLayout, TerminalType } from "../../types";
import {
  addPaneAsGrid,
  openOrUpdateBrowserPane,
  removePane,
  generatePaneId,
  generateTerminalId,
} from "../layout-utils";
import type { ToolCall } from "./llmClient";
import { isDestructive, WRITABLE_SETTINGS } from "./tools";

export interface DispatchOutcome {
  ok: boolean;
  /** Short human description ("Opened browser pane to github.com"). */
  message: string;
  /** When set, indicates the agent needs more input (clarify) or confirmation. */
  pending?: { kind: "clarify"; question: string } | { kind: "confirm"; summary: string; deferredCalls: ToolCall[] };
  /** When set, this is the "say" message for TTS / final feedback. */
  spoken?: string;
}

// ─── Pane resolution ─────────────────────────────────────────────────────

interface Flat {
  id: string;
  type: PaneLayout["type"];
  detail?: string;
  position: number;
}

function flatten(layout: PaneLayout | null, out: Flat[] = [], pos = { i: 0 }): Flat[] {
  if (!layout) return out;
  if (layout.type === "split") {
    flatten(layout.children[0], out, pos);
    flatten(layout.children[1], out, pos);
    return out;
  }
  let detail: string | undefined;
  if (layout.type === "terminal") detail = layout.terminalType ?? "shell";
  else if (layout.type === "browser") {
    try { detail = new URL(layout.url).hostname; } catch { detail = layout.url; }
  } else if (layout.type === "editor") detail = layout.filePath.split(/[\\/]/).pop();
  out.push({ id: layout.id, type: layout.type, detail, position: pos.i++ });
  return out;
}

function resolvePaneRef(store: AppStore, ref: string): { id: string } | { error: string; matches: Flat[] } {
  const tab = store.tabs.find((t) => t.id === store.activeTabId);
  const flats = flatten(tab?.layout ?? null);
  if (flats.length === 0) return { error: "No panes in the active tab.", matches: [] };

  // Direct id match
  if (flats.some((f) => f.id === ref)) return { id: ref };

  const r = ref.toLowerCase().trim();

  // Type or CLI keyword
  const typeMatches = flats.filter((f) => {
    if (r.includes(f.type)) return true;
    if (f.detail && r.includes(f.detail.toLowerCase())) return true;
    return false;
  });

  // Position keywords
  let candidates = typeMatches.length > 0 ? typeMatches : flats.slice();
  if (/(left|first|leftmost)/i.test(ref)) {
    candidates = [candidates.reduce((a, b) => (a.position <= b.position ? a : b))];
  } else if (/(right|last|rightmost)/i.test(ref)) {
    candidates = [candidates.reduce((a, b) => (a.position >= b.position ? a : b))];
  }

  if (candidates.length === 1) return { id: candidates[0].id };
  if (candidates.length === 0) return { error: `No pane matched "${ref}".`, matches: flats };
  return {
    error: `Multiple panes match "${ref}".`,
    matches: candidates,
  };
}

// ─── Tab resolution ──────────────────────────────────────────────────────

function resolveTabRef(store: AppStore, ref: string): string | null {
  const projectTabs = store.tabs.filter((t) => !t.isDevServerTab && !t.isServersTab && !t.isKanbanTab && !t.isSettingsTab);
  if (ref === "current") return store.activeTabId || null;

  // 1-based index
  const idx = Number(ref);
  if (!Number.isNaN(idx) && idx >= 1 && idx <= projectTabs.length) {
    return projectTabs[idx - 1].id;
  }

  // Exact id
  if (store.tabs.some((t) => t.id === ref)) return ref;

  // System tab name shortcuts
  const r = ref.toLowerCase();
  if (/^(task|kanban)/.test(r)) {
    const sys = store.tabs.find((t) => t.isKanbanTab);
    if (sys) return sys.id;
  }
  if (/^server/.test(r)) {
    const sys = store.tabs.find((t) => t.isServersTab);
    if (sys) return sys.id;
  }
  if (/^setting/.test(r)) {
    const sys = store.tabs.find((t) => t.isSettingsTab);
    if (sys) return sys.id;
  }

  // Substring name match (case-insensitive)
  const exact = store.tabs.find((t) => t.name.toLowerCase() === r);
  if (exact) return exact.id;
  const partial = store.tabs.find((t) => t.name.toLowerCase().includes(r));
  return partial?.id ?? null;
}

// ─── Setting coercion ────────────────────────────────────────────────────

function coerce(value: unknown, type: "boolean" | "number" | "string"): unknown {
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const v = value.toLowerCase();
      if (["true", "yes", "on", "1", "ja", "på"].includes(v)) return true;
      if (["false", "no", "off", "0", "nej", "av"].includes(v)) return false;
    }
    if (typeof value === "number") return value !== 0;
    return null;
  }
  if (type === "number") {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return String(value ?? "");
}

// ─── Main dispatcher ─────────────────────────────────────────────────────

/**
 * Execute a sequence of tool calls. Returns the outcome of the last
 * action-shaped call (we collapse `say`/`clarify` into the outcome).
 *
 * `pendingConfirm` carries deferred destructive calls forward across turns
 * — populated when the agent emits confirm_destructive followed by a
 * destructive tool, returned for the UI to gate on user yes/no.
 */
export function dispatch(calls: ToolCall[]): DispatchOutcome {
  const store = useAppStore.getState();
  if (calls.length === 0) {
    return { ok: false, message: "Agent returned no tool calls." };
  }

  let lastMessage = "";
  let spoken: string | undefined;
  let lastOk = true;

  // Detect destructive sequencing.
  // Pattern: confirm_destructive must be IMMEDIATELY followed by a destructive call.
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];

    // Clarify short-circuits the rest.
    if (call.name === "clarify") {
      const q = String(call.arguments.question ?? "");
      return {
        ok: true,
        message: `Clarifying: ${q}`,
        pending: { kind: "clarify", question: q },
        spoken: q,
      };
    }

    // confirm_destructive defers the next call(s) until user confirms.
    if (call.name === "confirm_destructive") {
      const summary = String(call.arguments.summary ?? "Are you sure?");
      const remaining = calls.slice(i + 1);
      return {
        ok: true,
        message: `Awaiting confirmation: ${summary}`,
        pending: { kind: "confirm", summary, deferredCalls: remaining },
        spoken: summary,
      };
    }

    // Destructive call without prior confirmation? Refuse and return as a confirmation prompt.
    if (
      isDestructive(call.name) &&
      store.voiceConfirmDestructive &&
      (i === 0 || calls[i - 1].name !== "confirm_destructive")
    ) {
      return {
        ok: false,
        message: `Refused destructive call without confirmation: ${call.name}`,
        pending: {
          kind: "confirm",
          summary: `Confirm: ${call.name}`,
          deferredCalls: [call],
        },
      };
    }

    if (call.name === "say") {
      spoken = String(call.arguments.message ?? "");
      lastMessage = spoken;
      continue;
    }

    const result = executeOne(call);
    if (!result.ok) lastOk = false;
    if (result.message) lastMessage = result.message;
  }

  return { ok: lastOk, message: lastMessage || "Done.", spoken };
}

function executeOne(call: ToolCall): { ok: boolean; message: string } {
  const store = useAppStore.getState();
  const tab = store.tabs.find((t) => t.id === store.activeTabId);

  switch (call.name) {
    case "add_terminal_pane": {
      if (!tab) return { ok: false, message: "No active tab." };
      const cli = (String(call.arguments.cli ?? "shell") as TerminalType);
      const validCli: TerminalType[] = ["claude", "codex", "gemini", "shell"];
      const type = validCli.includes(cli) ? cli : "shell";
      const terminalId = generateTerminalId();
      store.addTerminal(terminalId, type, tab.workingDir, tab.serverId);
      const newPane: PaneLayout = {
        type: "terminal",
        id: generatePaneId(),
        terminalId,
        terminalType: type,
      };
      const next = tab.layout
        ? addPaneAsGrid(tab.layout, newPane, store.wideGridLayout)
        : newPane;
      store.updateTabLayout(tab.id, next);
      return { ok: true, message: `Added ${type} pane.` };
    }

    case "add_browser_pane": {
      if (!tab) return { ok: false, message: "No active tab." };
      let url = String(call.arguments.url ?? "").trim();
      if (!url) return { ok: false, message: "No URL given." };
      if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
      // Reject single-label hosts ("gemini", "claude") — these crash the proxy
      // and aren't real sites anyway. Whisper occasionally turns "gemini pane"
      // into url=gemini; we want to fail cleanly, not open a broken iframe.
      try {
        const parsed = new URL(url);
        const host = parsed.hostname;
        const isLocalhost = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
        if (!isLocalhost && !host.includes(".")) {
          return { ok: false, message: `"${host}" doesn't look like a real URL — say the full address (e.g. github.com).` };
        }
      } catch {
        return { ok: false, message: `"${url}" isn't a valid URL.` };
      }
      const side = call.arguments.side === "left" || (store.browserSpawnLeft && call.arguments.side !== "right")
        ? "left"
        : "right";
      const sizeRaw = Number(call.arguments.size_percent);
      const size = Number.isFinite(sizeRaw) ? Math.max(20, Math.min(60, sizeRaw)) : 35;
      let host = url;
      try { host = new URL(url).hostname; } catch { /* ignore */ }
      if (!tab.layout) {
        // Empty tab — just use a single browser pane.
        store.updateTabLayout(tab.id, { type: "browser", id: generatePaneId(), url });
      } else {
        // Enforce one browser pane per tab: retarget the existing pane if any,
        // else add a fresh one on the chosen side. Voice "open browser to X"
        // shouldn't stack panes — the user expects the single preview to
        // navigate to the new URL.
        const { layout } = openOrUpdateBrowserPane(tab.layout, url, {
          sizePercent: size,
          fullColumn: true,
          spawnLeft: side === "left",
        });
        store.updateTabLayout(tab.id, layout);
      }
      return { ok: true, message: `Opened browser pane to ${host}.` };
    }

    case "close_pane": {
      if (!tab?.layout) return { ok: false, message: "No panes to close." };
      const ref = String(call.arguments.pane_ref ?? "");
      const resolved = resolvePaneRef(store, ref);
      if ("error" in resolved) {
        return { ok: false, message: resolved.error };
      }
      const next = removePane(tab.layout, resolved.id);
      store.updateTabLayout(tab.id, next);
      return { ok: true, message: "Closed pane." };
    }

    case "expand_pane":
    case "popout_pane":
    case "minimize_pane": {
      const ref = String(call.arguments.pane_ref ?? "");
      const resolved = resolvePaneRef(store, ref);
      if ("error" in resolved) return { ok: false, message: resolved.error };
      if (call.name === "expand_pane") store.expandPane(resolved.id);
      else if (call.name === "popout_pane") store.popoutPane(resolved.id);
      else store.minimizePane(resolved.id);
      return { ok: true, message: `${call.name.replace("_", " ")}d.` };
    }

    case "switch_tab": {
      const ref = String(call.arguments.tab_ref ?? "");
      const id = resolveTabRef(store, ref);
      if (!id) return { ok: false, message: `No tab matched "${ref}".` };
      store.setActiveTab(id);
      const name = store.tabs.find((t) => t.id === id)?.name ?? id;
      return { ok: true, message: `Switched to ${name}.` };
    }

    case "close_tab": {
      const ref = String(call.arguments.tab_ref ?? "");
      const id = resolveTabRef(store, ref);
      if (!id) return { ok: false, message: `No tab matched "${ref}".` };
      const name = store.tabs.find((t) => t.id === id)?.name ?? id;
      store.removeTab(id);
      return { ok: true, message: `Closed ${name}.` };
    }

    case "set_theme": {
      const id = String(call.arguments.theme_id ?? "");
      if (!id) return { ok: false, message: "No theme id." };
      store.setTheme(id);
      return { ok: true, message: `Theme set to ${id}.` };
    }

    case "set_setting": {
      const key = String(call.arguments.key ?? "");
      const rawValue = call.arguments.value;
      const type = WRITABLE_SETTINGS[key];
      if (!type) return { ok: false, message: `Setting "${key}" is not writable.` };
      const value = coerce(rawValue, type);
      if (value === null) return { ok: false, message: `Invalid value for ${key}.` };
      const setterName = `set${key.charAt(0).toUpperCase()}${key.slice(1)}`;
      const setter = (store as unknown as Record<string, unknown>)[setterName];
      if (typeof setter !== "function") {
        return { ok: false, message: `No setter found for ${key}.` };
      }
      (setter as (v: unknown) => void)(value);
      return { ok: true, message: `Set ${key} to ${value}.` };
    }

    case "open_settings": {
      store.toggleSettingsPanel?.();
      return { ok: true, message: "Opened Settings." };
    }

    case "open_command_palette": {
      window.dispatchEvent(new Event("ezydev:open-palette"));
      return { ok: true, message: "Opened command palette." };
    }

    case "toggle_sidebar": {
      store.toggleSidebar();
      return { ok: true, message: store.sidebarOpen ? "Hid sidebar." : "Showed sidebar." };
    }

    default:
      return { ok: false, message: `Unknown tool: ${call.name}` };
  }
}
