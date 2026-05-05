import { useAppStore } from "../../store";
import { transcribe } from "./whisperClient";
import { interpret, type ToolCall } from "./llmClient";
import { speak } from "./ttsClient";
import { buildContextSnapshot } from "./contextSnapshot";
import { dispatch } from "./dispatcher";

/** Last detected language from Whisper — used by manual-confirm path. */
let lastLanguage: string | null = null;

/**
 * Run one full turn: audio blob → transcript → tool calls → execute → optional TTS.
 *
 * State transitions (HUD reads these):
 *   transcribing → thinking → executing → (speaking) → idle
 *
 * Returns nothing; side-effects flow through the store.
 */
export async function runTurn(blob: Blob): Promise<void> {
  const store = useAppStore.getState();

  if (!store.voiceEnabled) {
    store.setVoiceLastError("Voice agent is disabled in settings.");
    store.setVoiceHudState("error");
    return;
  }
  if (!store.whisperUrl || !store.llmUrl || !store.llmModel) {
    store.setVoiceLastError("Voice endpoints not configured. Open Settings → Voice agent.");
    store.setVoiceHudState("error");
    return;
  }

  try {
    // ── 1. Transcribe ──────────────────────────────────────────────────
    store.setVoiceHudState("transcribing");
    store.setVoiceLastError(null);
    const transcribed = await transcribe(blob, {
      url: store.whisperUrl,
      format: store.whisperFormat,
      language: store.voiceLanguage,
    });
    store.setVoiceTranscript(transcribed.text);
    lastLanguage = transcribed.language;

    // ── 2. Interpret ───────────────────────────────────────────────────
    useAppStore.getState().setVoiceHudState("thinking");
    const snapshot = buildContextSnapshot(useAppStore.getState());
    const interpreted = await interpret(transcribed.text, snapshot, {
      url: store.llmUrl,
      model: store.llmModel,
    });

    if (interpreted.toolCalls.length === 0) {
      const preview = (interpreted.content || "").slice(0, 200);
      const reason = preview
        ? `LLM returned text instead of tool calls: "${preview}${interpreted.content.length > 200 ? "…" : ""}"`
        : "LLM returned an empty response — check that the model supports tool calling (Ollama ≥ 0.4 + a tool-capable model).";
      console.warn("[voice] no tool calls returned. Raw content:", interpreted.content);
      useAppStore.getState().setVoiceLastError(reason);
      useAppStore.getState().setVoiceHudState("error");
      return;
    }

    // ── 3. Execute ─────────────────────────────────────────────────────
    await runCalls(interpreted.toolCalls, transcribed.language);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    useAppStore.getState().setVoiceLastError(msg);
    useAppStore.getState().setVoiceHudState("error");
  }
}

/**
 * Re-enter the pipeline with a confirmed batch of deferred destructive calls.
 * Used by the HUD's "Yes" button on the destructive-confirmation toast.
 */
export async function runConfirmedCalls(calls: ToolCall[], language: string | null = null): Promise<void> {
  await runCalls(calls, language ?? lastLanguage);
}

async function runCalls(calls: ToolCall[], language: string | null): Promise<void> {
  const store = useAppStore.getState();
  store.setVoiceHudState("executing");
  store.setVoiceLastToolCall(calls.map((c) => c.name).join(" → "));

  const outcome = dispatch(calls);

  if (outcome.pending?.kind === "clarify") {
    store.setVoicePendingClarify({ question: outcome.pending.question });
    store.setVoiceHudState("speaking");
    await maybeSpeak(outcome.pending.question, language);
    store.setVoiceHudState("idle");
    return;
  }

  if (outcome.pending?.kind === "confirm") {
    store.setVoicePendingConfirm({ summary: outcome.pending.summary });
    // Keep the deferred calls handy for the HUD's confirm button.
    (window as unknown as { __ezyVoiceDeferred?: ToolCall[] }).__ezyVoiceDeferred =
      outcome.pending.deferredCalls;
    store.setVoiceHudState("speaking");
    await maybeSpeak(outcome.pending.summary, language);
    store.setVoiceHudState("idle");
    return;
  }

  if (!outcome.ok) {
    store.setVoiceLastError(outcome.message);
    store.setVoiceHudState("error");
    return;
  }

  if (outcome.spoken) {
    store.setVoiceHudState("speaking");
    await maybeSpeak(outcome.spoken, language);
  }
  store.setVoiceHudState("idle");
}

async function maybeSpeak(text: string, language: string | null): Promise<void> {
  const store = useAppStore.getState();
  if (!store.ttsUrl) return;
  await speak(text, {
    url: store.ttsUrl,
    voice: store.ttsVoice || undefined,
    language: language ?? (store.voiceLanguage !== "auto" ? store.voiceLanguage : undefined),
  });
}
