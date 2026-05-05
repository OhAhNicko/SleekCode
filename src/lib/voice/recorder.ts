/**
 * Audio capture for the voice agent. Wraps getUserMedia + MediaRecorder.
 *
 * Returns a single Blob on stop(). Errors propagate via the start() promise
 * (permission denied, no mic, etc.) so the caller can render a HUD message.
 */

export type RecorderHandle = {
  stop: () => Promise<Blob>;
  cancel: () => void;
  getMimeType: () => string;
};

const PREFERRED_MIMES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
  "",
];

function pickSupportedMime(): string {
  for (const m of PREFERRED_MIMES) {
    if (m === "") return "";
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) {
      return m;
    }
  }
  return "";
}

export async function startRecording(): Promise<RecorderHandle> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone API unavailable in this environment.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const mime = pickSupportedMime();
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  let cancelled = false;

  recorder.addEventListener("dataavailable", (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  });

  recorder.start();

  const stop = (): Promise<Blob> =>
    new Promise((resolve, reject) => {
      if (cancelled) {
        reject(new Error("Recording cancelled."));
        return;
      }
      recorder.addEventListener(
        "stop",
        () => {
          stream.getTracks().forEach((t) => t.stop());
          if (cancelled) {
            reject(new Error("Recording cancelled."));
            return;
          }
          const blob = new Blob(chunks, { type: mime || "audio/webm" });
          resolve(blob);
        },
        { once: true }
      );
      try {
        recorder.stop();
      } catch (err) {
        stream.getTracks().forEach((t) => t.stop());
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

  const cancel = () => {
    cancelled = true;
    try {
      if (recorder.state !== "inactive") recorder.stop();
    } catch { /* ignore */ }
    stream.getTracks().forEach((t) => t.stop());
  };

  return {
    stop,
    cancel,
    getMimeType: () => mime || "audio/webm",
  };
}
