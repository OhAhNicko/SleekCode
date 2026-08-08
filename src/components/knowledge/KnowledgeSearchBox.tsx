import { useRef } from "react";

/**
 * Full-text search over the project's memory.
 *
 * A real `<input>` in the MAIN webview, deliberately: the overlay webview is
 * `WS_EX_NOACTIVATE` and can never receive a keystroke, so a search field can
 * only live here. Debouncing happens in the store, not per-keystroke here, so
 * every caller of `setSearchQuery` gets the same rate limit.
 */
interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Move focus into the results list (ArrowDown out of the field). */
  onEnterList: () => void;
  busy: boolean;
  disabled: boolean;
}

export default function KnowledgeSearchBox({ value, onChange, onEnterList, busy, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div style={{ padding: 8, flexShrink: 0 }}>
      <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="var(--ezy-text-muted)"
          strokeWidth="1.5"
          strokeLinecap="round"
          style={{ position: "absolute", left: 7, pointerEvents: "none" }}
        >
          <circle cx="7" cy="7" r="5" />
          <line x1="11" y1="11" x2="14" y2="14" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={value}
          disabled={disabled}
          placeholder="Search knowledge"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              if (value) onChange("");
              else inputRef.current?.blur();
              return;
            }
            if (e.key === "ArrowDown" || e.key === "Enter") {
              e.preventDefault();
              onEnterList();
            }
          }}
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "5px 30px 5px 24px",
            fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
            fontFamily: "var(--ezy-font-ui)",
            color: "var(--ezy-text)",
            backgroundColor: "var(--ezy-bg)",
            border: "1px solid var(--ezy-border)",
            borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
            outline: "none",
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = "var(--ezy-accent)";
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = "var(--ezy-border)";
          }}
        />
        {/* One indicator slot, and the CLEAR affordance owns it whenever there
            is text: the store flags `busy` from the first keystroke, so a
            spinner-first slot hid the X exactly while the user was typing —
            which read as "no clear button" (user, 2026-08-08). In-flight
            feedback still shows as "Searching…" in the results list; the
            spinner here only covers the no-text edge. */}
        {value ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              onChange("");
              inputRef.current?.focus();
            }}
            style={{
              position: "absolute",
              right: 8,
              width: 16,
              height: 16,
              padding: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: "transparent",
              border: "none",
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
              color: "var(--ezy-text-muted)",
              cursor: "pointer",
              transition: "background-color 120ms ease, color 120ms ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)";
              e.currentTarget.style.color = "var(--ezy-text)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "transparent";
              e.currentTarget.style.color = "var(--ezy-text-muted)";
            }}
          >
            <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 3l10 10M13 3 3 13" />
            </svg>
          </button>
        ) : busy ? (
          <svg
            className="ezy-spin"
            width="11"
            height="11"
            viewBox="0 0 16 16"
            fill="none"
            stroke="var(--ezy-text-muted)"
            strokeWidth="1.6"
            strokeLinecap="round"
            style={{ position: "absolute", right: 11, pointerEvents: "none" }}
          >
            <path d="M8 1.5a6.5 6.5 0 1 0 6.5 6.5" />
          </svg>
        ) : null}
      </div>
    </div>
  );
}
