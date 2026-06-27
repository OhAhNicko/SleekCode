import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { migrateEzyDevToMade } from "./lib/migrate-ezydev-to-made";
import "./components/NativeTerminalSpikeMount";
import { useAppStore } from "./store";
import { getCurrentWindow } from "@tauri-apps/api/window";

migrateEzyDevToMade();

// Expose the store on window for DevTools-driven feature-flag toggling
// (e.g. native terminal renderer) while no Settings UI exists yet.
(window as unknown as { useAppStore: typeof useAppStore }).useAppStore = useAppStore;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// The window starts hidden (`visible:false` in tauri.conf.json) so the user
// never sees the transparent, un-painted window during startup. Reveal it once
// the first frame has painted. requestAnimationFrame fires after layout/paint
// and runs independently of React, so the window still appears even if a later
// effect is slow.
requestAnimationFrame(() => {
  getCurrentWindow().show().catch(() => {});
});
