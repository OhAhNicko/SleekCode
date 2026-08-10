import { useState, useMemo, useCallback, useEffect, useRef, useContext, createContext, Fragment } from "react";
import LoadingDots from "./LoadingDots";
import { nativeTermGpuInfo, nativeTermListMonoFonts, type GpuInfo } from "../lib/native-term-bridge";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { invoke, Channel } from "@tauri-apps/api/core";
import { useJiraNotifyStore } from "../store/jiraNotifyStore";
import { confirmAction, promptForInput } from "../lib/prompt-modal";
import { getCachedDistro, clearWslCliCache, resolveWslCliPaths } from "../lib/wsl-cache";
import { getTerminalActions } from "../lib/terminal-actions";
import { findAllTerminalIds } from "../lib/layout-utils";
import { RELEASES_REPO } from "../lib/release-notes";
import { open } from "@tauri-apps/plugin-dialog";
import { KNOWN_TERM_PROGRAMS } from "../lib/terminal-config";
import {
  setClaudeNotifChannel,
  getGeminiNotifications,
  setGeminiNotifications,
  type ClaudeNotifChannel,
} from "../lib/sessions-index";
import { useAppStore } from "../store";
import { useModalWhen } from "../store/modalCoordinationSlice";
import type { AiTimeBurst } from "../store/aiTimeSlice";
import { THEMES, getTheme, getEffectiveTerminalTheme, SEMANTIC_DIFF_ADD, SEMANTIC_DIFF_REMOVE } from "../lib/themes";
import {
  ANSI_OVERRIDE_KEYS,
  CORE_OVERRIDE_KEYS,
  OVERRIDE_KEYS,
  OVERRIDE_KEY_LABELS,
  type ColorOverrides,
  type OverrideKey,
} from "../lib/color-overrides";
import ColorSwatchPicker, { normalizeHexColor } from "./ColorSwatchPicker";
import TerminalColorsPreview from "./TerminalColorsPreview";
import { UI_FONT_OPTIONS, UI_FONT_SIZE_MIN, UI_FONT_SIZE_MAX, type UiFont } from "../lib/ui-fonts";
import { APP_ICON_OPTIONS, applyAppIcon } from "../lib/app-icon";
import { AppIconPreview } from "./AppIconPreview";
import { getDefaultBackend } from "../lib/platform";
import { previewSound } from "../lib/notification-sounds";
import {
  readJiraMcpStatus,
  installJiraMcp,
  JIRA_MCP_AUTH_HINT,
  JIRA_CLI_LABEL,
  JIRA_CLIS,
  CODEX_MCP_SSH_AUTH,
  type JiraCli,
  type JiraMcpStatus,
} from "../lib/jira-mcp";
import { pickExecShell } from "../lib/remote-cli-shells";
import { jiraSiteName } from "../lib/jira";
import {
  AI_CLIS,
  AI_CLI_LABEL,
  backendLabel,
  cliStatus,
  invalidateCliStatus,
  type AiCli,
  type CliStatus,
} from "../lib/cli-availability";
import { requestCliInstall } from "../lib/cli-install-modal";
import { pendingSettingsSection } from "../lib/settings-section";
import { TERMINAL_CONFIGS } from "../lib/terminal-config";
import { isWindows } from "../lib/platform";
import { currentIsoWeek } from "../lib/iso-week";
import {
  DEFAULT_CLI_FONT_SIZE,
  DEFAULT_JIRA_HEADER_SHOW,
  DEFAULT_JIRA_RAIL_WIDTHS,
  DEFAULT_JIRA_ROW_META_SHOW,
  JIRA_RAIL_MAX_WIDTH,
  JIRA_RAIL_MIN_WIDTH,
  type DevServerTabIconMode,
} from "../store/recentProjectsSlice";
import { buildStatusColorMap, normalizeStatus } from "../lib/jira-status-colors";
import { pickableFields } from "../lib/jira-fields";
import { requestSettingsSection } from "../lib/settings-section";
import type { JiraFieldMeta } from "../store/recentProjectsSlice";
import { FaCheck } from "react-icons/fa";
import { STATUSLINE_FEATURES, getStatuslineDefault } from "./TerminalHeader";
import ClearDataModal from "./ClearDataModal";
import type { TerminalType, TerminalBackend, ComposerExpansion } from "../types";
import type { VoiceLanguage, VoiceWhisperFormat, VoiceActivationMode } from "../store/voiceSlice";
import { pingWhisper } from "../lib/voice/whisperClient";
import { pingLlm } from "../lib/voice/llmClient";
import { pingTts } from "../lib/voice/ttsClient";
import { parseHotkey } from "../lib/voice/hotkey";
import { VOICE_ENABLED } from "../lib/voice/feature-flag";
import { useKnowledgeStore } from "../store/knowledgeStore";
import { canonicalProjectKey, MEMORY_DIR_NAME } from "../lib/knowledge/keys";
import { usableKnowledgePath } from "../lib/knowledge/remote-mirror";
import KnowledgeMcpRow from "./knowledge/KnowledgeMcpRow";
import {
  KNOWLEDGE_CLIS,
  connectionLine,
  readKnowledgeMcpConnections,
  type KnowledgeMcpConnection,
} from "../lib/knowledge/mcp";

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

function FontSizeStepper({ value, onChange, min = 10, max = 24, suffix = "", stepSize = 1 }: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  suffix?: string;
  stepSize?: number;
}) {
  const step = (delta: number, blocked: boolean) => (
    <div
      onClick={() => { if (!blocked) onChange(Math.min(max, Math.max(min, value + delta))); }}
      style={{
        width: 24,
        height: 24,
        borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: blocked ? "default" : "pointer",
        opacity: blocked ? 0.3 : 1,
        backgroundColor: "transparent",
        border: "1px solid var(--ezy-border-light)",
        color: "var(--ezy-text-secondary)",
        fontSize: "calc(var(--ezy-font-scale, 1) * 14px)",
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
      {step(-stepSize, value <= min)}
      <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 13px)", color: "var(--ezy-text)", minWidth: 24, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
        {value}{suffix}
      </span>
      {step(stepSize, value >= max)}
    </div>
  );
}

/** Slider + numeric readout + a reset. Built on a native `input[type=range]`
 *  so keyboard control, the focus ring and OS accessibility all come for free;
 *  `accent-color` is the whole theming story, and Chromium/WebKit both honour
 *  it. The reset DISABLES at the default rather than sitting there as a no-op,
 *  which is also how a user learns what "Default" would give them. */
function SliderWithReset({ value, onChange, onReset, isDefault, min, max, step, resetLabel = "Default" }: {
  value: number;
  onChange: (v: number) => void;
  onReset: () => void;
  /** Value already equals the default, so the reset has nothing to do. */
  isDefault: boolean;
  min: number;
  max: number;
  step: number;
  resetLabel?: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 180 }}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ flex: 1, minWidth: 96, accentColor: "var(--ezy-accent)", cursor: "pointer" }}
      />
      {/* String(2.25) is already "2.25" and String(2) is "2" — no formatter
          needed, and tabular-nums stops the row twitching as digits change. */}
      <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 13px)", color: "var(--ezy-text)", minWidth: 30, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        {String(value)}
      </span>
      <button
        onClick={() => { if (!isDefault) onReset(); }}
        disabled={isDefault}
        style={{
          padding: "0 8px",
          height: 24,
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
          border: "1px solid var(--ezy-border-light)",
          backgroundColor: "transparent",
          color: "var(--ezy-text-secondary)",
          fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
          fontFamily: "inherit",
          lineHeight: 1,
          cursor: isDefault ? "default" : "pointer",
          opacity: isDefault ? 0.3 : 1,
          transition: "background-color 120ms ease",
          flexShrink: 0,
        }}
        onMouseEnter={(e) => { if (!isDefault) e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
      >
        {resetLabel}
      </button>
    </div>
  );
}

/**
 * Pick any of the site's Jira fields to show as an extra column.
 *
 * A mature Jira site exposes ~150 fields, so this is a filterable checklist
 * rather than a wall of checkboxes: type to narrow, and whatever is already
 * ticked stays pinned to the top so you can always see (and untick) your
 * current picks even when the filter excludes them.
 */
