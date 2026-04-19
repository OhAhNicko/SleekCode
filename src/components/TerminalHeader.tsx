import { useState, useEffect, useRef, useMemo } from "react";
import type { TerminalType, TerminalBackend, ProjectSession, SessionIndexEntry } from "../types";
import type { ContextInfo } from "../lib/context-parser";
import { TERMINAL_CONFIGS, toWslPath } from "../lib/terminal-config";
import { supportsSessionResume } from "../lib/session-resume";
import { readSessionsIndex, resolveSessionName, readSessionFirstPrompt, slugify } from "../lib/sessions-index";
import { useAppStore } from "../store";
import { FaChevronDown, FaCheck, FaPen } from "react-icons/fa";
import { FaXmark, FaGripVertical, FaPlus } from "react-icons/fa6";
import { BiRefresh } from "react-icons/bi";

const TOOL_ORDER: TerminalType[] = ["claude", "codex", "gemini", "shell"];

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
  isYolo?: boolean;
  contextInfo?: ContextInfo | null;
  workingDir?: string;
  backend?: TerminalBackend;
  sessionResumeId?: string;
  /** True when sessionResumeId came from restore/explicit switch; false when detected from disk (may be stale). */
  sessionTrusted?: boolean;
  onSwitchSession?: (sessionId: string | undefined) => void;
  getPromptEntries?: () => PromptEntry[];
  onScrollToPromptLine?: (line: number) => void;
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

/** Compact CLI picker dropdown used for split and type-switch */
function CliPicker({
  onSelect,
  onClose,
  currentType,
}: {
  onSelect: (type: TerminalType) => void;
  onClose: () => void;
  currentType?: TerminalType;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <>
      {/* Backdrop to catch clicks outside (Tauri drag region swallows mousedown) */}
      <div
        style={{ position: "fixed", inset: 0, zIndex: 199 }}
        onMouseDown={onClose}
      />
      <div
        className="dropdown-enter"
        style={{
          position: "absolute",
          top: "100%",
          left: 0,
          marginTop: 2,
          width: 180,
          backgroundColor: "var(--ezy-surface-raised)",
          border: "1px solid var(--ezy-border)",
          borderRadius: 8,
          overflow: "hidden",
          boxShadow: "0 12px 36px rgba(0,0,0,0.5)",
          zIndex: 200,
        }}
      >
      {TOOL_ORDER.map((type) => {
        const config = TERMINAL_CONFIGS[type];
        const isCurrent = type === currentType;
        return (
          <button
            key={type}
            className="w-full text-left"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 10px",
              backgroundColor: isCurrent ? "var(--ezy-accent-glow)" : "transparent",
              border: "none",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: isCurrent ? 600 : 400,
              color: isCurrent ? "var(--ezy-text)" : "var(--ezy-text-secondary)",
              fontFamily: "inherit",
            }}
            onMouseEnter={(e) => {
              if (!isCurrent) e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)";
            }}
            onMouseLeave={(e) => {
              if (!isCurrent) e.currentTarget.style.backgroundColor = "transparent";
            }}
            onClick={() => {
              onSelect(type);
              onClose();
            }}
          >
            <TerminalIcon type={type} />
            <span>{config.label}</span>
            {isCurrent && (
              <FaCheck size={10} color="var(--ezy-accent)" style={{ marginLeft: "auto" }} />
            )}
          </button>
        );
      })}
    </div>
    </>
  );
}

/** Format a relative time string, e.g. "2h ago", "3d ago" */
function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  if (diff < 0) return "";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

