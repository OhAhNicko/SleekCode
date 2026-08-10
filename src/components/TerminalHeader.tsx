import { useState, useEffect, useRef, useMemo, useCallback, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useOverlayMenu } from "../lib/useOverlayMenu";
import { useOverlayPopupAnchor } from "../native-term/useOverlayPopupAnchor";
import type { TerminalType, TerminalBackend, ProjectSession, SessionIndexEntry } from "../types";
import type { ContextInfo } from "../lib/context-parser";
import { TERMINAL_CONFIGS, toWslPath } from "../lib/terminal-config";
import { getPlatform } from "../lib/platform";
import { supportsSessionResume } from "../lib/session-resume";
import { readSessionsIndex, resolveSessionName, readSessionFirstPrompt, slugify } from "../lib/sessions-index";
import { truncateSessionTitle } from "../lib/session-title";
import { openDevServerUrl, wantsInAppOpen } from "../lib/open-dev-server-url";
import { getQuickOpenServer } from "../lib/dev-server-lookup";
import { useAppStore } from "../store";
import { getProjectColor } from "../store/recentProjectsSlice";
import { getTheme, projectTintBg } from "../lib/themes";
import { findAllTerminalLeaves } from "../lib/layout-utils";
import { jiraInstKeyOfTermPaneId, jiraBaseTicket } from "../lib/jira-layout";
import { relativeShort, relativeShortIso } from "../lib/relative-time";
import { badgeInkFor } from "../lib/jira-colors";
import { buildStatusColorMap, resolveStatusColor } from "../lib/jira-status-colors";
import { fieldLabel } from "../lib/jira-fields";
import { jiraQK, siteForTabIn } from "../lib/jira-sites";
import { FaChevronDown } from "react-icons/fa";
import { FaXmark, FaGripVertical } from "react-icons/fa6";
import { BiRefresh } from "react-icons/bi";
import PaneExpandButton from "./PaneExpandButton";

const TOOL_ORDER: TerminalType[] = ["claude", "codex", "gemini", "shell"];

// Stable fallback so the session-picker anchor hook's effect (anchorRef in
// deps) doesn't restart every render when no anchor is passed.
const NULL_ANCHOR_REF: { current: HTMLDivElement | null } = { current: null };

/** All statusline toggle keys per CLI */
export const STATUSLINE_FEATURES: Record<string, { label: string; clis: TerminalType[] }> = {
  filePath:       { label: "File path",            clis: ["claude", "codex", "gemini"] },
  sessionPicker:  { label: "Session picker",       clis: ["claude", "codex", "gemini"] },
  model:          { label: "Model name",           clis: ["claude", "codex", "gemini"] },
  version:        { label: "CLI version",          clis: ["claude"] },
  speed:          { label: "Speed mode",           clis: ["claude"] },
  cost:           { label: "Session cost",         clis: ["claude"] },
  compactCount:   { label: "Compact count",        clis: ["claude"] },
  effort:         { label: "Effort level",         clis: ["claude", "codex"] },
  rateLimit:      { label: "Rate limits",          clis: ["codex", "gemini"] },
  collabMode:     { label: "Collaboration mode",   clis: ["codex"] },
  summary:        { label: "Session summary",      clis: ["gemini"] },
  thinkingTokens: { label: "Thinking tokens",      clis: ["gemini"] },
  quotaReset:     { label: "Quota reset timer",    clis: ["gemini"] },
  contextBar:     { label: "Context bar",          clis: ["claude", "codex", "gemini"] },
  promptHistory:  { label: "Prompt history",       clis: ["claude", "codex", "gemini"] },
};

/** Default ON/OFF state per statusline toggle key when the user hasn't set one. */
export const STATUSLINE_DEFAULTS: Record<string, boolean> = {
  filePath: true,
  sessionPicker: true,
  model: true,
  contextBar: true,
  promptHistory: true,
};

/** Resolve a statusline toggle value, falling back to the per-key default (off if unspecified). */
export function getStatuslineDefault(key: string): boolean {
  return STATUSLINE_DEFAULTS[key] ?? false;
}

/** Brand colors for each CLI — used for header underline */
export const CLI_BRAND_COLORS: Record<TerminalType, string> = {
  claude: "#D97757",
  codex: "#10a37f",
  gemini: "#8E75B2",
  shell: "var(--ezy-text-muted)",
  devserver: "var(--ezy-text-muted)",
};


export interface PromptEntry {
  line: number;
  text: string;
  timestamp?: number;
  fromComposer: boolean;
}

interface TerminalHeaderProps {
  terminalId: string;
  terminalType: TerminalType;
  isActive: boolean;
  onChangeType: (type: TerminalType) => void;
  onClose: () => void;
  onRestart?: () => void;
  onSwapPane?: (fromTerminalId: string, toTerminalId: string) => void;
  serverName?: string;
  /** When set, sessions index/first-prompt are read from this remote server over SSH. */
  serverId?: string;
  isYolo?: boolean;
  contextInfo?: ContextInfo | null;
  workingDir?: string;
  backend?: TerminalBackend;
  sessionResumeId?: string;
  /** True when sessionResumeId came from restore/explicit switch; false when detected from disk (may be stale). */
  sessionTrusted?: boolean;
  onSwitchSession?: (sessionId: string | undefined) => void;
  /** May be async: the native renderer reads its prompt lines over IPC. */
  getPromptEntries?: () => PromptEntry[] | Promise<PromptEntry[]>;
  onScrollToPromptLine?: (line: number) => void;
  /** Called when the user clicks the context-left widget to trigger a manual refresh. */
  onRefreshContext?: () => void | Promise<void>;
  /** True when this pane is drawn by the native (wgpu) renderer. Shows a
   * neutral NATIVE chip so a mixed native/xterm grid is readable at a glance. */
  isNativeRenderer?: boolean;
  /** Jira stacked sub-tickets: the pane can be folded down to just this header.
   *  Absent everywhere else, so no other pane grows a chevron. */
  collapsible?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

function TerminalIcon({ type }: { type: TerminalType }) {
  const size = 14;
  switch (type) {
    case "claude":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24">
          <path
            d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"
            fill="#D97757"
          />
        </svg>
      );
    case "codex":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24">
          <path
            d="M22.282 9.821a6 6 0 0 0-.516-4.91 6.05 6.05 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a6 6 0 0 0-3.998 2.9 6.05 6.05 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.05 6.05 0 0 0 6.515 2.9A6 6 0 0 0 13.26 24a6.06 6.06 0 0 0 5.772-4.206 6 6 0 0 0 3.997-2.9 6.06 6.06 0 0 0-.747-7.073M13.26 22.43a4.48 4.48 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.8.8 0 0 0 .392-.681v-6.737l2.02 1.168a.07.07 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494M3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.77.77 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646M2.34 7.896a4.5 4.5 0 0 1 2.366-1.973V11.6a.77.77 0 0 0 .388.677l5.815 3.354-2.02 1.168a.08.08 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.08.08 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667m2.01-3.023l-.141-.085-4.774-2.782a.78.78 0 0 0-.785 0L9.409 9.23V6.897a.07.07 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.8.8 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5Z"
            fill="#10a37f"
          />
        </svg>
      );
    case "gemini":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24">
          <path
            d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"
            fill="#8E75B2"
          />
        </svg>
      );
    case "shell":
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
          <rect
            x="1.5"
            y="2.5"
            width="13"
            height="11"
            rx="1.5"
            fill="none"
            stroke="var(--ezy-text-muted)"
            strokeWidth="1"
          />
          <path
            d="M4.5 6L6.5 8L4.5 10"
            stroke="var(--ezy-accent)"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <line
            x1="8"
            y1="10"
            x2="11"
            y2="10"
            stroke="var(--ezy-text-muted)"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      );
  }
}


/** Format a relative time string, e.g. "2h ago", "3d ago" */
const formatRelativeTime = relativeShortIso;

/** Format a timestamp (ms) as relative time */
const formatTimestamp = relativeShort;

