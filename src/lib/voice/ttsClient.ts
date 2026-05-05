/**
 * Optional text-to-speech via a self-hosted endpoint.
 * Tolerant: any failure (404, timeout, network) falls back to silent so
 * the visual HUD/toast remains the source of truth.
 *
 * Default: POST JSON {text, language?, voice?} → audio bytes.
 * If your server uses a different shape (form-data, GET with query, etc.),
 * adapt this client — only the renderer hot path goes through speak().
 */

export interface SpeakOpts {
  url: string;
  voice?: string;
  language?: string;
  signal?: AbortSignal;
}

export async function speak(text: string, opts: SpeakOpts): Promise<void> {
  if (!opts.url || !text.trim()) return;
  const body: Record<string, unknown> = { text };
  if (opts.voice) body.voice = opts.voice;
  if (opts.language && opts.language !== "auto") body.language = opts.language;

  let res: Response;
  try {
    res = await fetch(opts.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch {
    return;
  }
  if (!res.ok) return;

  const ct = res.headers.get("content-type") ?? "";
  if (!ct.startsWith("audio/")) return;

  const blob = await res.blob();
  const objUrl = URL.createObjectURL(blob);
  const audio = new Audio(objUrl);
  await new Promise<void>((resolve) => {
    audio.addEventListener("ended", () => { URL.revokeObjectURL(objUrl); resolve(); }, { once: true });
    audio.addEventListener("error", () => { URL.revokeObjectURL(objUrl); resolve(); }, { once: true });
    audio.play().catch(() => { URL.revokeObjectURL(objUrl); resolve(); });
  });
}

export async function pingTts(url: string): Promise<number> {
  if (!url) throw new Error("URL is empty.");
  const t0 = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "ping" }),
  });
  if (!res.ok && res.status !== 405) {
    throw new Error(`HTTP ${res.status}`);
  }
  return Math.round(performance.now() - t0);
}
