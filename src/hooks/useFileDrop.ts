import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getPtyWrite } from "../store/terminalSlice";
import { useAppStore } from "../store";
import { useClipboardImageStore } from "../store/clipboardImageStore";
import { toWslPath } from "../lib/terminal-config";
import { buildRemotePath } from "../lib/clipboard-insert";

/**
 * Resolve a list of dropped local paths into the strings that should be
 * inserted into the terminal. For remote SSH terminals, each file is
 * uploaded to /tmp/ezydev/ on the remote and the remote path is returned.
 * Failed uploads (e.g. file too large) are skipped and surface a toast.
 */
async function resolveDroppedPaths(
  paths: string[],
  terminalId: string
): Promise<string[]> {
  const state = useAppStore.getState();
  const terminal = state.terminals[terminalId];

  if (terminal?.serverId) {
    const server = state.servers.find((s) => s.id === terminal.serverId);
    if (!server) {
      useClipboardImageStore.getState().setUploadError({
        title: "Upload failed",
        detail: `Remote server ${terminal.serverId} not found`,
        timestamp: Date.now(),
      });
      return [];
    }

    const resolved: string[] = [];
    for (const localPath of paths) {
      const remotePath = buildRemotePath(localPath, "drop");
      try {
        const uploaded = await invoke<string>("ssh_upload_file_bytes", {
          host: server.host,
          username: server.username,
          localPath,
          remotePath,
          identityFile: server.sshKeyPath,
        });
        resolved.push(uploaded);
      } catch (e) {
        useClipboardImageStore.getState().setUploadError({
          title: `Upload to ${server.name} failed`,
          detail: `${localPath.split(/[\\/]/).pop() ?? localPath}: ${e}`,
          timestamp: Date.now(),
        });
      }
    }
    return resolved;
  }

  const backend = state.terminalBackend ?? "wsl";
  return paths.map((p) => (backend === "windows" ? p : toWslPath(p)));
}

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
      .onDragDropEvent(async (event) => {
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

        // Resolve paths — uploads to remote when terminal is bound to an SSH
        // server, falls back to local Windows/WSL conversion otherwise.
        const resolved = await resolveDroppedPaths(paths, terminalId);
        if (!resolved.length) return;

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
