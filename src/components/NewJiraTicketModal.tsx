import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store";
import { useModalWhen } from "../store/modalCoordinationSlice";
import { isTicketKey, normalizeTicketKey, normalizeJiraBaseUrl } from "../lib/jira";

/**
 * New-ticket dialog: acronym ("SUPPORT", "DEV", …) and ticket number entered
 * SEPARATELY. Acronyms are remembered most-recent-first and pre-filled, so a
 * ticket is usually just its number typed from memory — but pasting a full
 * key ("ABC-123", or a browse URL) into either field splits it automatically.
 * Same promise-carrying CustomEvent pattern as PromptModal; host mounted once
 * in App.
 */

export interface JiraTicketResult {
  ticket: string;
  swedish: boolean;
  english: boolean;
  /** Claude Code `--model` alias for the ticket pane, or null for the CLI's
   *  own default. Aliases resolve to the latest release of each tier. */
  model: string | null;
}

export interface JiraTicketRequest {
  resolve: (value: JiraTicketResult | null) => void;
}

export const JIRA_TICKET_EVENT = "made:jira-ticket-dialog";

export function requestJiraTicket(): Promise<JiraTicketResult | null> {
  return new Promise((resolve) => {
    window.dispatchEvent(
      new CustomEvent<JiraTicketRequest>(JIRA_TICKET_EVENT, { detail: { resolve } }),
    );
  });
}

const ACRONYM_RE = /^[A-Z][A-Z0-9_]*$/;

/** `--model` aliases — the CLI maps each to the latest model of that tier,
 *  so these never go stale on a release. null = don't pass the flag. */
const MODEL_OPTIONS: { label: string; value: string | null }[] = [
  { label: "Default", value: null },
  { label: "Fable", value: "fable" },
  { label: "Opus", value: "opus" },
  { label: "Sonnet", value: "sonnet" },
  { label: "Haiku", value: "haiku" },
];

