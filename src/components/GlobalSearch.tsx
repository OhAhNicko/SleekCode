import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import LoadingDots from "./LoadingDots";
import type { SearchResult, RemoteServer } from "../types";

interface GlobalSearchProps {
  rootDir: string;
  onOpenFile: (filePath: string, lineNumber?: number) => void;
  /** When set, search also runs remotely via ssh_grep on this server. */
  remoteServer?: RemoteServer;
  /** Click handler for remote results — takes the remote path. */
  onOpenRemoteFile?: (filePath: string, lineNumber?: number) => void;
}

export default function GlobalSearch({ rootDir, onOpenFile, remoteServer, onOpenRemoteFile }: GlobalSearchProps) {
  const [query, setQuery] = useState("");
  const [localResults, setLocalResults] = useState<SearchResult[]>([]);
  const [remoteResults, setRemoteResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setLocalResults([]);
      setRemoteResults([]);
      return;
    }
    setSearching(true);
    // Remote search replaces local search when a remote server is active,
    // because rootDir is the remote path and local search would either fail
    // or hit an unrelated local directory.
    if (remoteServer) {
      setLocalResults([]);
      try {
        const identityFile = remoteServer.authMethod === "ssh-key" && remoteServer.sshKeyPath ? remoteServer.sshKeyPath : null;
        const res = await invoke<SearchResult[]>("ssh_grep", {
          host: remoteServer.host,
          username: remoteServer.username,
          directory: rootDir,
          query: q,
          identityFile,
          maxResults: 100,
        });
        setRemoteResults(res);
      } catch {
        setRemoteResults([]);
      }
    } else {
      setRemoteResults([]);
      try {
        const res = await invoke<SearchResult[]>("search_in_files", {
          directory: rootDir,
          query: q,
          maxResults: 100,
        });
        setLocalResults(res);
      } catch {
        setLocalResults([]);
      }
    }
    setSearching(false);
  }, [rootDir, remoteServer]);

  const handleChange = useCallback((value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(value), 300);
  }, [doSearch]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const group = (results: SearchResult[]) =>
    results.reduce<Record<string, SearchResult[]>>((acc, r) => {
      if (!acc[r.file_path]) acc[r.file_path] = [];
      acc[r.file_path].push(r);
      return acc;
    }, {});

  const localGrouped = group(localResults);
  const remoteGrouped = group(remoteResults);
  const totalCount = localResults.length + remoteResults.length;

  const renderSection = (
    title: string,
    grouped: Record<string, SearchResult[]>,
    onClick: (filePath: string, lineNumber: number) => void,
  ) => {
    const entries = Object.entries(grouped);
    if (entries.length === 0) return null;
    return (
      <>
        <div
          style={{
            padding: "6px 8px",
            fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--ezy-text-muted)",
            backgroundColor: "var(--ezy-surface)",
            borderBottom: "1px solid var(--ezy-border-subtle)",
            borderTop: "1px solid var(--ezy-border-subtle)",
          }}
        >
          {title}
        </div>
        {entries.map(([filePath, matches]) => {
          const fileName = filePath.split(/[\\/]/).pop() || filePath;
          return (
            <div key={filePath}>
              <div
                style={{
                  padding: "4px 8px",
                  fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                  fontWeight: 600,
                  color: "var(--ezy-text)",
                  backgroundColor: "var(--ezy-surface)",
                  borderBottom: "1px solid var(--ezy-border-subtle)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                data-tooltip={filePath}
              >
                {fileName}
              </div>
              {matches.map((match, i) => (
                <div
                  key={`${filePath}-${match.line_number}-${i}`}
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 6,
                    padding: "3px 8px 3px 16px",
                    cursor: "pointer",
                    fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                    color: "var(--ezy-text-secondary)",
                    transition: "background-color 100ms ease",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)")}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                  onClick={() => onClick(filePath, match.line_number)}
                >
                  <span
                    style={{
                      color: "var(--ezy-text-muted)",
                      fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                      fontVariantNumeric: "tabular-nums",
                      flexShrink: 0,
                      minWidth: 28,
                      textAlign: "right",
                    }}
                  >
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
      </>
    );
  };

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
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => handleChange(e.target.value)}
            placeholder={remoteServer ? `Search on ${remoteServer.name}…` : "Search in files…"}
            style={{
              display: "block",
              width: "100%",
              padding: "6px 32px 6px 28px",
              backgroundColor: "var(--ezy-bg)",
              border: "1px solid var(--ezy-border)",
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
              color: "var(--ezy-text)",
              fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
              fontFamily: "inherit",
              outline: "none",
            }}
            onFocus={(e) => (e.currentTarget.style.borderColor = "var(--ezy-accent)")}
            onBlur={(e) => (e.currentTarget.style.borderColor = "var(--ezy-border)")}
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                if (debounceRef.current) clearTimeout(debounceRef.current);
                setQuery("");
                setLocalResults([]);
                setRemoteResults([]);
                inputRef.current?.focus();
              }}
              style={{
                position: "absolute",
                right: 12,
                top: "50%",
                transform: "translateY(-50%)",
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
          )}
        </div>
      </div>

      {/* Results */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {searching && (
          <div style={{ padding: "12px", fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-text-muted)" }}><LoadingDots>Searching</LoadingDots></div>
        )}
        {!searching && query && totalCount === 0 && (
          <div style={{ padding: "12px", fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-text-muted)" }}>No results found</div>
        )}
        {remoteServer
          ? renderSection(
              `Remote — ${remoteServer.name}`,
              remoteGrouped,
              (filePath, lineNumber) => (onOpenRemoteFile ?? (() => {}))(filePath, lineNumber),
            )
          : renderSection("Local", localGrouped, onOpenFile)}
      </div>
    </div>
  );
}
