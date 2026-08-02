import { useEffect, useRef } from "react";
import { useModal } from "../store/modalCoordinationSlice";
import { shortcutSections } from "../lib/keybindings";
import { MODAL_BACKDROP, MODAL_MAX_HEIGHT } from "../lib/modal-layout";

interface KeyboardShortcutsModalProps {
  onClose: () => void;
}

// Derived from src/lib/keybindings.ts — the one table that context menus and
// this modal both read. It used to be a hand-maintained array here, which had
// already drifted from the executable switch in App.tsx (Ctrl+Shift+1/2/3 were
// labelled "horizontal" while they split downwards).
const sections = shortcutSections();


export default function KeyboardShortcutsModal({ onClose }: KeyboardShortcutsModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  useModal("keyboard-shortcuts");
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      style={{
        ...MODAL_BACKDROP,
        zIndex: 200,
        backgroundColor: "rgba(0,0,0,0.7)",
      }}
      onClick={onClose}
    >
      <div
        ref={overlayRef}
        style={{
          backgroundColor: "var(--ezy-surface-raised)",
          border: "1px solid var(--ezy-border)",
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 8px)",
          padding: "16px 20px 20px",
          maxWidth: 420,
          maxHeight: MODAL_MAX_HEIGHT,
          overflowY: "auto",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ezy-text)" }}>
            Keyboard Shortcuts
          </span>
          <div
            onClick={onClose}
            style={{
              cursor: "pointer",
              padding: 4,
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.5" strokeLinecap="round">
              <line x1="2" y1="2" x2="10" y2="10" />
              <line x1="10" y1="2" x2="2" y2="10" />
            </svg>
          </div>
        </div>

        {sections.map((section, si) => (
          <div key={si}>
            {/* Section divider */}
            <div style={{ height: 1, backgroundColor: "var(--ezy-border)" }} />

            {/* Section title */}
            <div style={{
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--ezy-text-muted)",
              padding: "8px 4px 4px",
            }}>
              {section.title}
            </div>

            {/* Shortcut list */}
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {section.items.map((s, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "5px 4px",
                    borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                  }}
                >
                  <span style={{ fontSize: 12, color: "var(--ezy-text-secondary)" }}>
                    {s.label}
                  </span>
                  <div style={{ display: "flex", gap: 3 }}>
                    {s.keys.map((k, j) => (
                      <span
                        key={j}
                        style={{
                          fontSize: 11,
                          fontFamily: "monospace",
                          backgroundColor: "var(--ezy-surface)",
                          color: "var(--ezy-text-muted)",
                          border: "1px solid var(--ezy-border)",
                          borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                          padding: "1px 6px",
                          lineHeight: "18px",
                        }}
                      >
                        {k}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
