import { useEffect, useState } from "react";
import { useUndoClearStore, undoClearComposer } from "../store/undoClearStore";
import { useOverlayToast } from "../lib/useOverlayToast";

const TOAST_DURATION_MS = 5000;

/**
 * "Cleared composer — Undo" toast. Overlay-migrated: state, timer and the
 * Ctrl+Z shortcut live here (main webview); the card renders in the overlay
 * webview above the native panes (kind "toast", ambient/flat).
 */
export default function UndoClearToast() {
  const clearedText = useUndoClearStore((s) => s.clearedText);
  const clear = useUndoClearStore((s) => s.clear);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!clearedText) {
      setVisible(false);
      return;
    }

    setVisible(true);
    const timer = setTimeout(() => {
      setVisible(false);
      clear();
    }, TOAST_DURATION_MS);

    return () => clearTimeout(timer);
  }, [clearedText, clear]);

  // Ctrl+Z undo shortcut — capture phase to fire before UndoCloseToast (bubble)
  useEffect(() => {
    if (!visible || !clearedText) return;
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "z") {
        e.preventDefault();
        e.stopPropagation();
        undoClearComposer();
        setVisible(false);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [visible, clearedText]);

  const active = visible && !!clearedText;

  useOverlayToast({
    id: "undo-clear-toast",
    open: active,
    payload: active
      ? {
          placement: "bottom-center",
          variant: "surface",
          title: "Cleared composer",
          button: { label: "Undo", action: "undo" },
          shortcutHint: "Ctrl+Z",
        }
      : null,
    onAction: (action) => {
      if (action === "undo") {
        undoClearComposer();
        setVisible(false);
      }
    },
  });

  return null;
}
