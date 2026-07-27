import { useCallback, useState, useRef, useMemo, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Tab, TerminalType, PaneLayout, TerminalRenderer } from "../types";
import JiraTicketRail from "./JiraTicketRail";
import { useAppStore } from "../store";
import {
  addPaneAsGrid,
  findAllTerminalIds,
  findAllTerminalLeaves,
  findAllBrowserPanes,
  findPaneIdForTerminal,
  removePane,
  redistributeEqually,
  setTerminalTypeInLayout,
  splitPane,
  swapPanes,
  generatePaneId,
  generateTerminalId,
  repositionKanbanPane,
} from "../lib/layout-utils";
import { getPtyWrite } from "../store/terminalSlice";
import { pasteTextToTerminal } from "../lib/terminal-paste";
import { snapshotPane } from "../store/undoCloseStore";
import { DEFAULT_CLI_FONT_SIZE } from "../store/recentProjectsSlice";
import type { CommandBlock } from "../lib/command-block-parser";
import PaneGrid from "./PaneGrid";
import BrowserPreview from "./BrowserPreview";
import TerminalPane, { suppressFocusTerminals } from "./TerminalPane";
import ToolSelector from "./ToolSelector";
import EmptyTabLauncher from "./EmptyTabLauncher";
import FloatingPanesLayer from "./FloatingPanesLayer";
import { type RenderLeafCallbacks, parkSlot } from "../lib/render-pane";

interface WorkspaceProps {
  tab: Tab;
}

