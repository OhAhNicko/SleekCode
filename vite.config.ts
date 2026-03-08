import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/**
 * Vite plugin: preview proxy for BrowserPreview console capture.
 * Proxies fetch requests through the dev server to bypass CORS restrictions
 * when loading cross-port localhost pages for srcdoc injection.
 */
function previewProxy(): Plugin {
  return {
    name: "ezydev-preview-proxy",
    configureServer(server) {
      server.middlewares.use("/__ezy_proxy__", async (req, res) => {
        const parsed = new URL(req.url || "/", "http://localhost");
        const target = parsed.searchParams.get("url");
        if (!target) {
          res.statusCode = 400;
          res.end("Missing url parameter");
          return;
        }
        try {
          const upstream = await fetch(target);
          const ct = upstream.headers.get("content-type") || "text/html";
          res.setHeader("Content-Type", ct);
          res.setHeader("Access-Control-Allow-Origin", "*");
          const buf = Buffer.from(await upstream.arrayBuffer());
          res.end(buf);
        } catch (err) {
          res.statusCode = 502;
          res.end(String(err));
        }
      });
    },
  };
}

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), previewProxy()],
  clearScreen: false,
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
