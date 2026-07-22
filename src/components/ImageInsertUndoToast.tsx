import { useEffect, useState } from "react";
import { useClipboardImageStore } from "../store/clipboardImageStore";
import { undoLastInsertion } from "../lib/clipboard-insert";
import { useOverlayToast } from "../lib/useOverlayToast";

const TOAST_DURATION_MS = 5000;

/**
 * "Inserted <file> — Undo" toast for the last image path insertion.
 * Overlay-migrated: state and timer live here (main webview); the card
 * renders in the overlay webview above the native panes (kind "toast").
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
          title: `Inserted ${fileName}`,
          // Full path — shown as the hover tooltip on the truncated title.
          detail: lastInsertion?.text,
          button: { label: "Undo", action: "undo" },
          shortcutHint: "Ctrl+Z",
        }
      : null,
    onAction: (action) => {
      if (action === "undo") {
        undoLastInsertion();
        setVisible(false);
      }
    },
  });

  return null;
}
