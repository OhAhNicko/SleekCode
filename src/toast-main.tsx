import React from "react";
import ReactDOM from "react-dom/client";
import { ToastRoot } from "./toast/ToastRoot";

// Entry point for the THIRD webview: the custom OS notification popup — a
// tiny opaque always-on-top window at the work-area corner, visible while the
// main window is minimized or unfocused. Like the overlay, it must NOT run
// main.tsx's import-time side effects; it is a dumb renderer for the shared
// notification card visual, driven entirely by events from the main webview.

// Never the WebView2 default context menu on a notification card.
document.addEventListener("contextmenu", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("toast-root")!).render(
  <React.StrictMode>
    <ToastRoot />
  </React.StrictMode>,
);
