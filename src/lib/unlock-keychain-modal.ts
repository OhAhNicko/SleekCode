/**
 * Opener for the manual "Unlock Keychain" dialog.
 *
 * Same shape as `prompt-modal.ts`, and for the same reason: the dialog needs
 * real keyboard focus, so it renders in the MAIN webview from a single
 * app-level host (`UnlockKeychainModal`, mounted in App).
 *
 * The event indirection is load-bearing, not decoration. `ServersPanel` — which
 * draws the row the key icon lives on — can be mounted TWICE at once: compact
 * inside the Dev Servers panel and full-size in the Servers tab. A modal owned
 * by the panel would therefore open twice. One host, one listener, one dialog.
 */
export const UNLOCK_KEYCHAIN_EVENT = "made:unlock-keychain";

export interface UnlockKeychainRequest {
  serverId: string;
  /** Present when a spawning pane is waiting at the preamble's `read`. The
   *  resolver travels inside the CustomEvent (same pattern as prompt-modal.ts
   *  — safe because it never leaves this JS context) and MUST be called
   *  exactly once on every exit path: an orphaned resolver hangs the pane. */
  spawn?: {
    isRetry: boolean;
    resolve: (password: string | null) => void;
  };
}

/** Open the dialog for a remote server. No-op if that server is gone. */
export function openUnlockKeychain(serverId: string): void {
  window.dispatchEvent(
    new CustomEvent<UnlockKeychainRequest>(UNLOCK_KEYCHAIN_EVENT, {
      detail: { serverId },
    }),
  );
}

/**
 * Spawn-time variant: a remote Claude pane hit a locked keychain and its
 * watcher needs a password to answer the remote `read`. Resolves with the
 * password (verified over ssh first on key-auth servers) or null on cancel.
 * `isRetry` seeds the "Wrong password" note when the pane's in-band unlock
 * already rejected an earlier answer.
 */
export function requestSpawnUnlock(serverId: string, isRetry: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    window.dispatchEvent(
      new CustomEvent<UnlockKeychainRequest>(UNLOCK_KEYCHAIN_EVENT, {
        detail: { serverId, spawn: { isRetry, resolve } },
      }),
    );
  });
}
