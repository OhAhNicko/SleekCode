import type { PaneLayout } from "../types";
import BrowserPreview from "../components/BrowserPreview";
import EditorPane from "../components/EditorPane";
import KanbanBoard from "../components/KanbanBoard";
import CodeReviewPane from "../components/CodeReviewPane";
import FileViewerPane from "../components/FileViewerPane";
import GamePane from "../components/GamePane";

export interface RenderLeafCallbacks {
  onClose: (paneId: string) => void;
  onKanbanReposition?: (vertical: boolean) => void;
  /** Returns the persistent slot element for a terminal (managed by Workspace). */
  getTerminalSlot: (terminalId: string) => HTMLDivElement;
}

/**
 * Mount the persistent slot into the given container element. Handles both
 * fresh appends and re-parenting between containers (preserving xterm scrollTop).
 */
export function mountTerminalSlot(container: HTMLElement, slot: HTMLDivElement) {
  if (slot.parentElement === container) return;
  // Remove any stale child from this container before mounting
  while (container.firstChild) container.removeChild(container.firstChild);
  container.appendChild(slot);
  const viewport = slot.querySelector(".xterm-viewport") as HTMLElement | null;
  const saved = viewport?.dataset.savedScrollTop;
  if (viewport && saved) {
    const scrollTop = parseFloat(saved);
    if (scrollTop > 0) viewport.scrollTop = scrollTop;
  }
}

/**
 * Render a leaf pane node (any non-split type). Returns null for split nodes —
 * those stay in PaneGrid because recursion is host-specific.
 */
export function renderLeafPane(
  node: PaneLayout,
  cb: RenderLeafCallbacks
): React.ReactNode {
  if (node.type === "terminal") {
    return (
      <div
        key={node.id}
        className="h-full w-full"
        ref={(el) => {
          if (el) mountTerminalSlot(el, cb.getTerminalSlot(node.terminalId));
        }}
      />
    );
  }

  if (node.type === "browser") {
    return (
      <BrowserPreview
        key={node.id}
        initialUrl={node.url}
        onClose={() => cb.onClose(node.id)}
      />
    );
  }

  if (node.type === "editor") {
    return (
      <EditorPane
        key={node.id}
        paneId={node.id}
        filePath={node.filePath}
        language={node.language}
        serverId={node.serverId}
        onClose={() => cb.onClose(node.id)}
      />
    );
  }

  if (node.type === "kanban") {
    return (
      <KanbanBoard
        key={node.id}
        paneId={node.id}
        onClose={() => cb.onClose(node.id)}
        initialVertical={node.vertical}
        onReposition={cb.onKanbanReposition ?? (() => {})}
      />
    );
  }

  if (node.type === "codereview") {
    return <CodeReviewPane key={node.id} paneId={node.id} onClose={() => cb.onClose(node.id)} />;
  }

  if (node.type === "fileviewer") {
    return (
      <FileViewerPane
        key={node.id}
        paneId={node.id}
        initialFiles={node.files}
        initialActive={node.activeFile}
        onClose={() => cb.onClose(node.id)}
      />
    );
  }

  if (node.type === "game") {
    return (
      <GamePane
        key={node.id}
        onClose={() => cb.onClose(node.id)}
        initialGame={node.game}
        startPaused={node.startPaused}
      />
    );
  }

  return null;
}
