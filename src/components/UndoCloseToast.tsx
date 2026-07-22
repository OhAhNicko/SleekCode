import { useEffect, useState } from "react";
import { useUndoCloseStore, undoClose } from "../store/undoCloseStore";
import { useOverlayToast } from "../lib/useOverlayToast";

const TOAST_DURATION_MS = 5000;

/**
 * "Closed tab/pane — Undo" toast. Overlay-migrated: state, timer and the
 * Ctrl+Z shortcut live here (main webview); the card itself renders in the
 * overlay webview above the native panes (kind "toast", ambient/flat).
 */
export default function UndoCloseToast() {
  const lastClosed = useUndoCloseStore((s) => s.lastClosed);
  const clear = useUndoCloseStore((s) => s.clear);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!lastClosed) {
      setVisible(false);
      return;
    }

    setVisible(true);
    const timer = setTimeout(() => {
      setVisible(false);
      clear();
    }, TOAST_DURATION_MS);

    return () => clearTimeout(timer);
  }, [lastClosed, clear]);

  // Ctrl+Z undo shortcut
  useEffect(() => {
    if (!visible || !lastClosed) return;
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "z") {
        e.preventDefault();
        undoClose();
        setVisible(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [visible, lastClosed]);

  const active = visible && !!lastClosed;

  const label = !lastClosed
    ? ""
    : lastClosed.type === "tab"
      ? `Closed tab "${lastClosed.tab.name}"`
      : "Closed pane";

  useOverlayToast({
    id: "undo-close-toast",
    open: active,
    payload: active
      ? {
          placement: "bottom-center",
          variant: "surface",
          title: label,
          button: { label: "Undo", action: "undo" },
          shortcutHint: "Ctrl+Z",
        }
      : null,
    onAction: (action) => {
      if (action === "undo") {
        undoClose();
        setVisible(false);
      }
    },
  });

  return null;
}