function JiraExtraFieldsRow({
  where,
  label,
  description,
  fields,
  selected,
  onChange,
}: {
  where: "rows" | "header";
  label: string;
  description: string;
  fields: JiraFieldMeta[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [filter, setFilter] = useState("");
  const picked = new Set(selected);
  const q = filter.trim().toLowerCase();
  const shown = fields.filter((f) => picked.has(f.id) || !q || f.name.toLowerCase().includes(q));
  // Ticked first, so a pick never scrolls out of reach behind a filter.
  shown.sort((a, b) => {
    const pa = picked.has(a.id) ? 0 : 1;
    const pb = picked.has(b.id) ? 0 : 1;
    return pa !== pb ? pa - pb : a.name.localeCompare(b.name);
  });
  const toggle = (id: string) =>
    onChange(picked.has(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  return (
    <SettingsRow label={label} description={description} vertical>
      {fields.length === 0 ? (
        <span
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
            color: "var(--ezy-text-muted)",
          }}
        >
          Available once Jira has been polled at least once.
        </span>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, width: "100%" }}>
          <input
            type="text"
            value={filter}
            placeholder={`Filter ${fields.length} fields`}
            onChange={(e) => setFilter(e.target.value)}
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "5px 8px",
              fontFamily: "inherit",
              fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
              color: "var(--ezy-text)",
              backgroundColor: "var(--ezy-surface)",
              border: "1px solid var(--ezy-border)",
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
              outline: "none",
            }}
          />
          <div
            style={{
              maxHeight: 168,
              overflowY: "auto",
              border: "1px solid var(--ezy-border)",
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
              padding: 6,
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            {shown.length === 0 ? (
              <span
                style={{
                  fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                  color: "var(--ezy-text-muted)",
                }}
              >
                No field matches that.
              </span>
            ) : (
              shown.map((f) => (
                <label
                  key={`${where}-${f.id}`}
                  className="flex items-center gap-1.5"
                  style={{
                    fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                    color: "var(--ezy-text)",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={picked.has(f.id)}
                    onChange={() => toggle(f.id)}
                  />
                  <span
                    style={{
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {f.name}
                  </span>
                </label>
              ))
            )}
          </div>
        </div>
      )}
    </SettingsRow>
  );
}

function SegmentedControl<T extends string>({ options, value, onChange, disabled }: {
  /** `fontFamily` renders that option's label in the face it selects, so a font
   *  picker reads as a specimen instead of a word. Omitted everywhere else. */
  options: { value: T; label: string; disabled?: boolean; fontFamily?: string }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ display: "flex", borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)", border: "1px solid var(--ezy-border)", overflow: "hidden", minWidth: 180 }}>
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
              fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
              fontWeight: isActive ? 600 : 400,
              color: isOff ? "var(--ezy-text-muted)" : isActive ? "var(--ezy-text)" : "var(--ezy-text-muted)",
              backgroundColor: isActive ? "var(--ezy-accent-glow)" : "transparent",
              border: "none",
              cursor: isOff ? "default" : "pointer",
              fontFamily: opt.fontFamily ?? "inherit",
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
        fontSize: "calc(var(--ezy-font-scale, 1) * 15px)",
        fontWeight: 600,
        color: "var(--ezy-text)",
        margin: "0 0 4px",
        letterSpacing: "-0.01em",
      }}>{title}</h2>
      {description && (
        <p style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-text-muted)", margin: "0 0 5px", lineHeight: 1.4 }}>{description}</p>
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
          <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 13px)", color: "var(--ezy-text-secondary)" }}>{label}</div>
          {description && <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 11px)", color: "var(--ezy-text-muted)", marginTop: 2, lineHeight: 1.3 }}>{description}</div>}
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
      {/* The label gets a FLOOR and the control is what gives. Before this the
          label column was `flex:1, minWidth:0` against a `flexShrink:0`
          control, so a wide control (input + Test) squeezed it to ~90px and
          "Jira API token" wrapped onto three lines with its description as a
          ribbon. Controls all carry their own min sizes, so they shrink to a
          floor rather than collapsing. */}
      <div style={{ minWidth: 132, flex: "1 1 auto" }}>
        <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 13px)", color: "var(--ezy-text-secondary)" }}>{label}</div>
        {description && <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 11px)", color: "var(--ezy-text-muted)", marginTop: 2, lineHeight: 1.3 }}>{description}</div>}
      </div>
      <div style={{ flex: "0 1 auto", minWidth: 0, display: "flex", justifyContent: "flex-end" }}>{children}</div>
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
      {/* Only the basename fits here, so the full path lives in the tooltip —
          otherwise two picks from different folders look identical. */}
      <div
        data-tooltip={value || undefined}
        style={{
          fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
          color: value ? "var(--ezy-text-secondary)" : "var(--ezy-text-muted)",
          maxWidth: 180,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontStyle: value ? "normal" : "italic",
        }}
      >
        {value ? value.split(/[\\/]/).pop() : "Not set"}
      </div>
      <button
        onClick={handleBrowse}
        style={{
          padding: "4px 10px",
          fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
          fontWeight: 500,
          color: "var(--ezy-text-secondary)",
          backgroundColor: "var(--ezy-surface)",
          border: "1px solid var(--ezy-border)",
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
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
            fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
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
        <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", fontWeight: 600, color: "var(--ezy-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
          This Week
        </div>
        <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 28px)", fontWeight: 700, color: "var(--ezy-text)", letterSpacing: "-0.02em", marginBottom: 8 }}>
          {formatDuration(weekTotal)}
        </div>
        <div style={{ display: "flex", gap: 16 }}>
          {(["claude", "codex", "gemini"] as const).map((cli) => {
            const ms = weekByCli[cli] || 0;
            if (ms === 0 && weekTotal === 0) return null;
            return (
              <div key={cli} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: CLI_COLORS[cli] }} />
                <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-text-secondary)" }}>
                  {CLI_LABELS[cli]}: {formatDuration(ms)}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* All Time */}
      <div style={{ marginBottom: 24, paddingTop: 16, borderTop: "1px solid var(--ezy-border-subtle)" }}>
        <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", fontWeight: 600, color: "var(--ezy-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
          All Time
        </div>
        <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 22px)", fontWeight: 700, color: "var(--ezy-text)", letterSpacing: "-0.02em", marginBottom: 8 }}>
          {formatDuration(allTotal)}
        </div>
        <div style={{ display: "flex", gap: 16 }}>
          {(["claude", "codex", "gemini"] as const).map((cli) => {
            const ms = allByCli[cli] || 0;
            if (ms === 0 && allTotal === 0) return null;
            return (
              <div key={cli} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: CLI_COLORS[cli] }} />
                <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-text-secondary)" }}>
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
          <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", fontWeight: 600, color: "var(--ezy-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>
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
                <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 13px)", color: "var(--ezy-text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1, marginRight: 12 }}>
                  {p.name}
                </span>
                <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 13px)", fontWeight: 500, color: "var(--ezy-text)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                  {formatDuration(p.ms)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {bursts.length === 0 && (
        <div style={{ padding: "24px 0", textAlign: "center", color: "var(--ezy-text-muted)", fontSize: "calc(var(--ezy-font-scale, 1) * 13px)" }}>
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
                fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
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
              <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-text-muted)" }}>Are you sure?</span>
              <div
                onClick={() => { onClear(); setShowConfirm(false); }}
                style={{
                  fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                  fontWeight: 600,
                  color: "#fff",
                  backgroundColor: "var(--ezy-red, #e55)",
                  padding: "4px 10px",
                  borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                  cursor: "pointer",
                }}
              >
                Reset
              </div>
              <div
                onClick={() => setShowConfirm(false)}
                style={{
                  fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
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
  // Downgrade path: released versions older than the running one.
  const [prevVersions, setPrevVersions] = useState<{ version: string; date: string }[]>([]);
  const [confirmVersion, setConfirmVersion] = useState<string | null>(null);
  const [downgrade, setDowngrade] = useState<
    { version: string; downloaded: number; total: number | null; installing: boolean } | null
  >(null);
  const [downgradeError, setDowngradeError] = useState<string | null>(null);

  // Fetch app version on mount
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

  // Older releases for the downgrade list (public repo, same API the
  // changelog popup uses). Failing silently just hides the block.
  useEffect(() => {
    if (!appVersion) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(
          `https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=15`,
          { headers: { Accept: "application/vnd.github+json" } },
        );
        if (!resp.ok) return;
        const data = (await resp.json()) as {
          tag_name?: string;
          published_at?: string;
          draft?: boolean;
          prerelease?: boolean;
        }[];
        const cur = appVersion.split(".").map(Number);
        const older = data
          .filter((r) => !r.draft && !r.prerelease && /^v\d+\.\d+\.\d+$/.test(r.tag_name ?? ""))
          .map((r) => ({
            version: (r.tag_name as string).slice(1),
            date: r.published_at ? r.published_at.slice(0, 10) : "",
          }))
          .filter(({ version }) => {
            const v = version.split(".").map(Number);
            for (let i = 0; i < 3; i++) {
              if (v[i] !== cur[i]) return v[i] < cur[i];
            }
            return false; // same version
          })
          .slice(0, 5);
        if (!cancelled) setPrevVersions(older);
      } catch {
        // offline / rate-limited — no downgrade list this session
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [appVersion]);

  const handleDowngrade = useCallback(async (version: string) => {
    setConfirmVersion(null);
    setDowngradeError(null);
    setDowngrade({ version, downloaded: 0, total: null, installing: false });
    try {
      const onProgress = new Channel<{ downloaded: number; total: number | null }>();
      onProgress.onmessage = (p) =>
        setDowngrade((d) =>
          d && d.version === version
            ? { ...d, downloaded: p.downloaded, total: p.total ?? d.total }
            : d,
        );
      await invoke("updater_install_version", { version, onProgress });
      setDowngrade((d) => (d ? { ...d, installing: true } : d));
      // Same rule as handleUpdate: nothing is written to the store here —
      // a write immediately before relaunch() never reaches disk.
      await relaunch();
    } catch (err) {
      setDowngrade(null);
      setDowngradeError(err instanceof Error ? err.message : String(err));
    }
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
          <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 13px)", color: "var(--ezy-text-secondary)" }}>
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
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
              border: "1px solid var(--ezy-border)",
              background: "var(--ezy-surface-raised)",
              color: "var(--ezy-text)",
              fontSize: "calc(var(--ezy-font-scale, 1) * 13px)",
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
            {checkStatus === "checking" ? <LoadingDots>Checking</LoadingDots> : "Check for Updates"}
          </button>
          {checkStatus === "available" && (
            <button
              onClick={handleUpdate}
              style={{
                height: 30,
                padding: "0 14px",
                borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
                border: "none",
                background: "var(--ezy-accent-dim)",
                color: "#fff",
                fontSize: "calc(var(--ezy-font-scale, 1) * 13px)",
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
            <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 13px)", color: "var(--ezy-accent)", lineHeight: 1 }}>
              Up to date
            </span>
          )}
          {checkStatus === "available" && latestVersion && (
            <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 13px)", color: "var(--ezy-accent)", lineHeight: 1 }}>
              v{latestVersion} is available
            </span>
          )}
          {checkStatus === "installing" && (
            <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 13px)", color: "var(--ezy-accent)", lineHeight: 1 }}>
              <LoadingDots>Installing update, restarting</LoadingDots>
            </span>
          )}
        </div>
        {checkStatus === "downloading" && (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{
              flex: 1,
              height: 4,
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 2px)",
              backgroundColor: "var(--ezy-border)",
              overflow: "hidden",
              minWidth: 60,
            }}>
              <div style={{
                height: "100%",
                width: pct != null ? `${pct}%` : "30%",
                backgroundColor: "var(--ezy-accent)",
                borderRadius: "calc(var(--ezy-radius-scale, 1) * 2px)",
                transition: pct != null ? "width 200ms ease" : "none",
              }} />
            </div>
            {pct != null && (
              <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-text-muted)", fontVariantNumeric: "tabular-nums" }}>
                {pct}%
              </span>
            )}
          </div>
        )}
        {checkStatus === "error" && (
          <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-red)" }}>
            {errorMsg || "Failed to check for updates"}
          </span>
        )}
        <div style={{ borderTop: "1px solid var(--ezy-border)", paddingTop: 14, marginTop: 4 }}>
          <SettingsRow label="Show changelog popup after updates">
            <ToggleSwitch checked={showChangelogOnUpdate} onChange={setShowChangelogOnUpdate} />
          </SettingsRow>
        </div>
        {prevVersions.length > 0 && (
          <div style={{ borderTop: "1px solid var(--ezy-border)", paddingTop: 14, marginTop: 4 }}>
            <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 13px)", color: "var(--ezy-text-secondary)", marginBottom: 8 }}>
              Previous versions
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {prevVersions.map(({ version, date }) => {
                const isThisRow = downgrade?.version === version;
                const busy = isUpdating || downgrade !== null;
                return (
                  <div
                    key={version}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      height: 30,
                    }}
                  >
                    <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 13px)", color: "var(--ezy-text)", fontWeight: 500, width: 64 }}>
                      v{version}
                    </span>
                    <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-text-muted)", flex: 1 }}>
                      {date}
                    </span>
                    {confirmVersion === version && !busy ? (
                      <>
                        <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-text-muted)" }}>
                          Restarts the app
                        </span>
                        <button
                          onClick={() => void handleDowngrade(version)}
                          style={{
                            height: 24,
                            padding: "0 10px",
                            borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
                            border: "none",
                            background: "var(--ezy-accent-dim)",
                            color: "#fff",
                            fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                            fontWeight: 500,
                            cursor: "pointer",
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--ezy-accent-hover)")}
                          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "var(--ezy-accent-dim)")}
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => setConfirmVersion(null)}
                          style={{
                            height: 24,
                            padding: "0 10px",
                            borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
                            border: "1px solid var(--ezy-border)",
                            background: "var(--ezy-surface-raised)",
                            color: "var(--ezy-text)",
                            fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                            cursor: "pointer",
                          }}
                        >
                          Cancel
                        </button>
                      </>
                    ) : isThisRow ? (
                      <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-accent)" }}>
                        {downgrade.installing
                          ? <LoadingDots>Installing, restarting</LoadingDots>
                          : downgrade.total
                            ? `Downloading ${Math.min(100, Math.round((downgrade.downloaded / downgrade.total) * 100))}%`
                            : <LoadingDots>Downloading</LoadingDots>}
                      </span>
                    ) : (
                      <button
                        onClick={() => setConfirmVersion(version)}
                        disabled={busy}
                        style={{
                          height: 24,
                          padding: "0 10px",
                          borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
                          border: "1px solid var(--ezy-border)",
                          background: "var(--ezy-surface-raised)",
                          color: "var(--ezy-text)",
                          fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                          cursor: busy ? "not-allowed" : "pointer",
                          opacity: busy ? 0.5 : 1,
                          transition: "border-color 120ms ease",
                        }}
                        onMouseEnter={(e) => {
                          if (!busy) e.currentTarget.style.borderColor = "var(--ezy-accent)";
                        }}
                        onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--ezy-border)")}
                      >
                        Install
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            {downgradeError && (
              <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-red)", display: "block", marginTop: 6 }}>
                {downgradeError}
              </span>
            )}
          </div>
        )}
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
  /** `fontFamily` renders that row — and the closed button, when selected — in
   *  its own face. Used by the UI-font picker, where the list is a set of
   *  specimens and a font name set in some other font tells you nothing. */
  options: { value: T; label: string; fontFamily?: string }[];
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
          fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
          fontFamily: current?.fontFamily ?? "inherit",
          textAlign: "left",
          color: current ? "var(--ezy-text)" : "var(--ezy-text-muted)",
          backgroundColor: "var(--ezy-surface)",
          border: "1px solid var(--ezy-border)",
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
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
            borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
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
                  fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                  fontFamily: o.fontFamily ?? "inherit",
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
  onBlurValue,
  placeholder,
  monospace,
  password,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Called with the final value when the field loses focus — for inputs that
   *  normalize what was typed (normalizing per keystroke would fight typing). */
  onBlurValue?: (v: string) => void;
  placeholder?: string;
  monospace?: boolean;
  /** Masked input for secrets (the Jira API token). */
  password?: boolean;
}) {
  return (
    <input
      type={password ? "password" : "text"}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlurValue ? (e) => onBlurValue(e.target.value) : undefined}
      style={{
        // Shrinkable, not a hard 260: a fixed width here is what used to push
        // the row's label column down to a wrapping sliver on a narrow pane.
        width: 260,
        maxWidth: "100%",
        minWidth: 0,
        flex: "0 1 260px",
        padding: "5px 8px",
        fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
        fontFamily: monospace ? "var(--ezy-font-mono, ui-monospace, Menlo, monospace)" : "inherit",
        color: "var(--ezy-text)",
        backgroundColor: "var(--ezy-surface)",
        border: "1px solid var(--ezy-border)",
        borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
        outline: "none",
      }}
    />
  );
}

type PingState = { status: "idle" | "checking" | "ok" | "fail"; ms?: number; error?: string };

/**
 * Atlassian MCP state for ONE CLI, in the Jira section.
 *
 * Three states, deliberately distinct: connected, not set up, and unknown. The
 * last one matters — if the config could not be read we must not tell someone to
 * install a server they already have. It is also how a CLI that isn't on this
 * machine reads: no config directory, nothing to claim.
 */
