/**
 * Notification sound engine — synthesized Web Audio recipes, one per entry in
 * SOUND_PRESETS (store/recentProjectsSlice). Web Audio deliberately: no asset
 * files, not subject to the CSP media-src allowlist, and each sound is a small
 * tweakable function. The preset list is metadata-only, so swapping a recipe
 * for a decoded AudioBuffer later (bundled/ElevenLabs files) changes ONLY this
 * file.
 *
 * Autoplay: Chromium keeps an AudioContext created without user activation in
 * the "suspended" state. Activation is STICKY per document — one real click or
 * keydown in the main webview ever is enough — but native pane HWNDs are
 * WS_EX_NOACTIVATE children whose input never reaches this webview, so a
 * session where the user only touches terminals can stay locked.
 * installAudioUnlock() (App.tsx) closes that hole on the first interaction the
 * webview does see; play() also retries resume() each time. Failures are
 * console.debug'd, never silently swallowed (the ttsClient anti-pattern).
 */

import { useAppStore } from "../store";
import {
  autoAssignSound,
  type ProjectSoundId,
} from "../store/recentProjectsSlice";

export type SoundId = Exclude<ProjectSoundId, null>;

type Recipe = (ctx: AudioContext, out: GainNode, t0: number) => void;

let audioCtx: AudioContext | null = null;
let master: GainNode | null = null;

function ensureContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
    master = audioCtx.createGain();
    master.connect(audioCtx.destination);
  }
  if (audioCtx.state === "suspended") {
    void audioCtx.resume().catch((e) => console.debug("[notif-sound] resume failed", e));
  }
  return audioCtx;
}

/**
 * One-time capture-phase unlock, installed from App.tsx. Idempotent; returns a
 * cleanup that removes both listeners. Capture phase so a stopPropagation in
 * app code can't starve it; `once` is not used because either event alone
 * should not remove the other before it fired.
 */
export function installAudioUnlock(): () => void {
  const unlock = () => {
    ensureContext();
    window.removeEventListener("pointerdown", unlock, true);
    window.removeEventListener("keydown", unlock, true);
  };
  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);
  return () => {
    window.removeEventListener("pointerdown", unlock, true);
    window.removeEventListener("keydown", unlock, true);
  };
}

/** Sine/triangle/square partial with its own gain envelope. The building block
 * of most recipes: attack to `peak` in 8-12ms, exponential decay to `end`. */
function tone(
  ctx: AudioContext,
  out: GainNode,
  opts: {
    type: OscillatorType;
    freq: number;
    /** Optional exponential frequency sweep target. */
    sweepTo?: number;
    sweepEnd?: number;
    peak: number;
    start: number;
    end: number;
    attack?: number;
  },
): void {
  const o = ctx.createOscillator();
  o.type = opts.type;
  o.frequency.setValueAtTime(opts.freq, opts.start);
  if (opts.sweepTo !== undefined) {
    o.frequency.exponentialRampToValueAtTime(opts.sweepTo, opts.sweepEnd ?? opts.end);
  }
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, opts.start);
  env.gain.linearRampToValueAtTime(opts.peak, opts.start + (opts.attack ?? 0.01));
  env.gain.exponentialRampToValueAtTime(0.001, opts.end);
  o.connect(env).connect(out);
  o.start(opts.start);
  o.stop(opts.end + 0.02);
}

/**
 * One recipe per preset id — Record<SoundId, …> makes a preset without a
 * recipe a compile error. Every sound ends within ~0.5s of t0.
 */
