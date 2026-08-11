import { useCallback, useState, useRef, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "../store";
import { useTabLaunchMenu } from "../hooks/useTabLaunchMenu";
import { getQuickOpenServer } from "../lib/dev-server-lookup";
import { openDevServerUrl, wantsInAppOpen } from "../lib/open-dev-server-url";
import { findAllTerminalIds, findAllBrowserPanes, addBrowserPaneRight, addBrowserPaneLeft, addPaneAsGrid, removePane, generatePaneId, findKanbanPaneId, addKanbanPane } from "../lib/layout-utils";
import { TERMINAL_CONFIGS } from "../lib/terminal-config";
import { getProjectColor } from "../store/recentProjectsSlice";
import { syncProjectColors } from "../lib/tab-colors";
import { isTerminalActive } from "../lib/terminal-activity";
import { startCustomWindowDrag, toggleMaximizeOnDoubleClick } from "../lib/window-chrome";
import { useRemoteBrowseStore, requestRemoteReload } from "../store/remoteBrowseStore";
import { useOverlayMenu } from "../lib/useOverlayMenu";
import ClipboardImageStrip from "./ClipboardImageStrip";
import VoiceMicButton from "./VoiceMicButton";
import { VOICE_ENABLED } from "../lib/voice/feature-flag";
import GitStatusBar from "./GitStatusBar";
import { FaChevronDown } from "react-icons/fa";
import { TbBrowserPlus, TbBrowserMinus } from "react-icons/tb";
import { FaXmark, FaPlus, FaGear, FaServer, FaArrowRotateRight } from "react-icons/fa6";
import { PiKanbanDuotone, PiGameControllerDuotone } from "react-icons/pi";
import { AiOutlinePushpin, AiFillPushpin } from "react-icons/ai";
import { BiSidebar } from "react-icons/bi";

function truncateTabPath(path: string, maxSegments = 3): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = normalized.split("/").filter(Boolean);
  return segments.slice(-maxSegments).join("/");
}

