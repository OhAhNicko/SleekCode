import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RemoteServer } from "../types";

interface RemoteFileBrowserProps {
  server: RemoteServer;
  onSelect: (remotePath: string) => void;
  onClose: () => void;
}

export default function RemoteFileBrowser({
  server,
  onSelect,
  onClose,
}: RemoteFileBrowserProps) {
  const [currentPath, setCurrentPath] = useState("/");
  const [entries, setEntries] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const host = server.host;
  const identityFile = server.authMethod === "ssh-key" && server.sshKeyPath ? server.sshKeyPath : null;

  const loadDirectory = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<string[]>("ssh_ls", {
        host,
        username: server.username,
        path,
        identityFile,
      });
      setEntries(result);
      setCurrentPath(path);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [host, server.username, identityFile]);

  useEffect(() => {
    loadDirectory("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleNavigate = useCallback((entry: string) => {
    if (!entry.endsWith("/")) return;
    const dirName = entry.slice(0, -1);
    let newPath: string;
    if (dirName === "..") {
      const parts = currentPath.split("/").filter(Boolean);
      parts.pop();
      newPath = "/" + parts.join("/");
    } else {
      newPath = currentPath === "/" ? `/${dirName}` : `${currentPath}/${dirName}`;
    }
    loadDirectory(newPath);
  }, [currentPath, loadDirectory]);

  const pathParts = currentPath.split("/").filter(Boolean);
  const breadcrumbs = [
    { label: "/", path: "/" },
    ...pathParts.map((part, i) => ({
      label: part,
      path: "/" + pathParts.slice(0, i + 1).join("/"),
    })),
  ];

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 200,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 520,
          maxHeight: "70vh",
          backgroundColor: "var(--ezy-surface-raised)",
          border: "1px solid var(--ezy-border)",
          borderRadius: 10,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid var(--ezy-border)",
            backgroundColor: "var(--ezy-surface)",
          }}
        >
          <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
            <div className="flex items-center gap-2">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--ezy-cyan)" strokeWidth="1.3">
                <rect x="2" y="1" width="12" height="6" rx="1.5" />
                <rect x="2" y="9" width="12" height="6" rx="1.5" />
                <circle cx="5" cy="4" r="1" fill="var(--ezy-cyan)" stroke="none" />
                <circle cx="5" cy="12" r="1" fill="var(--ezy-cyan)" stroke="none" />
              </svg>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ezy-text)" }}>
                {server.name}
              </span>
              <span style={{ fontSize: 12, color: "var(--ezy-text-muted)" }}>
                — Select project directory
              </span>
            </div>
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="var(--ezy-text-muted)"
              strokeWidth="1.5"
              strokeLinecap="round"
              style={{ cursor: "pointer" }}
              onClick={onClose}
            >
              <line x1="4" y1="4" x2="12" y2="12" />
              <line x1="12" y1="4" x2="4" y2="12" />
            </svg>
          </div>

          {/* Breadcrumb */}
          <div className="flex items-center gap-1" style={{ fontSize: 12 }}>
            {breadcrumbs.map((crumb, i) => (
              <span key={crumb.path} className="flex items-center gap-1">
                {i > 0 && <span style={{ color: "var(--ezy-border-light)" }}>/</span>}
                <span
                  style={{
                    color: i === breadcrumbs.length - 1 ? "var(--ezy-text)" : "var(--ezy-cyan)",
                    cursor: i === breadcrumbs.length - 1 ? "default" : "pointer",
                    fontWeight: i === breadcrumbs.length - 1 ? 600 : 400,
                  }}
                  onClick={() => {
                    if (i < breadcrumbs.length - 1) loadDirectory(crumb.path);
                  }}
                >
                  {crumb.label}
                </span>
              </span>
            ))}
          </div>
        </div>

        {/* Entries */}
        <div style={{ flex: 1, overflowY: "auto", minHeight: 200 }}>
          {loading ? (
            <div
              className="flex items-center justify-center"
              style={{ padding: 32, color: "var(--ezy-text-muted)", fontSize: 13 }}
            >
              Loading...
            </div>
          ) : error ? (
            <div
              className="flex items-center justify-center"
              style={{ padding: 32, color: "var(--ezy-red)", fontSize: 13 }}
            >
              {error}
            </div>
          ) : (
            entries.map((entry) => {
              const isDir = entry.endsWith("/");
              const displayName = isDir ? entry.slice(0, -1) : entry;

              return (
                <div
                  key={entry}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 16px",
                    cursor: isDir ? "pointer" : "default",
                    fontSize: 13,
                    color: isDir ? "var(--ezy-text)" : "var(--ezy-text-muted)",
                    borderBottom: "1px solid var(--ezy-border-subtle)",
                  }}
                  onMouseEnter={(e) => {
                    if (isDir) e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = "transparent";
                  }}
                  onClick={() => isDir && handleNavigate(entry)}
                >
                  {isDir ? (
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="var(--ezy-text-muted)">
                      <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.879a1.5 1.5 0 0 1 1.06.44l.872.871A.5.5 0 0 0 8.665 3.5H13.5A1.5 1.5 0 0 1 15 5v7.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9Z" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--ezy-border-light)" strokeWidth="1">
                      <rect x="3" y="1" width="10" height="14" rx="1" />
                      <line x1="5.5" y1="4" x2="10.5" y2="4" strokeLinecap="round" />
                      <line x1="5.5" y1="6.5" x2="10.5" y2="6.5" strokeLinecap="round" />
                      <line x1="5.5" y1="9" x2="8" y2="9" strokeLinecap="round" />
                    </svg>
                  )}
                  <span>{displayName}</span>
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "10px 16px",
            borderTop: "1px solid var(--ezy-border)",
            backgroundColor: "var(--ezy-surface)",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          <button
            onClick={onClose}
            style={{
              padding: "6px 16px",
              backgroundColor: "transparent",
              border: "1px solid var(--ezy-border)",
              borderRadius: 6,
              color: "var(--ezy-text-muted)",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => onSelect(currentPath)}
            style={{
              padding: "6px 16px",
              backgroundColor: "var(--ezy-accent-dim)",
              border: "none",
              borderRadius: 6,
              color: "#ffffff",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Open Here
          </button>
        </div>
      </div>
    </div>
  );
}
