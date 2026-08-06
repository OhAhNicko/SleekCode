import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { isImagePath } from "../lib/screenshots";
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
  // File revealed via requestRevealFile — rendered as a selected row.
  const [highlightedPath, setHighlightedPath] = useState<string | null>(null);
  // Bumped when a reveal lands so the scroll effect below re-fires even for
  // an already-highlighted file.
  const [scrollNonce, setScrollNonce] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

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
    // Hard depth cap: recursion here is data-driven (cache + expandedDirs),
    // so corrupt data must degrade to a truncated tree, never a
    // stack-overflow crash of the whole app.
    if (depth > 32) return null;
    const isExpanded = expandedDirs.includes(entry.path);
    const isLoading = loading[entry.path];
    const isHighlighted = entry.path === highlightedPath;

    return (
      <div key={entry.path}>
        <div
          // Declares this row as a context-menu surface. Without it a
          // right-click here fell through to the app-wide menu and offered
          // "Toggle Sidebar / Settings / Open DevTools" on a source file.
          data-ctx-surface="file"
          data-ctx-path={entry.path}
          data-ctx-name={entry.name}
          data-ctx-dir={entry.is_directory ? "1" : ""}
          data-ctx-root={rootDir}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "3px 8px",
            paddingLeft: 8 + depth * 16,
            cursor: "pointer",
            fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
            color: isHighlighted ? "var(--ezy-text)" : "var(--ezy-text-secondary)",
            backgroundColor: isHighlighted ? "var(--ezy-accent-glow)" : "transparent",
            transition: "background-color 100ms ease",
          }}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"}
          // Leave restores the SELECTED background, not transparent — the
          // reveal highlight must survive the pointer passing through.
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = isHighlighted ? "var(--ezy-accent-glow)" : "transparent"}
          onClick={() => {
            if (entry.is_directory) {
              handleToggle(entry.path);
            } else if (!isImagePath(entry.path)) {
              // Images open in the screenshot viewer on DOUBLE-click — the
              // file pane reads UTF-8 and can only error on them.
              onOpenFile(entry.path);
            }
          }}
          onDoubleClick={() => {
            if (entry.is_directory || !isImagePath(entry.path)) return;
            // The normal open channel: PaneGrid's image guard routes it to
            // the screenshot viewer, falling back to the pane if unreadable.
            onOpenFile(entry.path);
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
              <div style={{ padding: "3px 8px", paddingLeft: 8 + (depth + 1) * 16, fontSize: "calc(var(--ezy-font-scale, 1) * 11px)", color: "var(--ezy-text-muted)" }}>
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

  // Reveal-in-sidebar requests (file opened from a pane, editor header's
  // "Reveal in file sidebar"). Walks the tree down from the root, expanding
  // each collapsed ancestor, then highlights the file. Fresh list_dir per
  // level rather than the render cache: the walk is async and a few levels
  // deep at most, and this way it also picks up files created after the
  // cache was filled.
  const revealRequest = useAppStore((s) => s.revealFileRequest);
  useEffect(() => {
    if (!revealRequest || !rootDir) return;
    // `/mnt/c/...` → `c:/...` so links emitted by WSL panes still resolve
    // against the Windows-style rootDir.
    const norm = (p: string) =>
      p.replace(/\\/g, "/").replace(/^\/mnt\/([a-z])\//i, (_, d: string) => `${d}:/`).toLowerCase();
    const target = norm(revealRequest.path);
    // Outside this project's tree (or the root itself) — nothing to reveal.
    if (!target.startsWith(norm(rootDir) + "/")) return;
    let cancelled = false;
    (async () => {
      let cur = rootDir;
      // Depth guard only — a real repo never nests 64 levels.
      for (let depth = 0; depth < 64; depth++) {
        let entries: FileEntry[];
        try {
          entries = await invoke<FileEntry[]>("list_dir", { path: cur });
        } catch {
          return;
        }
        if (cancelled) return;
        // Snapshot the key. The updater runs at React's NEXT flush, after
        // `cur` has already advanced to the child dir — capturing `cur`
        // itself wrote cache[childDir] = PARENT's entries, a listing that
        // contains childDir, i.e. a self-cycle that sent renderEntry into
        // infinite recursion (v0.2.8 "Maximum call stack size exceeded").
        const dir = cur;
        setCache((prev) => ({ ...prev, [dir]: entries }));
        const next = entries.find(
          (en) => target === norm(en.path) || target.startsWith(norm(en.path) + "/"),
        );
        if (!next) return;
        if (!next.is_directory) {
          setHighlightedPath(next.path);
          setScrollNonce((n) => n + 1);
          return;
        }
        // Live store read — the closure's expandedDirs goes stale across awaits.
        const s = useAppStore.getState();
        if (!s.expandedDirs.includes(next.path)) s.toggleExpandDir(next.path);
        cur = next.path;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [revealRequest, rootDir]);

  // Scroll the revealed row into view. Runs as an effect so it fires AFTER
  // the expansions above have committed and the row exists in the DOM.
  useEffect(() => {
    if (scrollNonce === 0 || !highlightedPath) return;
    containerRef.current
      ?.querySelector(`[data-ctx-path="${CSS.escape(highlightedPath)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [scrollNonce, highlightedPath]);

  // Re-read the tree after a context-menu mutation (rename / delete / create).
  // `loadDir` early-returns on a cached path, so dropping the cache is what
  // actually forces the re-read.
  useEffect(() => {
    const handler = () => {
      setCache({});
      if (rootDir) {
        invoke<FileEntry[]>("list_dir", { path: rootDir })
          .then((entries) => setCache({ [rootDir]: entries }))
          .catch(() => {});
      }
    };
    window.addEventListener("made:file-tree-refresh", handler);
    return () => window.removeEventListener("made:file-tree-refresh", handler);
  }, [rootDir]);

  return (
    <div ref={containerRef} style={{ overflowY: "auto", height: "100%" }}>
      {cache[rootDir] ? (
        cache[rootDir].map((entry) => renderEntry(entry, 0))
      ) : (
        <div style={{ padding: "12px", fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-text-muted)" }}>
          Loading...
        </div>
      )}
    </div>
  );
}
