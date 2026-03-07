import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useClipboardImageStore } from "../store/clipboardImageStore";
import { useAppStore } from "../store";
import { insertImagePath } from "../lib/clipboard-insert";

interface ClipboardPollResult {
  seq: number;
  image: { path: string; data_uri: string } | null;
}

const POLL_INTERVAL_MS = 1500;

/**
 * Polls the Windows clipboard for new images every 1.5 seconds.
 * Uses GetClipboardSequenceNumber() for fast change detection —
 * only reads the actual image (slow PowerShell) when the clipboard changes.
 * Adds detected images to the session-wide clipboard image store.
 * Optionally auto-inserts the path into the active terminal.
 */
export function useClipboardWatcher() {
  const lastSeqRef = useRef(0);

  useEffect(() => {
    let active = true;

    const poll = async () => {
      if (!active) return;

      try {
        const result = await invoke<ClipboardPollResult>(
          "poll_clipboard_image",
          { lastSeq: lastSeqRef.current }
        );

        lastSeqRef.current = result.seq;
        const clipStore = useClipboardImageStore.getState();
        clipStore.setLastSeq(result.seq);

        if (result.image) {
          clipStore.addImage(
            { winPath: result.image.path, dataUri: result.image.data_uri },
            result.seq
          );

          // Auto-insert if setting is enabled
          if (useAppStore.getState().autoInsertClipboardImage) {
            if (useAppStore.getState().promptComposerEnabled) {
              // Attach to active EzyComposer instead of writing to terminal
              const cs = useClipboardImageStore.getState();
              const newImg = cs.images[0];
              const activeId = cs.activeComposerTerminalId;
              if (newImg && activeId) {
                cs.setPendingComposerImage({ image: newImg, terminalId: activeId });
              }
            } else {
              insertImagePath(result.image.path);
            }
          }
        }
      } catch {
        // Polling failed — ignore
      }
    };

    // Initial poll
    poll();

    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
}
