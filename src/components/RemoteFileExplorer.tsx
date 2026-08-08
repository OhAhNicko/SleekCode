import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import LoadingDots from "./LoadingDots";
import { useAppStore } from "../store";
import {
  useRemoteBrowseStore,
  registerRemoteReloader,
} from "../store/remoteBrowseStore";
import { checkServerReachable } from "../lib/ssh-reachability";
import { isImagePath, openRemoteImageInViewer } from "../lib/screenshots";
import type { RemoteServer } from "../types";

interface RemoteFileExplorerProps {
  server: RemoteServer;
  rootDir: string;
  /** The tab this tree belongs to. Its load status is published under this key
   *  so the project tab can offer a retry (store/remoteBrowseStore.ts). */
  tabId: string;
  onOpenFile: (filePath: string) => void;
}

/**
 * Gaps between automatic retries after the project root fails to load, then
 * capped at the last value.
 *
 * The usual failure is "the server isn't up YET" — a laptop still waking, a VPN
 * still negotiating — so the first retries come quickly and it then settles
 * into a heartbeat instead of running ssh every few seconds all afternoon.
 */
const RETRY_BACKOFF_MS = [5_000, 10_000, 20_000, 30_000];

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

export default function RemoteFileExplorer({ server, rootDir, tabId, onOpenFile }: RemoteFileExplorerProps) {
  const expandedRemoteDirs = useAppStore((s) => s.expandedRemoteDirs);
  const toggleExpandRemoteDir = useAppStore((s) => s.toggleExpandRemoteDir);
  const [cache, setCache] = useState<Record<string, RemoteEntry[]>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const status = useRemoteBrowseStore((s) => s.byTab[tabId]);
  const setStatus = useRemoteBrowseStore((s) => s.setStatus);
  /** Guards against a load that resolves after the project changed under it. */
  const loadSeq = useRef(0);

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
      // Unlistable: collapse it so the chevron matches reality and the
      // reconcile effect below stops retrying it over ssh. Live store read —
      // this closure outlives the render.
      const s = useAppStore.getState();
      if (s.expandedRemoteDirs.includes(path)) s.toggleExpandRemoteDir(path);
    }
    setLoading((prev) => ({ ...prev, [path]: false }));
  }, [cache, server.host, server.username, identityFile]);

  /**
   * (Re)load the project root — the one directory whose failure means the tree
   * has nothing at all to show.
   *
   * Separate from `loadDir` because it must be able to run AGAIN over a path it
   * has already tried: `loadDir` early-returns on anything cached, and a retry
   * has to drop the previous attempt first. It also publishes the outcome to
   * remoteBrowseStore, which is what puts the retry button on the project tab.
   */
  const loadRoot = useCallback(async () => {
    if (!rootDir) return;
    const seq = ++loadSeq.current;
    setStatus(tabId, { state: "loading", rootDir });
    setCache((prev) => {
      if (!(rootDir in prev)) return prev;
      const next = { ...prev };
      delete next[rootDir];
      return next;
    });
    try {
      const raw = await invoke<string[]>("ssh_ls", {
        host: server.host,
        username: server.username,
        path: rootDir,
        identityFile,
      });
      if (seq !== loadSeq.current) return;
      setCache((prev) => ({ ...prev, [rootDir]: parseEntries(raw, rootDir) }));
      setError(null);
      setStatus(tabId, { state: "ok", rootDir });
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setStatus(tabId, { state: "failed", rootDir, error: String(e) });
    }
  }, [tabId, rootDir, server.host, server.username, identityFile, setStatus]);

  // Let the project tab's retry button drive this tree while it is mounted.
  useEffect(() => registerRemoteReloader(tabId, () => { void loadRoot(); }), [tabId, loadRoot]);

  const failed = status?.state === "failed" && status.rootDir === rootDir;

  /**
   * Recover on our own once the server comes back.
   *
   * The probe (`checkServerReachable`, BatchMode + ConnectTimeout=5) is cheaper
   * and quieter than a speculative `ls`, and publishing through it is what also
   * turns the Servers panel's dot green — the sidebar's own traffic answers the
   * question, so there is no second mechanism to keep in step.
   */
  useEffect(() => {
    if (!failed) return;
    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      const reachable = await checkServerReachable(server);
      if (cancelled) return;
      // `false` = it definitively did not answer, so don't waste an ls on it.
      // `true` = go. `null` = password auth, which BatchMode can never prove
      // either way — for those the `ls` IS the probe.
      if (reachable !== false) await loadRoot();
      if (cancelled) return;
      // On success `failed` flips and this effect is torn down, cancelling the
      // timer we are about to set; on failure the loop simply carries on.
      schedule();
    };

    const schedule = () => {
      const ms = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)];
      attempt += 1;
      timer = setTimeout(() => void tick(), ms);
    };

    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [failed, server, loadRoot]);

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
            fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
            color: "var(--ezy-text-secondary)",
            transition: "background-color 100ms ease",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)")}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
          onClick={() => {
            if (entry.isDirectory) {
              handleToggle(entry.path);
            } else if (!isImagePath(entry.path)) {
              // Images open in the screenshot viewer on DOUBLE-click, same as
              // the local tree — the remote editor is text-only.
              onOpenFile(entry.path);
            }
          }}
          onDoubleClick={() => {
            if (entry.isDirectory || !isImagePath(entry.path)) return;
            void openRemoteImageInViewer(
              { host: server.host, username: server.username, identityFile },
              entry.path,
            ).then((opened) => {
              // Unreadable (over the 16MB cap, ssh hiccup): fall back to the
              // remote editor so the double-click never lands on nothing.
              if (!opened) onOpenFile(entry.path);
            });
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
              <div style={{ padding: "3px 8px", paddingLeft: 8 + (depth + 1) * 16, fontSize: "calc(var(--ezy-font-scale, 1) * 11px)", color: "var(--ezy-text-muted)" }}>
                <LoadingDots />
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
    void loadRoot();
    if (!expandedRemoteDirs.includes(rootDir)) toggleExpandRemoteDir(rootDir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootDir, server.id]);

  // Same defect as the local tree: expandedRemoteDirs outlives this component
  // but the cache does not, so a remount rendered rotated chevrons over
  // folders with no children. Reload expanded dirs only once the root has
  // listed — a reachable server — never while it is failed, which would spam
  // ssh at a dead host. A dir that fails to list is collapsed by loadDir, so
  // this can't retry-loop.
  useEffect(() => {
    if (!rootDir || !cache[rootDir]) return;
    const rootPrefix = rootDir === "/" ? "/" : rootDir + "/";
    for (const dir of expandedRemoteDirs) {
      if (!dir.startsWith(rootPrefix)) continue;
      if (cache[dir] || loading[dir]) continue;
      loadDir(dir);
    }
  }, [expandedRemoteDirs, cache, loading, rootDir, loadDir]);

  if (!rootDir) {
    return (
      <div style={{ padding: "12px", fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-text-muted)" }}>
        No remote project active
      </div>
    );
  }

  return (
    <div style={{ overflowY: "auto", height: "100%" }}>
      <div
        style={{
          padding: "6px 10px",
          fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--ezy-text-muted)",
          borderBottom: "1px solid var(--ezy-border-subtle)",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
        data-tooltip={`${server.username}@${server.host}:${rootDir}`}
      >
        <span
          style={{
            padding: "1px 6px",
            borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
            backgroundColor: "var(--ezy-neutral-700, #404040)",
            color: "#ffffff",
            fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
          }}
        >
          {server.name}
        </span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "inherit", textTransform: "none", letterSpacing: 0 }}>
          {rootDir}
        </span>
      </div>
      {/* Three explicit states. The root load previously left the pane showing
          its error AND a "Loading…" that never resolved, because nothing ever
          retried and nothing ever landed in the cache. */}
      {failed ? (
        <div style={{ padding: "12px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", fontWeight: 500, color: "var(--ezy-red)" }}>
            Can’t reach {server.name}
          </div>
          {status?.error && (
            <div
              style={{
                fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                color: "var(--ezy-text-muted)",
                lineHeight: 1.5,
                wordBreak: "break-word",
              }}
            >
              {status.error}
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              onClick={() => void loadRoot()}
              style={{
                padding: "3px 10px",
                borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                backgroundColor: "var(--ezy-neutral-700, #404040)",
                color: "#ffffff",
                border: "none",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                transition: "background-color 120ms ease",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--ezy-neutral-600, #525252)")}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "var(--ezy-neutral-700, #404040)")}
            >
              Retry
            </button>
            <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 10px)", color: "var(--ezy-text-muted)" }}>
              Retrying automatically.
            </span>
          </div>
        </div>
      ) : (
        <>
          {/* Sub-directory failures only — the root's error lives above. */}
          {error && (
            <div style={{ padding: "8px 12px", fontSize: "calc(var(--ezy-font-scale, 1) * 11px)", color: "var(--ezy-red)" }}>{error}</div>
          )}
          {cache[rootDir] ? (
            cache[rootDir].map((entry) => renderEntry(entry, 0))
          ) : (
            <div style={{ padding: "12px", fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-text-muted)" }}><LoadingDots /></div>
          )}
        </>
      )}
    </div>
  );
}
