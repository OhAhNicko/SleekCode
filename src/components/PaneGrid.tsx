import { useCallback, useEffect } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import type { PaneLayout, GameType } from "../types";
import {
  removePane,
  redistributeEqually,
  generatePaneId,
  repositionKanbanPane,
} from "../lib/layout-utils";
import { useAppStore } from "../store";
import { snapshotPane } from "../store/undoCloseStore";
import BrowserPreview from "./BrowserPreview";
import EditorPane from "./EditorPane";
import KanbanBoard from "./KanbanBoard";
import CodeReviewPane from "./CodeReviewPane";
import FileViewerPane from "./FileViewerPane";
import GamePane from "./GamePane";

/** True if a pane is currently outside the grid (expanded/float) or animating closed. */
function isFloatingId(
  paneId: string,
  paneModes: Record<string, string>,
  closingPanes: Record<string, true>
): boolean {
  const mode = paneModes[paneId];
  return mode === "expanded" || mode === "float" || !!closingPanes[paneId];
}

/**
 * Determine what to render for a node, accounting for floating panes.
 * - If a leaf is floating/closing, return null (caller skips it).
 * - If a split has both children floating, return null.
 * - If a split has one child floating, return the surviving child node.
 * Otherwise return the node unchanged.
 */
function resolveNodeForRender(
  node: PaneLayout,
  paneModes: Record<string, string>,
  closingPanes: Record<string, true>
): PaneLayout | null {
  if (node.type !== "split") {
    return isFloatingId(node.id, paneModes, closingPanes) ? null : node;
  }
  const left = resolveNodeForRender(node.children[0], paneModes, closingPanes);
  const right = resolveNodeForRender(node.children[1], paneModes, closingPanes);
  if (left && right) return node;
  if (left) return left;
  if (right) return right;
  return null;
}

// Remember last active game so toggling off/on resumes it
let lastActiveGame: GameType | undefined;
// When game pane was auto-closed by AI-done, reopen it paused
let shouldStartPaused = false;

interface PaneGridProps {
  layout: PaneLayout;
  tabId: string;
  onLayoutChange: (layout: PaneLayout) => void;
  getTerminalSlot: (terminalId: string) => HTMLDivElement;
}

