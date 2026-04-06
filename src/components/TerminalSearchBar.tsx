import { useState, useRef, useEffect, useCallback } from "react";
import type { SearchAddon } from "@xterm/addon-search";

interface TerminalSearchBarProps {
  searchAddon: SearchAddon;
  onClose: () => void;
  isActive: boolean;
}

const SEARCH_DECORATIONS = {
  matchBackground: "#264f78",
  matchBorder: "transparent",
  matchOverviewRuler: "#8b949e",
  activeMatchBackground: "#39d353",
  activeMatchBorder: "transparent",
  activeMatchColorOverviewRuler: "#39d353",
};

export default function TerminalSearchBar({
  searchAddon,
  onClose,
  isActive,
}: TerminalSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [matchInfo, setMatchInfo] = useState<{ index: number; count: number } | null>(null);

  // Subscribe to match results from the search addon
  useEffect(() => {
    if (!("onDidChangeResults" in searchAddon)) return;
    const disposable = (searchAddon as any).onDidChangeResults(
      (e: { resultIndex: number; resultCount: number } | undefined) => {
        if (e) {
          setMatchInfo({ index: e.resultIndex, count: e.resultCount });
        } else {
          setMatchInfo(null);
        }
      }
    );
    return () => disposable.dispose();
  }, [searchAddon]);

  const searchOptions = useCallback(
    (incremental: boolean) => ({
      caseSensitive,
      regex,
      wholeWord,
      incremental,
      decorations: SEARCH_DECORATIONS,
    }),
    [caseSensitive, regex, wholeWord]
  );

  // Run incremental search on query or option change
  useEffect(() => {
    if (query) {
      searchAddon.findNext(query, searchOptions(true));
    } else {
      searchAddon.clearDecorations();
      setMatchInfo(null);
    }
  }, [query, caseSensitive, regex, wholeWord, searchAddon, searchOptions]);

  // Auto-focus input on mount (guarded by isActive)
  useEffect(() => {
    if (isActive) {
      inputRef.current?.focus();
    }
  }, [isActive]);

  const findNext = useCallback(() => {
    if (query) searchAddon.findNext(query, searchOptions(false));
  }, [query, searchAddon, searchOptions]);

  const findPrevious = useCallback(() => {
    if (query) searchAddon.findPrevious(query, searchOptions(false));
  }, [query, searchAddon, searchOptions]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) {
        findPrevious();
      } else {
        findNext();
      }
    }
  };

  // Match count display
  const matchDisplay = query
    ? matchInfo
      ? matchInfo.count > 0
        ? `${matchInfo.index + 1} of ${matchInfo.count}`
        : "No results"
      : null
    : null;
  const noResults = matchInfo !== null && matchInfo.count === 0 && query.length > 0;

  return (
    <div
      style={{
        position: "absolute",
        top: 6,
        right: 6,
        zIndex: 25,
        display: "flex",
        alignItems: "center",
        gap: 1,
        backgroundColor: "var(--ezy-surface-raised)",
        border: "1px solid var(--ezy-border)",
        borderRadius: 6,
        padding: "3px 4px",
        boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
        fontFamily: "system-ui, -apple-system, sans-serif",
        fontSize: 12,
      }}
    >
      {/* Search icon */}
      <div style={{ padding: "0 4px", display: "flex", alignItems: "center" }}>
        <svg
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill="none"
          stroke="var(--ezy-text-muted)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="7" cy="7" r="5" />
          <line x1="11" y1="11" x2="14.5" y2="14.5" />
        </svg>
      </div>

      {/* Search input */}
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find"
        spellCheck={false}
        autoComplete="off"
        style={{
          width: 140,
          height: 24,
          backgroundColor: "var(--ezy-surface)",
          border: `1px solid ${noResults ? "var(--ezy-red)" : "var(--ezy-border)"}`,
          borderRadius: 4,
          padding: "0 6px",
          color: "var(--ezy-text)",
          fontSize: 12,
          outline: "none",
          caretColor: "var(--ezy-accent)",
          transition: "border-color 120ms ease",
        }}
        onFocus={(e) => {
          if (!noResults) e.currentTarget.style.borderColor = "var(--ezy-accent-dim)";
        }}
        onBlur={(e) => {
          if (!noResults) e.currentTarget.style.borderColor = "var(--ezy-border)";
        }}
      />

      {/* Match count */}
      {matchDisplay && (
        <span
          style={{
            fontSize: 11,
            color: noResults ? "var(--ezy-red)" : "var(--ezy-text-muted)",
            padding: "0 4px",
            whiteSpace: "nowrap",
            minWidth: 48,
            textAlign: "center",
            userSelect: "none",
          }}
        >
          {matchDisplay}
        </span>
      )}

      {/* Separator */}
      <div
        style={{
          width: 1,
          height: 16,
          backgroundColor: "var(--ezy-border)",
          margin: "0 2px",
          flexShrink: 0,
        }}
      />

      {/* Prev / Next buttons */}
      <NavButton title="Previous match (Shift+Enter)" onClick={findPrevious} disabled={!query}>
        <polyline points="4,9 8,5 12,9" />
      </NavButton>
      <NavButton title="Next match (Enter)" onClick={findNext} disabled={!query}>
        <polyline points="4,7 8,11 12,7" />
      </NavButton>

      {/* Separator */}
      <div
        style={{
          width: 1,
          height: 16,
          backgroundColor: "var(--ezy-border)",
          margin: "0 2px",
          flexShrink: 0,
        }}
      />

      {/* Toggle: Case sensitive */}
      <ToggleButton
        active={caseSensitive}
        onClick={() => setCaseSensitive((v) => !v)}
        title="Match case"
        label="Aa"
      />

      {/* Toggle: Regex */}
      <ToggleButton
        active={regex}
        onClick={() => setRegex((v) => !v)}
        title="Use regular expression"
        label=".*"
      />

      {/* Toggle: Whole word */}
      <ToggleButton
        active={wholeWord}
        onClick={() => setWholeWord((v) => !v)}
        title="Match whole word"
        label="W"
        underline
      />

      {/* Separator */}
      <div
        style={{
          width: 1,
          height: 16,
          backgroundColor: "var(--ezy-border)",
          margin: "0 2px",
          flexShrink: 0,
        }}
      />

      {/* Close button */}
      <NavButton title="Close (Escape)" onClick={onClose}>
        <line x1="5" y1="5" x2="11" y2="11" />
        <line x1="11" y1="5" x2="5" y2="11" />
      </NavButton>
    </div>
  );
}

