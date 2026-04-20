import { useCallback, useEffect, useState } from "react";
import { FaXmark } from "react-icons/fa6";
import { useAppStore } from "../store";

interface ChangelogModalProps {
  version: string;
  notes: string;
  onClose: () => void;
}

export default function ChangelogModal({ version, notes, onClose }: ChangelogModalProps) {
  const showChangelogOnUpdate = useAppStore((s) => s.showChangelogOnUpdate);
  const setShowChangelogOnUpdate = useAppStore((s) => s.setShowChangelogOnUpdate);

  // Local state mirrors the inverted toggle ("don't show again" = !showChangelogOnUpdate).
  // Persist the store change immediately on toggle, not on close, so the user can see
  // it reflected in Settings without waiting.
  const [dontShowAgain, setDontShowAgain] = useState(!showChangelogOnUpdate);

  const handleClose = useCallback(() => {
    setShowChangelogOnUpdate(!dontShowAgain);
    onClose();
  }, [dontShowAgain, setShowChangelogOnUpdate, onClose]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleClose]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "12vh",
        zIndex: 250,
      }}
      onClick={handleClose}
    >
      <div
        style={{
          maxWidth: 560,
          width: "calc(100% - 48px)",
          maxHeight: "70vh",
          display: "flex",
          flexDirection: "column",
          backgroundColor: "var(--ezy-surface-raised)",
          border: "1px solid var(--ezy-border)",
          borderRadius: 10,
          overflow: "hidden",
          boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "14px 18px",
            borderBottom: "1px solid var(--ezy-border)",
            flexShrink: 0,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 11,
                color: "var(--ezy-text-muted)",
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                marginBottom: 2,
              }}
            >
              EzyDev updated
            </div>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--ezy-text)" }}>
              What's new in v{version}
            </div>
          </div>
          <div
            role="button"
            tabIndex={0}
            title="Close"
            onClick={handleClose}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") handleClose();
            }}
            style={{
              width: 28,
              height: 28,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 4,
              cursor: "pointer",
              color: "var(--ezy-text-muted)",
              marginLeft: 12,
            }}
          >
            <FaXmark size={14} color="currentColor" />
          </div>
        </div>

        {/* Body */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            padding: "14px 18px",
            fontSize: 13,
            lineHeight: 1.55,
            color: "var(--ezy-text-secondary)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {notes}
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 18px",
            borderTop: "1px solid var(--ezy-border)",
            backgroundColor: "var(--ezy-surface)",
            flexShrink: 0,
          }}
        >
          <div
            role="checkbox"
            aria-checked={dontShowAgain}
            tabIndex={0}
            onClick={() => setDontShowAgain((v) => !v)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setDontShowAgain((v) => !v);
              }
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              cursor: "pointer",
              flex: 1,
              minWidth: 0,
              userSelect: "none",
            }}
          >
            <div
              style={{
                width: 16,
                height: 16,
                borderRadius: 4,
                border: dontShowAgain ? "none" : "1px solid var(--ezy-border-light)",
                backgroundColor: dontShowAgain ? "var(--ezy-accent)" : "transparent",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
                transition: "background-color 120ms ease",
              }}
            >
              {dontShowAgain && (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path
                    d="M1.5 5.2 4 7.5 8.5 2.5"
                    stroke="#0d1117"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </div>
            <span style={{ fontSize: 12, color: "var(--ezy-text-secondary)" }}>
              Don't show changelog on future updates
            </span>
          </div>

          <button
            onClick={handleClose}
            style={{
              border: "none",
              backgroundColor: "var(--ezy-accent)",
              color: "#0d1117",
              fontSize: 12,
              fontWeight: 600,
              padding: "6px 14px",
              borderRadius: 6,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
