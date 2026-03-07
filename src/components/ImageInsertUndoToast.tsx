import { useEffect, useState } from "react";
import { useClipboardImageStore } from "../store/clipboardImageStore";
import { undoLastInsertion } from "../lib/clipboard-insert";

const TOAST_DURATION_MS = 5000;

/** Floating toast at bottom-center that allows undoing the last image path insertion. */
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

  if (!visible || !lastInsertion) return null;

  const fileName = lastInsertion.text.split(/[\\/]/).pop() ?? lastInsertion.text;

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
        title={lastInsertion.text}
      >
        Inserted {fileName}
      </span>
      <button
        onClick={() => {
          undoLastInsertion();
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
