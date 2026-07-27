// Root error boundary + global failure logging.
//
// WHY: MADE had NO error boundary and NO global error handler. An uncaught render
// error therefore unmounted the entire tree, and because every piece of chrome
// (tab bar, sidebar, pane headers, window buttons) is React, the window went
// blank — while the native terminal panes, being child HWNDs drawing via wgpu,
// kept rendering as if nothing happened. That is the "everything crashed except
// the native panes" report of 2026-07-27, and it left NO record of the cause.
//
// This does two things:
//   1. Keeps the process alive and SHOWS the failure, with the stack, so a
//      production incident can be screenshotted instead of guessed at.
//   2. Records uncaught errors and unhandled rejections to the console with a
//      stable prefix, so they are greppable in a dev-server log.
//
// It cannot catch everything. A crash of the WebView2 renderer process itself
// takes the whole DOM with it, boundary included — and that is distinguishable:
// this screen appearing means REACT failed; the window going blank with the
// native panes still painting means the WEBVIEW died, which is a different bug
// (see the shared-GPU note in docs/architecture.md).

import { Component, type ErrorInfo, type ReactNode } from "react";
import { setModalsOpen } from "../native-term/visibility";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Stable prefix so this is greppable in the terminal running tauri:dev.
    console.error("[made:crash] render error", error, info.componentStack);
    this.setState({ info });
    // Native panes are child HWNDs and paint OVER the DOM, so without this the
    // error screen would be hidden behind whatever panes are open. This is the
    // same owner the fullscreen modals use.
    try {
      setModalsOpen(true);
    } catch {
      /* never let the recovery path throw */
    }
  }

  private reload = () => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 99999,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 32,
          backgroundColor: "var(--ezy-bg, #0d1117)",
          color: "var(--ezy-text, #e6edf3)",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        }}
      >
        <div style={{ maxWidth: 720, width: "100%" }}>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>
            MADE hit an error and stopped drawing
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--ezy-text-muted, #8b949e)",
              lineHeight: 1.5,
              marginBottom: 16,
            }}
          >
            Your terminals are still running — this is the interface, not the
            processes. Reloading rebuilds the window and reattaches them.
          </div>

          <div
            style={{
              fontSize: 12,
              color: "var(--ezy-red, #f85149)",
              marginBottom: 10,
              wordBreak: "break-word",
            }}
          >
            {String(error.message || error)}
          </div>

          <pre
            style={{
              margin: 0,
              padding: 12,
              maxHeight: 260,
              overflow: "auto",
              fontSize: 11,
              lineHeight: 1.45,
              color: "var(--ezy-text-secondary, #c9d1d9)",
              backgroundColor: "var(--ezy-surface, #161b22)",
              border: "1px solid var(--ezy-border, #30363d)",
              borderRadius: 6,
              whiteSpace: "pre-wrap",
            }}
          >
            {(error.stack || "") + (info?.componentStack || "")}
          </pre>

          <div
            role="button"
            tabIndex={0}
            onClick={this.reload}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") this.reload();
            }}
            style={{
              display: "inline-block",
              marginTop: 16,
              padding: "6px 14px",
              borderRadius: 5,
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
              backgroundColor: "var(--ezy-accent, #3fb950)",
              color: "#000",
              outline: "none",
            }}
          >
            Reload MADE
          </div>
        </div>
      </div>
    );
  }
}

/** Log uncaught errors and rejections. Installed once from main.tsx.
 *
 *  A render error reaches the boundary above; these two never would, and they
 *  are the ones that previously vanished without trace. */
export function installGlobalErrorLogging(): void {
  window.addEventListener("error", (e) => {
    console.error(
      `[made:crash] uncaught ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`,
      e.error,
    );
  });
  window.addEventListener("unhandledrejection", (e) => {
    console.error("[made:crash] unhandled rejection", e.reason);
  });
}
