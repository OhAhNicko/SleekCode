import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
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
            fontSize: 10,
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
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)")}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                  onClick={() => onClick(filePath, match.line_number)}
                >
                  <span
                    style={{
                      color: "var(--ezy-text-muted)",
                      fontSize: 11,
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
            type="text"
            value={query}
            onChange={(e) => handleChange(e.target.value)}
            placeholder={remoteServer ? `Search on ${remoteServer.name}…` : "Search in files…"}
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
            onFocus={(e) => (e.currentTarget.style.borderColor = "var(--ezy-accent)")}
            onBlur={(e) => (e.currentTarget.style.borderColor = "var(--ezy-border)")}
          />
        </div>
      </div>

      {/* Results */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {searching && (
          <div style={{ padding: "12px", fontSize: 12, color: "var(--ezy-text-muted)" }}>Searching…</div>
        )}
        {!searching && query && totalCount === 0 && (
          <div style={{ padding: "12px", fontSize: 12, color: "var(--ezy-text-muted)" }}>No results found</div>
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
