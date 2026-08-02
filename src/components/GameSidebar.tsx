import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "../store";
import { GAME_SIDEBAR_MAX_WIDTH, GAME_SIDEBAR_MIN_WIDTH } from "../store/gameSlice";
import GamePane from "./GamePane";

/**
 * The games panel, as ONE app-level sidebar.
 *
 * It used to be a `game` node inside every tab's layout tree. Every open project
 * tab keeps its PaneGrid mounted (inactive tabs are `display:none`, not
 * unmounted), so the unguarded `made:open-game` listener added a copy to EVERY
 * tab, while the pane's X removed only the active tab's copy — closing it "once"
 * left copies behind in every other project. Rendering one instance driven by
 * one boolean (`gameSidebarOpen`) makes open and close global by construction,
 * with no event to keep N grids in sync.
 *
 * Mounted once in App.tsx, as a sibling of the left `Sidebar`. Only rendered
 * while open, so its listeners are live exactly when they can apply.
 */
export default function GameSidebar() {
  const storedWidth = useAppStore((s) => s.gameSidebarWidth);
  const setWidth = useAppStore((s) => s.setGameSidebarWidth);
  const closeGameSidebar = useAppStore((s) => s.closeGameSidebar);
  const initialGame = useAppStore((s) => s.gameSidebarGame);
  const autoMinimizeGameOnAiDone = useAppStore((s) => s.autoMinimizeGameOnAiDone);

  // Read once at mount: the AI-done auto-close arms this so the next open comes
  // back paused. Reading it live would unpause the running game the moment the
  // flag cleared.
  const [startPaused] = useState(() => useAppStore.getState().gameSidebarPaused);

  // Live width while dragging. It stays in component state and is committed to
  // the store once, on release: zustand's persist middleware writes on EVERY
  // set, so storing each mousemove would serialize the whole app state (tabs,
  // layouts, highscores) to localStorage ~60×/second for the length of a drag.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = dragWidth ?? storedWidth;

  // Close everywhere when the AI finishes, if enabled, and arm a paused
  // restart. One listener because there is one sidebar — the old pane ran this
  // once per mounted grid.
  useEffect(() => {
    if (!autoMinimizeGameOnAiDone) return;
    const handler = () => closeGameSidebar({ paused: true });
    window.addEventListener("made:ai-done", handler);
    return () => window.removeEventListener("made:ai-done", handler);
  }, [autoMinimizeGameOnAiDone, closeGameSidebar]);

  // Drag the LEFT edge: the sidebar is right-docked, so moving the pointer left
  // grows it. Replaces the in-grid splitter the pane used to have.
  // Holds the teardown for an in-flight drag so unmounting mid-drag (the AI-done
  // auto-close can fire while the pointer is still down) cannot strand the
  // window listeners.
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = useAppStore.getState().gameSidebarWidth;
      // Clamp here too, not only in the store action, so the rail cannot render
      // out-of-range mid-drag and then snap on release.
      const clamp = (w: number) =>
        Math.max(GAME_SIDEBAR_MIN_WIDTH, Math.min(GAME_SIDEBAR_MAX_WIDTH, Math.round(w)));
      let latest = startWidth;

      const onMove = (ev: MouseEvent) => {
        latest = clamp(startWidth - (ev.clientX - startX));
        setDragWidth(latest);
      };
      const stop = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", stop);
        dragCleanupRef.current = null;
        setWidth(latest); // the one persisted write per drag
        setDragWidth(null);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", stop);
      dragCleanupRef.current = stop;
    },
    [setWidth]
  );

  useEffect(() => () => dragCleanupRef.current?.(), []);

  return (
    <div
      style={{
        width,
        flexShrink: 0,
        backgroundColor: "var(--ezy-surface)",
        borderLeft: "1px solid var(--ezy-border-subtle)",
        display: "flex",
        height: "100%",
        overflow: "hidden",
      }}
    >
      <div
        onMouseDown={onResizeStart}
        title="Resize"
        style={{
          width: 4,
          flexShrink: 0,
          cursor: "col-resize",
          backgroundColor: dragWidth !== null ? "var(--ezy-accent)" : "transparent",
          transition: "background-color 120ms ease",
        }}
        onMouseEnter={(e) => {
          if (dragWidth === null) e.currentTarget.style.backgroundColor = "var(--ezy-surface-raised)";
        }}
        onMouseLeave={(e) => {
          if (dragWidth === null) e.currentTarget.style.backgroundColor = "transparent";
        }}
      />
      <div style={{ flex: 1, minWidth: 0, height: "100%" }}>
        <GamePane
          onClose={() => closeGameSidebar()}
          initialGame={initialGame}
          startPaused={startPaused}
        />
      </div>
    </div>
  );
}
