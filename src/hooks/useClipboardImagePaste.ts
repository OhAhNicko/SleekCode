import { useState, useEffect, useRef, useCallback } from "react";
import type { TerminalType } from "../types";
import { useClipboardImageStore } from "../store/clipboardImageStore";
import { undoLastInsertion, getImageLabel } from "../lib/clipboard-insert";

export interface PastedImage {
  /** Data URI for the thumbnail preview */
  thumbnailUrl: string;
  /** File path as inserted into the terminal */
  filePath: string;
}

interface UseClipboardImagePasteOptions {
  containerRef: React.RefObject<HTMLDivElement | null>;
  terminalType: TerminalType;
  terminalId: string;
  write: (data: string) => void;
  exited: boolean;
}

export function useClipboardImagePaste({
  containerRef,
  terminalType,
  terminalId,
  write,
  exited,
}: UseClipboardImagePasteOptions) {
  const [pastedImage, setPastedImage] = useState<PastedImage | null>(null);
  const processingRef = useRef(false);

  const dismissPreview = useCallback(() => {
    setPastedImage(null);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
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

      const store = useClipboardImageStore.getState();
      const latestImage = store.images[0];

      if (latestImage && store.lastSeq === store.lastImageSeq) {
        e.preventDefault();
        e.stopPropagation();

        const label = getImageLabel(latestImage.winPath);
        write(label);
        setPastedImage({ thumbnailUrl: latestImage.dataUri, filePath: label });

        // Record for undo
        store.setLastInsertion({
          text: label,
          terminalId,
          timestamp: Date.now(),
        });
        return;
      }

      // No image in clipboard — let xterm handle normal text paste
    };

    container.addEventListener("keydown", handleKeyDown, true);
    return () => container.removeEventListener("keydown", handleKeyDown, true);
  }, [containerRef, terminalType, terminalId, write, exited]);

  return { pastedImage, dismissPreview };
}
