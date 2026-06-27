import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";

/**
 * Tracks whether the OS window is maximized.
 *
 * Drives the frameless window's gutter/shadow/radius: a maximized window must
 * fill the work area edge-to-edge, so `.window-root` drops its 20px shadow
 * gutter and `.window-frame` drops its radius + box-shadow (see index.css
 * `.is-max`). Mirrors the maximize-tracking already used in the tab bars.
 */
export function useWindowMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const sync = () => {
      win.isMaximized().then((m) => {
        if (!cancelled) setMaximized(m);
      });
    };

    sync();
    win
      .onResized(() => sync())
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return maximized;
}
