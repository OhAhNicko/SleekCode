import { useState, useMemo } from "react";
import { useAppStore } from "../store";
import { getPtyWrite, getAllPtyWriteTerminalIds } from "../store/terminalSlice";

interface CommandHistoryProps {
  onClose: () => void;
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function formatDuration(start: number, end: number | null): string | null {
  if (!end) return null;
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

export default function CommandHistory({ onClose }: CommandHistoryProps) {
  const history = useAppStore((s) => s.commandHistory);
  const clearHistory = useAppStore((s) => s.clearHistory);
  const [searchQuery, setSearchQuery] = useState("");

  const filtered = useMemo(() => {
    const reversed = [...history].reverse(); // Most recent first
    if (!searchQuery.trim()) return reversed;
    const q = searchQuery.toLowerCase();
    return reversed.filter((e) => e.command.toLowerCase().includes(q));
  }, [history, searchQuery]);

  const handleCopy = (command: string) => {
    navigator.clipboard.writeText(command);
  };

  const handleRerun = (command: string) => {
    // Find active shell terminal to write to
    const allTerminalIds = getAllPtyWriteTerminalIds();
    const terminals = useAppStore.getState().terminals;
    const shellTerminal = allTerminalIds.find((id) => terminals[id]?.type === "shell");
    const targetId = shellTerminal ?? allTerminalIds[0];
    if (!targetId) return;
    const writeFn = getPtyWrite(targetId);
    if (writeFn) {
      writeFn(command + "\n");
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9998,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: 60,
        backgroundColor: "rgba(0,0,0,0.5)",
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 560,
          maxHeight: "70vh",
          backgroundColor: "var(--ezy-surface-raised)",
          border: "1px solid var(--ezy-border)",
          borderRadius: 12,
          overflow: "hidden",
          boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
          display: "flex",
          flexDirection: "column",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 16px",
            borderBottom: "1px solid var(--ezy-border)",
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--ezy-text)" }}>
            Command History
          </span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              onClick={() => clearHistory()}
              style={{
                padding: "3px 10px",
                backgroundColor: "transparent",
                border: "1px solid var(--ezy-border)",
                borderRadius: 6,
                color: "var(--ezy-text-muted)",
                fontSize: 11,
                fontFamily: "inherit",
                cursor: "pointer",
              }}
            >
              Clear
            </button>
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
        </div>

        {/* Search */}
        <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--ezy-border)" }}>
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search commands..."
            style={{
              width: "100%",
              backgroundColor: "transparent",
              border: "none",
              outline: "none",
              fontSize: 13,
              color: "var(--ezy-text)",
              fontFamily: "inherit",
            }}
            autoFocus
          />
        </div>

        {/* History list */}
        <div style={{ overflowY: "auto", flex: 1 }}>
          {filtered.length === 0 ? (
            <div style={{ padding: "32px 16px", textAlign: "center", fontSize: 13, color: "var(--ezy-text-muted)" }}>
              {history.length === 0 ? "No command history yet." : "No matching commands."}
            </div>
          ) : (
            filtered.map((entry) => {
              const duration = formatDuration(entry.timestamp, entry.endTimestamp);
              const isError = entry.exitCode !== null && entry.exitCode !== 0;

              return (
                <div
                  key={entry.id}
                  style={{
                    padding: "8px 16px",
                    borderBottom: "1px solid var(--ezy-border-subtle)",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    cursor: "pointer",
                  }}
                  onClick={() => handleCopy(entry.command)}
                  onDoubleClick={() => handleRerun(entry.command)}
                  title="Click to copy, double-click to re-run"
                >
                  {/* Left gutter dot */}
                  <div
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      backgroundColor: isError ? "var(--ezy-red)" : "var(--ezy-accent)",
                      flexShrink: 0,
                    }}
                  />

                  {/* Command + metadata */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13,
                        color: "var(--ezy-text)",
                        fontFamily: "'Hack', 'Geist Mono', 'Cascadia Code', monospace",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {entry.command}
                    </div>
                    <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
                      <span style={{ fontSize: 10, color: "var(--ezy-text-muted)" }}>
                        {formatRelativeTime(entry.timestamp)}
                      </span>
                      {duration && (
                        <span style={{ fontSize: 10, color: "var(--ezy-text-muted)" }}>
                          {duration}
                        </span>
                      )}
                      {entry.workingDir && (
                        <span style={{ fontSize: 10, color: "var(--ezy-text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 200 }}>
                          {entry.workingDir.split(/[\\/]/).pop()}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Exit code badge */}
                  {entry.exitCode !== null && (
                    <span
                      style={{
                        fontSize: 9,
                        fontWeight: 600,
                        padding: "1px 5px",
                        borderRadius: 3,
                        backgroundColor: isError ? "var(--ezy-red)" : "var(--ezy-accent-dim)",
                        color: "#fff",
                        flexShrink: 0,
                      }}
                    >
                      {entry.exitCode}
                    </span>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "6px 16px",
            borderTop: "1px solid var(--ezy-border)",
            fontSize: 10,
            color: "var(--ezy-text-muted)",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>{filtered.length} of {history.length} entries</span>
          <span>Click to copy, double-click to re-run</span>
        </div>
      </div>
    </div>
  );
}
