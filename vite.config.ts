import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Note: the browser-pane preview proxy used to live here as a Vite plugin.
// It now lives in the Rust backend (src-tauri/src/preview_proxy.rs) so it
// works in both `tauri:dev` and packaged production builds.

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  // Multi-page build: the main app (index.html → main.tsx) plus the transparent
  // overlay webview (overlay.html → overlay-main.tsx). The overlay has its own
  // entry so it never runs main.tsx's import-time side effects.
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        overlay: fileURLToPath(new URL("./overlay.html", import.meta.url)),
      },
    },
  },
  server: {
    port: 5420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 5421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
