import type { VoiceLanguage, VoiceWhisperFormat } from "../../store/voiceSlice";

export interface TranscribeResult {
  text: string;
  language: string | null;
  latencyMs: number;
}

export interface TranscribeOpts {
  url: string;
  format: VoiceWhisperFormat;
  language: VoiceLanguage;
  signal?: AbortSignal;
}

/**
 * Vocabulary hint passed to Whisper as `initial_prompt` so it biases toward
 * EzyDev terminology instead of phonetic neighbours ("cloud" → "Claude" etc.).
 *
 * Whisper uses this only as a soft prior — it doesn't constrain output.
 * Mixed English/Swedish on purpose, since the user toggles between languages.
 */
export const EZYDEV_VOCABULARY =
  "EzyDev, Claude, Claude Code, Codex, Gemini, " +
  "pane, browser, terminal, tab, kanban, " +
  "öppna, stäng, byt flik, terminal, fönster, ny pane, sidopanelen.";

function pickFilename(mime: string): string {
  if (mime.includes("webm")) return "audio.webm";
  if (mime.includes("ogg")) return "audio.ogg";
  if (mime.includes("mp4")) return "audio.m4a";
  if (mime.includes("wav")) return "audio.wav";
  return "audio";
}

/**
 * Transcribe an audio blob via the configured remote Whisper endpoint.
 *
 * Supports three common server shapes:
 *   - "openai":         POST multipart {file, model, language?} → {text, language}
 *                       (whisper-cpp openai-compat, mlx-whisper-server, ollama-whisper)
 *   - "asr-webservice": POST multipart {audio_file} → {text} or text/plain
 *                       (openai/whisper-asr-webservice)
 *   - "custom":         POST multipart {file} → text/plain or {text}
 */
export async function transcribe(blob: Blob, opts: TranscribeOpts): Promise<TranscribeResult> {
  if (!opts.url) throw new Error("Whisper endpoint not configured.");

  const filename = pickFilename(blob.type || "audio/webm");
  const file = new File([blob], filename, { type: blob.type || "audio/webm" });
  const form = new FormData();

  switch (opts.format) {
    case "asr-webservice":
      form.append("audio_file", file);
      if (opts.language && opts.language !== "auto") form.append("language", opts.language);
      form.append("output", "json");
      // whisper-asr-webservice supports an `initial_prompt` field too.
      form.append("initial_prompt", EZYDEV_VOCABULARY);
      break;
    case "custom":
      form.append("file", file);
      if (opts.language && opts.language !== "auto") form.append("language", opts.language);
      form.append("initial_prompt", EZYDEV_VOCABULARY);
      break;
    case "openai":
    default:
      form.append("file", file);
      form.append("model", "whisper-1");
      form.append("response_format", "json");
      if (opts.language && opts.language !== "auto") form.append("language", opts.language);
      // OpenAI's API names this field `prompt`; our custom server names it
      // `initial_prompt`. Both are harmlessly ignored when not recognised.
      form.append("prompt", EZYDEV_VOCABULARY);
      form.append("initial_prompt", EZYDEV_VOCABULARY);
      break;
  }

  const t0 = performance.now();
  const res = await fetch(opts.url, { method: "POST", body: form, signal: opts.signal });
  const latencyMs = Math.round(performance.now() - t0);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Whisper ${res.status}: ${body.slice(0, 200) || res.statusText}`);
  }

  const ct = res.headers.get("content-type") ?? "";
  let text = "";
  let language: string | null = null;

  if (ct.includes("application/json")) {
    const data = (await res.json()) as Record<string, unknown>;
    text = String(data.text ?? data.transcription ?? "").trim();
    const lang = data.language ?? data.detected_language;
    language = typeof lang === "string" ? lang : null;
  } else {
    text = (await res.text()).trim();
  }

  if (!text) throw new Error("Whisper returned an empty transcript.");
  return { text, language, latencyMs };
}

/** Quick health check; returns latency in ms or throws. */
export async function pingWhisper(url: string): Promise<number> {
  if (!url) throw new Error("URL is empty.");
  const t0 = performance.now();
  // Try GET on the URL root (most servers respond with something), fall back to OPTIONS.
  try {
    const root = new URL(url);
    root.pathname = "/";
    const res = await fetch(root.toString(), { method: "GET" });
    if (!res.ok && res.status !== 404 && res.status !== 405) {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    if (err instanceof TypeError) throw new Error(`Cannot reach ${url}: ${err.message}`);
    throw err;
  }
  return Math.round(performance.now() - t0);
}
