import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { migrateEzyDevToMade } from "./lib/migrate-ezydev-to-made";
import "./components/NativeTerminalSpikeMount";
import { useAppStore } from "./store";

migrateEzyDevToMade();

// Expose the store on window for DevTools-driven feature-flag toggling
// (e.g. native terminal renderer) while no Settings UI exists yet.
(window as unknown as { useAppStore: typeof useAppStore }).useAppStore = useAppStore;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
