import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getPtyWrite } from "../store/terminalSlice";
import { useAppStore } from "../store";
import { toWslPath } from "../lib/terminal-config";

/**
 * Global hook: listens for Tauri file-drop events.
 * When files are dropped onto a terminal pane or EzyComposer,
 * inserts the file path(s) into the appropriate target.
 */
export function useFileDrop() {
  useEffect(() => {
    // Prevent the browser/webview default file-drop behavior (which also
    // inserts the path or navigates to the file). Without this, the path
    // gets inserted twice — once by the native webview and once by our handler.
    const preventDefault = (e: DragEvent) => e.preventDefault();
    document.addEventListener("dragover", preventDefault);
    document.addEventListener("drop", preventDefault);

    let unlisten: (() => void) | null = null;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;

        const { paths, position } = event.payload;
        if (!paths.length) return;

        // Convert physical pixels → logical pixels for elementFromPoint
        const dpr = window.devicePixelRatio || 1;
        const x = position.x / dpr;
        const y = position.y / dpr;

        const el = document.elementFromPoint(x, y);
        if (!el) return;

        // Walk up to find terminal pane
        const pane = (el as HTMLElement).closest("[data-terminal-id]");
        if (!pane) return;

        const terminalId = pane.getAttribute("data-terminal-id");
        if (!terminalId) return;

        // Resolve paths for current backend
        const backend = useAppStore.getState().terminalBackend ?? "wsl";
        const resolved = paths.map((p) =>
          backend === "windows" ? p : toWslPath(p)
        );
        const pathText = resolved.join(" ");

        // Check if drop landed on the EzyComposer
        const composer = (el as HTMLElement).closest("[data-composer]");
        if (composer) {
          // Dispatch custom event for PromptComposer to pick up
          composer.dispatchEvent(
            new CustomEvent("ezydev:file-drop", {
              detail: { paths: resolved },
              bubbles: false,
            })
          );
          return;
        }

        // Otherwise write directly to PTY
        const writeFn = getPtyWrite(terminalId);
        if (writeFn) {
          writeFn(pathText);
        }
      })
      .then((fn) => {
        unlisten = fn;
      });

    return () => {
      unlisten?.();
      document.removeEventListener("dragover", preventDefault);
      document.removeEventListener("drop", preventDefault);
    };
  }, []);
}
