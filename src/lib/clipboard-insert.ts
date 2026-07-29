import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { getPtyWrite, getTerminalFocus } from "../store/terminalSlice";
import { useClipboardImageStore, type ClipboardImage } from "../store/clipboardImageStore";
import { findAllTerminalIds } from "./layout-utils";
import { toWslPath } from "./terminal-config";
import { registerImageMask } from "./image-mask";

/**
 * The terminal the caret is in: the globally active terminal, but ONLY when
 * it belongs to the ACTIVE tab's layout.
 *
 * The global `isActive` flag can go stale — background tabs' Workspaces used
 * to claim it on mount, and tab switches don't route through a pane click —
 * so trusting it raw once pasted a screenshot into a pane of a different
 * project. A screenshot must never land in a pane the user cannot see:
 * when the flag points outside the active tab, return null and let the
 * caller do nothing.
 */
export function resolveCaretTerminalId(): string | null {
  const state = useAppStore.getState();
  const active = Object.values(state.terminals).find((t) => t.isActive);
  if (!active) return null;
  const tab = state.tabs.find((t) => t.id === state.activeTabId);
  if (!tab?.layout) return null;
  return findAllTerminalIds(tab.layout).includes(active.id) ? active.id : null;
}

/**
 * Hand a screenshot to a terminal pane: its MadeComposer when one is mounted
 * (and the composer feature is on), the PTY path-insert otherwise.
 *
 * Every attach flow (thumbnail double-click, viewer button, auto-insert,
 * drag-drop) funnels through here so the target rules stay in one place.
 * Without `explicitTerminalId` the target is the caret pane; with it (drag
 * onto a specific pane) the caller's pane wins.
 */
export async function attachImage(
  image: ClipboardImage,
  explicitTerminalId?: string
): Promise<void> {
  const terminalId = explicitTerminalId ?? resolveCaretTerminalId();
  if (!terminalId) return;
  const state = useAppStore.getState();
  const composers = useClipboardImageStore.getState().mountedComposers;
  if (state.promptComposerEnabled && composers[terminalId]) {
    useClipboardImageStore.getState().setPendingComposerImage({ image, terminalId });
    return;
  }
  await insertImagePath(image.winPath, terminalId);
}

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
 * Build a stable POSIX remote path for a Windows file under /tmp/made/.
 * Uses the basename plus a millisecond timestamp to avoid collisions across
 * rapid pastes. Caller decides the prefix (e.g. "clipboard" vs "drop").
 */
export function buildRemotePath(localPath: string, prefix: string): string {
  const basename = localPath.split(/[\\/]/).pop() || `${prefix}.bin`;
  const ts = Date.now();
  return `/tmp/made/${prefix}-${ts}-${basename}`;
}

/**
 * Resolve a local Windows file path to whatever path string should actually
 * be inserted into the active terminal.
 *
 * - If the active terminal is bound to a remote SSH server, the local file
 *   is uploaded to /tmp/made/<prefix>-<ts>-<basename> on the remote and
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
  prefix: "clipboard" | "drop" = "clipboard",
  terminalId?: string
): Promise<string | null> {
  const state = useAppStore.getState();
  const targetId = terminalId ?? resolveCaretTerminalId();
  const targetTerminal = targetId ? state.terminals[targetId] : undefined;

  if (targetTerminal?.serverId) {
    const server = state.servers.find((s) => s.id === targetTerminal.serverId);
    if (!server) {
      useClipboardImageStore.getState().setUploadError({
        title: "Upload failed",
        detail: `Remote server ${targetTerminal.serverId} not found`,
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
 * Quote a path for a shell prompt, but only when it needs it.
 *
 * Windows paths are backslash-separated, so POSIX backslash escaping is not an
 * option — single quotes are the only safe wrapper on bash, and double quotes
 * on cmd/PowerShell. Paths without whitespace are left bare so the common case
 * (`clipboard-1729.png`) looks exactly as it always has.
 */
function quoteForShell(path: string): string {
  if (!/\s/.test(path)) return path;
  const backend = useAppStore.getState().terminalBackend ?? "wsl";
  if (backend === "windows") return `"${path}"`;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * Insert a clipboard image file path into a terminal — the caret pane by
 * default, or an explicit target (drag-drop). Records the insertion for undo
 * support. Returns the inserted text, or null if no valid target terminal or
 * the upload failed. "No valid target" includes the active-terminal flag
 * pointing outside the active tab — inserting into an invisible pane in
 * another project is strictly worse than doing nothing.
 */
export async function insertImagePath(
  winPath: string,
  terminalId?: string
): Promise<string | null> {
  const targetId = terminalId ?? resolveCaretTerminalId();
  if (!targetId) return null;
  const activeTerminal = useAppStore.getState().terminals[targetId];
  if (!activeTerminal) return null;

  const writeFn = getPtyWrite(activeTerminal.id);
  if (!writeFn) return null;

  const filePath = await resolveImagePath(winPath, "clipboard", activeTerminal.id);
  if (!filePath) return null;

  // Register a display mask BEFORE writing so the echo (if enabled in settings)
  // can be rewritten to [Image #N] when the shell echoes the path back.
  const images = useClipboardImageStore.getState().images;
  const idx = images.findIndex((im) => im.winPath === winPath);
  const imageNumber = idx >= 0 ? idx + 1 : images.length + 1;
  registerImageMask(activeTerminal.id, filePath, imageNumber);

  // For CLI TUIs (Claude/Codex/Gemini) wrap in bracketed paste so the TUI
  // ingests the path as a single paste atom and renders [Image #N] cleanly.
  // Without it, raw character input leaves an invisible whitespace gap where
  // the rest of the path would visually sit.
  const isCli =
    activeTerminal.type === "claude" ||
    activeTerminal.type === "codex" ||
    activeTerminal.type === "gemini";
  // A plain shell splits on whitespace, and OS screenshot names are full of it
  // ("Screenshot 2026-07-26 141530.png"). CLIs take the path as one paste atom
  // and would show the quotes, so only the shell branch gets them.
  const insertion = isCli ? filePath : quoteForShell(filePath) + " ";
  if (isCli) {
    writeFn("\x1b[200~" + filePath + "\x1b[201~");
  } else {
    writeFn(insertion);
  }

  // Record for undo (includes the trailing space so undo removes both)
  const insertedImage = idx >= 0 ? images[idx] : undefined;
  useClipboardImageStore.getState().setLastInsertion({
    text: insertion,
    terminalId: activeTerminal.id,
    timestamp: Date.now(),
    imageId: insertedImage?.id,
    thumbnailUrl: insertedImage?.dataUri,
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
