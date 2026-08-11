import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../store";
import { useModalWhen } from "../store/modalCoordinationSlice";
import { isTicketKey, normalizeTicketKey } from "../lib/jira";
import { folderBasename, type JiraCliGroup } from "../lib/jira-groups";
import type { JiraCli } from "../lib/jira-mcp";
import { MODAL_BACKDROP } from "../lib/modal-layout";

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
  /** Which CLI the ticket pane runs. */
  cli: JiraCli;
  /** Model for the ticket pane, or null for the CLI's own default. Claude takes
   *  a tier alias (resolved to that tier's latest release); Codex and Gemini
   *  have no aliases, so theirs is a literal slug. */
  model: string | null;
  /** CLI group folder the pane spawns in, or null for the project's fallback.
   *  Only ever non-null when the request asked for the group picker. */
  cwd: string | null;
}

/** Where the dialog was opened from — what the group picker needs. */
export interface JiraTicketContext {
  /** The Jira tab's workingDir — keys the per-project last-used group. */
  projectDir?: string;
  /** Show the CLI-group (folder) picker. Keyed projects only — legacy
   *  folder-based projects always spawn in their own folder. */
  showGroups?: boolean;
}

export interface JiraTicketRequest {
  ctx?: JiraTicketContext;
  resolve: (value: JiraTicketResult | null) => void;
}

export const JIRA_TICKET_EVENT = "made:jira-ticket-dialog";

export function requestJiraTicket(ctx?: JiraTicketContext): Promise<JiraTicketResult | null> {
  return new Promise((resolve) => {
    window.dispatchEvent(
      new CustomEvent<JiraTicketRequest>(JIRA_TICKET_EVENT, { detail: { ctx, resolve } }),
    );
  });
}

const ACRONYM_RE = /^[A-Z][A-Z0-9_]*$/;

/** Claude `--model` aliases — the CLI maps each to the latest model of that
 *  tier, so these never go stale on a release. null = don't pass the flag.
 *  Codex and Gemini have no equivalent (their `-m` takes versioned slugs like
 *  `gpt-5.6-sol` / `gemini-3.1-pro-preview`), which is why only Claude gets
 *  tiles and the other two get a text field. */
const MODEL_OPTIONS: { label: string; value: string | null }[] = [
  { label: "Default", value: null },
  { label: "Fable", value: "fable" },
  { label: "Opus", value: "opus" },
  { label: "Sonnet", value: "sonnet" },
  { label: "Haiku", value: "haiku" },
];

const CLI_OPTIONS: { label: string; value: JiraCli }[] = [
  { label: "Claude", value: "claude" },
  { label: "Codex", value: "codex" },
  { label: "Gemini", value: "gemini" },
];

/** One height for every control in the CLI/model rows — see `tileStyle`. */
const MODEL_ROW_HEIGHT = 28;

const MODEL_PLACEHOLDER: Record<JiraCli, string> = {
  claude: "",
  codex: "gpt-5.6-sol — blank for Codex's default",
  gemini: "gemini-3.1-pro-preview — blank for Gemini's default",
};