/** Format a timestamp (ms) as relative time */
function formatTimestamp(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function PromptHistoryDropdown({
  entries,
  anchorRef,
  onSelect,
  onClose,
}: {
  entries: PromptEntry[];
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onSelect: (line: number) => void;
  onClose: () => void;
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (anchorRef?.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      // Align right edge of dropdown with right edge of button
      setPos({ top: rect.bottom + 2, left: Math.max(8, rect.right - 320) });
    }
  }, [anchorRef]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  if (!pos) return null;

  return (
    <>
      <div
        style={{ position: "fixed", inset: 0, zIndex: 199 }}
        onMouseDown={onClose}
      />
      <div
        className="dropdown-enter"
        style={{
          position: "fixed",
          top: pos.top,
          left: pos.left,
          width: 320,
          backgroundColor: "var(--ezy-surface-raised)",
          border: "1px solid var(--ezy-border)",
          borderRadius: 8,
          overflow: "hidden",
          boxShadow: "0 12px 36px rgba(0,0,0,0.5)",
          zIndex: 200,
          maxHeight: 340,
        }}
      >
        <div
          style={{
            padding: "6px 10px",
            borderBottom: "1px solid var(--ezy-border)",
            fontSize: 11,
            fontWeight: 600,
            color: "var(--ezy-text-muted)",
          }}
        >
          Prompt History
        </div>
        <div style={{ overflowY: "auto", maxHeight: 296 }}>
          {entries.length === 0 ? (
            <div
              style={{
                padding: "24px 10px",
                textAlign: "center",
                fontSize: 12,
                color: "var(--ezy-text-muted)",
                opacity: 0.6,
              }}
            >
              No prompts yet
            </div>
          ) : (
            entries.map((entry, i) => (
              <div
                key={`${entry.line}-${i}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "5px 10px",
                  cursor: "pointer",
                  backgroundColor: "transparent",
                  borderBottom: "1px solid var(--ezy-border-subtle, rgba(255,255,255,0.04))",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "transparent";
                }}
                onClick={() => {
                  onSelect(entry.line);
                  onClose();
                }}
              >
                <span
                  style={{
                    fontSize: 10,
                    color: "var(--ezy-text-muted)",
                    opacity: 0.5,
                    minWidth: 20,
                    textAlign: "right",
                    flexShrink: 0,
                  }}
                >
                  #{i + 1}
                </span>
                <span
                  style={{
                    flex: 1,
                    fontSize: 12,
                    color: "var(--ezy-text)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {entry.text}
                </span>
                {entry.timestamp && (
                  <span
                    style={{
                      fontSize: 10,
                      color: "var(--ezy-text-muted)",
                      opacity: 0.5,
                      flexShrink: 0,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {formatTimestamp(entry.timestamp)}
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}

/** Merged session item for the picker — combines store + index data */
interface MergedSession {
  id: string;
  name: string;
  isFromStore: boolean;  // true = opened in current EzyDev session
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
  terminalType,
  onSelect,
  onRename,
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
  terminalType?: TerminalType;
  onSelect: (sessionId: string) => void;
  onRename: (sessionId: string, newName: string) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [indexEntries, setIndexEntries] = useState<SessionIndexEntry[]>([]);
  // Fallback slugs from direct JSONL reads, for sessions with no index entry.
  const [fallbackSlugs, setFallbackSlugs] = useState<Record<string, string>>({});
  const fallbackFetchedRef = useRef<Set<string>>(new Set());

  // Fetch sessions-index on mount (only for Claude sessions)
  useEffect(() => {
    if (!workingDir || (terminalType && terminalType !== "claude")) return;
    const effectiveBackend = backend ?? (useAppStore.getState().terminalBackend as TerminalBackend | undefined) ?? "wsl";
    // WSL backend needs a Unix path — convert UNC/Windows paths to /home/... form.
    const pathForBackend = effectiveBackend === "wsl" ? toWslPath(workingDir) : workingDir;
    readSessionsIndex(pathForBackend, effectiveBackend).then(setIndexEntries);
  }, [workingDir, backend, terminalType]);

  // Fetch first-prompt slugs for sessions that lack an index entry AND a store name.
  // This covers the common v2.1.109 case where sessions-index.json doesn't exist.
  useEffect(() => {
    if (!workingDir || (terminalType && terminalType !== "claude")) return;
    const effectiveBackend = backend ?? (useAppStore.getState().terminalBackend as TerminalBackend | undefined) ?? "wsl";
    const pathForBackend = effectiveBackend === "wsl" ? toWslPath(workingDir) : workingDir;
    const indexIds = new Set(indexEntries.map((e) => e.sessionId));
    const needSlug = sessions.filter((s) =>
      !s.isRenamed && !s.name && !indexIds.has(s.id) && !fallbackFetchedRef.current.has(s.id)
    );
    if (needSlug.length === 0) return;
    needSlug.forEach((s) => fallbackFetchedRef.current.add(s.id));
    Promise.all(
      needSlug.map(async (s) => {
        const prompt = await readSessionFirstPrompt(pathForBackend, effectiveBackend, s.id);
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
  }, [sessions, indexEntries, workingDir, backend, terminalType]);

  // Merge store sessions with index entries
  const mergedSessions = useMemo((): MergedSession[] => {
    const storeIds = new Set(sessions.map((s) => s.id));
    const merged: MergedSession[] = [];

    // Store sessions first (current EzyDev session)
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

  // Position dropdown below the anchor element using fixed positioning
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    if (anchorRef?.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 2, left: Math.max(8, rect.right - 260) });
    }
  }, [anchorRef]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (editingId) {
          setEditingId(null);
        } else {
          onClose();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, editingId]);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  const submitRename = () => {
    if (editingId && editValue.trim()) {
      onRename(editingId, editValue.trim());
    }
    setEditingId(null);
  };

  if (!pos) return null;

  return (
    <>
      <div
        style={{ position: "fixed", inset: 0, zIndex: 199 }}
        onMouseDown={onClose}
      />
      <div
        className="dropdown-enter"
        style={{
          position: "fixed",
          top: pos.top,
          left: pos.left,
          width: 260,
          backgroundColor: "var(--ezy-surface-raised)",
          border: "1px solid var(--ezy-border)",
          borderRadius: 8,
          overflow: "hidden",
          boxShadow: "0 12px 36px rgba(0,0,0,0.5)",
          zIndex: 200,
          maxHeight: 340,
        }}
      >
        <div style={{ overflowY: "auto", maxHeight: 296 }}>
          {mergedSessions.length === 0 && (
            <div
              style={{
                padding: "8px 10px",
                fontSize: 11,
                color: "var(--ezy-text-muted)",
                opacity: 0.6,
              }}
            >
              No saved sessions
            </div>
          )}
          {mergedSessions.map((session) => {
            const isEditing = editingId === session.id;
            return (
              <div
                key={session.id}
                className="group/session"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "0 4px 0 0",
                  backgroundColor: session.isCurrent ? "var(--ezy-accent-glow)" : "transparent",
                }}
                onMouseEnter={(e) => {
                  if (!session.isCurrent) e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)";
                }}
                onMouseLeave={(e) => {
                  if (!session.isCurrent) e.currentTarget.style.backgroundColor = "transparent";
                }}
              >
                {isEditing ? (
                  <input
                    ref={inputRef}
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={submitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitRename();
                      if (e.key === "Escape") setEditingId(null);
                      e.stopPropagation();
                    }}
                    style={{
                      flex: 1,
                      padding: "5px 10px",
                      fontSize: 12,
                      fontFamily: "inherit",
                      backgroundColor: "var(--ezy-bg)",
                      border: "1px solid var(--ezy-accent)",
                      borderRadius: 4,
                      color: "var(--ezy-text)",
                      outline: "none",
                      margin: "2px 0",
                    }}
                  />
                ) : (
                  <>
                    <button
                      className="w-full text-left"
                      style={{
                        flex: 1,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "6px 10px",
                        backgroundColor: "transparent",
                        border: "none",
                        cursor: "pointer",
                        fontSize: 12,
                        fontWeight: session.isCurrent ? 600 : 400,
                        color: session.isCurrent ? "var(--ezy-text)" : session.isFromStore ? "var(--ezy-text-secondary)" : "var(--ezy-text-muted)",
                        fontFamily: "inherit",
                        overflow: "hidden",
                      }}
                      onClick={() => {
                        if (!session.isCurrent) onSelect(session.id);
                        onClose();
                      }}
                    >
                      {/* Green dot for store sessions, dimmer dot for historical */}
                      <span
                        title={session.isFromStore ? "Session saved" : "Historical session"}
                        style={{
                          width: 5,
                          height: 5,
                          borderRadius: "50%",
                          backgroundColor: session.isFromStore ? "var(--ezy-accent)" : "var(--ezy-text-muted)",
                          flexShrink: 0,
                          opacity: session.isFromStore ? 0.7 : 0.4,
                        }}
                      />
                      <span
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          flex: 1,
                        }}
                        title={session.name}
                      >
                        {session.name}
                      </span>
                      {/* Relative time for historical sessions */}
                      {!session.isFromStore && session.modified && (
                        <span
                          style={{
                            fontSize: 10,
                            color: "var(--ezy-text-muted)",
                            opacity: 0.6,
                            flexShrink: 0,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {formatRelativeTime(session.modified)}
                        </span>
                      )}
                      {session.isCurrent && (
                        <FaCheck size={10} color="var(--ezy-accent)" style={{ flexShrink: 0 }} />
                      )}
                    </button>
                    {session.isFromStore && (
                      <div
                        role="button"
                        className="opacity-0 group-hover/session:opacity-100 transition-opacity"
                        style={{
                          cursor: "pointer",
                          padding: 4,
                          borderRadius: 4,
                          flexShrink: 0,
                          display: "flex",
                          alignItems: "center",
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-border)"}
                        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingId(session.id);
                          setEditValue(session.name);
                        }}
                        title="Rename session"
                      >
                        <FaPen size={9} color="var(--ezy-text-muted)" />
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
        {/* Divider + New Session */}
        <div style={{ borderTop: "1px solid var(--ezy-border)" }}>
          <button
            className="w-full text-left"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 10px",
              backgroundColor: "transparent",
              border: "none",
              cursor: "pointer",
              fontSize: 12,
              color: "var(--ezy-text-secondary)",
              fontFamily: "inherit",
            }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
            onClick={() => {
              onNew();
              onClose();
            }}
          >
            <FaPlus size={10} color="var(--ezy-text-muted)" />
            <span>New session</span>
          </button>
        </div>
      </div>
    </>
  );
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
  isYolo = false,
  contextInfo,
  workingDir,
  backend,
  sessionResumeId,
  sessionTrusted = false,
  onSwitchSession,
  getPromptEntries,
  onScrollToPromptLine,
}: TerminalHeaderProps) {
  const contextPercent = contextInfo?.percent ?? null;
  const config = TERMINAL_CONFIGS[terminalType];
  const slToggles = useAppStore((s) => s.statuslineToggles[terminalType]);
  /** Check if a statusline feature is shown (defaults to true) */
  const sl = (key: string) => slToggles?.[key] ?? true;
  const [showTypePicker, setShowTypePicker] = useState(false);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [showPromptHistory, setShowPromptHistory] = useState(false);
  const [promptEntries, setPromptEntries] = useState<PromptEntry[]>([]);
  const promptHistoryBtnRef = useRef<HTMLButtonElement>(null);
  const [inlineRenaming, setInlineRenaming] = useState(false);
  const [inlineRenameValue, setInlineRenameValue] = useState("");
  const inlineInputRef = useRef<HTMLInputElement>(null);
  const sessionNameRef = useRef<HTMLDivElement>(null);
  const isResumable = supportsSessionResume(terminalType);

  // Read sessions for this project + type from the store
  const normalizedDir = workingDir?.replace(/\\/g, "/") ?? "";
  const allSessions = useAppStore((s) => s.projectSessions[normalizedDir]);
  const sessions = useMemo(
    () => (allSessions ?? []).filter((sess) => sess.type === terminalType),
    [allSessions, terminalType]
  );
  const renameSession = useAppStore((s) => s.renameProjectSession);

  // Current session's custom name from registry
  const currentSession = sessions.find((s) => s.id === sessionResumeId);
  // For untrusted sessions (detected from disk — may be stale), only show the name
  // if the user explicitly renamed it. Auto-detected names come from old session files.
  // For trusted sessions (restored from persist or explicit switch), show everything.
  const sessionDisplayName = sessionTrusted
    ? (currentSession?.name || contextInfo?.sessionName || contextInfo?.summary || (sessionResumeId ? sessionResumeId.slice(0, 8) : null))
    : ((currentSession?.isRenamed ? currentSession.name : null) || contextInfo?.sessionName || contextInfo?.summary || (sessionResumeId ? sessionResumeId.slice(0, 8) : null));

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
      className="flex items-center select-none group"
      style={{
        height: 28,
        backgroundColor: isActive ? "var(--ezy-surface-raised)" : "var(--ezy-surface)",
        borderBottom: `2px solid ${isActive ? CLI_BRAND_COLORS[terminalType] : "var(--ezy-border)"}`,
        padding: "0 6px 0 0",
        transition: "border-color 200ms ease, background-color 200ms ease",
      }}
    >
      {/* Drag handle — custom pointer drag (HTML5 DnD doesn't work in Tauri WebView2) */}
      <div
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
        title="Drag to rearrange"
      >
        <FaGripVertical size={12} color="var(--ezy-text-muted)" />
      </div>
      {/* Left: type badge — clickable to switch CLI */}
      <div style={{ position: "relative", marginLeft: 3, flexShrink: 0 }}>
        <div
          className="flex items-center gap-1.5"
          style={{ cursor: "pointer", borderRadius: 4, padding: "2px 4px", margin: "-2px -4px" }}
          onClick={() => setShowTypePicker((v) => !v)}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-border)"}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
        >
          <TerminalIcon type={terminalType} />
          <span
            className="text-[11px] font-medium tracking-wide"
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
              style={{
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: "0.06em",
                lineHeight: 1.2,
                padding: "1px 4px",
                borderRadius: 3,
                backgroundColor: "var(--ezy-red, #e55)",
                color: "#fff",
              }}
            >
              YOLO
            </span>
          )}
          {sl("collabMode") && contextInfo?.collabMode && contextInfo.collabMode !== "default" && (
            <span
              style={{
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: "0.06em",
                lineHeight: 1.2,
                padding: "1px 4px",
                borderRadius: 3,
                backgroundColor: "var(--ezy-cyan, #5eead4)",
                color: "#000",
                textTransform: "uppercase",
              }}
            >
              {contextInfo.collabMode}
            </span>
          )}
          <FaChevronDown size={8} color="var(--ezy-text-muted)" />
        </div>
        {showTypePicker && (
          <CliPicker
            currentType={terminalType}
            onSelect={(type) => {
              if (type !== terminalType) onChangeType(type);
            }}
            onClose={() => setShowTypePicker(false)}
          />
        )}
      </div>

      {/* File path — max 3 segments from end */}
      {sl("filePath") && workingDir && (
        <span
          style={{
            fontSize: 10,
            color: "var(--ezy-text-muted)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            minWidth: 0,
            lineHeight: 1.2,
            marginLeft: 4,
          }}
          title={workingDir}
        >
          · {truncatePath(workingDir)}
        </span>
      )}

      {/* Model name + context usage indicator — CLI panes only (collapses when pane is narrow) */}
      {contextPercent != null && contextInfo && (
        <div
          className="ml-auto flex items-center gap-2"
          style={{ marginRight: 6, minWidth: 0, overflow: "hidden" }}
        >
          {sl("model") && contextInfo.model && (
            <span
              style={{
                fontSize: 10,
                color: "var(--ezy-text-muted)",
                lineHeight: 1.2,
                whiteSpace: "nowrap",
              }}
            >
              {terminalType === "gemini"
                ? formatGeminiModel(contextInfo.model ?? "")
                : (contextInfo.model?.replace(/^gpt-/i, "GPT ").replace(/\s*\([\d.]+[KMB]?\s*context\)/i, "") ?? "")}{contextInfo.window ? <span title={`Total context window: ${contextInfo.window.toLocaleString()} tokens`}>{` - ${formatContextWindow(contextInfo.window)}`}</span> : ""}{sl("effort") && contextInfo.effort ? ` - ${contextInfo.effort}` : ""}
            </span>
          )}
          {/* Claude: version */}
          {sl("version") && contextInfo.cliVersion && (
            <span
              style={{
                fontSize: 9,
                color: "var(--ezy-text-muted)",
                lineHeight: 1.2,
                whiteSpace: "nowrap",
              }}
            >
              v{contextInfo.cliVersion}
            </span>
          )}
          {/* Claude: speed mode */}
          {sl("speed") && contextInfo.speed && (
            <span
              style={{
                fontSize: 9,
                color: "var(--ezy-text-muted)",
                lineHeight: 1.2,
                whiteSpace: "nowrap",
              }}
            >
              {contextInfo.speed}
            </span>
          )}
          {/* Claude: per-pane session cost + cost/hr (project total in tooltip) */}
          {sl("cost") && contextInfo.costUsd != null && (
            <span
              title={(() => {
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
              style={{
                fontSize: 9,
                fontVariantNumeric: "tabular-nums",
                lineHeight: 1.2,
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
              title={`Context compacted ${contextInfo.compactCount} time${contextInfo.compactCount !== 1 ? "s" : ""}`}
              style={{
                fontSize: 9,
                fontVariantNumeric: "tabular-nums",
                lineHeight: 1.2,
                whiteSpace: "nowrap",
                color: "var(--ezy-text-muted)",
              }}
            >
              C:{contextInfo.compactCount}
            </span>
          )}
          {/* Session picker — always visible for resumable CLIs, shows name when available */}
          {sl("sessionPicker") && isResumable && (
            <div ref={sessionNameRef} style={{ minWidth: 0, flexShrink: 1 }}>
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
                    fontSize: 9,
                    lineHeight: 1.2,
                    fontFamily: "inherit",
                    backgroundColor: "var(--ezy-bg)",
                    border: "1px solid var(--ezy-accent)",
                    borderRadius: 3,
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
                    borderRadius: 3,
                    padding: "1px 4px",
                    margin: "-1px -4px",
                  }}
                  onClick={() => setShowSessionPicker((v) => !v)}
                  onDoubleClick={() => {
                    if (sessionResumeId) {
                      setInlineRenameValue(currentSession?.name || contextInfo?.sessionName || "");
                      setInlineRenaming(true);
                    }
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-border)"}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                  title={sessionDisplayName ? `${sessionDisplayName} — click to switch sessions, double-click to rename` : "Click to switch sessions"}
                >
                  <span
                    style={{
                      fontSize: 9,
                      color: "var(--ezy-text-muted)",
                      lineHeight: 1.2,
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
                      title="Session saved — will resume on restart"
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
          {/* Fallback: show session name for non-resumable or when no sessions yet */}
          {sl("sessionPicker") && !isResumable && contextInfo.sessionName && (
            <span
              title={contextInfo.sessionName}
              style={{
                fontSize: 9,
                color: "var(--ezy-text-muted)",
                lineHeight: 1.2,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                minWidth: 0,
                flexShrink: 1,
              }}
            >
              {contextInfo.sessionName}
            </span>
          )}
          {/* Gemini: summary — hidden for resumable CLIs where it's already the session name */}
          {sl("summary") && contextInfo.summary && !isResumable && (
            <span
              title={contextInfo.summary}
              style={{
                fontSize: 9,
                color: "var(--ezy-text-muted)",
                lineHeight: 1.2,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                minWidth: 0,
                flexShrink: 1,
              }}
            >
              {contextInfo.summary}
            </span>
          )}
          {/* Gemini: thinking tokens */}
          {sl("thinkingTokens") && contextInfo.thinkingTokens != null && (
            <span
              title={`Last response used ${contextInfo.thinkingTokens.toLocaleString()} thinking tokens`}
              style={{
                fontSize: 9,
                fontVariantNumeric: "tabular-nums",
                lineHeight: 1.2,
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
                title={`Quota resets at ${reset.toLocaleTimeString()}`}
                style={{
                  fontSize: 9,
                  fontVariantNumeric: "tabular-nums",
                  lineHeight: 1.2,
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
                title={tooltip}
                style={{
                  fontSize: 9,
                  fontVariantNumeric: "tabular-nums",
                  lineHeight: 1.2,
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
                title={`Weekly rate limit: ${left}% left (${contextInfo.rateLimitWeekly}% used)`}
                style={{
                  fontSize: 9,
                  fontVariantNumeric: "tabular-nums",
                  lineHeight: 1.2,
                  whiteSpace: "nowrap",
                  color: left <= 20 ? "var(--ezy-red)" : "var(--ezy-text-muted)",
                }}
              >
                W:{left}%
              </span>
            );
          })()}
          {/* Context bar + percentage — tooltip only on this section */}
          {sl("contextBar") && <div
            className="flex items-center gap-2"
            title={`${contextInfo.remaining.toLocaleString()} / ${contextInfo.window.toLocaleString()} = ${contextPercent.toFixed(2)}%`}
            style={{ flexShrink: 0 }}
          >
            <div
              style={{
                width: 44,
                height: 4,
                borderRadius: 2,
                backgroundColor: "var(--ezy-border)",
                overflow: "hidden",
                flexShrink: 0,
              }}
            >
              <div
                style={{
                  width: `${contextPercent}%`,
                  height: "100%",
                  borderRadius: 2,
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
              style={{
                fontSize: 10,
                fontVariantNumeric: "tabular-nums",
                color:
                  contextPercent <= 15
                    ? "var(--ezy-red)"
                    : contextPercent <= 40
                      ? "var(--ezy-text-muted)"
                      : "var(--ezy-text-muted)",
                lineHeight: 1.2,
                minWidth: 36,
                textAlign: "right",
              }}
            >
              {contextPercent.toFixed(2)}%
            </span>
          </div>}

        </div>
      )}

      {/* Prompt history button — always visible for AI CLIs */}
      {sl("promptHistory") && (terminalType === "claude" || terminalType === "codex" || terminalType === "gemini") && getPromptEntries && (
        <button
          ref={promptHistoryBtnRef}
          onClick={() => {
            if (showPromptHistory) {
              setShowPromptHistory(false);
            } else {
              setPromptEntries(getPromptEntries());
              setShowPromptHistory(true);
            }
          }}
          title="Prompt history"
          className={`p-1 rounded transition-colors hover:bg-[var(--ezy-border)] ${contextPercent == null ? "ml-auto" : ""}`}
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

      {/* Right: restart + close (visible on header hover) */}
      <div className={`flex items-center gap-0.5 ${contextPercent == null && !(terminalType === "claude" || terminalType === "codex" || terminalType === "gemini") ? "ml-auto" : ""} opacity-0 group-hover:opacity-100 transition-opacity`} style={{ flexShrink: 0 }}>
        {onRestart && (
          <button
            onClick={onRestart}
            title="Restart (same session)"
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
          title="Close Pane (Ctrl+Shift+W)"
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
      {showSessionPicker && isResumable && (
        <SessionPicker
          sessions={sessions}
          currentSessionId={sessionResumeId}
          contextSessionName={contextInfo?.sessionName ?? contextInfo?.summary ?? undefined}
          anchorRef={sessionNameRef}
          workingDir={workingDir}
          backend={backend}
          terminalType={terminalType}
          onSelect={(id) => onSwitchSession?.(id)}
          onRename={(id, name) => {
            if (workingDir) renameSession(workingDir, id, name);
          }}
          onNew={() => onSwitchSession?.(undefined)}
          onClose={() => setShowSessionPicker(false)}
        />
      )}

      {/* Prompt history dropdown — rendered outside overflow-hidden context info area */}
      {showPromptHistory && onScrollToPromptLine && (
        <PromptHistoryDropdown
          entries={promptEntries}
          anchorRef={promptHistoryBtnRef}
          onSelect={onScrollToPromptLine}
          onClose={() => setShowPromptHistory(false)}
        />
      )}
    </div>
  );
}