export default function TabBar() {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const removeTab = useAppStore((s) => s.removeTab);
  const togglePinTab = useAppStore((s) => s.togglePinTab);
  const reorderTabs = useAppStore((s) => s.reorderTabs);
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  // Jira mode: while a Jira project tab is active, the dev server and file
  // sidebar buttons hide — the ticket workflow doesn't use either, and the
  // slimmer bar keeps the focus on the rail + pair canvas.
  const jiraMode = useAppStore((s) => s.jiraMode ?? true);
  const hideJiraChrome =
    jiraMode && !!tabs.find((t) => t.id === activeTabId)?.isJiraProject;
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const recentProjects = useAppStore((s) => s.recentProjects);
  const servers = useAppStore((s) => s.servers);
  // Whether each tab's remote project loaded in the file sidebar. Selecting the
  // record itself (never a .filter()/.map(), which would return a fresh array
  // every render and loop) — the map is only rebuilt when a status changes.
  const remoteBrowse = useRemoteBrowseStore((s) => s.byTab);
  const cliYolo = useAppStore((s) => s.cliYolo);
  const hoverOpenAddPaneMenu = useAppStore((s) => s.hoverOpenAddPaneMenu);
  const showMiniGamesButton = useAppStore((s) => s.showMiniGamesButton ?? false);
  const gameSidebarOpen = useAppStore((s) => s.gameSidebarOpen);
  const showKanbanButton = useAppStore((s) => s.showKanbanButton ?? true);
  const devServers = useAppStore((s) => s.devServers);
  const devServerTabIcon = useAppStore((s) => s.devServerTabIcon);
  const devServerPanelOpen = useAppStore((s) => s.devServerPanelOpen);
  const toggleDevServerPanel = useAppStore((s) => s.toggleDevServerPanel);
  const projectColors = useAppStore((s) => s.projectColors);
  const setProjectColor = useAppStore((s) => s.setProjectColor);
  const settingsPanelOpen = useAppStore((s) => s.settingsPanelOpen);
  const showTabPath = useAppStore((s) => s.showTabPath);
  const renameTab = useAppStore((s) => s.renameTab);

  const [isMaximized, setIsMaximized] = useState(false);
  const [showNewTabMenu, setShowNewTabMenu] = useState(false);
  const [showServersTab] = useState(false);
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  // Tab color picker — overlay-rendered (kind "swatch-menu", backdrop).
  const tabsContainerRef = useRef<HTMLDivElement>(null);

  // Hole-cut publishers: each floating overlay publishes its viewport rect so
  // the native HWND underneath cuts a hole. Refs are conditionally attached
  // (only when the overlay is rendered); useOverlayPublisher's rAF loop
  // tolerates null refs and re-reads each frame.
  const newTabChevronRef = useRef<HTMLDivElement>(null);

  // The hook below is created before the hover timers it calls, so it reaches
  // them through refs rather than forcing a declaration-order dance.
  const cancelHoverCloseRef = useRef<() => void>(() => {});
  const scheduleHoverCloseRef = useRef<() => void>(() => {});

  // The "+" launcher (recent projects, Create/Browse/Jira, remote servers) and
  // its modals — shared verbatim with the vertical strip so both bars raise the
  // identical dialogue. Hover stays here: see the pointermove note below.
  const {
    recentBtnRef,
    showRecentMenu,
    setShowRecentMenu,
    handlePlusClick,
    launchModals,
  } = useTabLaunchMenu({
    hoverTracking: hoverOpenAddPaneMenu,
    onHoverIn: () => cancelHoverCloseRef.current(),
    onHoverOut: () => scheduleHoverCloseRef.current(),
  });

  // Hover-to-open mode: menus stay open only while the pointer is inside the
  // button or its dropdown. Leave either → grace timer → close (the grace
  // covers the pixels between button and popup, and button-to-button swaps).
  // One shared timer suffices — at most one of the two menus is open.
  const hoverCloseTimerRef = useRef<number | null>(null);
  const cancelHoverClose = useCallback(() => {
    if (hoverCloseTimerRef.current != null) {
      clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
  }, []);
  const scheduleHoverClose = useCallback(() => {
    if (!hoverOpenAddPaneMenu) return;
    cancelHoverClose();
    hoverCloseTimerRef.current = window.setTimeout(() => {
      hoverCloseTimerRef.current = null;
      setShowRecentMenu(false);
      setShowNewTabMenu(false);
    }, 160);
  }, [hoverOpenAddPaneMenu, cancelHoverClose]);
  cancelHoverCloseRef.current = cancelHoverClose;
  scheduleHoverCloseRef.current = scheduleHoverClose;
  // "Add pane" dropdown — overlay-rendered (kind "anchored-menu").
  useOverlayMenu({
    id: "tabbar-new-tab-menu",
    open: showNewTabMenu,
    anchorRef: newTabChevronRef,
    payload: showNewTabMenu
      ? {
          placement: "below-start",
          width: 220,
          gap: 2,
          hoverTracking: hoverOpenAddPaneMenu,
          sections: [
            {
              title: "Add pane",
              items: (["claude", "codex", "gemini", "shell"] as const).map(
                (type) => ({
                  actionId: `split:${type}`,
                  label: TERMINAL_CONFIGS[type].label,
                  iconId: `cli-${type}`,
                  badge: cliYolo[type] ? "YOLO" : undefined,
                  trailing: {
                    actionId: `split-down:${type}`,
                    iconId: "split-down",
                    title: "Split Down",
                  },
                }),
              ),
            },
          ],
        }
      : null,
    onAction: (actionId) => {
      if (actionId === "__hoverin__") {
        cancelHoverClose();
        return;
      }
      if (actionId === "__hoverout__") {
        scheduleHoverClose();
        return;
      }
      const [verb, type] = actionId.split(":");
      // No per-pane renderer stamp: new panes follow the global
      // `useNativeTerminalRenderer` setting (native by default). A pane can
      // still be flipped after the fact via paneRendererOverride.
      if (verb === "split") {
        window.dispatchEvent(
          new CustomEvent("made:split-terminal", { detail: { type } }),
        );
      } else if (verb === "split-down") {
        window.dispatchEvent(
          new CustomEvent("made:split-terminal", {
            detail: { type, direction: "vertical" },
          }),
        );
      }
    },
    onClose: () => setShowNewTabMenu(false),
  });
  const dragStartRef = useRef<{ tabId: string; offsetX: number; startX: number; startY: number; tabWidth: number; tabTop: number } | null>(null);
  const didDragRef = useRef(false);
  // Pending dev-server open from a tab-name click. When rename is possible
  // (showTabPath), the open is held briefly so a rename double-click can
  // cancel it — otherwise the browser would open on the first click of the
  // double-click. Single slot: only one click sequence can be live at a time.
  const devOpenTimerRef = useRef<number | null>(null);
  const [dragState, setDragState] = useState<{
    tabId: string;
    ghostX: number;
    tabTop: number;
    insertBeforeId: string | null;
    tabWidth: number;
  } | null>(null);

  // Poll terminal activity every 1s to update active pane counts
  const [activityTick, setActivityTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setActivityTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // The tab's working-dir tooltip is now `data-tooltip` on the tab itself,
  // driven by TooltipHost like every other tooltip in the app — this used to be
  // a bespoke 2s timer publishing its own overlay popup, which made the tab bar
  // the one surface with different tooltip timing and styling.

  const anyMenuOpen = showNewTabMenu || showRecentMenu;
  const closeAllMenus = useCallback(() => {
    setShowNewTabMenu(false);
    setShowRecentMenu(false);
  }, []);

  const getInsertBeforeId = useCallback((clientX: number, excludeId: string): string | null => {
    const container = tabsContainerRef.current;
    if (!container) return null;
    for (const btn of container.querySelectorAll<HTMLElement>("[data-tab-id]")) {
      if (btn.dataset.tabId === excludeId) continue;
      const { left, width } = btn.getBoundingClientRect();
      if (clientX < left + width / 2) return btn.dataset.tabId!;
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
        ghostX: e.clientX - ds.offsetX,
        tabTop: ds.tabTop,
        insertBeforeId: getInsertBeforeId(e.clientX, ds.tabId),
        tabWidth: ds.tabWidth,
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

  // Hover mode decides from pointer POSITION, not enter/leave edges.
  //
  // Edges are unreliable here for two reasons that between them produced every
  // symptom reported — menus closing under a motionless pointer, menus
  // reopening in a blink loop, and swaps that never happened:
  //
  //  1. `mouseenter` does NOT fire when an element appears under a stationary
  //     pointer. Opening a menu can therefore never be "confirmed" by the
  //     element that just appeared, and any logic waiting for that confirmation
  //     closes the menu it just opened.
  //  2. The dropdown lives in a SEPARATE overlay window whose hit region moves
  //     as the menu opens and closes, so which window owns a given pixel is
  //     itself a function of the state we are trying to compute.
  //
  // A pointermove hit-test against the two button rects has neither problem: it
  // re-evaluates on every movement and needs no event to have been delivered at
  // the right instant. While the pointer is over the DROPDOWN the main webview
  // gets no moves at all — which is exactly right, since silence there means
  // "not over a button", and the overlay's own `__hoverin__` holds the menu
  // open in that case.
  const hoverStateRef = useRef({ showRecentMenu, showNewTabMenu });
  hoverStateRef.current.showRecentMenu = showRecentMenu;
  hoverStateRef.current.showNewTabMenu = showNewTabMenu;
  useEffect(() => {
    if (!hoverOpenAddPaneMenu) return;
    if (!showRecentMenu && !showNewTabMenu) return;
    const inside = (el: HTMLElement | null, x: number, y: number) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    const onMove = (e: PointerEvent) => {
      const st = hoverStateRef.current;
      const onPlus = inside(recentBtnRef.current, e.clientX, e.clientY);
      const onChevron = inside(newTabChevronRef.current, e.clientX, e.clientY);
      if (!onPlus && !onChevron) {
        scheduleHoverClose();
        return;
      }
      cancelHoverClose();
      // Swapping between the two buttons is handled here as well as in
      // onMouseEnter, so a missed enter (see 1 above) cannot strand the wrong
      // menu open while the pointer sits on the other button.
      if (onChevron && !st.showNewTabMenu) {
        setShowRecentMenu(false);
        setShowNewTabMenu(true);
      } else if (onPlus && !st.showRecentMenu) {
        setShowNewTabMenu(false);
        setShowRecentMenu(true);
      }
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [hoverOpenAddPaneMenu, showRecentMenu, showNewTabMenu, scheduleHoverClose, cancelHoverClose]);
  // Track maximized state for window control icon
  useEffect(() => {
    const win = getCurrentWindow();
    win.isMaximized().then(setIsMaximized);
    let unlisten: (() => void) | undefined;
    const setup = async () => {
      unlisten = await win.onResized(async () => {
        setIsMaximized(await win.isMaximized());
      });
    };
    setup();
    return () => { unlisten?.(); };
  }, []);

  const renderTabIcon = (tab: typeof tabs[0], isActive: boolean) => {
    const activeColor = "var(--ezy-text)";
    const inactiveColor = "var(--ezy-text-muted)";
    const color = isActive ? activeColor : inactiveColor;

    if (tab.isKanbanTab) {
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.3" style={{ flexShrink: 0 }}>
          <rect x="1" y="2" width="4" height="12" rx="1" />
          <rect x="6" y="4" width="4" height="10" rx="1" />
          <rect x="11" y="1" width="4" height="13" rx="1" />
        </svg>
      );
    }
    if (tab.isSettingsTab) {
      return <FaGear size={13} color={color} style={{ flexShrink: 0 }} />;
    }
    if (tab.isServersTab) {
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={isActive ? "var(--ezy-cyan)" : inactiveColor} strokeWidth="1.3" style={{ flexShrink: 0 }}>
          <rect x="2" y="1" width="12" height="6" rx="1.5" />
          <rect x="2" y="9" width="12" height="6" rx="1.5" />
          <circle cx="5" cy="4" r="1" fill={isActive ? "var(--ezy-cyan)" : inactiveColor} stroke="none" />
          <circle cx="5" cy="12" r="1" fill={isActive ? "var(--ezy-cyan)" : inactiveColor} stroke="none" />
        </svg>
      );
    }
    if (tab.isDevServerTab) {
      return <FaServer size={14} color={color} style={{ flexShrink: 0 }} />;
    }
    if (tab.serverId) {
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={isActive ? "var(--ezy-cyan)" : inactiveColor} strokeWidth="1.3" style={{ flexShrink: 0 }}>
          <rect x="2" y="1" width="12" height="6" rx="1.5" />
          <rect x="2" y="9" width="12" height="6" rx="1.5" />
          <circle cx="5" cy="4" r="1" fill={isActive ? "var(--ezy-cyan)" : inactiveColor} stroke="none" />
          <circle cx="5" cy="12" r="1" fill={isActive ? "var(--ezy-cyan)" : inactiveColor} stroke="none" />
        </svg>
      );
    }
    // Default: terminal prompt icon (Warp style >_)
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        <polyline points="4,4 8,8 4,12" />
        <line x1="9" y1="12" x2="13" y2="12" />
      </svg>
    );
  };

  return (
    <>
      {/* Invisible backdrop to catch clicks outside dropdowns (Tauri drag region swallows mousedown) */}
      {anyMenuOpen && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 50 }}
          onMouseDown={closeAllMenus}
        />
      )}
      <div
        className="tab-bar flex items-stretch select-none"
        style={{
          height: 38,
          backgroundColor: "var(--ezy-bg)",
          borderBottom: "1px solid var(--ezy-border)",
          position: "relative",
          zIndex: 60,
        }}
      >
        {/* Sidebar toggle (Warp-style) — hidden in Jira mode on Jira tabs */}
        {!hideJiraChrome && (
          <div
            data-tooltip="File explorer" aria-label="File explorer"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 40,
              flexShrink: 0,
              cursor: "pointer",
              backgroundColor: sidebarOpen ? "var(--ezy-tab-active)" : "transparent",
            }}
            onClick={() => { closeAllMenus(); if (!sidebarOpen) useAppStore.getState().setSettingsPanelOpen(false); toggleSidebar(); }}
            // Guarded like the dev-server and settings toggles below: hover is a
            // step BELOW active, so painting it unconditionally would darken the
            // open toggle under the pointer.
            onMouseEnter={(e) => { if (!sidebarOpen) e.currentTarget.style.backgroundColor = "var(--ezy-surface)"; }}
            onMouseLeave={(e) => {
              if (!sidebarOpen) e.currentTarget.style.backgroundColor = "transparent";
            }}
          >
            <BiSidebar size={14} color={sidebarOpen ? "var(--ezy-accent)" : "var(--ezy-text-muted)"} />
          </div>
        )}

        {/* Dev Servers icon button — hidden in Jira mode on Jira tabs */}
        {!hideJiraChrome && (() => {
          const isDevActive = devServerPanelOpen;
          const runningCount = devServers.filter((s) => s.status === "running" || s.status === "starting").length;
          return (
            <div
              data-tooltip="Dev servers" aria-label="Dev servers"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 36,
                flexShrink: 0,
                cursor: "pointer",
                backgroundColor: isDevActive ? "var(--ezy-tab-active)" : "transparent",
                position: "relative",
                borderRight: isDevActive ? "1px solid var(--ezy-border)" : "1px solid var(--ezy-border-subtle)",
              }}
              onClick={() => { closeAllMenus(); if (!devServerPanelOpen) useAppStore.getState().setSettingsPanelOpen(false); toggleDevServerPanel(); }}
              onMouseEnter={(e) => { if (!isDevActive) e.currentTarget.style.backgroundColor = "var(--ezy-surface)"; }}
              onMouseLeave={(e) => { if (!isDevActive) e.currentTarget.style.backgroundColor = "transparent"; }}
            >
              {/* Rocket/activity icon */}
              <FaServer size={15} color={isDevActive ? "var(--ezy-accent)" : "var(--ezy-text-muted)"} />
              {runningCount > 0 && (
                <span style={{
                  position: "absolute",
                  top: 4,
                  right: 3,
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
                }}>
                  {runningCount}
                </span>
              )}
            </div>
          );
        })()}

        {/* Settings toggle */}
        <div
          data-tooltip="Settings" aria-label="Settings"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 36,
            flexShrink: 0,
            cursor: "pointer",
            backgroundColor: settingsPanelOpen ? "var(--ezy-tab-active)" : "transparent",
            borderRight: settingsPanelOpen ? "1px solid var(--ezy-border)" : "1px solid var(--ezy-border-subtle)",
          }}
          onClick={() => { closeAllMenus(); if (!settingsPanelOpen) { useAppStore.setState({ sidebarOpen: false, devServerPanelOpen: false }); } useAppStore.getState().toggleSettingsPanel(); }}
          onMouseEnter={(e) => { if (!settingsPanelOpen) e.currentTarget.style.backgroundColor = "var(--ezy-surface)"; }}
          onMouseLeave={(e) => { if (!settingsPanelOpen) e.currentTarget.style.backgroundColor = "transparent"; }}
        >
          <FaGear size={14} color={settingsPanelOpen ? "var(--ezy-accent)" : "var(--ezy-text-muted)"} />
        </div>

        {/* Tabs */}
        <div ref={tabsContainerRef} data-ctx-surface="tabstrip" style={{ display: "flex", alignItems: "stretch", minWidth: 0, overflow: "hidden" }}>
          {(() => {
            const visibleTabs = tabs.filter((t) => !t.isDevServerTab && !t.isKanbanTab && (!t.isServersTab || showServersTab) && !t.isSettingsTab);
            // Assign + dedup project colours. Shared with the vertical strip —
            // see lib/tab-colors.ts for why this could not stay inline here.
            const localColors = syncProjectColors(visibleTabs, projectColors, setProjectColor);
            return visibleTabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const isSystemTab = tab.isKanbanTab || tab.isDevServerTab || tab.isServersTab || tab.isSettingsTab;
            const isUserPinned = !!tab.isPinned;
            const normalizedDir = tab.workingDir.replace(/\\/g, "/");
            const tabColor = (!isSystemTab && normalizedDir) ? getProjectColor(localColors[normalizedDir] ?? null) : null;

            return (
              <div key={tab.id} style={{ display: "contents" }}>
                {/* Placeholder slot at this position during drag */}
                {dragState && dragState.insertBeforeId === tab.id && (
                  <div style={{ width: dragState.tabWidth, flexShrink: 0, height: "100%", borderRight: "1px solid var(--ezy-border-subtle)" }} />
                )}
                {/* Skip rendering the dragged tab — its slot is gone, others shift in */}
                {dragState?.tabId === tab.id ? null : (
                <button
                  role="tab"
                  aria-selected={isActive}
                  data-tab-id={tab.id}
                  onClick={() => {
                    if (didDragRef.current) return;
                    closeAllMenus();
                    if (tab.isSettingsTab) {
                      // No-op: settings tab is only visible when panel is open,
                      // close via X button or Ctrl+,
                    } else {
                      setActiveTab(tab.id);
                    }
                  }}
                  onPointerDown={(e) => {
                    if (e.button !== 0 || isSystemTab) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    dragStartRef.current = {
                      tabId: tab.id,
                      offsetX: e.clientX - rect.left,
                      startX: e.clientX,
                      startY: e.clientY,
                      tabWidth: rect.width,
                      tabTop: rect.top,
                    };
                    didDragRef.current = false;
                  }}
                  className="group"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "0 12px",
                    position: "relative",
                    backgroundColor: isActive ? "var(--ezy-tab-active)" : "transparent",
                    backgroundImage: isUserPinned
                      ? "repeating-linear-gradient(135deg, transparent, transparent 4px, rgba(255,255,255,0.05) 4px, rgba(255,255,255,0.05) 8px)"
                      : undefined,
                    border: "none",
                    cursor: isSystemTab ? "pointer" : "grab",
                    fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                    fontWeight: isActive ? 500 : 400,
                    color: isActive ? "var(--ezy-text)" : "var(--ezy-text-muted)",
                    fontFamily: "inherit",
                    transition: "background-color 120ms ease, color 120ms ease",
                    outline: "none",
                    // Floor evens out the strip: short-named tabs (TV, EVP)
                    // stop rendering as stubs next to long ones, without the
                    // padding/truncation costs of fully fixed-width tabs.
                    // Labels keep content sizing between the two bounds.
                    minWidth: isSystemTab ? 0 : 90,
                    maxWidth: 200,
                    height: "100%",
                    borderRight: "1px solid var(--ezy-border-subtle)",
                    borderBottom: tabColor ? `2px solid ${tabColor}` : "2px solid transparent",
                    userSelect: "none",
                  }}
                  data-tooltip={tab.workingDir || undefined}
                  onMouseEnter={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.03)";
                      e.currentTarget.style.color = "var(--ezy-text-secondary)";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.backgroundColor = "transparent";
                      e.currentTarget.style.color = "var(--ezy-text-muted)";
                    }
                  }}
                >
                  {/* Tab icon (special tabs only — no icon for regular project tabs) */}
                  {(tab.isKanbanTab || tab.isServersTab || tab.isDevServerTab || tab.isSettingsTab || tab.serverId) && renderTabIcon(tab, isActive)}

                  {/* Label with pane count and activity indicator */}
                  {!tab.isServersTab && !tab.isSettingsTab && (
                  <span
                    style={{
                      overflow: "visible",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      flex: 1,
                      minWidth: 0,
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    {(() => {
                      const termIds = tab.layout ? findAllTerminalIds(tab.layout) : [];
                      const cliCount = termIds.length;
                      // activityTick is read to trigger re-render on poll
                      void activityTick;
                      const activeCount = termIds.filter((id) => isTerminalActive(id)).length;
                      // Dev-server quick-open (Settings > Preview Panes > "Dev
                      // server link on tabs"): the tab NAME is the click target
                      // — hover underlines it like a link. "all" opens a
                      // BACKGROUND project's URL without switching tabs;
                      // "active" keeps inactive names as plain tab-switch
                      // targets. A project can run several dev servers;
                      // getQuickOpenServer honours the one the user marked in
                      // the dev-server panel.
                      const quickDs = devServerTabIcon !== "off" && !isSystemTab
                        ? getQuickOpenServer(
                            { devServers, recentProjects },
                            { tabId: tab.id, workingDir: tab.workingDir, serverId: tab.serverId },
                            { requireRunning: true },
                          )
                        : null;
                      const nameOpensDev = !!quickDs && (devServerTabIcon === "all" || isActive);
                      return (
                        <>
                          {showTabPath && !isSystemTab && renamingTabId === tab.id ? (
                            <input
                              ref={renameInputRef}
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              onBlur={() => {
                                if (renameValue.trim()) renameTab(tab.id, renameValue.trim());
                                setRenamingTabId(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  if (renameValue.trim()) renameTab(tab.id, renameValue.trim());
                                  setRenamingTabId(null);
                                }
                                if (e.key === "Escape") setRenamingTabId(null);
                                e.stopPropagation();
                              }}
                              onClick={(e) => e.stopPropagation()}
                              style={{
                                fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                                fontFamily: "inherit",
                                backgroundColor: "var(--ezy-bg)",
                                border: "1px solid var(--ezy-accent)",
                                borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
                                color: "var(--ezy-text)",
                                outline: "none",
                                padding: "0 4px",
                                width: 80,
                                lineHeight: "18px",
                              }}
                            />
                          ) : (
                            <span
                              role={nameOpensDev ? "button" : undefined}
                              aria-label={nameOpensDev ? "Open dev server in browser" : undefined}
                              data-tooltip={nameOpensDev && quickDs ? `Open localhost:${quickDs.port} in browser` : undefined}
                              data-tooltip-hint={nameOpensDev ? "Ctrl+Click opens the MADE browser pane" : undefined}
                              onClick={(e) => {
                                if (!nameOpensDev || !quickDs) return;
                                // stopPropagation even in "all" mode: opening a
                                // background project's URL must not also switch
                                // tabs (the old icon's contract).
                                e.stopPropagation();
                                if (didDragRef.current) return;
                                // Second click of a double-click — the first
                                // one already opened (or armed the timer).
                                if (e.detail > 1) return;
                                closeAllMenus();
                                const inApp = wantsInAppOpen(e);
                                if (showTabPath && !isSystemTab) {
                                  // Rename double-click shares this target —
                                  // hold the open so it can be cancelled.
                                  if (devOpenTimerRef.current) window.clearTimeout(devOpenTimerRef.current);
                                  devOpenTimerRef.current = window.setTimeout(() => {
                                    devOpenTimerRef.current = null;
                                    openDevServerUrl(quickDs, { inApp });
                                  }, 250);
                                } else {
                                  openDevServerUrl(quickDs, { inApp });
                                }
                              }}
                              onDoubleClick={(e) => {
                                if (devOpenTimerRef.current) {
                                  window.clearTimeout(devOpenTimerRef.current);
                                  devOpenTimerRef.current = null;
                                }
                                if (isSystemTab || !showTabPath) return;
                                e.stopPropagation();
                                setRenameValue(tab.customName ?? tab.name);
                                setRenamingTabId(tab.id);
                                setTimeout(() => renameInputRef.current?.select(), 0);
                              }}
                              // Link affordance appears on hover only: color
                              // lift + underline, no background box (the
                              // pane-count badge's activity dot overhangs and
                              // collides with any bg behind the label).
                              style={nameOpensDev ? {
                                cursor: "pointer",
                                transition: "color 120ms ease",
                                textUnderlineOffset: 3,
                              } : undefined}
                              onMouseEnter={nameOpensDev ? (e) => {
                                e.currentTarget.style.color = "var(--ezy-text)";
                                e.currentTarget.style.textDecoration = "underline";
                              } : undefined}
                              onMouseLeave={nameOpensDev ? (e) => {
                                e.currentTarget.style.color = "";
                                e.currentTarget.style.textDecoration = "";
                              } : undefined}
                            >
                              {showTabPath && tab.customName ? tab.customName : tab.name}
                            </span>
                          )}
                          {tab.isHibernated && (
                            <span
                              data-tooltip={`Hibernated — ${cliCount} pane${cliCount === 1 ? "" : "s"} sleeping. Click to wake (Claude sessions resume).`}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                lineHeight: 1,
                                padding: "1px 4px",
                                borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                                position: "relative" as const,
                                top: 1,
                                backgroundColor: "var(--ezy-surface-raised)",
                                border: "1px solid var(--ezy-border)",
                                color: "var(--ezy-text-muted)",
                              }}
                            >
                              <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor">
                                <path d="M9.598 1.591a.749.749 0 01.785-.175 7.001 7.001 0 11-8.967 8.967.75.75 0 01.961-.96 5.5 5.5 0 007.046-7.046.75.75 0 01.175-.786zm1.616 1.945a7 7 0 01-7.678 7.678 5.499 5.499 0 107.678-7.678z" />
                              </svg>
                            </span>
                          )}
                          {cliCount > 1 && !tab.isHibernated && (
                            <span
                              style={{
                                fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
                                fontWeight: 600,
                                lineHeight: 1,
                                padding: "1px 4px",
                                borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                                position: "relative" as const,
                                top: 1,
                                backgroundColor: "var(--ezy-surface-raised)",
                                border: "1px solid var(--ezy-border)",
                                color: "var(--ezy-text-secondary)",
                              }}
                            >
                              {cliCount}
                              {activeCount > 0 && (
                                <span style={{
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
                                }}>
                                  {activeCount}
                                </span>
                              )}
                            </span>
                          )}
                          {showTabPath && !isSystemTab && tab.workingDir && (
                            <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 10px)", color: "var(--ezy-text-muted)", opacity: 0.5, whiteSpace: "nowrap" }}>
                              {truncateTabPath(tab.workingDir, 2)}
                            </span>
                          )}
                        </>
                      );
                    })()}
                  </span>
                  )}

                  {/* Remote project the file sidebar could not load. The tree
                      retries on its own, but only while it is mounted — with
                      the sidebar closed this button is the only way back, and
                      it is also how you skip the backoff when you KNOW the
                      server just came up. Shown only while failed: reserving
                      the width on every remote tab would cost every tab,
                      always, for a rare state. Colour-only hover — a hover box
                      here collides with the pane-count badge's overhanging
                      dot. */}
                  {tab.serverId && remoteBrowse[tab.id]?.state === "failed" && (() => {
                    const retrying = !!remoteBrowse[tab.id]?.retrying;
                    const server = servers.find((s) => s.id === tab.serverId);
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
                          marginLeft: 2,
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

                  {/* Settings tab: X to close panel (hover reveal) */}
                  {tab.isSettingsTab && (
                    <FaXmark
                      size={10}
                      color="currentColor"
                      className="opacity-0 group-hover:opacity-40 hover:!opacity-100"
                      style={{ cursor: "pointer", transition: "opacity 120ms ease", flexShrink: 0, marginLeft: 6 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        useAppStore.getState().setSettingsPanelOpen(false);
                      }}
                    />
                  )}
                  {/* Right column: close (top) + pin (bottom) — hover reveal */}
                  {!isSystemTab && (
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 6,
                        flexShrink: 0,
                        marginLeft: 8,
                        marginRight: -6,
                      }}
                    >
                      {/* Close button — small X, only for unpinned tabs, hover only */}
                      {!isUserPinned && (
                        <FaXmark
                          size={10}
                          color="currentColor"
                          className="opacity-0 group-hover:opacity-40 hover:!opacity-100"
                          style={{
                            cursor: "pointer",
                            transition: "opacity 120ms ease",
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            removeTab(tab.id);
                          }}
                        />
                      )}
                      {/* Pin toggle — hover only for both states */}
                      {isUserPinned ? (
                        <AiFillPushpin
                          size={10}
                          color="var(--ezy-accent)"
                          className="opacity-0 group-hover:opacity-40 hover:!opacity-100"
                          style={{
                            cursor: "pointer",
                            transition: "opacity 120ms ease",
                          }}
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
                          style={{
                            cursor: "pointer",
                            transition: "opacity 120ms ease",
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            togglePinTab(tab.id);
                          }}
                        />
                      )}
                    </div>
                  )}
                </button>
                )}
              </div>
            );
          });
          })()}
          {/* Placeholder slot at end when dragging past all tabs */}
          {dragState && dragState.insertBeforeId === null && (
            <div style={{ width: dragState.tabWidth, flexShrink: 0, height: "100%", borderRight: "1px solid var(--ezy-border-subtle)" }} />
          )}
        </div>

        {/* Ghost tab — pixel-perfect clone of the real tab, floats under cursor */}
        {dragState && (() => {
          const ghostTab = tabs.find((t) => t.id === dragState.tabId);
          if (!ghostTab) return null;
          const gIsActive = ghostTab.id === activeTabId;
          const gIsUserPinned = !!ghostTab.isPinned;
          const gIsSystemTab = ghostTab.isKanbanTab || ghostTab.isDevServerTab || ghostTab.isServersTab || ghostTab.isSettingsTab;
          const gTermIds = ghostTab.layout ? findAllTerminalIds(ghostTab.layout) : [];
          const gCliCount = gTermIds.length;
          return (
            <div
              style={{
                position: "fixed",
                left: dragState.ghostX,
                top: dragState.tabTop,
                pointerEvents: "none",
                zIndex: 9999,
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "0 12px",
                height: 38,
                width: dragState.tabWidth,
                fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                fontWeight: gIsActive ? 500 : 400,
                color: gIsActive ? "var(--ezy-text)" : "var(--ezy-text-muted)",
                fontFamily: "inherit",
                backgroundColor: gIsActive ? "var(--ezy-tab-active)" : "var(--ezy-bg)",
                backgroundImage: gIsUserPinned
                  ? "repeating-linear-gradient(135deg, transparent, transparent 4px, rgba(255,255,255,0.05) 4px, rgba(255,255,255,0.05) 8px)"
                  : undefined,
                boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
                borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                border: "1px solid var(--ezy-border)",
                cursor: "grabbing",
                userSelect: "none",
                overflow: "hidden",
              }}
            >
              {(ghostTab.isKanbanTab || ghostTab.isServersTab || ghostTab.isDevServerTab || ghostTab.isSettingsTab || ghostTab.serverId) && renderTabIcon(ghostTab, gIsActive)}
              {!ghostTab.isServersTab && !ghostTab.isSettingsTab && (
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 4 }}>
                  <span>{ghostTab.name}</span>
                  {gCliCount > 1 && (
                    <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 9px)", fontWeight: 600, lineHeight: 1, padding: "1px 4px", borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)", position: "relative" as const, top: 1, backgroundColor: "var(--ezy-surface-raised)", border: "1px solid var(--ezy-border)", color: "var(--ezy-text-secondary)" }}>
                      {gCliCount}
                    </span>
                  )}
                </span>
              )}
              {!gIsSystemTab && (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, flexShrink: 0, marginLeft: 8, marginRight: -6 }}>
                  {!gIsUserPinned && (
                    <FaXmark size={10} color="currentColor" style={{ opacity: 0 }} />
                  )}
                  {gIsUserPinned ? (
                    <AiFillPushpin size={10} color="var(--ezy-accent)" style={{ opacity: 0.4 }} />
                  ) : (
                    <AiOutlinePushpin size={10} color="currentColor" style={{ opacity: 0 }} />
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {/* New tab button + dropdown chevron (Warp style: separate + and ⌄) */}
        <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
          {/* + button — opens recent projects dropdown or folder picker */}
          <div
            ref={recentBtnRef}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              cursor: "pointer",
              padding: "0 8px",
              backgroundColor: showRecentMenu ? "var(--ezy-surface-raised)" : "transparent",
            }}
            onClick={() => {
              setShowNewTabMenu(false);
              handlePlusClick();
            }}
            onMouseEnter={(e) => {
              cancelHoverClose();
              // Same hover-to-open setting as the add-pane chevron next door;
              // each button closes the other's menu, so moving the pointer
              // between the two is an instant switch.
              if (hoverOpenAddPaneMenu && !showRecentMenu) {
                setShowNewTabMenu(false);
                setShowRecentMenu(true);
                return;
              }
              if (!showRecentMenu) e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
            }}
            onMouseLeave={(e) => {
              scheduleHoverClose();
              if (!showRecentMenu) e.currentTarget.style.backgroundColor = "transparent";
            }}
          >
            <FaPlus size={13} color={showRecentMenu ? "var(--ezy-text)" : "var(--ezy-text-muted)"} />
          </div>

          {/* Recent Projects dropdown */}
          {/* Recent-projects menu — overlay-rendered (kind "recent-menu", hook above). */}

          {/* Chevron — opens the Add-pane menu. Gated on the ACTIVE tab (same
              precedent as the Git bar below): the menu only ever spawns panes
              into the active tab, so a system tab hides it — and so does a
              Jira project, whose panes are opened from the ticket rail. */}
          {(() => {
            const at = tabs.find((t) => t.id === activeTabId);
            return at && !at.isKanbanTab && !at.isDevServerTab && !at.isServersTab && !at.isSettingsTab && !at.isJiraProject;
          })() && <><div
            ref={newTabChevronRef}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              cursor: "pointer",
              padding: "0 6px",
              borderLeft: "1px solid var(--ezy-border-subtle)",
              backgroundColor: showNewTabMenu ? "var(--ezy-surface-raised)" : "transparent",
            }}
            onClick={() => {
              setShowRecentMenu(false);
              setShowNewTabMenu((v) => !v);
            }}
            onMouseEnter={(e) => {
              cancelHoverClose();
              if (hoverOpenAddPaneMenu && !showNewTabMenu) {
                setShowRecentMenu(false);
                setShowNewTabMenu(true);
                return;
              }
              if (!showNewTabMenu) e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
            }}
            onMouseLeave={(e) => {
              scheduleHoverClose();
              if (!showNewTabMenu) e.currentTarget.style.backgroundColor = "transparent";
            }}
          >
            <FaChevronDown size={8} color={showNewTabMenu ? "var(--ezy-text)" : "var(--ezy-text-muted)"} />
          </div>

          {/* Add-pane menu — overlay-rendered (useOverlayMenu above). */}
          </>}
        </div>

        {/* Spacer — app-owned drag path; avoids Windows' native frame during restore drags. */}
        <div
          className="flex-1"
          onPointerDown={anyMenuOpen ? () => closeAllMenus() : startCustomWindowDrag}
          onDoubleClick={anyMenuOpen ? undefined : toggleMaximizeOnDoubleClick}
        />

        {/* Git Status Bar — project tabs with a workingDir, LOCAL OR REMOTE.
            `serverId` is forwarded rather than used to exclude: it routes the
            reads to the git_*_ssh commands so a remote project shows its real
            branch and diff counts, and it hides the write actions, which run
            git locally and would otherwise act on the wrong machine.
            See lib/git-invoke.ts. */}
        {(() => {
          const at = tabs.find((t) => t.id === activeTabId);
          return at && at.workingDir && !at.isDevServerTab && !at.isServersTab && !at.isKanbanTab && !at.isSettingsTab;
        })() && (
          <GitStatusBar
            /* One instance per directory: remount on switch so the bar seeds
               from the new dir's snapshot instead of keeping the old dir's
               state painted while the fetch runs. */
            key={`${tabs.find((t) => t.id === activeTabId)!.serverId ?? ""}:${tabs.find((t) => t.id === activeTabId)!.workingDir!}`}
            workingDir={tabs.find((t) => t.id === activeTabId)!.workingDir!}
            serverId={tabs.find((t) => t.id === activeTabId)!.serverId}
          />
        )}

        {/* Voice agent mic — sits to the left of the clipboard image strip */}
        {VOICE_ENABLED && <VoiceMicButton />}

        {/* Clipboard image thumbnails */}
        <ClipboardImageStrip />

        {/* Tasks */}
        {showKanbanButton && (
          <div
            onClick={() => {
              const store = useAppStore.getState();
              const tab = store.tabs.find((t) => t.id === activeTabId);
              if (!tab || !tab.layout || tab.isDevServerTab || tab.isServersTab || tab.isKanbanTab || tab.isSettingsTab) return;

              // Toggle: if kanban already exists, remove it
              const existingId = findKanbanPaneId(tab.layout);
              if (existingId) {
                const newLayout = removePane(tab.layout, existingId);
                if (newLayout) store.updateTabLayout(tab.id, newLayout);
                return;
              }

              // Smart add: placement depends on row count
              const newLayout = addKanbanPane(tab.layout);
              if (newLayout) store.updateTabLayout(tab.id, newLayout);
            }}
            data-tooltip="Tasks"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              alignSelf: "center",
              width: 34,
              height: 26,
              cursor: "pointer",
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
              backgroundColor: "transparent",
              transition: "background-color 120ms ease",
            }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-surface)"}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
          >
            <PiKanbanDuotone size={14} color="var(--ezy-text-muted)" style={{ transform: "scale(1.5)" }} />
          </div>
        )}

        {/* Browser Preview — only for project tabs. Hidden for Jira projects:
            every ticket owns its browser pane inside its pair, and a manually
            added free-standing browser would make the migration effect read
            the layout as legacy and rebuild it. */}
        {(() => {
          const at = tabs.find((t) => t.id === activeTabId);
          return at && !at.isDevServerTab && !at.isServersTab && !at.isKanbanTab && !at.isSettingsTab && !at.isJiraProject;
        })() && (
          <div
            onClick={() => {
              const store = useAppStore.getState();
              const tab = store.tabs.find((t) => t.id === store.activeTabId);
              if (!tab || !tab.layout || tab.isDevServerTab || tab.isServersTab || tab.isKanbanTab || tab.isSettingsTab || tab.isJiraProject) return;

              // If browser pane already exists, remove it (toggle off)
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

              // Otherwise open a new browser preview. Bind it to this tab so
              // it tracks the live dev-server URL and shows a "Waiting for
              // dev server" state if the port isn't ready yet — avoids the
              // "can't reach page" race when the server is still starting.
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
            }}
            data-tooltip="Browser Preview"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              alignSelf: "center",
              width: 34,
              height: 26,
              cursor: "pointer",
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
              backgroundColor: "transparent",
              transition: "background-color 120ms ease",
            }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-surface)"}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
          >
            {(() => {
              const tab = tabs.find((t) => t.id === activeTabId);
              const hasBrowser = tab && tab.layout ? findAllBrowserPanes(tab.layout).length > 0 : false;
              return hasBrowser
                ? <TbBrowserMinus size={14} color="var(--ezy-text-muted)" style={{ transform: "scale(1.2)" }} />
                : <TbBrowserPlus size={14} color="var(--ezy-text-muted)" style={{ transform: "scale(1.2)" }} />;
            })()}
          </div>
        )}

        {/* Mini Games — only for project tabs */}
        {showMiniGamesButton && (() => {
          const at = tabs.find((t) => t.id === activeTabId);
          return at && !at.isDevServerTab && !at.isServersTab && !at.isKanbanTab && !at.isSettingsTab;
        })() && (
          <div
            onClick={() => useAppStore.getState().toggleGameSidebar()}
            data-tooltip="Mini Games"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              alignSelf: "center",
              width: 34,
              height: 26,
              cursor: "pointer",
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
              backgroundColor: "transparent",
              transition: "background-color 120ms ease",
            }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-surface)"}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
          >
            {/* One app-level sidebar, so the lit state is the store flag — not
                a per-tab layout probe. */}
            <PiGameControllerDuotone
              size={14}
              color={gameSidebarOpen ? "var(--ezy-accent)" : "var(--ezy-text-muted)"}
              style={{ transform: "scale(1.3)" }}
            />
          </div>
        )}


        {/* Separator before window controls */}
        <div style={{ width: 1, height: 16, backgroundColor: "var(--ezy-border-subtle)", alignSelf: "center", margin: "0 4px" }} />

        {/* Window controls (Warp style — subtle, integrated) */}
        <div style={{ display: "flex", alignItems: "stretch" }}>
          {/* Minimize */}
          <div
            onClick={async () => {
              const win = getCurrentWindow();
              if (await win.isMaximized()) {
                // Minimize directly without flashing the restored window,
                // then set restored state to normal so taskbar restore isn't maximized
                const { invoke } = await import("@tauri-apps/api/core");
                invoke("minimize_from_maximized").catch(() => win.minimize());
              } else {
                win.minimize();
              }
            }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 46,
              cursor: "pointer",
              transition: "background-color 120ms ease",
            }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.06)"}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
          >
            {/* Warp parity: 10px mark inset 1px in a 12px box. y=5.5 puts the
                1px stroke inside a single device row (y=5 straddled two rows
                and rendered at half brightness). */}
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <line x1="1" y1="5.5" x2="11" y2="5.5" stroke="var(--ezy-text-secondary)" strokeWidth="1" />
            </svg>
          </div>

          {/* Maximize / Restore */}
          <div
            onClick={async () => {
              const win = getCurrentWindow();
              if (await win.isMaximized()) {
                win.unmaximize();
              } else {
                win.maximize();
              }
            }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 46,
              cursor: "pointer",
              transition: "background-color 120ms ease",
            }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.06)"}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
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

          {/* Close */}
          <div
            // Straight to close(): App's onCloseRequested decides whether to
            // confirm, so this X, Alt+F4 and the taskbar X all take the same
            // path and QuitConfirmModal is the single place that asks.
            onClick={() => getCurrentWindow().close()}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 46,
              cursor: "pointer",
              transition: "background-color 120ms ease",
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
        </div>
      </div>

      {/* Remote File Browser modal */}
      {launchModals}
    </>
  );
}
