import { useAppStore } from "../store";
import type { DevServer } from "../types";

function StatusBadge({ status }: { status: DevServer["status"] }) {
  const colors = {
    running: { bg: "var(--ezy-accent-dim)", text: "#ffffff" },
    stopped: { bg: "var(--ezy-red)", text: "#ffffff" },
    error: { bg: "var(--ezy-red)", text: "#ffffff" },
  };
  const c = colors[status];

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.03em",
        backgroundColor: c.bg,
        color: c.text,
      }}
    >
      {status === "running" && (
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            backgroundColor: "var(--ezy-accent)",
          }}
        />
      )}
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

export default function DevServerTab() {
  const devServers = useAppStore((s) => s.devServers);
  const removeDevServer = useAppStore((s) => s.removeDevServer);
  const tabs = useAppStore((s) => s.tabs);

  return (
    <div
      className="h-full w-full flex flex-col workspace-enter"
      style={{ backgroundColor: "var(--ezy-bg)" }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between select-none"
        style={{
          height: 48,
          padding: "0 20px",
          borderBottom: "1px solid var(--ezy-border)",
          backgroundColor: "var(--ezy-surface)",
        }}
      >
        <div className="flex items-center gap-3">
          <svg
            width="18"
            height="18"
            viewBox="0 0 16 16"
            fill="none"
            stroke="var(--ezy-accent)"
            strokeWidth="1.3"
          >
            <rect x="2" y="3" width="12" height="10" rx="1.5" />
            <circle cx="5" cy="8" r="1.2" fill="var(--ezy-accent)" stroke="none" />
            <line x1="8" y1="8" x2="12" y2="8" strokeLinecap="round" />
          </svg>
          <span
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--ezy-text)",
              letterSpacing: "0.02em",
            }}
          >
            Dev Servers
          </span>
          <span
            style={{
              fontSize: 12,
              color: "var(--ezy-text-muted)",
            }}
          >
            {devServers.length} active
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-auto" style={{ padding: 20 }}>
        {devServers.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center h-full"
            style={{ color: "var(--ezy-text-muted)" }}
          >
            <svg
              width="48"
              height="48"
              viewBox="0 0 16 16"
              fill="none"
              stroke="var(--ezy-border)"
              strokeWidth="0.8"
              style={{ marginBottom: 16 }}
            >
              <rect x="2" y="3" width="12" height="10" rx="1.5" />
              <circle cx="5" cy="8" r="1.2" fill="var(--ezy-border)" stroke="none" />
              <line x1="8" y1="8" x2="12" y2="8" strokeLinecap="round" />
            </svg>
            <p style={{ fontSize: 14, marginBottom: 4 }}>
              No dev servers running
            </p>
            <p style={{ fontSize: 12, color: "var(--ezy-border-light)" }}>
              Run a dev server in any project tab and mark it to see it here
            </p>
          </div>
        ) : (
          <div
            style={{
              border: "1px solid var(--ezy-border)",
              borderRadius: 8,
              overflow: "hidden",
            }}
          >
            {/* Table header */}
            <div
              className="grid select-none"
              style={{
                gridTemplateColumns: "1fr 100px 100px 120px",
                backgroundColor: "var(--ezy-surface)",
                borderBottom: "1px solid var(--ezy-border)",
                padding: "8px 16px",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "var(--ezy-text-muted)",
              }}
            >
              <span>Project</span>
              <span>Port</span>
              <span>Status</span>
              <span style={{ textAlign: "right" }}>Actions</span>
            </div>

            {/* Table rows */}
            {devServers.map((server) => {
              const tab = tabs.find((t) => t.id === server.tabId);
              return (
                <div
                  key={server.id}
                  className="grid items-center"
                  style={{
                    gridTemplateColumns: "1fr 100px 100px 120px",
                    padding: "10px 16px",
                    borderBottom: "1px solid var(--ezy-border-subtle)",
                    fontSize: 13,
                    color: "var(--ezy-text)",
                  }}
                >
                  <div className="flex items-center gap-2">
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 16 16"
                      fill="var(--ezy-text-muted)"
                    >
                      <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h11A1.5 1.5 0 0 1 15 3.5v1a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5v-1ZM2.5 7h11a.5.5 0 0 1 .5.5v5A1.5 1.5 0 0 1 12.5 14h-9A1.5 1.5 0 0 1 2 12.5v-5a.5.5 0 0 1 .5-.5Z" />
                    </svg>
                    <span>{tab?.name || server.projectName}</span>
                  </div>
                  <span
                    style={{
                      fontVariantNumeric: "tabular-nums",
                      color: "var(--ezy-cyan)",
                    }}
                  >
                    :{server.port}
                  </span>
                  <StatusBadge status={server.status} />
                  <div
                    className="flex items-center justify-end gap-1"
                  >
                    <button
                      title="Open in browser preview"
                      className="p-1.5 rounded transition-colors"
                      style={{ backgroundColor: "transparent" }}
                      onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-border)"}
                      onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="var(--ezy-text-muted)"
                        strokeWidth="1.3"
                        strokeLinecap="round"
                      >
                        <path d="M6 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3" />
                        <path d="M10 2h4v4" />
                        <path d="M14 2L7 9" />
                      </svg>
                    </button>
                    <button
                      onClick={() => removeDevServer(server.id)}
                      title="Remove"
                      className="p-1.5 rounded transition-colors group"
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="var(--ezy-text-muted)"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        className="group-hover:stroke-[var(--ezy-red)]"
                      >
                        <line x1="4" y1="4" x2="12" y2="12" />
                        <line x1="12" y1="4" x2="4" y2="12" />
                      </svg>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
