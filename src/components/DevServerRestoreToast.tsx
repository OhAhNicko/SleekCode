import { useEffect, useState } from "react";

/**
 * Bottom-right toast that surfaces the result of the App.tsx dev-server
 * restore on app boot. Listens for the `ezydev:dev-server-restore` event
 * dispatched once by the restore useEffect. Visible for 12 seconds — long
 * enough to read but not nagging. Lets users diagnose "why didn't my SSH
 * dev server restart?" without opening DevTools.
 */

type Status = "ok" | "skipped" | "error" | "info";

interface RestoreToast {
  status: Status;
  title: string;
  detail?: string;
}

export default function DevServerRestoreToast() {
  const [toast, setToast] = useState<RestoreToast | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<RestoreToast>).detail;
      if (!detail) return;
      setToast(detail);
      const timer = setTimeout(() => setToast(null), 12_000);
      return () => clearTimeout(timer);
    };
    window.addEventListener("ezydev:dev-server-restore", handler as EventListener);
    return () => window.removeEventListener("ezydev:dev-server-restore", handler as EventListener);
  }, []);

  if (!toast) return null;

  // CLAUDE.md compliance: solid opaque backgrounds, no tinted/translucent
  // badges, no amber/yellow/blue, no animate-pulse.
  const bg =
    toast.status === "ok"
      ? "#10a37f"
      : toast.status === "error"
      ? "#dc2626"
      : toast.status === "skipped"
      ? "#525252"
      : "#404040";

  return (
    <div
      style={{
        position: "fixed",
        bottom: 16,
        right: 16,
        zIndex: 150,
        maxWidth: 420,
        padding: "10px 14px",
        borderRadius: 6,
        backgroundColor: bg,
        color: "#ffffff",
        boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: "-0.01em" }}>
          {toast.title}
        </span>
        <button
          onClick={() => setToast(null)}
          aria-label="Dismiss"
          style={{
            background: "transparent",
            border: "none",
            color: "#ffffff",
            cursor: "pointer",
            opacity: 0.8,
            padding: 0,
            display: "flex",
            alignItems: "center",
          }}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
          </svg>
        </button>
      </div>
      {toast.detail && (
        <span style={{ fontSize: 11, opacity: 0.95, lineHeight: 1.45, fontVariantNumeric: "tabular-nums", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {toast.detail}
        </span>
      )}
    </div>
  );
}
