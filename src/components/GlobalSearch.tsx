import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SearchResult } from "../types";

interface GlobalSearchProps {
  rootDir: string;
  onOpenFile: (filePath: string, lineNumber?: number) => void;
}

export default function GlobalSearch({ rootDir, onOpenFile }: GlobalSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      const res = await invoke<SearchResult[]>("search_in_files", {
        directory: rootDir,
        query: q,
        maxResults: 100,
      });
      setResults(res);
    } catch {
      setResults([]);
    }
    setSearching(false);
  }, [rootDir]);

  const handleChange = useCallback((value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(value), 300);
  }, [doSearch]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Group results by file
  const grouped = results.reduce<Record<string, SearchResult[]>>((acc, r) => {
    if (!acc[r.file_path]) acc[r.file_path] = [];
    acc[r.file_path].push(r);
    return acc;
  }, {});

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Search input */}
      <div style={{ padding: "8px", borderBottom: "1px solid var(--ezy-border)" }}>
        <div style={{ position: "relative" }}>
          <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="none"
            stroke="var(--ezy-text-muted)"
            strokeWidth="1.5"
            strokeLinecap="round"
            style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)" }}
          >
            <circle cx="7" cy="7" r="5" />
            <line x1="11" y1="11" x2="14" y2="14" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(e) => handleChange(e.target.value)}
            placeholder="Search in files..."
            style={{
              width: "100%",
              padding: "6px 8px 6px 28px",
              backgroundColor: "var(--ezy-bg)",
              border: "1px solid var(--ezy-border)",
              borderRadius: 6,
              color: "var(--ezy-text)",
              fontSize: 12,
              fontFamily: "inherit",
              outline: "none",
            }}
            onFocus={(e) => e.currentTarget.style.borderColor = "var(--ezy-accent)"}
            onBlur={(e) => e.currentTarget.style.borderColor = "var(--ezy-border)"}
          />
        </div>
      </div>

      {/* Results */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {searching && (
          <div style={{ padding: "12px", fontSize: 12, color: "var(--ezy-text-muted)" }}>
            Searching...
          </div>
        )}
        {!searching && query && results.length === 0 && (
          <div style={{ padding: "12px", fontSize: 12, color: "var(--ezy-text-muted)" }}>
            No results found
          </div>
        )}
        {Object.entries(grouped).map(([filePath, matches]) => {
          const fileName = filePath.split(/[\\/]/).pop() || filePath;
          return (
            <div key={filePath}>
              {/* File header */}
              <div
                style={{
                  padding: "4px 8px",
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--ezy-text)",
                  backgroundColor: "var(--ezy-surface)",
                  borderBottom: "1px solid var(--ezy-border-subtle)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={filePath}
              >
                {fileName}
              </div>
              {/* Matches */}
              {matches.map((match, i) => (
                <div
                  key={`${filePath}-${match.line_number}-${i}`}
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 6,
                    padding: "3px 8px 3px 16px",
                    cursor: "pointer",
                    fontSize: 12,
                    color: "var(--ezy-text-secondary)",
                    transition: "background-color 100ms ease",
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                  onClick={() => onOpenFile(filePath, match.line_number)}
                >
                  <span style={{ color: "var(--ezy-text-muted)", fontSize: 11, fontVariantNumeric: "tabular-nums", flexShrink: 0, minWidth: 28, textAlign: "right" }}>
                    {match.line_number}
                  </span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {match.line_content}
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
