import type { StateCreator } from "zustand";

export type VoiceLanguage = "auto" | "en" | "sv";
export type VoiceWhisperFormat = "openai" | "asr-webservice" | "custom";
export type VoiceActivationMode = "toggle" | "hold";
export type VoiceHudState =
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "executing"
  | "speaking"
  | "error";

export interface VoicePendingConfirm {
  summary: string;
}

export interface VoicePendingClarify {
  question: string;
}

export interface VoiceSlice {
  // ── Config (persisted) ─────────────────────────────────────────────
  voiceEnabled: boolean;
  whisperUrl: string;
  whisperFormat: VoiceWhisperFormat;
  llmUrl: string;
  llmModel: string;
  ttsUrl: string;
  ttsVoice: string;
  voiceLanguage: VoiceLanguage;
  voiceActivationMode: VoiceActivationMode;
  pttHotkey: string;
  voiceConfirmDestructive: boolean;

  // ── Runtime (not persisted) ────────────────────────────────────────
  voiceHudState: VoiceHudState;
  voiceTranscript: string;
  voiceLastError: string | null;
  voiceLastToolCall: string | null;
  voicePendingConfirm: VoicePendingConfirm | null;
  voicePendingClarify: VoicePendingClarify | null;

  // ── Setters ─────────────────────────────────────────────────────────
  setVoiceEnabled: (v: boolean) => void;
  setWhisperUrl: (v: string) => void;
  setWhisperFormat: (v: VoiceWhisperFormat) => void;
  setLlmUrl: (v: string) => void;
  setLlmModel: (v: string) => void;
  setTtsUrl: (v: string) => void;
  setTtsVoice: (v: string) => void;
  setVoiceLanguage: (v: VoiceLanguage) => void;
  setVoiceActivationMode: (v: VoiceActivationMode) => void;
  setPttHotkey: (v: string) => void;
  setVoiceConfirmDestructive: (v: boolean) => void;

  setVoiceHudState: (s: VoiceHudState) => void;
  setVoiceTranscript: (t: string) => void;
  setVoiceLastError: (e: string | null) => void;
  setVoiceLastToolCall: (s: string | null) => void;
  setVoicePendingConfirm: (c: VoicePendingConfirm | null) => void;
  setVoicePendingClarify: (c: VoicePendingClarify | null) => void;
  resetVoiceRuntime: () => void;
}

export const DEFAULT_PTT_HOTKEY = "Ctrl+Alt+Space";

export const createVoiceSlice: StateCreator<VoiceSlice, [], [], VoiceSlice> = (
  set
) => ({
  voiceEnabled: false,
  whisperUrl: "",
  whisperFormat: "openai",
  llmUrl: "",
  llmModel: "qwen2.5:14b",
  ttsUrl: "",
  ttsVoice: "",
  voiceLanguage: "auto",
  voiceActivationMode: "toggle",
  pttHotkey: DEFAULT_PTT_HOTKEY,
  voiceConfirmDestructive: true,

  voiceHudState: "idle",
  voiceTranscript: "",
  voiceLastError: null,
  voiceLastToolCall: null,
  voicePendingConfirm: null,
  voicePendingClarify: null,

  setVoiceEnabled: (v) => set({ voiceEnabled: v }),
  setWhisperUrl: (v) => set({ whisperUrl: v }),
  setWhisperFormat: (v) => set({ whisperFormat: v }),
  setLlmUrl: (v) => set({ llmUrl: v }),
  setLlmModel: (v) => set({ llmModel: v }),
  setTtsUrl: (v) => set({ ttsUrl: v }),
  setTtsVoice: (v) => set({ ttsVoice: v }),
  setVoiceLanguage: (v) => set({ voiceLanguage: v }),
  setVoiceActivationMode: (v) => set({ voiceActivationMode: v }),
  setPttHotkey: (v) => set({ pttHotkey: v }),
  setVoiceConfirmDestructive: (v) => set({ voiceConfirmDestructive: v }),

  setVoiceHudState: (s) => set({ voiceHudState: s }),
  setVoiceTranscript: (t) => set({ voiceTranscript: t }),
  setVoiceLastError: (e) => set({ voiceLastError: e }),
  setVoiceLastToolCall: (s) => set({ voiceLastToolCall: s }),
  setVoicePendingConfirm: (c) => set({ voicePendingConfirm: c }),
  setVoicePendingClarify: (c) => set({ voicePendingClarify: c }),
  resetVoiceRuntime: () =>
    set({
      voiceHudState: "idle",
      voiceTranscript: "",
      voiceLastError: null,
      voiceLastToolCall: null,
      voicePendingConfirm: null,
      voicePendingClarify: null,
    }),
});
