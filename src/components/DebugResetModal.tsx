import { useEffect, useRef, useState } from "react";
import LoadingDots from "./LoadingDots";
import { useModal } from "../store/modalCoordinationSlice";
import { useAppStore } from "../store";
import { MODAL_BACKDROP, MODAL_MAX_HEIGHT } from "../lib/modal-layout";

const PERSIST_KEY = "made-storage";

/**
 * The slice of the persist blob that survives a debug reset — the projects
 * themselves plus exactly what a reopened project needs to function:
 * `servers` because remote projects reference RemoteServer.id, and the Jira
 * site list + API credentials because a Jira project without them reopens
 * into an auth error instead of its ticket rail.
 */
const PRESERVED_STATE_KEYS = [
  "recentProjects",
  "servers",
  "jiraSites",
  "jiraDefaultSiteId",
  "jiraApiEmail",
  "jiraApiToken",
  "jiraMyAccountId",
  "jiraSiteAccounts",
] as const;

/**
 * Reset to a fresh install, keeping only the preserved project keys.
 * `backendAutoDetected: false` is explicit because the hydration merge
 * defaults it true whenever any persisted blob exists — a fresh-install
 * simulation must re-run the first-boot backend detection.
 *
 * Reload (not relaunch) on purpose: the process survives, so WebView2 gets to
 * flush its LevelDB — a localStorage write immediately before relaunch()
 * never reaches disk.
 *
 * NEVER `localStorage.clear()` here. WebView2 commits localStorage mutations
 * to its LevelDB on a delay, and the dev workflow hard-kills the process all
 * the time (tauri:dev restarts, Ctrl+C). A kill inside that window once
 * persisted the clear while dropping the follow-up setItem — the preserved
 * projects were destroyed on disk (2026-08-11). A single-key OVERWRITE of the
 * persist blob cannot half-survive: whatever the kill timing, made-storage
 * holds either the old state or the new one, and both carry the projects.
 */
function debugResetKeepingProjects(): void {
  if (!import.meta.env.DEV) return;

  // Capture currently open pane layouts onto their recentProjects entries
  // first — the close-time flush hasn't run yet, and the whole point of the
  // reset is that projects reopen with the panes they had right now.
  const store = useAppStore.getState();
  store.flushTabLayoutsToRecent(store.tabs);

  const preserved: Record<string, unknown> = {};
  let version = 0;
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { state?: Record<string, unknown>; version?: number };
      if (typeof parsed?.version === "number") version = parsed.version;
      const state = parsed?.state;
      if (state && typeof state === "object") {
        for (const k of PRESERVED_STATE_KEYS) {
          if (k in state) preserved[k] = state[k];
        }
      }
    }
  } catch {
    // Corrupted blob — nothing worth preserving; still reset clean below.
  }

  for (const key of Object.keys(localStorage)) {
    if (key !== PERSIST_KEY) localStorage.removeItem(key);
  }
  localStorage.setItem(
    PERSIST_KEY,
    JSON.stringify({ state: { ...preserved, backendAutoDetected: false }, version }),
  );
  window.location.reload();
}

const KEPT = [
  "Projects in the + menu — local, remote and Jira — with their saved pane layouts and templates",
  "Remote server entries those projects point at",
  "Jira sites and API credentials, so Jira projects still load tickets",
];

const CLEARED = [
  "Every setting, theme and toggle",
  "Open tabs, history, statistics, games and caches",
  "First-run state — the terminal backend re-detects on next launch",
];

interface DebugResetModalProps {
  onClose: () => void;
}

