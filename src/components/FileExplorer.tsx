import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import type { FileEntry } from "../types";

interface FileExplorerProps {
  rootDir: string;
  onOpenFile: (filePath: string) => void;
}

export default function FileExplorer({ rootDir, onOpenFile }: FileExplorerProps) {
  const expandedDirs = useAppStore((s) => s.expandedDirs);
  const toggleExpandDir = useAppStore((s) => s.toggleExpandDir);
  const [cache, setCache] = useState<Record<string, FileEntry[]>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});

  const loadDir = useCallback(async (path: string) => {
    if (cache[path]) return;
    setLoading((prev) => ({ ...prev, [path]: true }));
    try {
      const entries = await invoke<FileEntry[]>("list_dir", { path });
      setCache((prev) => ({ ...prev, [path]: entries }));
    } catch {
      // Failed to load
    }
    setLoading((prev) => ({ ...prev, [path]: false }));
  }, [cache]);

  const handleToggle = useCallback((path: string) => {
    const isExpanded = expandedDirs.includes(path);
    if (!isExpanded) {
      loadDir(path);
    }
    toggleExpandDir(path);
  }, [expandedDirs, loadDir, toggleExpandDir]);

  const renderEntry = (entry: FileEntry, depth: number) => {
    const isExpanded = expandedDirs.includes(entry.path);
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
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
          onClick={() => {
            if (entry.is_directory) {
              handleToggle(entry.path);
            } else {
              onOpenFile(entry.path);
            }
          }}
        >
          {/* Chevron for directories */}
          {entry.is_directory ? (
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
          {/* Icon */}
          {entry.is_directory ? (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="var(--ezy-accent-dim)" style={{ flexShrink: 0 }}>
              <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.879a1.5 1.5 0 0 1 1.06.44l.872.871A.5.5 0 0 0 8.665 3.5H13.5A1.5 1.5 0 0 1 15 5v7.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9Z" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.2" style={{ flexShrink: 0 }}>
              <path d="M4 1h5l4 4v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1Z" />
              <polyline points="9,1 9,5 13,5" />
            </svg>
          )}
          {/* Name */}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {entry.name}
          </span>
        </div>
        {/* Children */}
        {entry.is_directory && isExpanded && (
          <div>
            {isLoading && !cache[entry.path] ? (
              <div style={{ padding: "3px 8px", paddingLeft: 8 + (depth + 1) * 16, fontSize: 11, color: "var(--ezy-text-muted)" }}>
                Loading...
              </div>
            ) : (
              cache[entry.path]?.map((child) => renderEntry(child, depth + 1))
            )}
          </div>
        )}
      </div>
    );
  };

  // Load root dir when it changes
  useEffect(() => {
    if (rootDir && !cache[rootDir]) {
      loadDir(rootDir);
    }
  }, [rootDir]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ overflowY: "auto", height: "100%" }}>
      {cache[rootDir] ? (
        cache[rootDir].map((entry) => renderEntry(entry, 0))
      ) : (
        <div style={{ padding: "12px", fontSize: 12, color: "var(--ezy-text-muted)" }}>
          Loading...
        </div>
      )}
    </div>
  );
}
