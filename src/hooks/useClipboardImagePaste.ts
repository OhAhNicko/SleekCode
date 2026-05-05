import { useState, useEffect, useRef, useCallback } from "react";
import type { TerminalType } from "../types";
import { useClipboardImageStore } from "../store/clipboardImageStore";
import { undoLastInsertion, getImageLabel, resolveImagePath } from "../lib/clipboard-insert";

export interface PastedImage {
  /** Data URI for the thumbnail preview */
  thumbnailUrl: string;
  /** File path as inserted into the terminal */
  filePath: string;
}

interface UseClipboardImagePasteOptions {
  containerRef: React.RefObject<HTMLDivElement | null>;
  terminalRef: React.RefObject<import("@xterm/xterm").Terminal | null>;
  terminalType: TerminalType;
  terminalId: string;
  write: (data: string) => void;
  exited: boolean;
  onFocus?: () => void;
}

export function useClipboardImagePaste({
  containerRef,
  terminalRef,
  terminalType,
  terminalId,
  write,
  exited,
  onFocus,
}: UseClipboardImagePasteOptions) {
  const [pastedImage, setPastedImage] = useState<PastedImage | null>(null);
  const processingRef = useRef(false);

  const dismissPreview = useCallback(() => {
    setPastedImage(null);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Shared paste action — used by Ctrl+V and middle-click.
    // If the clipboard has a tracked image, inserts its file path (the active
    // clipboard-image capture flow); otherwise pastes text via the system
    // clipboard.
    const pasteFromClipboard = async () => {
      // Activate this pane before pasting — paste implies the user intends to
      // direct input here, even if it wasn't the active pane.
      onFocus?.();

      const store = useClipboardImageStore.getState();
      const latestImage = store.images[0];

      if (latestImage && store.lastSeq === store.lastImageSeq) {
        // resolveImagePath may upload to a remote SSH host; if it returns null
        // the upload failed and a toast is already showing — fall through to
        // the text-paste path so the user isn't stuck.
        const filePath = await resolveImagePath(latestImage.winPath, "clipboard");
        if (filePath) {
          const label = getImageLabel(latestImage.winPath);
          write(filePath);
          setPastedImage({ thumbnailUrl: latestImage.dataUri, filePath: label });

          store.setLastInsertion({
            text: filePath,
            terminalId,
            timestamp: Date.now(),
          });
          return;
        }
      }

      navigator.clipboard.readText().then((text) => {
        if (!text) return;
        // Delegate to xterm's paste() so multiline text is wrapped in
        // bracketed-paste escapes (\x1b[200~…\x1b[201~) when the underlying
        // app has enabled it. Prevents each \r in the paste from submitting
        // as its own command in Claude/Codex/Gemini and modern bash/pwsh.
        const term = terminalRef.current;
        if (term) term.paste(text);
        else write(text);
      });
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;

      // Ctrl+C — copy selection if any, otherwise let SIGINT through
      if (e.key === "c" || e.key === "C") {
        const term = terminalRef.current;
        if (term) {
          const selection = term.getSelection();
          if (selection) {
            e.preventDefault();
            e.stopPropagation();
            navigator.clipboard.writeText(selection);
            term.clearSelection();
            return;
          }
        }
        // No selection — let xterm send \x03 (SIGINT)
        return;
      }

      if (exited || processingRef.current) return;

      // Ctrl+Z — undo last clipboard image insertion
      if (e.key === "z" || e.key === "Z") {
        const store = useClipboardImageStore.getState();
        const insertion = store.lastInsertion;
        // Only intercept if there's a recent insertion (within 5s)
        if (insertion && Date.now() - insertion.timestamp <= 5000) {
          e.preventDefault();
          e.stopPropagation();
          undoLastInsertion();
          setPastedImage(null);
          return;
        }
        // Otherwise let xterm handle normal Ctrl+Z
        return;
      }

      // Ctrl+V — paste image label if clipboard has one
      if (e.key !== "v" && e.key !== "V") return;

      e.preventDefault();
      e.stopPropagation();
      void pasteFromClipboard();
    };

    // Middle-click (scroll wheel) paste — mirrors Ctrl+V behavior.
    // Using mousedown on capture phase so preventDefault blocks Windows
    // autoscroll mode before the browser activates it.
    const handleMouseDown = (e: MouseEvent) => {
      if (e.button !== 1) return;
      if (exited || processingRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      void pasteFromClipboard();
    };

    // Browsers that fire `auxclick` for button 1 still trigger autoscroll
    // unless the preceding mousedown was also suppressed. Kept as a
    // belt-and-suspenders guard against default paste-on-auxclick behaviors.
    const handleAuxClick = (e: MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      e.stopPropagation();
    };

    container.addEventListener("keydown", handleKeyDown, true);
    container.addEventListener("mousedown", handleMouseDown, true);
    container.addEventListener("auxclick", handleAuxClick, true);
    return () => {
      container.removeEventListener("keydown", handleKeyDown, true);
      container.removeEventListener("mousedown", handleMouseDown, true);
      container.removeEventListener("auxclick", handleAuxClick, true);
    };
  }, [containerRef, terminalRef, terminalType, terminalId, write, exited, onFocus]);

  return { pastedImage, dismissPreview };
}
