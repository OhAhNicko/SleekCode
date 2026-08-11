import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import LoadingDots from "./LoadingDots";
import { useAppStore } from "../store";
import { useJiraNotifyStore } from "../store/jiraNotifyStore";
import { useModal } from "../store/modalCoordinationSlice";
import { createKeyedJiraProject } from "../lib/jira-project";
import { credsForSiteIn, defaultJiraSiteIn } from "../lib/jira-sites";
import { jiraSiteName, normalizeJiraBaseUrl } from "../lib/jira";
import ModalCloseButton from "./ModalCloseButton";
import { MODAL_BACKDROP, MODAL_MAX_HEIGHT } from "../lib/modal-layout";

/**
 * New Jira Project — authenticate against Jira, then pick which PROJECT KEY
 * (SUPPORT, DEV, …) the tab points at. Three phases:
 *
 *   checking → stored credentials silently validated (`jira_test_auth`);
 *              straight to the picker when they pass, so the login form is
 *              never shown to an already-signed-in user.
 *   login    → site + email + API token, shown only when credentials are
 *              missing or rejected. Values persist ONLY after a successful
 *              test — a typo never overwrites working credentials.
 *   picker   → the account's projects on the chosen site
 *              (`jira_list_projects`), searchable; picking one creates the
 *              keyed tab (`createKeyedJiraProject`).
 *
 * The folder-coupled parts of the old modal — location chips, folder browse,
 * the CLAUDE.md template checkbox — are deliberately gone from this flow.
 * A keyed project has no folder yet; folder handling for Jira CLI panes
 * arrives with the follow-up step, and these controls return with it.
 */

interface JiraProjectBrief {
  key: string;
  name: string;
}

/** The Rust side rejects with `JiraApiError { kind, status?, message }`. */
interface JiraApiErr {
  kind?: string;
  status?: number;
  message?: string;
}

function apiErr(err: unknown): JiraApiErr {
  if (err && typeof err === "object") return err as JiraApiErr;
  return { message: String(err) };
}

/** User-facing copy per error kind — direction, not mood. */
function errCopy(e: JiraApiErr): string {
  switch (e.kind) {
    case "auth":
      return "Jira rejected this email or API token.";
    case "config":
      return "That doesn't look like a Jira site address.";
    case "rate":
      return "Jira is rate-limiting requests — try again in a minute.";
    default:
      return e.message || "Jira could not be reached.";
  }
}

type Phase = "checking" | "login" | "picker";

/** Where Atlassian API tokens are created. Opened in the SYSTEM browser —
 *  the user is typically already signed in to Atlassian there, which an
 *  embedded view would not be. */
const ATLASSIAN_API_TOKENS_URL =
  "https://id.atlassian.com/manage-profile/security/api-tokens";