export default function DebugResetModal({ onClose }: DebugResetModalProps) {
  useModal("debug-reset");
  const bodyRef = useRef<HTMLDivElement>(null);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    const container = bodyRef.current;
    if (!container) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !resetting) {
        e.stopPropagation();
        onClose();
      }
    };
    container.addEventListener("keydown", onKey);
    container.focus();
    return () => container.removeEventListener("keydown", onKey);
  }, [onClose, resetting]);

  const confirm = () => {
    if (resetting) return;
    setResetting(true);
    debugResetKeepingProjects();
  };

  return (
    <div
      style={{
        ...MODAL_BACKDROP,
        backgroundColor: "rgba(0,0,0,0.6)",
        zIndex: 300,
      }}
      onClick={() => { if (!resetting) onClose(); }}
    >
      <div
        ref={bodyRef}
        tabIndex={-1}
        style={{
          maxWidth: 520,
          width: "100%",
          maxHeight: MODAL_MAX_HEIGHT,
          backgroundColor: "var(--ezy-surface-raised)",
          border: "1px solid var(--ezy-border)",
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 10px)",
          overflow: "hidden",
          boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
          display: "flex",
          flexDirection: "column",
          outline: "none",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            height: 40,
            padding: "0 16px",
            borderBottom: "1px solid var(--ezy-border)",
            backgroundColor: "var(--ezy-surface)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M8 1.5 14.5 13.5h-13L8 1.5Z"
                stroke="var(--ezy-red, #e55)"
                strokeWidth="1.3"
                strokeLinejoin="round"
                fill="none"
              />
              <path d="M8 6v3.5" stroke="var(--ezy-red, #e55)" strokeWidth="1.3" strokeLinecap="round" />
              <circle cx="8" cy="11.5" r="0.7" fill="var(--ezy-red, #e55)" />
            </svg>
            <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 13px)", fontWeight: 600, color: "var(--ezy-text)" }}>
              Reset all (debug build)
            </span>
          </div>
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="var(--ezy-text-muted)"
            strokeWidth="1.5"
            strokeLinecap="round"
            style={{ cursor: resetting ? "not-allowed" : "pointer", opacity: resetting ? 0.4 : 1 }}
            onClick={() => { if (!resetting) onClose(); }}
          >
            <path d="M4 4 12 12M12 4 4 12" />
          </svg>
        </div>

        {/* Warning banner */}
        <div
          style={{
            padding: "12px 18px",
            backgroundColor: "var(--ezy-red, #e55)",
            color: "#fff",
            fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
            lineHeight: 1.45,
            flexShrink: 0,
          }}
        >
          Simulates a fresh install and reloads the app. This cannot be undone.
          Your files on disk are not touched.
        </div>

        {/* Body */}
        <div style={{ padding: "14px 18px", overflowY: "auto", flex: 1 }}>
          <ResetList title="Cleared" items={CLEARED} />
          <div style={{ height: 12 }} />
          <ResetList title="Kept" items={KEPT} />
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "12px 18px",
            borderTop: "1px solid var(--ezy-border)",
            backgroundColor: "var(--ezy-surface)",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 8,
            flexShrink: 0,
          }}
        >
          <button
            onClick={() => { if (!resetting) onClose(); }}
            disabled={resetting}
            style={{
              height: 30,
              padding: "0 14px",
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
              border: "1px solid var(--ezy-border)",
              backgroundColor: "var(--ezy-surface-raised)",
              color: "var(--ezy-text-secondary)",
              fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
              fontWeight: 500,
              fontFamily: "inherit",
              cursor: resetting ? "not-allowed" : "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={confirm}
            disabled={resetting}
            style={{
              height: 30,
              padding: "0 14px",
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
              border: "none",
              backgroundColor: "var(--ezy-red, #e55)",
              color: "#fff",
              fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
              fontWeight: 600,
              fontFamily: "inherit",
              cursor: resetting ? "not-allowed" : "pointer",
              opacity: resetting ? 0.7 : 1,
              transition: "opacity 120ms ease",
            }}
          >
            {resetting ? <LoadingDots>Resetting</LoadingDots> : "Reset and reload"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ResetList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <div
        style={{
          fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
          fontWeight: 600,
          color: "var(--ezy-text)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {items.map((item) => (
          <div
            key={item}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
              color: "var(--ezy-text-secondary)",
              lineHeight: 1.45,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 4,
                height: 4,
                borderRadius: "50%",
                backgroundColor: "var(--ezy-text-muted)",
                flexShrink: 0,
                marginTop: 7,
              }}
            />
            <span style={{ minWidth: 0 }}>{item}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