/** Small icon button for prev/next/close */
function NavButton({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      title={title}
      onClick={disabled ? undefined : onClick}
      style={{
        width: 24,
        height: 24,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 4,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.35 : 0.8,
        transition: "opacity 100ms ease, background-color 100ms ease",
      }}
      onMouseEnter={(e) => {
        if (!disabled) {
          e.currentTarget.style.opacity = "1";
          e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)";
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.opacity = disabled ? "0.35" : "0.8";
        e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="var(--ezy-text-muted)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </svg>
    </div>
  );
}

/** Toggle button for search options (Aa, .*, W) */
function ToggleButton({
  active,
  onClick,
  title,
  label,
  underline,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  label: string;
  underline?: boolean;
}) {
  return (
    <div
      title={title}
      onClick={onClick}
      style={{
        height: 24,
        minWidth: 24,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 4,
        padding: "0 4px",
        cursor: "pointer",
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.01em",
        backgroundColor: active ? "var(--ezy-accent-dim)" : "transparent",
        color: active ? "#fff" : "var(--ezy-text-muted)",
        textDecoration: underline ? "underline" : "none",
        textDecorationThickness: "1.5px",
        textUnderlineOffset: "2px",
        transition: "background-color 100ms ease, color 100ms ease",
        userSelect: "none",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      {label}
    </div>
  );
}
