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
}

/** Open the dialog for a remote server. No-op if that server is gone. */
export function openUnlockKeychain(serverId: string): void {
  window.dispatchEvent(
    new CustomEvent<UnlockKeychainRequest>(UNLOCK_KEYCHAIN_EVENT, {
      detail: { serverId },
    }),
  );
}
