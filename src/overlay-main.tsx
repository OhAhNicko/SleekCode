import React from "react";
import ReactDOM from "react-dom/client";
import { OverlayRoot } from "./overlay/OverlayRoot";

// Entry point for the SECOND webview (the transparent, always-above overlay).
//
// IMPORTANT: this must NOT run `main.tsx`'s import-time side effects
// (migrateEzyDevToMade(), NativeTerminalSpikeMount, the full 19-slice Zustand
// store). The overlay is a minimal, dumb renderer for floating popups — keep
// this tree tiny and isolated. That is the whole reason it has its own HTML
// entry (overlay.html) instead of reusing index.html.

// The overlay must NEVER show WebView2's default context menu (Back/Reload/
// Save as/Print/Inspect) — right-clicking any popup surface (search bar,
// toasts) reached it because only the backdrop divs preventDefault'ed.
document.addEventListener("contextmenu", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("overlay-root") as HTMLElement).render(
  <React.StrictMode>
    <OverlayRoot />
  </React.StrictMode>,
);
