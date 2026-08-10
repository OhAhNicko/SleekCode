import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "../store";
import { useModalWhen } from "../store/modalCoordinationSlice";
import { FaCheck } from "react-icons/fa";

/**
 * App-level quit confirmation.
 *
 * Mounted unconditionally in App.tsx so it works with EITHER tab bar. While it
 * lived inside TabBar, vertical mode had no listener for `made:quit-requested`
 * at all: Alt+F4 and the taskbar X silently did nothing, and the vertical
 * strip's own X was worse than useless — it confirmed via `window.confirm` and
 * then called `close()`, which re-entered App's `onCloseRequested`, which
 * preventDefault()ed again. With "Confirm before quitting" on, the app could
 * not be quit from the vertical bar at all.
 *
 * Every quit path now funnels through `getCurrentWindow().close()`: App's
 * onCloseRequested flushes layouts, then either lets the close proceed
 * (confirmQuit off) or preventDefaults and dispatches `made:quit-requested`,
 * which this component answers. The Quit button uses `destroy()`, which skips
 * onCloseRequested — that is what breaks the interception loop.
 */
export default function QuitConfirmModal() {
  const setConfirmQuit = useAppStore((s) => s.setConfirmQuit);
  const [show, setShow] = useState(false);
  const [dontShow, setDontShow] = useState(false);
  // Not optional: a fullscreen modal that does not register renders BEHIND the
  // native GPU panes.
  useModalWhen("quit-confirm", show);

  useEffect(() => {
    const handler = () => {
      setDontShow(false);
      setShow(true);
    };
    window.addEventListener("made:quit-requested", handler);
    return () => window.removeEventListener("made:quit-requested", handler);
  }, []);

  if (!show) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "rgba(0,0,0,0.55)",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) setShow(false); }}
    >
      <div
        style={{
          backgroundColor: "var(--ezy-surface-raised)",
          border: "1px solid var(--ezy-border)",
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 10px)",
          boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
          padding: "24px 28px 20px",
          width: 320,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 15px)", fontWeight: 600, color: "var(--ezy-text)" }}>
          Quit MADE?
        </div>
        <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 13px)", color: "var(--ezy-text-secondary)", lineHeight: 1.5 }}>
          All running terminals will be closed.
        </div>
        {/* Don't show again */}
        <div
          style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginTop: 2 }}
          onClick={() => setDontShow((v) => !v)}
        >
          <div
            style={{
              width: 15,
              height: 15,
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
              border: dontShow ? "none" : "1px solid var(--ezy-border-light)",
              backgroundColor: dontShow ? "var(--ezy-accent)" : "transparent",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              transition: "background-color 120ms ease",
            }}
          >
            {dontShow && <FaCheck size={9} color="#fff" />}
          </div>
          <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-text-muted)" }}>Do not show again</span>
        </div>
        {/* Buttons */}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
          <div
            onClick={() => setShow(false)}
            style={{
              padding: "6px 16px",
              fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
              fontWeight: 500,
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
              cursor: "pointer",
              border: "1px solid var(--ezy-border-light)",
              color: "var(--ezy-text-secondary)",
              backgroundColor: "transparent",
              transition: "background-color 120ms ease",
            }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
          >
            Cancel
          </div>
          <div
            onClick={() => {
              if (dontShow) setConfirmQuit(false);
              setShow(false);
              // destroy(), not close(): close() re-enters onCloseRequested and
              // would just reopen this dialog forever.
              getCurrentWindow().destroy();
            }}
            style={{
              padding: "6px 16px",
              fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
              fontWeight: 500,
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
              cursor: "pointer",
              border: "none",
              color: "#fff",
              backgroundColor: "#c42b1c",
              transition: "background-color 120ms ease",
            }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "#a82318"}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "#c42b1c"}
          >
            Quit
          </div>
        </div>
      </div>
    </div>
  );
}