export default function NewJiraTicketModal() {
  const [req, setReq] = useState<JiraTicketRequest | null>(null);
  const [acronym, setAcronym] = useState("");
  const [number, setNumber] = useState("");
  const [swedish, setSwedish] = useState(false);
  const [english, setEnglish] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [baseUrlValue, setBaseUrlValue] = useState("");
  const [acronymOpen, setAcronymOpen] = useState(false);
  const numberRef = useRef<HTMLInputElement>(null);

  const acronyms = useAppStore((s) => s.jiraAcronyms ?? []);
  const acronymCounts = useAppStore((s) => s.jiraAcronymCounts ?? {});
  const jiraBaseUrl = useAppStore((s) => s.jiraBaseUrl ?? "");
  const needsBaseUrl = !jiraBaseUrl.trim();
  const acronymBoxRef = useRef<HTMLDivElement>(null);

  // Quick-pick tiles: the 4 MOST-USED acronyms, EXCLUDING the one already in
  // the field above (a tile repeating the dropdown is layer-on-layer noise).
  // `jiraAcronyms` is MRU-ordered and sort is stable, so equal counts
  // tie-break by recency.
  const topAcronyms = [...acronyms]
    .sort((a, b) => (acronymCounts[b] ?? 0) - (acronymCounts[a] ?? 0))
    .filter((a) => a !== acronym.trim().toUpperCase())
    .slice(0, 4);

  // The chevron dropdown must close on any outside click, not just the chevron.
  useEffect(() => {
    if (!acronymOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!acronymBoxRef.current?.contains(e.target as Node)) setAcronymOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown, true);
    return () => document.removeEventListener("mousedown", onMouseDown, true);
  }, [acronymOpen]);

  useModalWhen("jira-ticket-modal", !!req);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<JiraTicketRequest>).detail;
      const store = useAppStore.getState();
      setAcronym(store.jiraAcronyms?.[0] ?? "");
      setNumber("");
      setSwedish(store.jiraReplyInSwedish ?? false);
      setEnglish(store.jiraReplyInEnglish ?? false);
      setModel(store.jiraClaudeModel ?? null);
      setBaseUrlValue("");
      setAcronymOpen(false);
      setReq(detail);
      setTimeout(() => numberRef.current?.focus(), 0);
    };
    window.addEventListener(JIRA_TICKET_EVENT, handler);
    return () => window.removeEventListener(JIRA_TICKET_EVENT, handler);
  }, []);

  if (!req) return null;

  /** A full key ("SUPPORT-212383" or a browse URL) pasted into either field
   *  splits into both. Returns true when it consumed the value. */
  const trySplitFullKey = (value: string): boolean => {
    if (!/[-/]/.test(value)) return false;
    const key = normalizeTicketKey(value);
    if (!key) return false;
    const dash = key.lastIndexOf("-");
    setAcronym(key.slice(0, dash));
    setNumber(key.slice(dash + 1));
    numberRef.current?.focus();
    return true;
  };

  const acronymTrimmed = acronym.trim().toUpperCase();
  const numberTrimmed = number.trim();
  const ticket = `${acronymTrimmed}-${numberTrimmed}`;
  const baseUrlOk = !needsBaseUrl || baseUrlValue.trim().length > 0;
  const canConfirm =
    ACRONYM_RE.test(acronymTrimmed) && /^\d+$/.test(numberTrimmed) && isTicketKey(ticket) && baseUrlOk;

  const finish = (confirmed: boolean) => {
    if (confirmed) {
      const store = useAppStore.getState();
      store.addJiraAcronym(acronymTrimmed);
      if (swedish !== store.jiraReplyInSwedish) store.setJiraReplyInSwedish(swedish);
      if (english !== store.jiraReplyInEnglish) store.setJiraReplyInEnglish(english);
      if (needsBaseUrl && baseUrlValue.trim()) {
        store.setJiraBaseUrl(normalizeJiraBaseUrl(baseUrlValue));
      }
      if (model !== store.jiraClaudeModel) store.setJiraClaudeModel(model);
      req.resolve({ ticket, swedish, english, model });
    } else {
      req.resolve(null);
    }
    setReq(null);
  };

  const inputStyle: React.CSSProperties = {
    boxSizing: "border-box",
    padding: "7px 10px",
    fontSize: 13,
    borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
    outline: "none",
    background: "var(--ezy-surface, #161b22)",
    border: "1px solid var(--ezy-border, rgba(255,255,255,0.12))",
    color: "var(--ezy-text, #e6edf3)",
    fontFamily: "inherit",
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 11,
    marginBottom: 5,
    color: "var(--ezy-text-muted, rgba(230,237,243,0.6))",
  };
  const checkboxLabelStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 12,
    cursor: "pointer",
    userSelect: "none",
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 300,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        // Upper third, matching the app's other action dialogs (Create
        // Project, token wizard) — dead-center reads oddly low for a form.
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "12vh",
      }}
      onClick={() => finish(false)}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            // First Escape closes an open dropdown; the second cancels.
            if (acronymOpen) {
              setAcronymOpen(false);
              return;
            }
            finish(false);
          } else if (e.key === "Enter" && canConfirm) {
            e.stopPropagation();
            finish(true);
          }
        }}
        style={{
          width: 400,
          maxWidth: "calc(100vw - 32px)",
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 10px)",
          background: "var(--ezy-surface-raised, #1c2128)",
          border: "1px solid var(--ezy-border, rgba(255,255,255,0.1))",
          boxShadow: "0 16px 48px rgba(0,0,0,0.55)",
          color: "var(--ezy-text, #e6edf3)",
          fontFamily: "Inter, system-ui, sans-serif",
        }}
      >
        <div style={{ padding: "16px 18px 12px" }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>NEW TICKET</div>

          {/* Acronym + number, side by side. */}
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <div ref={acronymBoxRef} style={{ width: 130, flexShrink: 0 }}>
              <div style={labelStyle}>Project</div>
              {/* Inner relative wrapper: the popover anchors to the INPUT,
                  not the column — the quick-pick tiles live below it. */}
              <div style={{ position: "relative" }}>
              <div style={{ display: "flex" }}>
                <input
                  value={acronym}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (trySplitFullKey(v)) return;
                    setAcronym(v.toUpperCase());
                  }}
                  placeholder="ABC"
                  spellCheck={false}
                  autoComplete="off"
                  style={{
                    ...inputStyle,
                    width: "100%",
                    borderRadius: acronyms.length > 0
                      ? "calc(var(--ezy-radius-scale, 1) * 6px) 0 0 calc(var(--ezy-radius-scale, 1) * 6px)"
                      : "calc(var(--ezy-radius-scale, 1) * 6px)",
                    textTransform: "uppercase",
                  }}
                />
                {acronyms.length > 0 && (
                  <div
                    onClick={() => setAcronymOpen((v) => !v)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 24,
                      cursor: "pointer",
                      background: "var(--ezy-surface, #161b22)",
                      border: "1px solid var(--ezy-border, rgba(255,255,255,0.12))",
                      borderLeft: "none",
                      borderRadius: "0 calc(var(--ezy-radius-scale, 1) * 6px) calc(var(--ezy-radius-scale, 1) * 6px) 0",
                    }}
                  >
                    <svg
                      width="9"
                      height="9"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="var(--ezy-text-muted)"
                      strokeWidth="2"
                      strokeLinecap="round"
                      style={{ transform: acronymOpen ? "rotate(180deg)" : "none" }}
                    >
                      <path d="M3 6l5 5 5-5" />
                    </svg>
                  </div>
                )}
              </div>
              {acronymOpen && (
                <div
                  style={{
                    position: "absolute",
                    top: "100%",
                    left: 0,
                    right: 0,
                    marginTop: 2,
                    zIndex: 10,
                    background: "var(--ezy-surface, #161b22)",
                    border: "1px solid var(--ezy-border, rgba(255,255,255,0.12))",
                    borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
                    boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                    maxHeight: 160,
                    overflowY: "auto",
                  }}
                >
                  {acronyms.map((a) => (
                    <div
                      key={a}
                      onClick={() => {
                        setAcronym(a);
                        setAcronymOpen(false);
                        numberRef.current?.focus();
                      }}
                      style={{
                        padding: "6px 10px",
                        fontSize: 12,
                        cursor: "pointer",
                        color: a === acronymTrimmed ? "var(--ezy-text)" : "var(--ezy-text-secondary, rgba(230,237,243,0.8))",
                        background: a === acronymTrimmed ? "var(--ezy-accent-glow, rgba(16,185,129,0.12))" : "transparent",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--ezy-border)"; }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = a === acronymTrimmed ? "var(--ezy-accent-glow, rgba(16,185,129,0.12))" : "transparent";
                      }}
                    >
                      {a}
                    </div>
                  ))}
                </div>
              )}
              </div>
              {/* Most-used quick picks — 2×2, matching the dropdown width. */}
              {topAcronyms.length > 0 && (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 4,
                    marginTop: 6,
                  }}
                >
                  {topAcronyms.map((a) => (
                    <div
                      key={a}
                      onClick={() => {
                        setAcronym(a);
                        setAcronymOpen(false);
                        numberRef.current?.focus();
                      }}
                      data-tooltip={a}
                      style={{
                        padding: "4px 2px",
                        fontSize: 10,
                        fontWeight: 600,
                        textAlign: "center",
                        borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                        cursor: "pointer",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        color: a === acronymTrimmed ? "#fff" : "var(--ezy-text-muted)",
                        backgroundColor:
                          a === acronymTrimmed ? "var(--ezy-accent-dim)" : "var(--ezy-surface, #161b22)",
                        border: `1px solid ${
                          a === acronymTrimmed
                            ? "var(--ezy-accent-dim)"
                            : "var(--ezy-border, rgba(255,255,255,0.12))"
                        }`,
                        transition: "all 120ms ease",
                      }}
                    >
                      {a}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={labelStyle}>Ticket number</div>
              <input
                ref={numberRef}
                value={number}
                onChange={(e) => {
                  const v = e.target.value;
                  if (trySplitFullKey(v)) return;
                  setNumber(v.replace(/[^\d]/g, ""));
                }}
                placeholder="123456 — or paste ABC-123"
                spellCheck={false}
                autoComplete="off"
                inputMode="numeric"
                style={{ ...inputStyle, width: "100%" }}
              />
            </div>
          </div>

          {/* Claude model for the ticket pane — same tile language as the
              acronym quick picks. "Default" = no --model flag; the aliases
              resolve to the latest release of each tier. */}
          <div style={{ marginTop: 14 }}>
            <div style={labelStyle}>Claude model</div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${MODEL_OPTIONS.length}, 1fr)`,
                gap: 4,
              }}
            >
              {MODEL_OPTIONS.map((opt) => {
                const selected = opt.value === model;
                return (
                  <div
                    key={opt.label}
                    onClick={() => setModel(opt.value)}
                    style={{
                      padding: "5px 2px",
                      fontSize: 10,
                      fontWeight: 600,
                      textAlign: "center",
                      borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                      cursor: "pointer",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      color: selected ? "#fff" : "var(--ezy-text-muted)",
                      backgroundColor: selected
                        ? "var(--ezy-accent-dim)"
                        : "var(--ezy-surface, #161b22)",
                      border: `1px solid ${
                        selected
                          ? "var(--ezy-accent-dim)"
                          : "var(--ezy-border, rgba(255,255,255,0.12))"
                      }`,
                      transition: "all 120ms ease",
                    }}
                  >
                    {opt.label}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Reply language — mutually exclusive; neither = template as-is. */}
          <div style={{ display: "flex", alignItems: "center", gap: 18, marginTop: 12 }}>
            <label style={checkboxLabelStyle}>
              <input
                type="checkbox"
                checked={swedish}
                onChange={(e) => {
                  setSwedish(e.target.checked);
                  if (e.target.checked) setEnglish(false);
                }}
                style={{ accentColor: "var(--ezy-accent, #10a37f)", cursor: "pointer" }}
              />
              Reply in Swedish
            </label>
            <label style={checkboxLabelStyle}>
              <input
                type="checkbox"
                checked={english}
                onChange={(e) => {
                  setEnglish(e.target.checked);
                  if (e.target.checked) setSwedish(false);
                }}
                style={{ accentColor: "var(--ezy-accent, #10a37f)", cursor: "pointer" }}
              />
              Reply in English
            </label>
          </div>

          {needsBaseUrl && (
            <div style={{ marginTop: 14 }}>
              <div style={labelStyle}>Jira company (or full address)</div>
              <input
                value={baseUrlValue}
                onChange={(e) => setBaseUrlValue(e.target.value)}
                placeholder="yourcompany"
                spellCheck={false}
                autoComplete="off"
                style={{ ...inputStyle, width: "100%" }}
              />
            </div>
          )}

        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 18px 14px" }}>
          <button
            onClick={() => finish(false)}
            style={{
              padding: "6px 14px",
              fontSize: 12,
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
              cursor: "pointer",
              border: "1px solid var(--ezy-border, rgba(255,255,255,0.12))",
              background: "transparent",
              color: "var(--ezy-text, #e6edf3)",
            }}
          >
            Cancel
          </button>
          <button
            disabled={!canConfirm}
            onClick={() => finish(true)}
            style={{
              padding: "6px 14px",
              fontSize: 12,
              fontWeight: 600,
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
              border: "none",
              cursor: canConfirm ? "pointer" : "default",
              opacity: canConfirm ? 1 : 0.45,
              background: "var(--ezy-accent, #10a37f)",
              color: "#fff",
            }}
          >
            Investigate
          </button>
        </div>
      </div>
    </div>
  );
}
