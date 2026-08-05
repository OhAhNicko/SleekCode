import { useCallback, useEffect } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { PaneLayout } from "../types";
import {
  removePane,
  redistributeEqually,
  generatePaneId,
  repositionKanbanPane,
  openOrUpdateBrowserPane,
} from "../lib/layout-utils";
import { useAppStore } from "../store";
import { snapshotPane } from "../store/undoCloseStore";
import { TerminalSlotHost, BrowserSlotHost, useSplitterDragging } from "./PaneSlotHost";
import EditorPane from "./EditorPane";
import KanbanBoard from "./KanbanBoard";
import CodeReviewPane from "./CodeReviewPane";
import FileViewerPane from "./FileViewerPane";

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

// (Last-active-game / start-paused state moved to the store's gameSidebar*
// fields when the games panel became an app-level sidebar — module globals
// could not be persisted and were shared across all grids by accident.)

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

  // P4b: splitter drag coordination for native panes. onDragging fires only
  // on drag start/end (not per mousemove) — a module-level flag in
  // frameSync.ts (no store churn) tells useNativePaneRegion to skip hole
  // recomputation while the drag is in flight; pane geometry keeps flowing
  // through the frame-sync coalescer so panes track the splitter. On
  // release, wait one rAF so each pane's rAF driver re-reads the final
  // layout and queues its exact geometry+holes, then flush that batch
  // immediately instead of waiting another coalescer frame.
  // P4b failsafe: if a PanelResizeHandle unmounts mid-drag (pane closed,
  // layout swap, tab teardown), onDragging(false) never fires and the
  // dragActive coarsening flag would stay stuck — hole recomputation frozen
  // for every native pane. Track whether a handle in THIS grid armed the
  // flag and clear it when the grid unmounts; frameSync's own watchdog
  // covers a handle that unmounts while the grid stays mounted.
  // All of the above now lives in `useSplitterDragging` (PaneSlotHost.tsx),
  // shared with the Jira stacked renderer so the two cannot drift.
  const handleSplitterDragging = useSplitterDragging();

  const handleKanbanReposition = useCallback(
    (vertical: boolean) => {
      const newLayout = repositionKanbanPane(layout, vertical);
      if (newLayout) {
        onLayoutChange(newLayout);
      }
    },
    [layout, onLayoutChange]
  );

  // Open http(s) links from the terminal panes (OSC 8 hyperlinks and
  // plain-text URLs; xterm dispatches from its link handlers, native from
  // useNativeFileLinks). `detail.inApp` picks the target: true opens MADE's
  // browser pane in this grid (Ctrl+Click — what the "Open in MADE" tooltip
  // promises), false/absent opens the system browser via Tauri's opener
  // plugin because window.open() is blocked in the WebView.
  // openUrl is an UNSCOPED global side effect (unlike the sibling open-file /
  // open-fileviewer handlers, which mutate each grid's own per-tab layout), so
  // it MUST fire from exactly one grid. Every open project tab keeps its
  // Workspace/PaneGrid mounted (inactive tabs are display:none, not unmounted),
  // so an unguarded listener would openUrl once per open tab. The link click
  // can only originate from the visible active tab, so gate on activeTabId ===
  // tabId — matching Workspace's made:font-zoom guard. The same guard keeps
  // the inApp branch single-writer: only the active tab's grid mutates layout.
  useEffect(() => {
    const dlog = (line: string) =>
      void invoke("debug_log_line", { line }).catch(() => {});
    const handler = (e: Event) => {
      const url = (e as CustomEvent).detail?.url;
      if (useAppStore.getState().activeTabId !== tabId) {
        dlog(`[open-url] grid ${tabId} skipped (inactive tab) url=${url}`);
        return;
      }
      if (typeof url !== "string" || !url) return;
      if ((e as CustomEvent).detail?.inApp) {
        dlog(`[open-url] grid ${tabId} → browser pane url=${url}`);
        const s = useAppStore.getState();
        const { layout: newLayout } = openOrUpdateBrowserPane(layout, url, {
          sizePercent: 35,
          fullColumn: s.browserFullColumn,
          spawnLeft: s.browserSpawnLeft,
          wideGridLayout: s.wideGridLayout,
        });
        onLayoutChange(newLayout);
        return;
      }
      // NOT silently — a rejected openUrl (opener scope, shell failure)
      // looked exactly like "clicking does nothing" for weeks.
      openUrl(url).then(
        () => dlog(`[open-url] grid ${tabId} → external OK url=${url}`),
        (err) => {
          console.error("[PaneGrid] openUrl failed", url, err);
          dlog(`[open-url] grid ${tabId} → external FAILED url=${url} err=${String(err)}`);
        },
      );
    };
    window.addEventListener("made:open-url", handler);
    return () => window.removeEventListener("made:open-url", handler);
  }, [tabId, layout, onLayoutChange]);

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
    window.addEventListener("made:open-codereview", handler);
    return () => window.removeEventListener("made:open-codereview", handler);
  }, [layout, onLayoutChange]);

  // The games panel used to live here as a `game` pane, opened by an unguarded
  // made:open-game listener that ran in EVERY mounted grid while the pane's X
  // removed only one copy. It is now a single app-level sidebar — see
  // GameSidebar.tsx and gameSlice's gameSidebar* state.

  // Global code-review close. The X in CodeReviewPane emits this so the pane
  // disappears from EVERY project tab at once — the counterpart to
  // made:open-codereview, which every mounted grid handles (inactive tabs are
  // display:none, not unmounted) and so opens the pane in every tab. Closing it
  // locally left a copy behind in every other project. Same shape as
  // made:close-fileviewer.
  useEffect(() => {
    const handler = () => {
      const findCodeReviewIds = (node: PaneLayout, out: string[]): string[] => {
        if (node.type === "codereview") out.push(node.id);
        if (node.type === "split") {
          findCodeReviewIds(node.children[0], out);
          findCodeReviewIds(node.children[1], out);
        }
        return out;
      };
      // Normally one per tab, but a layout can legitimately hold several.
      // Remove them one at a time off the freshest layout each round.
      let next = layout;
      for (const id of findCodeReviewIds(layout, [])) {
        const removed = removePane(next, id);
        if (removed) next = removed;
      }
      if (next !== layout) {
        snapshotPane(tabId, layout);
        onLayoutChange(redistributeOnClose ? redistributeEqually(next) : next);
      }
    };
    window.addEventListener("made:close-codereview", handler);
    return () => window.removeEventListener("made:close-codereview", handler);
  }, [layout, onLayoutChange, tabId, redistributeOnClose]);

  // Listen for file-open events (sidebar click, terminal Ctrl+Click, code
  // review, markdown link) and route them to the tabbed file viewer.
  //
  // Both event names land here directly. `made:open-file` used to be bounced
  // through a re-dispatch of `made:open-fileviewer`, but every open project tab
  // keeps its PaneGrid mounted (inactive tabs are display:none, not unmounted),
  // so N mounted grids re-emitted the same event N times and each of them then
  // handled all N copies. Handling the source event once per grid gives the same
  // result without the amplification — and without making delivery depend on
  // which tab happens to be active, so opening a file still works while a system
  // tab (Kanban, Dev Server) is in front.
  //
  // By default the text editor is a GLOBAL surface: every project tab's grid
  // handles this, so a file opens in every project and the editor sits in the
  // same place whichever project you switch to. With `perProjectEditor` on, each
  // tab owns an independent editor and only the active tab reacts.
  useEffect(() => {
    const handler = (e: Event) => {
      if (
        useAppStore.getState().perProjectEditor &&
        useAppStore.getState().activeTabId !== tabId
      ) {
        return;
      }
      const detail = (e as CustomEvent).detail;
      if (!detail?.filePath) return;
      const filePath: string = detail.filePath;

      // Opening a file also opens the file sidebar with the file highlighted
      // (closable as ever). Every mounted grid runs this handler — gate on
      // the active tab so the request fires exactly once.
      if (useAppStore.getState().activeTabId === tabId) {
        useAppStore.getState().requestRevealFile(filePath);
      }

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
          new CustomEvent("made:fileviewer-add", {
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
    window.addEventListener("made:open-file", handler);
    window.addEventListener("made:open-fileviewer", handler);
    return () => {
      window.removeEventListener("made:open-file", handler);
      window.removeEventListener("made:open-fileviewer", handler);
    };
  }, [layout, onLayoutChange, tabId]);

  // Global editor close. The X in FileViewerPane emits this (unless
  // `perProjectEditor` is on, in which case it closes locally instead) so the
  // editor disappears from EVERY project tab at once — the counterpart to
  // made:open-fileviewer opening it in every tab. Routed through handleClose so
  // the undo snapshot and pane-mode cleanup are identical to a local close.
  useEffect(() => {
    const handler = () => {
      const findFileViewerIds = (node: PaneLayout, out: string[]): string[] => {
        if (node.type === "fileviewer") out.push(node.id);
        if (node.type === "split") {
          findFileViewerIds(node.children[0], out);
          findFileViewerIds(node.children[1], out);
        }
        return out;
      };
      // Normally one per tab, but a layout can legitimately hold several.
      // Remove them one at a time off the freshest layout each round.
      let next = layout;
      for (const id of findFileViewerIds(layout, [])) {
        const removed = removePane(next, id);
        if (removed) next = removed;
      }
      if (next !== layout) {
        snapshotPane(tabId, layout);
        onLayoutChange(redistributeOnClose ? redistributeEqually(next) : next);
      }
      // The editor is gone — take the file sidebar with it IF a reveal
      // auto-opened it (never a sidebar the user opened). Idempotent, so
      // every mounted grid running this handler is fine.
      useAppStore.getState().closeAutoOpenedSidebar();
    };
    window.addEventListener("made:close-fileviewer", handler);
    return () => window.removeEventListener("made:close-fileviewer", handler);
  }, [layout, onLayoutChange, tabId, redistributeOnClose]);

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
    window.addEventListener("made:open-remote-editor", handler);
    return () => window.removeEventListener("made:open-remote-editor", handler);
  }, [layout, onLayoutChange]);

  const renderPane = (node: PaneLayout): React.ReactNode => {
    // Skip leaves that are currently expanded/floating/closing — siblings reflow.
    const resolved = resolveNodeForRender(node, paneModes, closingPanes);
    if (!resolved) return null;
    if (resolved.id !== node.id) return renderPane(resolved);
    node = resolved;

    if (node.type === "terminal") {
      return (
        <TerminalSlotHost
          key={node.id}
          paneId={node.id}
          terminalId={node.terminalId}
          getTerminalSlot={getTerminalSlot}
        />
      );
    }

    if (node.type === "browser") {
      return <BrowserSlotHost key={node.id} paneId={node.id} />;
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

    // Defensive: the games panel is an app-level sidebar now, and the store's
    // merge hook strips every persisted `game` node on load. Should one survive,
    // render nothing rather than falling through to the split branch below,
    // which would read `direction`/`children` off a leaf and crash the grid.
    if (node.type === "game") return null;

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
          onDragging={handleSplitterDragging}
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
