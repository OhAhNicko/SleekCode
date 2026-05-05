import { useEffect, useRef } from "react";
import { useAppStore } from "../store";
import { startRecording, type RecorderHandle } from "../lib/voice/recorder";
import { runTurn } from "../lib/voice/runner";
import { warmLlm } from "../lib/voice/llmClient";

/**
 * Invisible controller — owns the MediaRecorder lifecycle and reacts to
 * "ezydev:voice-{start,stop,toggle}" events. Mount once globally (App.tsx).
 *
 * The visible <VoiceMicButton /> in the sidebar just dispatches these events.
 * The push-to-talk hotkey in App.tsx also dispatches them.
 */
export default function VoiceController() {
  const recorderRef = useRef<RecorderHandle | null>(null);

  // Pre-warm the LLM at app start and every 30 minutes thereafter, so the
  // first voice command doesn't pay the 20s cold-load tax. Best-effort,
  // silent on failure.
  useEffect(() => {
    let cancelled = false;
    function warmIfEnabled(reason: string) {
      if (cancelled) return;
      const s = useAppStore.getState();
      if (!s.voiceEnabled || !s.llmUrl || !s.llmModel) return;
      console.debug(`[voice] warming LLM (${reason}): ${s.llmModel}`);
      warmLlm(s.llmUrl, s.llmModel);
    }
    // Fire immediately at app start.
    warmIfEnabled("app-start");
    // Re-warm every 30 minutes to stay ahead of Ollama's keep_alive expiry.
    const interval = setInterval(() => warmIfEnabled("periodic"), 30 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    async function start() {
      const s = useAppStore.getState();
      if (!s.voiceEnabled) return;
      if (recorderRef.current) return; // already recording
      try {
        s.setVoiceLastError(null);
        s.setVoiceHudState("listening");
        recorderRef.current = await startRecording();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        s.setVoiceLastError(msg);
        s.setVoiceHudState("error");
        recorderRef.current = null;
      }
    }
    async function stop() {
      const handle = recorderRef.current;
      recorderRef.current = null;
      if (!handle) return;
      try {
        const blob = await handle.stop();
        if (blob.size === 0) {
          useAppStore.getState().setVoiceHudState("idle");
          return;
        }
        await runTurn(blob);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const s = useAppStore.getState();
        s.setVoiceLastError(msg);
        s.setVoiceHudState("error");
      }
    }
    async function toggle() {
      const cur = useAppStore.getState().voiceHudState;
      if (cur === "listening") await stop();
      else if (cur === "idle" || cur === "error") await start();
    }

    window.addEventListener("ezydev:voice-start", start);
    window.addEventListener("ezydev:voice-stop", stop);
    window.addEventListener("ezydev:voice-toggle", toggle);
    return () => {
      window.removeEventListener("ezydev:voice-start", start);
      window.removeEventListener("ezydev:voice-stop", stop);
      window.removeEventListener("ezydev:voice-toggle", toggle);
    };
  }, []);

  return null;
}
