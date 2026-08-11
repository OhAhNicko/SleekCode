import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { migrateEzyDevToMade } from "./lib/migrate-ezydev-to-made";
import { pruneArchivedJiraPanes } from "./lib/jira-project";
import { prefetchHomeDir } from "./lib/jira-virtual-dir";
import { ensureFreshBrowserSession } from "./browser-view/bridge";
import { ensureFreshSession as ensureFreshNativeTermSession } from "./lib/native-term-bridge";
import { useAppStore } from "./store";
import AppErrorBoundary, {
  installGlobalErrorLogging,
} from "./components/AppErrorBoundary";

installGlobalErrorLogging();
migrateEzyDevToMade();
// Before the first render, so no pane can mount and `claude --resume` an
// archived ticket from stale persisted layout state.
pruneArchivedJiraPanes();
// Keyed Jira projects have a virtual workingDir; panes there spawn in the
// projects dir or home. Home must be known SYNCHRONOUSLY at spawn time, so
// warm the cache now.
prefetchHomeDir();

// Reap native child windows orphaned by a PREVIOUS page load (dev/HMR full
// reload or Ctrl+R while a pane or browser preview existed). The reap used to
// run only inside the NEXT surface create — so a reload after which no new
// surface was created left the orphan HWND painting over everything at stale
// bounds indefinitely (the "browser stuck on top" bug: DOM can never cover a
// child HWND, and with its page gone nothing would ever destroy it). Both
// reaps share the create path's window-memoised promise, so a later create
// still AWAITS this same reap — the boot call cannot race a create and the
// reap still cannot touch this page's own surfaces.
void ensureFreshBrowserSession();
void ensureFreshNativeTermSession();

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
