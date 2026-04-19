import { useState, useMemo, useCallback, useEffect } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../store";
import type { AiTimeBurst } from "../store/aiTimeSlice";
import { THEMES, getTheme } from "../lib/themes";
import { TERMINAL_CONFIGS } from "../lib/terminal-config";
import { isWindows } from "../lib/platform";
import { currentIsoWeek } from "../lib/iso-week";
import { DEFAULT_CLI_FONT_SIZE } from "../store/recentProjectsSlice";
import { FaCheck } from "react-icons/fa";
import { STATUSLINE_FEATURES } from "./TerminalHeader";
import ClearDataModal from "./ClearDataModal";
import type { TerminalType, ComposerExpansion } from "../types";

// ─── Internal sub-components ───────────────────────────────────────────────

function ToggleSwitch({ checked, onChange, color }: { checked: boolean; onChange: (v: boolean) => void; color?: string }) {
  const bg = checked ? (color ?? "var(--ezy-accent)") : "transparent";
  return (
    <div
      onClick={() => onChange(!checked)}
      style={{
        width: 36,
        height: 20,
        borderRadius: 10,
        backgroundColor: bg,
        border: checked ? "none" : "1px solid var(--ezy-border-light)",
        position: "relative",
        transition: "background-color 150ms ease",
        flexShrink: 0,
        cursor: "pointer",
      }}
    >
      <div
        style={{
          width: 16,
          height: 16,
          borderRadius: "50%",
          backgroundColor: checked ? "#fff" : "var(--ezy-text-muted)",
          position: "absolute",
          top: 2,
          left: checked ? 18 : 2,
          transition: "left 150ms ease",
        }}
      />
    </div>
  );
}

function SegmentedControl<T extends string>({ options, value, onChange, disabled }: {
  options: { value: T; label: string; disabled?: boolean }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ display: "flex", borderRadius: 6, border: "1px solid var(--ezy-border)", overflow: "hidden", minWidth: 180 }}>
      {options.map((opt) => {
        const isActive = value === opt.value;
        const isOff = disabled || opt.disabled;
        return (
          <button
            key={opt.value}
            disabled={isOff}
            style={{
              flex: 1,
              padding: "6px 12px",
              fontSize: 12,
              fontWeight: isActive ? 600 : 400,
              color: isOff ? "var(--ezy-text-muted)" : isActive ? "var(--ezy-text)" : "var(--ezy-text-muted)",
              backgroundColor: isActive ? "var(--ezy-accent-glow)" : "transparent",
              border: "none",
              cursor: isOff ? "default" : "pointer",
              fontFamily: "inherit",
              transition: "background-color 150ms ease",
              opacity: isOff ? 0.35 : 1,
            }}
            onMouseEnter={(e) => { if (!isActive && !isOff) e.currentTarget.style.backgroundColor = "var(--ezy-surface)"; }}
            onMouseLeave={(e) => { if (!isActive && !isOff) e.currentTarget.style.backgroundColor = "transparent"; }}
            onClick={() => { if (!isOff) onChange(opt.value); }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function SettingsSection({ id, title, description, children }: {
  id: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} style={{ paddingBottom: 32 }}>
      <h2 style={{
        fontSize: 15,
        fontWeight: 600,
        color: "var(--ezy-text)",
        margin: "0 0 4px",
        letterSpacing: "-0.01em",
      }}>{title}</h2>
      {description && (
        <p style={{ fontSize: 12, color: "var(--ezy-text-muted)", margin: "0 0 5px", lineHeight: 1.4 }}>{description}</p>
      )}
      {!description && <div style={{ height: 12 }} />}
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {children}
      </div>
    </section>
  );
}

function SettingsRow({ label, description, children }: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "10px 0",
      gap: 16,
      borderBottom: "1px solid var(--ezy-border-subtle)",
    }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13, color: "var(--ezy-text-secondary)" }}>{label}</div>
        {description && <div style={{ fontSize: 11, color: "var(--ezy-text-muted)", marginTop: 2, lineHeight: 1.3 }}>{description}</div>}
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  );
}

