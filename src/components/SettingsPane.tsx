import { useState, useMemo, useCallback, useEffect, useRef, useContext, createContext, Fragment } from "react";
import { nativeTermGpuInfo, type GpuInfo } from "../lib/native-term-bridge";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { KNOWN_TERM_PROGRAMS } from "../lib/terminal-config";
import { setClaudeNotifChannel, type ClaudeNotifChannel } from "../lib/sessions-index";
import { useAppStore } from "../store";
import { useModalWhen } from "../store/modalCoordinationSlice";
import type { AiTimeBurst } from "../store/aiTimeSlice";
import { THEMES, getTheme } from "../lib/themes";
import { getDefaultBackend } from "../lib/platform";
import {
  readJiraMcpStatus,
  installJiraMcp,
  JIRA_MCP_AUTH_HINT,
  type JiraMcpStatus,
} from "../lib/jira-mcp";
import { TERMINAL_CONFIGS } from "../lib/terminal-config";
import { isWindows } from "../lib/platform";
import { currentIsoWeek } from "../lib/iso-week";
import { DEFAULT_CLI_FONT_SIZE } from "../store/recentProjectsSlice";
import { FaCheck } from "react-icons/fa";
import { STATUSLINE_FEATURES, getStatuslineDefault } from "./TerminalHeader";
import ClearDataModal from "./ClearDataModal";
import type { TerminalType, ComposerExpansion } from "../types";
import type { VoiceLanguage, VoiceWhisperFormat, VoiceActivationMode } from "../store/voiceSlice";
import { pingWhisper } from "../lib/voice/whisperClient";
import { pingLlm } from "../lib/voice/llmClient";
import { pingTts } from "../lib/voice/ttsClient";
import { parseHotkey } from "../lib/voice/hotkey";
import { VOICE_ENABLED } from "../lib/voice/feature-flag";

// ─── Internal sub-components ───────────────────────────────────────────────

const SettingsSearchContext = createContext<{ query: string }>({ query: "" });

function ToggleSwitch({ checked, onChange, color }: { checked: boolean; onChange: (v: boolean) => void; color?: string }) {
  const accent = color ?? "var(--ezy-accent)";
  // Border stays in both states so the track's inner box never shifts by 1px
  // between off/on — that shift is what made the thumb read as off-center.
  return (
    <div
      role="switch"
      aria-checked={checked}
      tabIndex={0}
      onClick={() => onChange(!checked)}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") { e.preventDefault(); onChange(!checked); }
      }}
      style={{
        boxSizing: "border-box",
        width: 36,
        height: 20,
        borderRadius: 999,
        backgroundColor: checked ? accent : "transparent",
        border: `1px solid ${checked ? accent : "var(--ezy-border-light)"}`,
        position: "relative",
        transition: "background-color 150ms ease, border-color 150ms ease",
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
          top: 1,
          left: 1,
          transform: checked ? "translateX(16px)" : "translateX(0)",
          transition: "transform 150ms ease, background-color 150ms ease",
        }}
      />
    </div>
  );
}

