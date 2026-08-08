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

  // Ctrl+Z undo shortcut — but never stolen from a surface that owns the
  // chord itself. While this toast is visible, an unguarded window listener
  // made Ctrl+Z in the editor undo text AND resurrect the closed tab in one
  // press, and in a terminal (where Ctrl+Z is the shell's SIGTSTP) it popped
  // tabs back mid-command. The toast only takes the chord from neutral ground.
  useEffect(() => {
    if (!visible || !lastClosed) return;
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.key !== "z") return;
      const t = e.target as HTMLElement | null;
      const owned =
        !!t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable ||
          !!t.closest?.(".xterm"));
      if (owned) return;
      e.preventDefault();
      undoClose();
      setVisible(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [visible, lastClosed]);

  const active = visible && !!lastClosed;

  const label = !lastClosed
    ? ""
    : lastClosed.type === "tab"
      ? `Closed tab "${lastClosed.tab.name}"`
      : lastClosed.type === "tabs"
        ? `Closed ${lastClosed.tabs.length} tabs`
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
