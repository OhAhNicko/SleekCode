import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { getPtyWrite, getTerminalFocus } from "../store/terminalSlice";
import { useClipboardImageStore } from "../store/clipboardImageStore";
import { toWslPath } from "./terminal-config";
import { registerImageMask } from "./image-mask";

/**
 * Get the display label for a clipboard image (e.g. "[Img 1]").
 * Image number is based on position in the store (newest = #1).
 * Used for visual display in the composer — NOT for sending to CLIs.
 */
export function getImageLabel(winPath: string): string {
  const images = useClipboardImageStore.getState().images;
  const index = images.findIndex((img) => img.winPath === winPath);
  const num = index >= 0 ? index + 1 : images.length + 1;
  return `[Img ${num}]`;
}

/**
 * Build a stable POSIX remote path for a Windows file under /tmp/ezydev/.
 * Uses the basename plus a millisecond timestamp to avoid collisions across
 * rapid pastes. Caller decides the prefix (e.g. "clipboard" vs "drop").
 */
export function buildRemotePath(localPath: string, prefix: string): string {
  const basename = localPath.split(/[\\/]/).pop() || `${prefix}.bin`;
  const ts = Date.now();
  return `/tmp/ezydev/${prefix}-${ts}-${basename}`;
}

/**
 * Resolve a local Windows file path to whatever path string should actually
 * be inserted into the active terminal.
 *
 * - If the active terminal is bound to a remote SSH server, the local file
 *   is uploaded to /tmp/ezydev/<prefix>-<ts>-<basename> on the remote and
 *   the remote path is returned.
 * - Otherwise, the path is converted to the right local format (Windows or
 *   WSL) for the configured terminal backend.
 *
 * Returns null if the upload was attempted but failed — the caller must NOT
 * insert anything in that case (a toast is surfaced via the clipboard image
 * store).
 */
export async function resolveImagePath(
  winPath: string,
  prefix: "clipboard" | "drop" = "clipboard"
): Promise<string | null> {
  const state = useAppStore.getState();
  const activeTerminal = Object.values(state.terminals).find((t) => t.isActive);

  if (activeTerminal?.serverId) {
    const server = state.servers.find((s) => s.id === activeTerminal.serverId);
    if (!server) {
      useClipboardImageStore.getState().setUploadError({
        title: "Upload failed",
        detail: `Remote server ${activeTerminal.serverId} not found`,
        timestamp: Date.now(),
      });
      return null;
    }

    const remotePath = buildRemotePath(winPath, prefix);
    try {
      const uploaded = await invoke<string>("ssh_upload_file_bytes", {
        host: server.host,
        username: server.username,
        localPath: winPath,
        remotePath,
        identityFile: server.sshKeyPath,
      });
      return uploaded;
    } catch (e) {
      useClipboardImageStore.getState().setUploadError({
        title: `Upload to ${server.name} failed`,
        detail: String(e),
        timestamp: Date.now(),
      });
      return null;
    }
  }

  const backend = state.terminalBackend ?? "wsl";
  return backend === "windows" ? winPath : toWslPath(winPath);
}

/**
 * Insert a clipboard image file path into the active terminal.
 * Records the insertion for undo support.
 * Returns the inserted text, or null if no active terminal or upload failed.
 */
export async function insertImagePath(winPath: string): Promise<string | null> {
  const terminals = useAppStore.getState().terminals;
  const activeTerminal = Object.values(terminals).find((t) => t.isActive);
  if (!activeTerminal) return null;

  const writeFn = getPtyWrite(activeTerminal.id);
  if (!writeFn) return null;

  const filePath = await resolveImagePath(winPath, "clipboard");
  if (!filePath) return null;

  // Append a trailing space so the user can immediately start typing
  // without the next character colliding with the path.
  const insertion = filePath + " ";

  // Register a display mask BEFORE writing so the echo (if enabled in settings)
  // can be rewritten to [Image #N] when the shell echoes the path back.
  const images = useClipboardImageStore.getState().images;
  const idx = images.findIndex((im) => im.winPath === winPath);
  const imageNumber = idx >= 0 ? idx + 1 : images.length + 1;
  registerImageMask(activeTerminal.id, filePath, imageNumber);

  writeFn(insertion);

  // Record for undo (includes the trailing space so undo removes both)
  useClipboardImageStore.getState().setLastInsertion({
    text: insertion,
    terminalId: activeTerminal.id,
    timestamp: Date.now(),
  });

  // Return focus to the target terminal so the user can keep typing.
  // Deferred via rAF so it runs after any modal close / unmount tick.
  const focusFn = getTerminalFocus(activeTerminal.id);
  if (focusFn) requestAnimationFrame(() => focusFn());

  return insertion;
}

/**
 * Undo the last clipboard image path insertion by sending backspaces.
 * Only works within 5 seconds of insertion.
 */
export function undoLastInsertion(): boolean {
  const store = useClipboardImageStore.getState();
  const insertion = store.lastInsertion;
  if (!insertion) return false;

  // Only allow undo within 5 seconds
  if (Date.now() - insertion.timestamp > 5000) {
    store.setLastInsertion(null);
    return false;
  }

  const writeFn = getPtyWrite(insertion.terminalId);
  if (!writeFn) return false;

  // Send DEL (0x7F) to erase the path — this is what the Backspace key
  // actually sends to the PTY. \b (0x08) only moves the cursor, it doesn't
  // delete from the shell's readline buffer.
  const backspaces = "\x7f".repeat(insertion.text.length);
  writeFn(backspaces);

  store.setLastInsertion(null);
  return true;
}
