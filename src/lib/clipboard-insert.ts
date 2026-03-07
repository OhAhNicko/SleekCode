import { useAppStore } from "../store";
import { getPtyWrite } from "../store/terminalSlice";
import { useClipboardImageStore } from "../store/clipboardImageStore";

/**
 * Get the display label for a clipboard image (e.g. "[Image #1]").
 * Image number is based on position in the store (newest = #1).
 */
export function getImageLabel(winPath: string): string {
  const images = useClipboardImageStore.getState().images;
  const index = images.findIndex((img) => img.winPath === winPath);
  const num = index >= 0 ? index + 1 : images.length + 1;
  return `[Img ${num}]`;
}

/**
 * Insert a clipboard image label into the active terminal.
 * Records the insertion for undo support.
 * Returns the inserted label, or null if no active terminal.
 */
export function insertImagePath(winPath: string): string | null {
  const terminals = useAppStore.getState().terminals;
  const activeTerminal = Object.values(terminals).find((t) => t.isActive);
  if (!activeTerminal) return null;

  const writeFn = getPtyWrite(activeTerminal.id);
  if (!writeFn) return null;

  const label = getImageLabel(winPath);
  writeFn(label);

  // Record for undo
  useClipboardImageStore.getState().setLastInsertion({
    text: label,
    terminalId: activeTerminal.id,
    timestamp: Date.now(),
  });

  return label;
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
