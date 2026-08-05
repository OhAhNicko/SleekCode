/**
 * Deep-link into a Settings nav section.
 *
 * SettingsPane only mounts while the panel is open, so opening the panel and
 * dispatching in the same tick would fire before any listener exists. The
 * request is therefore ALSO parked here and read by SettingsPane on mount.
 *
 * Nothing consumes-and-clears: React StrictMode double-invokes state
 * initializers in dev, so a take() would hand the section to the throwaway
 * render and leave the real one on the default tab. The request expires on
 * time instead, which is both idempotent and self-cleaning.
 */

const PENDING_TTL_MS = 3_000;

let pending: { id: string; at: number } | null = null;

/** Ask SettingsPane to show `id` — both if it is already open and if it isn't. */
export function requestSettingsSection(id: string): void {
  pending = { id, at: Date.now() };
  window.dispatchEvent(new CustomEvent("made:settings-section", { detail: id }));
}

/** The section requested in the last few seconds, if any. */
export function pendingSettingsSection(): string | null {
  if (!pending) return null;
  if (Date.now() - pending.at > PENDING_TTL_MS) {
    pending = null;
    return null;
  }
  return pending.id;
}
