import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import type { RemoteServer } from "../types";

interface RemoteFileExplorerProps {
  server: RemoteServer;
  rootDir: string;
  onOpenFile: (filePath: string) => void;
}

interface RemoteEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

function parseEntries(raw: string[], parentPath: string): RemoteEntry[] {
  const entries: RemoteEntry[] = [];
  for (const line of raw) {
    if (line === "./" || line === "../") continue;
    if (line.startsWith(".")) continue;
    const isDirectory = line.endsWith("/");
    const name = isDirectory ? line.slice(0, -1) : line;
    const path = parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
    entries.push({ name, path, isDirectory });
  }
  const dirs = entries.filter((e) => e.isDirectory).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const files = entries.filter((e) => !e.isDirectory).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return [...dirs, ...files];
}

export default function RemoteFileExplorer({ server, rootDir, onOpenFile }: RemoteFileExplorerProps) {
  const expandedRemoteDirs = useAppStore((s) => s.expandedRemoteDirs);
  const toggleExpandRemoteDir = useAppStore((s) => s.toggleExpandRemoteDir);
  const [cache, setCache] = useState<Record<string, RemoteEntry[]>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const identityFile = server.authMethod === "ssh-key" && server.sshKeyPath ? server.sshKeyPath : null;

  const loadDir = useCallback(async (path: string) => {
    if (cache[path]) return;
    setLoading((prev) => ({ ...prev, [path]: true }));
    try {
      const raw = await invoke<string[]>("ssh_ls", {
        host: server.host,
        username: server.username,
        path,
        identityFile,
      });
      setCache((prev) => ({ ...prev, [path]: parseEntries(raw, path) }));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
    setLoading((prev) => ({ ...prev, [path]: false }));
  }, [cache, server.host, server.username, identityFile]);

  const handleToggle = useCallback((path: string) => {
    const isExpanded = expandedRemoteDirs.includes(path);
    if (!isExpanded) loadDir(path);
    toggleExpandRemoteDir(path);
  }, [expandedRemoteDirs, loadDir, toggleExpandRemoteDir]);

  const renderEntry = (entry: RemoteEntry, depth: number) => {
    const isExpanded = expandedRemoteDirs.includes(entry.path);
    const isLoading = loading[entry.path];
    return (
      <div key={entry.path}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "3px 8px",
            paddingLeft: 8 + depth * 16,
            cursor: "pointer",
            fontSize: 12,
            color: "var(--ezy-text-secondary)",
            transition: "background-color 100ms ease",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)")}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
          onClick={() => {
            if (entry.isDirectory) handleToggle(entry.path);
            else onOpenFile(entry.path);
          }}
        >
          {entry.isDirectory ? (
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="var(--ezy-text-muted)"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                flexShrink: 0,
                transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
                transition: "transform 120ms ease",
              }}
            >
              <polyline points="3,1 7,5 3,9" />
            </svg>
          ) : (
            <span style={{ width: 10, flexShrink: 0 }} />
          )}
          {entry.isDirectory ? (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="var(--ezy-accent-dim)" style={{ flexShrink: 0 }}>
              <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.879a1.5 1.5 0 0 1 1.06.44l.872.871A.5.5 0 0 0 8.665 3.5H13.5A1.5 1.5 0 0 1 15 5v7.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9Z" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.2" style={{ flexShrink: 0 }}>
              <path d="M4 1h5l4 4v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1Z" />
              <polyline points="9,1 9,5 13,5" />
            </svg>
          )}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.name}</span>
        </div>
        {entry.isDirectory && isExpanded && (
          <div>
            {isLoading && !cache[entry.path] ? (
              <div style={{ padding: "3px 8px", paddingLeft: 8 + (depth + 1) * 16, fontSize: 11, color: "var(--ezy-text-muted)" }}>
                Loading…
              </div>
            ) : (
              cache[entry.path]?.map((child) => renderEntry(child, depth + 1))
            )}
          </div>
        )}
      </div>
    );
  };

  // Auto-load project root when server / root changes, and auto-expand it.
  useEffect(() => {
    if (!rootDir) return;
    loadDir(rootDir);
    if (!expandedRemoteDirs.includes(rootDir)) toggleExpandRemoteDir(rootDir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootDir, server.id]);

  if (!rootDir) {
    return (
      <div style={{ padding: "12px", fontSize: 12, color: "var(--ezy-text-muted)" }}>
        No remote project active
      </div>
    );
  }

  return (
    <div style={{ overflowY: "auto", height: "100%" }}>
      <div
        style={{
          padding: "6px 10px",
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--ezy-text-muted)",
          borderBottom: "1px solid var(--ezy-border-subtle)",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
        title={`${server.username}@${server.host}:${rootDir}`}
      >
        <span
          style={{
            padding: "1px 6px",
            borderRadius: 3,
            backgroundColor: "var(--ezy-neutral-700, #404040)",
            color: "#ffffff",
            fontSize: 9,
          }}
        >
          {server.name}
        </span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "inherit", textTransform: "none", letterSpacing: 0 }}>
          {rootDir}
        </span>
      </div>
      {error && (
        <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--ezy-red)" }}>{error}</div>
      )}
      {cache[rootDir] ? (
        cache[rootDir].map((entry) => renderEntry(entry, 0))
      ) : (
        <div style={{ padding: "12px", fontSize: 12, color: "var(--ezy-text-muted)" }}>Loading…</div>
      )}
    </div>
  );
}
