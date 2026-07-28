import { useEffect, useState } from "react";
import { useClipboardImageStore } from "../store/clipboardImageStore";
import { undoLastInsertion } from "../lib/clipboard-insert";
import { useOverlayToast } from "../lib/useOverlayToast";
import { openScreenshotViewer } from "../lib/screenshot-viewer";

const TOAST_DURATION_MS = 5000;

/**
 * The single image-paste toast: thumbnail + "Image pasted" + filename, with
 * Undo (Ctrl+Z) and X. Clicking the card opens the image in the screenshot
 * viewer. Overlay-migrated: state and timer live here (main webview); the card
 * renders in the overlay webview above the native panes (kind "toast").
 * Duration matches the 5s undo window so Undo is never shown dead.
 */
export default function ImageInsertUndoToast() {
  const lastInsertion = useClipboardImageStore((s) => s.lastInsertion);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!lastInsertion) {
      setVisible(false);
      return;
    }

    setVisible(true);
    const timer = setTimeout(() => {
      setVisible(false);
      useClipboardImageStore.getState().setLastInsertion(null);
    }, TOAST_DURATION_MS);

    return () => clearTimeout(timer);
  }, [lastInsertion]);

  const active = visible && !!lastInsertion;

  const fileName = lastInsertion
    ? (lastInsertion.text.split(/[\\/]/).pop() ?? lastInsertion.text)
    : "";

  useOverlayToast({
    id: "image-insert-undo-toast",
    open: active,
    payload: active
      ? {
          placement: "bottom-center",
          variant: "surface",
          title: "Image pasted",
          detail: fileName,
          // Full path — shown as the hover tooltip on the truncated filename.
          detailTooltip: lastInsertion?.text,
          thumbnailUrl: lastInsertion?.thumbnailUrl,
          button: { label: "Undo", action: "undo" },
          shortcutHint: "Ctrl+Z",
          dismissable: true,
          clickAction: "open",
        }
      : null,
    onAction: (action) => {
      switch (action) {
        case "undo":
          undoLastInsertion();
          setVisible(false);
          break;
        case "open":
          openScreenshotViewer(lastInsertion?.imageId ?? null);
          setVisible(false);
          break;
        case "dismiss":
          // Hide the card only — Ctrl+Z keeps working for the 5s window.
          setVisible(false);
          break;
      }
    },
  });

  return null;
}
