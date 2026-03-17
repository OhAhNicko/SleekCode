import { useEffect, useState } from "react";
import { useUndoClearStore, undoClearComposer } from "../store/undoClearStore";

const TOAST_DURATION_MS = 5000;

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

  if (!visible || !clearedText) return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 16,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 150,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 12px",
        borderRadius: 8,
        backgroundColor: "var(--ezy-surface-raised)",
        border: "1px solid var(--ezy-border)",
        boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
      }}
    >
      <span
        className="text-xs truncate"
        style={{ color: "var(--ezy-text-secondary)", maxWidth: 260 }}
      >
        Cleared composer
      </span>
      <button
        onClick={() => {
          undoClearComposer();
          setVisible(false);
        }}
        className="text-xs px-2.5 py-1 rounded font-medium"
        style={{
          backgroundColor: "var(--ezy-accent)",
          color: "#fff",
          border: "none",
          cursor: "pointer",
          flexShrink: 0,
          whiteSpace: "nowrap",
        }}
      >
        Undo
      </button>
      <span
        className="text-[10px]"
        style={{ color: "var(--ezy-text-muted)", flexShrink: 0 }}
      >
        Ctrl+Z
      </span>
    </div>
  );
}
