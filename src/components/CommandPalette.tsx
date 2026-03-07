import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useAppStore } from "../store";
import { THEMES } from "../lib/themes";

export interface PaletteAction {
  id: string;
  label: string;
  category: "navigation" | "action" | "settings" | "launch" | "snippet" | "history";
  keywords?: string;
  execute: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  extraActions?: PaletteAction[];
}

export default function CommandPalette({
  open,
  onClose,
  extraActions = [],
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const tabs = useAppStore((s) => s.tabs);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const setTheme = useAppStore((s) => s.setTheme);

  // Build actions from store state
  const actions = useMemo<PaletteAction[]>(() => {
    const items: PaletteAction[] = [];

    // Navigation: one per tab
    for (const tab of tabs) {
      items.push({
        id: `nav-${tab.id}`,
        label: `Go to: ${tab.name}`,
        category: "navigation",
        keywords: tab.name,
        execute: () => {
          setActiveTab(tab.id);
          onClose();
        },
      });
    }

    // Actions
    items.push({
      id: "action-new-tab",
      label: "New Tab",
      category: "action",
      keywords: "new tab project open",
      execute: () => {
        // Trigger the new tab flow via keyboard shortcut simulation
        onClose();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "T", ctrlKey: true, shiftKey: true, bubbles: true }));
      },
    });

    // Settings: themes
    for (const theme of THEMES) {
      items.push({
        id: `theme-${theme.id}`,
        label: `Theme: ${theme.name}`,
        category: "settings",
        keywords: `theme ${theme.name} color appearance`,
        execute: () => {
          setTheme(theme.id);
          onClose();
        },
      });
    }

    // Extra actions (from launch configs, snippets, etc.)
    items.push(...extraActions);

    return items;
  }, [tabs, setActiveTab, setTheme, onClose, extraActions]);

  // Filter actions by query
  const filtered = useMemo(() => {
    if (!query.trim()) return actions;
    const q = query.toLowerCase();
    return actions.filter((a) => {
      const searchText = `${a.label} ${a.keywords ?? ""}`.toLowerCase();
      return searchText.includes(q);
    });
  }, [actions, query]);

  // Reset selection when query changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Focus input on open
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll("[data-palette-item]");
    items[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          if (filtered[selectedIndex]) {
            filtered[selectedIndex].execute();
          }
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [filtered, selectedIndex, onClose]
  );

  if (!open) return null;

  // Group filtered results by category
  const categoryOrder: PaletteAction["category"][] = [
    "action", "navigation", "launch", "snippet", "history", "settings",
  ];
  const categoryLabels: Record<string, string> = {
    navigation: "Navigation",
    action: "Actions",
    settings: "Settings",
    launch: "Launch Configs",
    snippet: "Snippets",
    history: "History",
  };

  const grouped = categoryOrder
    .map((cat) => ({
      category: cat,
      label: categoryLabels[cat],
      items: filtered.filter((a) => a.category === cat),
    }))
    .filter((g) => g.items.length > 0);

  // Flatten for index mapping
  let flatIndex = 0;

  function highlightMatch(text: string): React.ReactNode {
    if (!query.trim()) return text;
    const q = query.toLowerCase();
    const idx = text.toLowerCase().indexOf(q);
    if (idx === -1) return text;
    return (
      <>
        {text.slice(0, idx)}
        <mark
          style={{
            backgroundColor: "var(--ezy-accent-glow)",
            color: "var(--ezy-text)",
            borderRadius: 2,
            padding: "0 1px",
          }}
        >
          {text.slice(idx, idx + query.length)}
        </mark>
        {text.slice(idx + query.length)}
      </>
    );
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "15vh",
        backgroundColor: "rgba(0,0,0,0.5)",
      }}
      onClick={onClose}
    >
      <div
        style={{
          maxWidth: 448,
          width: "100%",
          maxHeight: "60vh",
          backgroundColor: "var(--ezy-surface-raised)",
          border: "1px solid var(--ezy-border)",
          borderRadius: 12,
          overflow: "hidden",
          boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
          display: "flex",
          flexDirection: "column",
        }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div
          style={{
            height: 32,
            padding: "0 16px",
            borderBottom: "1px solid var(--ezy-border)",
            display: "flex",
            alignItems: "center",
          }}
        >
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command..."
            style={{
              width: "100%",
              backgroundColor: "transparent",
              border: "none",
              outline: "none",
              fontSize: 15,
              color: "var(--ezy-text)",
              fontFamily: "inherit",
            }}
          />
        </div>

        {/* Results */}
        <div
          ref={listRef}
          style={{ overflowY: "auto", flex: 1, padding: "4px 0" }}
        >
          {filtered.length === 0 ? (
            <div
              style={{
                padding: "24px 16px",
                textAlign: "center",
                fontSize: 13,
                color: "var(--ezy-text-muted)",
              }}
            >
              No results
            </div>
          ) : (
            grouped.map((group) => (
              <div key={group.category}>
                <div
                  style={{
                    padding: "6px 16px 4px",
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: "var(--ezy-text-muted)",
                  }}
                >
                  {group.label}
                </div>
                {group.items.map((action) => {
                  const currentIndex = flatIndex++;
                  const isSelected = currentIndex === selectedIndex;
                  return (
                    <div
                      key={action.id}
                      data-palette-item
                      style={{
                        padding: "8px 16px",
                        fontSize: 13,
                        color: isSelected ? "var(--ezy-text)" : "var(--ezy-text-secondary)",
                        backgroundColor: isSelected ? "var(--ezy-accent-glow)" : "transparent",
                        cursor: "pointer",
                        transition: "background-color 80ms ease",
                      }}
                      onMouseEnter={() => setSelectedIndex(currentIndex)}
                      onClick={() => action.execute()}
                    >
                      {highlightMatch(action.label)}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div
          style={{
            padding: "6px 16px",
            borderTop: "1px solid var(--ezy-border)",
            fontSize: 10,
            color: "var(--ezy-text-muted)",
            display: "flex",
            gap: 12,
          }}
        >
          <span>
            <kbd style={{ padding: "1px 4px", borderRadius: 3, backgroundColor: "var(--ezy-surface)", border: "1px solid var(--ezy-border)", fontSize: 9 }}>
              ↑↓
            </kbd>{" "}
            navigate
          </span>
          <span>
            <kbd style={{ padding: "1px 4px", borderRadius: 3, backgroundColor: "var(--ezy-surface)", border: "1px solid var(--ezy-border)", fontSize: 9 }}>
              ↵
            </kbd>{" "}
            select
          </span>
          <span>
            <kbd style={{ padding: "1px 4px", borderRadius: 3, backgroundColor: "var(--ezy-surface)", border: "1px solid var(--ezy-border)", fontSize: 9 }}>
              esc
            </kbd>{" "}
            close
          </span>
        </div>
      </div>
    </div>
  );
}
