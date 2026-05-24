// One-shot localStorage migration: ezydev-* keys → made-* keys.
// Runs at app boot before Zustand persist initializes. Idempotent.

const EXACT_KEY_MAP: Array<[string, string]> = [
  ["ezydev-storage", "made-storage"],
  ["ezydev.silenceDevServerRestore", "made.silenceDevServerRestore"],
  ["ezydev-devtools-pinned", "made-devtools-pinned"],
  ["ezydev-devtools-height", "made-devtools-height"],
  ["ezydev-native-cli-cache", "made-native-cli-cache"],
  ["ezydev-wsl-cli-cache", "made-wsl-cli-cache"],
  ["ezydev-windows-cli-cache", "made-windows-cli-cache"],
  ["ezydev-slot-park", "made-slot-park"],
];

const PREFIX_MAP: Array<[string, string]> = [
  ["ezydev-wordle-", "made-wordle-"],
];

export function migrateEzyDevToMade(): void {
  try {
    if (typeof localStorage === "undefined") return;

    for (const [oldKey, newKey] of EXACT_KEY_MAP) {
      const oldVal = localStorage.getItem(oldKey);
      if (oldVal === null) continue;
      if (localStorage.getItem(newKey) === null) {
        localStorage.setItem(newKey, oldVal);
      }
      localStorage.removeItem(oldKey);
    }

    const keysToRewrite: Array<[string, string]> = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      for (const [oldPrefix, newPrefix] of PREFIX_MAP) {
        if (key.startsWith(oldPrefix)) {
          keysToRewrite.push([key, newPrefix + key.slice(oldPrefix.length)]);
          break;
        }
      }
    }
    for (const [oldKey, newKey] of keysToRewrite) {
      const oldVal = localStorage.getItem(oldKey);
      if (oldVal === null) continue;
      if (localStorage.getItem(newKey) === null) {
        localStorage.setItem(newKey, oldVal);
      }
      localStorage.removeItem(oldKey);
    }
  } catch {
    // localStorage may be unavailable (private mode, quota); skip silently.
  }
}
