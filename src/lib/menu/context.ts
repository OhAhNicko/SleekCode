import type { TerminalType, TerminalRenderer, PaneMode } from "../../types";
import { useAppStore } from "../../store";
import { getPaneState } from "../pane-state-registry";
import { findPaneIdForTerminal, findAllTerminalIds } from "../layout-utils";
import { getCachedBranch } from "../git-branch-cache";

/**
 * What a right-click landed on.
 *
 * The old menu computed `{ x, y, isTerminal }` and threw the DOM target away,
 * which is the single root cause of every "why is this option here?" complaint:
 * with no target, one menu had to serve a file row, the topbar, the editor and
 * the kanban board at once.
 */
export type SurfaceKind =
  | "terminal"
  | "pane"
  | "tab"
  | "tabstrip"
  | "file"
  | "composer"
  | "image"
  | "input"
  | "row"
  | "app";

type Base = {
  /** Viewport px, from the (possibly synthetic) MouseEvent. */
  point: { x: number; y: number };
};

export type TerminalCtx = Base & {
  kind: "terminal";
  terminalId: string;
  paneId: string | null;
  tabId: string;
  terminalType: TerminalType;
  renderer: TerminalRenderer;
  /** Spawn dir. There is no live-cwd (OSC 7) source in this app — don't fake one. */
  workingDir: string;
  serverId?: string;
  /** Synchronous, from the pane-state mirror. "" = nothing selected. */
  selection: string;
  altScreen: boolean;
  mouseReporting: boolean;
  exited: boolean;
  paneCount: number;
  /** Pane-local px of the click, for resolving which command block was hit. */
  local: { x: number; y: number } | null;
  /** ENRICHED — undefined means "not resolved yet", not "not a repo". */
  gitBranch?: string;
  isRepo?: boolean;
};

export type PaneCtx = Base & {
  kind: "pane";
  paneId: string;
  tabId: string;
  paneMode: PaneMode | null;
  paneCount: number;
};

export type TabCtx = Base & {
  kind: "tab";
  tabId: string;
  workingDir: string;
  isSystemTab: boolean;
  isPinned: boolean;
  isActive: boolean;
  isHibernated: boolean;
  hasLayout: boolean;
  /** Index among VISIBLE tabs — system tabs occupy leading store indices. */
  visibleIndex: number;
  visibleCount: number;
};

export type TabstripCtx = Base & { kind: "tabstrip" };

export type FileCtx = Base & {
  kind: "file";
  path: string;
  name: string;
  isDir: boolean;
  rootDir: string;
};

export type ComposerCtx = Base & {
  kind: "composer";
  terminalId: string;
};

export type ImageCtx = Base & {
  kind: "image";
  imageId: string;
  source: "strip" | "gallery" | "composer" | "screenshots";
};

export type InputCtx = Base & {
  kind: "input";
  /** Live DOM node — MUST stay main-side, never crosses the overlay bridge. */
  el: HTMLElement;
  hasSelection: boolean;
  readOnly: boolean;
};

/**
 * Generic list-row surface: kanban cards, code-review files, server rows,
 * dev-server rows, editor tabs, the browser pane, the sidebar background.
 *
 * One context kind covers all of them because they share a shape — an id, a
 * role, and a few string attributes — and giving each its own type would be
 * eight near-identical declarations. The provider still switches on `role` and
 * returns only that role's items, so the hide-what-can't-apply rule holds.
 */
export type RowCtx = Base & {
  kind: "row";
  role: SurfaceRoleName;
  id: string;
  label: string;
  data: Record<string, string>;
};

export type SurfaceRoleName =
  | "kanban-card"
  | "kanban-col"
  | "review-file"
  | "server"
  | "devserver"
  | "editor-tab"
  | "browser"
  | "sidebar"
  | "jira-ticket"
  | "jira-assigned"
  | "game-sidebar"
  | "knowledge"
  | "knowledge-note";

export type AppCtx = Base & {
  kind: "app";
  activeTabId: string | null;
  sidebarOpen: boolean;
  hasTerminal: boolean;
};

