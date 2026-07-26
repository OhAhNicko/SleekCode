import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useClipboardImageStore } from "../store/clipboardImageStore";
import { useAppStore } from "../store";
import { insertImagePath } from "../lib/clipboard-insert";
import { dataUriBytes, findOriginal, measureDataUri } from "../lib/screenshots";

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
          // Measure before adding: the store matches a clipboard capture to the
          // Screenshots-folder copy of the same snip on dimensions + time, and
          // without dimensions that degrades to a time-only match — too loose
          // to merge (or later delete) on.
          const size = await measureDataUri(result.image.data_uri);

          clipStore.addImage(
            {
              winPath: result.image.path,
              dataUri: result.image.data_uri,
              width: size?.width,
              height: size?.height,
              bytes: dataUriBytes(result.image.data_uri),
            },
            result.seq
          );

          const added = useClipboardImageStore
            .getState()
            .images.find((im) => im.tempPath === result.image!.path);

          // The store rejected it as a byte-identical re-save, so the PNG we
          // just wrote is an orphan nothing points at. Unlink it now instead of
          // leaving it for the 24h sweep — a clipboard that keeps getting
          // touched would otherwise strew a copy of the same image across
          // %TEMP%\made every poll.
          if (!added) {
            void invoke("screenshots_delete", { tempPath: result.image.path }).catch(
              () => {},
            );
          }

          // Find the Snipping Tool original so "delete from the PC" removes
          // both copies. Runs regardless of the folder-watcher setting — the
          // second file exists either way.
          if (added && !added.originalPath) {
            void findOriginal(result.image.path).then((orig) => {
              if (orig) {
                useClipboardImageStore.getState().attachOriginalPath(added.id, orig.path);
              }
            });
          }

          // Auto-insert if setting is enabled
          if (useAppStore.getState().autoInsertClipboardImage) {
            if (useAppStore.getState().promptComposerEnabled) {
              // Attach to active MadeComposer instead of writing to terminal
              const cs = useClipboardImageStore.getState();
              const newImg = cs.images[0];
              const activeId = cs.activeComposerTerminalId;
              if (newImg && activeId) {
                cs.setPendingComposerImage({ image: newImg, terminalId: activeId });
              }
            } else {
              // insertImagePath is async (may upload to remote SSH host); the
              // promise resolves itself even on failure (toast is surfaced
              // via the clipboard image store), so just kick it off.
              void insertImagePath(result.image.path);
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