function JiraPluginRow({ cli }: { cli: JiraCli }) {
  const terminalBackend = useAppStore((s) => s.terminalBackend);
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const servers = useAppStore((s) => s.servers);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const projectPath = activeTab?.workingDir;
  // A remote project's ticket pane runs the CLI on its SERVER, so that is the
  // machine this row must describe — reporting the local config there would be
  // a confidently wrong "Connected".
  const server = activeTab?.serverId
    ? servers.find((s) => s.id === activeTab.serverId) ?? null
    : null;
  const backend: TerminalBackend = server ? "ssh" : terminalBackend ?? getDefaultBackend();
  const target = useMemo(
    () =>
      server
        ? {
            host: server.host,
            username: server.username,
            sshKeyPath: server.sshKeyPath,
            authMethod: server.authMethod,
            shellFor: (c: JiraCli) => pickExecShell(server.detectedCliShells ?? null, c),
          }
        : null,
    [server],
  );

  const [status, setStatus] = useState<JiraMcpStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setStatus(null);
    void readJiraMcpStatus(cli, backend, projectPath, target).then(setStatus);
  }, [cli, backend, projectPath, target]);

  useEffect(refresh, [refresh]);

  const install = async () => {
    setBusy(true);
    setError(null);
    try {
      await installJiraMcp(cli, backend, target);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const connected = !!status?.configured;
  const unknown = !!status && !status.checked;
  const remoteNoKey = backend === "ssh" && !target?.sshKeyPath?.trim();
  const label = connected
    ? status.scope === "user"
      ? "Connected"
      : `Connected (${status.scope})`
    : unknown
      ? "Unknown"
      : "Not set up";
  const dot = connected ? "#10b981" : unknown ? "var(--ezy-text-muted)" : "var(--ezy-red, #e55)";
  // Why a row can say nothing useful, rather than leaving "Unknown" bare.
  const description = remoteNoKey
    ? `${target?.host ?? "This server"} uses password auth — MADE can only read it over an SSH key.`
    : connected
      ? backend === "ssh" && cli === "codex"
        ? CODEX_MCP_SSH_AUTH
        : JIRA_MCP_AUTH_HINT[cli]
      : undefined;

  return (
    <SettingsRow label={JIRA_CLI_LABEL[cli]} description={description}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {error && (
          <span
            data-tooltip={error}
            style={{
              fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
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
        <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "calc(var(--ezy-font-scale, 1) * 11px)", color: "var(--ezy-text-secondary)" }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", backgroundColor: dot, flexShrink: 0 }} />
          {status === null ? <LoadingDots>Checking</LoadingDots> : label}
        </span>
        {!connected && (
          <button
            onClick={install}
            disabled={busy || remoteNoKey}
            // Disabled needs a reason, or the row is just a dead control.
            data-tooltip={
              remoteNoKey ? "Needs SSH-key auth to configure this server" : undefined
            }
            style={{
              padding: "4px 10px",
              fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
              fontWeight: 500,
              color: "var(--ezy-text-secondary)",
              backgroundColor: "var(--ezy-surface)",
              border: "1px solid var(--ezy-border)",
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
              cursor: busy || remoteNoKey ? "default" : "pointer",
              opacity: remoteNoKey ? 0.5 : 1,
              fontFamily: "inherit",
            }}
          >
            {busy ? <LoadingDots>Setting up</LoadingDots> : "Set up"}
          </button>
        )}
      </div>
    </SettingsRow>
  );
}

/**
 * Is ONE AI CLI installed on the machine its panes would run on?
 *
 * Same three states as the Jira row above and for the same reason: "unknown"
 * (the backend could not be asked) must never be rendered as "not installed".
 * The target follows the active tab — a remote project's panes run the CLI on
 * its SERVER, so reporting the local machine there would be confidently wrong.
 */
function CliInstallRow({ cli }: { cli: AiCli }) {
  const terminalBackend = useAppStore((s) => s.terminalBackend);
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const servers = useAppStore((s) => s.servers);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const server = activeTab?.serverId ? servers.find((s) => s.id === activeTab.serverId) ?? null : null;
  const backend: TerminalBackend = server ? "ssh" : terminalBackend ?? getDefaultBackend();

  const [status, setStatus] = useState<CliStatus | null>(null);

  const refresh = useCallback(() => {
    setStatus(null);
    invalidateCliStatus(cli, backend, server);
    void cliStatus(cli, backend, server).then(setStatus);
  }, [cli, backend, server]);

  useEffect(refresh, [refresh]);

  const where = backendLabel(backend, server);
  const label =
    status === "present" ? "Installed" : status === "missing" ? "Not installed" : "Unknown";
  const dot =
    status === "present"
      ? "#10b981"
      : status === "missing"
        ? "var(--ezy-red, #e55)"
        : "var(--ezy-text-muted)";

  return (
    <SettingsRow
      label={AI_CLI_LABEL[cli]}
      description={status === "unknown" ? `${where} did not answer.` : undefined}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
            color: "var(--ezy-text-secondary)",
          }}
        >
          <span style={{ width: 7, height: 7, borderRadius: "50%", backgroundColor: dot, flexShrink: 0 }} />
          {status === null ? <LoadingDots>Checking</LoadingDots> : label}
        </span>
        {status === "missing" && (
          <button
            onClick={() =>
              requestCliInstall({ cli, backend, serverId: server?.id ?? undefined })
            }
            style={{
              padding: "4px 10px",
              fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
              fontWeight: 500,
              color: "var(--ezy-text-secondary)",
              backgroundColor: "var(--ezy-surface)",
              border: "1px solid var(--ezy-border)",
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Install
          </button>
        )}
      </div>
    </SettingsRow>
  );
}

function TestButton({ onClick, state }: { onClick: () => void; state: PingState }) {
  const label =
    state.status === "checking" ? <LoadingDots>Testing</LoadingDots> :
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
          fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
          fontWeight: 500,
          color: "var(--ezy-text-secondary)",
          backgroundColor: "var(--ezy-surface)",
          border: "1px solid var(--ezy-border)",
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
          cursor: state.status === "checking" ? "default" : "pointer",
          fontFamily: "inherit",
        }}
      >
        {label}
      </button>
      {state.status === "fail" && state.error && (
        <span data-tooltip={state.error} style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 10px)", color, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {state.error}
        </span>
      )}
      {state.status === "ok" && (
        <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 10px)", color }}>connected</span>
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
        fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
        color: recording ? "var(--ezy-text)" : "var(--ezy-text-secondary)",
        backgroundColor: recording ? "var(--ezy-accent-glow)" : "var(--ezy-surface)",
        border: `1px solid ${recording ? "var(--ezy-accent)" : "var(--ezy-border)"}`,
        borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
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
        description="Whisper transcribes, a local LLM maps intent to actions."
      >
        <SettingsRow label="Enable voice agent">
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
          <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 11px)", color: "var(--ezy-red, #e55)", padding: "0 0 6px" }}>
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

      <SettingsSection id="voice-llm" title="LLM (intent → action)" description="OpenAI-compatible endpoint with tool calling.">
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

// ─── Color presets ─────────────────────────────────────────────────────────

/** The ghost button shared by the color-preset cluster (New / Rename /
 *  Duplicate / Export / Import / Reset / Delete). Delete overrides `color`. */
const PRESET_BTN_STYLE: React.CSSProperties = {
  padding: "5px 10px",
  fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
  fontFamily: "inherit",
  color: "var(--ezy-text-secondary)",
  backgroundColor: "transparent",
  border: "1px solid var(--ezy-border)",
  borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
  cursor: "pointer",
};

const OVERRIDE_KEY_SET: ReadonlySet<string> = new Set(OVERRIDE_KEYS);

/**
 * Parses an exported preset back into `{ name, overrides }`, or null when the
 * text is not one. Pasted JSON is untrusted input: unknown keys and any value
 * `normalizeHexColor` rejects (including 8-digit hex, which the native renderer
 * would silently drop the alpha from) are dropped rather than stored, so an
 * import can never put a color in a preset the picker itself would refuse.
 */
function parsePresetJson(raw: string): { name: string; overrides: ColorOverrides } | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const rec = data as Record<string, unknown>;
  const name = typeof rec.name === "string" ? rec.name.trim() : "";
  if (!name) return null;
  if (!rec.overrides || typeof rec.overrides !== "object") return null;
  const overrides: ColorOverrides = {};
  for (const [key, val] of Object.entries(rec.overrides as Record<string, unknown>)) {
    if (!OVERRIDE_KEY_SET.has(key) || typeof val !== "string") continue;
    const hex = normalizeHexColor(val);
    if (hex) overrides[key as OverrideKey] = hex;
  }
  return { name, overrides };
}

// ─── NexusMind ─────────────────────────────────────────────────────────────

/**
 * Adapters attached to this MADE right now (spec §7.9).
 *
 * The rows above answer "is it registered?"; this answers "is it working?".
 * They come apart often enough to be worth separating: a CLI registered before
 * MADE moved, or a pane started before the server was added, is configured and
 * not connected — and only this list can tell you that.
 *
 * Polled rather than pushed: connections come and go with pane lifetimes, and
 * the panel is only on screen while someone is looking at it.
 */
function KnowledgeMcpConnections({
  Row,
}: {
  Row: (props: { label: string; description?: string; children: React.ReactNode }) => React.ReactElement | null;
}) {
  const [connections, setConnections] = useState<KnowledgeMcpConnection[] | null>(null);

  useEffect(() => {
    let alive = true;
    const read = () => {
      void readKnowledgeMcpConnections().then((list) => {
        if (alive) setConnections(list);
      });
    };
    read();
    const timer = setInterval(read, 5_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <Row
      label="Agent connections"
      description="Live MCP adapters talking to this MADE instance."
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 3,
          fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
          color: "var(--ezy-text-secondary)",
        }}
      >
        {connections === null ? (
          <span style={{ color: "var(--ezy-text-muted)" }}><LoadingDots>Checking</LoadingDots></span>
        ) : connections.length === 0 ? (
          <span style={{ color: "var(--ezy-text-muted)" }}>No agent connections</span>
        ) : (
          connections.map((c, i) => (
            <span
              key={`${c.agentKind}-${c.paneId ?? i}`}
              style={{ display: "flex", alignItems: "center", gap: 6 }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  backgroundColor: "#10b981",
                  flexShrink: 0,
                }}
              />
              {connectionLine(c)}
            </span>
          ))
        )}
      </div>
    </Row>
  );
}

/**
 * Shared agent knowledge settings.
 *
 * Two of these are machine-wide preferences and two are about the project in
 * front of you, which is why the project ones name it: a control that silently
 * applies to "whatever is active" is one people change from the wrong place.
 *
 * The write policy is deliberately NOT a persisted app setting. It decides what
 * agents may write to a project's memory, so it lives in the knowledge service
 * next to the data it protects and survives a cleared local store.
 */
function NexusMindSection() {
  const autoAttach = useAppStore((s) => s.knowledgeAutoAttach);
  const setAutoAttach = useAppStore((s) => s.setKnowledgeAutoAttach);
  const notifEnabled = useAppStore((s) => s.knowledgeNotifEnabled);
  const setNotifEnabled = useAppStore((s) => s.setKnowledgeNotifEnabled);

  // The LOCAL path this section acts on. An SSH tab resolves to its local twin
  // when the folder has been linked, and to "" when it has not — the rows then
  // disable themselves with a reason, exactly as they do before initialization.
  const projectPath = useAppStore(
    (s) => {
      const tab = s.tabs.find((t) => t.id === s.activeTabId);
      if (!tab?.workingDir) return "";
      return usableKnowledgePath(tab.workingDir, tab.serverId) ?? "";
    },
  );
  const projectName = useAppStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    return tab?.customName || tab?.name || "";
  });
  const projectKey = canonicalProjectKey(projectPath);
  const project = useKnowledgeStore((s) => s.projects[projectKey]);
  const initialize = useKnowledgeStore((s) => s.initialize);
  const setPolicy = useKnowledgeStore((s) => s.setPolicy);

  // Which machine a pane's CLI would run on — the same resolution the Jira row
  // uses. A remote project's panes run their CLI on the SERVER, where MADE's
  // adapter does not exist, so the rows say so rather than describing this
  // machine's config.
  const terminalBackend = useAppStore((s) => s.terminalBackend);
  const activeServerId = useAppStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.serverId);
  const mcpBackend: TerminalBackend = activeServerId
    ? "ssh"
    : terminalBackend ?? getDefaultBackend();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const status = project?.status;
  const ready = status === "ready" || status === "readonly";
  const policyReason =
    activeServerId && !projectPath
      ? "This project's folder is not linked to one on this machine — open the Knowledge sidebar to link it"
      : status === "remote-unsupported"
      ? "Knowledge is local-only — SSH projects are not supported yet"
      : status === "readonly"
        ? project?.readonlyReason || "Knowledge is read-only in this instance"
        : ready
          ? null
          : "Initialize knowledge for this project first";

  return (
    <SettingsSection
      id="nexusmind"
      title="NexusMind"
      description="Shared project memory your agents can read and write."
    >
      <SettingsRow label="Attach knowledge on project open">
        <ToggleSwitch checked={autoAttach} onChange={setAutoAttach} />
      </SettingsRow>

      <SettingsRow
        label="Memory write policy"
        description={
          projectName
            ? `Applies to ${projectName}. Every write is revisioned.`
            : "Open a project to set its write policy."
        }
      >
        <span data-tooltip={policyReason ?? undefined}>
          <SegmentedControl
            options={[
              { value: "read-only" as const, label: "Read only" },
              { value: "ask" as const, label: "Ask before write" },
              { value: "trusted" as const, label: "Trusted" },
            ]}
            value={project?.policy ?? "ask"}
            disabled={!!policyReason || busy}
            onChange={(v) => {
              setError(null);
              setBusy(true);
              void setPolicy(projectPath, v)
                .catch((e) => setError(String(e)))
                .finally(() => setBusy(false));
            }}
          />
        </span>
      </SettingsRow>

      {KNOWLEDGE_CLIS.map((cli) => (
        <KnowledgeMcpRow
          key={cli}
          cli={cli}
          backend={mcpBackend}
          projectPath={projectPath || undefined}
          Row={SettingsRow}
        />
      ))}

      <KnowledgeMcpConnections Row={SettingsRow} />

      <SettingsRow
        label="This project"
        description={
          !projectPath
            ? "No project is active."
            : ready
              ? `Ready · ${project?.notes.length ?? 0} notes · rev ${project?.revision ?? 0}`
              : status === "remote-unsupported"
                ? "SSH projects are not supported yet."
                : status === "unavailable"
                  ? project?.lastError || "The knowledge service is not available."
                  : "Not initialized — no files have been created in this project."
        }
      >
        {ready ? (
          <button
            onClick={() => {
              const path = project?.memoryDir;
              if (path) void invoke("reveal_in_explorer", { path }).catch(() => {});
            }}
            aria-disabled={!project?.memoryDir}
            data-tooltip={project?.memoryDir ? undefined : "Folder path not reported yet"}
            style={{
              padding: "5px 12px",
              fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
              fontFamily: "var(--ezy-font-ui)",
              color: "var(--ezy-text-secondary)",
              backgroundColor: "transparent",
              border: "1px solid var(--ezy-border)",
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
              cursor: project?.memoryDir ? "pointer" : "default",
              opacity: project?.memoryDir ? 1 : 0.6,
            }}
          >
            Open {MEMORY_DIR_NAME} folder
          </button>
        ) : (
          <button
            onClick={() => {
              if (!projectPath || busy) return;
              setError(null);
              setBusy(true);
              void initialize(projectPath)
                .then((ok) => {
                  if (!ok) setError("Could not initialize knowledge for this project.");
                })
                .finally(() => setBusy(false));
            }}
            aria-disabled={!projectPath || status === "remote-unsupported" || busy}
            data-tooltip={
              status === "remote-unsupported"
                ? "SSH projects are not supported yet"
                : !projectPath
                  ? "No project is active"
                  : undefined
            }
            style={{
              padding: "5px 12px",
              fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
              fontFamily: "var(--ezy-font-ui)",
              color: "var(--ezy-on-accent)",
              backgroundColor: "var(--ezy-accent)",
              border: "none",
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
              cursor: !projectPath || status === "remote-unsupported" || busy ? "default" : "pointer",
              opacity: !projectPath || status === "remote-unsupported" || busy ? 0.6 : 1,
            }}
          >
            {busy ? <LoadingDots>Initializing</LoadingDots> : "Initialize…"}
          </button>
        )}
      </SettingsRow>

      <SettingsRow label="Knowledge update notifications">
        <ToggleSwitch checked={notifEnabled} onChange={setNotifEnabled} />
      </SettingsRow>

      {error && (
        <div
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
            color: "var(--ezy-red)",
            paddingTop: 8,
            wordBreak: "break-word",
          }}
        >
          {error}
        </div>
      )}
    </SettingsSection>
  );
}

// ─── Nav sections ──────────────────────────────────────────────────────────

const NAV_SECTIONS = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "terminal", label: "Terminal" },
  { id: "cli", label: "CLI" },
  { id: "browser", label: "Browser" },
  { id: "projects", label: "Projects" },
  { id: "editor", label: "Editor" },
  { id: "ai", label: "AI" },
  { id: "nexusmind", label: "NexusMind" },
  { id: "jira", label: "Jira" },
  ...(VOICE_ENABLED ? [{ id: "voice", label: "Voice agent" }] : []),
  { id: "updates", label: "Updates" },
];

// ─── Main component ───────────────────────────────────────────────────────

