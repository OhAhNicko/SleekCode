import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { migrateEzyDevToMade } from "./lib/migrate-ezydev-to-made";
import "./components/NativeTerminalSpikeMount";

migrateEzyDevToMade();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
