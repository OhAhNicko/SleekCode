import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "../store";
import type { PaneLayout, ProjectSession } from "../types";
import {
  findAllTerminalIds,
  findAllTerminalLeaves,
  findAllBrowserPanes,
  addBrowserPaneRight,
  addBrowserPaneLeft,
  addPaneAsGrid,
  removePane,
  generatePaneId,
  findKanbanPaneId,
  addKanbanPane,
} from "../lib/layout-utils";
import { getProjectColor } from "../store/recentProjectsSlice";
import { syncProjectColors } from "../lib/tab-colors";
import {
  VERTICAL_TABBAR_MAX_WIDTH,
  VERTICAL_TABBAR_MIN_WIDTH,
} from "../store/layoutSlice";
import { getQuickOpenServer } from "../lib/dev-server-lookup";
import { openDevServerUrl, wantsInAppOpen } from "../lib/open-dev-server-url";
import { isTerminalActive } from "../lib/terminal-activity";
import { startCustomWindowDrag, toggleMaximizeOnDoubleClick } from "../lib/window-chrome";
import ClipboardImageStrip from "./ClipboardImageStrip";
import VoiceMicButton from "./VoiceMicButton";
import { VOICE_ENABLED } from "../lib/voice/feature-flag";
import GitStatusBar from "./GitStatusBar";
import VerticalTicketTree, {
  focusTerminalInTab,
  type TicketTreeEntry,
} from "./VerticalTicketTree";
import VerticalTicketFlyout from "./VerticalTicketFlyout";
import { registerSurfaceActions, unregisterSurfaceActions } from "../lib/surface-actions";
import {
  buildJiraTicketActions,
  buildJiraAssignedActions,
  buildJiraUnassignedActions,
} from "../lib/jira-surface-actions";
import { FaXmark, FaGear, FaServer, FaPlus, FaChevronLeft, FaChevronRight } from "react-icons/fa6";
import { TbBrowserPlus, TbBrowserMinus } from "react-icons/tb";
import { PiKanbanDuotone, PiGameControllerDuotone } from "react-icons/pi";
import { AiOutlinePushpin, AiFillPushpin } from "react-icons/ai";
import { BiSidebar } from "react-icons/bi";
import { FaChevronDown } from "react-icons/fa";
import { TERMINAL_CONFIGS } from "../lib/terminal-config";
import { useOverlayMenu } from "../lib/useOverlayMenu";
import { useTabLaunchMenu } from "../hooks/useTabLaunchMenu";
import { useRemoteBrowseStore, requestRemoteReload } from "../store/remoteBrowseStore";
import { FaArrowRotateRight } from "react-icons/fa6";

/**
 * Vertical tab strip, v2 — "gutter rail".
 *
 * Behind Settings > General > "Vertical tabbar v2"; VerticalTabBar.tsx stays
 * the fallback and is untouched. Three things differ from v1:
 *
 *  1. The project colour is a RAIL, not trim. v1 painted a 2px border on one
 *     row's content-facing edge; here a 3px bar sits on the DOCK-facing edge of
 *     a wrapper that holds the project row *and* its Jira ticket tree, so a
 *     project and its conversations read as a single object.
 *  2. v1's three full-width labelled rows (Explorer / Servers / Browser) become
 *     one wrapping icon grid — ~74px of chrome returned to the tab list.
 *  3. Rows carry no bottom hairline. Grouping is the rail and the indent;
 *     hairlines survive only between the strip's major regions.
 *
 * Everything the menu engine needs is unchanged from v1: the list is a
 * `tabstrip` surface and each row carries `data-tab-id`, so rows raise the same
 * tab context menu the horizontal bar does.
 */

const COMPACT_WIDTH = 80;
const TAB_ROW_HEIGHT = 30;
const GRID_ROW_HEIGHT = 34;
/** Width of the project-colour gutter. Reserved even when there is no colour,
 *  so labels never shift as colours get assigned. */
const RAIL_WIDTH = 3;

/**
 * Open/closed counts for a Jira project's tickets, straight from the store.
 *
 * Deliberately not `useJiraTicketRows`: the compact strip shows this for every
 * Jira tab at once, and mounting the rows hook per tab would run a transcript
 * probe and a 20s title poll per project for a row of dots. Sorting, grouping
 * and naming are irrelevant here — only "is a pane live for this session".
 */
function ticketDots(
  tab: { layout: PaneLayout | null | undefined },
  sessions: ProjectSession[] | undefined,
): { open: number; closed: number } {
  const live = new Set<string>();
  if (tab.layout) {
    for (const leaf of findAllTerminalLeaves(tab.layout)) {
      if (leaf.sessionResumeId) live.add(leaf.sessionResumeId);
    }
  }
  let open = 0;
  let closed = 0;
  for (const s of sessions ?? []) {
    if (!s.ticket || s.archived) continue;
    if (live.has(s.id)) open += 1;
    else closed += 1;
  }
  return { open, closed };
}

/** Last `maxSegments` path segments — the tail is what identifies a project. */
function truncateTabPath(path: string, maxSegments = 3): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = normalized.split("/").filter(Boolean);
  return segments.slice(-maxSegments).join("/");
}

