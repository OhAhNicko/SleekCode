import { useCallback, useEffect, useRef, useState } from "react";
import { FaXmark } from "react-icons/fa6";
import { useAppStore } from "../store";
import { useModal } from "../store/modalCoordinationSlice";
import { MODAL_BACKDROP, MODAL_MAX_HEIGHT } from "../lib/modal-layout";

interface ChangelogModalProps {
  version: string;
  notes: string;
  onClose: () => void;
}

export default function ChangelogModal({ version, notes, onClose }: ChangelogModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  useModal("changelog");
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
        ...MODAL_BACKDROP,
        backgroundColor: "rgba(0,0,0,0.6)",
        zIndex: 250,
      }}
      onClick={handleClose}
    >
      <div
        ref={overlayRef}
        style={{
          maxWidth: 560,
          width: "calc(100% - 48px)",
          maxHeight: MODAL_MAX_HEIGHT,
          display: "flex",
          flexDirection: "column",
          backgroundColor: "var(--ezy-surface-raised)",
          border: "1px solid var(--ezy-border)",
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 10px)",
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
                fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                color: "var(--ezy-text-muted)",
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                marginBottom: 2,
              }}
            >
              MADE updated
            </div>
            <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 15px)", fontWeight: 600, color: "var(--ezy-text)" }}>
              What's new in v{version}
            </div>
          </div>
          <div
            role="button"
            tabIndex={0}
           
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
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
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
            fontSize: "calc(var(--ezy-font-scale, 1) * 13px)",
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
                borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
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
            <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-text-secondary)" }}>
              Don't show changelog on future updates
            </span>
          </div>

          <button
            onClick={handleClose}
            style={{
              border: "none",
              backgroundColor: "var(--ezy-accent)",
              color: "#0d1117",
              fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
              fontWeight: 600,
              padding: "6px 14px",
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
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
