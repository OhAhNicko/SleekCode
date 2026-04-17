import { useState, useMemo, useEffect, useRef } from "react";

const PERSIST_KEY = "ezydev-storage";

interface Category {
  id: string;
  label: string;
  description: string;
  stateKeys: string[];
  rawKeys?: string[];
  rawPrefixes?: string[];
}

const CATEGORIES: Category[] = [
  {
    id: "workspace",
    label: "Workspace & projects",
    description: "Open tabs, recent projects, session layouts, expanded folders, project colors.",
    stateKeys: [
      "tabs",
      "activeTabId",
      "recentProjects",
      "lastActiveProjectPath",
      "projectSessions",
      "expandedDirs",
      "previewInProjectTab",
      "sidebarOpen",
      "sidebarTab",
      "projectColors",
    ],
  },
  {
    id: "preferences",
    label: "Preferences & theme",
    description: "Theme, toggles, CLI font sizes, YOLO mode, statusline, composer, default paths, onboarding.",
    stateKeys: [
      "themeId",
      "vibrantColors",
      "alwaysShowTemplatePicker",
      "restoreLastSession",
      "autoInsertClipboardImage",
      "cliFontSizes",
      "cliYolo",
      "promptComposerEnabled",
      "promptComposerAlwaysVisible",
      "composerExpansion",
      "autoStartServerCommand",
      "browserFullColumn",
      "browserSpawnLeft",
      "copyOnSelect",
      "confirmQuit",
      "codeReviewCollapseAll",
      "showTabPath",
      "openPanesInBackground",
      "wideGridLayout",
      "autoMinimizeGameOnAiDone",
      "terminalBackend",
      "commitMsgMode",
      "shadowAiCli",
      "statuslineToggles",
      "onboardingCompleted",
      "projectsDir",
      "defaultClaudeMdPath",
      "defaultAgentsMdPath",
    ],
    rawKeys: ["ezydev-devtools-pinned"],
  },
  {
    id: "history",
    label: "Prompt & command history",
    description: "Composer prompt history (per-pane and global) and terminal command history.",
    stateKeys: ["panePromptHistory", "globalPromptHistory", "commandHistory"],
  },
  {
    id: "aitime",
    label: "AI time statistics",
    description: "Tracked AI working-time bursts across all projects.",
    stateKeys: ["aiTimeBursts"],
  },
  {
    id: "games",
    label: "Games & highscores",
    description: "Highscores, timed leaderboards, game stats, crossword progress.",
    stateKeys: ["highscores", "timedHighscores", "gameStats", "completedCrosswordIds", "customCrosswords"],
    rawPrefixes: ["ezydev-wordle-"],
  },
  {
    id: "configs",
    label: "Snippets, servers & tasks",
    description: "Saved snippets, launch configs, custom server commands, remote servers, kanban tasks.",
    stateKeys: ["snippets", "launchConfigs", "customServerCommands", "servers", "tasks"],
  },
  {
    id: "clicache",
    label: "CLI detection cache",
    description: "Cached Claude/Codex/Gemini binary paths. Safe to clear \u2014 will re-detect on next use.",
    stateKeys: [],
    rawKeys: [
      "ezydev-wsl-cli-cache",
      "ezydev-windows-cli-cache",
      "ezydev-native-cli-cache",
    ],
  },
];

function wipeSelected(ids: Set<string>) {
  const selected = CATEGORIES.filter((c) => ids.has(c.id));

  // 1. Rewrite the Zustand persist blob by removing the listed state keys.
  const stateKeysToDrop = new Set<string>();
  for (const cat of selected) for (const k of cat.stateKeys) stateKeysToDrop.add(k);

  if (stateKeysToDrop.size > 0) {
    try {
      const raw = localStorage.getItem(PERSIST_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { state?: Record<string, unknown>; version?: number };
        if (parsed && parsed.state && typeof parsed.state === "object") {
          for (const k of stateKeysToDrop) {
            delete parsed.state[k];
          }
          localStorage.setItem(PERSIST_KEY, JSON.stringify(parsed));
        }
      }
    } catch {
      // If the blob is corrupted, nuke it so app boots clean.
      localStorage.removeItem(PERSIST_KEY);
    }
  }

  // 2. Raw localStorage keys + prefixes.
  for (const cat of selected) {
    if (cat.rawKeys) {
      for (const k of cat.rawKeys) localStorage.removeItem(k);
    }
    if (cat.rawPrefixes) {
      const all = Object.keys(localStorage);
      for (const k of all) {
        if (cat.rawPrefixes.some((p) => k.startsWith(p))) localStorage.removeItem(k);
      }
    }
  }
}

interface ClearDataModalProps {
  onClose: () => void;
}

