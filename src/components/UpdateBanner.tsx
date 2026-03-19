import type { UpdateStatus } from "../hooks/useUpdateChecker";

interface UpdateBannerProps {
  status: UpdateStatus;
  progress: { downloaded: number; total: number | null } | null;
  error: string | null;
  version: string | null;
  notes: string | null;
  checkForUpdate: () => void;
  downloadAndInstall: () => void;
  dismiss: () => void;
}

export default function UpdateBanner({
  status,
  progress,
  error,
  version,
  downloadAndInstall,
  checkForUpdate,
  dismiss,
}: UpdateBannerProps) {
  const visible =
    status === "available" ||
    status === "downloading" ||
    status === "installing" ||
    status === "error";

  if (!visible) return null;

  const pct =
    progress && progress.total
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 36,
        padding: "0 14px",
        gap: 10,
        backgroundColor: "var(--ezy-surface)",
        borderBottom: "1px solid var(--ezy-border-subtle)",
        flexShrink: 0,
        fontSize: 13,
        color: "var(--ezy-text-secondary)",
        overflow: "hidden",
      }}
    >
      {/* ── Available ── */}
      {status === "available" && (
        <>
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            style={{ flexShrink: 0 }}
          >
            <path
              d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM8 3a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0v-4.5A.75.75 0 0 1 8 3Zm0 8a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Z"
              fill="var(--ezy-accent)"
            />
          </svg>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ color: "var(--ezy-text)", fontWeight: 500 }}>
              EzyDev v{version}
            </span>{" "}
            is available
          </span>
          <button
            onClick={downloadAndInstall}
            style={{
              height: 24,
              padding: "0 12px",
              borderRadius: 4,
              border: "none",
              background: "var(--ezy-accent-dim)",
              color: "#fff",
              fontSize: 12,
              fontWeight: 500,
              cursor: "pointer",
              flexShrink: 0,
              transition: "background-color 120ms ease",
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.backgroundColor =
                "var(--ezy-accent-hover)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.backgroundColor = "var(--ezy-accent-dim)")
            }
          >
            Update Now
          </button>
          <DismissButton onClick={dismiss} />
        </>
      )}

      {/* ── Downloading ── */}
      {status === "downloading" && (
        <>
          <span style={{ flexShrink: 0 }}>Downloading update</span>
          <div
            style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              backgroundColor: "var(--ezy-border)",
              overflow: "hidden",
              minWidth: 60,
            }}
          >
            <div
              style={{
                height: "100%",
                width: pct != null ? `${pct}%` : "30%",
                backgroundColor: "var(--ezy-accent)",
                borderRadius: 2,
                transition:
                  pct != null
                    ? "width 200ms ease"
                    : "none",
                ...(pct == null
                  ? {
                      animation: "indeterminate-bar 1.4s ease-in-out infinite",
                    }
                  : {}),
              }}
            />
          </div>
          {pct != null && (
            <span
              style={{
                fontSize: 12,
                color: "var(--ezy-text-muted)",
                flexShrink: 0,
                fontVariantNumeric: "tabular-nums",
                minWidth: 32,
                textAlign: "right",
              }}
            >
              {pct}%
            </span>
          )}
        </>
      )}

      {/* ── Installing ── */}
      {status === "installing" && (
        <>
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            style={{
              flexShrink: 0,
              animation: "spin 0.8s linear infinite",
            }}
          >
            <circle
              cx="8"
              cy="8"
              r="6"
              stroke="var(--ezy-border-light)"
              strokeWidth="2"
            />
            <path
              d="M14 8a6 6 0 0 0-6-6"
              stroke="var(--ezy-accent)"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
          <span>Installing update, restarting&hellip;</span>
        </>
      )}

      {/* ── Error ── */}
      {status === "error" && (
        <>
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            style={{ flexShrink: 0 }}
          >
            <circle cx="8" cy="8" r="7" fill="var(--ezy-red)" />
            <path
              d="M5.5 5.5l5 5M10.5 5.5l-5 5"
              stroke="#fff"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            Update failed
            {error && (
              <span style={{ color: "var(--ezy-text-muted)" }}>
                {" "}
                &mdash; {error}
              </span>
            )}
          </span>
          <button
            onClick={checkForUpdate}
            style={{
              height: 24,
              padding: "0 10px",
              borderRadius: 4,
              border: "1px solid var(--ezy-border)",
              background: "transparent",
              color: "var(--ezy-text-secondary)",
              fontSize: 12,
              fontWeight: 500,
              cursor: "pointer",
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: 4,
              transition: "border-color 120ms ease",
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.borderColor = "var(--ezy-border-light)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.borderColor = "var(--ezy-border)")
            }
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path
                d="M13.65 2.35A8 8 0 1 0 16 8h-2a6 6 0 1 1-1.76-4.24L10 6h6V0l-2.35 2.35Z"
                fill="currentColor"
              />
            </svg>
            Retry
          </button>
          <DismissButton onClick={dismiss} />
        </>
      )}

      {/* Animation keyframes injected once */}
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        @keyframes indeterminate-bar {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(400%); }
        }
      `}</style>
    </div>
  );
}

function DismissButton({ onClick }: { onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      role="button"
      title="Dismiss"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 22,
        height: 22,
        borderRadius: 4,
        cursor: "pointer",
        flexShrink: 0,
        color: "var(--ezy-text-muted)",
        transition: "background-color 120ms ease, color 120ms ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = "var(--ezy-surface-raised)";
        e.currentTarget.style.color = "var(--ezy-text)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = "transparent";
        e.currentTarget.style.color = "var(--ezy-text-muted)";
      }}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
        <path
          d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"
          fill="currentColor"
        />
      </svg>
    </div>
  );
}
