import { useRef, useEffect } from "react";

export interface PaneSearchBarProps {
  query: string;
  setQuery: (s: string) => void;
  caseSensitive: boolean;
  setCaseSensitive: (v: boolean) => void;
  regex: boolean;
  setRegex: (v: boolean) => void;
  wholeWord: boolean;
  setWholeWord: (v: boolean) => void;
  matchInfo: { index: number; count: number } | null;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  isActive: boolean;
  disableWholeWord?: boolean;
  placeholder?: string;
  /** Increment from the parent on every Ctrl+F press to refocus + select the input. */
  focusBump?: number;
}

export default function PaneSearchBar({
  query,
  setQuery,
  caseSensitive,
  setCaseSensitive,
  regex,
  setRegex,
  wholeWord,
  setWholeWord,
  matchInfo,
  onNext,
  onPrev,
  onClose,
  isActive,
  disableWholeWord,
  placeholder = "Find",
  focusBump,
}: PaneSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus on mount and on every focusBump change (re-pressed Ctrl+F refocuses the input).
  // Guarded by isActive to prevent background focus theft.
  useEffect(() => {
    if (isActive) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isActive, focusBump]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) onPrev();
      else onNext();
    }
  };

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
        placeholder={placeholder}
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
      <NavButton title="Previous match (Shift+Enter)" onClick={onPrev} disabled={!query}>
        <polyline points="4,9 8,5 12,9" />
      </NavButton>
      <NavButton title="Next match (Enter)" onClick={onNext} disabled={!query}>
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
        onClick={() => setCaseSensitive(!caseSensitive)}
        title="Match case"
        label="Aa"
      />

      {/* Toggle: Regex */}
      <ToggleButton
        active={regex}
        onClick={() => setRegex(!regex)}
        title="Use regular expression"
        label=".*"
      />

      {/* Toggle: Whole word */}
      {!disableWholeWord && (
        <ToggleButton
          active={wholeWord}
          onClick={() => setWholeWord(!wholeWord)}
          title="Match whole word"
          label="W"
          underline
        />
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

      {/* Close button */}
      <NavButton title="Close (Escape)" onClick={onClose}>
        <line x1="5" y1="5" x2="11" y2="11" />
        <line x1="11" y1="5" x2="5" y2="11" />
      </NavButton>
    </div>
  );
}

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