export default function ClearDataModal({ onClose }: ClearDataModalProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [wiping, setWiping] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const allSelected = selected.size === CATEGORIES.length;
  const nothing = selected.size === 0;

  const summary = useMemo(() => {
    if (allSelected) return "Everything will be cleared.";
    if (nothing) return "Pick at least one category to continue.";
    return `${selected.size} ${selected.size === 1 ? "category" : "categories"} will be cleared.`;
  }, [allSelected, nothing, selected.size]);

  // Esc closes
  useEffect(() => {
    const container = bodyRef.current;
    if (!container) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !wiping) {
        e.stopPropagation();
        onClose();
      }
    };
    container.addEventListener("keydown", onKey);
    container.focus();
    return () => container.removeEventListener("keydown", onKey);
  }, [onClose, wiping]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) => (prev.size === CATEGORIES.length ? new Set() : new Set(CATEGORIES.map((c) => c.id))));
  };

  const confirm = () => {
    if (nothing || wiping) return;
    setWiping(true);
    try {
      wipeSelected(selected);
    } finally {
      // Reload so the Zustand store rehydrates from the trimmed blob with defaults.
      window.location.reload();
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "10vh",
        zIndex: 300,
      }}
      onClick={() => { if (!wiping) onClose(); }}
    >
      <div
        ref={bodyRef}
        tabIndex={-1}
        style={{
          maxWidth: 520,
          width: "100%",
          maxHeight: "80vh",
          backgroundColor: "var(--ezy-surface-raised)",
          border: "1px solid var(--ezy-border)",
          borderRadius: 10,
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
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ezy-text)" }}>
              Clear local data
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
            style={{ cursor: wiping ? "not-allowed" : "pointer", opacity: wiping ? 0.4 : 1 }}
            onClick={() => { if (!wiping) onClose(); }}
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
            fontSize: 12,
            lineHeight: 1.45,
            flexShrink: 0,
          }}
        >
          This action cannot be undone. The app will reload after clearing.
          Your files on disk are not touched &mdash; only EzyDev's local storage.
        </div>

        {/* Body */}
        <div style={{ padding: "14px 18px 4px", overflowY: "auto", flex: 1 }}>
          {/* Select all */}
          <div
            onClick={toggleAll}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 10px",
              marginBottom: 8,
              borderRadius: 6,
              backgroundColor: allSelected ? "var(--ezy-accent-glow)" : "transparent",
              border: "1px solid var(--ezy-border-subtle)",
              cursor: "pointer",
              userSelect: "none",
              transition: "background-color 120ms ease",
            }}
            onMouseEnter={(e) => { if (!allSelected) e.currentTarget.style.backgroundColor = "var(--ezy-surface)"; }}
            onMouseLeave={(e) => { if (!allSelected) e.currentTarget.style.backgroundColor = "transparent"; }}
          >
            <Checkbox checked={allSelected} />
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ezy-text)" }}>
              {allSelected ? "Deselect all" : "Select all"}
            </span>
          </div>

          {/* Categories */}
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {CATEGORIES.map((cat) => {
              const isOn = selected.has(cat.id);
              return (
                <div
                  key={cat.id}
                  onClick={() => toggle(cat.id)}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 10,
                    padding: "10px",
                    borderRadius: 6,
                    cursor: "pointer",
                    backgroundColor: isOn ? "var(--ezy-accent-glow)" : "transparent",
                    transition: "background-color 120ms ease",
                  }}
                  onMouseEnter={(e) => { if (!isOn) e.currentTarget.style.backgroundColor = "var(--ezy-surface)"; }}
                  onMouseLeave={(e) => { if (!isOn) e.currentTarget.style.backgroundColor = "transparent"; }}
                >
                  <div style={{ marginTop: 1 }}><Checkbox checked={isOn} /></div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13, color: "var(--ezy-text)", fontWeight: 500 }}>{cat.label}</div>
                    <div style={{ fontSize: 11, color: "var(--ezy-text-muted)", marginTop: 2, lineHeight: 1.4 }}>
                      {cat.description}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "12px 18px",
            borderTop: "1px solid var(--ezy-border)",
            backgroundColor: "var(--ezy-surface)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 11, color: "var(--ezy-text-muted)" }}>{summary}</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => { if (!wiping) onClose(); }}
              disabled={wiping}
              style={{
                height: 30,
                padding: "0 14px",
                borderRadius: 6,
                border: "1px solid var(--ezy-border)",
                backgroundColor: "var(--ezy-surface-raised)",
                color: "var(--ezy-text-secondary)",
                fontSize: 12,
                fontWeight: 500,
                fontFamily: "inherit",
                cursor: wiping ? "not-allowed" : "pointer",
              }}
            >
              Cancel
            </button>
            <button
              onClick={confirm}
              disabled={nothing || wiping}
              style={{
                height: 30,
                padding: "0 14px",
                borderRadius: 6,
                border: "none",
                backgroundColor: nothing ? "var(--ezy-surface)" : "var(--ezy-red, #e55)",
                color: nothing ? "var(--ezy-text-muted)" : "#fff",
                fontSize: 12,
                fontWeight: 600,
                fontFamily: "inherit",
                cursor: nothing || wiping ? "not-allowed" : "pointer",
                opacity: wiping ? 0.7 : 1,
                transition: "background-color 120ms ease, opacity 120ms ease",
              }}
            >
              {wiping ? "Clearing..." : allSelected ? "Clear everything" : "Clear selected"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Checkbox({ checked }: { checked: boolean }) {
  return (
    <div
      style={{
        width: 16,
        height: 16,
        borderRadius: 4,
        border: checked ? "none" : "1px solid var(--ezy-border-light)",
        backgroundColor: checked ? "var(--ezy-red, #e55)" : "transparent",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        transition: "background-color 120ms ease",
      }}
    >
      {checked && (
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M1.5 5.2 4 7.5 8.5 2.5" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </div>
  );
}
