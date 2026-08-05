/**
 * Request the CLI install dialog.
 *
 * Mounted once in App like `PromptModal` and `UnlockKeychainModal`, and for the
 * same two reasons: it needs real keyboard focus (impossible in the
 * `WS_EX_NOACTIVATE` overlay webview), and it has to hide the native panes
 * while it is open — they are child HWNDs that would otherwise paint straight
 * over it.
 *
 * The request crosses as a CustomEvent carrying its own callback, the pattern
 * `prompt-modal.ts` established. Safe here for the same reason: it never leaves
 * this JS context.
 */

import type { TerminalBackend } from "../types";
import type { AiCli } from "./cli-availability";

export interface CliInstallRequest {
  cli: AiCli;
  backend: TerminalBackend;
  /** Which remote server, when `backend` is "ssh". */
  serverId?: string;
  /**
   * What "Launch" does once the CLI is in place. A blocked pane passes its own
   * unblock-and-spawn; a launcher passes "open a new pane". Omit it and the
   * dialog simply reports success — Settings has no pane to launch into, and a
   * button that cannot act is worse than no button.
   */
  onLaunch?: () => void;
  /** Button text for `onLaunch`, e.g. "Start Codex". */
  launchLabel?: string;
}

export const CLI_INSTALL_EVENT = "made:cli-install";

export function requestCliInstall(req: CliInstallRequest): void {
  window.dispatchEvent(new CustomEvent<CliInstallRequest>(CLI_INSTALL_EVENT, { detail: req }));
}
