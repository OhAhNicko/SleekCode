import { useState, useEffect } from "react";
import { useAppStore } from "../store";
import { THEMES, getTheme } from "../lib/themes";
import { isWindows } from "../lib/platform";
import { FaCheck } from "react-icons/fa";
import type { TerminalBackend } from "../types";

// ─── Internal sub-components (mirrored from SettingsPane) ────────────

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const bg = checked ? "var(--ezy-accent)" : "transparent";
  return (
    <div
      onClick={() => onChange(!checked)}
      style={{
        width: 36,
        height: 20,
        borderRadius: 10,
        backgroundColor: bg,
        border: checked ? "none" : "1px solid var(--ezy-border-light)",
        position: "relative",
        transition: "background-color 150ms ease",
        flexShrink: 0,
        cursor: "pointer",
      }}
    >
      <div
        style={{
          width: 16,
          height: 16,
          borderRadius: "50%",
          backgroundColor: checked ? "#fff" : "var(--ezy-text-muted)",
          position: "absolute",
          top: 2,
          left: checked ? 18 : 2,
          transition: "left 150ms ease",
        }}
      />
    </div>
  );
}

function SegmentedControl<T extends string>({ options, value, onChange }: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div style={{ display: "flex", borderRadius: 6, border: "1px solid var(--ezy-border)", overflow: "hidden" }}>
      {options.map((opt) => {
        const isActive = value === opt.value;
        return (
          <button
            key={opt.value}
            style={{
              flex: 1,
              padding: "6px 16px",
              fontSize: 12,
              fontWeight: isActive ? 600 : 400,
              color: isActive ? "var(--ezy-text)" : "var(--ezy-text-muted)",
              backgroundColor: isActive ? "var(--ezy-accent-glow)" : "transparent",
              border: "none",
              cursor: "pointer",
              fontFamily: "inherit",
              transition: "background-color 150ms ease",
            }}
            onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.backgroundColor = "var(--ezy-surface)"; }}
            onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.backgroundColor = isActive ? "var(--ezy-accent-glow)" : "transparent"; }}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────

interface WelcomeModalProps {
  onComplete: () => void;
  onSkip: () => void;
}

export default function WelcomeModal({ onComplete, onSkip }: WelcomeModalProps) {
  // Read current store values as initial selections
  const storeThemeId = useAppStore((s) => s.themeId);
  const storeComposerEnabled = useAppStore((s) => s.promptComposerEnabled);
  const storeRestoreSession = useAppStore((s) => s.restoreLastSession);
  const storeBackend = useAppStore((s) => s.terminalBackend);

  // Store setters
  const setTheme = useAppStore((s) => s.setTheme);
  const setPromptComposerEnabled = useAppStore((s) => s.setPromptComposerEnabled);
  const setRestoreLastSession = useAppStore((s) => s.setRestoreLastSession);
  const setTerminalBackend = useAppStore((s) => s.setTerminalBackend);

  // Local draft state
  const [selectedTheme, setSelectedTheme] = useState(storeThemeId);
  const [composerEnabled, setComposerEnabled] = useState(storeComposerEnabled);
  const [restoreSession, setRestoreSession] = useState(storeRestoreSession);
  const [backend, setBackend] = useState<TerminalBackend>(storeBackend);

  const theme = getTheme(selectedTheme);
  const showBackend = isWindows();

  // Escape key handler
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onSkip();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onSkip]);

  const handleGetStarted = () => {
    setTheme(selectedTheme);
    setPromptComposerEnabled(composerEnabled);
    setRestoreLastSession(restoreSession);
    if (showBackend) setTerminalBackend(backend);
    onComplete();
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 250,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "10vh",
        backgroundColor: "rgba(0,0,0,0.7)",
      }}
      onClick={onSkip}
    >
      <div
        style={{
          backgroundColor: "var(--ezy-surface-raised)",
          border: "1px solid var(--ezy-border)",
          borderRadius: 10,
          padding: "28px 32px 24px",
          maxWidth: 520,
          width: "100%",
          maxHeight: "80vh",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 0,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ─────────────────────────────────────── */}
        <div style={{ marginBottom: 24 }}>
          <h1 style={{
            fontSize: 20,
            fontWeight: 700,
            color: "var(--ezy-text)",
            margin: 0,
            letterSpacing: "-0.02em",
          }}>
            Welcome to EzyDev
          </h1>
          <p style={{
            fontSize: 13,
            color: "var(--ezy-text-muted)",
            margin: "4px 0 0",
          }}>
            Set up your workspace
          </p>
        </div>

        {/* ── Section: Theme ─────────────────────────────── */}
        <div style={{ marginBottom: 20 }}>
          <div style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: "var(--ezy-text-muted)",
            marginBottom: 10,
          }}>
            Theme
          </div>
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, 1fr)",
            gap: 6,
          }}>
            {THEMES.map((t) => {
              const isSelected = t.id === selectedTheme;
              return (
                <button
                  key={t.id}
                  onClick={() => setSelectedTheme(t.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 10px",
                    borderRadius: 6,
                    border: isSelected ? `2px solid var(--ezy-accent)` : "1px solid var(--ezy-border)",
                    backgroundColor: isSelected ? "var(--ezy-accent-glow)" : "var(--ezy-surface)",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    textAlign: "left",
                    transition: "all 120ms ease",
                  }}
                  onMouseEnter={(e) => {
                    if (!isSelected) e.currentTarget.style.borderColor = "var(--ezy-accent)";
                  }}
                  onMouseLeave={(e) => {
                    if (!isSelected) e.currentTarget.style.borderColor = "var(--ezy-border)";
                  }}
                >
                  <div style={{ display: "flex", gap: 3, flexShrink: 0 }}>
                    <div style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: t.surface.bg }} />
                    <div style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: t.surface.accent }} />
                    <div style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: t.surface.cyan }} />
                  </div>
                  <span style={{
                    fontSize: 12,
                    fontWeight: isSelected ? 600 : 400,
                    color: isSelected ? "var(--ezy-text)" : "var(--ezy-text-secondary)",
                  }}>
                    {t.name}
                  </span>
                  {isSelected && <FaCheck size={10} color={theme.surface.accent} style={{ marginLeft: "auto" }} />}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Section: EzyComposer ───────────────────────── */}
        <div style={{
          marginBottom: 16,
          padding: "14px 16px",
          borderRadius: 8,
          border: "1px solid var(--ezy-border)",
          backgroundColor: "var(--ezy-surface)",
        }}>
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 13,
                fontWeight: 600,
                color: "var(--ezy-text)",
                marginBottom: 4,
              }}>
                EzyComposer
              </div>
              <div style={{
                fontSize: 12,
                color: "var(--ezy-text-muted)",
                lineHeight: 1.4,
              }}>
                Rich prompt editor with image attachments, slash commands, and prompt history. Press{" "}
                <span style={{
                  fontSize: 11,
                  backgroundColor: "var(--ezy-surface-raised)",
                  border: "1px solid var(--ezy-border)",
                  borderRadius: 3,
                  padding: "1px 5px",
                  fontFamily: "monospace",
                  color: "var(--ezy-text-secondary)",
                }}>
                  Ctrl+I
                </span>
                {" "}to open.
              </div>
            </div>
            <ToggleSwitch checked={composerEnabled} onChange={setComposerEnabled} />
          </div>
        </div>

        {/* ── Section: Restore Session ──────────────────── */}
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 0",
          gap: 16,
          borderTop: "1px solid var(--ezy-border-subtle)",
        }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 13, color: "var(--ezy-text-secondary)" }}>Restore last session</div>
            <div style={{ fontSize: 11, color: "var(--ezy-text-muted)", marginTop: 2, lineHeight: 1.3 }}>
              Reopen your tabs from the previous session on startup.
            </div>
          </div>
          <ToggleSwitch checked={restoreSession} onChange={setRestoreSession} />
        </div>

        {/* ── Section: Terminal Backend (Windows only) ──── */}
        {showBackend && (
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 0",
            gap: 16,
            borderTop: "1px solid var(--ezy-border-subtle)",
          }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, color: "var(--ezy-text-secondary)" }}>Terminal backend</div>
              <div style={{ fontSize: 11, color: "var(--ezy-text-muted)", marginTop: 2, lineHeight: 1.3 }}>
                Choose the shell backend for terminal sessions.
              </div>
            </div>
            <SegmentedControl
              options={[
                { value: "wsl" as const, label: "WSL" },
                { value: "windows" as const, label: "Windows" },
              ]}
              value={backend as "wsl" | "windows"}
              onChange={(v) => setBackend(v)}
            />
          </div>
        )}

        {/* ── Footer ─────────────────────────────────────── */}
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: 20,
          paddingTop: 16,
          borderTop: "1px solid var(--ezy-border-subtle)",
        }}>
          <div
            onClick={onSkip}
            style={{
              fontSize: 12,
              color: "var(--ezy-text-muted)",
              cursor: "pointer",
              padding: "6px 0",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--ezy-text-secondary)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--ezy-text-muted)"; }}
          >
            Skip for now
          </div>
          <button
            onClick={handleGetStarted}
            style={{
              padding: "8px 24px",
              borderRadius: 6,
              border: "none",
              backgroundColor: "var(--ezy-accent)",
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: "inherit",
              transition: "background-color 120ms ease",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--ezy-accent-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "var(--ezy-accent)"; }}
          >
            Get Started
          </button>
        </div>
      </div>
    </div>
  );
}