/** Longest prompt a hover chip will carry. The chip wraps at 280px, so ~360
 *  chars is about 12 lines — enough to identify any prompt, short enough that a
 *  pasted stack trace cannot fill the screen. */
const TIP_TEXT_MAX = 360;

/** Prompt text for a tooltip: collapsed to one flow (a prompt sent from the
 *  composer keeps its newlines, and a chip is not a document viewer) and capped. */
function truncateForTip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TIP_TEXT_MAX ? `${flat.slice(0, TIP_TEXT_MAX)}…` : flat;
}


/** Merged session item for the picker — combines store + index data */
interface MergedSession {
  id: string;
  name: string;
  isFromStore: boolean;  // true = opened in current MADE session
  isCurrent: boolean;
  isRenamed: boolean;
  modified?: string;     // ISO datetime for historical entries
}

/** Session picker dropdown — lists saved sessions for current project + CLI type */
function SessionPicker({
  sessions,
  currentSessionId,
  contextSessionName,
  anchorRef,
  workingDir,
  backend,
  serverId,
  terminalType,
  onSelect,
  onRename,
  onRemove,
  onNew,
  onClose,
}: {
  sessions: ProjectSession[];
  currentSessionId?: string;
  /** Live session name from contextInfo — used as fallback for current session display */
  contextSessionName?: string;
  anchorRef?: React.RefObject<HTMLDivElement | null>;
  workingDir?: string;
  backend?: TerminalBackend;
  serverId?: string;
  terminalType?: TerminalType;
  onSelect: (sessionId: string) => void;
  onRename: (sessionId: string, newName: string) => void;
  onRemove: (sessionId: string) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const [indexEntries, setIndexEntries] = useState<SessionIndexEntry[]>([]);
  // Fallback slugs from direct JSONL reads, for sessions with no index entry.
  const [fallbackSlugs, setFallbackSlugs] = useState<Record<string, string>>({});
  const fallbackFetchedRef = useRef<Set<string>>(new Set());

  // Fetch sessions-index on mount, then poll every 30s while the dropdown is
  // open so newly created Claude Code sessions appear without reopening.
  useEffect(() => {
    if (!workingDir || !terminalType || !LISTABLE_CLIS.includes(terminalType)) return;
    const isSsh = !!serverId;
    const effectiveBackend: TerminalBackend = isSsh
      ? "ssh"
      : (backend ?? (useAppStore.getState().terminalBackend as TerminalBackend | undefined) ?? "wsl");
    // WSL backend needs a Unix path; SSH workingDir is already remote Unix.
    const pathForBackend = effectiveBackend === "wsl" ? toWslPath(workingDir) : workingDir;
    const fetch = () =>
      readSessionsIndex(pathForBackend, effectiveBackend, serverId, terminalType).then(setIndexEntries);
    fetch();
    const interval = setInterval(fetch, 30_000);
    return () => clearInterval(interval);
  }, [workingDir, backend, terminalType, serverId]);

  // Fetch first-prompt slugs for sessions that lack an index entry AND a store name.
  // This covers the common v2.1.109 case where sessions-index.json doesn't exist.
  useEffect(() => {
    // Claude-only on purpose: `read_session_first_prompt_*` reads a Claude
    // transcript, and the Codex reader already returns `first_user_message`
    // inline so there is nothing left to backfill.
    if (!workingDir || (terminalType && terminalType !== "claude")) return;
    const isSsh = !!serverId;
    const effectiveBackend: TerminalBackend = isSsh
      ? "ssh"
      : (backend ?? (useAppStore.getState().terminalBackend as TerminalBackend | undefined) ?? "wsl");
    const pathForBackend = effectiveBackend === "wsl" ? toWslPath(workingDir) : workingDir;
    const indexIds = new Set(indexEntries.map((e) => e.sessionId));
    const needSlug = sessions.filter((s) =>
      !s.isRenamed && !s.name && !indexIds.has(s.id) && !fallbackFetchedRef.current.has(s.id)
    );
    if (needSlug.length === 0) return;
    needSlug.forEach((s) => fallbackFetchedRef.current.add(s.id));
    Promise.all(
      needSlug.map(async (s) => {
        const prompt = await readSessionFirstPrompt(pathForBackend, effectiveBackend, s.id, serverId);
        return [s.id, prompt] as const;
      })
    ).then((results) => {
      const next: Record<string, string> = {};
      for (const [id, prompt] of results) {
        if (prompt) {
          const slug = slugify(prompt);
          if (slug) next[id] = slug;
        }
      }
      if (Object.keys(next).length > 0) {
        setFallbackSlugs((prev) => ({ ...prev, ...next }));
      }
    });
  }, [sessions, indexEntries, workingDir, backend, terminalType, serverId]);

  // Merge store sessions with index entries
  const mergedSessions = useMemo((): MergedSession[] => {
    const storeIds = new Set(sessions.map((s) => s.id));
    const merged: MergedSession[] = [];

    // Store sessions first (current MADE session)
    for (const s of sessions) {
      const indexEntry = indexEntries.find((e) => e.sessionId === s.id);
      const autoName = indexEntry ? resolveSessionName(indexEntry) : undefined;
      const fallbackSlug = fallbackSlugs[s.id];
      merged.push({
        id: s.id,
        name: s.isRenamed ? s.name : (s.name || autoName || fallbackSlug || (s.id === currentSessionId ? (contextSessionName || s.id.slice(0, 8)) : s.id.slice(0, 8))),
        isFromStore: true,
        isCurrent: s.id === currentSessionId,
        isRenamed: s.isRenamed,
        modified: indexEntry?.modified ?? new Date(s.createdAt).toISOString(),
      });
    }

    // Historical entries from index (not in store)
    for (const entry of indexEntries) {
      if (storeIds.has(entry.sessionId)) continue;
      merged.push({
        id: entry.sessionId,
        name: resolveSessionName(entry),
        isFromStore: false,
        isCurrent: entry.sessionId === currentSessionId,
        isRenamed: false,
        modified: entry.modified,
      });
    }

    // Sort: current first, then by modified desc (newest on top)
    merged.sort((a, b) => {
      if (a.isCurrent) return -1;
      if (b.isCurrent) return 1;
      if (a.modified && b.modified) return b.modified.localeCompare(a.modified);
      if (a.modified) return -1;
      if (b.modified) return 1;
      return 0;
    });

    return merged;
  }, [sessions, indexEntries, currentSessionId, contextSessionName, fallbackSlugs]);

  // Overlay-rendered (kind "session-picker", focus handoff for the inline
  // rename input). All data logic above stays here; the overlay renders the
  // rows and bounces pick/rename/new back.
  useOverlayPopupAnchor({
    id: "terminal-header-session-picker",
    kind: "session-picker",
    open: true, // component only mounts while the picker is open
    anchorRef: anchorRef ?? NULL_ANCHOR_REF,
    payload: {
      sessions: mergedSessions.map((m) => ({
        id: m.id,
        name: m.name,
        isFromStore: m.isFromStore,
        isCurrent: m.isCurrent,
        timeLabel: m.modified ? formatRelativeTime(m.modified) : undefined,
      })),
    },
    onAction: (action, data) => {
      switch (action) {
        case "__dismiss__":
          onClose();
          break;
        case "pick": {
          const id = (data as { id?: string } | undefined)?.id;
          if (id) onSelect(id);
          onClose();
          break;
        }
        case "rename": {
          const d = data as { id?: string; name?: string } | undefined;
          if (d?.id && d?.name) onRename(d.id, d.name);
          break;
        }
        case "remove": {
          const id = (data as { id?: string } | undefined)?.id;
          // Stays open: removing is usually one of several tidy-ups, and the
          // list re-renders one row shorter without losing the user's place.
          if (id) onRemove(id);
          break;
        }
        case "new":
          onNew();
          onClose();
          break;
      }
    },
  });

  return null;
}

/** Format Gemini model ID into human-readable name, e.g. "gemini-2.5-pro-preview-05-06" → "Gemini 2.5 Pro Preview" */
function formatGeminiModel(raw: string): string {
  const m = raw.match(/^gemini-([0-9.]+)-(\w+)(?:-preview)?/i);
  if (!m) return raw;
  const version = m[1];
  const variant = m[2].charAt(0).toUpperCase() + m[2].slice(1);
  const isPreview = /preview/i.test(raw);
  return `Gemini ${version} ${variant}${isPreview ? " Preview" : ""}`;
}

/** Format context window size into compact label, e.g. 1000000 → "1M", 200000 → "200K" */
function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return m % 1 === 0 ? `${m}M` : `${m.toFixed(1)}M`;
  }
  const k = tokens / 1_000;
  return k % 1 === 0 ? `${k}K` : `${k.toFixed(1)}K`;
}

