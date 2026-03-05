import { useEffect, useState, useMemo, useCallback } from "react";
import { useAppStore } from "./store";
import { getTheme } from "./lib/themes";
import TabBar from "./components/TabBar";
import Workspace from "./components/Workspace";
import DevServerTab from "./components/DevServerTab";
import ServersPanel from "./components/ServersPanel";
import KanbanBoard from "./components/KanbanBoard";
import CommandPalette, { type PaletteAction } from "./components/CommandPalette";
import SnippetPanel from "./components/SnippetPanel";
import CommandHistory from "./components/CommandHistory";
import Sidebar from "./components/Sidebar";

export default function App() {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const themeId = useAppStore((s) => s.themeId);
  const [showPalette, setShowPalette] = useState(false);
  const launchConfigs = useAppStore((s) => s.launchConfigs);
  const loadLaunchConfig = useAppStore((s) => s.loadLaunchConfig);
  const snippets = useAppStore((s) => s.snippets);
  const [showHistory, setShowHistory] = useState(false);
  const [showSnippets, setShowSnippets] = useState(false);
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
  const theme = getTheme(themeId);

  // Build extra palette actions from launch configs, snippets, and history
  const paletteExtraActions = useMemo<PaletteAction[]>(() => {
    const actions: PaletteAction[] = [];

    // Launch configs
    for (const config of launchConfigs) {
      actions.push({
        id: `launch-${config.id}`,
        label: `Launch: ${config.name}`,
        category: "launch",
        keywords: `launch workspace config ${config.name}`,
        execute: () => loadLaunchConfig(config.id),
      });
    }

    // Snippets (added in Phase 5)
    if (snippets) {
      for (const snippet of snippets) {
        actions.push({
          id: `snippet-${snippet.id}`,
          label: `Run: ${snippet.name}`,
          category: "snippet",
          keywords: `snippet workflow run ${snippet.name} ${snippet.description ?? ""}`,
          execute: () => {
            setShowSnippets(true);
          },
        });
      }
    }

    // History action
    actions.push({
      id: "action-history",
      label: "Open Command History",
      category: "history",
      keywords: "history commands search recent",
      execute: () => setShowHistory(true),
    });

    // Code Review action
    actions.push({
      id: "action-code-review",
      label: "Open Code Review",
      category: "action",
      keywords: "git diff code review changes uncommitted",
      execute: () => window.dispatchEvent(new Event("ezydev:open-codereview")),
    });

    // File Viewer action (placeholder — files opened from sidebar go to viewer automatically)
    actions.push({
      id: "action-file-viewer",
      label: "Open File Viewer",
      category: "action",
      keywords: "file viewer tabbed browse code",
      execute: () => {
        // Open a file dialog to pick a file, then open in viewer
        // For now, just a no-op — files are opened via sidebar
      },
    });

    return actions;
  }, [launchConfigs, loadLaunchConfig, snippets]);

  // Inject theme CSS variables into :root
  useEffect(() => {
    const root = document.documentElement;
    const s = theme.surface;
    root.style.setProperty("--ezy-bg", s.bg);
    root.style.setProperty("--ezy-surface", s.surface);
    root.style.setProperty("--ezy-surface-raised", s.surfaceRaised);
    root.style.setProperty("--ezy-border", s.border);
    root.style.setProperty("--ezy-border-subtle", s.borderSubtle);
    root.style.setProperty("--ezy-border-light", s.borderLight);
    root.style.setProperty("--ezy-text", s.text);
    root.style.setProperty("--ezy-text-secondary", s.textSecondary);
    root.style.setProperty("--ezy-text-muted", s.textMuted);
    root.style.setProperty("--ezy-accent", s.accent);
    root.style.setProperty("--ezy-accent-hover", s.accentHover);
    root.style.setProperty("--ezy-accent-dim", s.accentDim);
    root.style.setProperty("--ezy-accent-glow", s.accentGlow);
    root.style.setProperty("--ezy-red", s.red);
    root.style.setProperty("--ezy-cyan", s.cyan);
  }, [theme]);

  // Listen for snippet panel open events from TerminalHeader
  useEffect(() => {
    const handler = () => setShowSnippets(true);
    window.addEventListener("ezydev:open-snippets", handler);
    return () => window.removeEventListener("ezydev:open-snippets", handler);
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const { ctrlKey, shiftKey, key } = e;

      // Ctrl+K → Command Palette
      if (ctrlKey && !shiftKey && key === "k") {
        e.preventDefault();
        setShowPalette((v) => !v);
        return;
      }

      // Ctrl+B → Toggle Sidebar
      if (ctrlKey && !shiftKey && key === "b") {
        e.preventDefault();
        toggleSidebar();
        return;
      }

      // Ctrl+Tab → next tab
      if (ctrlKey && !shiftKey && key === "Tab") {
        e.preventDefault();
        const store = useAppStore.getState();
        const currentIndex = store.tabs.findIndex(
          (t) => t.id === store.activeTabId
        );
        const nextIndex = (currentIndex + 1) % store.tabs.length;
        store.setActiveTab(store.tabs[nextIndex].id);
        return;
      }

      if (!ctrlKey || !shiftKey) return;

      const store = useAppStore.getState();

      switch (key) {
        case "T": {
          // Ctrl+Shift+T → dispatch new-tab event for TabBar
          e.preventDefault();
          window.dispatchEvent(new Event("ezydev:new-tab"));
          break;
        }
        case "G": {
          // Ctrl+Shift+G → Open Code Review
          e.preventDefault();
          window.dispatchEvent(new Event("ezydev:open-codereview"));
          break;
        }
        case "Tab": {
          // Ctrl+Shift+Tab → previous tab
          e.preventDefault();
          const currentIndex = store.tabs.findIndex(
            (t) => t.id === store.activeTabId
          );
          const prevIndex =
            (currentIndex - 1 + store.tabs.length) % store.tabs.length;
          store.setActiveTab(store.tabs[prevIndex].id);
          break;
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleOpenFile = useCallback((filePath: string, lineNumber?: number) => {
    window.dispatchEvent(
      new CustomEvent("ezydev:open-file", { detail: { filePath, lineNumber } })
    );
  }, []);

  return (
    <div className="flex flex-col h-full w-full" style={{ backgroundColor: "var(--ezy-bg)" }}>
      <TabBar />
      <div className="flex-1 min-h-0 flex">
        {sidebarOpen && (
          <Sidebar
            rootDir={activeTab?.workingDir || ""}
            onOpenFile={handleOpenFile}
          />
        )}
        <div className="flex-1 min-w-0 relative">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                className="h-full w-full"
                style={{
                  display: isActive ? "block" : "none",
                  position: isActive ? "relative" : "absolute",
                }}
              >
                {tab.isKanbanTab ? (
                  <KanbanBoard />
                ) : tab.isDevServerTab ? (
                  <DevServerTab />
                ) : tab.isServersTab ? (
                  <ServersPanel />
                ) : (
                  <Workspace tab={tab} />
                )}
              </div>
            );
          })}
        </div>
      </div>
      <CommandPalette
        open={showPalette}
        onClose={() => setShowPalette(false)}
        extraActions={paletteExtraActions}
      />
      {showSnippets && <SnippetPanel onClose={() => setShowSnippets(false)} />}
      {showHistory && <CommandHistory onClose={() => setShowHistory(false)} />}
    </div>
  );
}
