import { useEffect, useState } from "react";
import { useAppStore } from "../store";
import { useOverlayViewportPopup } from "../lib/useOverlayToast";
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

/** Payload shape for OverlayRoot's "voice-hud" renderer (JSON-safe). */
export type VoiceHudPayload = {
  state: string;
  title: string;
  transcript?: string;
  tool?: string;
  error?: string;
  clarifyQuestion?: string;
  confirmSummary?: string;
};

/**
 * Voice agent HUD (bottom-left card). Overlay-migrated: all state machine +
 * store wiring stays here (main webview); the card renders in the overlay
 * webview above the native panes (kind "voice-hud", interactive ambient).
 * Buttons bounce back: clarify-cancel / confirm-run / confirm-cancel.
 */
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

  const visible =
    enabled &&
    !dismissed &&
    !(state === "idle" && !pendingConfirm && !pendingClarify);

  useOverlayViewportPopup({
    id: "voice-hud",
    kind: "voice-hud",
    open: visible,
    payload: visible
      ? ({
          state,
          title:
            state === "error" ? "Voice agent" : (STATE_LABELS[state] ?? "Voice"),
          transcript:
            transcript && state !== "error" ? transcript : undefined,
          tool:
            lastTool && (state === "executing" || state === "speaking")
              ? lastTool
              : undefined,
          error: state === "error" && error ? error : undefined,
          clarifyQuestion: pendingClarify?.question,
          confirmSummary: pendingConfirm?.summary,
        } satisfies VoiceHudPayload)
      : null,
    onAction: (action) => {
      if (action === "clarify-cancel") {
        setPendingClarify(null);
      } else if (action === "confirm-run") {
        const w = window as unknown as { __ezyVoiceDeferred?: ToolCall[] };
        const deferred = w.__ezyVoiceDeferred ?? [];
        setPendingConfirm(null);
        w.__ezyVoiceDeferred = undefined;
        void runConfirmedCalls(deferred);
      } else if (action === "confirm-cancel") {
        setPendingConfirm(null);
        (
          window as unknown as { __ezyVoiceDeferred?: ToolCall[] }
        ).__ezyVoiceDeferred = undefined;
      }
    },
  });

  return null;
}
