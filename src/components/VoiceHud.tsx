import { useEffect, useState } from "react";
import { useAppStore } from "../store";
import { runConfirmedCalls } from "../lib/voice/runner";
import type { ToolCall } from "../lib/voice/llmClient";

const STATE_LABELS: Record<string, string> = {
  listening: "Listening…",
  transcribing: "Transcribing…",
  thinking: "Thinking…",
  executing: "Working…",
  speaking: "Speaking…",
  error: "Error",
};

function StateDot({ active }: { active: boolean }) {
  return (
    <div
      style={{
        width: 8,
        height: 8,
        borderRadius: 8,
        backgroundColor: active ? "var(--ezy-accent)" : "var(--ezy-text-muted)",
        opacity: active ? 1 : 0.4,
        flexShrink: 0,
        transition: "opacity 200ms ease",
      }}
    />
  );
}

export default function VoiceHud() {
  const enabled = useAppStore((s) => s.voiceEnabled);
  const state = useAppStore((s) => s.voiceHudState);
  const transcript = useAppStore((s) => s.voiceTranscript);
  const error = useAppStore((s) => s.voiceLastError);
  const lastTool = useAppStore((s) => s.voiceLastToolCall);
  const pendingConfirm = useAppStore((s) => s.voicePendingConfirm);
  const pendingClarify = useAppStore((s) => s.voicePendingClarify);
  const setHudState = useAppStore((s) => s.setVoiceHudState);
  const setError = useAppStore((s) => s.setVoiceLastError);
  const setPendingConfirm = useAppStore((s) => s.setVoicePendingConfirm);
  const setPendingClarify = useAppStore((s) => s.setVoicePendingClarify);

  // Auto-dismiss errors after a few seconds (idle state then resets).
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    setDismissed(false);
    if (state === "error") {
      const t = setTimeout(() => {
        setHudState("idle");
        setError(null);
        setDismissed(true);
      }, 5000);
      return () => clearTimeout(t);
    }
  }, [state, setHudState, setError]);

  if (!enabled) return null;
  if (state === "idle" && !pendingConfirm && !pendingClarify) return null;
  if (dismissed) return null;

  // Position bottom-left so it doesn't collide with the EzyComposer (bottom-right area).
  const containerStyle: React.CSSProperties = {
    position: "fixed",
    bottom: 16,
    left: 16,
    zIndex: 9998,
    minWidth: 240,
    maxWidth: 360,
    backgroundColor: "var(--ezy-surface-raised)",
    border: `1px solid ${state === "error" ? "var(--ezy-red)" : "var(--ezy-border)"}`,
    borderRadius: 8,
    padding: "10px 12px",
    boxShadow: "0 8px 28px rgba(0,0,0,0.45)",
    color: "var(--ezy-text)",
    fontSize: 12,
    display: "flex",
    flexDirection: "column",
    gap: 6,
  };

  return (
    <div style={containerStyle} role="status" aria-live="polite">
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <StateDot active={state !== "idle" && state !== "error"} />
        <span style={{ fontWeight: 600 }}>
          {state === "error" ? "Voice agent" : (STATE_LABELS[state] ?? "Voice")}
        </span>
        {state !== "error" && (
          <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--ezy-text-muted)" }}>
            {state}
          </span>
        )}
      </div>

      {/* Transcript */}
      {transcript && state !== "error" && (
        <div style={{ color: "var(--ezy-text-secondary)", fontStyle: "italic" }}>
          "{transcript}"
        </div>
      )}

      {/* Tool call summary */}
      {lastTool && (state === "executing" || state === "speaking") && (
        <div style={{ color: "var(--ezy-text-muted)", fontSize: 11 }}>
          {lastTool}
        </div>
      )}

      {/* Error */}
      {state === "error" && error && (
        <div style={{ color: "var(--ezy-red)", fontSize: 11, lineHeight: 1.4 }}>
          {error}
        </div>
      )}

      {/* Clarify */}
      {pendingClarify && (
        <div style={{ borderTop: "1px solid var(--ezy-border-subtle)", paddingTop: 8, marginTop: 2 }}>
          <div style={{ color: "var(--ezy-text-secondary)", marginBottom: 6 }}>{pendingClarify.question}</div>
          <button
            onClick={() => setPendingClarify(null)}
            style={{
              fontSize: 11,
              color: "var(--ezy-text-muted)",
              backgroundColor: "transparent",
              border: "1px solid var(--ezy-border)",
              borderRadius: 4,
              padding: "3px 8px",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Destructive confirmation */}
      {pendingConfirm && (
        <div style={{ borderTop: "1px solid var(--ezy-border-subtle)", paddingTop: 8, marginTop: 2 }}>
          <div style={{ color: "var(--ezy-text-secondary)", marginBottom: 8 }}>
            {pendingConfirm.summary}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={async () => {
                const deferred = (window as unknown as { __ezyVoiceDeferred?: ToolCall[] }).__ezyVoiceDeferred ?? [];
                setPendingConfirm(null);
                (window as unknown as { __ezyVoiceDeferred?: ToolCall[] }).__ezyVoiceDeferred = undefined;
                await runConfirmedCalls(deferred);
              }}
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: "#fff",
                backgroundColor: "var(--ezy-red)",
                border: "none",
                borderRadius: 4,
                padding: "4px 10px",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Confirm
            </button>
            <button
              onClick={() => {
                setPendingConfirm(null);
                (window as unknown as { __ezyVoiceDeferred?: ToolCall[] }).__ezyVoiceDeferred = undefined;
              }}
              style={{
                fontSize: 11,
                color: "var(--ezy-text-muted)",
                backgroundColor: "transparent",
                border: "1px solid var(--ezy-border)",
                borderRadius: 4,
                padding: "4px 10px",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