export default function JiraProjectModal({ onClose }: { onClose: () => void }) {
  useModal("jira-project-modal");
  const jiraSites = useAppStore((s) => s.jiraSites ?? []);
  const storedEmail = useAppStore((s) => s.jiraApiEmail ?? "");
  const storedToken = useAppStore((s) => s.jiraApiToken ?? "");

  const haveCreds = jiraSites.length > 0 && !!storedEmail && !!storedToken;
  const [phase, setPhase] = useState<Phase>(haveCreds ? "checking" : "login");
  /** rate/network failure of the silent check — credentials may be fine, so
   *  this is a Retry view, never a forced re-entry of working values. */
  const [checkError, setCheckError] = useState<JiraApiErr | null>(null);

  // Login form. Prefilled from the store so fixing a rejected token is an
  // edit, not a retype.
  const [siteInput, setSiteInput] = useState<string>(
    () => defaultJiraSiteIn(useAppStore.getState()) || "",
  );
  const [emailInput, setEmailInput] = useState(storedEmail);
  const [tokenInput, setTokenInput] = useState(storedToken);
  const [loginError, setLoginError] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);

  // Picker.
  const [siteId, setSiteId] = useState<string>(
    () => defaultJiraSiteIn(useAppStore.getState()) || "",
  );
  const [projects, setProjects] = useState<JiraProjectBrief[] | null>(null);
  const [listError, setListError] = useState<JiraApiErr | null>(null);
  const [search, setSearch] = useState("");
  const [selectedKey, setSelectedKey] = useState<string>("");
  const searchRef = useRef<HTMLInputElement>(null);

  /** The login form is adding a NEW site with its own login (the "Add site…"
   *  chip) rather than fixing the main account. On success the entered pair
   *  becomes a PER-SITE account override when it differs from the main one —
   *  the main jiraApiEmail/Token are never touched on this path. */
  const [newSiteLogin, setNewSiteLogin] = useState(false);

  const passCheck = useCallback((accountId: string) => {
    useAppStore.getState().setJiraMyAccountId(accountId);
    useJiraNotifyStore.getState().clearSiteAuthErrors();
  }, []);

  /** Silent validation of STORED credentials (mount / Retry). */
  const checkStored = useCallback(async () => {
    setPhase("checking");
    setCheckError(null);
    const s = useAppStore.getState();
    try {
      const me = await invoke<{ displayName: string; accountId: string }>("jira_test_auth", {
        // One Atlassian account spans every site — testing the default site
        // validates the credential pair for all of them.
        baseUrl: defaultJiraSiteIn(s),
        email: s.jiraApiEmail,
        token: s.jiraApiToken,
      });
      passCheck(me.accountId);
      setPhase("picker");
    } catch (err) {
      const e = apiErr(err);
      if (e.kind === "auth" || e.kind === "config") {
        // The stored values are actually wrong — hand them to the login form.
        setLoginError("Jira rejected the saved credentials — check them below.");
        setPhase("login");
      } else {
        setCheckError(e);
      }
    }
  }, [passCheck]);

  useEffect(() => {
    if (haveCreds) void checkStored();
    // Mount-only: haveCreds is a snapshot of whether to try the silent path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Test the ENTERED values; persist them only on success. */
  const submitLogin = useCallback(async () => {
    const base = normalizeJiraBaseUrl(siteInput);
    const email = emailInput.trim();
    const token = tokenInput.trim();
    if (!base || !email || !token || loginBusy) return;
    setLoginBusy(true);
    setLoginError("");
    try {
      const me = await invoke<{ displayName: string; accountId: string }>("jira_test_auth", {
        baseUrl: base,
        email,
        token,
      });
      const store = useAppStore.getState();
      store.addJiraSite(base); // dedupes; the first site becomes the default
      const haveMain = !!store.jiraApiEmail && !!store.jiraApiToken;
      const matchesMain = email === store.jiraApiEmail && token === store.jiraApiToken;
      if (newSiteLogin && haveMain && !matchesMain) {
        // A different login for THIS site only — the main pair stays.
        store.setJiraSiteAccount(base, { email, token, accountId: me.accountId });
        useJiraNotifyStore.getState().clearSiteAuthErrors();
      } else {
        // First login ever, a main-account fix, or the same pair re-entered.
        store.setJiraApiEmail(email);
        store.setJiraApiToken(token);
        passCheck(me.accountId);
      }
      setNewSiteLogin(false);
      setSiteId(base);
      setPhase("picker");
    } catch (err) {
      setLoginError(errCopy(apiErr(err)));
    } finally {
      setLoginBusy(false);
    }
  }, [siteInput, emailInput, tokenInput, loginBusy, newSiteLogin, passCheck]);

  /** Fetch the picker's project list for one site — with that SITE's login. */
  const loadProjects = useCallback(async (site: string) => {
    setProjects(null);
    setListError(null);
    setSelectedKey("");
    const creds = credsForSiteIn(useAppStore.getState(), site);
    try {
      const list = await invoke<JiraProjectBrief[]>("jira_list_projects", {
        baseUrl: site,
        email: creds.email,
        token: creds.token,
      });
      setProjects(list);
    } catch (err) {
      const e = apiErr(err);
      if (e.kind === "auth") {
        // Token revoked between the check and the listing — back to login.
        setLoginError(errCopy(e));
        setPhase("login");
        return;
      }
      setListError(e);
    }
  }, []);

  useEffect(() => {
    if (phase !== "picker") return;
    if (!siteId) {
      // Adopt the default site; the state change re-runs this effect, which
      // then loads exactly once.
      const site = defaultJiraSiteIn(useAppStore.getState());
      if (site) setSiteId(site);
      return;
    }
    void loadProjects(siteId);
  }, [phase, siteId, loadProjects]);

  // The search field is where every picker visit starts.
  useEffect(() => {
    if (phase === "picker" && projects) searchRef.current?.focus();
  }, [phase, projects]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // Optional CLI folder ("group") added right here in the wizard, so the very
  // first ticket already has somewhere real to spawn. Global list — the same
  // groups Settings → Jira manages and the new-ticket dialog offers.
  const [groupPath, setGroupPath] = useState("");
  const [groupName, setGroupName] = useState("");

  const browseGroupFolder = useCallback(async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "Select a folder for Jira CLI panes",
      });
      if (typeof picked === "string") setGroupPath(picked);
    } catch {
      /* cancelled */
    }
  }, []);

  /** Create the keyed project (single click + Create, or row double-click) —
   *  and register/preselect the optional CLI folder for it. */
  const createProject = useCallback(
    (key: string) => {
      if (!key || !siteId) return;
      const { tabId } = createKeyedJiraProject({ siteId, projectKey: key });
      if (groupPath) {
        const store = useAppStore.getState();
        const groupId = store.addJiraCliGroup(groupPath, groupName || undefined);
        // Preselect it for this project's first new-ticket dialog.
        const dir = store.tabs.find((t) => t.id === tabId)?.workingDir;
        if (dir) store.setJiraLastGroup(dir, groupId);
      }
      onClose();
    },
    [siteId, groupPath, groupName, onClose],
  );

  const handleCreate = useCallback(() => createProject(selectedKey), [createProject, selectedKey]);

  const labelStyle: React.CSSProperties = {
    fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
    color: "var(--ezy-text-muted)",
    marginBottom: 6,
    fontWeight: 500,
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "8px 10px",
    fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
    color: "var(--ezy-text)",
    backgroundColor: "var(--ezy-surface)",
    border: "1px solid var(--ezy-border)",
    borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
    outline: "none",
    fontFamily: "inherit",
    boxSizing: "border-box",
  };

  const primaryBtn = (enabled: boolean): React.CSSProperties => ({
    marginTop: 16,
    width: "100%",
    padding: "8px 0",
    fontSize: "calc(var(--ezy-font-scale, 1) * 13px)",
    fontWeight: 600,
    color: enabled ? "#fff" : "var(--ezy-text-muted)",
    backgroundColor: enabled ? "var(--ezy-accent)" : "var(--ezy-surface)",
    border: enabled ? "none" : "1px solid var(--ezy-border)",
    borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
    cursor: enabled ? "pointer" : "not-allowed",
    fontFamily: "inherit",
    transition: "background-color 150ms ease",
  });

  const secondaryBtn: React.CSSProperties = {
    padding: "5px 14px",
    fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
    fontWeight: 500,
    color: "var(--ezy-text-secondary)",
    backgroundColor: "var(--ezy-surface-raised)",
    border: "1px solid var(--ezy-border)",
    borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
    cursor: "pointer",
    fontFamily: "inherit",
  };

  const errorStyle: React.CSSProperties = {
    fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
    color: "#e55",
    marginTop: 10,
  };

  const query = search.trim().toLowerCase();
  const filtered = (projects ?? []).filter(
    (p) => !query || p.key.toLowerCase().includes(query) || p.name.toLowerCase().includes(query),
  );

  return (
    <div
      style={{
        ...MODAL_BACKDROP,
        backgroundColor: "rgba(0,0,0,0.6)",
        zIndex: 200,
      }}
      onClick={onClose}
    >
      <div
        style={{
          maxWidth: 480,
          width: "100%",
          maxHeight: MODAL_MAX_HEIGHT,
          backgroundColor: "var(--ezy-surface-raised)",
          border: "1px solid var(--ezy-border)",
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 10px)",
          overflowX: "hidden",
          overflowY: "auto",
          boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            height: 32,
            padding: "0 16px",
            borderBottom: "1px solid var(--ezy-border)",
            backgroundColor: "var(--ezy-surface)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 13px)", fontWeight: 600, color: "var(--ezy-text)" }}>
            New Jira Project
          </span>
          <ModalCloseButton onClose={onClose} />
        </div>

        {/* Body — min-height keeps the modal from jumping between phases. */}
        <div style={{ padding: 16, minHeight: 220, boxSizing: "border-box" }}>
          {phase === "checking" && (
            <div
              style={{
                minHeight: 188,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 12,
              }}
            >
              {checkError ? (
                <>
                  <div style={{ ...errorStyle, marginTop: 0, textAlign: "center" }}>
                    {errCopy(checkError)}
                  </div>
                  <button style={secondaryBtn} onClick={() => void checkStored()}>
                    Retry
                  </button>
                </>
              ) : (
                <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-text-muted)" }}>
                  <LoadingDots>Checking Jira access</LoadingDots>
                </div>
              )}
            </div>
          )}

          {phase === "login" && (
            <>
              <div style={{ marginBottom: 14 }}>
                <div style={labelStyle}>Jira site</div>
                <input
                  style={inputStyle}
                  value={siteInput}
                  onChange={(e) => setSiteInput(e.target.value)}
                  placeholder="acme or https://acme.atlassian.net"
                  spellCheck={false}
                  autoFocus={!siteInput}
                />
              </div>
              <div style={{ marginBottom: 14 }}>
                <div style={labelStyle}>Email</div>
                <input
                  style={inputStyle}
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  placeholder="you@company.com"
                  spellCheck={false}
                  autoFocus={!!siteInput && !emailInput}
                />
              </div>
              <div style={{ marginBottom: 4 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    justifyContent: "space-between",
                    gap: 8,
                    marginBottom: 6,
                  }}
                >
                  <div style={{ ...labelStyle, marginBottom: 0 }}>API token</div>
                  {/* System browser on purpose: that's where the user is
                      already signed in to Atlassian. */}
                  <div
                    onClick={() => void openUrl(ATLASSIAN_API_TOKENS_URL).catch(() => {})}
                    style={{
                      fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                      fontWeight: 500,
                      color: "var(--ezy-accent)",
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Create one on id.atlassian.com
                  </div>
                </div>
                <input
                  style={inputStyle}
                  type="password"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submitLogin();
                  }}
                  autoFocus={!!siteInput && !!emailInput}
                />
              </div>
              {loginError && <div style={errorStyle}>{loginError}</div>}
              {newSiteLogin && (
                <div
                  style={{
                    fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                    color: "var(--ezy-text-muted)",
                    marginTop: 10,
                  }}
                >
                  A different email and token here becomes this site's own
                  login — the main account is not changed.
                </div>
              )}
              <button
                disabled={!normalizeJiraBaseUrl(siteInput) || !emailInput.trim() || !tokenInput.trim() || loginBusy}
                onClick={() => void submitLogin()}
                style={primaryBtn(!!normalizeJiraBaseUrl(siteInput) && !!emailInput.trim() && !!tokenInput.trim() && !loginBusy)}
              >
                {loginBusy ? <LoadingDots>Connecting</LoadingDots> : "Connect to Jira"}
              </button>
              {newSiteLogin && jiraSites.length > 0 && (
                <button
                  onClick={() => {
                    setNewSiteLogin(false);
                    setLoginError("");
                    setPhase("picker");
                  }}
                  style={{ ...secondaryBtn, marginTop: 8, width: "100%" }}
                >
                  Back to projects
                </button>
              )}
            </>
          )}

          {phase === "picker" && (
            <>
              {/* Site chips + "Add site…". One site per project; the list is
                  per-site, so switching refetches. Adding a site opens the
                  login form blank — a NEW site may use a different account,
                  which becomes a per-site override (main login untouched). */}
              <div style={{ marginBottom: 14 }}>
                <div style={labelStyle}>Jira site</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {jiraSites.map((origin) => (
                    <div
                      key={origin}
                      onClick={() => setSiteId(origin)}
                      data-tooltip={origin}
                      style={{
                        padding: "5px 12px",
                        fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                        fontWeight: 600,
                        borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
                        cursor: "pointer",
                        color: siteId === origin ? "#fff" : "var(--ezy-text-muted)",
                        backgroundColor: siteId === origin ? "var(--ezy-accent-dim)" : "var(--ezy-surface)",
                        border: `1px solid ${siteId === origin ? "var(--ezy-accent-dim)" : "var(--ezy-border)"}`,
                        transition: "all 120ms ease",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {jiraSiteName(origin) ?? origin}
                    </div>
                  ))}
                  <div
                    onClick={() => {
                      setNewSiteLogin(true);
                      setSiteInput("");
                      setEmailInput("");
                      setTokenInput("");
                      setLoginError("");
                      setPhase("login");
                    }}
                    data-tooltip="Add another Jira site — it can use its own email and API token"
                    style={{
                      padding: "5px 12px",
                      fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                      fontWeight: 600,
                      borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
                      cursor: "pointer",
                      color: "var(--ezy-text-muted)",
                      backgroundColor: "var(--ezy-surface)",
                      border: "1px solid var(--ezy-border)",
                      transition: "all 120ms ease",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Add site…
                  </div>
                </div>
              </div>

              <div style={labelStyle}>Project</div>
              {listError ? (
                <div
                  style={{
                    minHeight: 140,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 12,
                  }}
                >
                  <div style={{ ...errorStyle, marginTop: 0, textAlign: "center" }}>{errCopy(listError)}</div>
                  <button style={secondaryBtn} onClick={() => void loadProjects(siteId)}>
                    Retry
                  </button>
                </div>
              ) : projects === null ? (
                <div
                  style={{
                    minHeight: 140,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                    color: "var(--ezy-text-muted)",
                  }}
                >
                  <LoadingDots>Loading projects</LoadingDots>
                </div>
              ) : projects.length === 0 ? (
                <div
                  style={{
                    minHeight: 140,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                    color: "var(--ezy-text-muted)",
                    textAlign: "center",
                  }}
                >
                  No projects visible to this account on this site.
                </div>
              ) : (
                <>
                  <input
                    ref={searchRef}
                    style={{ ...inputStyle, marginBottom: 8 }}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search projects…"
                    spellCheck={false}
                  />
                  <div
                    style={{
                      maxHeight: 264,
                      overflowY: "auto",
                      border: "1px solid var(--ezy-border)",
                      borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
                      backgroundColor: "var(--ezy-surface)",
                    }}
                  >
                    {filtered.length === 0 ? (
                      <div
                        style={{
                          padding: "16px 12px",
                          fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                          color: "var(--ezy-text-muted)",
                          textAlign: "center",
                        }}
                      >
                        No project matches "{search.trim()}".
                      </div>
                    ) : (
                      filtered.map((p) => {
                        const selected = p.key === selectedKey;
                        return (
                          <div
                            key={p.key}
                            onClick={() => setSelectedKey(p.key)}
                            onDoubleClick={() => {
                              setSelectedKey(p.key);
                              createProject(p.key);
                            }}
                            style={{
                              display: "flex",
                              alignItems: "baseline",
                              gap: 8,
                              padding: "7px 12px",
                              cursor: "pointer",
                              backgroundColor: selected ? "var(--ezy-accent-dim)" : "transparent",
                            }}
                          >
                            <span
                              style={{
                                fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                                fontWeight: 600,
                                color: selected ? "#fff" : "var(--ezy-text)",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {p.key}
                            </span>
                            <span
                              style={{
                                fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                                color: selected ? "rgba(255,255,255,0.75)" : "var(--ezy-text-muted)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                minWidth: 0,
                              }}
                            >
                              {p.name}
                            </span>
                          </div>
                        );
                      })
                    )}
                  </div>
                  {/* Optional CLI folder ("group") — where this project's
                      ticket panes spawn. Also manageable later in Settings →
                      Jira; skipping it falls back to the projects dir/home. */}
                  <div style={{ marginTop: 12 }}>
                    <div style={labelStyle}>CLI folder (optional)</div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <div
                        style={{
                          flex: 1,
                          minWidth: 0,
                          padding: "8px 10px",
                          fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                          color: groupPath ? "var(--ezy-text)" : "var(--ezy-text-muted)",
                          fontStyle: groupPath ? "normal" : "italic",
                          backgroundColor: "var(--ezy-surface)",
                          border: "1px solid var(--ezy-border)",
                          borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        data-tooltip={groupPath || undefined}
                      >
                        {groupPath || "No folder — panes open in the projects dir"}
                      </div>
                      <button
                        onClick={() => void browseGroupFolder()}
                        style={{ ...secondaryBtn, flexShrink: 0 }}
                      >
                        Browse
                      </button>
                    </div>
                    {groupPath && (
                      <input
                        style={{ ...inputStyle, marginTop: 6 }}
                        value={groupName}
                        onChange={(e) => setGroupName(e.target.value)}
                        placeholder="Group name (optional) — shown instead of the path"
                        spellCheck={false}
                      />
                    )}
                  </div>
                  <button
                    disabled={!selectedKey}
                    onClick={handleCreate}
                    style={primaryBtn(!!selectedKey)}
                  >
                    {selectedKey ? `Create Jira Project · ${selectedKey}` : "Create Jira Project"}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