export default function SettingsPane() {
  // pendingSettingsSection covers the deep-link that OPENS the panel (this
  // component mounts after the request); the listener below covers a panel
  // that is already open.
  const [activeSection, setActiveSection] = useState(
    () => pendingSettingsSection() ?? NAV_SECTIONS[0]?.id ?? "behavior",
  );
  useEffect(() => {
    const onSection = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (id) setActiveSection(id);
    };
    window.addEventListener("made:settings-section", onSection as EventListener);
    return () => window.removeEventListener("made:settings-section", onSection as EventListener);
  }, []);
  const [showClearModal, setShowClearModal] = useState(false);
  const [wslShutdownBusy, setWslShutdownBusy] = useState(false);
  const [wslShutdownResult, setWslShutdownResult] = useState<string | null>(null);
  const handleWslShutdown = useCallback(async () => {
    const ok = await confirmAction({
      title: "Restart WSL?",
      detail:
        "Runs wsl --shutdown, then respawns every WSL pane automatically — Claude panes resume their sessions. Terminal scrollback is lost, and WSL dev servers must be started again from their panel.",
      confirmLabel: "Restart WSL",
      danger: true,
    });
    if (!ok) return;
    setWslShutdownBusy(true);
    setWslShutdownResult(null);
    try {
      await invoke("wsl_shutdown"); // also flushes the dead pre-warmed pool
      // Re-warm the pool first: it boots the fresh VM (picking up .wslconfig)
      // and makes the pane respawns below near-instant.
      void invoke("pty_pool_warm", { count: 16, distro: getCachedDistro() || null }).catch(() => {});
      // Respawn every WSL pane through its registered restart action — the
      // same path as the pane-header restart button, so Claude panes keep
      // their session id and come back with --resume. Staggered so a dozen
      // wsl.exe launches don't storm the just-booted VM at once.
      const s = useAppStore.getState();
      const restarts: Array<() => void> = [];
      for (const tab of s.tabs) {
        if (!tab.layout || tab.serverId || tab.isHibernated) continue; // SSH untouched; sleeping tabs stay asleep
        if (tab.backend === "windows") continue; // no WSL processes to revive
        for (const t of findAllTerminalIds(tab.layout)) {
          const term = s.terminals[t];
          if (!term || term.type === "devserver") continue; // dev servers have their own lifecycle
          const actions = getTerminalActions(t);
          if (actions) restarts.push(() => actions.restart());
        }
      }
      restarts.forEach((fn, i) => setTimeout(fn, 400 + i * 150));
      setWslShutdownResult(
        restarts.length > 0
          ? `WSL restarted — respawning ${restarts.length} pane${restarts.length === 1 ? "" : "s"} (Claude sessions resume).`
          : "WSL restarted. No WSL panes were open.",
      );
    } catch (e) {
      setWslShutdownResult(`Restart failed: ${e}`);
    } finally {
      setWslShutdownBusy(false);
    }
  }, []);
  // Installed WSL distros for the distribution picker. `wsl --list --quiet`
  // is registry-backed (no VM boot), so enumerating on mount is cheap.
  const [wslDistros, setWslDistros] = useState<string[]>([]);
  useEffect(() => {
    if (!isWindows()) return;
    invoke<string[]>("wsl_list_distros")
      .then(setWslDistros)
      .catch(() => {}); // no wsl.exe / no distros — picker still offers Default
  }, []);
  const handleWslDistroChange = useCallback((value: string) => {
    useAppStore.getState().setWslDistro(value || null);
    // Cached CLI paths (claude/codex/gemini) belong to the previous distro.
    // Re-resolve inside the new one; that also re-warms the pool, and
    // pty_pool_warm flushes the old distro's pooled sessions on the way.
    clearWslCliCache();
    void resolveWslCliPaths();
  }, []);
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
  const wslDistro = useAppStore((s) => s.wslDistro ?? null);
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
  const autoHibernateEnabled = useAppStore((s) => s.autoHibernateEnabled ?? false);
  const setAutoHibernateEnabled = useAppStore((s) => s.setAutoHibernateEnabled);
  const autoHibernateMinutes = useAppStore((s) => s.autoHibernateMinutes ?? 30);
  const setAutoHibernateMinutes = useAppStore((s) => s.setAutoHibernateMinutes);
  const notifEnabled = useAppStore((s) => s.notifEnabled ?? true);
  const setNotifEnabled = useAppStore((s) => s.setNotifEnabled);
  const notifAutoDismiss = useAppStore((s) => s.notifAutoDismiss ?? false);
  const setNotifAutoDismiss = useAppStore((s) => s.setNotifAutoDismiss);
  const notifAutoDismissSeconds = useAppStore((s) => s.notifAutoDismissSeconds ?? 30);
  const setNotifAutoDismissSeconds = useAppStore((s) => s.setNotifAutoDismissSeconds);
  const notifAutoSwitchMinimized = useAppStore((s) => s.notifAutoSwitchMinimized ?? false);
  const setNotifAutoSwitchMinimized = useAppStore((s) => s.setNotifAutoSwitchMinimized);
  const notifSystemMinimized = useAppStore((s) => s.notifSystemMinimized ?? true);
  const notifOsPopupsEnabled = useAppStore((s) => s.notifOsPopupsEnabled ?? true);
  const setNotifOsPopupsEnabled = useAppStore((s) => s.setNotifOsPopupsEnabled);
  const setNotifSystemMinimized = useAppStore((s) => s.setNotifSystemMinimized);
  const notifSoundEnabled = useAppStore((s) => s.notifSoundEnabled ?? true);
  // Names the channels a Jira notification will actually use, so the Jira tab
  // answers "will I see this outside the app?" without a trip to Terminal.
  // Declared here, after the channel selectors it reads — a const cannot be
  // used above its declaration.
  const jiraChannelSummary = [
    "In-app",
    notifOsPopupsEnabled ? "popup" : null,
    notifSystemMinimized ? "system" : null,
    notifSoundEnabled ? "sound" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const setNotifSoundEnabled = useAppStore((s) => s.setNotifSoundEnabled);
  const notifSoundVolume = useAppStore((s) => s.notifSoundVolume ?? 50);
  const setNotifSoundVolume = useAppStore((s) => s.setNotifSoundVolume);
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
  const hoverOpenAddPaneMenu = useAppStore((s) => s.hoverOpenAddPaneMenu);
  const setHoverOpenAddPaneMenu = useAppStore((s) => s.setHoverOpenAddPaneMenu);
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
  const devServerButtonInHeader = useAppStore((s) => s.devServerButtonInHeader);
  const setDevServerButtonInHeader = useAppStore((s) => s.setDevServerButtonInHeader);
  const devServerTabIcon = useAppStore((s) => s.devServerTabIcon);
  const setDevServerTabIcon = useAppStore((s) => s.setDevServerTabIcon);
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
  const aiWorkingMarkerDetection = useAppStore((s) => s.aiWorkingMarkerDetection ?? false);
  const setAiWorkingMarkerDetection = useAppStore((s) => s.setAiWorkingMarkerDetection);
  const jiraSitesList = useAppStore((s) => s.jiraSites ?? []);
  const jiraDefaultSiteId = useAppStore((s) => s.jiraDefaultSiteId ?? "");
  const addJiraSite = useAppStore((s) => s.addJiraSite);
  const removeJiraSite = useAppStore((s) => s.removeJiraSite);
  const setJiraDefaultSite = useAppStore((s) => s.setJiraDefaultSite);
  const jiraApiEmail = useAppStore((s) => s.jiraApiEmail ?? "");
  const setJiraApiEmail = useAppStore((s) => s.setJiraApiEmail);
  const jiraApiToken = useAppStore((s) => s.jiraApiToken ?? "");
  const setJiraApiToken = useAppStore((s) => s.setJiraApiToken);
  const jiraNotifEnabled = useAppStore((s) => s.jiraNotifEnabled ?? true);
  const setJiraNotifEnabled = useAppStore((s) => s.setJiraNotifEnabled);
  const jiraAssignedMode = useAppStore((s) => s.jiraAssignedMode ?? false);
  const setJiraAssignedMode = useAppStore((s) => s.setJiraAssignedMode);
  // Select the RAW slice and merge below. Building the object inside the
  // selector would return a fresh reference on every store change and
  // re-render this pane constantly (same rule as the rail's row selectors).
  // The merge is not optional: a store written before a key existed carries
  // the object WITHOUT it, so `?? DEFAULT` alone leaves the new checkbox
  // reading `undefined`.
  const jiraHeaderShowRaw = useAppStore((s) => s.jiraHeaderShow);
  const jiraHeaderShow = useMemo(
    () => ({ ...DEFAULT_JIRA_HEADER_SHOW, ...(jiraHeaderShowRaw ?? {}) }),
    [jiraHeaderShowRaw],
  );
  const setJiraHeaderShow = useAppStore((s) => s.setJiraHeaderShow);
  const jiraUnassignedMode = useAppStore((s) => s.jiraUnassignedMode ?? false);
  const setJiraUnassignedMode = useAppStore((s) => s.setJiraUnassignedMode);
  const jiraUnassignedNotify = useAppStore((s) => s.jiraUnassignedNotify ?? true);
  const setJiraUnassignedNotify = useAppStore((s) => s.setJiraUnassignedNotify);
  const jiraRowMetaShowRaw = useAppStore((s) => s.jiraRowMetaShow);
  const jiraRowMetaShow = useMemo(
    () => ({ ...DEFAULT_JIRA_ROW_META_SHOW, ...(jiraRowMetaShowRaw ?? {}) }),
    [jiraRowMetaShowRaw],
  );
  const setJiraRowMetaShow = useAppStore((s) => s.setJiraRowMetaShow);
  const jiraStatusIndicator = useAppStore((s) => s.jiraStatusIndicator ?? "both");
  const setJiraStatusIndicator = useAppStore((s) => s.setJiraStatusIndicator);
  const jiraListGrouping = useAppStore((s) => s.jiraListGrouping ?? "flat");
  const setJiraListGrouping = useAppStore((s) => s.setJiraListGrouping);
  const jiraStatusColorMode = useAppStore((s) => s.jiraStatusColorMode ?? "auto");
  const setJiraStatusColorMode = useAppStore((s) => s.setJiraStatusColorMode);
  const jiraStatusColors = useAppStore((s) => s.jiraStatusColors);
  const setJiraStatusColor = useAppStore((s) => s.setJiraStatusColor);
  const jiraSiteFields = useAppStore((s) => s.jiraSiteFields);
  const jiraExtraFieldsRaw = useAppStore((s) => s.jiraExtraFields);
  const jiraExtraFields = useMemo(
    () => ({ rows: jiraExtraFieldsRaw?.rows ?? [], header: jiraExtraFieldsRaw?.header ?? [] }),
    [jiraExtraFieldsRaw],
  );
  const setJiraExtraFields = useAppStore((s) => s.setJiraExtraFields);
  // UNION of every configured site's catalogue, not just the default one — on
  // a multi-site setup the default-only list silently offered nothing for the
  // other sites. Deduped by field id, first name seen wins. A pick is narrowed
  // back to the site that actually has the field at request AND render time,
  // so a field only one site defines is simply inert on the others.
  const jiraPickableFields = useMemo(() => {
    const byId = new Map<string, JiraFieldMeta>();
    const cats = jiraSiteFields ?? {};
    // Default site first, so its naming wins any collision.
    for (const site of [jiraDefaultSiteId, ...Object.keys(cats)]) {
      for (const f of cats[site] ?? []) if (!byId.has(f.id)) byId.set(f.id, f);
    }
    return pickableFields([...byId.values()]);
  }, [jiraSiteFields, jiraDefaultSiteId]);
  const jiraRailWidths = useAppStore((s) => s.jiraRailWidths ?? DEFAULT_JIRA_RAIL_WIDTHS);
  const setJiraRailWidth = useAppStore((s) => s.setJiraRailWidth);
  const jiraAssignedTickets = useAppStore((s) => s.jiraAssignedTickets);
  const jiraUnassignedTickets = useAppStore((s) => s.jiraUnassignedTickets);
  const jiraTicketSnapshots = useAppStore((s) => s.jiraTicketSnapshots);
  // Every status the app has actually seen, with its automatic colour. Built
  // from the SAME union the rail uses, so a colour pinned here is guaranteed to
  // be the colour that renders there.
  const jiraKnownStatuses = useMemo(() => {
    const names: string[] = [];
    for (const t of jiraAssignedTickets ?? []) if (t.status) names.push(t.status);
    for (const t of jiraUnassignedTickets ?? []) if (t.status) names.push(t.status);
    for (const snap of Object.values(jiraTicketSnapshots ?? {})) {
      if (snap?.statusName) names.push(snap.statusName);
    }
    const auto = buildStatusColorMap(names);
    // One row per NORMALIZED status, labelled with the first spelling seen —
    // the map key is what the override is stored against.
    const label = new Map<string, string>();
    for (const n of names) if (!label.has(normalizeStatus(n))) label.set(normalizeStatus(n), n);
    return [...auto.entries()]
      .map(([key, color]) => ({ key, label: label.get(key) ?? key, auto: color }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [jiraAssignedTickets, jiraUnassignedTickets, jiraTicketSnapshots]);
  const jiraSiteAuthErrors = useJiraNotifyStore((s) => s.siteAuthErrors);
  const [jiraCredPing, setJiraCredPing] = useState<PingState>({ status: "idle" });
  const [newJiraSite, setNewJiraSite] = useState("");
  const testJiraCreds = async () => {
    setJiraCredPing({ status: "checking" });
    const t0 = performance.now();
    try {
      const me = await invoke<{ displayName: string; accountId: string }>("jira_test_auth", {
        // One Atlassian account spans every site — testing the default site
        // validates the credential pair for all of them.
        baseUrl: jiraDefaultSiteId,
        email: jiraApiEmail,
        token: jiraApiToken,
      });
      useAppStore.getState().setJiraMyAccountId(me.accountId);
      useJiraNotifyStore.getState().clearSiteAuthErrors();
      setJiraCredPing({ status: "ok", ms: Math.round(performance.now() - t0) });
    } catch (err) {
      const e = err as { message?: string };
      setJiraCredPing({ status: "fail", error: e?.message ?? String(err) });
    }
  };
  const jiraPromptTemplate = useAppStore((s) => s.jiraPromptTemplate ?? "");
  const setJiraPromptTemplate = useAppStore((s) => s.setJiraPromptTemplate);
  const jiraReplyInSwedish = useAppStore((s) => s.jiraReplyInSwedish ?? false);
  const setJiraReplyInSwedish = useAppStore((s) => s.setJiraReplyInSwedish);
  const defaultJiraClaudeMdPath = useAppStore((s) => s.defaultJiraClaudeMdPath ?? "");
  const setDefaultJiraClaudeMdPath = useAppStore((s) => s.setDefaultJiraClaudeMdPath);
  const jiraClaudeSide = useAppStore((s) => s.jiraClaudeSide ?? "left");
  const setJiraClaudeSide = useAppStore((s) => s.setJiraClaudeSide);
  const jiraRowFullColor = useAppStore((s) => s.jiraRowFullColor ?? false);
  const setJiraRowFullColor = useAppStore((s) => s.setJiraRowFullColor);
  const jiraMode = useAppStore((s) => s.jiraMode ?? true);
  const setJiraMode = useAppStore((s) => s.setJiraMode);
  const jiraSubticketMode = useAppStore((s) => s.jiraSubticketMode ?? "default");
  const setJiraSubticketMode = useAppStore((s) => s.setJiraSubticketMode);
  const jiraDetectPastedTickets = useAppStore((s) => s.jiraDetectPastedTickets ?? true);
  const setJiraDetectPastedTickets = useAppStore((s) => s.setJiraDetectPastedTickets);
  const jiraAutoSwitchToDetected = useAppStore((s) => s.jiraAutoSwitchToDetected ?? "auto");
  const setJiraAutoSwitchToDetected = useAppStore((s) => s.setJiraAutoSwitchToDetected);
  const jiraArchivedTicketAction = useAppStore((s) => s.jiraArchivedTicketAction ?? "resume");
  const setJiraArchivedTicketAction = useAppStore((s) => s.setJiraArchivedTicketAction);
  // The plugin rows describe whichever machine the ACTIVE project's panes run
  // on, which for a remote project is its server. Saying so is the difference
  // between a status and a guess.
  const jiraPluginServerHost = useAppStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    if (!tab?.serverId) return null;
    return s.servers.find((srv) => srv.id === tab.serverId)?.host ?? null;
  });
  const jiraPluginTargetNote = jiraPluginServerHost
    ? `Plugin status is read from ${jiraPluginServerHost} — the active project's server, where its panes run.`
    : undefined;
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
  const appIconVariant = useAppStore((s) => s.appIconVariant);
  const setAppIconVariant = useAppStore((s) => s.setAppIconVariant);
  const projectPaneTint = useAppStore((s) => s.projectPaneTint);
  const setProjectPaneTint = useAppStore((s) => s.setProjectPaneTint);
  const projectPaneTintStrength = useAppStore((s) => s.projectPaneTintStrength);
  const setProjectPaneTintStrength = useAppStore((s) => s.setProjectPaneTintStrength);
  const projectHeaderTint = useAppStore((s) => s.projectHeaderTint);
  const setProjectHeaderTint = useAppStore((s) => s.setProjectHeaderTint);
  const projectHeaderTintStrength = useAppStore((s) => s.projectHeaderTintStrength);
  const setProjectHeaderTintStrength = useAppStore((s) => s.setProjectHeaderTintStrength);
  const activePaneLift = useAppStore((s) => s.activePaneLift);
  const setActivePaneLift = useAppStore((s) => s.setActivePaneLift);
  const headerButtonsSlide = useAppStore((s) => s.headerButtonsSlide);
  const setHeaderButtonsSlide = useAppStore((s) => s.setHeaderButtonsSlide);
  const uiFont = useAppStore((s) => s.uiFont);
  const setUiFont = useAppStore((s) => s.setUiFont);
  const uiFontSize = useAppStore((s) => s.uiFontSize);
  const setUiFontSize = useAppStore((s) => s.setUiFontSize);
  const radiusScaleOverride = useAppStore((s) => s.radiusScaleOverride);
  const setRadiusScaleOverride = useAppStore((s) => s.setRadiusScaleOverride);
  const hoverTooltips = useAppStore((s) => s.hoverTooltips);
  const setHoverTooltips = useAppStore((s) => s.setHoverTooltips);
  const nativeCursorStyle = useAppStore((s) => s.nativeCursorStyle);
  const setNativeCursorStyle = useAppStore((s) => s.setNativeCursorStyle);
  const nativeCursorBlink = useAppStore((s) => s.nativeCursorBlink);
  const setNativeCursorBlink = useAppStore((s) => s.setNativeCursorBlink);
  const colorPresets = useAppStore((s) => s.colorPresets);
  const activeColorPresetId = useAppStore((s) => s.activeColorPresetId);
  const createColorPreset = useAppStore((s) => s.createColorPreset);
  const renameColorPreset = useAppStore((s) => s.renameColorPreset);
  const deleteColorPreset = useAppStore((s) => s.deleteColorPreset);
  const setActiveColorPreset = useAppStore((s) => s.setActiveColorPreset);
  const setPresetColor = useAppStore((s) => s.setPresetColor);
  const clearPresetColor = useAppStore((s) => s.clearPresetColor);
  const clearPresetColors = useAppStore((s) => s.clearPresetColors);
  const activeColorPreset = colorPresets.find((p) => p.id === activeColorPresetId) ?? null;
  // What each picker's trigger swatch shows: the theme with the ACTIVE
  // preset's overrides already applied (no tint/lift — those are per-pane).
  const presetPreviewTheme = useMemo(
    () => getEffectiveTerminalTheme(themeId, vibrantColors, false, null, 0, activeColorPreset?.overrides ?? null),
    [themeId, vibrantColors, activeColorPreset],
  );
  const terminalFontFamily = useAppStore((s) => s.terminalFontFamily);
  const setTerminalFontFamily = useAppStore((s) => s.setTerminalFontFamily);
  const perCliFontFamily = useAppStore((s) => s.perCliFontFamily);
  const setPerCliFontFamily = useAppStore((s) => s.setPerCliFontFamily);
  const cliFontFamilies = useAppStore((s) => s.cliFontFamilies);
  const setCliFontFamily = useAppStore((s) => s.setCliFontFamily);
  const terminalLineHeight = useAppStore((s) => s.terminalLineHeight);
  const setTerminalLineHeight = useAppStore((s) => s.setTerminalLineHeight);
  const boldUsesBright = useAppStore((s) => s.boldUsesBright);
  const setBoldUsesBright = useAppStore((s) => s.setBoldUsesBright);
  const minContrast = useAppStore((s) => s.minContrast);
  const setMinContrast = useAppStore((s) => s.setMinContrast);
  const dimStrength = useAppStore((s) => s.dimStrength);
  const setDimStrength = useAppStore((s) => s.setDimStrength);
  const cursorBlockOpacity = useAppStore((s) => s.cursorBlockOpacity);
  const setCursorBlockOpacity = useAppStore((s) => s.setCursorBlockOpacity);
  const scrollbackLines = useAppStore((s) => s.scrollbackLines);
  const setScrollbackLines = useAppStore((s) => s.setScrollbackLines);
  // The monospace families installed on this machine. Enumerated Rust-side, so
  // a machine whose backend has not caught up still gets the bundled face
  // rather than an empty picker.
  const [monoFonts, setMonoFonts] = useState<string[]>(["Hack"]);
  useEffect(() => {
    let alive = true;
    void nativeTermListMonoFonts()
      .then((fonts) => { if (alive && fonts.length) setMonoFonts(fonts); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  const fontOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: { value: string; label: string }[] = [];
    // Hack first — the ONLY truly bundled face (embedded in the native
    // renderer + woff2 in the webview), so it renders identically on every
    // machine. Geist Mono is deliberately NOT pinned: its @font-face is
    // local()-only, so it appears here only when the enumeration finds it
    // installed — offering it everywhere would silently render Hack in native
    // panes. A saved family that is no longer installed stays listed for the
    // same reason the WSL distro row keeps a missing distro: a blank control
    // would hide that the setting is still in force.
    for (const family of ["Hack", terminalFontFamily, ...monoFonts]) {
      if (!family || seen.has(family)) continue;
      seen.add(family);
      out.push({ value: family, label: family });
    }
    return out;
  }, [monoFonts, terminalFontFamily]);
  const useNativeTerminalRenderer = useAppStore((s) => s.useNativeTerminalRenderer);
  const scrollThumbAcceleration = useAppStore((s) => s.scrollThumbAcceleration);
  const wheelAcceleration = useAppStore((s) => s.wheelAcceleration);
  const termProgram = useAppStore((s) => s.termProgram);
  const setTermProgram = useAppStore((s) => s.setTermProgram);
  const termProgramVersion = useAppStore((s) => s.termProgramVersion);
  const [notifChannelState, setNotifChannelState] = useState<
    { status: "idle" | "ok" | "fail"; msg?: string }
  >({ status: "idle" });
  // Gemini notifications row: live read-back of general.enableNotifications
  // (unlike Claude's channel, which is setter-only) so a Gemini-side /settings
  // change shows here truthfully. "off" covers both explicit false and the
  // absent key — Gemini treats both as off.
  const [geminiNotif, setGeminiNotif] = useState<
    "loading" | "unavailable" | "on" | "off"
  >("loading");
  const [geminiNotifApply, setGeminiNotifApply] = useState<
    { status: "idle" | "fail"; msg?: string }
  >({ status: "idle" });
  useEffect(() => {
    void getGeminiNotifications("wsl")
      .then((v) => setGeminiNotif(v === true ? "on" : "off"))
      .catch(() => setGeminiNotif("unavailable"));
  }, []);
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
  const verticalTabMode = useAppStore((s) => s.verticalTabMode);
  const setVerticalTabMode = useAppStore((s) => s.setVerticalTabMode);
  const sidebarSide = useAppStore((s) => s.sidebarSide);
  const setSidebarSide = useAppStore((s) => s.setSidebarSide);
  const verticalTabBarV2 = useAppStore((s) => s.verticalTabBarV2 ?? false);
  const setVerticalTabBarV2 = useAppStore((s) => s.setVerticalTabBarV2);
  const theme = getTheme(themeId);
  // What a picker's trigger swatch shows for a key: the override if set, else
  // the theme's own value. The three preset-only extras fall back to each
  // renderer's built-in color so the swatch never renders empty.
  const presetEffectiveColor = (key: OverrideKey): string => {
    if (key === "accent") return activeColorPreset?.overrides.accent ?? theme.surface.accent;
    if (key === "diffAdd") return activeColorPreset?.overrides.diffAdd ?? theme.surface.diffAdd ?? SEMANTIC_DIFF_ADD;
    if (key === "diffRemove") return activeColorPreset?.overrides.diffRemove ?? theme.surface.diffRemove ?? SEMANTIC_DIFF_REMOVE;
    const t = presetPreviewTheme as Record<string, string | undefined>;
    const fallback =
      key === "link" ? "#92bcff"
      : key === "searchMatch" ? "#e6e6e6"
      : key === "searchMatchActive" ? "#39d353"
      : "#0d0d11";
    return t[key] ?? fallback;
  };
  const handlePresetColor = (key: OverrideKey, hex: string | null) => {
    if (!activeColorPreset) return;
    if (hex) setPresetColor(activeColorPreset.id, key, hex);
    else clearPresetColor(activeColorPreset.id, key);
  };
  // There is no "create with overrides" action, so both Duplicate and Import
  // create an empty preset and fill it. `createColorPreset` activates what it
  // makes and zustand's set is synchronous, so the fresh id is readable
  // immediately — and reading it back beats re-deriving the id format here.
  const createPresetWithOverrides = (name: string, overrides: ColorOverrides) => {
    createColorPreset(name);
    const newId = useAppStore.getState().activeColorPresetId;
    if (!newId) return;
    for (const [key, hex] of Object.entries(overrides)) {
      if (hex) setPresetColor(newId, key as OverrideKey, hex);
    }
  };
  // Export copies to the clipboard: the repo has no file-write path (the dialog
  // plugin is imported for `open` only, and there is no fs write command), and
  // adding one is not this change's job.
  const [exportState, setExportState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (exportState === "idle") return;
    const t = setTimeout(() => setExportState("idle"), 1500);
    return () => clearTimeout(t);
  }, [exportState]);
  const handleExportPreset = () => {
    if (!activeColorPreset) return;
    const json = JSON.stringify(
      { name: activeColorPreset.name, overrides: activeColorPreset.overrides },
      null,
      2,
    );
    void navigator.clipboard
      .writeText(json)
      .then(() => setExportState("copied"))
      .catch(() => setExportState("failed"));
  };
  const handleImportPreset = () => {
    void promptForInput({
      title: "Import color preset",
      label: "Paste preset JSON",
      detail: "The JSON an Export put on your clipboard.",
      confirmLabel: "Import",
      validate: (v) =>
        !v.trim() || parsePresetJson(v) ? null : "Not a preset — paste what Export copied.",
    }).then((raw) => {
      const parsed = raw ? parsePresetJson(raw) : null;
      if (parsed) createPresetWithOverrides(parsed.name, parsed.overrides);
    });
  };

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
              <SettingsRow
                label="Auto-hibernate idle tabs"
                description="Idle background tabs free their WSL processes; reopening the tab resumes them."
              >
                <ToggleSwitch checked={autoHibernateEnabled} onChange={setAutoHibernateEnabled} />
              </SettingsRow>
              {autoHibernateEnabled && (
                <SettingsRow label="Hibernate after idle for">
                  <Dropdown<string>
                    value={String(autoHibernateMinutes)}
                    onChange={(v) => setAutoHibernateMinutes(Number(v) || 30)}
                    options={[
                      { value: "15", label: "15 minutes" },
                      { value: "30", label: "30 minutes" },
                      { value: "60", label: "1 hour" },
                      { value: "120", label: "2 hours" },
                    ]}
                    width={140}
                  />
                </SettingsRow>
              )}
              <SettingsRow label="Auto-paste screenshots">
                <ToggleSwitch checked={autoInsertClipboardImage} onChange={setAutoInsertClipboardImage} />
              </SettingsRow>
              <SettingsRow label="Mask image paths in terminal (beta)" description="The CLI still receives the real path.">
                <ToggleSwitch checked={maskImagePathsInTerminal} onChange={setMaskImagePathsInTerminal} />
              </SettingsRow>
              <SettingsRow label="Remember the screenshot viewer's size">
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
              <SettingsRow label="Hover tooltips" description="File links keep working.">
                <ToggleSwitch checked={hoverTooltips} onChange={setHoverTooltips} />
              </SettingsRow>
              <SettingsRow label="Show path in tabs">
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
              <SettingsRow label="Vertical tab bar" description="Auto swaps to the vertical strip when the window is taller than wide.">
                <SegmentedControl<"auto" | "always" | "never">
                  options={[
                    { value: "auto", label: "Auto" },
                    { value: "always", label: "Always" },
                    { value: "never", label: "Never" },
                  ]}
                  value={verticalTabMode}
                  onChange={setVerticalTabMode}
                />
              </SettingsRow>
              <SettingsRow
                label="Vertical tabbar v2"
                description="Redesigned strip: a project-colour rail spanning each tab, an icon action grid instead of labelled rows, and Jira tickets nested under their project instead of in a separate rail."
              >
                <ToggleSwitch checked={verticalTabBarV2} onChange={setVerticalTabBarV2} />
              </SettingsRow>
              <SettingsRow label="Sidebar side">
                <SegmentedControl<"left" | "right">
                  options={[
                    { value: "left", label: "Left" },
                    { value: "right", label: "Right" },
                  ]}
                  value={sidebarSide}
                  onChange={setSidebarSide}
                />
              </SettingsRow>
              <SettingsRow label="Slash command ghost text">
                <ToggleSwitch checked={slashCommandGhostText} onChange={setSlashCommandGhostText} />
              </SettingsRow>
              <SettingsRow label="Open panes in background">
                <ToggleSwitch checked={openPanesInBackground} onChange={setOpenPanesInBackground} />
              </SettingsRow>
              <SettingsRow label="Open tab-bar menus on hover" description="The + projects and add-pane menus.">
                <ToggleSwitch checked={hoverOpenAddPaneMenu} onChange={setHoverOpenAddPaneMenu} />
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
            <SettingsSection id="danger-zone" title="Danger Zone">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0" }}>
                <div style={{ minWidth: 0, flex: 1, marginRight: 16 }}>
                  <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 13px)", color: "var(--ezy-text-secondary)" }}>Clear local data</div>
                  <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 11px)", color: "var(--ezy-text-muted)", marginTop: 2, lineHeight: 1.3 }}>
                    Wipe preferences, history, recent projects, game scores, or cached CLI paths. Choose what to clear in the next step.
                  </div>
                </div>
                <button
                  onClick={() => setShowClearModal(true)}
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
              {isWindows() && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderTop: "1px solid var(--ezy-border-subtle, rgba(255,255,255,0.06))" }}>
                  <div style={{ minWidth: 0, flex: 1, marginRight: 16 }}>
                    <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 13px)", color: "var(--ezy-text-secondary)" }}>Restart WSL</div>
                    <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 11px)", color: "var(--ezy-text-muted)", marginTop: 2, lineHeight: 1.3 }}>
                      Full reset for when WSL stops responding: shuts WSL down, then respawns every WSL pane (Claude sessions resume).
                      {wslShutdownResult && (
                        <span style={{ display: "block", marginTop: 4, color: "var(--ezy-text-secondary)" }}>
                          {wslShutdownResult}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={handleWslShutdown}
                    disabled={wslShutdownBusy}
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
                      cursor: wslShutdownBusy ? "default" : "pointer",
                      opacity: wslShutdownBusy ? 0.6 : 1,
                      flexShrink: 0,
                      transition: "opacity 120ms ease",
                    }}
                    onMouseEnter={(e) => { if (!wslShutdownBusy) e.currentTarget.style.opacity = "0.85"; }}
                    onMouseLeave={(e) => { if (!wslShutdownBusy) e.currentTarget.style.opacity = "1"; }}
                  >
                    {wslShutdownBusy ? <LoadingDots>Restarting</LoadingDots> : "Restart WSL..."}
                  </button>
                </div>
              )}
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
                        borderRadius: "calc(var(--ezy-radius-scale, 1) * 8px)",
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
                        <div style={{ width: 12, height: 12, borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)", backgroundColor: t.surface.bg }} />
                        <div style={{ width: 12, height: 12, borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)", backgroundColor: t.surface.accent }} />
                        <div style={{ width: 12, height: 12, borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)", backgroundColor: t.surface.cyan }} />
                      </div>
                      <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 13px)", fontWeight: isSelected ? 600 : 400, color: isSelected ? "var(--ezy-text)" : "var(--ezy-text-secondary)" }}>
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
              <SettingsRow label="Project color pane tint">
                <ToggleSwitch checked={projectPaneTint} onChange={setProjectPaneTint} />
              </SettingsRow>
              {projectPaneTint && (
                <SettingsRow label="Tint strength">
                  <FontSizeStepper
                    value={projectPaneTintStrength}
                    onChange={setProjectPaneTintStrength}
                    min={1}
                    max={15}
                    suffix="%"
                  />
                </SettingsRow>
              )}
              <SettingsRow label="Project color header tint">
                <ToggleSwitch checked={projectHeaderTint} onChange={setProjectHeaderTint} />
              </SettingsRow>
              {projectHeaderTint && (
                <SettingsRow label="Tint strength">
                  <FontSizeStepper
                    value={projectHeaderTintStrength}
                    onChange={setProjectHeaderTintStrength}
                    min={1}
                    max={30}
                    suffix="%"
                  />
                </SettingsRow>
              )}
              <SettingsRow label="Lighten active pane" description="Off: the pane header alone marks the active pane.">
                <ToggleSwitch checked={activePaneLift} onChange={setActivePaneLift} />
              </SettingsRow>
              <SettingsRow label="Slide-in header buttons" description="Off: the buttons always reserve their space and fade in on hover.">
                <ToggleSwitch checked={headerButtonsSlide} onChange={setHeaderButtonsSlide} />
              </SettingsRow>
              {/* Shape, not color — so it sits after the color rows and before
                  the typography pair below. Dragging this visibly rounds the
                  Default button beside it: the control is drawn with the same
                  --ezy-radius-scale it sets, so the row previews itself. */}
              <SettingsRow
                label="Corners"
                description="Default keeps each theme's own roundness."
              >
                <SliderWithReset
                  value={radiusScaleOverride ?? theme.radiusScale ?? 1}
                  onChange={setRadiusScaleOverride}
                  onReset={() => setRadiusScaleOverride(null)}
                  isDefault={radiusScaleOverride === null}
                  min={0}
                  max={3}
                  // 0.25 is the finest step that still renders: below it the
                  // smallest base radius (4px) moves by less than a pixel.
                  step={0.25}
                />
              </SettingsRow>
              {/* Last in the section on purpose — the color rows above must not
                  be split from their own strength stepper. ONE row for the
                  face AND the size it renders at: the size belongs to the
                  font, so it lives beside it instead of as its own row. */}
              <SettingsRow
                label="UI font"
                description="Scales every label, menu and panel; terminal fonts live in the CLI tab."
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "flex-end",
                    flexWrap: "wrap",
                    gap: 6,
                  }}
                >
                  {/* A dropdown rather than the segmented row this used to be:
                      six faces split a segmented control into strips too narrow
                      to read a name in, which defeats setting each option in
                      its own face. 150px fits the longest name ("Schibsted
                      Grotesk") and still leaves the stepper on the same line. */}
                  <Dropdown<UiFont>
                    options={UI_FONT_OPTIONS}
                    value={uiFont}
                    onChange={setUiFont}
                    width={150}
                  />
                  <FontSizeStepper
                    value={uiFontSize}
                    onChange={setUiFontSize}
                    min={UI_FONT_SIZE_MIN}
                    max={UI_FONT_SIZE_MAX}
                  />
                </div>
              </SettingsRow>
            </SettingsSection>
            <SettingsSection
              id="terminal-colors"
              title="Terminal colors"
              description="Only colors you set change — the rest follows the theme."
            >
              {/* vertical: the dropdown + three buttons are wider than the
                  label column tolerates — side-by-side crushed the label. */}
              <SettingsRow label="Color preset" vertical>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <Dropdown
                    value={activeColorPresetId ?? "none"}
                    onChange={(v) => setActiveColorPreset(v === "none" ? null : v)}
                    options={[
                      { value: "none", label: "None (theme colors)" },
                      ...colorPresets.map((p) => ({ value: p.id, label: p.name })),
                    ]}
                    width={200}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      void promptForInput({
                        title: "New color preset",
                        label: "Name",
                        confirmLabel: "Create",
                        validate: (v) => (v.trim() ? null : "Name the preset"),
                      }).then((name) => {
                        if (name?.trim()) createColorPreset(name.trim());
                      });
                    }}
                    style={PRESET_BTN_STYLE}
                  >
                    New
                  </button>
                  {/* Import sits with New: both make a preset, and neither
                      needs one selected first. */}
                  <button type="button" onClick={handleImportPreset} style={PRESET_BTN_STYLE}>
                    Import
                  </button>
                  {activeColorPreset && (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          void promptForInput({
                            title: "Rename preset",
                            label: "Name",
                            initialValue: activeColorPreset.name,
                            confirmLabel: "Rename",
                            validate: (v) => (v.trim() ? null : "Name the preset"),
                          }).then((name) => {
                            if (name?.trim()) renameColorPreset(activeColorPreset.id, name.trim());
                          });
                        }}
                        style={PRESET_BTN_STYLE}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          createPresetWithOverrides(
                            `${activeColorPreset.name} copy`,
                            activeColorPreset.overrides,
                          )
                        }
                        style={PRESET_BTN_STYLE}
                      >
                        Duplicate
                      </button>
                      {/* The label carries the result for ~1.5s — the clipboard
                          gives no other sign it worked, and a silent failure
                          would look identical to a success. */}
                      <button type="button" onClick={handleExportPreset} style={PRESET_BTN_STYLE}>
                        {exportState === "copied" ? "Copied" : exportState === "failed" ? "Failed" : "Export"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void confirmAction({
                            title: "Reset preset",
                            detail: `Clear all color overrides in "${activeColorPreset.name}"? Every color returns to the current theme's defaults.`,
                            confirmLabel: "Reset",
                            danger: true,
                          }).then((ok) => {
                            if (ok) clearPresetColors(activeColorPreset.id);
                          });
                        }}
                        style={PRESET_BTN_STYLE}
                      >
                        Reset
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void confirmAction({
                            title: "Delete preset",
                            detail: `Delete "${activeColorPreset.name}"? Panes return to plain theme colors.`,
                            confirmLabel: "Delete",
                            danger: true,
                          }).then((ok) => {
                            if (ok) deleteColorPreset(activeColorPreset.id);
                          });
                        }}
                        style={{ ...PRESET_BTN_STYLE, color: "var(--ezy-red)" }}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </SettingsRow>
              {/* Shown with or without a preset: with none it is the plain
                  theme, which is exactly what "None (theme colors)" means. */}
              <SettingsRow label="Preview" vertical>
                <TerminalColorsPreview theme={presetPreviewTheme} />
              </SettingsRow>
              {!activeColorPreset ? (
                <div
                  style={{
                    padding: "8px 0 2px",
                    fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                    color: "var(--ezy-text-muted)",
                  }}
                >
                  Select or create a preset to customize colors.
                </div>
              ) : (
                <>
                  {CORE_OVERRIDE_KEYS.map((key) => (
                    <SettingsRow
                      key={key}
                      label={OVERRIDE_KEY_LABELS[key].label}
                      description={OVERRIDE_KEY_LABELS[key].description}
                    >
                      <ColorSwatchPicker
                        value={activeColorPreset.overrides[key] ?? null}
                        effectiveColor={presetEffectiveColor(key)}
                        onChange={(hex) => handlePresetColor(key, hex)}
                        label={OVERRIDE_KEY_LABELS[key].label}
                      />
                    </SettingsRow>
                  ))}
                  <SettingsRow
                    label="ANSI colors"
                    description="The 16 palette colors terminal output is drawn with."
                    vertical
                  >
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(8, minmax(0, 44px))",
                        gap: 8,
                      }}
                    >
                      {ANSI_OVERRIDE_KEYS.map((key) => (
                        <div
                          key={key}
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                            gap: 3,
                          }}
                        >
                          <ColorSwatchPicker
                            value={activeColorPreset.overrides[key] ?? null}
                            effectiveColor={presetEffectiveColor(key)}
                            onChange={(hex) => handlePresetColor(key, hex)}
                            label={OVERRIDE_KEY_LABELS[key].label}
                          />
                          <span
                            style={{
                              fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
                              color: "var(--ezy-text-muted)",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {/* "Bright black" → "Black" under the bright row's
                                swatch: the row split already says bright. */}
                            {OVERRIDE_KEY_LABELS[key].label.replace(/^Bright /, "")}
                          </span>
                        </div>
                      ))}
                    </div>
                  </SettingsRow>
                  <SettingsRow
                    label={OVERRIDE_KEY_LABELS.accent.label}
                    description={OVERRIDE_KEY_LABELS.accent.description}
                  >
                    <ColorSwatchPicker
                      value={activeColorPreset.overrides.accent ?? null}
                      effectiveColor={presetEffectiveColor("accent")}
                      onChange={(hex) => handlePresetColor("accent", hex)}
                      label={OVERRIDE_KEY_LABELS.accent.label}
                    />
                  </SettingsRow>
                  <SettingsRow
                    label={OVERRIDE_KEY_LABELS.diffAdd.label}
                    description={OVERRIDE_KEY_LABELS.diffAdd.description}
                  >
                    <ColorSwatchPicker
                      value={activeColorPreset.overrides.diffAdd ?? null}
                      effectiveColor={presetEffectiveColor("diffAdd")}
                      onChange={(hex) => handlePresetColor("diffAdd", hex)}
                      label={OVERRIDE_KEY_LABELS.diffAdd.label}
                    />
                  </SettingsRow>
                  <SettingsRow
                    label={OVERRIDE_KEY_LABELS.diffRemove.label}
                    description={OVERRIDE_KEY_LABELS.diffRemove.description}
                  >
                    <ColorSwatchPicker
                      value={activeColorPreset.overrides.diffRemove ?? null}
                      effectiveColor={presetEffectiveColor("diffRemove")}
                      onChange={(hex) => handlePresetColor("diffRemove", hex)}
                      label={OVERRIDE_KEY_LABELS.diffRemove.label}
                    />
                  </SettingsRow>
                </>
              )}
            </SettingsSection>
            <SettingsSection id="app-icon" title="App icon">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 8 }}>
                {APP_ICON_OPTIONS.map((opt) => {
                  const isSelected = opt.id === appIconVariant;
                  return (
                    <button
                      key={opt.id}
                      onClick={() => {
                        setAppIconVariant(opt.id);
                        void applyAppIcon(opt.id);
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "10px 12px",
                        borderRadius: "calc(var(--ezy-radius-scale, 1) * 8px)",
                        // 1px border in every state + inset selected ring, same
                        // zero-layout-cost trick as the theme cards above.
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
                      <AppIconPreview variant={opt.id} size={36} />
                      <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 13px)", fontWeight: isSelected ? 600 : 400, color: isSelected ? "var(--ezy-text)" : "var(--ezy-text-secondary)" }}>
                        {opt.name}
                      </span>
                      {isSelected && <FaCheck size={12} color={theme.surface.accent} style={{ marginLeft: "auto" }} />}
                    </button>
                  );
                })}
              </div>
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
              <SettingsRow
                label="Block cursor opacity"
                description="At 100% the character shows in the cursor accent color."
              >
                <SliderWithReset
                  value={cursorBlockOpacity}
                  onChange={setCursorBlockOpacity}
                  onReset={() => setCursorBlockOpacity(30)}
                  isDefault={cursorBlockOpacity === 30}
                  min={10}
                  max={100}
                  step={5}
                />
              </SettingsRow>
            </SettingsSection>
          </>
        );

      case "cli":
        return (
          <>
            <SettingsSection
              id="cli-install"
              title="AI CLIs"
              description="Checked on the machine the active project's panes run on."
            >
              {AI_CLIS.map((cli) => (
                <CliInstallRow key={cli} cli={cli} />
              ))}
            </SettingsSection>
            <SettingsSection id="cli-options" title="CLI Options">
            <SettingsRow label="Terminal font">
              <Dropdown<string>
                value={terminalFontFamily}
                onChange={setTerminalFontFamily}
                options={fontOptions}
                width={260}
              />
            </SettingsRow>
            <SettingsRow label="Per-CLI font">
              <ToggleSwitch checked={perCliFontFamily} onChange={setPerCliFontFamily} />
            </SettingsRow>
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
                      <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 13px)", fontWeight: 500, color: "var(--ezy-text)" }}>{label}</span>
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
                    <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-text-secondary)" }}>Font size</span>
                    <FontSizeStepper
                      value={cliFontSizes[cliType] ?? DEFAULT_CLI_FONT_SIZE}
                      onChange={(v) => setCliFontSize(cliType, v)}
                    />
                  </div>
                  {perCliFontFamily && (
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                      <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-text-secondary)" }}>Font</span>
                      <Dropdown<string>
                        value={cliFontFamilies[cliType] ?? terminalFontFamily}
                        onChange={(v) => setCliFontFamily(cliType, v)}
                        options={fontOptions}
                        width={200}
                      />
                    </div>
                  )}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {isYolo ? (
                        <span style={{
                          fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
                          fontWeight: 700,
                          padding: "2px 5px",
                          borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
                          backgroundColor: "var(--ezy-red, #e55)",
                          color: "#fff",
                          lineHeight: 1,
                          letterSpacing: "0.06em",
                        }}>YOLO</span>
                      ) : (
                        <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-text-muted)" }}>YOLO</span>
                      )}
                      <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-text-muted)" }}>mode</span>
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
                            borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                            border: "1px solid var(--ezy-border-light)",
                            color: "var(--ezy-text-secondary)",
                            fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
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
                          <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 11px)", color: "var(--ezy-text-muted)" }}>Statusline</div>
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
                            <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-text-secondary)" }}>{feat.label}</span>
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
            <SettingsSection id="cli-integration" title="Terminal integration">
              <SettingsRow
                vertical
                label="Report terminal type to AI CLIs (TERM_PROGRAM)"
                description="Claude enables extra features only for terminals it recognises. Applies to new panes."
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
                description="MADE turns iTerm2, Kitty and Ghostty into in-app toasts. Applies to new sessions."
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
                        fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
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
              <SettingsRow
                label="Gemini notifications"
                description="Finished Gemini panes toast like Claude and Codex. Applies to new sessions."
              >
                <div className="flex items-center gap-2">
                  {geminiNotif === "unavailable" ? (
                    <span
                      style={{
                        fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                        color: "var(--ezy-text-muted)",
                      }}
                    >
                      Gemini not detected
                    </span>
                  ) : geminiNotif === "on" ? (
                    <span
                      style={{
                        fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                        color: "var(--ezy-accent)",
                      }}
                    >
                      Enabled
                    </span>
                  ) : geminiNotif === "off" ? (
                    <>
                      <span
                        style={{
                          fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                          color: "var(--ezy-text-muted)",
                        }}
                      >
                        Disabled in Gemini
                      </span>
                      <button
                        onClick={() => {
                          setGeminiNotifApply({ status: "idle" });
                          void setGeminiNotifications(true, "wsl")
                            .then(() => setGeminiNotif("on"))
                            .catch((e) =>
                              setGeminiNotifApply({ status: "fail", msg: String(e) }),
                            );
                        }}
                        style={{
                          height: 24,
                          padding: "0 10px",
                          borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
                          border: "none",
                          background: "var(--ezy-accent-dim)",
                          color: "#fff",
                          fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                          fontWeight: 500,
                          cursor: "pointer",
                        }}
                        onMouseEnter={(e) =>
                          (e.currentTarget.style.backgroundColor = "var(--ezy-accent-hover)")
                        }
                        onMouseLeave={(e) =>
                          (e.currentTarget.style.backgroundColor = "var(--ezy-accent-dim)")
                        }
                      >
                        Enable
                      </button>
                    </>
                  ) : null}
                  {geminiNotifApply.status === "fail" && (
                    <span
                      style={{
                        fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                        color: "var(--ezy-red)",
                      }}
                      data-tooltip={geminiNotifApply.msg}
                    >
                      Failed
                    </span>
                  )}
                </div>
              </SettingsRow>
            </SettingsSection>
          </>
        );

      case "browser":
        return (
          <>
            <SettingsSection id="browser" title="Browser">
              <SettingsRow
                label="Use the legacy preview for dev servers"
                description="Only affects localhost — websites always use the native browser."
              >
                <ToggleSwitch checked={browserIframeForLocalhost} onChange={setBrowserIframeForLocalhost} />
              </SettingsRow>
              <SettingsRow
                label="Ask before saving a download"
                description="Approving re-requests the file, which some one-time download links will not allow."
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
              <SettingsSection id="terminal-backend" title="Backend" description="Used when a project's path doesn't decide; a per-project setting overrides it.">
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
                {terminalBackend === "wsl" && (
                  <SettingsRow label="WSL distribution" description="Applies to new terminals.">
                    <Dropdown<string>
                      value={wslDistro ?? ""}
                      onChange={handleWslDistroChange}
                      options={[
                        { value: "", label: "Default" },
                        // Keep a saved distro visible even if it was
                        // uninstalled — a blank control would hide that the
                        // override is still active.
                        ...(wslDistro && !wslDistros.includes(wslDistro)
                          ? [{ value: wslDistro, label: `${wslDistro} (not found)` }]
                          : []),
                        ...wslDistros.map((d) => ({ value: d, label: d })),
                      ]}
                      width={200}
                    />
                  </SettingsRow>
                )}
              </SettingsSection>
            )}
            <SettingsSection id="native-renderer" title="Native renderer">
              <SettingsRow label="Native terminal renderer" description="GPU renderer instead of xterm panes. Open terminals reload.">
                <ToggleSwitch checked={useNativeTerminalRenderer} onChange={setUseNativeTerminalRenderer} />
              </SettingsRow>
              <SettingsRow
                label="Share one GPU device"
                description="Panes open ~4x faster; a driver reset then affects every shared pane at once."
              >
                <ToggleSwitch checked={nativeSharedGpu} onChange={setNativeSharedGpu} />
              </SettingsRow>
              <SettingsRow
                label="Graphics backend"
                description={gpuInfo ? undefined : "Available once a native pane is open."}
              >
                <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-text-muted)", textAlign: "right" }}>
                  {gpuInfo
                    ? `${gpuInfo.backend} · ${gpuInfo.name}${gpuInfo.shared ? "" : " (per-pane adapter)"}`
                    : "—"}
                </span>
              </SettingsRow>
              <SettingsRow label="Mouse wheel acceleration" description="Fullscreen CLIs do their own acceleration.">
                <ToggleSwitch checked={wheelAcceleration} onChange={setWheelAcceleration} />
              </SettingsRow>
              <SettingsRow label="Scroll thumb acceleration" description="Off is a strict 1:1 drag, so the top of the bar is the top of the buffer.">
                <ToggleSwitch checked={scrollThumbAcceleration} onChange={setScrollThumbAcceleration} />
              </SettingsRow>
            </SettingsSection>
            <SettingsSection id="terminal-rendering" title="Rendering">
              <SettingsRow label="Line height">
                <SliderWithReset
                  value={terminalLineHeight}
                  onChange={setTerminalLineHeight}
                  onReset={() => setTerminalLineHeight(1)}
                  isDefault={terminalLineHeight === 1}
                  min={1}
                  max={1.6}
                  step={0.05}
                />
              </SettingsRow>
              <SettingsRow label="Bold uses bright colors">
                <ToggleSwitch checked={boldUsesBright} onChange={setBoldUsesBright} />
              </SettingsRow>
              <SettingsRow
                label="Minimum contrast"
                description="Nudges text color until it reads against its background."
              >
                <SegmentedControl<"off" | "4.5" | "7">
                  options={[
                    { value: "off", label: "Off" },
                    { value: "4.5", label: "4.5:1" },
                    { value: "7", label: "7:1" },
                  ]}
                  // 1 is "no ratio enforced" — every other value is the ratio
                  // itself, so the control reads the number back rather than
                  // keeping a second copy of the choice.
                  value={minContrast <= 1 ? "off" : minContrast >= 7 ? "7" : "4.5"}
                  onChange={(v) => setMinContrast(v === "off" ? 1 : Number(v))}
                />
              </SettingsRow>
              <SettingsRow
                label="Dim text strength"
                description="Native panes only."
              >
                <SliderWithReset
                  value={dimStrength}
                  onChange={setDimStrength}
                  onReset={() => setDimStrength(50)}
                  isDefault={dimStrength === 50}
                  min={20}
                  max={80}
                  step={5}
                />
              </SettingsRow>
              <SettingsRow
                label="Scrollback"
                description="Dense layouts scale it down; applies when a pane is created."
              >
                <Dropdown<string>
                  value={String(scrollbackLines)}
                  onChange={(v) => setScrollbackLines(Number(v))}
                  options={[
                    { value: "1000", label: "1 000 lines" },
                    { value: "5000", label: "5 000 lines" },
                    { value: "10000", label: "10 000 lines" },
                    { value: "20000", label: "20 000 lines" },
                    { value: "50000", label: "50 000 lines" },
                    { value: "100000", label: "100 000 lines" },
                  ]}
                  width={160}
                />
              </SettingsRow>
            </SettingsSection>
            <SettingsSection
              id="notifications"
              title="Notifications"
              description="In-app cards when a background pane finishes a turn or needs permission."
            >
              <SettingsRow label="Pane notifications">
                <ToggleSwitch checked={notifEnabled} onChange={setNotifEnabled} />
              </SettingsRow>
              {notifEnabled && (
                <SettingsRow label="Auto-dismiss pane notifications">
                  <ToggleSwitch checked={notifAutoDismiss} onChange={setNotifAutoDismiss} />
                </SettingsRow>
              )}
              {notifEnabled && notifAutoDismiss && (
                <SettingsRow label="Dismiss after">
                  <Dropdown<string>
                    value={String(notifAutoDismissSeconds)}
                    onChange={(v) => setNotifAutoDismissSeconds(Number(v) || 30)}
                    options={[
                      { value: "10", label: "10 seconds" },
                      { value: "30", label: "30 seconds" },
                      { value: "60", label: "1 minute" },
                      { value: "300", label: "5 minutes" },
                    ]}
                    width={140}
                  />
                </SettingsRow>
              )}
              {notifEnabled && (
                <SettingsRow
                  label="Notification sound"
                  description="Each project gets its own sound — change it from the tab's right-click menu."
                >
                  <ToggleSwitch checked={notifSoundEnabled} onChange={setNotifSoundEnabled} />
                </SettingsRow>
              )}
              {notifEnabled && notifSoundEnabled && (
                <SettingsRow label="Volume">
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <FontSizeStepper
                      value={notifSoundVolume}
                      onChange={setNotifSoundVolume}
                      min={0}
                      max={100}
                      stepSize={10}
                      suffix="%"
                    />
                    <svg
                      onClick={() => previewSound("chime")}
                      role="button"
                      aria-label="Test notification sound"
                      width="20"
                      height="20"
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      style={{ cursor: "pointer", color: "var(--ezy-text-muted)", padding: 2 }}
                      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--ezy-text)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = "var(--ezy-text-muted)"; }}
                    >
                      <path d="M4.75 2.57a.75.75 0 011.14-.64l8 5.43a.75.75 0 010 1.28l-8 5.43a.75.75 0 01-1.14-.64V2.57z" />
                    </svg>
                  </div>
                </SettingsRow>
              )}
              {notifEnabled && (
                <SettingsRow
                  label="Notification popups outside the app"
                  description="MADE's own cards, not Windows notifications."
                >
                  <ToggleSwitch checked={notifOsPopupsEnabled} onChange={setNotifOsPopupsEnabled} />
                </SettingsRow>
              )}
              {notifEnabled && (
                <SettingsRow label="System notifications while minimized">
                  <ToggleSwitch checked={notifSystemMinimized} onChange={setNotifSystemMinimized} />
                </SettingsRow>
              )}
              {notifEnabled && (
                <SettingsRow
                  label="Switch to notifying pane while minimized"
                  description="Re-targets the tab and pane in the background — the window stays minimized."
                >
                  <ToggleSwitch checked={notifAutoSwitchMinimized} onChange={setNotifAutoSwitchMinimized} />
                </SettingsRow>
              )}
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
              description="Extra .md templates offered when creating a project."
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
                        borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
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
                          fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                          color: "var(--ezy-text)",
                          backgroundColor: "var(--ezy-surface-raised)",
                          border: `1px solid ${filenameInvalid ? "#e55" : "var(--ezy-border)"}`,
                          borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
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
                          fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
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
                          fontSize: "calc(var(--ezy-font-scale, 1) * 14px)",
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
                    fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                    fontWeight: 500,
                    color: "var(--ezy-text-secondary)",
                    backgroundColor: "var(--ezy-surface)",
                    border: "1px solid var(--ezy-border)",
                    borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
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
              <SettingsRow label="Dev server link on tabs">
                <SegmentedControl
                  options={[
                    { value: "all" as DevServerTabIconMode, label: "All tabs" },
                    { value: "active" as DevServerTabIconMode, label: "Active tab" },
                    { value: "off" as DevServerTabIconMode, label: "Off" },
                  ]}
                  value={devServerTabIcon}
                  onChange={setDevServerTabIcon}
                />
              </SettingsRow>
              <SettingsRow label="Dev server button in pane headers">
                <ToggleSwitch checked={devServerButtonInHeader} onChange={setDevServerButtonInHeader} />
              </SettingsRow>
            </SettingsSection>
            <SettingsSection id="codereview" title="Code Review">
              <SettingsRow label="Collapse all files">
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
              <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 11px)", color: "var(--ezy-text-muted)", padding: "4px 0 0", lineHeight: 1.3 }}>
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
                <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 13px)", color: "var(--ezy-text-secondary)", flex: 1 }}>Manage Snippets</span>
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
                <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 13px)", color: "var(--ezy-text-secondary)", flex: 1 }}>Keyboard Shortcuts</span>
                <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 11px)", color: "var(--ezy-text-muted)", fontFamily: "monospace" }}>Ctrl+/</span>
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
              <SettingsRow label="Working badge reads the status line">
                <ToggleSwitch checked={aiWorkingMarkerDetection} onChange={setAiWorkingMarkerDetection} />
              </SettingsRow>
            </SettingsSection>
            <AiTimeStatsSection bursts={aiTimeBursts} onClear={clearAiTimeStats} />
          </>
        );

      case "nexusmind":
        return <NexusMindSection />;

      case "jira":
        return (
          <>
            <SettingsSection id="jira" title="Jira" description={jiraPluginTargetNote}>
              <SettingsRow
                label="Jira mode"
                description="Hides dev server and sidebar buttons."
              >
                <ToggleSwitch checked={jiraMode} onChange={setJiraMode} />
              </SettingsRow>
              {/* One row per CLI: all three can reach Atlassian over the same
                  MCP endpoint, and a ticket pane can now run on any of them. */}
              {JIRA_CLIS.map((cli) => (
                <JiraPluginRow key={cli} cli={cli} />
              ))}
              <SettingsRow
                vertical
                label="Jira sites"
                description="Name or full address."
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 6, width: 380, maxWidth: "100%" }}>
                  {jiraSitesList.map((origin) => (
                    <div
                      key={origin}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "5px 8px",
                        border: "1px solid var(--ezy-border)",
                        borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
                        backgroundColor: "var(--ezy-surface)",
                      }}
                    >
                      <span
                        data-tooltip={origin}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                          color: "var(--ezy-text)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {jiraSiteName(origin) ?? origin}
                      </span>
                      <label
                        className="flex items-center gap-1.5"
                        style={{
                          fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                          color: "var(--ezy-text-muted)",
                          cursor: "pointer",
                          whiteSpace: "nowrap",
                          flexShrink: 0,
                        }}
                      >
                        <input
                          type="radio"
                          name="jira-default-site"
                          checked={jiraDefaultSiteId === origin}
                          onChange={() => setJiraDefaultSite(origin)}
                        />
                        Default
                      </label>
                      {/* Bare svg — a <button> inflates the 26px row. */}
                      <svg
                        role="button"
                        tabIndex={0}
                        aria-label={`Remove ${origin}`}
                        data-tooltip="Remove site"
                        onClick={() => removeJiraSite(origin)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            removeJiraSite(origin);
                          }
                        }}
                        width="14"
                        height="14"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        style={{ color: "var(--ezy-text-muted)", cursor: "pointer", flexShrink: 0, outline: "none" }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--ezy-red)")}
                        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--ezy-text-muted)")}
                      >
                        <line x1="4" y1="4" x2="12" y2="12" />
                        <line x1="12" y1="4" x2="4" y2="12" />
                      </svg>
                    </div>
                  ))}
                  <div className="flex items-center gap-2">
                    <TextInput
                      value={newJiraSite}
                      onChange={setNewJiraSite}
                      placeholder="yourcompany — or a full address"
                    />
                    <button
                      onClick={() => {
                        if (!newJiraSite.trim()) return;
                        addJiraSite(newJiraSite);
                        setNewJiraSite("");
                      }}
                      style={{
                        height: 24,
                        padding: "0 10px",
                        borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
                        border: "none",
                        background: "var(--ezy-accent-dim)",
                        color: "#fff",
                        fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                        fontWeight: 500,
                        cursor: "pointer",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--ezy-accent-hover)")}
                      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "var(--ezy-accent-dim)")}
                    >
                      Add
                    </button>
                  </div>
                </div>
              </SettingsRow>
              {/* Email and token are ONE row: neither works without the other,
                  and the API is either configured or it isn't. Vertical so the
                  two fields get the full width instead of fighting the label
                  column on a narrow pane. */}
              <SettingsRow
                label="Jira account"
                description="Token: id.atlassian.com → Security."
                vertical
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    width: "100%",
                    flexWrap: "wrap",
                  }}
                >
                  <TextInput
                    value={jiraApiEmail}
                    onChange={setJiraApiEmail}
                    placeholder="you@company.com"
                  />
                  <TextInput
                    value={jiraApiToken}
                    onChange={setJiraApiToken}
                    placeholder="API token"
                    password
                  />
                  <TestButton onClick={() => void testJiraCreds()} state={jiraCredPing} />
                </div>
              </SettingsRow>
              {Object.entries(jiraSiteAuthErrors).map(([siteId, msg]) => (
                <div
                  key={siteId}
                  style={{
                    padding: "0 0 6px",
                    fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                    color: "var(--ezy-red)",
                  }}
                >
                  Polling paused for {jiraSiteName(siteId) ?? siteId}: {msg}
                </div>
              ))}
              {/* Jira's own notification controls live HERE, not only in
                  Terminal > Notifications. The two Terminal switches
                  ("Notification popups outside the app", "System notifications
                  while minimized") stay global on purpose — they choose the
                  CHANNEL for every notification MADE raises, so duplicating
                  them per source would let the two disagree. What is Jira's to
                  own is WHICH Jira events are worth a notification. */}
              <SettingsRow
                label="Ticket update notifications"
                description="Replies, status and assignee changes."
              >
                <ToggleSwitch checked={jiraNotifEnabled} onChange={setJiraNotifEnabled} />
              </SettingsRow>
              <SettingsRow
                label="New unassigned tickets"
                description="Announces one when it lands in the queue."
              >
                <ToggleSwitch
                  checked={jiraUnassignedNotify}
                  onChange={setJiraUnassignedNotify}
                />
              </SettingsRow>
              <SettingsRow
                label="Notification channels"
                description={
                  notifEnabled
                    ? `${jiraChannelSummary} · change in Terminal.`
                    : "All notifications are off in Terminal."
                }
              >
                <button
                  onClick={() => requestSettingsSection("notifications")}
                  style={{
                    padding: "0 10px",
                    height: 24,
                    borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                    border: "1px solid var(--ezy-border-light)",
                    backgroundColor: "transparent",
                    color: "var(--ezy-text-secondary)",
                    fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                    fontFamily: "inherit",
                    lineHeight: 1,
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = "transparent";
                  }}
                >
                  Open
                </button>
              </SettingsRow>
              <SettingsRow
                label="My assigned tickets"
                description="Adds an Assigned tab."
              >
                <ToggleSwitch checked={jiraAssignedMode} onChange={setJiraAssignedMode} />
              </SettingsRow>
              <SettingsRow
                label="Unassigned tickets"
                description="Open tickets nobody has picked up."
              >
                <ToggleSwitch checked={jiraUnassignedMode} onChange={setJiraUnassignedMode} />
              </SettingsRow>
              <SettingsRow
                label="Ticket list details"
                description="Second line under the ticket key."
              >
                <div className="flex items-center gap-3" style={{ flexWrap: "wrap" }}>
                  {(
                    [
                      ["organization", "Organization"],
                      ["requestType", "Request type"],
                      ["updated", "Updated"],
                      ["created", "Created"],
                      ["priority", "Priority"],
                      ["reporter", "Reporter"],
                    ] as const
                  ).map(([k, label]) => (
                    <label
                      key={k}
                      className="flex items-center gap-1.5"
                      style={{
                        fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                        color: "var(--ezy-text)",
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={jiraRowMetaShow[k]}
                        onChange={(e) => setJiraRowMetaShow({ [k]: e.target.checked })}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </SettingsRow>
              <JiraExtraFieldsRow
                where="rows"
                label="More details in ticket lists"
                description="Any other Jira field, as a column."
                fields={jiraPickableFields}
                selected={jiraExtraFields.rows}
                onChange={(ids) => setJiraExtraFields("rows", ids)}
              />
              <JiraExtraFieldsRow
                where="header"
                label="More details in the pane header"
                description="Any other Jira field."
                fields={jiraPickableFields}
                selected={jiraExtraFields.header}
                onChange={(ids) => setJiraExtraFields("header", ids)}
              />
              <SettingsRow
                label="Status indicator"
                description="Where the status colour sits."
              >
                <SegmentedControl<"both" | "stripe" | "badge">
                  options={[
                    { value: "both", label: "Both" },
                    { value: "stripe", label: "Left edge" },
                    { value: "badge", label: "Badge" },
                  ]}
                  value={jiraStatusIndicator}
                  onChange={setJiraStatusIndicator}
                />
              </SettingsRow>
              <SettingsRow
                label="Group tickets by"
                description="Collapsible groups with counts."
              >
                <SegmentedControl<"flat" | "status" | "category">
                  options={[
                    { value: "flat", label: "None" },
                    { value: "status", label: "Status" },
                    { value: "category", label: "Category" },
                  ]}
                  value={jiraListGrouping}
                  onChange={setJiraListGrouping}
                />
              </SettingsRow>
              <SettingsRow
                label="Status colours"
                description="Manual lets you pin each status."
              >
                <SegmentedControl<"auto" | "manual">
                  options={[
                    { value: "auto", label: "Auto" },
                    { value: "manual", label: "Manual" },
                  ]}
                  value={jiraStatusColorMode}
                  onChange={setJiraStatusColorMode}
                />
              </SettingsRow>
              {jiraStatusColorMode === "manual" &&
                (jiraKnownStatuses.length === 0 ? (
                  <SettingsRow
                    label="No statuses yet"
                    description="Appear after the first poll."
                  >
                    <span />
                  </SettingsRow>
                ) : (
                  jiraKnownStatuses.map((s) => (
                    <SettingsRow key={s.key} label={s.label}>
                      <ColorSwatchPicker
                        value={jiraStatusColors?.[s.key] ?? null}
                        effectiveColor={jiraStatusColors?.[s.key] ?? s.auto}
                        onChange={(hex) => setJiraStatusColor(s.key, hex)}
                        label={`${s.label} colour`}
                      />
                    </SettingsRow>
                  ))
                ))}
              <SettingsRow
                label="Ticket list width"
                description="Also draggable from the list edge."
                vertical
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
                  {(
                    [
                      ["tickets", "Tickets"],
                      ["list", "Assigned & Unassigned"],
                    ] as const
                  ).map(([which, label]) => (
                    <div
                      key={which}
                      style={{ display: "flex", alignItems: "center", gap: 10, width: "100%" }}
                    >
                      <span
                        style={{
                          fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                          color: "var(--ezy-text-secondary)",
                          width: 150,
                          flexShrink: 0,
                        }}
                      >
                        {label}
                      </span>
                      <SliderWithReset
                        value={jiraRailWidths[which] ?? DEFAULT_JIRA_RAIL_WIDTHS[which]}
                        min={JIRA_RAIL_MIN_WIDTH}
                        max={JIRA_RAIL_MAX_WIDTH}
                        step={4}
                        onChange={(v) => setJiraRailWidth(which, v)}
                        onReset={() => setJiraRailWidth(which, DEFAULT_JIRA_RAIL_WIDTHS[which])}
                        isDefault={
                          (jiraRailWidths[which] ?? DEFAULT_JIRA_RAIL_WIDTHS[which])
                          === DEFAULT_JIRA_RAIL_WIDTHS[which]
                        }
                      />
                    </div>
                  ))}
                </div>
              </SettingsRow>
              <SettingsRow
                label="Ticket pane header"
                description="Shown in the ticket's CLI pane header."
              >
                <div className="flex items-center gap-3" style={{ flexWrap: "wrap" }}>
                  {(
                    [
                      ["status", "Status"],
                      ["summary", "Summary"],
                      ["organization", "Organization"],
                      ["requestType", "Request type"],
                      ["assignee", "Assignee"],
                      ["priority", "Priority"],
                      ["reporter", "Reporter"],
                      ["updated", "Updated"],
                    ] as const
                  ).map(([k, label]) => (
                    <label
                      key={k}
                      className="flex items-center gap-1.5"
                      style={{
                        fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                        color: "var(--ezy-text)",
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={jiraHeaderShow[k]}
                        onChange={(e) => setJiraHeaderShow({ [k]: e.target.checked })}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </SettingsRow>
              <SettingsRow
                label="Claude pane side"
                description="The ticket's browser takes the other side."
              >
                <SegmentedControl<"left" | "right">
                  options={[
                    { value: "left", label: "Left" },
                    { value: "right", label: "Right" },
                  ]}
                  value={jiraClaudeSide}
                  onChange={setJiraClaudeSide}
                />
              </SettingsRow>
              <SettingsRow
                label="Sub-ticket mode"
                description="Stacked shows a ticket and its sub-tickets at once, each foldable to its header."
              >
                <SegmentedControl<"default" | "stacked">
                  options={[
                    { value: "default", label: "Default" },
                    { value: "stacked", label: "Stacked panes" },
                  ]}
                  value={jiraSubticketMode}
                  onChange={setJiraSubticketMode}
                />
              </SettingsRow>
              <SettingsRow
                label="Detect pasted tickets"
                description="A ticket link pasted into the address bar opens as its own ticket instead of replacing this one."
              >
                <ToggleSwitch
                  checked={jiraDetectPastedTickets}
                  onChange={setJiraDetectPastedTickets}
                />
              </SettingsRow>
              <SettingsRow
                label="Switch to detected ticket"
                description="Manual opens it in the background and offers a Switch button."
              >
                <SegmentedControl<"auto" | "manual">
                  options={[
                    { value: "auto", label: "Automatic" },
                    { value: "manual", label: "Manual" },
                  ]}
                  value={jiraAutoSwitchToDetected}
                  onChange={setJiraAutoSwitchToDetected}
                />
              </SettingsRow>
              <SettingsRow
                label="Detected ticket is archived"
                description="Applies when every conversation of the detected ticket is archived."
              >
                <SegmentedControl<"resume" | "new">
                  options={[
                    { value: "resume", label: "Resume it" },
                    { value: "new", label: "Start new" },
                  ]}
                  value={jiraArchivedTicketAction}
                  onChange={setJiraArchivedTicketAction}
                />
              </SettingsRow>
              <SettingsRow
                label="Default Jira CLAUDE.md"
                description="Copied into new Jira projects unless the source folder already has one."
              >
                <PathPicker
                  value={defaultJiraClaudeMdPath}
                  onChange={setDefaultJiraClaudeMdPath}
                  filters={[{ name: "Markdown", extensions: ["md"] }]}
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
                    fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                    lineHeight: 1.5,
                    fontFamily: "inherit",
                    resize: "vertical",
                    color: "var(--ezy-text)",
                    backgroundColor: "var(--ezy-surface)",
                    border: "1px solid var(--ezy-border)",
                    borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
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
              <SettingsRow
                label="Full-color ticket rows"
                description="Off: only the left edge carries the ticket color."
              >
                <ToggleSwitch checked={jiraRowFullColor} onChange={setJiraRowFullColor} />
              </SettingsRow>
            </SettingsSection>
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
        /* Search empty state. Rows unmount when they don't match, so "the
           content area holds no [data-settings-row]" IS the no-results
           condition — same source of truth as the section-hiding rule above,
           nothing to keep in sync in JS. */
        [data-settings-no-results] {
          display: none;
        }
        [data-settings-search-active] [data-settings-content]:not(:has([data-settings-row])) [data-settings-no-results] {
          display: flex;
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
              fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
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
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
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
                  fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                  color: "var(--ezy-text)",
                }}
              />
              <button
                type="button"
                aria-label="Close search (Esc)"
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
                  borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
                  color: "var(--ezy-text-muted)",
                  cursor: "pointer",
                  flexShrink: 0,
                  transition: "background-color 120ms ease, color 120ms ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)";
                  e.currentTarget.style.color = "var(--ezy-text)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "transparent";
                  e.currentTarget.style.color = "var(--ezy-text-muted)";
                }}
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
                  borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
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
                  borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
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
                fontSize: "calc(var(--ezy-font-scale, 1) * 13px)",
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
      <div ref={contentScrollRef} data-settings-content style={{
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
            ? (
                <>
                  {NAV_SECTIONS.map((s) => (
                    <Fragment key={s.id}>{renderSection(s.id)}</Fragment>
                  ))}
                  {/* display comes from the [data-settings-no-results] CSS
                      above: none while anything matches, flex when nothing
                      does. Do not set display inline. */}
                  <div
                    data-settings-no-results
                    style={{
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 4,
                      paddingTop: 96,
                      textAlign: "center",
                    }}
                  >
                    <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 13px)", color: "var(--ezy-text-secondary)" }}>
                      No matching settings
                    </div>
                    <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 11px)", color: "var(--ezy-text-muted)", lineHeight: 1.4 }}>
                      Nothing matches “{trimmedQuery}”. Esc clears the search.
                    </div>
                  </div>
                </>
              )
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
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 10px)",
              boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
              padding: "24px 28px 20px",
              width: 340,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 15px)", fontWeight: 600, color: "var(--ezy-text)" }}>
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
                    borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
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
                <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-text-muted)" }}>Remember</span>
              </div>
              <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              <div
                onClick={() => setShowReloadConfirm(false)}
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
                  // Persist the opt-out BEFORE the reload tears the page down.
                  // Unlike relaunch(), location.reload() keeps the process alive,
                  // so WebView2 still commits the localStorage write.
                  if (reloadRemember) setConfirmReloadPanes(false);
                  setShowReloadConfirm(false);
                  window.location.reload();
                }}
                style={{
                  padding: "6px 16px",
                  fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                  fontWeight: 500,
                  borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
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