export default function Workspace({ tab }: WorkspaceProps) {
  const updateTabLayout = useAppStore((s) => s.updateTabLayout);
  const updatePaneSessionResumeId = useAppStore((s) => s.updatePaneSessionResumeId);
  const addTerminal = useAppStore((s) => s.addTerminal);
  const addTerminals = useAppStore((s) => s.addTerminals);
  const setActiveTerminal = useAppStore((s) => s.setActiveTerminal);
  const terminals = useAppStore((s) => s.terminals);
  const redistributeOnClose = useAppStore((s) => s.redistributeOnClose);
  // Subscribed for the browser-slot position-sync effect — when a pane
  // expands/floats/closes its placeholder div moves between PaneGrid and
  // FloatingPaneWindow and the slot needs to re-observe the new element.
  const paneModes = useAppStore((s) => s.paneModes);
  const closingPanes = useAppStore((s) => s.closingPanes);
  const [activeTerminalId, setLocalActiveTerminal] = useState<string | null>(
    null
  );
  // SUBSCRIBED, not read imperatively like the activeTabId checks in the event
  // handlers below: panes must re-render when the active tab changes, because
  // `isTabActive` gates the native pane's Win32 keyboard-focus claim. The other
  // reads are inside event handlers, where a live getState() is correct.
  const activeTabId = useAppStore((s) => s.activeTabId);
  const isTabActive = tab.id === activeTabId;
  const [showToolSelector, setShowToolSelector] = useState(false);

  // Track which element last had DOM focus inside a terminal pane.
  // Captures BOTH xterm textareas and PromptComposer textareas — whichever
  // was focused when the user last interacted with a terminal pane.
  // Survives clicks on TabBar/menus (those elements aren't inside a pane).
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const handler = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      const pane = target.closest('[data-terminal-id]');
      if (pane) {
        lastFocusedElementRef.current = target;
      }
    };
    document.addEventListener('focusin', handler);
    return () => document.removeEventListener('focusin', handler);
  }, []);

  // Check if this is a fresh tab that needs its first terminal spawned
  // (skip if the leaf has a persisted terminalType — that means it's being restored)
  const layoutTerminalId =
    tab.layout?.type === "terminal" ? tab.layout.terminalId : null;
  const isRestoredLeaf =
    tab.layout?.type === "terminal" && !!tab.layout.terminalType;
  const needsInitialTerminal =
    layoutTerminalId && !terminals[layoutTerminalId] && !isRestoredLeaf;

  // Collect all terminal IDs in the current layout (sorted for stable portal order)
  const allTerminalIds = useMemo(
    () => (tab.layout ? findAllTerminalIds(tab.layout).sort() : []),
    [tab.layout]
  );

  // Auto-activate the first terminal on mount so at least one pane starts
  // as "active" and its MadeComposer initializes properly via Case 1.
  useEffect(() => {
    if (activeTerminalId === null && allTerminalIds.length > 0) {
      const firstId = allTerminalIds[0];
      if (terminals[firstId]) {
        setLocalActiveTerminal(firstId);
        setActiveTerminal(firstId);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allTerminalIds]);

  // Persistent slot divs per terminal — survive layout restructures
  const slotMapRef = useRef<Map<string, HTMLDivElement>>(new Map());

  // Create/get persistent slot element for a terminal
  const getSlotEl = useCallback((terminalId: string): HTMLDivElement => {
    let el = slotMapRef.current.get(terminalId);
    if (!el) {
      el = document.createElement("div");
      el.style.width = "100%";
      el.style.height = "100%";
      slotMapRef.current.set(terminalId, el);
    }
    return el;
  }, []);

  // Cleanup slots for removed terminals
  useEffect(() => {
    const activeSet = new Set(allTerminalIds);
    for (const [id, el] of slotMapRef.current) {
      if (!activeSet.has(id)) {
        el.remove();
        slotMapRef.current.delete(id);
      }
    }
  }, [allTerminalIds]);

  // Persistent slot divs per browser-preview pane — keep iframe alive across
  // layout restructures (any pane open/close re-runs PaneGrid.renderPane and
  // changes element types in the React tree, which would otherwise unmount
  // BrowserPreview and reload its iframe).
  const browserSlotMapRef = useRef<Map<string, HTMLDivElement>>(new Map());

  const getBrowserSlotEl = useCallback((paneId: string): HTMLDivElement => {
    let el = browserSlotMapRef.current.get(paneId);
    if (!el) {
      el = document.createElement("div");
      // Slot is fixed-positioned and lives permanently in the park (under
      // document.body). It overlays the placeholder via getBoundingClientRect
      // — we never move the iframe DOM, which is what stops it from reloading
      // when the layout restructures.
      el.style.position = "fixed";
      el.style.left = "0px";
      el.style.top = "0px";
      el.style.width = "0px";
      el.style.height = "0px";
      el.style.display = "none";
      el.style.zIndex = "10";
      // The park (document.body slot park) sets pointer-events:none so parked
      // slots don't capture events. But this slot stays in the park while shown
      // as a visible fixed overlay, so it must re-enable pointer events or the
      // iframe inherits `none` and the whole preview becomes click/scroll-dead.
      el.style.pointerEvents = "auto";
      parkSlot(el);
      browserSlotMapRef.current.set(paneId, el);
    }
    return el;
  }, []);

  // Active browser panes derived from layout (used to drive portal mounts)
  const allBrowserPanes = useMemo(
    () => (tab.layout ? findAllBrowserPanes(tab.layout) : []),
    [tab.layout]
  );

  // Cleanup slots for removed browser panes
  useEffect(() => {
    const activeSet = new Set(allBrowserPanes.map((p) => p.id));
    for (const [id, el] of browserSlotMapRef.current) {
      if (!activeSet.has(id)) {
        el.remove();
        browserSlotMapRef.current.delete(id);
      }
    }
  }, [allBrowserPanes]);

  // Sync each browser slot's fixed-position rect to its placeholder div on
  // every layout change, plus on window resize and pane drag-resize. We use
  // ResizeObserver on each placeholder for drag-resize and a self-gating rAF
  // loop while a FLIP animation is in flight (PanelResizeHandle dragging only
  // fires resize events on the panel children).
  //
  // The expensive work (syncAll) runs only when needed: ResizeObserver covers
  // layout-change frames, the resize/scroll listeners cover window-level
  // changes, and the rAF loop gates its work on document.getAnimations() so it
  // stays quiet when nothing is animating — eliminating the 60Hz forced-reflow
  // baseline that previously pegged a core during startup churn and resize.
  const syncAllRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const syncOne = (paneId: string, slot: HTMLDivElement) => {
      const placeholder = document.querySelector(
        `[data-browser-pane-id="${paneId}"]`
      ) as HTMLElement | null;
      if (!placeholder) {
        slot.style.display = "none";
        return;
      }
      const rect = placeholder.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        slot.style.display = "none";
        return;
      }
      slot.style.display = "block";
      slot.style.left = `${rect.left}px`;
      slot.style.top = `${rect.top}px`;
      slot.style.width = `${rect.width}px`;
      slot.style.height = `${rect.height}px`;
      // If the placeholder is inside a floating pane window, the slot must
      // sit above that wrapper's z-index (which is 350+). Otherwise default
      // to a low z-index so modals stay on top.
      const floatingAncestor = placeholder.closest(
        "[data-floating-zindex]"
      ) as HTMLElement | null;
      if (floatingAncestor) {
        const z = Number(floatingAncestor.dataset.floatingZindex ?? 350);
        slot.style.zIndex = String(z + 1);
      } else {
        slot.style.zIndex = "10";
      }
    };

    const syncAll = () => {
      for (const [id, slot] of browserSlotMapRef.current) {
        syncOne(id, slot);
      }
    };
    syncAllRef.current = syncAll;

    syncAll();

    // ResizeObserver fires when placeholders resize (window resize, pane drag,
    // sidebar collapse, etc.) and also fires once on observe — so it covers
    // the initial measurement after layout changes mount new placeholders.
    const ro = new ResizeObserver(syncAll);
    document
      .querySelectorAll("[data-browser-pane-id]")
      .forEach((el) => ro.observe(el));

    // rAF loop. Two reasons to do work:
    //
    //  1. A WAAPI animation is in flight (FLIP open/close/expand/float) — track
    //     the animated transform from grid-rect to final-rect.
    //  2. A placeholder MOVED without resizing. ResizeObserver is blind to pure
    //     movement, and there is no animation either, so opening the Settings
    //     sidebar (which shifts panes sideways at unchanged width) left the slot
    //     — and the native webview parked on it — at the old position, sitting
    //     over the CLI panes. The comment that RO covers "sidebar collapse" was
    //     simply wrong.
    //
    // The position probe is one getBoundingClientRect per browser pane per frame
    // (there is at most one), which is what every native pane's driver already
    // does; the reflow storm this loop was written to avoid came from tearing
    // down and recreating the observers, not from measuring.
    const movedSinceLastSync = () => {
      for (const [id, slot] of browserSlotMapRef.current) {
        if (slot.style.display === "none") continue;
        const placeholder = document.querySelector(
          `[data-browser-pane-id="${id}"]`
        ) as HTMLElement | null;
        if (!placeholder) return true;
        const r = placeholder.getBoundingClientRect();
        if (
          Math.round(r.left) !== Math.round(parseFloat(slot.style.left || "0")) ||
          Math.round(r.top) !== Math.round(parseFloat(slot.style.top || "0")) ||
          Math.round(r.width) !== Math.round(parseFloat(slot.style.width || "0")) ||
          Math.round(r.height) !== Math.round(parseFloat(slot.style.height || "0"))
        ) {
          return true;
        }
      }
      return false;
    };

    let rafId = requestAnimationFrame(function tick() {
      const anims = document.getAnimations();
      let anyRunning = false;
      for (let i = 0; i < anims.length; i++) {
        if (anims[i].playState === "running") { anyRunning = true; break; }
      }
      if (anyRunning || movedSinceLastSync()) syncAll();
      rafId = requestAnimationFrame(tick);
    });

    window.addEventListener("resize", syncAll);
    window.addEventListener("scroll", syncAll, true);

    return () => {
      ro.disconnect();
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", syncAll);
      window.removeEventListener("scroll", syncAll, true);
      syncAllRef.current = null;
    };
  }, [allBrowserPanes, tab.layout]);

  // Pane-mode transitions (float/expand/close) re-parent the browser
  // placeholder between PaneGrid and FloatingPaneWindow. Trigger a one-shot
  // resync without tearing down the rAF/ResizeObserver infrastructure — that
  // teardown-recreate cycle on every store mutation was the primary cause of
  // the resize/startup freeze (forced-reflow storm).
  useEffect(() => {
    syncAllRef.current?.();
  }, [paneModes, closingPanes]);

  const handleLayoutChange = useCallback(
    (layout: PaneLayout | null) => {
      updateTabLayout(tab.id, layout);
    },
    [tab.id, updateTabLayout]
  );

  const handleTerminalFocus = useCallback(
    (terminalId: string) => {
      setLocalActiveTerminal(terminalId);
      setActiveTerminal(terminalId);
    },
    [setActiveTerminal]
  );

  // Refocus the previously focused element — used after "open in background"
  // to return focus to wherever the user was (xterm textarea OR composer textarea).
  // Retries because the new pane's async init may steal focus later.
  const refocusPrevious = useCallback(() => {
    const doFocus = () => {
      const el = lastFocusedElementRef.current;
      if (el && el.isConnected) el.focus();
    };
    doFocus();
    setTimeout(doFocus, 50);
    setTimeout(doFocus, 200);
    setTimeout(doFocus, 500);
    setTimeout(doFocus, 1000);
  }, []);

  const handleSpawnTerminal = useCallback(
    (terminalId: string, type: TerminalType, serverId?: string, workingDir?: string) => {
      // `workingDir` override: the file tree's "Open terminal here" names a
      // folder. Everything else omits it and inherits the tab's directory.
      addTerminal(terminalId, type, workingDir || tab.workingDir, serverId ?? tab.serverId);
      if (tab.layout) {
        updateTabLayout(tab.id, setTerminalTypeInLayout(tab.layout, terminalId, type));
      }
    },
    [addTerminal, tab.workingDir, tab.serverId, tab.id, tab.layout, updateTabLayout]
  );

  const handleInitialSpawn = useCallback(
    (type: TerminalType, serverId?: string) => {
      if (!layoutTerminalId || !tab.layout) return;
      addTerminal(layoutTerminalId, type, tab.workingDir, serverId ?? tab.serverId);
      updateTabLayout(tab.id, setTerminalTypeInLayout(tab.layout, layoutTerminalId, type));
      setLocalActiveTerminal(layoutTerminalId);
      setShowToolSelector(false);
    },
    [addTerminal, layoutTerminalId, tab.workingDir, tab.serverId, tab.id, tab.layout, updateTabLayout]
  );

  // --- Terminal pane callbacks (used by portal-rendered TerminalPanes) ---

  const cleanupPaneMode = useAppStore((s) => s.cleanupPaneMode);

  const handleTerminalClose = useCallback((termId: string) => {
    if (!tab.layout) return;
    const paneId = findPaneIdForTerminal(tab.layout, termId);
    if (!paneId) return;
    snapshotPane(tab.id, tab.layout);
    const removed = removePane(tab.layout, paneId);
    // `removed` may be null when the last pane is closed — propagate that so
    // the empty-state launcher renders.
    const next = removed && redistributeOnClose ? redistributeEqually(removed) : removed;
    cleanupPaneMode(paneId);
    handleLayoutChange(next);
  }, [tab.id, tab.layout, handleLayoutChange, redistributeOnClose, cleanupPaneMode]);

  // Generic pane close (used by FloatingPanesLayer + non-terminal panes).
  const handlePaneClose = useCallback((paneId: string) => {
    if (!tab.layout) return;
    snapshotPane(tab.id, tab.layout);
    const removed = removePane(tab.layout, paneId);
    const next = removed && redistributeOnClose ? redistributeEqually(removed) : removed;
    cleanupPaneMode(paneId);
    handleLayoutChange(next);
  }, [tab.id, tab.layout, handleLayoutChange, redistributeOnClose, cleanupPaneMode]);

  const handleKanbanReposition = useCallback((vertical: boolean) => {
    if (!tab.layout) return;
    const newLayout = repositionKanbanPane(tab.layout, vertical);
    if (newLayout) handleLayoutChange(newLayout);
  }, [tab.layout, handleLayoutChange]);

  // Title helper for floating-window header. Type-narrowed by node.type.
  const paneTitleFor = useCallback((node: PaneLayout): string => {
    switch (node.type) {
      case "terminal": {
        const t = terminals[node.terminalId];
        return t ? `${t.type[0].toUpperCase()}${t.type.slice(1)}` : "Terminal";
      }
      case "browser":
        return node.url || "Browser";
      case "editor":
        return node.filePath?.split(/[/\\]/).pop() || "Editor";
      case "fileviewer":
        return node.activeFile?.split(/[/\\]/).pop() || "Files";
      case "codereview":
        return "Code Review";
      case "kanban":
        return "Kanban";
      case "game":
        return "Games";
      default:
        return "Pane";
    }
  }, [terminals]);

  const floatingCallbacks: RenderLeafCallbacks = useMemo(() => ({
    onClose: handlePaneClose,
    onKanbanReposition: handleKanbanReposition,
    getTerminalSlot: getSlotEl,
  }), [handlePaneClose, handleKanbanReposition, getSlotEl]);



  const handleTerminalExplainError = useCallback((termId: string, block: CommandBlock) => {
    if (!tab.layout) return;
    const prompt = `Explain this error:\n\`\`\`\n${block.command}\n${block.outputText ?? ""}\n\`\`\`\nExit code: ${block.exitCode}\n`;

    // Look for existing AI terminal in current tab layout
    const allIds = findAllTerminalIds(tab.layout);
    const terms = useAppStore.getState().terminals;
    const aiTypes: TerminalType[] = ["claude", "codex", "gemini"];

    for (const tid of allIds) {
      const t = terms[tid];
      if (t && aiTypes.includes(t.type)) {
        const writeFn = getPtyWrite(tid);
        if (writeFn) {
          writeFn(prompt);
          return;
        }
      }
    }

    // No AI terminal found — split source pane and spawn one
    const paneId = findPaneIdForTerminal(tab.layout, termId);
    if (!paneId) return;
    const newTerminalId = generateTerminalId();
    const newLeaf = { type: "terminal" as const, id: generatePaneId(), terminalId: newTerminalId, terminalType: "claude" as const };
    handleSpawnTerminal(newTerminalId, "claude", tab.serverId);
    handleLayoutChange(splitPane(tab.layout, paneId, "horizontal", newLeaf));

    setTimeout(() => {
      const writeFn = getPtyWrite(newTerminalId);
      if (writeFn) writeFn(prompt);
    }, 2000);
  }, [tab.layout, tab.serverId, handleLayoutChange, handleSpawnTerminal]);

  const handleSwapPane = useCallback((fromTerminalId: string, toTerminalId: string) => {
    if (!tab.layout) return;
    const paneA = findPaneIdForTerminal(tab.layout, fromTerminalId);
    const paneB = findPaneIdForTerminal(tab.layout, toTerminalId);
    if (!paneA || !paneB) return;

    // Swap slot elements in the DOM FIRST (atomic, avoids WebGL context loss)
    const slotA = slotMapRef.current.get(fromTerminalId);
    const slotB = slotMapRef.current.get(toTerminalId);
    if (slotA && slotB && slotA.parentElement && slotB.parentElement) {
      const parentA = slotA.parentElement;
      const parentB = slotB.parentElement;
      const placeholder = document.createElement("div");
      parentA.replaceChild(placeholder, slotA);
      parentB.replaceChild(slotA, slotB);
      parentA.replaceChild(slotB, placeholder);
    }

    // Then update layout tree — React re-renders but ref callbacks
    // find slots already in place (parentElement === el) and skip DOM work
    handleLayoutChange(swapPanes(tab.layout!, paneA, paneB));
  }, [tab.layout, handleLayoutChange]);

  // Listen for split-terminal events from the chevron dropdown
  useEffect(() => {
    const handler = (e: Event) => {
      // Only respond if this tab is the active one
      const activeId = useAppStore.getState().activeTabId;
      if (activeId !== tab.id) return;

      const detail = (e as CustomEvent).detail;
      const type = detail?.type as TerminalType | undefined;
      if (!type) return;

      // Per-pane renderer, only ever set by the tab bar's "Add pane" dropdown
      // (sticky toggle or Ctrl+click). Every other dispatcher omits it, so
      // those panes follow the global Settings toggle. Lives on the leaf, so
      // it persists with the layout and dies with the pane.
      const renderer = detail?.renderer as TerminalRenderer | undefined;
      // A caller that has to know the terminal id BEFORE the pane exists can
      // supply it (the Jira flow stashes the first prompt against it, and
      // registers the ticket's session under it). Everyone else omits it and
      // gets a fresh one, exactly as before.
      const newTerminalId = (detail?.terminalId as string | undefined) ?? generateTerminalId();
      // Resuming a named session — a closed Jira ticket being reopened. Lives
      // on the leaf, so the pane spawns with `--resume <uuid>` and the previous
      // conversation comes back.
      const sessionResumeId = detail?.sessionResumeId as string | undefined;
      const newLeaf = { type: "terminal" as const, id: generatePaneId(), terminalId: newTerminalId, terminalType: type, renderer, sessionResumeId };

      const focusNewPane = !useAppStore.getState().openPanesInBackground;

      // Mark this terminal for focus suppression — TerminalPane will
      // override textarea.focus() until the pane becomes active.
      if (!focusNewPane) {
        suppressFocusTerminals.add(newTerminalId);
      }

      // Empty tab — promote the new leaf to root layout. We bypass
      // handleSpawnTerminal here because it short-circuits when tab.layout
      // is null (the layout-write would no-op).
      if (!tab.layout) {
        addTerminal(newTerminalId, type, (detail?.workingDir as string | undefined) || tab.workingDir, tab.serverId);
        handleLayoutChange(newLeaf);
        if (focusNewPane) handleTerminalFocus(newTerminalId);
        else refocusPrevious();
        return;
      }

      handleSpawnTerminal(newTerminalId, type, tab.serverId, detail?.workingDir as string | undefined);

      // Direction: "left" | "right" | "up" | "down" from the context menu,
      // plus the legacy "vertical" (= down) that every existing dispatcher
      // sends. Anything else falls through to the grid add below.
      const dir = detail?.direction as string | undefined;
      const axis: "horizontal" | "vertical" | null =
        dir === "left" || dir === "right" ? "horizontal"
        : dir === "up" || dir === "down" || dir === "vertical" ? "vertical"
        : null;

      if (axis) {
        // Splits must land on a real pane. An explicit `targetTerminalId`
        // (context menu — the pane actually right-clicked) wins over the
        // focused pane. `activeTerminalId` can be null (nothing focused yet) or
        // point at a pane that has since been closed — in both cases
        // findPaneIdForTerminal returns null. Falling through to the grid add
        // then silently produced a side-by-side pane, which is the "Split Down
        // only works sometimes" report: the user asked to stack and got a grid.
        // Fall back to the last pane in the layout so the intent is honoured.
        const requested = (detail?.targetTerminalId as string | undefined) ?? activeTerminalId;
        const target =
          (requested && findPaneIdForTerminal(tab.layout, requested)) ||
          (() => {
            const ids = findAllTerminalIds(tab.layout);
            const last = ids[ids.length - 1];
            return last ? findPaneIdForTerminal(tab.layout, last) : null;
          })();
        if (target) {
          const insertBefore = dir === "left" || dir === "up";
          handleLayoutChange(splitPane(tab.layout, target, axis, newLeaf, insertBefore));
          if (focusNewPane) handleTerminalFocus(newTerminalId);
          else refocusPrevious();
          return;
        }
      }
      const wideGrid = useAppStore.getState().wideGridLayout;
      handleLayoutChange(addPaneAsGrid(tab.layout, newLeaf, wideGrid));
      if (focusNewPane) handleTerminalFocus(newTerminalId);
      else refocusPrevious();
    };
    window.addEventListener("made:split-terminal", handler);
    return () => window.removeEventListener("made:split-terminal", handler);
    // activeTerminalId MUST stay in this list. Without it the handler closed
    // over whichever pane was focused the last time one of the other deps
    // changed, so Split Down stacked under the wrong pane — or, if that pane
    // had been closed, degraded to a grid add. It appeared to work "sometimes"
    // because any layout change refreshes the closure. Every other effect in
    // this file already lists it.
  }, [tab.id, tab.layout, tab.serverId, activeTerminalId, handleLayoutChange, handleSpawnTerminal, handleTerminalFocus, refocusPrevious]);

  // Listen for close-pane events (Ctrl+W, context menu)
  useEffect(() => {
    const handler = (e: Event) => {
      if (useAppStore.getState().activeTabId !== tab.id) return;
      // An explicit target wins over the focused pane. The keyboard shortcut
      // sends no detail and keeps the old behaviour; the context menu names
      // the pane that was actually right-clicked, which is not necessarily the
      // focused one — closing the focused pane instead is destructive.
      const detail = (e as CustomEvent).detail;
      const targetId = (detail?.terminalId as string | undefined) ?? activeTerminalId;
      if (!targetId) return;
      handleTerminalClose(targetId);
    };
    window.addEventListener("made:close-pane", handler);
    return () => window.removeEventListener("made:close-pane", handler);
  }, [tab.id, activeTerminalId, handleTerminalClose]);

  // Listen for focus-next/prev pane events (Ctrl+Shift+]/[)
  useEffect(() => {
    const nextHandler = () => {
      if (useAppStore.getState().activeTabId !== tab.id) return;
      if (!tab.layout) return;
      const leaves = findAllTerminalLeaves(tab.layout);
      if (leaves.length < 2) return;
      const ids = leaves.map((l) => l.terminalId);
      const curIdx = ids.indexOf(activeTerminalId ?? "");
      const nextIdx = (curIdx + 1) % ids.length;
      handleTerminalFocus(ids[nextIdx]);
      // Focus the terminal's textarea/canvas
      const paneEl = document.querySelector(`[data-terminal-id="${ids[nextIdx]}"]`);
      const focusTarget = paneEl?.querySelector("textarea") ?? paneEl?.querySelector("canvas");
      (focusTarget as HTMLElement)?.focus();
    };
    const prevHandler = () => {
      if (useAppStore.getState().activeTabId !== tab.id) return;
      if (!tab.layout) return;
      const leaves = findAllTerminalLeaves(tab.layout);
      if (leaves.length < 2) return;
      const ids = leaves.map((l) => l.terminalId);
      const curIdx = ids.indexOf(activeTerminalId ?? "");
      const prevIdx = (curIdx - 1 + ids.length) % ids.length;
      handleTerminalFocus(ids[prevIdx]);
      const paneEl = document.querySelector(`[data-terminal-id="${ids[prevIdx]}"]`);
      const focusTarget = paneEl?.querySelector("textarea") ?? paneEl?.querySelector("canvas");
      (focusTarget as HTMLElement)?.focus();
    };
    window.addEventListener("made:focus-next-pane", nextHandler);
    window.addEventListener("made:focus-prev-pane", prevHandler);
    return () => {
      window.removeEventListener("made:focus-next-pane", nextHandler);
      window.removeEventListener("made:focus-prev-pane", prevHandler);
    };
  }, [tab.id, tab.layout, activeTerminalId, handleTerminalFocus]);

  // Restore focus to the active pane when this tab becomes visible.
  // Tabs stay mounted behind display:none, so xterm's internal focus is
  // lost while the container is hidden and nothing re-grabs it on show.
  // lastFocusedElementRef is document-scoped and may point at a pane in a
  // different tab, so we route through this tab's own activeTerminalId.
  useEffect(() => {
    const focusActivePane = () => {
      if (!activeTerminalId) return;
      const paneEl = document.querySelector(`[data-terminal-id="${activeTerminalId}"]`);
      if (!paneEl) return;
      // xterm's textarea lives inside containerRef and precedes the composer
      // textarea in DOM order, so the first match is the terminal input.
      const target = paneEl.querySelector("textarea") ?? paneEl.querySelector("canvas");
      (target as HTMLElement | null)?.focus();
    };

    if (useAppStore.getState().activeTabId === tab.id) {
      requestAnimationFrame(focusActivePane);
    }

    const unsub = useAppStore.subscribe((state, prev) => {
      if (state.activeTabId === prev.activeTabId) return;
      if (state.activeTabId !== tab.id) return;
      requestAnimationFrame(focusActivePane);
    });
    return unsub;
  }, [tab.id, activeTerminalId]);

  // Listen for clear-terminal events (Ctrl+L, context menu)
  useEffect(() => {
    const handler = (e: Event) => {
      if (useAppStore.getState().activeTabId !== tab.id) return;
      const detail = (e as CustomEvent).detail;
      const targetId = (detail?.terminalId as string | undefined) ?? activeTerminalId;
      if (!targetId) return;
      const writeFn = getPtyWrite(targetId);
      if (writeFn) writeFn("\x0c"); // Send form-feed (Ctrl+L) to PTY
    };
    window.addEventListener("made:clear-terminal", handler);
    return () => window.removeEventListener("made:clear-terminal", handler);
  }, [tab.id, activeTerminalId]);

  // Listen for paste-text events (Ctrl+Shift+V, context menu).
  //
  // This listener did not exist. `made:paste-text` had two dispatchers
  // (App.tsx's Ctrl+Shift+V and the context menu's Paste item) and zero
  // listeners, so both were silently inert — Paste has never worked from
  // either entry point.
  useEffect(() => {
    const handler = (e: Event) => {
      if (useAppStore.getState().activeTabId !== tab.id) return;
      const detail = (e as CustomEvent).detail;
      const text = detail?.text as string | undefined;
      if (!text) return;
      const targetId = (detail?.terminalId as string | undefined) ?? activeTerminalId;
      if (!targetId) return;
      pasteTextToTerminal(targetId, text);
    };
    window.addEventListener("made:paste-text", handler);
    return () => window.removeEventListener("made:paste-text", handler);
  }, [tab.id, activeTerminalId]);

  // Listen for font-zoom events (Ctrl++/Ctrl+-)
  useEffect(() => {
    const handler = (e: Event) => {
      if (useAppStore.getState().activeTabId !== tab.id) return;
      if (!activeTerminalId) return;
      const detail = (e as CustomEvent).detail;
      const store = useAppStore.getState();
      const terminal = store.terminals[activeTerminalId];
      if (!terminal) return;
      // Ctrl+0 reset — restore the default CLI font size (works for both the
      // xterm and native renderers; native forwards Ctrl+0 via App.tsx).
      if (detail?.reset) {
        store.setCliFontSize(terminal.type, DEFAULT_CLI_FONT_SIZE);
        return;
      }
      const delta = detail?.delta as number;
      if (!delta) return;
      const currentSize = store.cliFontSizes[terminal.type] ?? DEFAULT_CLI_FONT_SIZE;
      const newSize = Math.min(30, Math.max(8, currentSize + delta));
      store.setCliFontSize(terminal.type, newSize);
    };
    window.addEventListener("made:font-zoom", handler);
    return () => window.removeEventListener("made:font-zoom", handler);
  }, [tab.id, activeTerminalId]);

  // Auto-spawn terminals for restored tabs (session restore)
  const hasAutoSpawned = useRef(false);
  useEffect(() => {
    if (hasAutoSpawned.current) return;
    if (!tab.layout) return;
    const currentTerminals = useAppStore.getState().terminals;
    const leaves = findAllTerminalLeaves(tab.layout);
    const toSpawn = leaves.filter((leaf) => !currentTerminals[leaf.terminalId]);
    if (toSpawn.length === 0) return;
    hasAutoSpawned.current = true;
    // [DIAG-SSH-RESUME] temporary: confirm tab.serverId + leaf.sessionResumeId
    // both reach addTerminals on restore. Remove once SSH resume is verified.
    console.log("[DIAG-SSH-RESUME] Workspace auto-spawn", {
      tabId: tab.id,
      tabServerId: tab.serverId,
      tabName: tab.name,
      workingDir: tab.workingDir,
      toSpawn: toSpawn.map((l) => ({
        terminalId: l.terminalId,
        terminalType: l.terminalType,
        sessionResumeId: l.sessionResumeId,
      })),
    });
    addTerminals(
      toSpawn.map((leaf) => ({
        id: leaf.terminalId,
        type: leaf.terminalType ?? "shell",
        workingDir: tab.workingDir,
        serverId: tab.serverId,
      }))
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A Jira project keeps its rail visible in every state — including the empty
  // one, since the rail is where "new ticket" lives. So each return below is
  // wrapped rather than returned bare.
  const withRail = (content: ReactNode) => {
    if (!tab.isJiraProject) return content;
    return (
      <div className="h-full w-full flex" style={{ minWidth: 0 }}>
        <JiraTicketRail tab={tab} onFocusTerminal={handleTerminalFocus} />
        <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>{content}</div>
      </div>
    );
  };

  // A Jira project with no panes yet: the rail already offers "new ticket", so
  // the middle just says so. The generic launchers below would spawn panes that
  // aren't tickets, which would sit outside the rail's model entirely.
  if (tab.isJiraProject && (needsInitialTerminal || !tab.layout)) {
    return withRail(
      <div
        className="h-full w-full flex items-center justify-center"
        style={{ backgroundColor: "var(--ezy-bg)" }}
      >
        <div
          style={{
            fontSize: 12,
            color: "var(--ezy-text-muted)",
            textAlign: "center",
            lineHeight: 1.6,
          }}
        >
          No ticket open.
          <br />
          Add one from the rail to start investigating.
        </div>
      </div>,
    );
  }

  // Show tool selector for brand new tab
  if (needsInitialTerminal) {
    return (
      <div
        className="h-full w-full flex items-center justify-center workspace-enter"
        style={{ backgroundColor: "var(--ezy-bg)" }}
      >
        <div style={{ position: "relative" }}>
          <button
            onClick={() => setShowToolSelector((v) => !v)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "12px 24px",
              backgroundColor: "var(--ezy-surface)",
              border: "1px solid var(--ezy-border)",
              borderRadius: 8,
              color: "var(--ezy-text)",
              fontSize: 14,
              fontFamily: "inherit",
              cursor: "pointer",
              transition: "all 150ms ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = "var(--ezy-accent)";
              e.currentTarget.style.backgroundColor = "var(--ezy-surface-raised)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "var(--ezy-border)";
              e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="var(--ezy-accent)"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <line x1="8" y1="3" x2="8" y2="13" />
              <line x1="3" y1="8" x2="13" y2="8" />
            </svg>
            Open Terminal
          </button>

          {showToolSelector && (
            <ToolSelector
              onSelect={handleInitialSpawn}
              onClose={() => setShowToolSelector(false)}
            />
          )}
        </div>
      </div>
    );
  }

  // Empty tab — render the launcher in place of the layout grid. Terminal
  // panes (if any) still need to render via portals so an in-flight close
  // animation isn't visible-then-gone, but with null layout there are none.
  if (!tab.layout) {
    return <EmptyTabLauncher />;
  }

  return withRail(
    <div className="h-full w-full workspace-enter">
      <PaneGrid
        layout={tab.layout}
        tabId={tab.id}
        onLayoutChange={handleLayoutChange}
        getTerminalSlot={getSlotEl}
      />
      <FloatingPanesLayer
        layout={tab.layout}
        callbacks={floatingCallbacks}
        paneTitleFor={paneTitleFor}
      />
      {/* Render terminal panes via portals into persistent slot elements.
          This keeps them mounted even when the layout tree restructures. */}
      {allTerminalIds.map((termId) => {
        const terminal = terminals[termId];
        if (!terminal) return null;
        const slotEl = getSlotEl(termId);
        const leaf = findAllTerminalLeaves(tab.layout!).find((l) => l.terminalId === termId);
        return createPortal(
          <TerminalPane
            terminalId={termId}
            terminalType={terminal.type}
            workingDir={tab.workingDir}
            isActive={activeTerminalId === termId}
            isTabActive={isTabActive}
            paneCount={allTerminalIds.length}
            onClose={() => handleTerminalClose(termId)}
            onChangeType={(type) => {
              useAppStore.getState().changeTerminalType(termId, type);
              if (tab.layout) {
                updateTabLayout(tab.id, setTerminalTypeInLayout(tab.layout, termId, type));
              }
              // Clear session resume ID atomically (reads latest layout inside set())
              updatePaneSessionResumeId(tab.id, termId, undefined);
            }}
            onFocus={() => handleTerminalFocus(termId)}
            onSwapPane={handleSwapPane}
            onExplainError={(block) => handleTerminalExplainError(termId, block)}
            serverId={terminal.serverId}
            sessionResumeId={leaf?.sessionResumeId}
            renderer={leaf?.renderer}
            backend={tab.backend}
            onSessionResumeId={(id) => {
              updatePaneSessionResumeId(tab.id, termId, id);
            }}
            onSwitchSession={(newSessionId) => {
              updatePaneSessionResumeId(tab.id, termId, newSessionId);
            }}
          />,
          slotEl,
          termId
        );
      })}
      {/* Render browser previews via portals into persistent slot elements.
          Keeps the iframe alive when the layout tree restructures. */}
      {allBrowserPanes.map((pane) => {
        const slotEl = getBrowserSlotEl(pane.id);
        return createPortal(
          <BrowserPreview
            initialUrl={pane.url}
            linkedTabId={pane.linkedTabId}
            onClose={() => handlePaneClose(pane.id)}
          />,
          slotEl,
          pane.id
        );
      })}
    </div>,
  );
}