function FontSizeStepper({ value, onChange, min = 10, max = 24 }: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  const step = (delta: number, blocked: boolean) => (
    <div
      onClick={() => { if (!blocked) onChange(Math.min(max, Math.max(min, value + delta))); }}
      style={{
        width: 24,
        height: 24,
        borderRadius: 4,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: blocked ? "default" : "pointer",
        opacity: blocked ? 0.3 : 1,
        backgroundColor: "transparent",
        border: "1px solid var(--ezy-border-light)",
        color: "var(--ezy-text-secondary)",
        fontSize: 14,
        lineHeight: 1,
        transition: "background-color 120ms ease",
        userSelect: "none",
      }}
      onMouseEnter={(e) => { if (!blocked) e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
    >
      {delta < 0 ? "-" : "+"}
    </div>
  );
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      {step(-1, value <= min)}
      <span style={{ fontSize: 13, color: "var(--ezy-text)", minWidth: 24, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
        {value}
      </span>
      {step(1, value >= max)}
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
              whiteSpace: "nowrap",
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
    <section id={id} data-settings-section style={{ paddingBottom: 32 }}>
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

function SettingsRow({ label, description, children, vertical }: {
  label: string;
  description?: string;
  children: React.ReactNode;
  vertical?: boolean;
}) {
  const { query } = useContext(SettingsSearchContext);
  if (query) {
    const haystack = `${label} ${description ?? ""}`.toLowerCase();
    if (!haystack.includes(query.toLowerCase())) return null;
  }
  if (vertical) {
    return (
      <div data-settings-row style={{
        display: "flex",
        flexDirection: "column",
        padding: "10px 0",
        gap: 8,
        borderBottom: "1px solid var(--ezy-border-subtle)",
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, color: "var(--ezy-text-secondary)" }}>{label}</div>
          {description && <div style={{ fontSize: 11, color: "var(--ezy-text-muted)", marginTop: 2, lineHeight: 1.3 }}>{description}</div>}
        </div>
        <div>{children}</div>
      </div>
    );
  }
  return (
    <div data-settings-row style={{
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
                data-tooltip={p.path}
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
  const showChangelogOnUpdate = useAppStore((s) => s.showChangelogOnUpdate);
  const setShowChangelogOnUpdate = useAppStore((s) => s.setShowChangelogOnUpdate);

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
      // Nothing is cached for the ChangelogModal here: a store write followed
      // by relaunch() never reaches disk (WebView2 flushes localStorage on a
      // delay, the process dies first). App.tsx fetches the release body on
      // the next launch instead.
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
    <SettingsSection id="updates" title="Updates">
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
          {/* Status sits on the button's baseline rather than on its own line
              below — it reads as the button's answer, not a new paragraph. */}
          {checkStatus === "up-to-date" && (
            <span style={{ fontSize: 13, color: "var(--ezy-accent)", lineHeight: 1 }}>
              Up to date
            </span>
          )}
          {checkStatus === "available" && latestVersion && (
            <span style={{ fontSize: 13, color: "var(--ezy-accent)", lineHeight: 1 }}>
              v{latestVersion} is available
            </span>
          )}
          {checkStatus === "installing" && (
            <span style={{ fontSize: 13, color: "var(--ezy-accent)", lineHeight: 1 }}>
              Installing update, restarting...
            </span>
          )}
        </div>
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
        {checkStatus === "error" && (
          <span style={{ fontSize: 12, color: "var(--ezy-red)" }}>
            {errorMsg || "Failed to check for updates"}
          </span>
        )}
        <div style={{ borderTop: "1px solid var(--ezy-border)", paddingTop: 14, marginTop: 4 }}>
          <SettingsRow
            label="Show changelog popup after updates"
            description="Shown on the next launch after an update."
          >
            <ToggleSwitch checked={showChangelogOnUpdate} onChange={setShowChangelogOnUpdate} />
          </SettingsRow>
        </div>
      </div>
    </SettingsSection>
  );
}

// ─── Voice agent section ──────────────────────────────────────────────────

/**
 * Dropdown. Deliberately NOT a native `<select>`.
 *
 * A native select opens an OS popup that needs activation, and MADE's window
 * management actively fights that: panes and the overlay answer
 * WM_MOUSEACTIVATE with MA_NOACTIVATE and the main window subclasses
 * WM_NCACTIVATE, so the popup lost activation and closed on the same click that
 * opened it. Every other dropdown in this app is custom-rendered for the same
 * reason; the one native `<select>` that works lives inside a modal, which
 * hides the panes and changes the activation picture entirely.
 *
 * The list is `position: fixed` off the button's measured rect rather than
 * absolutely positioned, because the settings pane is a scroll container with
 * `overflow: hidden` ancestors that would otherwise clip it.
 */
function Dropdown<T extends string>({
  value,
  onChange,
  options,
  width = 260,
  placeholder,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  width?: number;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  const measure = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const b = el.getBoundingClientRect();
    setRect({ left: b.left, top: b.bottom + 4, width: b.width });
  }, []);

  useEffect(() => {
    if (!open) return;
    measure();
    // These listeners are on `window` in the CAPTURE phase, so they run before
    // the event ever reaches React's root container — a React
    // `stopPropagation` on the popup cannot hold them off. Both dismissals
    // therefore have to test the target themselves:
    //   - pointerdown fired first and unmounted the popup before the option's
    //     click could land, so no option was ever selectable;
    //   - scroll fired for the popup's OWN overflow container, so it closed
    //     the moment you tried to scroll the list.
    const inside = (t: EventTarget | null) =>
      t instanceof Node &&
      (popRef.current?.contains(t) === true || btnRef.current?.contains(t) === true);
    const onPointerDown = (e: Event) => {
      if (!inside(e.target)) setOpen(false);
    };
    const onScroll = (e: Event) => {
      if (!inside(e.target)) setOpen(false);
    };
    // A resize invalidates the measured anchor outright, so always dismiss.
    const onResize = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, measure]);

  const current = options.find((o) => o.value === value);
  const label = current?.label ?? placeholder ?? "";

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onPointerDown={(e) => {
          // Keep the press off any ancestor drag/press handlers. The dismiss
          // listener above ignores this button by ref, not by propagation.
          e.stopPropagation();
        }}
        onClick={() => {
          measure();
          setOpen((v) => !v);
        }}
        style={{
          width,
          // Matches TextInput exactly so a dropdown and a field can sit side
          // by side without looking mismatched.
          padding: "5px 8px",
          fontSize: 12,
          fontFamily: "inherit",
          textAlign: "left",
          color: current ? "var(--ezy-text)" : "var(--ezy-text-muted)",
          backgroundColor: "var(--ezy-surface)",
          border: "1px solid var(--ezy-border)",
          borderRadius: 5,
          outline: "none",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          // The chevron sits directly after the label rather than pinned to the
          // far edge, which is what made the native control look unbalanced on
          // a wide field.
          gap: 8,
          lineHeight: 1.4,
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 12 12"
          fill="none"
          stroke="var(--ezy-text-muted)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ flexShrink: 0, transform: open ? "rotate(180deg)" : undefined }}
        >
          <polyline points="3,4.5 6,8 9,4.5" />
        </svg>
      </button>
      {open && rect && (
        <div
          ref={popRef}
          className="ezy-popup-scroll"
          style={{
            position: "fixed",
            left: rect.left,
            top: rect.top,
            width: rect.width,
            maxHeight: 280,
            overflowY: "auto",
            zIndex: 1000,
            padding: "4px 0",
            borderRadius: 6,
            backgroundColor: "var(--ezy-surface-raised)",
            border: "1px solid var(--ezy-border)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
          }}
        >
          {options.map((o) => {
            const selected = o.value === value;
            return (
              <div
                key={o.value}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                style={{
                  padding: "5px 10px",
                  fontSize: 12,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  color: selected ? "var(--ezy-text)" : "var(--ezy-text-secondary)",
                  backgroundColor: selected ? "var(--ezy-border-subtle)" : "transparent",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = "var(--ezy-border)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = selected
                    ? "var(--ezy-border-subtle)"
                    : "transparent";
                }}
              >
                {o.label}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  monospace,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  monospace?: boolean;
}) {
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width: 260,
        padding: "5px 8px",
        fontSize: 12,
        fontFamily: monospace ? "var(--ezy-font-mono, ui-monospace, Menlo, monospace)" : "inherit",
        color: "var(--ezy-text)",
        backgroundColor: "var(--ezy-surface)",
        border: "1px solid var(--ezy-border)",
        borderRadius: 5,
        outline: "none",
      }}
    />
  );
}

type PingState = { status: "idle" | "checking" | "ok" | "fail"; ms?: number; error?: string };

/**
 * Atlassian MCP state for the Jira section.
 *
 * Three states, deliberately distinct: connected, not set up, and unknown. The
 * last one matters — if the config could not be read we must not tell someone to
 * install a server they already have.
 */
function JiraPluginRow() {
  const terminalBackend = useAppStore((s) => s.terminalBackend);
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const backend = terminalBackend ?? getDefaultBackend();
  const projectPath = tabs.find((t) => t.id === activeTabId)?.workingDir;

  const [status, setStatus] = useState<JiraMcpStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void readJiraMcpStatus(backend, projectPath).then(setStatus);
  }, [backend, projectPath]);

  useEffect(refresh, [refresh]);

  const install = async () => {
    setBusy(true);
    setError(null);
    try {
      await installJiraMcp(backend);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const connected = !!status?.configured;
  const unknown = !!status && !status.checked;
  const label = connected
    ? status.scope === "user"
      ? "Connected"
      : `Connected (${status.scope})`
    : unknown
      ? "Unknown"
      : "Not set up";
  const dot = connected ? "#10b981" : unknown ? "var(--ezy-text-muted)" : "var(--ezy-red, #e55)";

  return (
    <SettingsRow
      label="Jira plugin"
      description={connected ? JIRA_MCP_AUTH_HINT : undefined}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {error && (
          <span
            data-tooltip={error}
            style={{
              fontSize: 10,
              color: "var(--ezy-red, #e55)",
              maxWidth: 150,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {error}
          </span>
        )}
        <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--ezy-text-secondary)" }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", backgroundColor: dot, flexShrink: 0 }} />
          {status === null ? "Checking…" : label}
        </span>
        {!connected && (
          <button
            onClick={install}
            disabled={busy}
            style={{
              padding: "4px 10px",
              fontSize: 11,
              fontWeight: 500,
              color: "var(--ezy-text-secondary)",
              backgroundColor: "var(--ezy-surface)",
              border: "1px solid var(--ezy-border)",
              borderRadius: 5,
              cursor: busy ? "default" : "pointer",
              fontFamily: "inherit",
            }}
          >
            {busy ? "Setting up…" : "Set up"}
          </button>
        )}
      </div>
    </SettingsRow>
  );
}

function TestButton({ onClick, state }: { onClick: () => void; state: PingState }) {
  const label =
    state.status === "checking" ? "Testing…" :
    state.status === "ok" ? `OK ${state.ms}ms` :
    state.status === "fail" ? "Failed" :
    "Test";
  const color =
    state.status === "ok" ? "#10b981" :
    state.status === "fail" ? "var(--ezy-red, #e55)" :
    "var(--ezy-text-secondary)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <button
        onClick={onClick}
        disabled={state.status === "checking"}
        style={{
          padding: "4px 10px",
          fontSize: 11,
          fontWeight: 500,
          color: "var(--ezy-text-secondary)",
          backgroundColor: "var(--ezy-surface)",
          border: "1px solid var(--ezy-border)",
          borderRadius: 5,
          cursor: state.status === "checking" ? "default" : "pointer",
          fontFamily: "inherit",
        }}
      >
        {label}
      </button>
      {state.status === "fail" && state.error && (
        <span data-tooltip={state.error} style={{ fontSize: 10, color, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {state.error}
        </span>
      )}
      {state.status === "ok" && (
        <span style={{ fontSize: 10, color }}>connected</span>
      )}
    </div>
  );
}

function HotkeyCapture({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [recording, setRecording] = useState(false);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    const parts: string[] = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    if (e.metaKey) parts.push("Meta");
    let key = e.key;
    if (key === " ") key = "Space";
    // Skip pure modifier keys
    if (["Control", "Alt", "Shift", "Meta"].includes(key)) return;
    parts.push(key.length === 1 ? key.toUpperCase() : key);
    onChange(parts.join("+"));
    setRecording(false);
  };

  return (
    <div
      onKeyDown={onKeyDown}
      tabIndex={0}
      onClick={() => setRecording(true)}
      onBlur={() => setRecording(false)}
      style={{
        minWidth: 160,
        padding: "5px 10px",
        fontSize: 12,
        color: recording ? "var(--ezy-text)" : "var(--ezy-text-secondary)",
        backgroundColor: recording ? "var(--ezy-accent-glow)" : "var(--ezy-surface)",
        border: `1px solid ${recording ? "var(--ezy-accent)" : "var(--ezy-border)"}`,
        borderRadius: 5,
        cursor: "pointer",
        outline: "none",
        textAlign: "center",
        fontFamily: "var(--ezy-font-mono, ui-monospace, Menlo, monospace)",
      }}
    >
      {recording ? "Press a key…" : (value || "Click to set")}
    </div>
  );
}

function VoiceAgentSection() {
  const voiceEnabled = useAppStore((s) => s.voiceEnabled);
  const setVoiceEnabled = useAppStore((s) => s.setVoiceEnabled);
  const whisperUrl = useAppStore((s) => s.whisperUrl);
  const setWhisperUrl = useAppStore((s) => s.setWhisperUrl);
  const whisperFormat = useAppStore((s) => s.whisperFormat);
  const setWhisperFormat = useAppStore((s) => s.setWhisperFormat);
  const llmUrl = useAppStore((s) => s.llmUrl);
  const setLlmUrl = useAppStore((s) => s.setLlmUrl);
  const llmModel = useAppStore((s) => s.llmModel);
  const setLlmModel = useAppStore((s) => s.setLlmModel);
  const ttsUrl = useAppStore((s) => s.ttsUrl);
  const setTtsUrl = useAppStore((s) => s.setTtsUrl);
  const ttsVoice = useAppStore((s) => s.ttsVoice);
  const setTtsVoice = useAppStore((s) => s.setTtsVoice);
  const language = useAppStore((s) => s.voiceLanguage);
  const setLanguage = useAppStore((s) => s.setVoiceLanguage);
  const activationMode = useAppStore((s) => s.voiceActivationMode);
  const setActivationMode = useAppStore((s) => s.setVoiceActivationMode);
  const pttHotkey = useAppStore((s) => s.pttHotkey);
  const setPttHotkey = useAppStore((s) => s.setPttHotkey);
  const confirmDestructive = useAppStore((s) => s.voiceConfirmDestructive);
  const setConfirmDestructive = useAppStore((s) => s.setVoiceConfirmDestructive);

  const [whisperPing, setWhisperPing] = useState<PingState>({ status: "idle" });
  const [llmPing, setLlmPing] = useState<PingState>({ status: "idle" });
  const [ttsPing, setTtsPing] = useState<PingState>({ status: "idle" });

  const testWhisper = async () => {
    setWhisperPing({ status: "checking" });
    try {
      const ms = await pingWhisper(whisperUrl);
      setWhisperPing({ status: "ok", ms });
    } catch (err) {
      setWhisperPing({ status: "fail", error: err instanceof Error ? err.message : String(err) });
    }
  };
  const testLlm = async () => {
    setLlmPing({ status: "checking" });
    try {
      const ms = await pingLlm(llmUrl, llmModel);
      setLlmPing({ status: "ok", ms });
    } catch (err) {
      setLlmPing({ status: "fail", error: err instanceof Error ? err.message : String(err) });
    }
  };
  const testTts = async () => {
    setTtsPing({ status: "checking" });
    try {
      const ms = await pingTts(ttsUrl);
      setTtsPing({ status: "ok", ms });
    } catch (err) {
      setTtsPing({ status: "fail", error: err instanceof Error ? err.message : String(err) });
    }
  };

  const hotkeyValid = !!parseHotkey(pttHotkey);

  return (
    <>
      <SettingsSection
        id="voice"
        title="Voice agent"
        description="Speak commands in English or Swedish. Whisper transcribes, a local LLM maps intent to actions."
      >
        <SettingsRow label="Enable voice agent" description="When off, the mic button and hotkey do nothing.">
          <ToggleSwitch checked={voiceEnabled} onChange={setVoiceEnabled} />
        </SettingsRow>
        <SettingsRow
          label="Activation"
          description="Toggle: click once to start, again to stop. Hold: speak while held, release to send."
        >
          <SegmentedControl<VoiceActivationMode>
            options={[
              { value: "toggle", label: "Toggle" },
              { value: "hold", label: "Hold" },
            ]}
            value={activationMode}
            onChange={setActivationMode}
          />
        </SettingsRow>
        <SettingsRow
          label={activationMode === "hold" ? "Hold-to-talk hotkey" : "Toggle hotkey"}
        >
          <HotkeyCapture value={pttHotkey} onChange={setPttHotkey} />
        </SettingsRow>
        {!hotkeyValid && pttHotkey && (
          <div style={{ fontSize: 11, color: "var(--ezy-red, #e55)", padding: "0 0 6px" }}>
            Hotkey "{pttHotkey}" is invalid. Click the field and press a new combination.
          </div>
        )}
        <SettingsRow label="Language" description="Used for transcription and the agent's replies.">
          <SegmentedControl<VoiceLanguage>
            options={[
              { value: "auto", label: "Auto" },
              { value: "en", label: "English" },
              { value: "sv", label: "Svenska" },
            ]}
            value={language}
            onChange={setLanguage}
          />
        </SettingsRow>
        <SettingsRow label="Confirm destructive actions" description="Voice commands ask first before closing tabs with content.">
          <ToggleSwitch checked={confirmDestructive} onChange={setConfirmDestructive} />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection id="voice-whisper" title="Whisper (speech-to-text)" description="Self-hosted MLX Whisper server reachable over Tailscale.">
        <SettingsRow label="Endpoint URL">
          <TextInput value={whisperUrl} onChange={setWhisperUrl} placeholder="http://<mac-mini-tailscale>:8765/transcribe" monospace />
        </SettingsRow>
        <SettingsRow label="Server format" description="The API shape your Whisper server exposes.">
          <SegmentedControl<VoiceWhisperFormat>
            options={[
              { value: "openai", label: "OpenAI-compat" },
              { value: "asr-webservice", label: "ASR" },
              { value: "custom", label: "Custom" },
            ]}
            value={whisperFormat}
            onChange={setWhisperFormat}
          />
        </SettingsRow>
        <SettingsRow label="Test connection">
          <TestButton onClick={testWhisper} state={whisperPing} />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection id="voice-llm" title="LLM (intent → action)" description="OpenAI-compatible endpoint with tool calling. Mistral Nemo and Qwen 2.5 handle Swedish well.">
        <SettingsRow label="Endpoint URL">
          <TextInput value={llmUrl} onChange={setLlmUrl} placeholder="http://<mac-mini-tailscale>:8765/v1/chat/completions" monospace />
        </SettingsRow>
        <SettingsRow label="Model">
          <TextInput value={llmModel} onChange={setLlmModel} placeholder="qwen2.5:14b" monospace />
        </SettingsRow>
        <SettingsRow label="Test connection">
          <TestButton onClick={testLlm} state={llmPing} />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection id="voice-tts" title="Text-to-speech (optional)" description="Leave blank for visual-only feedback.">
        <SettingsRow label="Endpoint URL">
          <TextInput value={ttsUrl} onChange={setTtsUrl} placeholder="http://mac-mini.tail-xxxxx.ts.net:5005/speak" monospace />
        </SettingsRow>
        <SettingsRow label="Voice" description="Server-specific voice id. Blank uses the default.">
          <TextInput value={ttsVoice} onChange={setTtsVoice} placeholder="" monospace />
        </SettingsRow>
        <SettingsRow label="Test connection">
          <TestButton onClick={testTts} state={ttsPing} />
        </SettingsRow>
      </SettingsSection>
    </>
  );
}

// ─── Nav sections ──────────────────────────────────────────────────────────

const NAV_SECTIONS = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "terminal", label: "Terminal" },
  { id: "browser", label: "Browser" },
  { id: "projects", label: "Projects" },
  { id: "editor", label: "Editor" },
  { id: "ai", label: "AI" },
  ...(VOICE_ENABLED ? [{ id: "voice", label: "Voice agent" }] : []),
  { id: "updates", label: "Updates" },
];

// ─── Main component ───────────────────────────────────────────────────────

export default function SettingsPane() {
  const [activeSection, setActiveSection] = useState(NAV_SECTIONS[0]?.id ?? "behavior");
  const [showClearModal, setShowClearModal] = useState(false);
  const [showReloadConfirm, setShowReloadConfirm] = useState(false);
  const [reloadRemember, setReloadRemember] = useState(false);
  // Native panes are child HWNDs — OS windows layered above the whole WebView.
  // No z-index can put DOM over them, so a fullscreen modal has to HIDE them
  // instead. Registering here is what drives NativePaneVisibilityCoordinator;
  // without it the dialog is buried, visible only in the gaps between panes.
  // useModalWhen (not useModal) because SettingsPane stays mounted when the
  // dialog is closed.
  useModalWhen("settings-reload-confirm", showReloadConfirm);
  const [cliExpanded, setCliExpanded] = useState<Partial<Record<TerminalType, boolean>>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const contentScrollRef = useRef<HTMLDivElement>(null);
  const trimmedQuery = searchQuery.trim();
  const isSearching = trimmedQuery.length > 0;

  useEffect(() => {
    if (searchOpen) {
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  }, [searchOpen]);

  useEffect(() => {
    contentScrollRef.current?.scrollTo({ top: 0 });
  }, [isSearching, activeSection]);

  const closeSearch = useCallback(() => {
    setSearchQuery("");
    setSearchOpen(false);
  }, []);

  // Store selectors
  const terminalBackend = useAppStore((s) => s.terminalBackend ?? "wsl");
  const setTerminalBackend = useAppStore((s) => s.setTerminalBackend);
  const alwaysShowTemplatePicker = useAppStore((s) => s.alwaysShowTemplatePicker);
  const setAlwaysShowTemplatePicker = useAppStore((s) => s.setAlwaysShowTemplatePicker);
  const restoreLastSession = useAppStore((s) => s.restoreLastSession);
  const setRestoreLastSession = useAppStore((s) => s.setRestoreLastSession);
  const autoInsertClipboardImage = useAppStore((s) => s.autoInsertClipboardImage);
  const setAutoInsertClipboardImage = useAppStore((s) => s.setAutoInsertClipboardImage);
  const maskImagePathsInTerminal = useAppStore((s) => s.maskImagePathsInTerminal);
  const setMaskImagePathsInTerminal = useAppStore((s) => s.setMaskImagePathsInTerminal);
  const watchScreenshotsFolder = useAppStore((s) => s.watchScreenshotsFolder ?? false);
  const setWatchScreenshotsFolder = useAppStore((s) => s.setWatchScreenshotsFolder);
  const screenshotsFolderOverride = useAppStore((s) => s.screenshotsFolderOverride ?? "");
  const setScreenshotsFolderOverride = useAppStore((s) => s.setScreenshotsFolderOverride);
  const rememberScreenshotWindow = useAppStore((s) => s.rememberScreenshotWindow ?? false);
  const setRememberScreenshotWindow = useAppStore((s) => s.setRememberScreenshotWindow);
  const showKanbanButton = useAppStore((s) => s.showKanbanButton ?? true);
  const setShowKanbanButton = useAppStore((s) => s.setShowKanbanButton);
  const copyOnSelect = useAppStore((s) => s.copyOnSelect);
  const setCopyOnSelect = useAppStore((s) => s.setCopyOnSelect);
  const perProjectEditor = useAppStore((s) => s.perProjectEditor);
  const setPerProjectEditor = useAppStore((s) => s.setPerProjectEditor);
  const editorWordWrap = useAppStore((s) => s.editorWordWrap ?? true);
  const setEditorWordWrap = useAppStore((s) => s.setEditorWordWrap);
  const showTabPath = useAppStore((s) => s.showTabPath);
  const setShowTabPath = useAppStore((s) => s.setShowTabPath);
  const confirmQuit = useAppStore((s) => s.confirmQuit);
  const confirmReloadPanes = useAppStore((s) => s.confirmReloadPanes ?? true);
  const setConfirmReloadPanes = useAppStore((s) => s.setConfirmReloadPanes);
  const claudeNotifChannel = useAppStore((s) => s.claudeNotifChannel ?? "");
  const setClaudeNotifChannelPref = useAppStore((s) => s.setClaudeNotifChannelPref);
  const setConfirmQuit = useAppStore((s) => s.setConfirmQuit);
  const slashCommandGhostText = useAppStore((s) => s.slashCommandGhostText);
  const setSlashCommandGhostText = useAppStore((s) => s.setSlashCommandGhostText);
  const openPanesInBackground = useAppStore((s) => s.openPanesInBackground);
  const setOpenPanesInBackground = useAppStore((s) => s.setOpenPanesInBackground);
  const wideGridLayout = useAppStore((s) => s.wideGridLayout);
  const setWideGridLayout = useAppStore((s) => s.setWideGridLayout);
  const redistributeOnClose = useAppStore((s) => s.redistributeOnClose);
  const setRedistributeOnClose = useAppStore((s) => s.setRedistributeOnClose);
  const autoMinimizeGameOnAiDone = useAppStore((s) => s.autoMinimizeGameOnAiDone);
  const setAutoMinimizeGameOnAiDone = useAppStore((s) => s.setAutoMinimizeGameOnAiDone);
  const autoStartServerCommand = useAppStore((s) => s.autoStartServerCommand);
  const setAutoStartServerCommand = useAppStore((s) => s.setAutoStartServerCommand);
  const pullWithRebase = useAppStore((s) => s.pullWithRebase);
  const setPullWithRebase = useAppStore((s) => s.setPullWithRebase);
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
  const defaultGeminiMdPath = useAppStore((s) => s.defaultGeminiMdPath);
  const setDefaultGeminiMdPath = useAppStore((s) => s.setDefaultGeminiMdPath);
  const defaultUseSingleSourcePointers = useAppStore((s) => s.defaultUseSingleSourcePointers);
  const setDefaultUseSingleSourcePointers = useAppStore((s) => s.setDefaultUseSingleSourcePointers);
  const customScaffolds = useAppStore((s) => s.customScaffolds);
  const addCustomScaffold = useAppStore((s) => s.addCustomScaffold);
  const updateCustomScaffold = useAppStore((s) => s.updateCustomScaffold);
  const removeCustomScaffold = useAppStore((s) => s.removeCustomScaffold);
  const commitMsgMode = useAppStore((s) => s.commitMsgMode ?? "simple");
  const setCommitMsgMode = useAppStore((s) => s.setCommitMsgMode);
  const shadowAiCli = useAppStore((s) => s.shadowAiCli ?? "claude");
  const setShadowAiCli = useAppStore((s) => s.setShadowAiCli);
  const jiraBaseUrl = useAppStore((s) => s.jiraBaseUrl ?? "");
  const setJiraBaseUrl = useAppStore((s) => s.setJiraBaseUrl);
  const jiraPromptTemplate = useAppStore((s) => s.jiraPromptTemplate ?? "");
  const setJiraPromptTemplate = useAppStore((s) => s.setJiraPromptTemplate);
  const jiraReplyInSwedish = useAppStore((s) => s.jiraReplyInSwedish ?? false);
  const setJiraReplyInSwedish = useAppStore((s) => s.setJiraReplyInSwedish);
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
  const projectPaneTint = useAppStore((s) => s.projectPaneTint);
  const setProjectPaneTint = useAppStore((s) => s.setProjectPaneTint);
  const hoverTooltips = useAppStore((s) => s.hoverTooltips);
  const setHoverTooltips = useAppStore((s) => s.setHoverTooltips);
  const nativeCursorStyle = useAppStore((s) => s.nativeCursorStyle);
  const setNativeCursorStyle = useAppStore((s) => s.setNativeCursorStyle);
  const nativeCursorBlink = useAppStore((s) => s.nativeCursorBlink);
  const setNativeCursorBlink = useAppStore((s) => s.setNativeCursorBlink);
  const useNativeTerminalRenderer = useAppStore((s) => s.useNativeTerminalRenderer);
  const scrollThumbAcceleration = useAppStore((s) => s.scrollThumbAcceleration);
  const wheelAcceleration = useAppStore((s) => s.wheelAcceleration);
  const termProgram = useAppStore((s) => s.termProgram);
  const setTermProgram = useAppStore((s) => s.setTermProgram);
  const termProgramVersion = useAppStore((s) => s.termProgramVersion);
  const [notifChannelState, setNotifChannelState] = useState<
    { status: "idle" | "ok" | "fail"; msg?: string }
  >({ status: "idle" });
  const setTermProgramVersion = useAppStore((s) => s.setTermProgramVersion);
  const setWheelAcceleration = useAppStore((s) => s.setWheelAcceleration);
  const setScrollThumbAcceleration = useAppStore((s) => s.setScrollThumbAcceleration);
  const setUseNativeTerminalRenderer = useAppStore((s) => s.setUseNativeTerminalRenderer);
  const nativeSharedGpu = useAppStore((s) => s.nativeSharedGpu);
  // Which backend/adapter the panes actually run on. Null until a native pane
  // exists — the adapter is only built once there is a surface to validate it
  // against, so before that there is genuinely nothing true to report.
  const [gpuInfo, setGpuInfo] = useState<GpuInfo | null>(null);
  useEffect(() => {
    let alive = true;
    void nativeTermGpuInfo()
      .then((i) => { if (alive) setGpuInfo(i); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  const setNativeSharedGpu = useAppStore((s) => s.setNativeSharedGpu);
  const browserIframeForLocalhost = useAppStore((s) => s.browserIframeForLocalhost);
  const setBrowserIframeForLocalhost = useAppStore((s) => s.setBrowserIframeForLocalhost);
  const browserAskBeforeDownload = useAppStore((s) => s.browserAskBeforeDownload);
  const setBrowserAskBeforeDownload = useAppStore((s) => s.setBrowserAskBeforeDownload);
  const aiTimeBursts = useAppStore((s) => s.aiTimeBursts);
  const clearAiTimeStats = useAppStore((s) => s.clearAiTimeStats);
  const verticalModeEnabled = useAppStore((s) => s.verticalModeEnabled);
  const setVerticalModeEnabled = useAppStore((s) => s.setVerticalModeEnabled);
  const theme = getTheme(themeId);

  // Render only the requested section's content
  const renderSection = (sectionId: string) => {
    switch (sectionId) {
      case "general":
        return (
          <>
            <SettingsSection id="behavior" title="Behavior">
              <SettingsRow label="Always show layout picker">
                <ToggleSwitch checked={alwaysShowTemplatePicker} onChange={setAlwaysShowTemplatePicker} />
              </SettingsRow>
              <SettingsRow label="Restore last session">
                <ToggleSwitch checked={restoreLastSession} onChange={setRestoreLastSession} />
              </SettingsRow>
              <SettingsRow label="Auto-paste screenshots">
                <ToggleSwitch checked={autoInsertClipboardImage} onChange={setAutoInsertClipboardImage} />
              </SettingsRow>
              <SettingsRow label="Mask image paths in terminal (beta)" description="Shows [Image #N] in place of the path. The CLI still receives the real path.">
                <ToggleSwitch checked={maskImagePathsInTerminal} onChange={setMaskImagePathsInTerminal} />
              </SettingsRow>
              <SettingsRow
                label="Remember the screenshot viewer's size"
                description="Off: it reopens centred at its default size every time. On: your last drag and resize stick."
              >
                <ToggleSwitch
                  checked={rememberScreenshotWindow}
                  onChange={setRememberScreenshotWindow}
                />
              </SettingsRow>
              <SettingsRow
                label="Watch the Screenshots folder"
                description="Catches snips that never reach the clipboard."
              >
                <ToggleSwitch checked={watchScreenshotsFolder} onChange={setWatchScreenshotsFolder} />
              </SettingsRow>
              {watchScreenshotsFolder && (
                <SettingsRow
                  label="Screenshots folder"
                  description="Leave empty to use the folder Windows reports."
                >
                  <PathPicker
                    value={screenshotsFolderOverride}
                    onChange={setScreenshotsFolderOverride}
                    directory
                  />
                </SettingsRow>
              )}
              <SettingsRow label="Show Kanban button in topbar">
                <ToggleSwitch checked={showKanbanButton} onChange={setShowKanbanButton} />
              </SettingsRow>
              <SettingsRow label="Copy on select">
                <ToggleSwitch checked={copyOnSelect} onChange={setCopyOnSelect} />
              </SettingsRow>
              <SettingsRow label="Hover tooltips" description="Off hides every hover tooltip. File links keep working.">
                <ToggleSwitch checked={hoverTooltips} onChange={setHoverTooltips} />
              </SettingsRow>
              <SettingsRow label="Show path in tabs" description="Double-click the name to rename it.">
                <ToggleSwitch checked={showTabPath} onChange={setShowTabPath} />
              </SettingsRow>
              <SettingsRow label="Confirm before quitting">
                <ToggleSwitch checked={confirmQuit} onChange={setConfirmQuit} />
              </SettingsRow>
              <SettingsRow
                label="Confirm before reloading panes"
                description="Turn back on to undo Remember in the reload dialog."
              >
                <ToggleSwitch checked={confirmReloadPanes} onChange={setConfirmReloadPanes} />
              </SettingsRow>
              <SettingsRow label="Auto-rotate topbar in portrait" description="Taller than wide swaps the topbar for a vertical tab strip.">
                <ToggleSwitch checked={verticalModeEnabled} onChange={setVerticalModeEnabled} />
              </SettingsRow>
              <SettingsRow label="Slash command ghost text" description="Inline suggestion as you type a slash command.">
                <ToggleSwitch checked={slashCommandGhostText} onChange={setSlashCommandGhostText} />
              </SettingsRow>
              <SettingsRow label="Open panes in background">
                <ToggleSwitch checked={openPanesInBackground} onChange={setOpenPanesInBackground} />
              </SettingsRow>
              <SettingsRow label="Wide grid layout" description="First 4 panes go side-by-side before stacking.">
                <ToggleSwitch checked={wideGridLayout} onChange={setWideGridLayout} />
              </SettingsRow>
              <SettingsRow label="Redistribute space on pane close" description="Off: only the neighbouring pane absorbs the space.">
                <ToggleSwitch checked={redistributeOnClose} onChange={setRedistributeOnClose} />
              </SettingsRow>
              <SettingsRow label="Auto-hide games when AI done">
                <ToggleSwitch checked={autoMinimizeGameOnAiDone} onChange={setAutoMinimizeGameOnAiDone} />
              </SettingsRow>
              <SettingsRow label="Auto-start server command" description="Reopening a project restarts its dev server.">
                <ToggleSwitch checked={autoStartServerCommand} onChange={setAutoStartServerCommand} />
              </SettingsRow>
              <SettingsRow label="Prefer rebase when pulling" description="Replays local commits instead of making a merge commit.">
                <ToggleSwitch checked={pullWithRebase} onChange={setPullWithRebase} />
              </SettingsRow>
            </SettingsSection>
            <SettingsSection id="danger-zone" title="Danger Zone" description="Clear MADE's local storage. Your files on disk are not affected.">
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

      case "appearance":
        return (
          <>
            <SettingsSection id="theme" title="Theme">
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
                        // The border stays 1px in every state. It used to go to
                        // 2px when selected, and since these cards are
                        // auto-height that added 2px of box on selection — every
                        // card in the grid shifted as you clicked around. The
                        // selected ring is an inset shadow instead: same look,
                        // zero layout cost.
                        border: "1px solid",
                        borderColor: isSelected ? "var(--ezy-accent)" : "var(--ezy-border)",
                        boxShadow: isSelected ? "inset 0 0 0 1px var(--ezy-accent)" : "none",
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
              <SettingsRow label="Vibrant colors">
                <ToggleSwitch checked={vibrantColors} onChange={setVibrantColors} />
              </SettingsRow>
              <SettingsRow label="Project color pane tint" description="Washes each pane toward its project's tab color.">
                <ToggleSwitch checked={projectPaneTint} onChange={setProjectPaneTint} />
              </SettingsRow>
            </SettingsSection>
            <SettingsSection id="cursor" title="Cursor" description="Applies to the native terminal renderer.">
              <SettingsRow label="Cursor style">
                <SegmentedControl<"bar" | "block" | "underline">
                  options={[
                    { value: "bar", label: "Bar" },
                    { value: "block", label: "Block" },
                    { value: "underline", label: "Underline" },
                  ]}
                  value={nativeCursorStyle}
                  onChange={setNativeCursorStyle}
                />
              </SettingsRow>
              <SettingsRow label="Cursor blink">
                <ToggleSwitch checked={nativeCursorBlink} onChange={setNativeCursorBlink} />
              </SettingsRow>
            </SettingsSection>
            <SettingsSection id="cli" title="CLI Options">
            {(["claude", "codex", "gemini"] as TerminalType[]).map((cliType) => {
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
                    <FontSizeStepper
                      value={cliFontSizes[cliType] ?? DEFAULT_CLI_FONT_SIZE}
                      onChange={(v) => setCliFontSize(cliType, v)}
                    />
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
                      const allOn = visibleKeys.every((k) => statuslineToggles[cliType]?.[k] ?? getStatuslineDefault(k));
                      const allOff = visibleKeys.every((k) => !(statuslineToggles[cliType]?.[k] ?? getStatuslineDefault(k)));
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
                        const isOn = statuslineToggles[cliType]?.[key] ?? getStatuslineDefault(key);
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

      case "browser":
        return (
          <>
            <SettingsSection id="browser" title="Browser">
              <SettingsRow
                label="Use the legacy preview for dev servers"
                description="Only affects localhost. Websites always use the native browser — the legacy preview cannot load them."
              >
                <ToggleSwitch checked={browserIframeForLocalhost} onChange={setBrowserIframeForLocalhost} />
              </SettingsRow>
              <SettingsRow
                label="Ask before saving a download"
                description="Off saves straight to Downloads like Chrome. On keeps files off disk until you approve, but it re-requests the file, which some one-time download links will not allow."
              >
                <ToggleSwitch checked={browserAskBeforeDownload} onChange={setBrowserAskBeforeDownload} />
              </SettingsRow>
            </SettingsSection>
          </>
        );

      case "terminal":
        return (
          <>
            {isWindows() && (
              <SettingsSection id="terminal-backend" title="Backend" description="Fallback when a project's path doesn't say WSL or Windows. A per-project setting overrides it.">
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
            <SettingsSection id="native-renderer" title="Native renderer">
              <SettingsRow label="Native terminal renderer (beta)" description="GPU renderer instead of xterm panes. Open terminals reload.">
                <ToggleSwitch checked={useNativeTerminalRenderer} onChange={setUseNativeTerminalRenderer} />
              </SettingsRow>
              <SettingsRow
                label="Share one GPU device (experimental)"
                description="Native panes share a single GPU device instead of building their own — measured ~4x faster to open a pane. The trade: a driver reset affects every shared pane at once instead of one. Applies to panes you open after flipping this; open panes keep the device they started with."
              >
                <ToggleSwitch checked={nativeSharedGpu} onChange={setNativeSharedGpu} />
              </SettingsRow>
              <SettingsRow
                label="Graphics backend"
                description={
                  gpuInfo
                    ? "Chosen automatically. Shown because it is the first thing worth knowing when a pane renders wrong."
                    : "Available once a native pane is open — the adapter is picked when the first pane creates its surface."
                }
              >
                <span style={{ fontSize: 12, color: "var(--ezy-text-muted)", textAlign: "right" }}>
                  {gpuInfo
                    ? `${gpuInfo.backend} · ${gpuInfo.name}${gpuInfo.shared ? "" : " (per-pane adapter)"}`
                    : "—"}
                </span>
              </SettingsRow>
              <SettingsRow
                vertical
                label="Report terminal type to AI CLIs (TERM_PROGRAM)"
                description="Claude enables synchronized output, progress and notifications only for terminals it recognises. If a feature stays quiet, pick another. Applies to the next pane you open."
              >
                <div className="flex items-center gap-2">
                  <Dropdown<string>
                    value={termProgram}
                    onChange={setTermProgram}
                    options={[
                      { value: "", label: "Off — report nothing" },
                      ...KNOWN_TERM_PROGRAMS.map((n) => ({ value: n as string, label: n })),
                    ]}
                    width={200}
                  />
                  <TextInput
                    value={termProgramVersion}
                    onChange={setTermProgramVersion}
                    placeholder="version (blank = default)"
                    monospace
                  />
                </div>
              </SettingsRow>
              <SettingsRow
                vertical
                label="Claude notification channel"
                description="Which escape sequence Claude sends when it wants your attention. MADE turns iTerm2, Kitty and Ghostty into an in-app toast; Terminal Bell carries no message. Applies to new sessions."
              >
                <div className="flex items-center gap-2">
                  <Dropdown<ClaudeNotifChannel | "">
                    // Mirrors what MADE last wrote into Claude's settings.json.
                    // This used to be hardcoded to "" with a placeholder option,
                    // so the control snapped back to "Choose a channel…" after
                    // every pick and looked like it never saved. There is no
                    // read-back command (setters only), hence the local mirror.
                    value={claudeNotifChannel as ClaudeNotifChannel | ""}
                    placeholder="Not set"
                    onChange={(v) => {
                      if (!v) return;
                      const prev = claudeNotifChannel;
                      setNotifChannelState({ status: "idle" });
                      setClaudeNotifChannelPref(v); // optimistic — reverted below on failure
                      void setClaudeNotifChannel(v as ClaudeNotifChannel, "wsl")
                        .then((path) =>
                          setNotifChannelState({ status: "ok", msg: `Set to "${v}" in ${path}` }),
                        )
                        .catch((e) => {
                          setClaudeNotifChannelPref(prev);
                          setNotifChannelState({ status: "fail", msg: String(e) });
                        });
                    }}
                    options={[
                      { value: "ghostty", label: "Ghostty (OSC 777) — recommended" },
                      { value: "iterm2", label: "iTerm2 (OSC 9)" },
                      { value: "kitty", label: "Kitty (OSC 99)" },
                      { value: "iterm2+bell", label: "iTerm2 w/ Bell" },
                      { value: "auto", label: "Auto (follow terminal type)" },
                      { value: "bell", label: "Terminal Bell — no toast" },
                      { value: "none", label: "Disabled" },
                    ]}
                    width={280}
                  />
                  {notifChannelState.status !== "idle" && (
                    <span
                      style={{
                        fontSize: 11,
                        color:
                          notifChannelState.status === "ok"
                            ? "var(--ezy-accent)"
                            : "var(--ezy-red)",
                      }}
                      data-tooltip={notifChannelState.msg}
                    >
                      {notifChannelState.status === "ok" ? "Applied" : "Failed"}
                    </span>
                  )}
                </div>
              </SettingsRow>
              <SettingsRow label="Mouse wheel acceleration" description="Scroll faster to travel further per notch. Fullscreen CLIs do their own acceleration.">
                <ToggleSwitch checked={wheelAcceleration} onChange={setWheelAcceleration} />
              </SettingsRow>
              <SettingsRow label="Scroll thumb acceleration" description="Off is a strict 1:1 drag, so the top of the bar is the top of the buffer.">
                <ToggleSwitch checked={scrollThumbAcceleration} onChange={setScrollThumbAcceleration} />
              </SettingsRow>
            </SettingsSection>
          </>
        );

      case "projects":
        return (
          <SettingsSection id="projects" title="Projects">
            <SettingsRow label="Projects directory">
              <PathPicker value={projectsDir} onChange={setProjectsDir} directory />
            </SettingsRow>
            <SettingsRow label="Default CLAUDE.md" description="Copied into new projects, for Claude Code.">
              <PathPicker value={defaultClaudeMdPath} onChange={setDefaultClaudeMdPath} filters={[{ name: "Markdown", extensions: ["md"] }]} />
            </SettingsRow>
            <SettingsRow label="Default AGENTS.md" description="Copied into new projects, for Codex and other agents.">
              <PathPicker value={defaultAgentsMdPath} onChange={setDefaultAgentsMdPath} filters={[{ name: "Markdown", extensions: ["md"] }]} />
            </SettingsRow>
            <SettingsRow label="Default GEMINI.md" description="Copied into new projects, for Gemini CLI.">
              <PathPicker value={defaultGeminiMdPath} onChange={setDefaultGeminiMdPath} filters={[{ name: "Markdown", extensions: ["md"] }]} />
            </SettingsRow>
            <SettingsRow label="Single source + pointers by default" description="AGENTS.md holds the instructions; the others become pointers to it.">
              <ToggleSwitch checked={defaultUseSingleSourcePointers} onChange={setDefaultUseSingleSourcePointers} />
            </SettingsRow>
            <SettingsRow
              label="Custom scaffolds"
              description="Extra .md templates offered when creating a project. No path characters in filenames."
              vertical
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 6, width: "100%" }}>
                {customScaffolds.map((scaffold) => {
                  const filenameInvalid =
                    scaffold.filename.length > 0 && /[/\\:*?"<>|]/.test(scaffold.filename);
                  return (
                    <div
                      key={scaffold.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "6px 8px",
                        border: "1px solid var(--ezy-border)",
                        borderRadius: 6,
                        backgroundColor: "var(--ezy-surface)",
                      }}
                    >
                      <input
                        type="text"
                        value={scaffold.filename}
                        onChange={(e) =>
                          updateCustomScaffold(scaffold.id, { filename: e.target.value })
                        }
                        placeholder="STYLE.md"
                        style={{
                          flex: "0 0 140px",
                          padding: "4px 8px",
                          fontSize: 12,
                          color: "var(--ezy-text)",
                          backgroundColor: "var(--ezy-surface-raised)",
                          border: `1px solid ${filenameInvalid ? "#e55" : "var(--ezy-border)"}`,
                          borderRadius: 5,
                          outline: "none",
                          fontFamily: "inherit",
                        }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <PathPicker
                          value={scaffold.templatePath}
                          onChange={(v) => updateCustomScaffold(scaffold.id, { templatePath: v })}
                          filters={[{ name: "Markdown", extensions: ["md"] }]}
                        />
                      </div>
                      <label
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          fontSize: 11,
                          color: "var(--ezy-text-secondary)",
                          cursor: "pointer",
                          userSelect: "none",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={scaffold.enabledByDefault}
                          onChange={(e) =>
                            updateCustomScaffold(scaffold.id, {
                              enabledByDefault: e.target.checked,
                            })
                          }
                        />
                        Default
                      </label>
                      <button
                        onClick={() => removeCustomScaffold(scaffold.id)}
                        aria-label="Remove"
                        style={{
                          padding: "2px 8px",
                          fontSize: 14,
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
                    </div>
                  );
                })}
                <button
                  onClick={addCustomScaffold}
                  style={{
                    alignSelf: "flex-start",
                    padding: "5px 12px",
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
                  + Add custom scaffold
                </button>
              </div>
            </SettingsRow>
          </SettingsSection>
        );

      case "editor":
        return (
          <>
            <SettingsSection id="texteditor" title="Text Editor">
              <SettingsRow
                label="Wrap long lines"
                description="The markdown preview always wraps, whatever this is set to."
              >
                <ToggleSwitch checked={editorWordWrap} onChange={setEditorWordWrap} />
              </SettingsRow>
              <SettingsRow
                label="Separate editor per project"
                description="Off: one shared editor — closing it closes it everywhere."
              >
                <ToggleSwitch checked={perProjectEditor} onChange={setPerProjectEditor} />
              </SettingsRow>
            </SettingsSection>
            <SettingsSection id="composer" title="MadeComposer" description="The prompt composer overlay (Ctrl+I).">
              <SettingsRow label="Enable MadeComposer">
                <ToggleSwitch checked={promptComposerEnabled} onChange={setPromptComposerEnabled} />
              </SettingsRow>
              {promptComposerEnabled && (
                <>
                  <SettingsRow label="Always visible">
                    <ToggleSwitch checked={promptComposerAlwaysVisible} onChange={setPromptComposerAlwaysVisible} />
                  </SettingsRow>
                  <SettingsRow label="Expansion direction">
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
            <SettingsSection id="preview" title="Preview Panes">
              <SettingsRow label="Full column" description="Browser pane takes a whole column in split layouts.">
                <ToggleSwitch checked={browserFullColumn} onChange={setBrowserFullColumn} />
              </SettingsRow>
              <SettingsRow label="Spawn on left">
                <ToggleSwitch checked={browserSpawnLeft} onChange={setBrowserSpawnLeft} />
              </SettingsRow>
            </SettingsSection>
            <SettingsSection id="codereview" title="Code Review">
              <SettingsRow label="Collapse all files" description="Diffs start collapsed.">
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
                onClick={() => window.dispatchEvent(new Event("made:open-snippets"))}
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
                onClick={() => window.dispatchEvent(new Event("made:open-shortcuts"))}
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
            <SettingsSection id="ai" title="AI Sessions">
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
            <SettingsSection id="jira" title="Jira">
              <JiraPluginRow />
              <SettingsRow label="Jira address">
                <TextInput
                  value={jiraBaseUrl}
                  onChange={setJiraBaseUrl}
                  placeholder="https://yourcompany.atlassian.net"
                />
              </SettingsRow>
              <SettingsRow
                label="Ticket prompt"
                description="{ticket} is replaced with the ticket number."
                vertical
              >
                <textarea
                  value={jiraPromptTemplate}
                  onChange={(e) => setJiraPromptTemplate(e.target.value)}
                  rows={4}
                  spellCheck={false}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "6px 8px",
                    fontSize: 12,
                    lineHeight: 1.5,
                    fontFamily: "inherit",
                    resize: "vertical",
                    color: "var(--ezy-text)",
                    backgroundColor: "var(--ezy-surface)",
                    border: "1px solid var(--ezy-border)",
                    borderRadius: 5,
                    outline: "none",
                  }}
                />
              </SettingsRow>
              <SettingsRow label="Reply in Swedish">
                <ToggleSwitch
                  checked={jiraReplyInSwedish}
                  onChange={setJiraReplyInSwedish}
                />
              </SettingsRow>
            </SettingsSection>
            <AiTimeStatsSection bursts={aiTimeBursts} onClear={clearAiTimeStats} />
          </>
        );

      case "voice":
        return VOICE_ENABLED ? <VoiceAgentSection /> : null;

      case "updates":
        return <UpdatesSection />;

      default:
        return null;
    }
  };

  return (
    <div
      data-settings-search-active={isSearching ? "" : undefined}
      style={{
        display: "flex",
        height: "100%",
        width: 620,
        flexShrink: 0,
        borderRight: "1px solid var(--ezy-border)",
        backgroundColor: "var(--ezy-bg)",
        color: "var(--ezy-text)",
      }}
    >
      <style>{`
        [data-settings-search-active] [data-settings-section]:not(:has([data-settings-row])) {
          display: none;
        }
        /* Inter-section spacing, but none trailing the last one — the scroll
           container's own padding closes out the page. !important because the
           32px lives in an inline style. */
        [data-settings-section]:last-of-type {
          padding-bottom: 0 !important;
        }
      `}</style>
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
          padding: "0 12px 12px 16px",
          gap: 4,
          minHeight: 22,
        }}>
          {!searchOpen && (
            <span style={{
              fontSize: 11,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "var(--ezy-text-muted)",
              flex: 1,
              minWidth: 0,
            }}>Settings</span>
          )}
          {searchOpen && (
            <div style={{
              display: "flex",
              alignItems: "center",
              flex: 1,
              minWidth: 0,
              height: 22,
              padding: "0 6px",
              borderRadius: 4,
              backgroundColor: "var(--ezy-surface)",
              gap: 6,
              transition: "width 160ms ease",
            }}>
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--ezy-text-muted)", flexShrink: 0 }}>
                <circle cx="7" cy="7" r="5" />
                <path d="m11 11 3 3" />
              </svg>
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    closeSearch();
                  }
                }}
                style={{
                  flex: 1,
                  minWidth: 0,
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  padding: 0,
                  fontFamily: "inherit",
                  fontSize: 12,
                  color: "var(--ezy-text)",
                }}
              />
              <button
                type="button"
                data-tooltip="Close search (Esc)" aria-label="Close search (Esc)"
                onClick={closeSearch}
                style={{
                  width: 16,
                  height: 16,
                  padding: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: "transparent",
                  border: "none",
                  borderRadius: 3,
                  color: "var(--ezy-text-muted)",
                  cursor: "pointer",
                  flexShrink: 0,
                  transition: "color 120ms ease",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--ezy-text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--ezy-text-muted)"; }}
              >
                <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 3l10 10M13 3 3 13" />
                </svg>
              </button>
            </div>
          )}
          {!searchOpen && (
            <>
              <button
                type="button"
                aria-label="Search settings"
                onClick={() => setSearchOpen(true)}
                style={{
                  width: 22,
                  height: 22,
                  padding: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: "transparent",
                  border: "none",
                  borderRadius: 4,
                  color: "var(--ezy-text-muted)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  flexShrink: 0,
                  transition: "background-color 120ms ease, color 120ms ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
                  e.currentTarget.style.color = "var(--ezy-text)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "transparent";
                  e.currentTarget.style.color = "var(--ezy-text-muted)";
                }}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="7" cy="7" r="5" />
                  <path d="m11 11 3 3" />
                </svg>
              </button>
              <button
                type="button"
                data-tooltip="Reload all panes (CTRL+SHIFT+R)" aria-label="Reload all panes (CTRL+SHIFT+R)"
                onClick={() => {
                  if (confirmReloadPanes) {
                    setReloadRemember(false);
                    setShowReloadConfirm(true);
                  } else {
                    window.location.reload();
                  }
                }}
                style={{
                  width: 22,
                  height: 22,
                  padding: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: "transparent",
                  border: "none",
                  borderRadius: 4,
                  color: "var(--ezy-text-muted)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  flexShrink: 0,
                  transition: "background-color 120ms ease, color 120ms ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
                  e.currentTarget.style.color = "var(--ezy-text)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "transparent";
                  e.currentTarget.style.color = "var(--ezy-text-muted)";
                }}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M13.5 4.5A6 6 0 1 0 14 9" />
                  <path d="M14 2v3h-3" />
                </svg>
              </button>
            </>
          )}
        </div>
        {!isSearching && NAV_SECTIONS.map((s) => {
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

      {/* Right content area — only the active section, or all sections during search */}
      <div ref={contentScrollRef} style={{
        flex: 1,
        overflowY: "auto",
        // Was "24px 24px 60px", which stacked on top of the last section's own
        // 32px padding — 92px of empty space that pushed a scrollbar onto tabs
        // that otherwise fit. The last section's padding is zeroed in the style
        // block above, so the trailing gap now matches the leading one.
        padding: 24,
      }}>
        <SettingsSearchContext.Provider value={{ query: trimmedQuery }}>
          {isSearching
            ? NAV_SECTIONS.map((s) => (
                <Fragment key={s.id}>{renderSection(s.id)}</Fragment>
              ))
            : (
                // Keyed by section so switching tabs REMOUNTS the subtree.
                // Without it React reconciles positionally and reuses the same
                // DOM nodes, so a toggle landing where a differently-valued one
                // sat animates its knob across on arrival — the transition is
                // doing exactly what it should, on an element that should never
                // have been recycled.
                <Fragment key={activeSection}>{renderSection(activeSection)}</Fragment>
              )}
        </SettingsSearchContext.Provider>
      </div>

      {showClearModal && <ClearDataModal onClose={() => setShowClearModal(false)} />}

      {/* Reload confirmation — same shape as TabBar's quit dialog so the two
          destructive confirmations look and behave identically. */}
      {showReloadConfirm && (
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
          onClick={(e) => { if (e.target === e.currentTarget) setShowReloadConfirm(false); }}
        >
          <div
            style={{
              backgroundColor: "var(--ezy-surface-raised)",
              border: "1px solid var(--ezy-border)",
              borderRadius: 10,
              boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
              padding: "24px 28px 20px",
              width: 340,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--ezy-text)" }}>
              Are you sure you want to reload all panes?
            </div>
            {/* Remember shares the action row: the choice and the buttons that
                commit it belong on one line, and it saves a row of height. */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginTop: 4 }}>
              <div
                style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", minWidth: 0 }}
                onClick={() => setReloadRemember((v) => !v)}
              >
                <div
                  style={{
                    width: 15,
                    height: 15,
                    borderRadius: 3,
                    border: reloadRemember ? "none" : "1px solid var(--ezy-border-light)",
                    backgroundColor: reloadRemember ? "var(--ezy-accent)" : "transparent",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    transition: "background-color 120ms ease",
                  }}
                >
                  {reloadRemember && <FaCheck size={9} color="#fff" />}
                </div>
                <span style={{ fontSize: 12, color: "var(--ezy-text-muted)" }}>Remember</span>
              </div>
              <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              <div
                onClick={() => setShowReloadConfirm(false)}
                style={{
                  padding: "6px 16px",
                  fontSize: 12,
                  fontWeight: 500,
                  borderRadius: 6,
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
                  // Persist the opt-out BEFORE the reload tears the page down.
                  // Unlike relaunch(), location.reload() keeps the process alive,
                  // so WebView2 still commits the localStorage write.
                  if (reloadRemember) setConfirmReloadPanes(false);
                  setShowReloadConfirm(false);
                  window.location.reload();
                }}
                style={{
                  padding: "6px 16px",
                  fontSize: 12,
                  fontWeight: 500,
                  borderRadius: 6,
                  cursor: "pointer",
                  border: "none",
                  color: "#fff",
                  backgroundColor: "var(--ezy-accent-dim)",
                  transition: "background-color 120ms ease",
                }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-accent-hover)"}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-accent-dim)"}
              >
                OK
              </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