export default function NewJiraTicketModal() {
  const [req, setReq] = useState<JiraTicketRequest | null>(null);
  const [acronym, setAcronym] = useState("");
  const [number, setNumber] = useState("");
  const [swedish, setSwedish] = useState(false);
  const [english, setEnglish] = useState(false);
  const [cli, setCli] = useState<JiraCli>("claude");
  // One entry per CLI, so switching back restores what that CLI last ran on
  // instead of carrying a Claude alias into `codex -m`.
  const [modelByCli, setModelByCli] = useState<Record<JiraCli, string | null>>({
    claude: null,
    codex: null,
    gemini: null,
  });
  const [baseUrlValue, setBaseUrlValue] = useState("");
  const [acronymOpen, setAcronymOpen] = useState(false);
  /** Selected CLI group id; "" = the project's fallback dir ("Default"). */
  const [groupId, setGroupId] = useState("");
  const numberRef = useRef<HTMLInputElement>(null);

  const acronyms = useAppStore((s) => s.jiraAcronyms ?? []);
  const acronymCounts = useAppStore((s) => s.jiraAcronymCounts ?? {});
  const needsBaseUrl = useAppStore((s) => (s.jiraSites ?? []).length === 0);
  const cliGroups = useAppStore((s) => s.jiraCliGroups ?? []);
  const acronymBoxRef = useRef<HTMLDivElement>(null);

  const showGroups = !!req?.ctx?.showGroups;
  const projectDir = req?.ctx?.projectDir?.replace(/\\/g, "/") ?? "";

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
      setCli(store.jiraCli ?? "claude");
      setModelByCli({
        claude: store.jiraClaudeModel ?? null,
        codex: store.jiraCodexModel ?? null,
        gemini: store.jiraGeminiModel ?? null,
      });
      setBaseUrlValue("");
      setAcronymOpen(false);
      // Preselect the group this project's LAST ticket opened in — but only
      // while that group still exists; a removed one falls back to Default.
      const dir = detail.ctx?.projectDir?.replace(/\\/g, "/") ?? "";
      const lastId = dir ? (store.jiraLastGroupByProject ?? {})[dir] : undefined;
      setGroupId(
        lastId && (store.jiraCliGroups ?? []).some((g) => g.id === lastId) ? lastId : "",
      );
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
        // First site ever — addJiraSite normalizes and makes it the default.
        store.addJiraSite(baseUrlValue);
      }
      if (cli !== store.jiraCli) store.setJiraCli(cli);
      if (modelByCli.claude !== store.jiraClaudeModel) store.setJiraClaudeModel(modelByCli.claude);
      if (modelByCli.codex !== store.jiraCodexModel) store.setJiraCodexModel(modelByCli.codex);
      if (modelByCli.gemini !== store.jiraGeminiModel) store.setJiraGeminiModel(modelByCli.gemini);
      const group = showGroups ? cliGroups.find((g) => g.id === groupId) : undefined;
      if (showGroups && projectDir) {
        store.setJiraLastGroup(projectDir, group?.id);
      }
      req.resolve({
        ticket,
        swedish,
        english,
        cli,
        model: modelByCli[cli],
        cwd: group?.path ?? null,
      });
    } else {
      req.resolve(null);
    }
    setReq(null);
  };

  const inputStyle: React.CSSProperties = {
    boxSizing: "border-box",
    padding: "7px 10px",
    fontSize: "calc(var(--ezy-font-scale, 1) * 13px)",
    borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
    outline: "none",
    background: "var(--ezy-surface, #161b22)",
    border: "1px solid var(--ezy-border, rgba(255,255,255,0.12))",
    color: "var(--ezy-text, #e6edf3)",
    fontFamily: "inherit",
  };
  const labelStyle: React.CSSProperties = {
    fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
    marginBottom: 5,
    color: "var(--ezy-text-muted, rgba(230,237,243,0.6))",
  };
  /**
   * Shared look of the CLI and Claude-model tiles.
   *
   * The height is EXPLICIT and shared with the free-text model field, because
   * the model row swaps between the two depending on the CLI: left to their
   * natural sizes, a 10px-font tile row and a 12px-font input differ by a few
   * pixels, and the whole dialog grew and shrank as you clicked between
   * Claude and Codex. Fixed height + border-box means padding and font can
   * never feed back into the dialog's size again.
   */
  const tileStyle = (selected: boolean): React.CSSProperties => ({
    boxSizing: "border-box",
    height: MODEL_ROW_HEIGHT,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0 2px",
    fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
    fontWeight: 600,
    textAlign: "center",
    borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
    cursor: "pointer",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: selected ? "#fff" : "var(--ezy-text-muted)",
    backgroundColor: selected ? "var(--ezy-accent-dim)" : "var(--ezy-surface, #161b22)",
    border: `1px solid ${selected ? "var(--ezy-accent-dim)" : "var(--ezy-border, rgba(255,255,255,0.12))"}`,
    transition: "all 120ms ease",
  });
  const checkboxLabelStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
    cursor: "pointer",
    userSelect: "none",
  };

  return (
    <div
      style={{
        ...MODAL_BACKDROP,
        zIndex: 300,
        background: "rgba(0,0,0,0.55)",
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
          fontFamily: "var(--ezy-font-ui, Inter, system-ui, sans-serif)",
        }}
      >
        <div style={{ padding: "16px 18px 12px" }}>
          <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 14px)", fontWeight: 600 }}>NEW TICKET</div>

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
                        fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
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
                        fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
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

          {/* CLI for the ticket pane, then that CLI's model — same tile
              language as the acronym quick picks. */}
          <div style={{ marginTop: 14 }}>
            <div style={labelStyle}>CLI</div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${CLI_OPTIONS.length}, 1fr)`,
                gap: 4,
              }}
            >
              {CLI_OPTIONS.map((opt) => (
                <div key={opt.value} onClick={() => setCli(opt.value)} style={tileStyle(opt.value === cli)}>
                  {opt.label}
                </div>
              ))}
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <div style={labelStyle}>Model</div>
            {/* Fixed height: this slot holds a different control per CLI, and
                the dialog must not resize under the pointer when you switch.
                tileStyle and the input below each pin themselves to the same
                height; this pins the slot, so a future third control cannot
                reintroduce the jump. */}
            <div style={{ height: MODEL_ROW_HEIGHT }}>
              {cli === "claude" ? (
                // Aliases only Claude has: "Default" = no --model flag, and each
                // alias resolves to the latest release of its tier.
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: `repeat(${MODEL_OPTIONS.length}, 1fr)`,
                    gap: 4,
                  }}
                >
                  {MODEL_OPTIONS.map((opt) => (
                    <div
                      key={opt.label}
                      onClick={() => setModelByCli((m) => ({ ...m, claude: opt.value }))}
                      style={tileStyle(opt.value === modelByCli.claude)}
                    >
                      {opt.label}
                    </div>
                  ))}
                </div>
              ) : (
                // Codex and Gemini take versioned slugs with no alias layer, so a
                // fixed tile list would rot on every vendor release. Blank = no
                // flag at all, which leaves the CLI on its own default.
                <input
                  value={modelByCli[cli] ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    setModelByCli((m) => ({ ...m, [cli]: v.trim() ? v : null }));
                  }}
                  placeholder={MODEL_PLACEHOLDER[cli]}
                  spellCheck={false}
                  autoComplete="off"
                  style={{
                    ...inputStyle,
                    width: "100%",
                    fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                    // Same row height as the tiles it replaces; the vertical
                    // padding goes with it, or border-box would just shrink the
                    // text box inside a correctly-sized frame.
                    height: MODEL_ROW_HEIGHT,
                    padding: "0 10px",
                  }}
                />
              )}
            </div>
          </div>

          {/* CLI group — which FOLDER the ticket pane spawns in. Keyed
              projects only; "Default" = the project fallback dir. Tiles use
              the group's name (or the folder's basename), full path in the
              tooltip. Browse adds a folder to the GLOBAL group list. */}
          {showGroups && (
            <div style={{ marginTop: 12 }}>
              <div style={labelStyle}>Group</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                <div
                  onClick={() => setGroupId("")}
                  data-tooltip="No folder — the pane opens in the projects dir (or home)"
                  style={{ ...tileStyle(groupId === ""), padding: "0 10px" }}
                >
                  Default
                </div>
                {cliGroups.map((g: JiraCliGroup) => (
                  <div
                    key={g.id}
                    onClick={() => setGroupId(g.id)}
                    data-tooltip={g.path}
                    style={{ ...tileStyle(groupId === g.id), padding: "0 10px", maxWidth: 140 }}
                  >
                    {g.name?.trim() || folderBasename(g.path)}
                  </div>
                ))}
                <div
                  onClick={() => {
                    void openDialog({
                      directory: true,
                      multiple: false,
                      title: "Select a folder for Jira CLI panes",
                    }).then((picked) => {
                      if (typeof picked !== "string") return;
                      // Adds to (or re-finds in) the global list and selects it;
                      // naming happens in Settings → Jira.
                      setGroupId(useAppStore.getState().addJiraCliGroup(picked));
                    });
                  }}
                  data-tooltip="Add a folder to the group list"
                  style={{ ...tileStyle(false), padding: "0 10px" }}
                >
                  Add folder…
                </div>
              </div>
            </div>
          )}

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
              fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
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
              fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
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
