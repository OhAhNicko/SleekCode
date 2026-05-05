import { useEffect, useState } from "react";
import { useClipboardImageStore } from "../store/clipboardImageStore";

const TOAST_DURATION_MS = 6000;

/** Floating toast at bottom-center for failed remote SSH file uploads. */
export default function UploadErrorToast() {
  const uploadError = useClipboardImageStore((s) => s.uploadError);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!uploadError) {
      setVisible(false);
      return;
    }

    setVisible(true);
    const timer = setTimeout(() => {
      setVisible(false);
      useClipboardImageStore.getState().setUploadError(null);
    }, TOAST_DURATION_MS);

    return () => clearTimeout(timer);
  }, [uploadError]);

  if (!visible || !uploadError) return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 16,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 150,
        display: "flex",
        flexDirection: "column",
        gap: 2,
        padding: "8px 12px",
        borderRadius: 8,
        backgroundColor: "#dc2626",
        color: "#fff",
        boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
        maxWidth: 420,
      }}
    >
      <span className="text-xs font-medium">{uploadError.title}</span>
      <span className="text-[11px]" style={{ opacity: 0.9, wordBreak: "break-word" }}>
        {uploadError.detail}
      </span>
    </div>
  );
}
