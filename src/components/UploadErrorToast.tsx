import { useEffect, useState } from "react";
import { useClipboardImageStore } from "../store/clipboardImageStore";
import { useOverlayToast } from "../lib/useOverlayToast";

const TOAST_DURATION_MS = 6000;

/**
 * Floating toast at bottom-center for failed remote SSH file uploads.
 * Overlay-migrated: state and timer live here (main webview); the solid red
 * card renders in the overlay webview above the native panes (kind "toast").
 */
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

  const active = visible && !!uploadError;

  useOverlayToast({
    id: "upload-error-toast",
    open: active,
    payload: active
      ? {
          placement: "bottom-center",
          variant: "solid",
          bg: "#dc2626",
          title: uploadError!.title,
          detail: uploadError!.detail,
        }
      : null,
  });

  return null;
}
