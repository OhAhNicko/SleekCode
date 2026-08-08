import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import LoadingDots from "./LoadingDots";
import { useAppStore } from "../store";
import { isImagePath } from "../lib/screenshots";
import type { FileEntry } from "../types";

interface FileExplorerProps {
  rootDir: string;
  onOpenFile: (filePath: string) => void;
}

// `/mnt/c/...` → `c:/...` so links emitted by WSL panes still resolve
// against the Windows-style rootDir.
const norm = (p: string) =>
  p.replace(/\\/g, "/").replace(/^\/mnt\/([a-z])\//i, (_, d: string) => `${d}:/`).toLowerCase();

// Listing cache shared across mounts. The component's own state dies with
// every unmount (sidebar tab switch, sidebar close) while expandedDirs is
// persisted — this module-level mirror is what lets a remounted tree paint
// its expanded folders instantly instead of flashing per-row loading states.
// Session-only by design: a fresh launch re-lists everything.
let sharedCache: Record<string, FileEntry[]> = {};

export default function FileExplorer({ rootDir, onOpenFile }: FileExplorerProps) {
  const expandedDirs = useAppStore((s) => s.expandedDirs);
  const toggleExpandDir = useAppStore((s) => s.toggleExpandDir);
  const [cache, setCacheState] = useState<Record<string, FileEntry[]>>(sharedCache);
  // Every cache write goes through here so the module-level mirror stays in
  // step with the state React renders from.
  const setCache = useCallback(
    (updater: (prev: Record<string, FileEntry[]>) => Record<string, FileEntry[]>) => {
      setCacheState((prev) => {
        const next = updater(prev);
        sharedCache = next;
        return next;
      });
    },
    [],
  );
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  // File revealed via requestRevealFile — rendered as a selected row.
  const [highlightedPath, setHighlightedPath] = useState<string | null>(null);
  // Bumped when a reveal lands so the scroll effect below re-fires even for
  // an already-highlighted file.
  const [scrollNonce, setScrollNonce] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // `revalidate` re-lists a dir that is already cached and swaps the fresh
  // entries in silently — the stale listing keeps rendering meanwhile, so
  // there is never a loading placeholder for a folder the user has seen.
  const loadDir = useCallback(async (path: string, revalidate = false) => {
    if (cache[path] && !revalidate) return;
    const firstLoad = !cache[path];
    if (firstLoad) setLoading((prev) => ({ ...prev, [path]: true }));
    try {
      const entries = await invoke<FileEntry[]>("list_dir", { path });
      setCache((prev) => ({ ...prev, [path]: entries }));
    } catch {
      // Unlistable (deleted since it was expanded, permissions): collapse it
      // so the chevron matches reality and the reconcile effect below stops
      // retrying it. Live store read — this closure outlives the render.
      const s = useAppStore.getState();
      if (s.expandedDirs.includes(path)) s.toggleExpandDir(path);
    }
    if (firstLoad) setLoading((prev) => ({ ...prev, [path]: false }));
  }, [cache, setCache]);

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
        {/* Children. No loading placeholder: a cached listing paints
            instantly, and a first-time list lands within a frame or two on
            the local FS — the rotating chevron is the click feedback. */}
        {entry.is_directory && isExpanded && (
          <div>
            {cache[entry.path]?.map((child) => renderEntry(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  // On mount / project switch: load the root and silently revalidate every
  // cached expanded dir. The shared cache paints the tree instantly; fresh
  // listings swap in underneath so changes made while the tree was unmounted
  // still show up. Uncached expanded dirs are the reconcile effect's job.
  useEffect(() => {
    if (!rootDir) return;
    loadDir(rootDir, true);
    const rootPrefix = norm(rootDir) + "/";
    for (const dir of expandedDirs) {
      if (norm(dir).startsWith(rootPrefix) && cache[dir]) loadDir(dir, true);
    }
  }, [rootDir]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reconcile listings with expandedDirs. The expansion set is persisted
  // store state and outlives this component; the cache above dies with every
  // unmount (sidebar closed, tab switched away). Without this, a remounted
  // tree rendered rotated chevrons over folders with no children. Scoped to
  // this project's root — other projects' entries stay untouched — and gated
  // on the root listing so a dead rootDir never fans out child loads. A dir
  // that fails to list is collapsed by loadDir, so this can't retry-loop.
  useEffect(() => {
    if (!rootDir || !cache[rootDir]) return;
    const rootPrefix = norm(rootDir) + "/";
    for (const dir of expandedDirs) {
      if (!norm(dir).startsWith(rootPrefix)) continue;
      if (cache[dir] || loading[dir]) continue;
      loadDir(dir);
    }
  }, [expandedDirs, cache, loading, rootDir, loadDir]);

  // Reveal-in-sidebar requests (file opened from a pane, editor header's
  // "Reveal in file sidebar"). Walks the tree down from the root, expanding
  // each collapsed ancestor, then highlights the file. Fresh list_dir per
  // level rather than the render cache: the walk is async and a few levels
  // deep at most, and this way it also picks up files created after the
  // cache was filled.
  const revealRequest = useAppStore((s) => s.revealFileRequest);
  useEffect(() => {
    if (!revealRequest || !rootDir) return;
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
  // Visible dirs (root + expanded) revalidate IN PLACE — the old listing keeps
  // rendering until the fresh one swaps in, so the tree never blanks or shows
  // a loading state. Collapsed dirs under this root just drop their stale
  // listings; they re-list on next expand. Other projects' entries survive.
  useEffect(() => {
    const handler = () => {
      if (!rootDir) return;
      const rootNorm = norm(rootDir);
      const rootPrefix = rootNorm + "/";
      const expanded = useAppStore.getState().expandedDirs;
      setCache((prev) => {
        const next: Record<string, FileEntry[]> = {};
        for (const [key, entries] of Object.entries(prev)) {
          const n = norm(key);
          const underRoot = n === rootNorm || n.startsWith(rootPrefix);
          if (!underRoot || key === rootDir || expanded.includes(key)) next[key] = entries;
        }
        return next;
      });
      loadDir(rootDir, true);
      for (const dir of expanded) {
        if (norm(dir).startsWith(rootPrefix)) loadDir(dir, true);
      }
    };
    window.addEventListener("made:file-tree-refresh", handler);
    return () => window.removeEventListener("made:file-tree-refresh", handler);
  }, [rootDir, loadDir, setCache]);

  return (
    <div ref={containerRef} style={{ overflowY: "auto", height: "100%", paddingTop: 6 }}>
      {cache[rootDir] ? (
        cache[rootDir].map((entry) => renderEntry(entry, 0))
      ) : (
        <div style={{ padding: "12px", fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-text-muted)" }}>
          <LoadingDots />
        </div>
      )}
    </div>
  );
}
