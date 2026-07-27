import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { migrateEzyDevToMade } from "./lib/migrate-ezydev-to-made";
import { useAppStore } from "./store";
import AppErrorBoundary, {
  installGlobalErrorLogging,
} from "./components/AppErrorBoundary";

installGlobalErrorLogging();
migrateEzyDevToMade();

// Expose the store on window for DevTools-driven feature-flag toggling
// (e.g. native terminal renderer) while no Settings UI exists yet.
(window as unknown as { useAppStore: typeof useAppStore }).useAppStore = useAppStore;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* Outside <App/> deliberately: a render error anywhere inside, including in
        the chrome itself, must still leave something on screen. Without this the
        whole window went blank while the native panes kept painting. */}
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);