export type MenuContext =
  | TerminalCtx
  | PaneCtx
  | TabCtx
  | TabstripCtx
  | FileCtx
  | ComposerCtx
  | ImageCtx
  | InputCtx
  | RowCtx
  | AppCtx;

type Point = { x: number; y: number };
type Resolver = (el: HTMLElement, point: Point) => MenuContext | null;

// ── Resolvers, most-specific first ────────────────────────────────────────
// Ordered so a single node carrying both [data-terminal-id] and [data-pane-id]
// (TerminalPaneNative's anchor does) yields both contexts, terminal first.

const SYSTEM_TAB_FLAGS = ["isDevServerTab", "isServersTab", "isKanbanTab", "isSettingsTab"] as const;

const resolveTerminal: Resolver = (el, point) => {
  const terminalId = el.dataset?.terminalId;
  if (!terminalId) return null;
  const s = useAppStore.getState();
  const term = s.terminals[terminalId];
  if (!term) return null;
  const tab = s.tabs.find((t) => t.layout && findPaneIdForTerminal(t.layout, terminalId));
  const paneId = tab?.layout ? findPaneIdForTerminal(tab.layout, terminalId) : null;
  const pane = getPaneState(terminalId);

  // Pane-local px: the native pane's synthetic event carries viewport coords
  // computed from this same anchor, so subtracting its rect recovers them.
  const r = el.getBoundingClientRect();
  const local = r.width > 0 ? { x: point.x - r.left, y: point.y - r.top } : null;

  // Synchronous if the cache is warm — the right-button PRESS prewarms it and
  // Chromium only fires `contextmenu` on button-up, so in practice the menu
  // opens already knowing. A cold cache leaves these undefined and the
  // enrichment pass fills them in.
  const workingDir = term.workingDir ?? tab?.workingDir ?? "";
  const git = getCachedBranch(workingDir);

  return {
    kind: "terminal",
    point,
    terminalId,
    paneId,
    tabId: tab?.id ?? s.activeTabId ?? "",
    terminalType: term.type,
    renderer: (el.dataset?.terminalRenderer as TerminalRenderer) ?? "xterm",
    workingDir,
    serverId: term.serverId,
    selection: pane.selection,
    altScreen: pane.altScreen,
    mouseReporting: pane.mouseReporting,
    exited: pane.exited,
    paneCount: tab?.layout ? findAllTerminalIds(tab.layout).length : 1,
    local,
    isRepo: git?.isRepo,
    gitBranch: git?.branch,
  };
};

const resolvePane: Resolver = (el, point) => {
  const paneId = el.dataset?.paneId;
  if (!paneId) return null;
  const s = useAppStore.getState();
  const tab = s.tabs.find((t) => t.id === s.activeTabId);
  return {
    kind: "pane",
    point,
    paneId,
    tabId: tab?.id ?? "",
    paneMode: s.paneModes?.[paneId] ?? null,
    paneCount: tab?.layout ? findAllTerminalIds(tab.layout).length : 1,
  };
};

const resolveTab: Resolver = (el, point) => {
  const tabId = el.dataset?.tabId;
  if (!tabId) return null;
  const s = useAppStore.getState();
  const tab = s.tabs.find((t) => t.id === tabId);
  if (!tab) return null;
  const isSystemTab = SYSTEM_TAB_FLAGS.some((f) => (tab as unknown as Record<string, boolean>)[f]);
  const visible = s.tabs.filter(
    (t) => !SYSTEM_TAB_FLAGS.some((f) => (t as unknown as Record<string, boolean>)[f]),
  );
  return {
    kind: "tab",
    point,
    tabId,
    workingDir: tab.workingDir ?? "",
    isSystemTab,
    isPinned: !!tab.isPinned,
    isActive: s.activeTabId === tabId,
    isHibernated: !!tab.isHibernated,
    hasLayout: !!tab.layout,
    visibleIndex: visible.findIndex((t) => t.id === tabId),
    visibleCount: visible.length,
  };
};

