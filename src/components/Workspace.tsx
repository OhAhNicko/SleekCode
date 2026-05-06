import { useCallback, useState, useRef, useMemo, useEffect } from "react";
import { createPortal } from "react-dom";
import type { Tab, TerminalType, PaneLayout } from "../types";
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
import { snapshotPane } from "../store/undoCloseStore";
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
  // as "active" and its EzyComposer initializes properly via Case 1.
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
  // ResizeObserver on each placeholder for drag-resize and an rAF loop while
  // the user is resizing (PanelResizeHandle dragging only fires resize events
  // on the panel children).
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

    syncAll();

    // ResizeObserver fires when placeholders resize (window resize, pane drag,
    // sidebar collapse, etc.) and also fires once on observe — so it covers
    // the initial measurement after layout changes mount new placeholders.
    const ro = new ResizeObserver(syncAll);
    document
      .querySelectorAll("[data-browser-pane-id]")
      .forEach((el) => ro.observe(el));

    // Continuous rAF keeps the slot following FLIP animations on
    // expand/float/close (those use Web Animations API transforms which don't
    // trigger ResizeObserver). Cheap — fixed-position writes don't reflow.
    let rafId = requestAnimationFrame(function tick() {
      syncAll();
      rafId = requestAnimationFrame(tick);
    });

    window.addEventListener("resize", syncAll);
    window.addEventListener("scroll", syncAll, true);

    return () => {
      ro.disconnect();
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", syncAll);
      window.removeEventListener("scroll", syncAll, true);
    };
  }, [allBrowserPanes, tab.layout, paneModes, closingPanes]);

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
    (terminalId: string, type: TerminalType, serverId?: string) => {
      addTerminal(terminalId, type, tab.workingDir, serverId ?? tab.serverId);
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

      const newTerminalId = generateTerminalId();
      const newLeaf = { type: "terminal" as const, id: generatePaneId(), terminalId: newTerminalId, terminalType: type };

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
        addTerminal(newTerminalId, type, tab.workingDir, tab.serverId);
        handleLayoutChange(newLeaf);
        if (focusNewPane) handleTerminalFocus(newTerminalId);
        else refocusPrevious();
        return;
      }

      handleSpawnTerminal(newTerminalId, type, tab.serverId);

      if (detail?.direction === "vertical" && activeTerminalId) {
        const paneId = findPaneIdForTerminal(tab.layout, activeTerminalId);
        if (paneId) {
          handleLayoutChange(splitPane(tab.layout, paneId, "vertical", newLeaf));
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
    window.addEventListener("ezydev:split-terminal", handler);
    return () => window.removeEventListener("ezydev:split-terminal", handler);
  }, [tab.id, tab.layout, tab.serverId, handleLayoutChange, handleSpawnTerminal, handleTerminalFocus, refocusPrevious]);

  // Listen for close-pane events (Ctrl+W)
  useEffect(() => {
    const handler = () => {
      if (useAppStore.getState().activeTabId !== tab.id) return;
      if (!activeTerminalId) return;
      handleTerminalClose(activeTerminalId);
    };
    window.addEventListener("ezydev:close-pane", handler);
    return () => window.removeEventListener("ezydev:close-pane", handler);
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
    window.addEventListener("ezydev:focus-next-pane", nextHandler);
    window.addEventListener("ezydev:focus-prev-pane", prevHandler);
    return () => {
      window.removeEventListener("ezydev:focus-next-pane", nextHandler);
      window.removeEventListener("ezydev:focus-prev-pane", prevHandler);
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

  // Listen for clear-terminal events (Ctrl+L)
  useEffect(() => {
    const handler = () => {
      if (useAppStore.getState().activeTabId !== tab.id) return;
      if (!activeTerminalId) return;
      const writeFn = getPtyWrite(activeTerminalId);
      if (writeFn) writeFn("\x0c"); // Send form-feed (Ctrl+L) to PTY
    };
    window.addEventListener("ezydev:clear-terminal", handler);
    return () => window.removeEventListener("ezydev:clear-terminal", handler);
  }, [tab.id, activeTerminalId]);

  // Listen for font-zoom events (Ctrl++/Ctrl+-)
  useEffect(() => {
    const handler = (e: Event) => {
      if (useAppStore.getState().activeTabId !== tab.id) return;
      if (!activeTerminalId) return;
      const delta = (e as CustomEvent).detail?.delta as number;
      if (!delta) return;
      const terminal = useAppStore.getState().terminals[activeTerminalId];
      if (!terminal) return;
      const store = useAppStore.getState();
      const currentSize = store.cliFontSizes[terminal.type] ?? 15;
      const newSize = Math.min(30, Math.max(8, currentSize + delta));
      store.setCliFontSize(terminal.type, newSize);
    };
    window.addEventListener("ezydev:font-zoom", handler);
    return () => window.removeEventListener("ezydev:font-zoom", handler);
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

  return (
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
    </div>
  );
}
