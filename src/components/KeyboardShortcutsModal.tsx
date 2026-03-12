import { useEffect } from "react";

interface KeyboardShortcutsModalProps {
  onClose: () => void;
}

interface ShortcutSection {
  title: string;
  items: { keys: string[]; label: string }[];
}

const sections: ShortcutSection[] = [
  {
    title: "General",
    items: [
      { keys: ["Ctrl", "1"], label: "New Claude pane" },
      { keys: ["Ctrl", "2"], label: "New Codex pane" },
      { keys: ["Ctrl", "3"], label: "New Gemini pane" },
      { keys: ["Ctrl", "B"], label: "Toggle sidebar" },
      { keys: ["Ctrl", "K"], label: "Command palette" },
      { keys: ["Ctrl", "Tab"], label: "Next tab" },
      { keys: ["Ctrl", "Shift", "Tab"], label: "Previous tab" },
      { keys: ["Ctrl", "Shift", "T"], label: "New tab" },
      { keys: ["Ctrl", "Shift", "G"], label: "Code review" },
      { keys: ["Ctrl", "Enter"], label: "Confirm commit" },
      { keys: ["Ctrl", "Z"], label: "Undo close tab" },
      { keys: ["Ctrl", "/"], label: "Keyboard shortcuts" },
    ],
  },
  {
    title: "Terminal",
    items: [
      { keys: ["Ctrl", "I"], label: "Open prompt composer" },
      { keys: ["Ctrl", "Home"], label: "Scroll to top" },
      { keys: ["End"], label: "Scroll to bottom" },
      { keys: ["Ctrl", "Shift", "↑"], label: "Scroll up one line" },
      { keys: ["Ctrl", "Shift", "↓"], label: "Scroll down one line" },
      { keys: ["PgUp"], label: "Jump to previous prompt" },
      { keys: ["PgDn"], label: "Jump to next prompt" },
      { keys: ["↑", "↑"], label: "Jump to previous prompt" },
      { keys: ["Ctrl", "Backspace"], label: "Delete word (backward)" },
      { keys: ["Ctrl", "Delete"], label: "Delete word (forward)" },
      { keys: ["Ctrl", "V"], label: "Paste (or attach image)" },
    ],
  },
  {
    title: "Prompt Composer",
    items: [
      { keys: ["Enter"], label: "Send message" },
      { keys: ["Shift", "Enter"], label: "New line" },
      { keys: ["Escape"], label: "Send Escape to terminal" },
      { keys: ["↑"], label: "Previous prompt (history)" },
      { keys: ["↓"], label: "Next prompt (history)" },
      { keys: ["Tab"], label: "Accept ghost / cycle image" },
      { keys: ["Shift", "Tab"], label: "Forward to terminal" },
      { keys: ["PgUp"], label: "Jump to previous prompt" },
      { keys: ["PgDn"], label: "Jump to next prompt" },
      { keys: ["Ctrl", "Backspace"], label: "Delete word (backward)" },
      { keys: ["Ctrl", "Delete"], label: "Delete word (forward)" },
      { keys: ["Ctrl", "←"], label: "Jump word left" },
      { keys: ["Ctrl", "→"], label: "Jump word right" },
    ],
  },
];

export default function KeyboardShortcutsModal({ onClose }: KeyboardShortcutsModalProps) {
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
        position: "fixed",
        inset: 0,
        zIndex: 200,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "15vh",
        backgroundColor: "rgba(0,0,0,0.7)",
      }}
      onClick={onClose}
    >
      <div
        style={{
          backgroundColor: "var(--ezy-surface-raised)",
          border: "1px solid var(--ezy-border)",
          borderRadius: 8,
          padding: "16px 20px 20px",
          maxWidth: 420,
          maxHeight: "70vh",
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
              borderRadius: 4,
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
                    borderRadius: 4,
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
                          borderRadius: 4,
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