const resolveByCtxAttr: Resolver = (el, point) => {
  const surface = el.dataset?.ctxSurface;
  if (!surface) return null;
  switch (surface) {
    case "tabstrip":
      return { kind: "tabstrip", point };
    case "file":
      return {
        kind: "file",
        point,
        path: el.dataset.ctxPath ?? "",
        name: el.dataset.ctxName ?? "",
        isDir: el.dataset.ctxDir === "1",
        rootDir: el.dataset.ctxRoot ?? "",
      };
    case "composer":
      return { kind: "composer", point, terminalId: el.dataset.ctxTerminalId ?? "" };
    case "image":
      return {
        kind: "image",
        point,
        imageId: el.dataset.ctxImageId ?? "",
        source: (el.dataset.ctxImageSource as ImageCtx["source"]) ?? "strip",
      };
    default: {
      // Generic list rows. `data-ctx-surface` carries the role directly, so a
      // new row surface needs an attribute and a provider case — no new type.
      const ROLES = [
        "kanban-card", "kanban-col", "review-file", "server",
        "devserver", "editor-tab", "browser", "sidebar", "jira-ticket",
        "jira-assigned", "game-sidebar", "knowledge", "knowledge-note",
      ] as const;
      if (!(ROLES as readonly string[]).includes(surface)) return null;
      const data: Record<string, string> = {};
      for (const [k, v] of Object.entries(el.dataset)) {
        if (k.startsWith("ctx") && typeof v === "string") data[k] = v;
      }
      return {
        kind: "row",
        point,
        role: surface as RowCtx["role"],
        id: el.dataset.ctxId ?? "",
        label: el.dataset.ctxLabel ?? "",
        data,
      };
    }
  }
};

/**
 * Text fields. No attribute — matched by predicate, because every input in the
 * app deserves real Cut/Copy/Paste and annotating them all would be busywork
 * that the next new input would forget.
 */
const resolveInput: Resolver = (el, point) => {
  if (
    !(el instanceof HTMLInputElement) &&
    !(el instanceof HTMLTextAreaElement) &&
    el.getAttribute?.("contenteditable") !== "true"
  ) {
    return null;
  }
  const field = el as HTMLInputElement | HTMLTextAreaElement;
  const hasSelection =
    typeof field.selectionStart === "number" && typeof field.selectionEnd === "number"
      ? field.selectionEnd > field.selectionStart
      : !!window.getSelection()?.toString();
  return {
    kind: "input",
    point,
    el,
    hasSelection,
    readOnly: !!(field as HTMLInputElement).readOnly || (field as HTMLInputElement).disabled,
  };
};

const ORDERED_RESOLVERS: Resolver[] = [
  resolveInput,
  resolveTerminal,
  resolveByCtxAttr,
  resolveTab,
  resolvePane,
];

function buildAppCtx(point: Point): AppCtx {
  const s = useAppStore.getState();
  return {
    kind: "app",
    point,
    activeTabId: s.activeTabId ?? null,
    sidebarOpen: !!s.sidebarOpen,
    hasTerminal: Object.keys(s.terminals ?? {}).length > 0,
  };
}

/**
 * Walk from the event target outward, collecting one context per surface kind
 * (innermost wins), and always append the app context.
 *
 * The stack is what makes nesting free: a composer inside a terminal pane
 * yields [composer, terminal, pane, app], so the composer's items, the pane's
 * Split/Close and the app fallbacks all appear, in that order, with no
 * coordination between their providers.
 */
export function resolveMenuContext(ev: MouseEvent): MenuContext[] {
  const point = { x: ev.clientX, y: ev.clientY };
  const out: MenuContext[] = [];
  let el = ev.target as HTMLElement | null;

  while (el && el !== document.body && el.nodeType === 1) {
    for (const resolve of ORDERED_RESOLVERS) {
      let ctx: MenuContext | null = null;
      try {
        ctx = resolve(el, point);
      } catch {
        ctx = null; // a resolver must never take the menu down with it
      }
      if (ctx && !out.some((c) => c.kind === ctx!.kind)) out.push(ctx);
    }
    el = el.parentElement;
  }

  out.push(buildAppCtx(point));
  return out;
}
