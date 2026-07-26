import { getPtyWrite } from "../store/terminalSlice";
import { useAppStore } from "../store";

/**
 * Paste text into a terminal pane's PTY.
 *
 * This is *paste*, not *submit* — no Enter is appended. The submit path lives
 * in the pane components (`TerminalPaneXterm`'s composer handler) and needs a
 * length-scaled delay before Enter; pasting has no such race because nothing
 * follows the text.
 *
 * CLI panes get bracketed paste so the TUI ingests the text as one atom.
 * Without it a multi-line paste is read as a sequence of Enter presses, which
 * submits half a prompt.
 */
export function pasteTextToTerminal(terminalId: string, text: string): boolean {
  if (!text) return false;
  const writeFn = getPtyWrite(terminalId);
  if (!writeFn) return false;

  const term = useAppStore.getState().terminals[terminalId];
  const isCli =
    term?.type === "claude" || term?.type === "codex" || term?.type === "gemini";

  if (isCli) {
    writeFn("\x1b[200~" + text + "\x1b[201~");
  } else {
    writeFn(text);
  }
  return true;
}