function PathPicker({ value, onChange, directory, filters }: {
  value: string;
  onChange: (v: string) => void;
  directory?: boolean;
  filters?: { name: string; extensions: string[] }[];
}) {
  const handleBrowse = async () => {
    try {
      const selected = await open({
        directory: !!directory,
        multiple: false,
        title: directory ? "Select Directory" : "Select File",
        filters: directory ? undefined : filters,
      });
      if (selected && typeof selected === "string") {
        onChange(selected);
      }
    } catch { /* cancelled */ }
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{
        fontSize: 11,
        color: value ? "var(--ezy-text-secondary)" : "var(--ezy-text-muted)",
        maxWidth: 180,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        fontStyle: value ? "normal" : "italic",
      }}>
        {value ? value.split(/[\\/]/).pop() : "Not set"}
      </div>
      <button
        onClick={handleBrowse}
        style={{
          padding: "4px 10px",
          fontSize: 11,
          fontWeight: 500,
          color: "var(--ezy-text-secondary)",
          backgroundColor: "var(--ezy-surface)",
          border: "1px solid var(--ezy-border)",
          borderRadius: 5,
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        Browse
      </button>
      {value && (
        <button
          onClick={() => onChange("")}
          style={{
            padding: "2px 6px",
            fontSize: 12,
            color: "var(--ezy-text-muted)",
            backgroundColor: "transparent",
            border: "none",
            cursor: "pointer",
            fontFamily: "inherit",
            lineHeight: 1,
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

// ─── Duration formatter ──────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return "0s";
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}


const CLI_COLORS: Record<string, string> = {
  claude: "#e87b35",  // orange
  codex: "#34d399",   // emerald/green
  gemini: "#a78bfa",  // purple
};

const CLI_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
};

function AiTimeStatsSection({ bursts, onClear }: { bursts: AiTimeBurst[]; onClear: () => void }) {
  const [showConfirm, setShowConfirm] = useState(false);
  const weekKey = useMemo(() => currentIsoWeek(), []);

  // Aggregate data outside selectors (per feedback_zustand_selector_no_filter)
  const { weekTotal, weekByCli, allTotal, allByCli, projects } = useMemo(() => {
    let weekTotal = 0;
    const weekByCli: Record<string, number> = {};
    let allTotal = 0;
    const allByCli: Record<string, number> = {};
    const projectMap: Record<string, number> = {};

    for (const b of bursts) {
      allTotal += b.durationMs;
      allByCli[b.cli] = (allByCli[b.cli] || 0) + b.durationMs;
      projectMap[b.project] = (projectMap[b.project] || 0) + b.durationMs;
      if (b.week === weekKey) {
        weekTotal += b.durationMs;
        weekByCli[b.cli] = (weekByCli[b.cli] || 0) + b.durationMs;
      }
    }

    const projects = Object.entries(projectMap)
      .sort((a, b) => b[1] - a[1])
      .map(([path, ms]) => ({ path, ms, name: path.split("/").pop() || path }));

    return { weekTotal, weekByCli, allTotal, allByCli, projects };
  }, [bursts, weekKey]);

  return (
    <SettingsSection id="statistics" title="Statistics" description="AI working time tracked from terminal output bursts.">
      {/* This Week */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ezy-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
          This Week
        </div>
        <div style={{ fontSize: 28, fontWeight: 700, color: "var(--ezy-text)", letterSpacing: "-0.02em", marginBottom: 8 }}>
          {formatDuration(weekTotal)}
        </div>
        <div style={{ display: "flex", gap: 16 }}>
          {(["claude", "codex", "gemini"] as const).map((cli) => {
            const ms = weekByCli[cli] || 0;
            if (ms === 0 && weekTotal === 0) return null;
            return (
              <div key={cli} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: CLI_COLORS[cli] }} />
                <span style={{ fontSize: 12, color: "var(--ezy-text-secondary)" }}>
                  {CLI_LABELS[cli]}: {formatDuration(ms)}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* All Time */}
      <div style={{ marginBottom: 24, paddingTop: 16, borderTop: "1px solid var(--ezy-border-subtle)" }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ezy-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
          All Time
        </div>
        <div style={{ fontSize: 22, fontWeight: 700, color: "var(--ezy-text)", letterSpacing: "-0.02em", marginBottom: 8 }}>
          {formatDuration(allTotal)}
        </div>
        <div style={{ display: "flex", gap: 16 }}>
          {(["claude", "codex", "gemini"] as const).map((cli) => {
            const ms = allByCli[cli] || 0;
            if (ms === 0 && allTotal === 0) return null;
            return (
              <div key={cli} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: CLI_COLORS[cli] }} />
                <span style={{ fontSize: 12, color: "var(--ezy-text-secondary)" }}>
                  {CLI_LABELS[cli]}: {formatDuration(ms)}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Per Project */}
      {projects.length > 0 && (
        <div style={{ marginBottom: 24, paddingTop: 16, borderTop: "1px solid var(--ezy-border-subtle)" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ezy-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>
            Per Project
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {projects.map((p) => (
              <div
                key={p.path}
                title={p.path}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "6px 0",
                  borderBottom: "1px solid var(--ezy-border-subtle)",
                }}
              >
                <span style={{ fontSize: 13, color: "var(--ezy-text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1, marginRight: 12 }}>
                  {p.name}
                </span>
                <span style={{ fontSize: 13, fontWeight: 500, color: "var(--ezy-text)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                  {formatDuration(p.ms)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {bursts.length === 0 && (
        <div style={{ padding: "24px 0", textAlign: "center", color: "var(--ezy-text-muted)", fontSize: 13 }}>
          No AI time tracked yet. Open an AI terminal and let it work to start tracking.
        </div>
      )}

      {/* Reset */}
      {bursts.length > 0 && (
        <div style={{ paddingTop: 16, borderTop: "1px solid var(--ezy-border-subtle)" }}>
          {!showConfirm ? (
            <div
              onClick={() => setShowConfirm(true)}
              style={{
                fontSize: 12,
                color: "var(--ezy-red, #e55)",
                cursor: "pointer",
                padding: "6px 0",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.8"; }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
            >
              Reset all statistics
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 12, color: "var(--ezy-text-muted)" }}>Are you sure?</span>
              <div
                onClick={() => { onClear(); setShowConfirm(false); }}
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: "#fff",
                  backgroundColor: "var(--ezy-red, #e55)",
                  padding: "4px 10px",
                  borderRadius: 4,
                  cursor: "pointer",
                }}
              >
                Reset
              </div>
              <div
                onClick={() => setShowConfirm(false)}
                style={{
                  fontSize: 12,
                  color: "var(--ezy-text-muted)",
                  cursor: "pointer",
                }}
              >
                Cancel
              </div>
            </div>
          )}
        </div>
      )}
    </SettingsSection>
  );
}

// ─── Updates section ──────────────────────────────────────────────────────

function UpdatesSection() {
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [checkStatus, setCheckStatus] = useState<"idle" | "checking" | "available" | "downloading" | "installing" | "up-to-date" | "error">("idle");
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ downloaded: number; total: number | null } | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);

  // Fetch app version on mount
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

  const handleCheck = useCallback(async () => {
    setCheckStatus("checking");
    setErrorMsg(null);
    try {
      const update = await check();
      if (update) {
        setCheckStatus("available");
        setLatestVersion(update.version);
        setPendingUpdate(update);
      } else {
        setCheckStatus("up-to-date");
        setPendingUpdate(null);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isNoRelease =
        /fetch.*release/i.test(msg) ||
        /404/i.test(msg) ||
        /network/i.test(msg);
      if (isNoRelease) {
        setCheckStatus("up-to-date");
      } else {
        setCheckStatus("error");
        setErrorMsg(msg);
      }
    }
  }, []);

  const handleUpdate = useCallback(async () => {
    if (!pendingUpdate) return;
    setCheckStatus("downloading");
    setProgress({ downloaded: 0, total: null });
    try {
      await pendingUpdate.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            setProgress({ downloaded: 0, total: event.data.contentLength ?? null });
            break;
          case "Progress":
            setProgress((p) => ({
              downloaded: (p?.downloaded ?? 0) + (event.data.chunkLength ?? 0),
              total: p?.total ?? null,
            }));
            break;
          case "Finished":
            setCheckStatus("installing");
            break;
        }
      });
      await relaunch();
    } catch (err) {
      setCheckStatus("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, [pendingUpdate]);

  const pct = progress && progress.total
    ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
    : null;

  const isUpdating = checkStatus === "downloading" || checkStatus === "installing";

  return (
    <SettingsSection id="updates" title="Updates" description="Check for new versions of EzyDev.">
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {appVersion && (
          <div style={{ fontSize: 13, color: "var(--ezy-text-secondary)" }}>
            Current version:{" "}
            <span style={{ color: "var(--ezy-text)", fontWeight: 500 }}>{appVersion}</span>
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            onClick={handleCheck}
            disabled={checkStatus === "checking" || isUpdating}
            style={{
              height: 30,
              padding: "0 14px",
              borderRadius: 6,
              border: "1px solid var(--ezy-border)",
              background: "var(--ezy-surface-raised)",
              color: "var(--ezy-text)",
              fontSize: 13,
              fontWeight: 500,
              cursor: checkStatus === "checking" || isUpdating ? "not-allowed" : "pointer",
              opacity: checkStatus === "checking" || isUpdating ? 0.6 : 1,
              transition: "border-color 120ms ease",
              flexShrink: 0,
            }}
            onMouseEnter={(e) => {
              if (checkStatus !== "checking" && !isUpdating)
                e.currentTarget.style.borderColor = "var(--ezy-accent)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "var(--ezy-border)";
            }}
          >
            {checkStatus === "checking" ? "Checking..." : "Check for Updates"}
          </button>
          {checkStatus === "available" && (
            <button
              onClick={handleUpdate}
              style={{
                height: 30,
                padding: "0 14px",
                borderRadius: 6,
                border: "none",
                background: "var(--ezy-accent-dim)",
                color: "#fff",
                fontSize: 13,
                fontWeight: 500,
                cursor: "pointer",
                flexShrink: 0,
                transition: "background-color 120ms ease",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.backgroundColor = "var(--ezy-accent-hover)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.backgroundColor = "var(--ezy-accent-dim)")
              }
            >
              Update Now
            </button>
          )}
        </div>
        {checkStatus === "up-to-date" && (
          <span style={{ fontSize: 12, color: "var(--ezy-accent)" }}>
            Up to date
          </span>
        )}
        {checkStatus === "available" && latestVersion && (
          <span style={{ fontSize: 12, color: "var(--ezy-accent)" }}>
            v{latestVersion} is available
          </span>
        )}
        {checkStatus === "downloading" && (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              backgroundColor: "var(--ezy-border)",
              overflow: "hidden",
              minWidth: 60,
            }}>
              <div style={{
                height: "100%",
                width: pct != null ? `${pct}%` : "30%",
                backgroundColor: "var(--ezy-accent)",
                borderRadius: 2,
                transition: pct != null ? "width 200ms ease" : "none",
              }} />
            </div>
            {pct != null && (
              <span style={{ fontSize: 12, color: "var(--ezy-text-muted)", fontVariantNumeric: "tabular-nums" }}>
                {pct}%
              </span>
            )}
          </div>
        )}
        {checkStatus === "installing" && (
          <span style={{ fontSize: 12, color: "var(--ezy-accent)" }}>
            Installing update, restarting...
          </span>
        )}
        {checkStatus === "error" && (
          <span style={{ fontSize: 12, color: "var(--ezy-red)" }}>
            {errorMsg || "Failed to check for updates"}
          </span>
        )}
      </div>
    </SettingsSection>
  );
}

// ─── Nav sections ──────────────────────────────────────────────────────────

const NAV_SECTIONS = [
  { id: "general", label: "General" },
  { id: "terminal", label: "Terminal" },
  { id: "projects", label: "Projects" },
  { id: "editor", label: "Editor" },
  { id: "ai", label: "AI" },
  { id: "updates", label: "Updates" },
];

// ─── Main component ───────────────────────────────────────────────────────

export default function SettingsPane() {
  const [activeSection, setActiveSection] = useState(NAV_SECTIONS[0]?.id ?? "behavior");
  const [showClearModal, setShowClearModal] = useState(false);
  const [cliExpanded, setCliExpanded] = useState<Partial<Record<TerminalType, boolean>>>({});

  // Store selectors
  const terminalBackend = useAppStore((s) => s.terminalBackend ?? "wsl");
  const setTerminalBackend = useAppStore((s) => s.setTerminalBackend);
  const alwaysShowTemplatePicker = useAppStore((s) => s.alwaysShowTemplatePicker);
  const setAlwaysShowTemplatePicker = useAppStore((s) => s.setAlwaysShowTemplatePicker);
  const restoreLastSession = useAppStore((s) => s.restoreLastSession);
  const setRestoreLastSession = useAppStore((s) => s.setRestoreLastSession);
  const autoInsertClipboardImage = useAppStore((s) => s.autoInsertClipboardImage);
  const setAutoInsertClipboardImage = useAppStore((s) => s.setAutoInsertClipboardImage);
  const copyOnSelect = useAppStore((s) => s.copyOnSelect);
  const setCopyOnSelect = useAppStore((s) => s.setCopyOnSelect);
  const showTabPath = useAppStore((s) => s.showTabPath);
  const setShowTabPath = useAppStore((s) => s.setShowTabPath);
  const confirmQuit = useAppStore((s) => s.confirmQuit);
  const setConfirmQuit = useAppStore((s) => s.setConfirmQuit);
  const slashCommandGhostText = useAppStore((s) => s.slashCommandGhostText);
  const setSlashCommandGhostText = useAppStore((s) => s.setSlashCommandGhostText);
  const openPanesInBackground = useAppStore((s) => s.openPanesInBackground);
  const setOpenPanesInBackground = useAppStore((s) => s.setOpenPanesInBackground);
  const wideGridLayout = useAppStore((s) => s.wideGridLayout);
  const setWideGridLayout = useAppStore((s) => s.setWideGridLayout);
  const autoMinimizeGameOnAiDone = useAppStore((s) => s.autoMinimizeGameOnAiDone);
  const setAutoMinimizeGameOnAiDone = useAppStore((s) => s.setAutoMinimizeGameOnAiDone);
  const autoStartServerCommand = useAppStore((s) => s.autoStartServerCommand);
  const setAutoStartServerCommand = useAppStore((s) => s.setAutoStartServerCommand);
  const promptComposerEnabled = useAppStore((s) => s.promptComposerEnabled);
  const setPromptComposerEnabled = useAppStore((s) => s.setPromptComposerEnabled);
  const promptComposerAlwaysVisible = useAppStore((s) => s.promptComposerAlwaysVisible);
  const setPromptComposerAlwaysVisible = useAppStore((s) => s.setPromptComposerAlwaysVisible);
  const composerExpansion = useAppStore((s) => s.composerExpansion);
  const setComposerExpansion = useAppStore((s) => s.setComposerExpansion);
  const browserFullColumn = useAppStore((s) => s.browserFullColumn);
  const setBrowserFullColumn = useAppStore((s) => s.setBrowserFullColumn);
  const browserSpawnLeft = useAppStore((s) => s.browserSpawnLeft);
  const setBrowserSpawnLeft = useAppStore((s) => s.setBrowserSpawnLeft);
  const codeReviewCollapseAll = useAppStore((s) => s.codeReviewCollapseAll);
  const setCodeReviewCollapseAll = useAppStore((s) => s.setCodeReviewCollapseAll);
  const projectsDir = useAppStore((s) => s.projectsDir);
  const setProjectsDir = useAppStore((s) => s.setProjectsDir);
  const defaultClaudeMdPath = useAppStore((s) => s.defaultClaudeMdPath);
  const setDefaultClaudeMdPath = useAppStore((s) => s.setDefaultClaudeMdPath);
  const defaultAgentsMdPath = useAppStore((s) => s.defaultAgentsMdPath);
  const setDefaultAgentsMdPath = useAppStore((s) => s.setDefaultAgentsMdPath);
  const commitMsgMode = useAppStore((s) => s.commitMsgMode ?? "simple");
  const setCommitMsgMode = useAppStore((s) => s.setCommitMsgMode);
  const shadowAiCli = useAppStore((s) => s.shadowAiCli ?? "claude");
  const setShadowAiCli = useAppStore((s) => s.setShadowAiCli);
  const cliFontSizes = useAppStore((s) => s.cliFontSizes);
  const setCliFontSize = useAppStore((s) => s.setCliFontSize);
  const cliYolo = useAppStore((s) => s.cliYolo);
  const setCliYolo = useAppStore((s) => s.setCliYolo);
  const statuslineToggles = useAppStore((s) => s.statuslineToggles);
  const setStatuslineToggle = useAppStore((s) => s.setStatuslineToggle);
  const themeId = useAppStore((s) => s.themeId);
  const setTheme = useAppStore((s) => s.setTheme);
  const vibrantColors = useAppStore((s) => s.vibrantColors);
  const setVibrantColors = useAppStore((s) => s.setVibrantColors);
  const aiTimeBursts = useAppStore((s) => s.aiTimeBursts);
  const clearAiTimeStats = useAppStore((s) => s.clearAiTimeStats);
  const theme = getTheme(themeId);

  // Render only the active section content
  const renderSection = () => {
    switch (activeSection) {
      case "general":
        return (
          <>
            <SettingsSection id="behavior" title="Behavior" description="General application behavior and defaults.">
              <SettingsRow label="Always show layout picker" description="Show the workspace template picker when creating new tabs.">
                <ToggleSwitch checked={alwaysShowTemplatePicker} onChange={setAlwaysShowTemplatePicker} />
              </SettingsRow>
              <SettingsRow label="Restore last session" description="Reopen tabs from the previous session on startup.">
                <ToggleSwitch checked={restoreLastSession} onChange={setRestoreLastSession} />
              </SettingsRow>
              <SettingsRow label="Auto-paste screenshots" description="Automatically insert clipboard images into AI context.">
                <ToggleSwitch checked={autoInsertClipboardImage} onChange={setAutoInsertClipboardImage} />
              </SettingsRow>
              <SettingsRow label="Copy on select" description="Automatically copy selected terminal text to clipboard.">
                <ToggleSwitch checked={copyOnSelect} onChange={setCopyOnSelect} />
              </SettingsRow>
              <SettingsRow label="Show path in tabs" description="Display the project path after the tab name. Double-click name to rename.">
                <ToggleSwitch checked={showTabPath} onChange={setShowTabPath} />
              </SettingsRow>
              <SettingsRow label="Confirm before quitting" description="Show a confirmation dialog when closing the app.">
                <ToggleSwitch checked={confirmQuit} onChange={setConfirmQuit} />
              </SettingsRow>
              <SettingsRow label="Slash command ghost text" description="Show inline autocomplete suggestions for slash commands.">
                <ToggleSwitch checked={slashCommandGhostText} onChange={setSlashCommandGhostText} />
              </SettingsRow>
              <SettingsRow label="Open panes in background" description="New panes open without stealing focus from the current pane.">
                <ToggleSwitch checked={openPanesInBackground} onChange={setOpenPanesInBackground} />
              </SettingsRow>
              <SettingsRow label="Wide grid layout" description="First 4 panes open side-by-side before stacking vertically.">
                <ToggleSwitch checked={wideGridLayout} onChange={setWideGridLayout} />
              </SettingsRow>
              <SettingsRow label="Auto-hide games when AI done" description="Minimize game pane when AI task completes.">
                <ToggleSwitch checked={autoMinimizeGameOnAiDone} onChange={setAutoMinimizeGameOnAiDone} />
              </SettingsRow>
              <SettingsRow label="Auto-start server command" description="Restore dev server commands when reopening projects.">
                <ToggleSwitch checked={autoStartServerCommand} onChange={setAutoStartServerCommand} />
              </SettingsRow>
            </SettingsSection>
            <SettingsSection id="theme" title="Theme" description="Choose a color theme for the application.">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 8, marginBottom: 16 }}>
                {THEMES.map((t) => {
                  const isSelected = t.id === themeId;
                  return (
                    <button
                      key={t.id}
                      onClick={() => setTheme(t.id)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "10px 12px",
                        borderRadius: 8,
                        border: isSelected ? `2px solid var(--ezy-accent)` : "1px solid var(--ezy-border)",
                        backgroundColor: isSelected ? "var(--ezy-accent-glow)" : "var(--ezy-surface)",
                        cursor: "pointer",
                        fontFamily: "inherit",
                        textAlign: "left",
                        transition: "all 120ms ease",
                      }}
                      onMouseEnter={(e) => {
                        if (!isSelected) e.currentTarget.style.borderColor = "var(--ezy-accent)";
                      }}
                      onMouseLeave={(e) => {
                        if (!isSelected) e.currentTarget.style.borderColor = "var(--ezy-border)";
                      }}
                    >
                      <div style={{ display: "flex", gap: 3, flexShrink: 0 }}>
                        <div style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: t.surface.bg }} />
                        <div style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: t.surface.accent }} />
                        <div style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: t.surface.cyan }} />
                      </div>
                      <span style={{ fontSize: 13, fontWeight: isSelected ? 600 : 400, color: isSelected ? "var(--ezy-text)" : "var(--ezy-text-secondary)" }}>
                        {t.name}
                      </span>
                      {isSelected && <FaCheck size={12} color={theme.surface.accent} style={{ marginLeft: "auto" }} />}
                    </button>
                  );
                })}
              </div>
              <SettingsRow label="Vibrant colors" description="Use brighter, more saturated accent colors throughout the UI.">
                <ToggleSwitch checked={vibrantColors} onChange={setVibrantColors} />
              </SettingsRow>
            </SettingsSection>
            <SettingsSection id="danger-zone" title="Danger Zone" description="Clear EzyDev's local storage. Your files on disk are not affected.">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0" }}>
                <div style={{ minWidth: 0, flex: 1, marginRight: 16 }}>
                  <div style={{ fontSize: 13, color: "var(--ezy-text-secondary)" }}>Clear local data</div>
                  <div style={{ fontSize: 11, color: "var(--ezy-text-muted)", marginTop: 2, lineHeight: 1.3 }}>
                    Wipe preferences, history, recent projects, game scores, or cached CLI paths. Choose what to clear in the next step.
                  </div>
                </div>
                <button
                  onClick={() => setShowClearModal(true)}
                  style={{
                    height: 30,
                    padding: "0 14px",
                    borderRadius: 6,
                    border: "none",
                    backgroundColor: "var(--ezy-red, #e55)",
                    color: "#fff",
                    fontSize: 12,
                    fontWeight: 600,
                    fontFamily: "inherit",
                    cursor: "pointer",
                    flexShrink: 0,
                    transition: "opacity 120ms ease",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.85"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
                >
                  Clear data...
                </button>
              </div>
            </SettingsSection>
          </>
        );

      case "terminal":
        return (
          <>
            {isWindows() && (
              <SettingsSection id="terminal-backend" title="Backend" description="Choose the backend for new terminal instances.">
                <SettingsRow label="Terminal backend">
                  <SegmentedControl
                    options={[
                      { value: "wsl" as const, label: "WSL" },
                      { value: "windows" as const, label: "Windows" },
                    ]}
                    value={terminalBackend as "wsl" | "windows"}
                    onChange={(v) => setTerminalBackend(v)}
                  />
                </SettingsRow>
              </SettingsSection>
            )}
            <SettingsSection id="cli" title="CLI Options" description="Per-CLI font size and YOLO mode settings.">
            {(["claude", "codex", "gemini"] as TerminalType[]).map((cliType) => {
              const currentSize = cliFontSizes[cliType] ?? DEFAULT_CLI_FONT_SIZE;
              const isYolo = !!cliYolo[cliType];
              const label = TERMINAL_CONFIGS[cliType].label;
              const isExpanded = cliExpanded[cliType] ?? false;
              return (
                <div key={cliType} style={{ borderBottom: "1px solid var(--ezy-border-subtle)", marginBottom: 8 }}>
                  <div
                    onClick={() => setCliExpanded({ ...cliExpanded, [cliType]: !isExpanded })}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "10px 0",
                      cursor: "pointer",
                      userSelect: "none",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: CLI_COLORS[cliType] }} />
                      <span style={{ fontSize: 13, fontWeight: 500, color: "var(--ezy-text)" }}>{label}</span>
                    </div>
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 12 12"
                      style={{
                        color: "var(--ezy-text-muted)",
                        transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
                        transition: "transform 150ms ease",
                      }}
                    >
                      <path d="M4 2 L8 6 L4 10" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                  {isExpanded && (
                  <div style={{ paddingBottom: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                    <span style={{ fontSize: 12, color: "var(--ezy-text-secondary)" }}>Font size</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <div
                        onClick={() => setCliFontSize(cliType, Math.max(10, currentSize - 1))}
                        style={{
                          width: 24,
                          height: 24,
                          borderRadius: 4,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          cursor: currentSize <= 10 ? "default" : "pointer",
                          opacity: currentSize <= 10 ? 0.3 : 1,
                          backgroundColor: "transparent",
                          border: "1px solid var(--ezy-border-light)",
                          color: "var(--ezy-text-secondary)",
                          fontSize: 14,
                          lineHeight: 1,
                          transition: "background-color 120ms ease",
                        }}
                        onMouseEnter={(e) => { if (currentSize > 10) e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
                      >
                        -
                      </div>
                      <span style={{ fontSize: 13, color: "var(--ezy-text)", minWidth: 24, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
                        {currentSize}
                      </span>
                      <div
                        onClick={() => setCliFontSize(cliType, Math.min(24, currentSize + 1))}
                        style={{
                          width: 24,
                          height: 24,
                          borderRadius: 4,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          cursor: currentSize >= 24 ? "default" : "pointer",
                          opacity: currentSize >= 24 ? 0.3 : 1,
                          backgroundColor: "transparent",
                          border: "1px solid var(--ezy-border-light)",
                          color: "var(--ezy-text-secondary)",
                          fontSize: 14,
                          lineHeight: 1,
                          transition: "background-color 120ms ease",
                        }}
                        onMouseEnter={(e) => { if (currentSize < 24) e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
                      >
                        +
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {isYolo ? (
                        <span style={{
                          fontSize: 10,
                          fontWeight: 700,
                          padding: "2px 5px",
                          borderRadius: 3,
                          backgroundColor: "var(--ezy-red, #e55)",
                          color: "#fff",
                          lineHeight: 1,
                          letterSpacing: "0.06em",
                        }}>YOLO</span>
                      ) : (
                        <span style={{ fontSize: 12, color: "var(--ezy-text-muted)" }}>YOLO</span>
                      )}
                      <span style={{ fontSize: 12, color: "var(--ezy-text-muted)" }}>mode</span>
                    </div>
                    <ToggleSwitch checked={isYolo} onChange={(v) => setCliYolo(cliType, v)} color="var(--ezy-red, #e55)" />
                  </div>
                  {/* Statusline toggles */}
                  <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--ezy-border-subtle)" }}>
                    {(() => {
                      const visibleKeys = Object.entries(STATUSLINE_FEATURES)
                        .filter(([, feat]) => feat.clis.includes(cliType))
                        .map(([k]) => k);
                      const allOn = visibleKeys.every((k) => statuslineToggles[cliType]?.[k] ?? true);
                      const allOff = visibleKeys.every((k) => !(statuslineToggles[cliType]?.[k] ?? true));
                      const setAll = (value: boolean) => {
                        visibleKeys.forEach((k) => setStatuslineToggle(cliType, k, value));
                      };
                      const btn = (label: string, onClick: () => void, disabled: boolean) => (
                        <div
                          onClick={disabled ? undefined : onClick}
                          style={{
                            padding: "2px 8px",
                            borderRadius: 4,
                            border: "1px solid var(--ezy-border-light)",
                            color: "var(--ezy-text-secondary)",
                            fontSize: 11,
                            lineHeight: 1.3,
                            cursor: disabled ? "default" : "pointer",
                            opacity: disabled ? 0.3 : 1,
                            backgroundColor: "transparent",
                            transition: "background-color 120ms ease",
                            userSelect: "none",
                          }}
                          onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
                        >
                          {label}
                        </div>
                      );
                      return (
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                          <div style={{ fontSize: 11, color: "var(--ezy-text-muted)" }}>Statusline</div>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            {btn("All", () => setAll(true), allOn)}
                            {btn("None", () => setAll(false), allOff)}
                          </div>
                        </div>
                      );
                    })()}
                    {Object.entries(STATUSLINE_FEATURES)
                      .filter(([, feat]) => feat.clis.includes(cliType))
                      .map(([key, feat]) => {
                        const isOn = statuslineToggles[cliType]?.[key] ?? true;
                        return (
                          <div
                            key={key}
                            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 0", cursor: "pointer" }}
                            onClick={() => setStatuslineToggle(cliType, key, !isOn)}
                          >
                            <span style={{ fontSize: 12, color: "var(--ezy-text-secondary)" }}>{feat.label}</span>
                            <ToggleSwitch checked={isOn} onChange={(v) => setStatuslineToggle(cliType, key, v)} />
                          </div>
                        );
                      })}
                  </div>
                  </div>
                  )}
                </div>
              );
            })}
          </SettingsSection>
          </>
        );

      case "projects":
        return (
          <SettingsSection id="projects" title="Projects" description="Configure default project directory and template files for new projects.">
            <SettingsRow label="Projects directory" description="Default folder where new projects are created.">
              <PathPicker value={projectsDir} onChange={setProjectsDir} directory />
            </SettingsRow>
            <SettingsRow label="Default CLAUDE.md" description="Template file copied to new projects as CLAUDE.md (Claude Code).">
              <PathPicker value={defaultClaudeMdPath} onChange={setDefaultClaudeMdPath} filters={[{ name: "Markdown", extensions: ["md"] }]} />
            </SettingsRow>
            <SettingsRow label="Default AGENTS.md" description="Template file copied to new projects as AGENTS.md (Codex / Gemini).">
              <PathPicker value={defaultAgentsMdPath} onChange={setDefaultAgentsMdPath} filters={[{ name: "Markdown", extensions: ["md"] }]} />
            </SettingsRow>
          </SettingsSection>
        );

      case "editor":
        return (
          <>
            <SettingsSection id="composer" title="EzyComposer" description="Configure the prompt composer overlay (Ctrl+I).">
              <SettingsRow label="Enable EzyComposer">
                <ToggleSwitch checked={promptComposerEnabled} onChange={setPromptComposerEnabled} />
              </SettingsRow>
              {promptComposerEnabled && (
                <>
                  <SettingsRow label="Always visible" description="Keep the composer visible at all times instead of toggle.">
                    <ToggleSwitch checked={promptComposerAlwaysVisible} onChange={setPromptComposerAlwaysVisible} />
                  </SettingsRow>
                  <SettingsRow label="Expansion direction" description="How the composer expands when typing long prompts.">
                    <SegmentedControl
                      options={[
                        { value: "up" as ComposerExpansion, label: "Up" },
                        { value: "down" as ComposerExpansion, label: "Down" },
                        { value: "scroll" as ComposerExpansion, label: "Scroll" },
                      ]}
                      value={composerExpansion}
                      onChange={setComposerExpansion}
                    />
                  </SettingsRow>
                </>
              )}
            </SettingsSection>
            <SettingsSection id="preview" title="Preview Panes" description="Configure browser preview pane behavior.">
              <SettingsRow label="Full column" description="Browser pane takes a full column width in split layouts.">
                <ToggleSwitch checked={browserFullColumn} onChange={setBrowserFullColumn} />
              </SettingsRow>
              <SettingsRow label="Spawn on left" description="Open browser preview on the left side instead of right.">
                <ToggleSwitch checked={browserSpawnLeft} onChange={setBrowserSpawnLeft} />
              </SettingsRow>
            </SettingsSection>
            <SettingsSection id="codereview" title="Code Review" description="Configure the built-in code review experience.">
              <SettingsRow label="Collapse all files" description="Start with all file diffs collapsed in code review.">
                <ToggleSwitch checked={codeReviewCollapseAll} onChange={setCodeReviewCollapseAll} />
              </SettingsRow>
              <SettingsRow label="Commit message mode">
                <SegmentedControl
                  options={[
                    { value: "empty" as const, label: "Empty" },
                    { value: "simple" as const, label: "Simple" },
                    { value: "advanced" as const, label: "AI" },
                  ]}
                  value={commitMsgMode}
                  onChange={setCommitMsgMode}
                />
              </SettingsRow>
              <div style={{ fontSize: 11, color: "var(--ezy-text-muted)", padding: "4px 0 0", lineHeight: 1.3 }}>
                {commitMsgMode === "empty" && "Start with a blank commit message"}
                {commitMsgMode === "simple" && "Auto-fill from changed filenames"}
                {commitMsgMode === "advanced" && "Generate message via background AI session"}
              </div>
            </SettingsSection>
            <SettingsSection id="links" title="Snippets & Shortcuts">
              <div
                onClick={() => window.dispatchEvent(new Event("ezydev:open-snippets"))}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "12px 0",
                  cursor: "pointer",
                  borderBottom: "1px solid var(--ezy-border-subtle)",
                }}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.3" strokeLinecap="round">
                  <path d="M5.5 2H3a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1V3a1 1 0 00-1-1h-2.5" />
                  <path d="M5 5l2 2-2 2" />
                  <line x1="8" y1="10" x2="12" y2="10" />
                </svg>
                <span style={{ fontSize: 13, color: "var(--ezy-text-secondary)", flex: 1 }}>Manage Snippets</span>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 4l4 4-4 4" />
                </svg>
              </div>
              <div
                onClick={() => window.dispatchEvent(new Event("ezydev:open-shortcuts"))}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "12px 0",
                  cursor: "pointer",
                  borderBottom: "1px solid var(--ezy-border-subtle)",
                }}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="1" y="4" width="14" height="9" rx="1.5" />
                  <line x1="4" y1="7" x2="5.5" y2="7" />
                  <line x1="7" y1="7" x2="8.5" y2="7" />
                  <line x1="10.5" y1="7" x2="12" y2="7" />
                  <line x1="4.5" y1="10" x2="11.5" y2="10" />
                </svg>
                <span style={{ fontSize: 13, color: "var(--ezy-text-secondary)", flex: 1 }}>Keyboard Shortcuts</span>
                <span style={{ fontSize: 11, color: "var(--ezy-text-muted)", fontFamily: "monospace" }}>Ctrl+/</span>
              </div>
            </SettingsSection>
          </>
        );

      case "ai":
        return (
          <>
            <SettingsSection id="ai" title="AI Sessions" description="Configure shadow AI provider for background tasks.">
              <SettingsRow label="Shadow AI provider" description="Subscription used for Promptifier and AI commit messages.">
                <SegmentedControl
                  options={[
                    { value: "claude" as const, label: "Claude" },
                    { value: "codex" as const, label: "Codex" },
                    { value: "gemini" as const, label: "Gemini", disabled: true },
                  ]}
                  value={shadowAiCli}
                  onChange={(v) => setShadowAiCli(v as "claude" | "codex")}
                />
              </SettingsRow>
            </SettingsSection>
            <AiTimeStatsSection bursts={aiTimeBursts} onClear={clearAiTimeStats} />
          </>
        );

      case "updates":
        return <UpdatesSection />;

      default:
        return null;
    }
  };

  return (
    <div style={{
      display: "flex",
      height: "100%",
      width: 620,
      flexShrink: 0,
      borderRight: "1px solid var(--ezy-border)",
      backgroundColor: "var(--ezy-bg)",
      color: "var(--ezy-text)",
    }}>
      {/* Left nav sidebar */}
      <nav style={{
        width: 160,
        flexShrink: 0,
        borderRight: "1px solid var(--ezy-border)",
        padding: "12px 0",
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 1,
      }}>
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 16px 12px",
        }}>
          <span style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: "var(--ezy-text-muted)",
          }}>Settings</span>
        </div>
        {NAV_SECTIONS.map((s) => {
          const isActive = activeSection === s.id;
          return (
            <div
              key={s.id}
              onClick={() => setActiveSection(s.id)}
              style={{
                padding: "7px 16px",
                fontSize: 13,
                color: isActive ? "var(--ezy-text)" : "var(--ezy-text-secondary)",
                fontWeight: isActive ? 600 : 400,
                cursor: "pointer",
                borderLeft: isActive ? `2px solid var(--ezy-accent)` : "2px solid transparent",
                backgroundColor: isActive ? "var(--ezy-accent-glow)" : "transparent",
                transition: "all 120ms ease",
              }}
              onMouseEnter={(e) => {
                if (!isActive) e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
              }}
              onMouseLeave={(e) => {
                if (!isActive) e.currentTarget.style.backgroundColor = "transparent";
              }}
            >
              {s.label}
            </div>
          );
        })}
      </nav>

      {/* Right content area — only the active section */}
      <div style={{
        flex: 1,
        overflowY: "auto",
        padding: "24px 24px 60px",
      }}>
        {renderSection()}
      </div>

      {showClearModal && <ClearDataModal onClose={() => setShowClearModal(false)} />}
    </div>
  );
}
