import { useState, useMemo, useEffect, useRef } from "react";
import { useAppStore } from "../store";

interface PromptHistorySearchProps {
  onClose: () => void;
  onSelect: (text: string) => void;
}

export default function PromptHistorySearch({ onClose, onSelect }: PromptHistorySearchProps) {
  const globalHistory = useAppStore((s) => s.globalPromptHistory);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return globalHistory;
    const q = searchQuery.toLowerCase();
    return globalHistory.filter((p) => p.toLowerCase().includes(q));
  }, [globalHistory, searchQuery]);

  // Reset selection when search changes
  useEffect(() => {
    setSelectedIdx(0);
  }, [searchQuery]);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIdx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  // Keyboard nav
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" && filtered.length > 0) {
        e.preventDefault();
        onSelect(filtered[selectedIdx]);
        onClose();
        return;
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [filtered, selectedIdx, onClose, onSelect]);

  /** Highlight matching substring in a prompt */
  function highlightMatch(text: string): React.ReactNode {
    if (!searchQuery.trim()) return text;
    const q = searchQuery.toLowerCase();
    const idx = text.toLowerCase().indexOf(q);
    if (idx < 0) return text;
    return (
      <>
        {text.slice(0, idx)}
        <span style={{ backgroundColor: "var(--ezy-accent-glow)", color: "var(--ezy-accent)", borderRadius: 2, padding: "0 1px" }}>
          {text.slice(idx, idx + searchQuery.length)}
        </span>
        {text.slice(idx + searchQuery.length)}
      </>
    );
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9997,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: 60,
        backgroundColor: "rgba(0,0,0,0.5)",
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 520,
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
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 16px",
            borderBottom: "1px solid var(--ezy-border)",
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--ezy-text)" }}>
            Prompt History
          </span>
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="var(--ezy-text-muted)"
            strokeWidth="1.5"
            strokeLinecap="round"
            style={{ cursor: "pointer" }}
            onClick={onClose}
          >
            <line x1="4" y1="4" x2="12" y2="12" />
            <line x1="12" y1="4" x2="4" y2="12" />
          </svg>
        </div>

        {/* Search */}
        <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--ezy-border)" }}>
          <input
            ref={inputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search prompts..."
            style={{
              width: "100%",
              backgroundColor: "transparent",
              border: "none",
              outline: "none",
              fontSize: 13,
              color: "var(--ezy-text)",
              fontFamily: "inherit",
            }}
            autoFocus
          />
        </div>

        {/* List */}
        <div ref={listRef} style={{ overflowY: "auto", flex: 1 }}>
          {filtered.length === 0 ? (
            <div style={{ padding: "32px 16px", textAlign: "center", fontSize: 13, color: "var(--ezy-text-muted)" }}>
              {globalHistory.length === 0 ? "No prompt history yet." : "No matching prompts."}
            </div>
          ) : (
            filtered.map((prompt, i) => (
              <div
                key={`${i}-${prompt.slice(0, 20)}`}
                style={{
                  padding: "8px 16px",
                  borderBottom: "1px solid var(--ezy-border-subtle)",
                  cursor: "pointer",
                  backgroundColor: i === selectedIdx ? "var(--ezy-accent-glow)" : "transparent",
                }}
                onClick={() => {
                  onSelect(prompt);
                  onClose();
                }}
                onMouseEnter={() => setSelectedIdx(i)}
              >
                <div
                  style={{
                    fontSize: 13,
                    color: "var(--ezy-text)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {highlightMatch(prompt)}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "6px 16px",
            borderTop: "1px solid var(--ezy-border)",
            fontSize: 10,
            color: "var(--ezy-text-muted)",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>{filtered.length} of {globalHistory.length} prompts</span>
          <span>Enter to insert, Esc to close</span>
        </div>
      </div>
    </div>
  );
}