function tabInitials(name: string): string {
  const cleaned = name.trim().replace(/[_\-./\\]+/g, " ");
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export default function VerticalTabBarV2() {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const removeTab = useAppStore((s) => s.removeTab);
  const togglePinTab = useAppStore((s) => s.togglePinTab);
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const devServers = useAppStore((s) => s.devServers);
  const recentProjects = useAppStore((s) => s.recentProjects);
  const devServerTabIcon = useAppStore((s) => s.devServerTabIcon);
  const devServerPanelOpen = useAppStore((s) => s.devServerPanelOpen);
  const toggleDevServerPanel = useAppStore((s) => s.toggleDevServerPanel);
  const projectColors = useAppStore((s) => s.projectColors);
  const setProjectColor = useAppStore((s) => s.setProjectColor);
  const settingsPanelOpen = useAppStore((s) => s.settingsPanelOpen);
  const showMiniGamesButton = useAppStore((s) => s.showMiniGamesButton ?? false);
  const gameSidebarOpen = useAppStore((s) => s.gameSidebarOpen);
  const showKanbanButton = useAppStore((s) => s.showKanbanButton ?? true);
  const compact = useAppStore((s) => s.verticalTabBarCompact);
  const setCompact = useAppStore((s) => s.setVerticalTabBarCompact);
  const dockedRight = useAppStore((s) => s.sidebarSide) === "right";
  const wideWidth = useAppStore((s) => s.verticalTabBarWidth ?? 220);
  const setWideWidth = useAppStore((s) => s.setVerticalTabBarWidth);
  const stripWidth = compact ? COMPACT_WIDTH : wideWidth;
  const projectSessions = useAppStore((s) => s.projectSessions);
  // Same setting that governs the horizontal bar's hover-open dropdowns, so
  // the strip does not invent a second rule for the same gesture.
  const hoverOpenMenus = useAppStore((s) => s.hoverOpenAddPaneMenu ?? false);
  const showTabPath = useAppStore((s) => s.showTabPath);
  const remoteServers = useAppStore((s) => s.servers);
  const remoteBrowse = useRemoteBrowseStore((s) => s.byTab);

  const visibleTabs = tabs.filter(
    (t) => !t.isDevServerTab && !t.isKanbanTab && !t.isServersTab && !t.isSettingsTab
  );
  // Assign + dedup project colours here too. v1 only READ the map, so a
  // project that had never been on screen in horizontal mode had no colour —
  // and in v2 the colour is the rail, i.e. the whole visual system.
  const localColors = syncProjectColors(visibleTabs, projectColors, setProjectColor);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeIsProject =
    !!activeTab &&
    !activeTab.isDevServerTab &&
    !activeTab.isServersTab &&
    !activeTab.isKanbanTab &&
    !activeTab.isSettingsTab;

  const runningDevCount = devServers.filter(
    (s) => s.status === "running" || s.status === "starting"
  ).length;


  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // ── Drag to reorder ──────────────────────────────────────────────────────
  // Same shape as the horizontal bar's (4px threshold, ghost, drop
  // placeholder, commit on pointerup), hit-tested on the Y axis instead: a row
  // is "before" the pointer when the pointer sits above its vertical midpoint.
  // Ticket rows inside a tree are NOT draggable — only project rows carry the
  // pointer handler.
  const reorderTabs = useAppStore((s) => s.reorderTabs);
  const dragStartRef = useRef<{
    tabId: string;
    offsetY: number;
    startX: number;
    startY: number;
    rowHeight: number;
    rowLeft: number;
    rowWidth: number;
  } | null>(null);
  const didDragRef = useRef(false);
  const [dragState, setDragState] = useState<{
    tabId: string;
    ghostY: number;
    rowLeft: number;
    rowWidth: number;
    rowHeight: number;
    insertBeforeId: string | null;
  } | null>(null);

  const getInsertBeforeId = useCallback((clientY: number, excludeId: string): string | null => {
    const container = listRef.current;
    if (!container) return null;
    for (const el of container.querySelectorAll<HTMLElement>("[data-tab-id]")) {
      if (el.dataset.tabId === excludeId) continue;
      const { top, height } = el.getBoundingClientRect();
      if (clientY < top + height / 2) return el.dataset.tabId!;
    }
    return null;
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const ds = dragStartRef.current;
      if (!ds) return;
      const dx = Math.abs(e.clientX - ds.startX);
      const dy = Math.abs(e.clientY - ds.startY);
      if (!didDragRef.current && dx < 4 && dy < 4) return;
      didDragRef.current = true;
      setDragState({
        tabId: ds.tabId,
        ghostY: e.clientY - ds.offsetY,
        rowLeft: ds.rowLeft,
        rowWidth: ds.rowWidth,
        rowHeight: ds.rowHeight,
        insertBeforeId: getInsertBeforeId(e.clientY, ds.tabId),
      });
    };
    const onUp = () => {
      if (didDragRef.current) {
        setDragState((prev) => {
          if (prev) reorderTabs(prev.tabId, prev.insertBeforeId);
          return null;
        });
      } else {
        setDragState(null);
      }
      dragStartRef.current = null;
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
  }, [getInsertBeforeId, reorderTabs]);

  // ── "+" launcher (the left half of the pinned footer) ────────────────────
  // The SAME hook the horizontal bar uses, so the dialogue is identical by
  // construction rather than by two implementations agreeing.
  const launchHoverTimer = useRef<number | null>(null);
  const cancelLaunchHoverClose = useCallback(() => {
    if (launchHoverTimer.current !== null) {
      clearTimeout(launchHoverTimer.current);
      launchHoverTimer.current = null;
    }
  }, []);
  const {
    recentBtnRef,
    showRecentMenu,
    setShowRecentMenu,
    handlePlusClick,
    launchModals,
  } = useTabLaunchMenu({
    hoverTracking: hoverOpenMenus,
    onHoverIn: () => cancelLaunchHoverClose(),
    onHoverOut: () => {
      cancelLaunchHoverClose();
      launchHoverTimer.current = window.setTimeout(() => setShowRecentMenu(false), 160);
    },
  });
  useEffect(() => cancelLaunchHoverClose, [cancelLaunchHoverClose]);

  // ── Add-pane menu (the "⌄" half of the pinned footer) ────────────────────
  // Same overlay menu the horizontal bar raises from its chevron, same action
  // events — the payload is small and stateless, so it lives here rather than
  // behind an extraction.
  const cliYolo = useAppStore((s) => s.cliYolo);
  const addPaneBtnRef = useRef<HTMLDivElement>(null);
  const [showAddPaneMenu, setShowAddPaneMenu] = useState(false);
  // Adding a free pane has nothing to attach to on a system tab, and on a Jira
  // project it would break the per-ticket pair layout. The half stays PUT and
  // greys out with a reason — a footer that loses a button reads as broken.
  const addPaneReason = !activeIsProject
    ? "no project tab is active"
    : activeTab?.isJiraProject
      ? "a Jira project's panes belong to its tickets"
      : undefined;
  const canAddPane = !addPaneReason;
  useEffect(() => {
    if (!canAddPane) setShowAddPaneMenu(false);
  }, [canAddPane]);
  useOverlayMenu({
    id: "vtabbar-add-pane",
    open: showAddPaneMenu,
    anchorRef: addPaneBtnRef,
    payload: showAddPaneMenu
      ? {
          // Opens UPWARD: the footer sits at the bottom of the strip, so a
          // below-placed menu would immediately clamp against the viewport.
          placement: dockedRight ? "above-end" : "above-start",
          width: 220,
          gap: 2,
          sections: [
            {
              title: "Add pane",
              items: (["claude", "codex", "gemini", "shell"] as const).map((type) => ({
                actionId: `split:${type}`,
                label: TERMINAL_CONFIGS[type].label,
                iconId: `cli-${type}`,
                badge: cliYolo[type] ? "YOLO" : undefined,
                trailing: {
                  actionId: `split-down:${type}`,
                  iconId: "split-down",
                  title: "Split Down",
                },
              })),
            },
          ],
        }
      : null,
    onAction: (actionId) => {
      const [verb, type] = actionId.split(":");
      if (verb === "split") {
        window.dispatchEvent(new CustomEvent("made:split-terminal", { detail: { type } }));
      } else if (verb === "split-down") {
        window.dispatchEvent(
          new CustomEvent("made:split-terminal", { detail: { type, direction: "vertical" } }),
        );
      }
    },
    onClose: () => setShowAddPaneMenu(false),
  });

  // ── Inline rename ────────────────────────────────────────────────────────
  const renameTab = useAppStore((s) => s.renameTab);
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const commitRename = (tabId: string) => {
    if (renameValue.trim()) renameTab(tabId, renameValue.trim());
    setRenamingTabId(null);
  };

  // ── Jira ticket trees ────────────────────────────────────────────────────
  // A project's tree is open when its tab is active; anything else is an
  // explicit user toggle, held here rather than persisted. That mirrors what
  // the rail did (it only ever showed the active tab's tickets) and keeps the
  // strip free of a new persisted key.
  const [treeOverrides, setTreeOverrides] = useState<Map<string, boolean>>(new Map());
  const isTreeOpen = (tabId: string) => treeOverrides.get(tabId) ?? tabId === activeTabId;
  const toggleTree = (tabId: string) =>
    setTreeOverrides((prev) => {
      const next = new Map(prev);
      next.set(tabId, !(prev.get(tabId) ?? tabId === activeTabId));
      return next;
    });

  // Compact-mode ticket flyout. One at a time, so a single anchor ref is all
  // that is needed — it is pointed at the clicked cluster before opening.
  const [flyoutTabId, setFlyoutTabId] = useState<string | null>(null);
  // A click-opened flyout stays until dismissed; a hover-opened one closes on
  // hover-out. Tracked here because the overlay only reports the gesture.
  const [flyoutByHover, setFlyoutByHover] = useState(false);
  const flyoutAnchorRef = useRef<HTMLElement | null>(null);
  const flyoutTab = flyoutTabId ? tabs.find((t) => t.id === flyoutTabId) : undefined;
  useEffect(() => {
    // Expanding shows the tree instead; a flyout left open would be orphaned
    // over the content with nothing anchoring it.
    if (!compact) setFlyoutTabId(null);
  }, [compact]);

  // Each mounted tree publishes itself here. registerSurfaceActions is keyed by
  // ROLE and overwrites (surface-actions.ts), so the strip registers ONCE and
  // resolves the owning project from the clicked row — several trees can be
  // open at the same time and a per-tree registration would clobber.
  const treesRef = useRef(new Map<string, TicketTreeEntry>());
  const registerTree = useCallback((tabId: string, entry: TicketTreeEntry | null) => {
    if (entry) treesRef.current.set(tabId, entry);
    else treesRef.current.delete(tabId);
  }, []);

  useEffect(() => {
    registerSurfaceActions(
      "jira-ticket",
      buildJiraTicketActions((id) => {
        for (const entry of treesRef.current.values()) {
          const row = entry.getRows().find((r) => r.session.id === id);
          if (!row) continue;
          const owner = entry.getTab();
          return {
            row,
            tab: owner,
            missing: entry.getMissing(),
            focusTerminal: (terminalId) => focusTerminalInTab(owner.id, terminalId),
            openRow: entry.openRow,
          };
        }
        return null;
      }),
    );
    // Assigned/Unassigned rows carry a composite `<tabId>::<qualifiedKey>` id
    // precisely so this resolver can name the project without searching for it.
    const resolveListRow = (id: string) => {
      const sep = id.indexOf("::");
      if (sep < 0) return null;
      const entry = treesRef.current.get(id.slice(0, sep));
      return entry ? { tab: entry.getTab(), qkey: id.slice(sep + 2) } : null;
    };
    registerSurfaceActions("jira-assigned", buildJiraAssignedActions(resolveListRow));
    registerSurfaceActions("jira-unassigned", buildJiraUnassignedActions(resolveListRow));
    return () => {
      unregisterSurfaceActions("jira-ticket");
      unregisterSurfaceActions("jira-assigned");
      unregisterSurfaceActions("jira-unassigned");
    };
  }, []);

  const [isMaximized, setIsMaximized] = useState(false);
  useEffect(() => {
    const win = getCurrentWindow();
    win.isMaximized().then(setIsMaximized);
    let unlisten: (() => void) | undefined;
    win.onResized(async () => setIsMaximized(await win.isMaximized())).then((u) => {
      unlisten = u;
    });
    return () => { unlisten?.(); };
  }, []);

  // Poll terminal-activity state once per second so the per-tab WIP badge
  // updates while AI CLIs are streaming output. Same reason as v1: without it,
  // isTerminalActive() is read once at mount and never refreshed.
  const [, setActivityTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setActivityTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const handleMinimize = async () => {
    const win = getCurrentWindow();
    if (await win.isMaximized()) {
      const { invoke } = await import("@tauri-apps/api/core");
      invoke("minimize_from_maximized").catch(() => win.minimize());
    } else {
      win.minimize();
    }
  };

  const handleMaximizeToggle = async () => {
    const win = getCurrentWindow();
    if (await win.isMaximized()) win.unmaximize();
    else win.maximize();
  };

  // App's onCloseRequested decides whether to confirm; QuitConfirmModal (App
  // level, always mounted) answers it. Never window.confirm + close() here —
  // close() re-enters the interception and the app becomes unquittable.
  const handleClose = () => {
    getCurrentWindow().close();
  };

  const handleSidebarClick = () => {
    if (!sidebarOpen) useAppStore.getState().setSettingsPanelOpen(false);
    toggleSidebar();
  };

  const handleDevServersClick = () => {
    if (!devServerPanelOpen) useAppStore.getState().setSettingsPanelOpen(false);
    toggleDevServerPanel();
  };

  const handleSettingsClick = () => {
    if (!settingsPanelOpen) {
      useAppStore.setState({ sidebarOpen: false, devServerPanelOpen: false });
    }
    useAppStore.getState().toggleSettingsPanel();
  };

  const handleTasksClick = () => {
    const store = useAppStore.getState();
    const tab = store.tabs.find((t) => t.id === store.activeTabId);
    if (!tab || !tab.layout || tab.isDevServerTab || tab.isServersTab || tab.isKanbanTab || tab.isSettingsTab) return;
    const existingId = findKanbanPaneId(tab.layout);
    if (existingId) {
      const newLayout = removePane(tab.layout, existingId);
      if (newLayout) store.updateTabLayout(tab.id, newLayout);
      return;
    }
    const newLayout = addKanbanPane(tab.layout);
    if (newLayout) store.updateTabLayout(tab.id, newLayout);
  };

  const handleBrowserClick = () => {
    const store = useAppStore.getState();
    const tab = store.tabs.find((t) => t.id === store.activeTabId);
    if (!tab || !tab.layout || tab.isDevServerTab || tab.isServersTab || tab.isKanbanTab || tab.isSettingsTab || tab.isJiraProject) return;
    const existing = findAllBrowserPanes(tab.layout);
    if (existing.length > 0) {
      let newLayout: import("../types").PaneLayout | null = tab.layout;
      for (const bp of existing) {
        if (!newLayout) break;
        newLayout = removePane(newLayout, bp.id);
      }
      store.updateTabLayout(tab.id, newLayout);
      return;
    }
    // Bind the new browser pane to this tab so it tracks the live dev-server
    // URL and shows a "Waiting for dev server" state until the port is bound.
    const ds = getQuickOpenServer(store, { tabId: tab.id }, { requireRunning: true });
    const url = ds ? `http://localhost:${ds.port}` : "about:blank";
    if (store.browserFullColumn) {
      const { layout } = store.browserSpawnLeft
        ? addBrowserPaneLeft(tab.layout, url, 35, tab.id)
        : addBrowserPaneRight(tab.layout, url, 35, tab.id);
      store.updateTabLayout(tab.id, layout);
    } else {
      const newPane = { type: "browser" as const, id: generatePaneId(), url, linkedTabId: tab.id };
      const newLayout = addPaneAsGrid(tab.layout, newPane, store.wideGridLayout);
      store.updateTabLayout(tab.id, newLayout);
    }
  };

  const activeHasBrowser = activeTab?.layout
    ? findAllBrowserPanes(activeTab.layout).length > 0
    : false;

  // ── Drag-resize of the expanded width ────────────────────────────────────
  // Measured against the strip's own rect rather than a captured start offset,
  // so a docked-right strip resizes the correct direction without a sign flag.
  const handleResizeDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (compact) return;
      if (e.button !== 0) return;
      e.preventDefault();
      const el = rootRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // DOCUMENT listeners and NO pointer capture, same reasoning as the
      // ticket rail's handle: capture stuck whenever a native pane HWND ate
      // the release mid-drag, freezing the strip with every later click
      // retargeted to the handle. The `buttons` check makes any lost-release
      // path self-heal on the first button-up mouse move.
      function end() {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", end);
        document.removeEventListener("pointercancel", end);
        window.removeEventListener("blur", end);
      }
      function move(ev: PointerEvent) {
        if ((ev.buttons & 1) === 0) {
          end();
          return;
        }
        const next = dockedRight ? rect.right - ev.clientX : ev.clientX - rect.left;
        setWideWidth(next);
      }
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", end);
      document.addEventListener("pointercancel", end);
      window.addEventListener("blur", end);
    },
    [compact, dockedRight, setWideWidth],
  );

  // ── Action grid ──────────────────────────────────────────────────────────
  // v1's three labelled full-width rows, folded into one wrapping row of icon
  // buttons. Basis (not a fixed width) so conditional buttons flow onto a
  // second line instead of needing a bespoke layout per combination.
  //
  // The grid NEVER drops a button. v1 hid Explorer/Servers/Browser outright on
  // a Jira tab, which was survivable when they were full-width rows (the strip
  // just got shorter) but in a grid it left a single lone gear that reads as a
  // broken app. Anything that cannot apply right now is DISABLED with a reason
  // instead, so the toolbar keeps one constant shape.
  const gridBasis = compact ? "50%" : "25%";
  const gridButton = (
    key: string,
    label: string,
    icon: React.ReactNode,
    onClick: (() => void) | undefined,
    lit: boolean,
    badge?: number,
    reason?: string,
  ) => (
    <div
      key={key}
      onClick={onClick}
      data-tooltip={reason ? `${label} — ${reason}` : label}
      aria-label={label}
      aria-disabled={onClick ? undefined : true}
      role="button"
      style={{
        flex: `0 0 ${gridBasis}`,
        height: GRID_ROW_HEIGHT,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        cursor: onClick ? "pointer" : "not-allowed",
        opacity: onClick ? 1 : 0.4,
        backgroundColor: lit ? "var(--ezy-tab-active)" : "transparent",
        color: lit ? "var(--ezy-accent)" : "var(--ezy-text-muted)",
        transition: "background-color 120ms ease, color 120ms ease",
      }}
      onMouseEnter={(e) => {
        if (!lit && onClick) e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
      }}
      onMouseLeave={(e) => {
        if (!lit) e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      {icon}
      {badge !== undefined && badge > 0 && (
        <span
          style={{
            position: "absolute",
            top: 4,
            right: compact ? 8 : "50%",
            marginRight: compact ? 0 : -18,
            minWidth: 14,
            height: 14,
            borderRadius: "calc(var(--ezy-radius-scale, 1) * 7px)",
            backgroundColor: "var(--ezy-accent)",
            border: "1px solid var(--ezy-bg)",
            fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
            fontWeight: 700,
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            lineHeight: 1,
            padding: "0 4px",
          }}
        >
          {badge}
        </span>
      )}
    </div>
  );

  // Reasons, not removals — see the note on gridButton.
  const noProject = activeIsProject ? undefined : "no project tab is active";
  const browserReason = activeTab?.isJiraProject
    ? "each Jira ticket owns its own browser pane"
    : noProject;
  const gridItems: React.ReactNode[] = [
    gridButton("explorer", "Explorer", <BiSidebar size={15} color="currentColor" />, handleSidebarClick, sidebarOpen),
    gridButton("servers", "Dev Servers", <FaServer size={14} color="currentColor" />, handleDevServersClick, devServerPanelOpen, runningDevCount),
    // Settings sits immediately left of Browser — in compact's 2-up grid that
    // puts the pair on one row, and it frees the bottom strip for the collapse
    // chevron alone.
    gridButton("settings", "Settings", <FaGear size={14} color="currentColor" />, handleSettingsClick, settingsPanelOpen),
    gridButton(
      "browser",
      "Browser Preview",
      activeHasBrowser
        ? <TbBrowserMinus size={16} color="currentColor" />
        : <TbBrowserPlus size={16} color="currentColor" />,
      browserReason ? undefined : handleBrowserClick,
      activeHasBrowser,
      undefined,
      browserReason,
    ),
  ];
  if (showKanbanButton) {
    gridItems.push(
      gridButton(
        "tasks",
        "Tasks",
        <PiKanbanDuotone size={18} color="currentColor" />,
        noProject ? undefined : handleTasksClick,
        false,
        undefined,
        noProject,
      ),
    );
  }
  if (showMiniGamesButton) {
    gridItems.push(
      gridButton(
        "games",
        "Mini Games",
        <PiGameControllerDuotone size={18} color="currentColor" />,
        () => useAppStore.getState().toggleGameSidebar(),
        gameSidebarOpen,
      ),
    );
  }

  return (
    <div
      ref={rootRef}
      data-vertical-tabbar="v2"
      style={{
        width: stripWidth,
        flexShrink: 0,
        height: "100%",
        backgroundColor: "var(--ezy-bg)",
        // The border faces the main content, whichever side we're docked on.
        ...(dockedRight
          ? { borderLeft: "1px solid var(--ezy-border)" }
          : { borderRight: "1px solid var(--ezy-border)" }),
        display: "flex",
        flexDirection: "column",
        position: "relative",
        zIndex: 60,
      }}
    >
      {/* TOP — window controls */}
      <div
        style={{
          display: "flex",
          alignItems: "stretch",
          height: 32,
          flexShrink: 0,
          borderBottom: "1px solid var(--ezy-border-subtle)",
        }}
      >
        <div
          onClick={handleClose}
          data-tooltip="Close"
          style={{
            width: compact ? 24 : 40,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            transition: "background-color 120ms ease",
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = "#c42b1c";
            const svg = e.currentTarget.querySelector("svg");
            if (svg) svg.style.stroke = "#fff";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = "transparent";
            const svg = e.currentTarget.querySelector("svg");
            if (svg) svg.style.stroke = "var(--ezy-text-secondary)";
          }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--ezy-text-secondary)" strokeWidth="1.2" strokeLinecap="round">
            <line x1="1.5" y1="1.5" x2="10.5" y2="10.5" />
            <line x1="10.5" y1="1.5" x2="1.5" y2="10.5" />
          </svg>
        </div>

        <div
          onClick={handleMaximizeToggle}
          data-tooltip={isMaximized ? "Restore" : "Maximize"}
          style={{
            width: compact ? 24 : 40,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            transition: "background-color 120ms ease",
            flexShrink: 0,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.06)")}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
        >
          {isMaximized ? (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--ezy-text-secondary)" strokeWidth="1">
              <rect x="1.5" y="3.5" width="7" height="7" />
              <polyline points="3.5,3.5 3.5,1.5 10.5,1.5 10.5,8.5 8.5,8.5" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--ezy-text-secondary)" strokeWidth="1">
              <rect x="1.5" y="1.5" width="9" height="9" />
            </svg>
          )}
        </div>

        <div
          onClick={handleMinimize}
          data-tooltip="Minimize"
          style={{
            width: compact ? 24 : 40,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            transition: "background-color 120ms ease",
            flexShrink: 0,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.06)")}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <line x1="1" y1="5.5" x2="11" y2="5.5" stroke="var(--ezy-text-secondary)" strokeWidth="1" />
          </svg>
        </div>

        {/* App-owned drag path; avoids Windows' native frame during restore drags.
            The "+" that used to sit here now lives in the pinned list footer. */}
        <div onPointerDown={startCustomWindowDrag} onDoubleClick={toggleMaximizeOnDoubleClick} style={{ flex: 1, minWidth: 0 }} />
      </div>

      {/* ACTION GRID — Explorer / Servers / Browser / Tasks / Games */}
      {gridItems.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            // Centres a partial last row — with an odd item count in compact's
            // 2-up grid the leftover button would otherwise hang off to one side.
            justifyContent: "center",
            flexShrink: 0,
            borderBottom: "1px solid var(--ezy-border-subtle)",
          }}
        >
          {gridItems}
        </div>
      )}

      {/* MIDDLE — scrollable tab list */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          overflowX: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div ref={listRef} data-ctx-surface="tabstrip" style={{ display: "flex", flexDirection: "column" }}>
          {visibleTabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const isUserPinned = !!tab.isPinned;
            const dirKey = (tab.workingDir ?? "").replace(/\\/g, "/");
            const colorId = localColors[dirKey];
            const tabColor = colorId ? getProjectColor(colorId) : null;
            const termIds = tab.layout ? findAllTerminalIds(tab.layout) : [];
            const cliCount = termIds.length;
            const activeCount = termIds.filter((id) => isTerminalActive(id)).length;
            const label = tab.customName ?? tab.name;
            // Jira projects grow a ticket tree. The count comes straight from
            // the store rather than the rows hook — the badge has to show even
            // while the tree is closed and the hook unmounted.
            const isJira = !!tab.isJiraProject;
            const ticketCount = isJira
              ? (projectSessions[dirKey] ?? []).filter((s) => !!s.ticket && !s.archived).length
              : 0;
            const treeOpen = isJira && !compact && isTreeOpen(tab.id);
            const dots = isJira && compact
              ? ticketDots(tab, projectSessions[dirKey])
              : { open: 0, closed: 0 };
            // Dev-server quick-open: the tab NAME is the click target, hover
            // underlines it like a link. Compact has no name to click.
            const quickDs = !compact && devServerTabIcon !== "off" && (devServerTabIcon === "all" || isActive)
              ? getQuickOpenServer(
                  { devServers, recentProjects },
                  { tabId: tab.id, workingDir: tab.workingDir, serverId: tab.serverId },
                  { requireRunning: true },
                )
              : null;

            return (
              // Wrapper carries the RAIL. It spans the project row and that
              // project's ticket tree, which is the whole point of the gutter:
              // one unbroken bar per project.
              <div key={tab.id} style={{ display: "contents" }}>
                {/* Drop placeholder — a gap the height of the dragged row. */}
                {dragState && dragState.insertBeforeId === tab.id && (
                  <div
                    style={{
                      height: dragState.rowHeight,
                      flexShrink: 0,
                      backgroundColor: "var(--ezy-surface)",
                      borderTop: "1px solid var(--ezy-border-subtle)",
                      borderBottom: "1px solid var(--ezy-border-subtle)",
                    }}
                  />
                )}
                {/* The dragged row itself is unmounted while the ghost flies —
                    the placeholder above stands in for it. */}
                {dragState?.tabId === tab.id ? null : (
                <div
                  style={{
                    position: "relative",
                    ...(dockedRight
                      ? { borderRight: `${RAIL_WIDTH}px solid ${tabColor ?? "transparent"}` }
                      : { borderLeft: `${RAIL_WIDTH}px solid ${tabColor ?? "transparent"}` }),
                  }}
                >
                <button
                  role="tab"
                  aria-selected={isActive}
                  // Raises the SAME tab context menu as the horizontal bar —
                  // the menu engine resolves any element carrying data-tab-id.
                  data-tab-id={tab.id}
                  onClick={() => {
                    // A drag that ended over this row must not also activate it.
                    if (didDragRef.current) return;
                    setActiveTab(tab.id);
                  }}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    const r = e.currentTarget.getBoundingClientRect();
                    dragStartRef.current = {
                      tabId: tab.id,
                      offsetY: e.clientY - r.top,
                      startX: e.clientX,
                      startY: e.clientY,
                      rowHeight: r.height,
                      rowLeft: r.left,
                      rowWidth: r.width,
                    };
                    didDragRef.current = false;
                  }}
                  className="group"
                  data-tooltip={compact ? label : tab.workingDir}
                  aria-label={compact ? label : undefined}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: compact ? "center" : "flex-start",
                    gap: compact ? 0 : 8,
                    padding: compact ? "0 4px" : "0 8px 0 8px",
                    // "Show path in tabs" adds a second line under the name, so
                    // the row has to grow with it or the path is clipped.
                    height: !compact && showTabPath && tab.workingDir ? 40 : TAB_ROW_HEIGHT,
                    position: "relative",
                    backgroundColor: isActive ? "var(--ezy-tab-active)" : "transparent",
                    backgroundImage: isUserPinned
                      ? "repeating-linear-gradient(135deg, transparent, transparent 4px, rgba(255,255,255,0.05) 4px, rgba(255,255,255,0.05) 8px)"
                      : undefined,
                    // No per-row hairline: the rail and the indent carry the
                    // grouping. This is where the tree's vertical room comes from.
                    border: "none",
                    cursor: "pointer",
                    fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                    fontWeight: isActive ? 500 : 400,
                    color: isActive ? "var(--ezy-text)" : "var(--ezy-text-muted)",
                    fontFamily: "inherit",
                    transition: "background-color 120ms ease, color 120ms ease",
                    outline: "none",
                    textAlign: "left",
                    width: "100%",
                    userSelect: "none",
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) e.currentTarget.style.backgroundColor = "transparent";
                  }}
                >
                  {/* Initials chip — neutral in BOTH modes. The rail is the one
                      colour carrier; a coloured chip beside it would say the
                      same thing twice. */}
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 24,
                      height: 20,
                      borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                      fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
                      fontWeight: 700,
                      letterSpacing: "0.02em",
                      backgroundColor: "var(--ezy-surface-raised)",
                      color: isActive ? "var(--ezy-text)" : "var(--ezy-text-secondary)",
                      flexShrink: 0,
                    }}
                  >
                    {tabInitials(label)}
                  </span>

                  {!compact && renamingTabId === tab.id ? (
                    <input
                      ref={renameInputRef}
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={(e) => e.stopPropagation()}
                      onBlur={() => commitRename(tab.id)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") commitRename(tab.id);
                        else if (e.key === "Escape") setRenamingTabId(null);
                      }}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        background: "var(--ezy-surface-raised)",
                        border: "1px solid var(--ezy-border-light)",
                        borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
                        outline: "none",
                        padding: "1px 4px",
                        fontFamily: "inherit",
                        fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                        color: "var(--ezy-text)",
                      }}
                    />
                  ) : !compact ? (
                    <span
                      role={quickDs ? "button" : undefined}
                      aria-label={quickDs ? "Open dev server in browser" : undefined}
                      data-tooltip={quickDs ? `Open localhost:${quickDs.port} in browser` : undefined}
                      data-tooltip-hint={quickDs ? "Ctrl+Click opens the MADE browser pane" : undefined}
                      onClick={quickDs ? (e) => {
                        // stopPropagation even in "all" mode: opening a
                        // background project's URL must not also switch tabs.
                        e.stopPropagation();
                        if (e.detail > 1) return;
                        openDevServerUrl(quickDs, { inApp: wantsInAppOpen(e) });
                      } : undefined}
                      onMouseEnter={quickDs ? (e) => {
                        e.currentTarget.style.color = "var(--ezy-text)";
                        e.currentTarget.style.textDecoration = "underline";
                      } : undefined}
                      onMouseLeave={quickDs ? (e) => {
                        e.currentTarget.style.color = "";
                        e.currentTarget.style.textDecoration = "";
                      } : undefined}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        ...(quickDs ? {
                          cursor: "pointer",
                          transition: "color 120ms ease",
                          textUnderlineOffset: 3,
                        } : null),
                      }}
                      onDoubleClick={(e) => {
                        // Double-click renames. stopPropagation so a quickDs
                        // link doesn't also fire — its own handler already
                        // ignores e.detail > 1, this covers the non-link case.
                        e.stopPropagation();
                        setRenameValue(label);
                        setRenamingTabId(tab.id);
                        setTimeout(() => renameInputRef.current?.select(), 0);
                      }}
                    >
                      {label}
                      {showTabPath && tab.workingDir && (
                        <span
                          style={{
                            display: "block",
                            fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
                            opacity: 0.5,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            lineHeight: 1.2,
                          }}
                        >
                          {truncateTabPath(tab.workingDir, 2)}
                        </span>
                      )}
                    </span>
                  ) : null}

                  {/* Remote project: a rack icon, so an SSH tab is never
                      mistaken for a local one at a glance. */}
                  {!compact && tab.serverId && (
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ flexShrink: 0 }}
                      data-tooltip={remoteServers.find((s) => s.id === tab.serverId)?.name ?? "Remote project"}
                    >
                      <rect x="2" y="2.5" width="12" height="4" rx="1" />
                      <rect x="2" y="9.5" width="12" height="4" rx="1" />
                      <line x1="4.5" y1="4.5" x2="4.5" y2="4.5" />
                      <line x1="4.5" y1="11.5" x2="4.5" y2="11.5" />
                    </svg>
                  )}

                  {/* Remote project failed to load — retry in place rather than
                      making the user close and reopen the tab. */}
                  {!compact && tab.serverId && remoteBrowse[tab.id]?.state === "failed" && (() => {
                    const retrying = !!remoteBrowse[tab.id]?.retrying;
                    const server = remoteServers.find((s) => s.id === tab.serverId);
                    return (
                      <span
                        role="button"
                        aria-label="Retry loading remote project"
                        data-tooltip={`Can’t reach ${server?.name ?? "the server"} — click to retry`}
                        onClick={(e) => {
                          e.stopPropagation();
                          void requestRemoteReload(tab.id, server);
                        }}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: 14,
                          height: 14,
                          flexShrink: 0,
                          cursor: retrying ? "default" : "pointer",
                          color: "var(--ezy-red)",
                          transition: "color 120ms ease",
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--ezy-text)")}
                        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--ezy-red)")}
                      >
                        <FaArrowRotateRight size={9} className={retrying ? "ezy-spin" : undefined} />
                      </span>
                    );
                  })()}

                  {!compact && tab.isHibernated && (
                    <span
                      data-tooltip={`Hibernated — ${cliCount} pane${cliCount === 1 ? "" : "s"} sleeping. Click to wake (Claude sessions resume).`}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        lineHeight: 1,
                        padding: "1px 4px",
                        borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                        backgroundColor: "var(--ezy-surface-raised)",
                        border: "1px solid var(--ezy-border)",
                        color: "var(--ezy-text-muted)",
                        flexShrink: 0,
                      }}
                    >
                      <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M9.598 1.591a.749.749 0 01.785-.175 7.001 7.001 0 11-8.967 8.967.75.75 0 01.961-.96 5.5 5.5 0 007.046-7.046.75.75 0 01.175-.786zm1.616 1.945a7 7 0 01-7.678 7.678 5.499 5.499 0 107.678-7.678z" />
                      </svg>
                    </span>
                  )}
                  {compact && tab.isHibernated && (
                    <span
                      data-tooltip="Hibernated — click to wake"
                      style={{
                        position: "absolute",
                        top: 3,
                        right: 3,
                        width: 8,
                        height: 8,
                        borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                        backgroundColor: "var(--ezy-surface-raised)",
                        border: "1px solid var(--ezy-border)",
                      }}
                    />
                  )}

                  {/* Jira projects count TICKETS; a pane count would just be
                      "two per ticket" and tell the user nothing. */}
                  {!compact && isJira && ticketCount > 0 && !tab.isHibernated && (
                    <span
                      data-tooltip={`${ticketCount} ticket${ticketCount === 1 ? "" : "s"}`}
                      style={{
                        fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
                        fontWeight: 600,
                        lineHeight: 1,
                        padding: "1px 4px",
                        borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                        backgroundColor: "var(--ezy-surface-raised)",
                        border: "1px solid var(--ezy-border)",
                        color: "var(--ezy-text-secondary)",
                        flexShrink: 0,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {ticketCount}
                    </span>
                  )}

                  {!compact && !isJira && cliCount > 1 && !tab.isHibernated && (
                    <span
                      style={{
                        fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
                        fontWeight: 600,
                        lineHeight: 1,
                        padding: "1px 4px",
                        borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                        position: "relative",
                        backgroundColor: "var(--ezy-surface-raised)",
                        border: "1px solid var(--ezy-border)",
                        color: "var(--ezy-text-secondary)",
                        flexShrink: 0,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {cliCount}
                      {activeCount > 0 && (
                        <span
                          style={{
                            position: "absolute",
                            top: -7,
                            right: -8,
                            minWidth: 12,
                            height: 12,
                            borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
                            backgroundColor: "var(--ezy-accent)",
                            border: "1px solid var(--ezy-bg)",
                            fontSize: "calc(var(--ezy-font-scale, 1) * 7px)",
                            fontWeight: 700,
                            color: "#fff",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            lineHeight: 1,
                            padding: "0 2px",
                          }}
                        >
                          {activeCount}
                        </span>
                      )}
                    </span>
                  )}

                  {compact && activeCount > 0 && (
                    <span
                      data-tooltip={`${activeCount} working`}
                      style={{
                        position: "absolute",
                        top: 3,
                        right: 3,
                        width: 8,
                        height: 8,
                        borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                        backgroundColor: "var(--ezy-accent)",
                        border: "1px solid var(--ezy-bg)",
                      }}
                    />
                  )}

                  {compact && !isUserPinned && (
                    <span
                      role="button"
                      aria-label="Close tab"
                      className="opacity-0 group-hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeTab(tab.id);
                      }}
                      style={{
                        position: "absolute",
                        top: 2,
                        left: 2,
                        width: 14,
                        height: 14,
                        borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: "var(--ezy-bg)",
                        border: "1px solid var(--ezy-border)",
                        cursor: "pointer",
                        transition: "opacity 120ms ease",
                      }}
                    >
                      <FaXmark size={8} color="var(--ezy-text-muted)" />
                    </span>
                  )}

                  <div
                    style={{
                      display: compact ? "none" : "flex",
                      alignItems: "center",
                      gap: 6,
                      flexShrink: 0,
                    }}
                  >
                    {!isUserPinned && (
                      <FaXmark
                        size={10}
                        color="currentColor"
                        className="opacity-0 group-hover:opacity-40 hover:!opacity-100"
                        style={{ cursor: "pointer", transition: "opacity 120ms ease" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          removeTab(tab.id);
                        }}
                      />
                    )}
                    {isUserPinned ? (
                      <AiFillPushpin
                        size={10}
                        color="var(--ezy-accent)"
                        className="opacity-0 group-hover:opacity-40 hover:!opacity-100"
                        style={{ cursor: "pointer", transition: "opacity 120ms ease" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          togglePinTab(tab.id);
                        }}
                      />
                    ) : (
                      <AiOutlinePushpin
                        size={10}
                        color="currentColor"
                        className="opacity-0 group-hover:opacity-40 hover:!opacity-100"
                        style={{ cursor: "pointer", transition: "opacity 120ms ease" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          togglePinTab(tab.id);
                        }}
                      />
                    )}
                  </div>

                  {/* Disclosure for the ticket tree. Always rendered on a Jira
                      project (never hover-revealed) — it is the only way to
                      reach the tickets, so it must not hide. */}
                  {!compact && isJira && (
                    <span
                      role="button"
                      tabIndex={-1}
                      aria-expanded={treeOpen}
                      aria-label={treeOpen ? "Hide tickets" : "Show tickets"}
                      data-tooltip={treeOpen ? "Hide tickets" : "Show tickets"}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleTree(tab.id);
                      }}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 14,
                        flexShrink: 0,
                        cursor: "pointer",
                        color: "currentColor",
                      }}
                    >
                      <svg
                        width="9"
                        height="9"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{
                          transform: treeOpen ? "rotate(90deg)" : "none",
                          transition: "transform 140ms ease-out",
                        }}
                      >
                        <path d="M6 3l5 5-5 5" />
                      </svg>
                    </span>
                  )}
                </button>

                {/* Compact ticket cluster — filled = open pane, hollow =
                    closed. Click opens the flyout; hover does too, but only
                    under the same setting that governs the tab bar's other
                    hover-open menus. */}
                {compact && isJira && (dots.open > 0 || dots.closed > 0) && (
                  <div
                    role="button"
                    tabIndex={-1}
                    aria-label={`${ticketCount} ticket${ticketCount === 1 ? "" : "s"}`}
                    data-tooltip={`${dots.open} open, ${dots.closed} closed`}
                    onClick={(e) => {
                      flyoutAnchorRef.current = e.currentTarget;
                      setFlyoutByHover(false);
                      setFlyoutTabId((cur) => (cur === tab.id ? null : tab.id));
                    }}
                    onMouseEnter={
                      hoverOpenMenus
                        ? (e) => {
                            flyoutAnchorRef.current = e.currentTarget;
                            setFlyoutByHover(true);
                            setFlyoutTabId(tab.id);
                          }
                        : undefined
                    }
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 3,
                      height: 12,
                      cursor: "pointer",
                      backgroundColor: isActive ? "var(--ezy-tab-active)" : "transparent",
                    }}
                  >
                    {Array.from({ length: Math.min(dots.open, 4) }).map((_, i) => (
                      <span
                        key={`o${i}`}
                        style={{
                          width: 5,
                          height: 5,
                          borderRadius: "50%",
                          backgroundColor: tabColor ?? "var(--ezy-text-secondary)",
                        }}
                      />
                    ))}
                    {Array.from({ length: Math.min(dots.closed, 4 - Math.min(dots.open, 4)) }).map((_, i) => (
                      <span
                        key={`c${i}`}
                        style={{
                          width: 5,
                          height: 5,
                          borderRadius: "50%",
                          border: "1px solid var(--ezy-text-muted)",
                        }}
                      />
                    ))}
                  </div>
                )}

                {treeOpen && <VerticalTicketTree tab={tab} register={registerTree} />}
                </div>
                )}
              </div>
            );
          })}
          {/* Tail placeholder — dropping past the last row appends. */}
          {dragState && dragState.insertBeforeId === null && (
            <div
              style={{
                height: dragState.rowHeight,
                flexShrink: 0,
                backgroundColor: "var(--ezy-surface)",
                borderTop: "1px solid var(--ezy-border-subtle)",
              }}
            />
          )}
        </div>

        {/* Empty space below the tabs stays grabbable to move the window. */}
        <div onPointerDown={startCustomWindowDrag} onDoubleClick={toggleMaximizeOnDoubleClick} style={{ flex: 1, minHeight: 24 }} />
      </div>

      {/* PINNED LIST FOOTER — new tab. Outside the scroll container on purpose:
          "add another" must not scroll away under a long tab list. The add-pane
          half joins it once the launch menus are shared with the horizontal bar. */}
      <div
        style={{
          display: "flex",
          alignItems: "stretch",
          height: 30,
          flexShrink: 0,
          borderTop: "1px solid var(--ezy-border-subtle)",
        }}
      >
        <div
          ref={recentBtnRef}
          onClick={() => {
            setShowAddPaneMenu(false);
            handlePlusClick();
          }}
          data-tooltip="New tab"
          role="button"
          aria-label="New tab"
          aria-expanded={showRecentMenu}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            cursor: "pointer",
            backgroundColor: showRecentMenu ? "var(--ezy-surface)" : "transparent",
            color: showRecentMenu ? "var(--ezy-text)" : "var(--ezy-text-muted)",
            fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
            transition: "background-color 120ms ease, color 120ms ease",
          }}
          onMouseEnter={(e) => {
            cancelLaunchHoverClose();
            // Same hover-to-open setting as the add-pane half next door.
            if (hoverOpenMenus && !showRecentMenu) {
              setShowAddPaneMenu(false);
              setShowRecentMenu(true);
              return;
            }
            if (!showRecentMenu) {
              e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
              e.currentTarget.style.color = "var(--ezy-text)";
            }
          }}
          onMouseLeave={(e) => {
            if (!showRecentMenu) {
              e.currentTarget.style.backgroundColor = "transparent";
              e.currentTarget.style.color = "var(--ezy-text-muted)";
            }
          }}
        >
          <FaPlus size={10} color="currentColor" />
          {!compact && <span>New</span>}
        </div>

        <div
          ref={addPaneBtnRef}
          onClick={canAddPane ? () => setShowAddPaneMenu((v) => !v) : undefined}
          onMouseEnter={
            canAddPane
              ? (e) => {
                  e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
                  if (hoverOpenMenus) {
                    setShowRecentMenu(false);
                    setShowAddPaneMenu(true);
                  }
                }
              : undefined
          }
          onMouseLeave={(e) => {
            if (!showAddPaneMenu) e.currentTarget.style.backgroundColor = "transparent";
          }}
          data-tooltip={addPaneReason ? `Add pane — ${addPaneReason}` : "Add pane"}
          role="button"
          aria-label="Add pane"
          aria-disabled={canAddPane ? undefined : true}
          aria-expanded={showAddPaneMenu}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            cursor: canAddPane ? "pointer" : "not-allowed",
            opacity: canAddPane ? 1 : 0.4,
            borderLeft: "1px solid var(--ezy-border-subtle)",
            backgroundColor: showAddPaneMenu ? "var(--ezy-surface)" : "transparent",
            color: showAddPaneMenu ? "var(--ezy-text)" : "var(--ezy-text-muted)",
            fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
            transition: "background-color 120ms ease, color 120ms ease",
          }}
        >
          <FaChevronDown size={9} color="currentColor" />
          {!compact && <span>Pane</span>}
        </div>
      </div>

      {/* BOTTOM — git status, voice, screenshots, settings + collapse */}
      <div style={{ flexShrink: 0, borderTop: "1px solid var(--ezy-border)" }}>
        {activeTab && activeTab.workingDir && activeIsProject && (
          <div style={{ padding: compact ? "6px 3px" : "6px 10px", borderBottom: "1px solid var(--ezy-border-subtle)" }}>
            {/* key: one instance per directory — see the twin in TabBar.tsx */}
            <GitStatusBar key={`${activeTab.serverId ?? ""}:${activeTab.workingDir}`} workingDir={activeTab.workingDir} serverId={activeTab.serverId} compact={compact} />
          </div>
        )}
        {VOICE_ENABLED && (
          <div style={{ display: "flex", justifyContent: "center", padding: "8px 0 4px" }}>
            <VoiceMicButton size="vertical" />
          </div>
        )}
        <div style={{ padding: "6px 4px" }}>
          <ClipboardImageStrip orientation="vertical" />
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "stretch",
            height: GRID_ROW_HEIGHT,
            borderTop: "1px solid var(--ezy-border-subtle)",
          }}
        >
          {/* Settings moved up into the action grid; this strip is the collapse
              toggle alone, so it gets the full width and a real hit target. */}
          <div
            onClick={() => setCompact(!compact)}
            data-tooltip={compact ? "Expand tab bar" : "Collapse tab bar"}
            role="button"
            aria-label={compact ? "Expand tab bar" : "Collapse tab bar"}
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              color: "var(--ezy-text-muted)",
              transition: "background-color 120ms ease, color 120ms ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
              e.currentTarget.style.color = "var(--ezy-text)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "transparent";
              e.currentTarget.style.color = "var(--ezy-text-muted)";
            }}
          >
            {/* Collapse points toward the dock edge, expand toward the content
                — so the pair mirrors when the strip is docked right. */}
            {compact !== dockedRight ? (
              <FaChevronRight size={12} color="currentColor" />
            ) : (
              <FaChevronLeft size={12} color="currentColor" />
            )}
          </div>
        </div>
      </div>

      {/* Drag ghost — a pixel clone of the row following the pointer. */}
      {dragState && (() => {
        const ghostTab = tabs.find((t) => t.id === dragState.tabId);
        if (!ghostTab) return null;
        const ghostLabel = ghostTab.customName ?? ghostTab.name;
        const ghostDir = (ghostTab.workingDir ?? "").replace(/\\/g, "/");
        const ghostColor = getProjectColor(localColors[ghostDir] ?? null);
        return (
          <div
            style={{
              position: "fixed",
              left: dragState.rowLeft,
              top: dragState.ghostY,
              width: dragState.rowWidth,
              height: dragState.rowHeight,
              zIndex: 9998,
              pointerEvents: "none",
              display: "flex",
              alignItems: "center",
              gap: compact ? 0 : 8,
              justifyContent: compact ? "center" : "flex-start",
              padding: compact ? "0 4px" : "0 8px",
              backgroundColor: "var(--ezy-surface-raised)",
              ...(dockedRight
                ? { borderRight: `${RAIL_WIDTH}px solid ${ghostColor ?? "transparent"}` }
                : { borderLeft: `${RAIL_WIDTH}px solid ${ghostColor ?? "transparent"}` }),
              boxShadow: "0 8px 24px rgba(0,0,0,0.6)",
              cursor: "grabbing",
              fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
              color: "var(--ezy-text)",
            }}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 24,
                height: 20,
                borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
                fontWeight: 700,
                backgroundColor: "var(--ezy-surface)",
                color: "var(--ezy-text)",
                flexShrink: 0,
              }}
            >
              {tabInitials(ghostLabel)}
            </span>
            {!compact && (
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {ghostLabel}
              </span>
            )}
          </div>
        );
      })()}

      {/* Compact ticket flyout — renders no DOM here; it drives an overlay
          menu and only exists while open, which is also the only time its
          data hook runs. */}
      {compact && flyoutTab && (
        <VerticalTicketFlyout
          key={flyoutTab.id}
          tab={flyoutTab}
          anchorRef={flyoutAnchorRef}
          dockedRight={dockedRight}
          hoverTracking={flyoutByHover}
          onClose={() => setFlyoutTabId(null)}
        />
      )}

      {/* Launcher modals (Create project / Remote browse / New Jira project) —
          owned by useTabLaunchMenu so both bars host the same ones. */}
      {launchModals}

      {/* RESIZE HANDLE — on the content-facing edge, expanded only. */}
      {!compact && (
        <div
          onPointerDown={handleResizeDown}
          data-tooltip={`Drag to resize (${VERTICAL_TABBAR_MIN_WIDTH}–${VERTICAL_TABBAR_MAX_WIDTH}px)`}
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            ...(dockedRight ? { left: -2 } : { right: -2 }),
            width: 5,
            // Plain ↔ (the OS window-edge glyph), matching the ticket rail —
            // the user's pick for MADE's resize affordances (2026-08).
            cursor: "ew-resize",
            zIndex: 70,
          }}
        />
      )}
    </div>
  );
}
