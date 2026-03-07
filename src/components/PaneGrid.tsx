import { useCallback, useEffect } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import type { PaneLayout } from "../types";
import {
  splitPane,
  removePane,
  generatePaneId,
  findFirstLeafId,
} from "../lib/layout-utils";
import { snapshotPane } from "../store/undoCloseStore";
import BrowserPreview from "./BrowserPreview";
import EditorPane from "./EditorPane";
import KanbanBoard from "./KanbanBoard";
import CodeReviewPane from "./CodeReviewPane";
import FileViewerPane from "./FileViewerPane";

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
  const handleClose = useCallback(
    (paneId: string) => {
      snapshotPane(tabId, layout);
      const newLayout = removePane(layout, paneId);
      if (newLayout) {
        onLayoutChange(newLayout);
      }
    },
    [tabId, layout, onLayoutChange]
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

  // Listen for code review open events
  useEffect(() => {
    const handler = () => {
      // Check if a codereview pane already exists
      const hasCodeReview = (node: PaneLayout): boolean => {
        if (node.type === "codereview") return true;
        if (node.type === "split") {
          return hasCodeReview(node.children[0]) || hasCodeReview(node.children[1]);
        }
        return false;
      };
      if (hasCodeReview(layout)) return;

      const codeReviewPane = {
        type: "codereview" as const,
        id: generatePaneId(),
      };
      const firstPaneId = findFirstLeafId(layout);
      if (firstPaneId) {
        const newLayout = splitPane(layout, firstPaneId, "horizontal", codeReviewPane);
        onLayoutChange(newLayout);
      }
    };
    window.addEventListener("ezydev:open-codereview", handler);
    return () => window.removeEventListener("ezydev:open-codereview", handler);
  }, [layout, onLayoutChange]);

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

      // Create new file viewer pane
      const viewerPane = {
        type: "fileviewer" as const,
        id: generatePaneId(),
        files: [filePath],
        activeFile: filePath,
      };
      const firstPaneId = findFirstLeafId(layout);
      if (firstPaneId) {
        const newLayout = splitPane(layout, firstPaneId, "horizontal", viewerPane);
        onLayoutChange(newLayout);
      }
    };
    window.addEventListener("ezydev:open-fileviewer", handler);
    return () => window.removeEventListener("ezydev:open-fileviewer", handler);
  }, [layout, onLayoutChange]);

  const renderPane = (node: PaneLayout): React.ReactNode => {
    if (node.type === "terminal") {
      return (
        <div
          key={node.id}
          className="h-full w-full"
          ref={(el) => {
            if (el) {
              const slot = getTerminalSlot(node.terminalId);
              if (slot.parentElement !== el) {
                // Remove stale slot (from a previous terminal assigned to this pane)
                while (el.firstChild) el.removeChild(el.firstChild);
                el.appendChild(slot);
              }
            }
          }}
        />
      );
    }

    if (node.type === "browser") {
      return (
        <BrowserPreview
          key={node.id}
          initialUrl={node.url}
          onClose={() => handleClose(node.id)}
        />
      );
    }

    if (node.type === "editor") {
      return (
        <EditorPane
          key={node.id}
          filePath={node.filePath}
          language={node.language}
          onClose={() => handleClose(node.id)}
        />
      );
    }

    if (node.type === "kanban") {
      return <KanbanBoard key={node.id} onClose={() => handleClose(node.id)} />;
    }

    if (node.type === "codereview") {
      return <CodeReviewPane key={node.id} onClose={() => handleClose(node.id)} />;
    }

    if (node.type === "fileviewer") {
      return (
        <FileViewerPane
          key={node.id}
          initialFiles={node.files}
          initialActive={node.activeFile}
          onClose={() => handleClose(node.id)}
        />
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
    <div className="h-full w-full" style={{ backgroundColor: "var(--ezy-bg)" }}>
      {renderPane(layout)}
    </div>
  );
}