const RECIPES: Record<SoundId, Recipe> = {
  // Two consonant sine partials, gentle decay — the classic soft chime.
  chime: (ctx, out, t0) => {
    tone(ctx, out, { type: "sine", freq: 880, peak: 0.5, start: t0, end: t0 + 0.45 });
    tone(ctx, out, { type: "sine", freq: 1320, peak: 0.25, start: t0, end: t0 + 0.4 });
  },
  // Fundamental plus an inharmonic 2.4x partial — the clang that reads "bell".
  bell: (ctx, out, t0) => {
    tone(ctx, out, { type: "sine", freq: 660, peak: 0.5, start: t0, end: t0 + 0.5 });
    tone(ctx, out, { type: "sine", freq: 1584, peak: 0.18, start: t0, end: t0 + 0.3 });
  },
  // Triangle fundamental + sine octave with a fast decay — woody strike.
  marimba: (ctx, out, t0) => {
    tone(ctx, out, { type: "triangle", freq: 523, peak: 0.6, start: t0, end: t0 + 0.22, attack: 0.005 });
    tone(ctx, out, { type: "sine", freq: 1046, peak: 0.2, start: t0, end: t0 + 0.15, attack: 0.005 });
  },
  // Descending sine sweep — watery plip.
  droplet: (ctx, out, t0) => {
    tone(ctx, out, {
      type: "sine", freq: 950, sweepTo: 380, sweepEnd: t0 + 0.16,
      peak: 0.6, start: t0, end: t0 + 0.22, attack: 0.008,
    });
  },
  // Short square blip with a downward octave snap.
  pop: (ctx, out, t0) => {
    tone(ctx, out, {
      type: "square", freq: 300, sweepTo: 150, sweepEnd: t0 + 0.07,
      peak: 0.3, start: t0, end: t0 + 0.09, attack: 0.004,
    });
  },
  // Two high sines struck together, very short — glass tap.
  glass: (ctx, out, t0) => {
    tone(ctx, out, { type: "sine", freq: 1568, peak: 0.35, start: t0, end: t0 + 0.18, attack: 0.004 });
    tone(ctx, out, { type: "sine", freq: 2093, peak: 0.22, start: t0, end: t0 + 0.14, attack: 0.004 });
  },
  // Single clear sine, medium decay — sonar ping.
  ping: (ctx, out, t0) => {
    tone(ctx, out, { type: "sine", freq: 1175, peak: 0.5, start: t0, end: t0 + 0.35 });
  },
  // Rising two-note interval, staggered — an opening-up figure.
  bloom: (ctx, out, t0) => {
    tone(ctx, out, { type: "sine", freq: 523, peak: 0.4, start: t0, end: t0 + 0.3 });
    tone(ctx, out, { type: "sine", freq: 784, peak: 0.4, start: t0 + 0.09, end: t0 + 0.45 });
  },
  // Two low-passed noise taps — knuckles on wood. The one non-tonal preset.
  knock: (ctx, out, t0) => {
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.06), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    for (const at of [t0, t0 + 0.13]) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 320;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.9, at);
      env.gain.exponentialRampToValueAtTime(0.001, at + 0.06);
      src.connect(lp).connect(env).connect(out);
      src.start(at);
    }
  },
  // Two short triangle bursts on one pitch — steady heartbeat tick.
  pulse: (ctx, out, t0) => {
    tone(ctx, out, { type: "triangle", freq: 660, peak: 0.45, start: t0, end: t0 + 0.1, attack: 0.005 });
    tone(ctx, out, { type: "triangle", freq: 660, peak: 0.45, start: t0 + 0.16, end: t0 + 0.26, attack: 0.005 });
  },
};

function play(id: SoundId, volume: number): void {
  try {
    const ctx = ensureContext();
    // Perceptual curve: linear gain makes 50% sound nearly as loud as 100%.
    const v = Math.max(0, Math.min(100, volume));
    master!.gain.setValueAtTime(Math.pow(v / 100, 2), ctx.currentTime);
    RECIPES[id](ctx, master!, ctx.currentTime + 0.01);
  } catch (e) {
    console.debug("[notif-sound] play failed", e);
  }
}

/** Notification-time playback. The caller has already checked notifSoundEnabled. */
export function playNotificationSound(id: SoundId): void {
  play(id, useAppStore.getState().notifSoundVolume ?? 50);
}

/** Preview from the picker/settings. Plays even while the sound toggle is OFF
 * (auditioning is an explicit user action), but respects the volume setting. */
export function previewSound(id: SoundId): void {
  play(id, useAppStore.getState().notifSoundVolume ?? 50);
}

/**
 * Per-project sound, assigned lazily on first use (unlike colors, which
 * auto-assign render-time in TabBar). Absent key → pick a random unused sound
 * and persist it; `null` is the user's sticky "No sound" and is returned as-is.
 */
export function ensureProjectSound(workingDir: string): ProjectSoundId {
  const key = workingDir.replace(/\\/g, "/");
  if (!key) return null;
  const s = useAppStore.getState();
  const current = (s.projectSounds ?? {})[key];
  if (current !== undefined) return current;
  const id = autoAssignSound(s.projectSounds ?? {});
  s.setProjectSound(key, id);
  return id;
}