export default function PaneGrid({
  layout,
  tabId,
  onLayoutChange,
  getTerminalSlot,
}: PaneGridProps) {
  const autoMinimizeGameOnAiDone = useAppStore((s) => s.autoMinimizeGameOnAiDone);
  const redistributeOnClose = useAppStore((s) => s.redistributeOnClose);
  const paneModes = useAppStore((s) => s.paneModes);
  const closingPanes = useAppStore((s) => s.closingPanes);

  const handleClose = useCallback(
    (paneId: string) => {
      snapshotPane(tabId, layout);
      const removed = removePane(layout, paneId);
      if (removed) {
        const next = redistributeOnClose ? redistributeEqually(removed) : removed;
        onLayoutChange(next);
      }
    },
    [tabId, layout, onLayoutChange, redistributeOnClose]
  );

  const handleKanbanReposition = useCallback(
    (vertical: boolean) => {
      const newLayout = repositionKanbanPane(layout, vertical);
      if (newLayout) {
        onLayoutChange(newLayout);
      }
    },
    [layout, onLayoutChange]
  );

  // Listen for sidebar file-open events — route to tabbed file viewer
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.filePath) return;
      // Route to the file viewer (creates one or adds to existing)
      window.dispatchEvent(
        new CustomEvent("ezydev:open-fileviewer", { detail: { filePath: detail.filePath, lineNumber: detail.lineNumber } })
      );
    };
    window.addEventListener("ezydev:open-file", handler);
    return () => window.removeEventListener("ezydev:open-file", handler);
  }, [layout, onLayoutChange]);

  // Toggle code review pane (open on right / close if already open)
  useEffect(() => {
    const handler = () => {
      const findCodeReviewId = (node: PaneLayout): string | null => {
        if (node.type === "codereview") return node.id;
        if (node.type === "split") {
          return findCodeReviewId(node.children[0]) ?? findCodeReviewId(node.children[1]);
        }
        return null;
      };
      const existingId = findCodeReviewId(layout);
      if (existingId) {
        // Close it
        const newLayout = removePane(layout, existingId);
        if (newLayout) onLayoutChange(newLayout);
        return;
      }
      // Open on far right
      const codeReviewPane = {
        type: "codereview" as const,
        id: generatePaneId(),
      };
      const newLayout: PaneLayout = {
        type: "split",
        id: generatePaneId(),
        direction: "horizontal",
        children: [layout, codeReviewPane],
        sizes: [70, 30],
      };
      onLayoutChange(newLayout);
    };
    window.addEventListener("ezydev:open-codereview", handler);
    return () => window.removeEventListener("ezydev:open-codereview", handler);
  }, [layout, onLayoutChange]);

  // Toggle game pane (open on right / close if already open)
  // When closing, remember the active game; when reopening, resume it
  useEffect(() => {
    const handler = () => {
      const findGameNode = (node: PaneLayout): { id: string; game?: GameType } | null => {
        if (node.type === "game") return { id: node.id, game: node.game };
        if (node.type === "split") {
          return findGameNode(node.children[0]) ?? findGameNode(node.children[1]);
        }
        return null;
      };
      const existing = findGameNode(layout);
      if (existing) {
        // Save the current game selection before closing
        if (existing.game) lastActiveGame = existing.game;
        const newLayout = removePane(layout, existing.id);
        if (newLayout) onLayoutChange(newLayout);
        return;
      }
      const gamePane = {
        type: "game" as const,
        id: generatePaneId(),
        game: lastActiveGame, // resume previous game if any
        startPaused: shouldStartPaused,
      };
      shouldStartPaused = false;
      const newLayout: PaneLayout = {
        type: "split",
        id: generatePaneId(),
        direction: "horizontal",
        children: [layout, gamePane],
        sizes: [65, 35],
      };
      onLayoutChange(newLayout);
    };

    // Listen for game-active broadcast from GamePane to track current game
    const gameActiveHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.game) lastActiveGame = detail.game as GameType;
      else lastActiveGame = undefined;
    };

    window.addEventListener("ezydev:open-game", handler);
    window.addEventListener("ezydev:game-active", gameActiveHandler);
    return () => {
      window.removeEventListener("ezydev:open-game", handler);
      window.removeEventListener("ezydev:game-active", gameActiveHandler);
    };
  }, [layout, onLayoutChange]);

  // Auto-minimize game pane when AI finishes working
  useEffect(() => {
    if (!autoMinimizeGameOnAiDone) return;
    const handler = () => {
      const findGameNode = (node: PaneLayout): { id: string; game?: GameType } | null => {
        if (node.type === "game") return { id: node.id, game: node.game };
        if (node.type === "split") {
          return findGameNode(node.children[0]) ?? findGameNode(node.children[1]);
        }
        return null;
      };
      const existing = findGameNode(layout);
      if (!existing) return;
      // Save game and mark for paused restart
      if (existing.game) lastActiveGame = existing.game;
      shouldStartPaused = true;
      const newLayout = removePane(layout, existing.id);
      if (newLayout) onLayoutChange(newLayout);
    };
    window.addEventListener("ezydev:ai-done", handler);
    return () => window.removeEventListener("ezydev:ai-done", handler);
  }, [layout, onLayoutChange, autoMinimizeGameOnAiDone]);

  // Listen for file viewer open events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.filePath) return;
      const filePath: string = detail.filePath;

      // Check if a fileviewer pane already exists — if so, add the file to it
      const findFileViewer = (node: PaneLayout): string | null => {
        if (node.type === "fileviewer") return node.id;
        if (node.type === "split") {
          return findFileViewer(node.children[0]) ?? findFileViewer(node.children[1]);
        }
        return null;
      };

      const existingId = findFileViewer(layout);
      if (existingId) {
        // Dispatch add-file event to existing viewer
        window.dispatchEvent(
          new CustomEvent("ezydev:fileviewer-add", {
            detail: { filePath, viewerId: existingId },
          })
        );
        return;
      }

      // Create new file viewer pane on the far right
      const viewerPane = {
        type: "fileviewer" as const,
        id: generatePaneId(),
        files: [filePath],
        activeFile: filePath,
      };
      const newLayout: PaneLayout = {
        type: "split",
        id: generatePaneId(),
        direction: "horizontal",
        children: [layout, viewerPane],
        sizes: [70, 30],
      };
      onLayoutChange(newLayout);
    };
    window.addEventListener("ezydev:open-fileviewer", handler);
    return () => window.removeEventListener("ezydev:open-fileviewer", handler);
  }, [layout, onLayoutChange]);

  // Remote editor: open an EditorPane with serverId so file I/O routes over SSH.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.filePath || !detail?.serverId) return;
      const filePath: string = detail.filePath;
      const serverId: string = detail.serverId;

      // If an editor for this exact remote file is already open, just focus-ish (no-op for now).
      const findEditor = (node: PaneLayout): string | null => {
        if (node.type === "editor" && node.filePath === filePath && node.serverId === serverId) return node.id;
        if (node.type === "split") {
          return findEditor(node.children[0]) ?? findEditor(node.children[1]);
        }
        return null;
      };
      if (findEditor(layout)) return;

      const editorPane = {
        type: "editor" as const,
        id: generatePaneId(),
        filePath,
        serverId,
      };
      const newLayout: PaneLayout = {
        type: "split",
        id: generatePaneId(),
        direction: "horizontal",
        children: [layout, editorPane],
        sizes: [60, 40],
      };
      onLayoutChange(newLayout);
    };
    window.addEventListener("ezydev:open-remote-editor", handler);
    return () => window.removeEventListener("ezydev:open-remote-editor", handler);
  }, [layout, onLayoutChange]);

  const renderPane = (node: PaneLayout): React.ReactNode => {
    // Skip leaves that are currently expanded/floating/closing — siblings reflow.
    const resolved = resolveNodeForRender(node, paneModes, closingPanes);
    if (!resolved) return null;
    if (resolved.id !== node.id) return renderPane(resolved);
    node = resolved;

    if (node.type === "terminal") {
      return (
        <div
          key={node.id}
          data-pane-id={node.id}
          className="h-full w-full"
          ref={(el) => {
            if (el) {
              const slot = getTerminalSlot(node.terminalId);
              if (slot.parentElement !== el) {
                // Remove stale slot (from a previous terminal assigned to this pane)
                while (el.firstChild) el.removeChild(el.firstChild);
                el.appendChild(slot);
                // Restore scrollTop — DOM detachment silently resets it to 0,
                // and no scroll events fire on detached elements. TerminalPane
                // continuously saves the real scrollTop as a data attribute.
                const viewport = slot.querySelector(".xterm-viewport") as HTMLElement | null;
                const saved = viewport?.dataset.savedScrollTop;
                if (viewport && saved) {
                  const scrollTop = parseFloat(saved);
                  if (scrollTop > 0) viewport.scrollTop = scrollTop;
                }
              }
            }
          }}
        />
      );
    }

    if (node.type === "browser") {
      return (
        <div key={node.id} data-pane-id={node.id} className="h-full w-full">
          <BrowserPreview
            initialUrl={node.url}
            onClose={() => handleClose(node.id)}
          />
        </div>
      );
    }

    if (node.type === "editor") {
      return (
        <div key={node.id} data-pane-id={node.id} className="h-full w-full">
          <EditorPane
            paneId={node.id}
            filePath={node.filePath}
            language={node.language}
            serverId={node.serverId}
            onClose={() => handleClose(node.id)}
          />
        </div>
      );
    }

    if (node.type === "kanban") {
      return (
        <div key={node.id} data-pane-id={node.id} className="h-full w-full">
          <KanbanBoard
            paneId={node.id}
            onClose={() => handleClose(node.id)}
            initialVertical={node.vertical}
            onReposition={handleKanbanReposition}
          />
        </div>
      );
    }

    if (node.type === "codereview") {
      return (
        <div key={node.id} data-pane-id={node.id} className="h-full w-full">
          <CodeReviewPane paneId={node.id} onClose={() => handleClose(node.id)} />
        </div>
      );
    }

    if (node.type === "fileviewer") {
      return (
        <div key={node.id} data-pane-id={node.id} className="h-full w-full">
          <FileViewerPane
            paneId={node.id}
            initialFiles={node.files}
            initialActive={node.activeFile}
            onClose={() => handleClose(node.id)}
          />
        </div>
      );
    }

    if (node.type === "game") {
      return (
        <div key={node.id} data-pane-id={node.id} className="h-full w-full">
          <GamePane
            onClose={() => handleClose(node.id)}
            initialGame={node.game}
            startPaused={node.startPaused}
          />
        </div>
      );
    }

    // Split node
    const direction =
      node.direction === "horizontal" ? "horizontal" : "vertical";

    return (
      <PanelGroup
        key={node.id}
        direction={direction}
        autoSaveId={node.id}
      >
        <Panel minSize={10} defaultSize={node.sizes?.[0] ?? 50}>
          {renderPane(node.children[0])}
        </Panel>
        <PanelResizeHandle
          style={{
            width: direction === "horizontal" ? 4 : undefined,
            height: direction === "vertical" ? 4 : undefined,
            backgroundColor: "var(--ezy-surface-raised)",
            cursor:
              direction === "horizontal" ? "col-resize" : "row-resize",
            position: "relative",
          }}
        />
        <Panel minSize={10} defaultSize={node.sizes?.[1] ?? 50}>
          {renderPane(node.children[1])}
        </Panel>
      </PanelGroup>
    );
  };

  return (
    <div data-grid-root className="h-full w-full" style={{ backgroundColor: "var(--ezy-bg)" }}>
      {renderPane(layout)}
    </div>
  );
}
