import { useEffect, useState } from "react";
import { useOverlayToast } from "../lib/useOverlayToast";

/**
 * Bottom-right toast that surfaces the result of the App.tsx dev-server
 * restore on app boot. Listens for the `made:dev-server-restore` event
 * dispatched once by the restore useEffect. Visible for 12 seconds — long
 * enough to read but not nagging. Lets users diagnose "why didn't my SSH
 * dev server restart?" without opening DevTools.
 *
 * Overlay-migrated: state lives here (main webview); the solid status card
 * renders in the overlay webview above the native panes (kind "toast").
 */

type Status = "ok" | "skipped" | "error" | "info";

interface RestoreToast {
  status: Status;
  title: string;
  detail?: string;
}

export default function DevServerRestoreToast() {
  const [toast, setToast] = useState<RestoreToast | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<RestoreToast>).detail;
      if (!detail) return;
      setToast(detail);
      const timer = setTimeout(() => setToast(null), 12_000);
      return () => clearTimeout(timer);
    };
    window.addEventListener("made:dev-server-restore", handler as EventListener);
    return () => window.removeEventListener("made:dev-server-restore", handler as EventListener);
  }, []);

  // CLAUDE.md compliance: solid opaque backgrounds, no tinted/translucent
  // badges, no amber/yellow/blue, no animate-pulse.
  const bg =
    toast?.status === "ok"
      ? "#10a37f"
      : toast?.status === "error"
      ? "#dc2626"
      : toast?.status === "skipped"
      ? "#525252"
      : "#404040";

  useOverlayToast({
    id: "dev-server-restore-toast",
    open: !!toast,
    payload: toast
      ? {
          placement: "bottom-right",
          variant: "solid",
          bg,
          title: toast.title,
          detail: toast.detail,
          dismissable: true,
        }
      : null,
    onAction: (action) => {
      if (action === "dismiss") setToast(null);
    },
  });

  return null;
}