/** Extract last N segments from a file path */
/**
 * Widest a session name may render in the pane header.
 *
 * The name sits last in the header's info row, so without a cap it takes every
 * pixel the other items leave — on a wide pane that is most of the header. At
 * 9px this holds roughly 40 characters, which is a readable name next to the
 * model / context / version items rather than instead of them. The string is
 * already capped at 60 chars upstream (`truncateSessionTitle`); this bounds the
 * PIXELS, which is what a proportional font actually needs.
 */
const SESSION_NAME_MAX_PX = 220;

/**
 * CLIs whose sessions can be listed from disk. A pane of any other type shows
 * only the sessions MADE itself registered.
 */
const LISTABLE_CLIS: TerminalType[] = ["claude", "codex", "gemini"];

function truncatePath(path: string, maxSegments = 3): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = normalized.split("/").filter(Boolean);
  return segments.slice(-maxSegments).join("/");
}

export default function TerminalHeader({
  terminalId,
  terminalType,
  isActive,
  onChangeType,
  onClose,
  onRestart,
  onSwapPane,
  serverName,
  serverId,
  isYolo = false,
  contextInfo,
  workingDir,
  backend,
  sessionResumeId,
  sessionTrusted = false,
  onSwitchSession,
  getPromptEntries,
  onScrollToPromptLine,
  onRefreshContext,
  isNativeRenderer = false,
  collapsible = false,
  collapsed = false,
  onToggleCollapse,
}: TerminalHeaderProps) {
  const contextPercent = contextInfo?.percent ?? null;
  const [refreshingContext, setRefreshingContext] = useState(false);

  const handleContextRefreshClick = useCallback(async () => {
    if (!onRefreshContext || refreshingContext) return;
    setRefreshingContext(true);
    try {
      await onRefreshContext();
    } finally {
      setRefreshingContext(false);
    }
  }, [onRefreshContext, refreshingContext]);
  const config = TERMINAL_CONFIGS[terminalType];
  const slToggles = useAppStore((s) => s.statuslineToggles[terminalType]);
  /** Check if a statusline feature is shown (falls back to the per-key default). */
  const sl = (key: string) => slToggles?.[key] ?? getStatuslineDefault(key);

  const showPromptHistoryButton =
    sl("promptHistory") &&
    (terminalType === "claude" || terminalType === "codex" || terminalType === "gemini") &&
    !!getPromptEntries;
  // Buttons are 20px boxes (p-1 + 12px icon) at gap-0.5 (2px), plus the 6px
  // expanded padding-left: 22n + 4. Passed to CSS as the slide-in transition
  // target so the 150ms is all visible motion regardless of how many buttons
  // this pane renders — a fixed worst-case max-width would spend half the
  // collapse as dead time on two-button shell panes.
  const headerButtonCount = 2 + (showPromptHistoryButton ? 1 : 0) + (onRestart ? 1 : 0);
  const headerControlsMaxPx = 22 * headerButtonCount + 4; // 48 / 70 / 92
  const headerButtonsSlide = useAppStore((s) => s.headerButtonsSlide);

  // WSL/WIN badge — shell panes on a Windows host only (SSH shells run remote
  // bash, macOS/Linux run zsh; neither has a PowerShell mode to toggle).
  // The selector mirrors shellPsModeFor (per-project override, else the
  // pane's backend) and returns a primitive, so the .find is re-render-safe.
  const showShellModeBadge =
    terminalType === "shell" && !serverId && !!workingDir && getPlatform() === "windows";
  const shellPsMode = useAppStore((s): "wsl" | "windows" | undefined => {
    if (!showShellModeBadge) return undefined;
    const norm = workingDir!.replace(/\\/g, "/");
    const override = s.recentProjects.find(
      (p) => p.path.replace(/\\/g, "/") === norm && p.serverId === serverId,
    )?.shellInWindows;
    if (override !== undefined) return override ? "windows" : "wsl";
    return (backend ?? s.terminalBackend ?? "wsl") === "windows" ? "windows" : "wsl";
  });
  const setProjectShellInWindows = useAppStore((s) => s.setProjectShellInWindows);
  const toggleShellPsMode = useCallback(() => {
    if (!workingDir || !shellPsMode) return;
    // Persist FIRST, then respawn — the fresh PTY reads the override at spawn
    // time (shellPsModeFor), so order matters.
    setProjectShellInWindows(workingDir, serverId, shellPsMode === "wsl");
    onRestart?.();
  }, [workingDir, serverId, shellPsMode, setProjectShellInWindows, onRestart]);
  // Dev-server quick-open icon (Settings > Preview Panes). The header has no
  // tab id, so the server is matched the same way spawnDevServer dedupes:
  // normalized workingDir + serverId — which also catches servers added by
  // hand in the panel (their tabId is ""). Selector returns the found object
  // (stable identity) — same re-render-safe pattern as shellPsMode above.
  const headerDevServer = useAppStore((s) => {
    if (!s.devServerButtonInHeader || !workingDir) return undefined;
    return getQuickOpenServer(s, { workingDir, serverId }, { requireRunning: true });
  });
  const [showTypePicker, setShowTypePicker] = useState(false);
  const typePickerAnchorRef = useRef<HTMLDivElement>(null);
  // CLI type picker — overlay-rendered (kind "anchored-menu").
  useOverlayMenu({
    id: `terminal-header-type-picker-${terminalId}`,
    open: showTypePicker,
    anchorRef: typePickerAnchorRef,
    payload: showTypePicker
      ? {
          placement: "below-start",
          width: 180,
          sections: [
            {
              items: TOOL_ORDER.map((type) => ({
                actionId: `type:${type}`,
                label: TERMINAL_CONFIGS[type].label,
                iconId: `cli-${type}`,
                checked: type === terminalType,
              })),
            },
          ],
        }
      : null,
    onAction: (actionId) => {
      const type = actionId.replace(/^type:/, "") as TerminalType;
      if (type !== terminalType) onChangeType(type);
    },
    onClose: () => setShowTypePicker(false),
  });
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [showPromptHistory, setShowPromptHistory] = useState(false);
  const [promptEntries, setPromptEntries] = useState<PromptEntry[]>([]);
  const promptHistoryBtnRef = useRef<HTMLButtonElement>(null);
  // Prompt-history dropdown — overlay-rendered, right-aligned to its button.
  useOverlayMenu({
    id: `terminal-header-prompt-history-${terminalId}`,
    open: showPromptHistory && !!onScrollToPromptLine,
    anchorRef: promptHistoryBtnRef,
    payload:
      showPromptHistory && onScrollToPromptLine
        ? {
            placement: "below-end",
            width: 320,
            maxHeight: 340,
            gap: 2,
            sections: [
              {
                title: "Prompt History",
                items:
                  promptEntries.length === 0
                    ? [
                        {
                          actionId: "__none__",
                          label: "No prompts yet",
                          disabled: true,
                        },
                      ]
                    : promptEntries
                        .slice()
                        .reverse()
                        .map((entry, i) => ({
                          actionId: `line:${entry.line}`,
                          label: `#${promptEntries.length - i}  ${entry.text}`,
                          shortcut: entry.timestamp
                            ? formatTimestamp(entry.timestamp)
                            : undefined,
                          // A 320px row ellipsizes everything past ~40 chars,
                          // which is most prompts — the tooltip is the only
                          // place the whole thing can be read. Capped so a
                          // pasted wall of text can't grow a chip taller than
                          // the window; the row shows where it starts, the chip
                          // shows enough to tell two similar prompts apart.
                          tooltip: truncateForTip(entry.text),
                          tooltipHint: "Click to scroll to this prompt",
                        })),
              },
            ],
          }
        : null,
    onAction: (actionId) => {
      if (actionId.startsWith("line:")) {
        onScrollToPromptLine?.(Number(actionId.slice(5)));
      }
    },
    onClose: () => setShowPromptHistory(false),
  });
  const [inlineRenaming, setInlineRenaming] = useState(false);
  const [inlineRenameValue, setInlineRenameValue] = useState("");
  const inlineInputRef = useRef<HTMLInputElement>(null);
  const sessionNameRef = useRef<HTMLDivElement>(null);
  const isResumable = supportsSessionResume(terminalType);

  // Live-Jira header segment: derive this pane's ticket from the layouts
  // (pane id prefix carries the instance key) instead of threading a prop
  // through both renderers. Primitive result — the memo recompute per tabs
  // change is a cheap walk over few leaves.
  const allTabs = useAppStore((s) => s.tabs);
  // Two DIFFERENT questions, answered separately on purpose:
  //   `jiraOwner`  — is this pane inside a Jira project at all?
  //   `.ticket`    — which ticket is it, parsed out of the pane id?
  // The live-Jira segment needs the key (it looks up a snapshot); the session
  // picker only needs "am I in a Jira project". Keeping the tab even when the
  // pane-id parse fails means the picker's gate never depends on that parse,
  // so it cannot flash for a frame while a hibernated tab's layout settles.
  const jiraOwner = useMemo(() => {
    for (const t of allTabs) {
      if (!t.isJiraProject || !t.layout) continue;
      for (const leaf of findAllTerminalLeaves(t.layout)) {
        if (leaf.terminalId === terminalId) {
          const inst = jiraInstKeyOfTermPaneId(leaf.id);
          return { tab: t, ticket: inst ? jiraBaseTicket(inst) : undefined };
        }
      }
    }
    return undefined;
  }, [allTabs, terminalId]);
  const jiraTicket = jiraOwner?.ticket;
  const jiraSnapshot = useAppStore((s) =>
    jiraOwner?.ticket
      ? (s.jiraTicketSnapshots ?? {})[jiraQK(siteForTabIn(s, jiraOwner.tab), jiraOwner.ticket)]
      : undefined,
  );
  const jiraHeaderShow = useAppStore((s) => s.jiraHeaderShow);
  // Status colour for the header chip. Built from the same union the rail uses
  // (every status the app currently knows about) so one status is one colour
  // everywhere — a chip that disagreed with its own rail row would be worse
  // than no colour at all.
  const jiraStatusColorMode = useAppStore((s) => s.jiraStatusColorMode ?? "auto");
  const jiraStatusColorOverrides = useAppStore((s) => s.jiraStatusColors);
  const jiraAssignedTickets = useAppStore((s) => s.jiraAssignedTickets);
  const jiraUnassignedTickets = useAppStore((s) => s.jiraUnassignedTickets);
  const jiraSnapshots = useAppStore((s) => s.jiraTicketSnapshots);
  // Extra fields picked for the HEADER, narrowed to ones this site has — a
  // field picked while another site was active would render a dead column.
  const jiraExtraFields = useAppStore((s) => s.jiraExtraFields);
  const jiraSiteFields = useAppStore((s) => s.jiraSiteFields);
  // Selector, not getState(): a site switch has to re-render this header, and
  // a getState() read inside render would silently keep the old catalogue.
  const headerSite = useAppStore((s) => (jiraOwner ? siteForTabIn(s, jiraOwner.tab) : ""));
  const headerSiteFields = headerSite ? (jiraSiteFields ?? {})[headerSite] : undefined;
  const headerExtraFields = useMemo(() => {
    const picked = jiraExtraFields?.header ?? [];
    if (picked.length === 0) return [];
    const known = new Set((headerSiteFields ?? []).map((f) => f.id));
    return known.size === 0 ? picked : picked.filter((id) => known.has(id));
  }, [jiraExtraFields?.header, headerSiteFields]);
  const jiraFieldLabel = useMemo(
    () => (id: string) => fieldLabel(headerSiteFields, id),
    [headerSiteFields],
  );
  const jiraStatusColor = useMemo(() => {
    const name = jiraSnapshot?.statusName;
    if (!name) return undefined;
    const names: string[] = [];
    for (const t of jiraAssignedTickets ?? []) if (t.status) names.push(t.status);
    for (const t of jiraUnassignedTickets ?? []) if (t.status) names.push(t.status);
    for (const snap of Object.values(jiraSnapshots ?? {})) {
      if (snap?.statusName) names.push(snap.statusName);
    }
    return resolveStatusColor(
      name,
      buildStatusColorMap(names),
      jiraStatusColorMode,
      jiraStatusColorOverrides,
    );
  }, [
    jiraSnapshot?.statusName,
    jiraAssignedTickets,
    jiraUnassignedTickets,
    jiraSnapshots,
    jiraStatusColorMode,
    jiraStatusColorOverrides,
  ]);

  // Read sessions for this project + type from the store
  const normalizedDir = workingDir?.replace(/\\/g, "/") ?? "";

  // Project-color wash for the header surface ("Project color header tint") —
  // independent of the pane canvas tint. Same color source as the pane tint:
  // projectColors keyed by the slash-normalized working dir. Without a tint
  // the CSS vars below are kept verbatim, so the toggle off = today's header.
  const projectHeaderTint = useAppStore((s) => s.projectHeaderTint);
  const projectHeaderTintStrength = useAppStore((s) => s.projectHeaderTintStrength);
  const themeId = useAppStore((s) => s.themeId);
  const headerColorId = useAppStore((s) => s.projectColors[normalizedDir] ?? null);
  const headerTintColor = projectHeaderTint ? getProjectColor(headerColorId) : null;
  const headerBg = headerTintColor
    ? projectTintBg(
        isActive ? getTheme(themeId).surface.surfaceRaised : getTheme(themeId).surface.surface,
        headerTintColor,
        projectHeaderTintStrength / 100,
      )
    : isActive
      ? "var(--ezy-surface-raised)"
      : "var(--ezy-surface)";
  const allSessions = useAppStore((s) => s.projectSessions[normalizedDir]);
  const sessions = useMemo(
    () => (allSessions ?? []).filter((sess) => sess.type === terminalType),
    [allSessions, terminalType]
  );
  const renameSession = useAppStore((s) => s.renameProjectSession);
  const removeSession = useAppStore((s) => s.removeProjectSession);

  // Current session's custom name from registry
  const currentSession = sessions.find((s) => s.id === sessionResumeId);
  // For untrusted sessions (detected from disk — may be stale), only show the name
  // if the user explicitly renamed it. Auto-detected names come from old session files.
  // For trusted sessions (restored from persist or explicit switch), show everything.
  // `contextInfo.sessionName` is the CLI's own title, read straight off the
  // transcript — it reaches this component UNCAPPED (the registry copy is
  // capped on the way in, see useSessionContext). Cap it here too, or a pane
  // that has not registered its session yet still renders a full raw prompt.
  const contextName = contextInfo?.sessionName || contextInfo?.summary;
  const cappedContextName = contextName ? truncateSessionTitle(contextName) : null;
  const sessionDisplayName = sessionTrusted
    ? (currentSession?.name || cappedContextName || (sessionResumeId ? sessionResumeId.slice(0, 8) : null))
    : ((currentSession?.isRenamed ? currentSession.name : null) || cappedContextName || (sessionResumeId ? sessionResumeId.slice(0, 8) : null));

  useEffect(() => {
    if (inlineRenaming && inlineInputRef.current) {
      inlineInputRef.current.focus();
      inlineInputRef.current.select();
    }
  }, [inlineRenaming]);

  const submitInlineRename = () => {
    if (sessionResumeId && inlineRenameValue.trim() && workingDir) {
      renameSession(workingDir, sessionResumeId, inlineRenameValue.trim());
    }
    setInlineRenaming(false);
  };
  return (
    <div
      className="flex items-center select-none ezy-pane-header"
      style={{
        height: 28,
        backgroundColor: headerBg,
        borderBottom: `1px solid ${isActive ? CLI_BRAND_COLORS[terminalType] : "var(--ezy-border)"}`,
        padding: "0 6px 0 0",
        transition: "border-color 200ms ease, background-color 200ms ease",
      }}
    >
      {/* Fold this pane down to just this header (Jira stacked sub-tickets).
          A bare SVG, not a <button>: buttons inherit line-height 1.5 and would
          push this 28px header to 24px+ of content. Collapsing gives the pane's
          terminal surface a zero-height anchor, which the native renderer
          already treats as "hidden" WITHOUT resizing the PTY — so folding a
          pane never reflows the conversation inside it. */}
      {collapsible && (
        <svg
          onClick={(e) => {
            e.stopPropagation();
            onToggleCollapse?.();
          }}
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            flexShrink: 0,
            margin: "0 2px 0 5px",
            cursor: "pointer",
            color: "var(--ezy-text-muted)",
            transform: collapsed ? "rotate(-90deg)" : undefined,
            transition: "transform 150ms ease",
          }}
        >
          <title>{collapsed ? "Expand pane" : "Collapse pane"}</title>
          <path d="M4 6l4 4 4-4" />
        </svg>
      )}
      {/* Drag handle — custom pointer drag (HTML5 DnD doesn't work in Tauri
          WebView2). Hidden entirely when the host disabled pane moving
          (onSwapPane undefined — Jira tabs: one pane per ticket). */}
      {!onSwapPane && !collapsible && <div style={{ width: 6, flexShrink: 0 }} />}
      {onSwapPane && <div
        onMouseDown={(e) => {
          e.preventDefault();
          document.documentElement.classList.add("ezy-dragging-pane");

          // Clear any prior highlights
          document.querySelectorAll("[data-terminal-id]").forEach((el) => {
            (el as HTMLElement).style.outline = "";
          });

          const handleMouseMove = (ev: MouseEvent) => {
            const el = document.elementFromPoint(ev.clientX, ev.clientY);
            const pane = el?.closest("[data-terminal-id]") as HTMLElement | null;
            const hoveredId = pane?.getAttribute("data-terminal-id");

            document.querySelectorAll("[data-terminal-id]").forEach((p) => {
              const pid = p.getAttribute("data-terminal-id");
              (p as HTMLElement).style.outline =
                pid === hoveredId && hoveredId !== terminalId
                  ? "2px solid var(--ezy-accent)"
                  : "";
            });
          };

          const handleMouseUp = (ev: MouseEvent) => {
            document.documentElement.classList.remove("ezy-dragging-pane");
            document.removeEventListener("mousemove", handleMouseMove, true);
            document.removeEventListener("mouseup", handleMouseUp, true);

            // Remove all highlights
            document.querySelectorAll("[data-terminal-id]").forEach((el) => {
              (el as HTMLElement).style.outline = "";
            });

            const el = document.elementFromPoint(ev.clientX, ev.clientY);
            const pane = el?.closest("[data-terminal-id]") as HTMLElement | null;
            const targetId = pane?.getAttribute("data-terminal-id");

            if (targetId && targetId !== terminalId && onSwapPane) {
              onSwapPane(terminalId, targetId);
            }
          };

          // Use capture phase so xterm.js stopPropagation() can't block us
          document.addEventListener("mousemove", handleMouseMove, true);
          document.addEventListener("mouseup", handleMouseUp, true);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 16,
          height: "100%",
          cursor: "grab",
          flexShrink: 0,
          opacity: 0.4,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.8"; }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.4"; }}
        data-tooltip="Drag to rearrange"
      >
        <FaGripVertical size={12} color="var(--ezy-text-muted)" />
      </div>}
      {/* Left: type badge — clickable to switch CLI */}
      <div style={{ position: "relative", marginLeft: 3, flexShrink: 0 }}>
        <div
          ref={typePickerAnchorRef}
          className="flex items-center gap-1.5"
          style={{ cursor: "pointer", borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)", padding: "2px 4px", margin: "-2px -4px" }}
          onClick={() => setShowTypePicker((v) => !v)}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-border)"}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
        >
          <TerminalIcon type={terminalType} />
          <span
            className="ezy-pane-header-text text-[11px] font-medium tracking-wide"
            style={{
              color: isActive ? "var(--ezy-text)" : "var(--ezy-text-muted)",
              letterSpacing: "0.04em",
            }}
          >
            {config.label}
            {serverName && (
              <span style={{ color: "var(--ezy-cyan)", marginLeft: 2 }}>
                @ {serverName}
              </span>
            )}
          </span>
          {isYolo && (
            <span
              className="ezy-pane-header-text"
              style={{
                fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
                fontWeight: 700,
                letterSpacing: "0.06em",
                padding: "0 4px",
                borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
                backgroundColor: "var(--ezy-red, #e55)",
                color: "#fff",
              }}
            >
              YOLO
            </span>
          )}
          {sl("collabMode") && contextInfo?.collabMode && contextInfo.collabMode !== "default" && (
            <span
              className="ezy-pane-header-text"
              style={{
                fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
                fontWeight: 700,
                letterSpacing: "0.06em",
                padding: "0 4px",
                borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
                backgroundColor: "var(--ezy-cyan, #5eead4)",
                color: "#000",
                textTransform: "uppercase",
              }}
            >
              {contextInfo.collabMode}
            </span>
          )}
          {isNativeRenderer && (
            <span
              className="ezy-pane-header-text"
              data-tooltip="Drawn by the native GPU renderer"
              style={{
                fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
                fontWeight: 700,
                letterSpacing: "0.06em",
                padding: "0 4px",
                borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
                // Neutral on purpose: red means YOLO and cyan means collab mode
                // in this same chip row. The renderer is a fact, not a warning.
                backgroundColor: "var(--ezy-border-light, #484f58)",
                color: "var(--ezy-text, #e6edf3)",
              }}
            >
              NATIVE
            </span>
          )}
          <FaChevronDown size={8} color="var(--ezy-text-muted)" />
        </div>
        {/* Type picker — overlay-rendered (useOverlayMenu above). */}
      </div>

      {/* WSL/WIN mode badge — shell panes only. Shows where the shell lands
          (accent = WSL bash preload, neutral = plain PowerShell); click
          persists the per-project override and relaunches the shell in the
          other mode. Sibling of the type picker, not inside it, so a click
          can't also open the CLI picker. */}
      {showShellModeBadge && shellPsMode && (
        <span
          role="button"
          className="ezy-pane-header-text"
          data-tooltip={
            shellPsMode === "wsl"
              ? "Shell drops into WSL bash at the project. Click to relaunch in plain Windows PowerShell."
              : "Plain Windows PowerShell at the project. Click to relaunch into WSL bash."
          }
          onClick={toggleShellPsMode}
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
            fontWeight: 700,
            letterSpacing: "0.06em",
            padding: "0 4px",
            borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
            marginLeft: 6,
            flexShrink: 0,
            cursor: "pointer",
            userSelect: "none",
            backgroundColor:
              shellPsMode === "wsl" ? "var(--ezy-accent)" : "var(--ezy-border-light, #484f58)",
            color: shellPsMode === "wsl" ? "#fff" : "var(--ezy-text, #e6edf3)",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.filter = "brightness(1.15)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.filter = ""; }}
        >
          {shellPsMode === "wsl" ? "WSL" : "WIN"}
        </span>
      )}

      {/* File path — max 3 segments from end */}
      {sl("filePath") && workingDir && (
        <span
          className="ezy-pane-header-text"
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
            color: "var(--ezy-text-muted)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            minWidth: 0,
            marginLeft: 0,
            cursor: "pointer",
            borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
            padding: "1px 4px",
          }}
          data-tooltip={workingDir}
          // Instruction goes on its own row, never reflowed into the middle of
          // a wrapped path.
          data-tooltip-hint={
            serverId
              ? "On the remote host"
              : "Double-click to open in file manager"
          }
          onDoubleClick={() => {
            // Remote panes: workingDir is a path on the SSH host, so opening it
            // in the LOCAL file manager would either fail or open an unrelated
            // local directory. Do nothing (the title says so).
            if (serverId) return;
            void invoke("open_folder", { path: workingDir }).catch((e) => {
              console.error("[TerminalHeader] open_folder failed:", e);
            });
          }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--ezy-border)")}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
        >
          · {truncatePath(workingDir)}
        </span>
      )}

      {/* Dev-server quick-open — shown only while this project's server is
          running (Settings > Preview Panes > "Dev server button in pane
          headers"). Green = the app-wide running color (StatusDot). Same
          click contract as terminal links: plain = external browser,
          Ctrl/Cmd = MADE browser pane. */}
      {headerDevServer && (
        <span
          role="button"
          aria-label="Open dev server in browser"
          data-tooltip={`Open localhost:${headerDevServer.port} in browser`}
          data-tooltip-hint="Ctrl+Click opens the MADE browser pane"
          onClick={(e) => {
            e.stopPropagation();
            openDevServerUrl(headerDevServer, { inApp: wantsInAppOpen(e) });
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 3,
            marginLeft: 2,
            borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
            flexShrink: 0,
            cursor: "pointer",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--ezy-border)")}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
        >
          <svg width={12} height={12} viewBox="0 0 12 12" fill="none">
            <circle cx="6" cy="6" r="4.5" stroke="#4ade80" strokeWidth="1.2" />
            <ellipse cx="6" cy="6" rx="2" ry="4.5" stroke="#4ade80" strokeWidth="1" />
            <path d="M1.5 6h9" stroke="#4ade80" strokeWidth="1" />
          </svg>
        </span>
      )}

      {/* Live-Jira segment (ticket panes only, per-element toggles in
          Settings > Jira). Populated from jiraTicketSnapshots, so it appears
          after the first poll and tracks changes at poll cadence. */}
      {jiraTicket && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginLeft: 6,
            minWidth: 0,
            flexShrink: 1,
            overflow: "hidden",
          }}
        >
          {/* Status chip in the ticket's own status colour — the same hue the
              rail paints on this ticket's row stripe and badge, so a pane and
              its rail row read as one object. Sized to content here (a header
              has the room), unlike the rail's fixed-width aligned column. */}
          {jiraHeaderShow?.status !== false && jiraSnapshot?.statusName && (
            <span
              className="ezy-pane-header-text"
              data-tooltip={`Jira status: ${jiraSnapshot.statusName}`}
              style={{
                fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
                fontWeight: 600,
                padding: "0 5px",
                borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
                background: jiraStatusColor ?? "var(--ezy-border)",
                color: jiraStatusColor ? badgeInkFor(jiraStatusColor) : "var(--ezy-text)",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              {jiraSnapshot.statusName}
            </span>
          )}
          {jiraHeaderShow?.summary !== false && jiraSnapshot?.summary && (
            <span
              className="ezy-pane-header-text"
              data-tooltip={jiraSnapshot.summary}
              style={{
                fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
                color: "var(--ezy-text-muted)",
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {jiraSnapshot.summary}
            </span>
          )}
          {/* Organization — the customer company that raised the ticket. Sits
              right after the summary because in a support workflow "who is
              this for" is read together with "what is it". Absent on sites
              with no JSM Organizations field, which is why it renders off the
              value rather than off the toggle alone. */}
          {jiraHeaderShow?.organization !== false && jiraSnapshot?.organization && (
            <span
              className="ezy-pane-header-text"
              data-tooltip={`Organization: ${jiraSnapshot.organization}`}
              style={{
                fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
                color: "var(--ezy-text-secondary)",
                minWidth: 0,
                maxWidth: 160,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flexShrink: 1,
              }}
            >
              {jiraSnapshot.organization}
            </span>
          )}
          {jiraHeaderShow?.requestType !== false && jiraSnapshot?.requestType && (
            <span
              className="ezy-pane-header-text"
              data-tooltip={`Request type: ${jiraSnapshot.requestType}`}
              style={{
                fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
                color: "var(--ezy-text-muted)",
                minWidth: 0,
                maxWidth: 140,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flexShrink: 1,
              }}
            >
              · {jiraSnapshot.requestType}
            </span>
          )}
          {jiraHeaderShow?.assignee === true && jiraSnapshot?.assigneeName && (
            <span
              className="ezy-pane-header-text"
              data-tooltip="Assignee"
              style={{
                fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
                color: "var(--ezy-text-muted)",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              · {jiraSnapshot.assigneeName}
            </span>
          )}
          {jiraHeaderShow?.priority === true && jiraSnapshot?.priorityName && (
            <span
              className="ezy-pane-header-text"
              data-tooltip="Priority"
              style={{
                fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
                color: "var(--ezy-text-muted)",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              · {jiraSnapshot.priorityName}
            </span>
          )}
          {jiraHeaderShow?.reporter === true && jiraSnapshot?.reporterName && (
            <span
              className="ezy-pane-header-text"
              data-tooltip="Reporter"
              style={{
                fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
                color: "var(--ezy-text-muted)",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              · {jiraSnapshot.reporterName}
            </span>
          )}
          {jiraHeaderShow?.updated === true && jiraSnapshot?.updatedIso && (
            <span
              className="ezy-pane-header-text"
              data-tooltip="Last updated in Jira"
              style={{
                fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
                color: "var(--ezy-text-muted)",
                fontVariantNumeric: "tabular-nums",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              · {relativeShortIso(jiraSnapshot.updatedIso)}
            </span>
          )}
          {/* Any other Jira field the user added in Settings > Jira. Rendered
              off the VALUE, so a field a ticket doesn't fill costs no chrome. */}
          {headerExtraFields.map((id) => {
            const value = jiraSnapshot?.extra?.[id];
            if (!value) return null;
            return (
              <span
                key={id}
                className="ezy-pane-header-text"
                data-tooltip={`${jiraFieldLabel(id)}: ${value}`}
                style={{
                  fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
                  color: "var(--ezy-text-muted)",
                  minWidth: 0,
                  maxWidth: 140,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flexShrink: 1,
                }}
              >
                · {value}
              </span>
            );
          })}
          {/* No "My assigned tickets" button here. It only ever flipped the
              rail to a tab the rail already offers, and the assigned list now
              lives entirely in the rail. */}
        </div>
      )}

      {/* Model name + context usage indicator — CLI panes only (collapses when pane is narrow) */}
      {contextPercent != null && contextInfo && (
        <div
          className="ml-auto flex items-center gap-2"
          style={{ minWidth: 0, overflow: "hidden" }}
        >
          {sl("model") && contextInfo.model && (
            <span
              className="ezy-pane-header-text"
              style={{
                fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
                color: "var(--ezy-text-muted)",
                whiteSpace: "nowrap",
              }}
            >
              {terminalType === "gemini"
                ? formatGeminiModel(contextInfo.model ?? "")
                : (contextInfo.model?.replace(/^gpt-/i, "GPT ").replace(/\s*\([\d.]+[KMB]?\s*context\)/i, "") ?? "")}{contextInfo.window ? <span data-tooltip={`Total context window: ${contextInfo.window.toLocaleString()} tokens`}>{` - ${formatContextWindow(contextInfo.window)}`}</span> : ""}{sl("effort") && contextInfo.effort ? ` - ${contextInfo.effort}` : ""}
            </span>
          )}
          {/* Claude: version */}
          {sl("version") && contextInfo.cliVersion && (
            <span
              className="ezy-pane-header-text"
              style={{
                fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
                color: "var(--ezy-text-muted)",
                whiteSpace: "nowrap",
              }}
            >
              v{contextInfo.cliVersion}
            </span>
          )}
          {/* Claude: speed mode */}
          {sl("speed") && contextInfo.speed && (
            <span
              className="ezy-pane-header-text"
              style={{
                fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
                color: "var(--ezy-text-muted)",
                whiteSpace: "nowrap",
              }}
            >
              {contextInfo.speed}
            </span>
          )}
          {/* Claude: per-pane session cost + cost/hr (project total in tooltip) */}
          {sl("cost") && contextInfo.costUsd != null && (
            <span
              data-tooltip={(() => {
                const parts: string[] = [`$${contextInfo.costUsd.toFixed(2)} this session`];
                if (contextInfo.durationMs != null && contextInfo.durationMs > 0) {
                  parts.push(`$${(contextInfo.costUsd / (contextInfo.durationMs / 3_600_000)).toFixed(2)}/hr`);
                  parts.push(`${Math.round(contextInfo.durationMs / 60_000)}m session`);
                }
                if (contextInfo.projectCostUsd != null) {
                  parts.push(`$${contextInfo.projectCostUsd.toFixed(2)} project total`);
                }
                return parts.join(" · ");
              })()}
              className="ezy-pane-header-text"
              style={{
                fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
                fontVariantNumeric: "tabular-nums",
                whiteSpace: "nowrap",
                color: "var(--ezy-text-muted)",
              }}
            >
              ${contextInfo.costUsd.toFixed(2)}{contextInfo.durationMs != null && contextInfo.durationMs > 0
                ? ` · $${(contextInfo.costUsd / (contextInfo.durationMs / 3_600_000)).toFixed(2)}/hr`
                : ""}
            </span>
          )}
          {/* Claude: compact count */}
          {sl("compactCount") && contextInfo.compactCount != null && contextInfo.compactCount > 0 && (
            <span
              data-tooltip={`Context compacted ${contextInfo.compactCount} time${contextInfo.compactCount !== 1 ? "s" : ""}`}
              className="ezy-pane-header-text"
              style={{
                fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
                fontVariantNumeric: "tabular-nums",
                whiteSpace: "nowrap",
                color: "var(--ezy-text-muted)",
              }}
            >
              C:{contextInfo.compactCount}
            </span>
          )}
          {/* Session picker — always visible for resumable CLIs, shows name when
              available. SESSION_NAME_MAX_PX caps the name on a WIDE pane, where
              flex leftover is generous enough that a long title would run the
              whole header. On a narrow pane flexShrink still does the work and
              the name gives up space before this cap is reached.

              NOT on Jira ticket panes (`!jiraOwner`). Such a pane's identity IS
              its ticket: the rail names it, the rail's menu renames it, and
              swapping the session underneath would leave the pane pointing at a
              conversation that has nothing to do with the ticket beside it —
              breaking the pair invariant Workspace maintains. */}
          {sl("sessionPicker") && isResumable && !jiraOwner && (
            <div ref={sessionNameRef} style={{ minWidth: 0, flexShrink: 1, maxWidth: SESSION_NAME_MAX_PX }}>
              {inlineRenaming ? (
                <input
                  ref={inlineInputRef}
                  value={inlineRenameValue}
                  onChange={(e) => setInlineRenameValue(e.target.value)}
                  onBlur={submitInlineRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitInlineRename();
                    if (e.key === "Escape") setInlineRenaming(false);
                    e.stopPropagation();
                  }}
                  style={{
                    fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
                    lineHeight: 1.2,
                    fontFamily: "inherit",
                    backgroundColor: "var(--ezy-bg)",
                    border: "1px solid var(--ezy-accent)",
                    borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
                    color: "var(--ezy-text)",
                    outline: "none",
                    padding: "1px 4px",
                    width: 120,
                  }}
                />
              ) : (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 3,
                    cursor: "pointer",
                    borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
                    padding: "1px 4px",
                    margin: "-1px -4px",
                  }}
                  onClick={() => setShowSessionPicker((v) => !v)}
                  onDoubleClick={() => {
                    if (sessionResumeId) {
                      // Capped: the input is 120px wide, and seeding it with a
                      // raw first message would make the user delete a
                      // paragraph before they can type a name.
                      setInlineRenameValue(currentSession?.name || cappedContextName || "");
                      setInlineRenaming(true);
                    }
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-border)"}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                  // Tooltip carries the FULL name — the row shows the capped
                  // one, so hovering has to be how you read the rest.
                  data-tooltip={currentSession?.name || contextName || "Session"}
                  data-tooltip-hint={sessionDisplayName ? "Click to switch sessions · double-click to rename" : "Click to switch sessions"}
                >
                  <span
                    className="ezy-pane-header-text"
                    style={{
                      fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
                      color: "var(--ezy-text-muted)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      minWidth: 0,
                    }}
                  >
                    {sessionDisplayName || "New"}
                  </span>
                  {/* Green dot = sessionId detected (session will persist on restart) */}
                  {sessionResumeId && (
                    <span
                      data-tooltip="Session saved — will resume on restart"
                      style={{
                        width: 5,
                        height: 5,
                        borderRadius: "50%",
                        backgroundColor: "var(--ezy-accent)",
                        flexShrink: 0,
                        opacity: 0.7,
                      }}
                    />
                  )}
                  <FaChevronDown size={6} color="var(--ezy-text-muted)" style={{ flexShrink: 0 }} />
                </div>
              )}
            </div>
          )}
          {/* Fallback: show session name for non-resumable or when no sessions yet.
              Tooltip carries the FULL text — the cap is display only. */}
          {sl("sessionPicker") && !isResumable && !jiraOwner && contextInfo.sessionName && (
            <span
              className="ezy-pane-header-text"
              data-tooltip={contextInfo.sessionName}
              style={{
                fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
                color: "var(--ezy-text-muted)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                minWidth: 0,
                maxWidth: SESSION_NAME_MAX_PX,
                flexShrink: 1,
              }}
            >
              {truncateSessionTitle(contextInfo.sessionName)}
            </span>
          )}
          {/* Gemini: summary — hidden for resumable CLIs where it's already the session name */}
          {sl("summary") && contextInfo.summary && !isResumable && (
            <span
              className="ezy-pane-header-text"
              data-tooltip={contextInfo.summary}
              style={{
                fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
                color: "var(--ezy-text-muted)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                minWidth: 0,
                maxWidth: SESSION_NAME_MAX_PX,
                flexShrink: 1,
              }}
            >
              {truncateSessionTitle(contextInfo.summary)}
            </span>
          )}
          {/* Gemini: thinking tokens */}
          {sl("thinkingTokens") && contextInfo.thinkingTokens != null && (
            <span
              data-tooltip={`Last response used ${contextInfo.thinkingTokens.toLocaleString()} thinking tokens`}
              className="ezy-pane-header-text"
              style={{
                fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
                fontVariantNumeric: "tabular-nums",
                whiteSpace: "nowrap",
                color: "var(--ezy-text-muted)",
              }}
            >
              T:{contextInfo.thinkingTokens.toLocaleString()}
            </span>
          )}
          {/* Gemini: quota reset time */}
          {sl("quotaReset") && contextInfo.quotaResetTime && (() => {
            const reset = new Date(contextInfo.quotaResetTime);
            const now = new Date();
            const diffMs = reset.getTime() - now.getTime();
            if (diffMs <= 0) return null;
            const diffH = Math.floor(diffMs / 3_600_000);
            const diffM = Math.floor((diffMs % 3_600_000) / 60_000);
            const label = diffH > 0 ? `${diffH}h${diffM}m` : `${diffM}m`;
            return (
              <span
                data-tooltip={`Quota resets at ${reset.toLocaleTimeString()}`}
                className="ezy-pane-header-text"
                style={{
                  fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
                  fontVariantNumeric: "tabular-nums",
                  whiteSpace: "nowrap",
                  color: "var(--ezy-text-muted)",
                }}
              >
                RST:{label}
              </span>
            );
          })()}
          {/* Rate limits — left of context bar (show remaining, not used) */}
          {sl("rateLimit") && contextInfo.rateLimitFiveHour != null && (() => {
            const left = Math.round((100 - contextInfo.rateLimitFiveHour) * 100) / 100;
            const isGemini = terminalType === "gemini";
            const label = isGemini ? "RPD" : "5h";
            const tooltip = isGemini
              ? `Daily rate limit: ${left}% left (${contextInfo.rateLimitFiveHour}% used)`
              : `5h rate limit: ${left}% left (${contextInfo.rateLimitFiveHour}% used)`;
            return (
              <span
                data-tooltip={tooltip}
                className="ezy-pane-header-text"
                style={{
                  fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
                  fontVariantNumeric: "tabular-nums",
                  whiteSpace: "nowrap",
                  color: left <= 20 ? "var(--ezy-red)" : "var(--ezy-text-muted)",
                }}
              >
                {label}:{left}%
              </span>
            );
          })()}
          {sl("rateLimit") && contextInfo.rateLimitWeekly != null && terminalType !== "gemini" && (() => {
            const left = Math.round((100 - contextInfo.rateLimitWeekly) * 100) / 100;
            return (
              <span
                data-tooltip={`Weekly rate limit: ${left}% left (${contextInfo.rateLimitWeekly}% used)`}
                className="ezy-pane-header-text"
                style={{
                  fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
                  fontVariantNumeric: "tabular-nums",
                  whiteSpace: "nowrap",
                  color: left <= 20 ? "var(--ezy-red)" : "var(--ezy-text-muted)",
                }}
              >
                W:{left}%
              </span>
            );
          })()}
          {/* Context bar + percentage — click to manually refresh */}
          {sl("contextBar") && <div
            className="flex items-center gap-2"
            data-tooltip={`${contextInfo.remaining.toLocaleString()} / ${contextInfo.window.toLocaleString()} = ${contextPercent.toFixed(2)}%`}
            data-tooltip-hint={onRefreshContext ? "Click to refresh" : undefined}
            onClick={onRefreshContext ? handleContextRefreshClick : undefined}
            style={{
              flexShrink: 0,
              cursor: onRefreshContext ? "pointer" : "default",
              padding: "2px 4px",
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
              opacity: refreshingContext ? 0.6 : 1,
              transition: "background-color 100ms ease, opacity 120ms ease",
            }}
            onMouseEnter={(e) => {
              if (onRefreshContext && !refreshingContext) {
                e.currentTarget.style.backgroundColor = "var(--ezy-border)";
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "transparent";
            }}
          >
            <div
              style={{
                width: 44,
                height: 4,
                borderRadius: "calc(var(--ezy-radius-scale, 1) * 2px)",
                backgroundColor: "var(--ezy-border)",
                overflow: "hidden",
                flexShrink: 0,
              }}
            >
              <div
                style={{
                  width: `${contextPercent}%`,
                  height: "100%",
                  borderRadius: "calc(var(--ezy-radius-scale, 1) * 2px)",
                  backgroundColor:
                    contextPercent <= 15
                      ? "var(--ezy-red)"
                      : contextPercent <= 40
                        ? "var(--ezy-text-muted)"
                        : "var(--ezy-accent)",
                  transition: "width 500ms ease, background-color 500ms ease",
                }}
              />
            </div>
            <span
              className="ezy-pane-header-text"
              style={{
                fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
                fontVariantNumeric: "tabular-nums",
                color:
                  contextPercent <= 15
                    ? "var(--ezy-red)"
                    : contextPercent <= 40
                      ? "var(--ezy-text-muted)"
                      : "var(--ezy-text-muted)",
                minWidth: 36,
                textAlign: "right",
              }}
            >
              {contextPercent.toFixed(2)}%
            </span>
          </div>}

        </div>
      )}

      {/* Right: prompt history + expand + restart + close. Collapsed to zero
          width until the header is hovered (max-width + overflow hidden in
          `.ezy-header-controls`, index.css) so the stats / path content owns
          the full row; on hover the cluster slides in from under the fixed
          right edge, pushing the content aside with an animated reflow rather
          than overlaying it. `data-pinned` holds it open while the prompt
          history dropdown is up — the menu is anchored to that button's rect,
          and collapsing out from under an open popup would read as a glitch.
          The expanded width rides in as a CSS variable so the transition
          duration is honest for 2-, 3- and 4-button panes alike. */}
      <div
        className={`ezy-header-controls flex items-center gap-0.5 ${contextPercent == null ? "ml-auto" : ""}`}
        data-pinned={showPromptHistory ? "" : undefined}
        data-static={headerButtonsSlide ? undefined : ""}
        style={{ flexShrink: 0, "--ezy-header-controls-max": `${headerControlsMaxPx}px` } as CSSProperties}
      >
        {showPromptHistoryButton && (
          <button
            ref={promptHistoryBtnRef}
            onClick={() => {
              if (showPromptHistory) {
                setShowPromptHistory(false);
              } else {
                // Native panes resolve their entries over IPC — await before
                // opening so the dropdown never renders an empty first frame.
                void Promise.resolve(getPromptEntries!()).then((entries) => {
                  setPromptEntries(entries);
                  setShowPromptHistory(true);
                });
              }
            }}
            data-tooltip="Prompt history" aria-label="Prompt history"
            // `transition`, not `transition-colors transition-opacity`: those are
            // both `transition-property` utilities, so whichever lands later in
            // the stylesheet wins and the other animation is silently dropped.
            className="p-1 rounded transition hover:bg-[var(--ezy-border)]"
            style={{ flexShrink: 0 }}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              stroke="var(--ezy-text-muted)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="8" cy="8" r="6.5" />
              <polyline points="8,4 8,8 11,10" />
            </svg>
          </button>
        )}
        <PaneExpandButton />
        {onRestart && (
          <button
            onClick={onRestart}
            data-tooltip="Restart (same session)" aria-label="Restart (same session)"
            className="p-1 rounded transition-colors hover:bg-[var(--ezy-border)]"
          >
            <BiRefresh
              size={12}
              color="var(--ezy-text-muted)"
              style={{ transform: "scale(1.3)" }}
            />
          </button>
        )}
        <button
          onClick={onClose}
          data-tooltip="Close Pane (Ctrl+Shift+W)" aria-label="Close Pane (Ctrl+Shift+W)"
          className="p-1 rounded transition-colors hover:bg-[var(--ezy-border)]"
        >
          <FaXmark
            size={12}
            color="var(--ezy-text-muted)"
            className="hover:!text-[var(--ezy-red)]"
          />
        </button>
      </div>

      {/* Session picker — rendered outside overflow-hidden context info area */}
      {/* `!jiraOwner` again, defensively: without a trigger this cannot open,
          but a stale `showSessionPicker` left over from before a pane became a
          Jira pane must not re-open it. */}
      {showSessionPicker && isResumable && !jiraOwner && (
        <SessionPicker
          sessions={sessions}
          currentSessionId={sessionResumeId}
          contextSessionName={cappedContextName ?? undefined}
          anchorRef={sessionNameRef}
          workingDir={workingDir}
          backend={backend}
          serverId={serverId}
          terminalType={terminalType}
          onSelect={(id) => onSwitchSession?.(id)}
          onRename={(id, name) => {
            if (workingDir) renameSession(workingDir, id, name);
          }}
          onRemove={(id) => {
            if (workingDir) removeSession(workingDir, id);
          }}
          onNew={() => onSwitchSession?.(undefined)}
          onClose={() => setShowSessionPicker(false)}
        />
      )}

      {/* Prompt history dropdown — overlay-rendered (useOverlayMenu above). */}
    </div>
  );
}
