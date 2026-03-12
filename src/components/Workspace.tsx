import { useCallback, useState, useRef, useMemo, useEffect } from "react";
import { createPortal } from "react-dom";
import type { Tab, TerminalType, PaneLayout } from "../types";
import { useAppStore } from "../store";
import {
  addPaneAsGrid,
  findAllTerminalIds,
  findAllTerminalLeaves,
  findPaneIdForTerminal,
  removePane,
  setSessionResumeIdInLayout,
  setTerminalTypeInLayout,
  splitPane,
  swapPanes,
  generatePaneId,
  generateTerminalId,
} from "../lib/layout-utils";
import { getPtyWrite } from "../store/terminalSlice";
import { snapshotPane } from "../store/undoCloseStore";
import type { CommandBlock } from "../lib/command-block-parser";
import PaneGrid from "./PaneGrid";
import TerminalPane, { suppressFocusTerminals } from "./TerminalPane";
import ToolSelector from "./ToolSelector";

interface WorkspaceProps {
  tab: Tab;
}

export default function Workspace({ tab }: WorkspaceProps) {
  const updateTabLayout = useAppStore((s) => s.updateTabLayout);
  const addTerminal = useAppStore((s) => s.addTerminal);
  const addTerminals = useAppStore((s) => s.addTerminals);
  const setActiveTerminal = useAppStore((s) => s.setActiveTerminal);
  const terminals = useAppStore((s) => s.terminals);
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
    tab.layout.type === "terminal" ? tab.layout.terminalId : null;
  const isRestoredLeaf =
    tab.layout.type === "terminal" && !!tab.layout.terminalType;
  const needsInitialTerminal =
    layoutTerminalId && !terminals[layoutTerminalId] && !isRestoredLeaf;

  // Collect all terminal IDs in the current layout (sorted for stable portal order)
  const allTerminalIds = useMemo(
    () => findAllTerminalIds(tab.layout).sort(),
    [tab.layout]
  );

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

  const handleLayoutChange = useCallback(
    (layout: PaneLayout) => {
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
      updateTabLayout(tab.id, setTerminalTypeInLayout(tab.layout, terminalId, type));
    },
    [addTerminal, tab.workingDir, tab.serverId, tab.id, tab.layout, updateTabLayout]
  );

  const handleInitialSpawn = useCallback(
    (type: TerminalType, serverId?: string) => {
      if (!layoutTerminalId) return;
      addTerminal(layoutTerminalId, type, tab.workingDir, serverId ?? tab.serverId);
      updateTabLayout(tab.id, setTerminalTypeInLayout(tab.layout, layoutTerminalId, type));
      setLocalActiveTerminal(layoutTerminalId);
      setShowToolSelector(false);
    },
    [addTerminal, layoutTerminalId, tab.workingDir, tab.serverId, tab.id, tab.layout, updateTabLayout]
  );

  // --- Terminal pane callbacks (used by portal-rendered TerminalPanes) ---

  const handleTerminalClose = useCallback((termId: string) => {
    const paneId = findPaneIdForTerminal(tab.layout, termId);
    if (!paneId) return;
    snapshotPane(tab.id, tab.layout);
    const newLayout = removePane(tab.layout, paneId);
    handleLayoutChange(newLayout ?? tab.layout);
  }, [tab.id, tab.layout, handleLayoutChange]);



  const handleTerminalExplainError = useCallback((termId: string, block: CommandBlock) => {
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
    handleLayoutChange(swapPanes(tab.layout, paneA, paneB));
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
      handleSpawnTerminal(newTerminalId, type, tab.serverId);

      const focusNewPane = !useAppStore.getState().openPanesInBackground;

      // Mark this terminal for focus suppression — TerminalPane will
      // override textarea.focus() until the pane becomes active.
      if (!focusNewPane) {
        suppressFocusTerminals.add(newTerminalId);
      }

      if (detail?.direction === "vertical" && activeTerminalId) {
        const paneId = findPaneIdForTerminal(tab.layout, activeTerminalId);
        if (paneId) {
          handleLayoutChange(splitPane(tab.layout, paneId, "vertical", newLeaf));
          if (focusNewPane) handleTerminalFocus(newTerminalId);
          else refocusPrevious();
          return;
        }
      }
      handleLayoutChange(addPaneAsGrid(tab.layout, newLeaf));
      if (focusNewPane) handleTerminalFocus(newTerminalId);
      else refocusPrevious();
    };
    window.addEventListener("ezydev:split-terminal", handler);
    return () => window.removeEventListener("ezydev:split-terminal", handler);
  }, [tab.id, tab.layout, tab.serverId, handleLayoutChange, handleSpawnTerminal, handleTerminalFocus, refocusPrevious]);

  // Auto-spawn terminals for restored tabs (session restore)
  const hasAutoSpawned = useRef(false);
  useEffect(() => {
    if (hasAutoSpawned.current) return;
    const currentTerminals = useAppStore.getState().terminals;
    const leaves = findAllTerminalLeaves(tab.layout);
    const toSpawn = leaves.filter((leaf) => !currentTerminals[leaf.terminalId]);
    if (toSpawn.length === 0) return;
    hasAutoSpawned.current = true;
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

  return (
    <div className="h-full w-full workspace-enter">
      <PaneGrid
        layout={tab.layout}
        tabId={tab.id}
        onLayoutChange={handleLayoutChange}
        getTerminalSlot={getSlotEl}
      />
      {/* Render terminal panes via portals into persistent slot elements.
          This keeps them mounted even when the layout tree restructures. */}
      {allTerminalIds.map((termId) => {
        const terminal = terminals[termId];
        if (!terminal) return null;
        const slotEl = getSlotEl(termId);
        const leaf = findAllTerminalLeaves(tab.layout).find((l) => l.terminalId === termId);
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
              // Clear session resume ID when switching terminal types
              let newLayout = setTerminalTypeInLayout(tab.layout, termId, type);
              newLayout = setSessionResumeIdInLayout(newLayout, termId, undefined);
              updateTabLayout(tab.id, newLayout);
            }}
            onFocus={() => handleTerminalFocus(termId)}
            onSwapPane={handleSwapPane}
            onExplainError={(block) => handleTerminalExplainError(termId, block)}
            serverId={terminal.serverId}
            sessionResumeId={leaf?.sessionResumeId}
            backend={tab.backend}
            onSessionResumeId={(id) => {
              // Read current layout from store to avoid stale closure
              const currentTab = useAppStore.getState().tabs.find(t => t.id === tab.id);
              if (currentTab) {
                updateTabLayout(tab.id, setSessionResumeIdInLayout(currentTab.layout, termId, id));
              }
            }}
          />,
          slotEl,
          termId
        );
      })}
    </div>
  );
}
