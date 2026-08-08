import { useState, useCallback, useEffect } from "react";
import LoadingDots from "./LoadingDots";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../store";
import { useModal } from "../store/modalCoordinationSlice";
import { createJiraProjectAt, jiraFileExists } from "../lib/jira-project";
import { defaultJiraSiteIn } from "../lib/jira-sites";
import { jiraSiteName } from "../lib/jira";
import RemoteFileBrowser from "./RemoteFileBrowser";
import { MODAL_BACKDROP } from "../lib/modal-layout";

/**
 * New Jira Project — pick the source folder (local or on a remote server) the
 * tickets run against, optionally seeding it with the Jira CLAUDE.md template.
 * The template is NEVER written over an existing CLAUDE.md: Jira projects
 * point at existing repos, so the modal pre-checks and disables the option
 * when the file is already there.
 */
export default function JiraProjectModal({ onClose }: { onClose: () => void }) {
  useModal("jira-project-modal");
  const servers = useAppStore((s) => s.servers);
  const jiraTemplatePath = useAppStore((s) => s.defaultJiraClaudeMdPath);
  const jiraSites = useAppStore((s) => s.jiraSites ?? []);

  // "local" or a RemoteServer id.
  const [locationId, setLocationId] = useState<string>("local");
  const [siteId, setSiteId] = useState<string>(() => defaultJiraSiteIn(useAppStore.getState()));
  const [folder, setFolder] = useState("");
  const [showRemoteBrowser, setShowRemoteBrowser] = useState(false);
  const [addTemplate, setAddTemplate] = useState(!!jiraTemplatePath);
  const [hasExistingClaudeMd, setHasExistingClaudeMd] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const remoteServer = locationId === "local" ? null : servers.find((s) => s.id === locationId) ?? null;
  const remoteServerHasKey = !!(remoteServer && remoteServer.authMethod === "ssh-key" && remoteServer.sshKeyPath);

  const pickLocation = (id: string) => {
    setLocationId(id);
    setFolder("");
    setHasExistingClaudeMd(false);
    setError("");
  };

  // Pre-check for an existing CLAUDE.md so "skip existing" is visible BEFORE
  // creating, not a surprise afterwards.
  useEffect(() => {
    if (!folder || !jiraTemplatePath) {
      setHasExistingClaudeMd(false);
      return;
    }
    let cancelled = false;
    jiraFileExists(folder, "CLAUDE.md", remoteServer).then((exists) => {
      if (!cancelled) setHasExistingClaudeMd(exists);
    });
    return () => {
      cancelled = true;
    };
  }, [folder, jiraTemplatePath, remoteServer]);

  const browseLocal = useCallback(async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "Select the source folder for this Jira project",
      });
      if (typeof picked === "string") {
        setFolder(picked);
        setError("");
      }
    } catch {
      /* cancelled */
    }
  }, []);

  const canCreate = !!folder && !creating && (!remoteServer || remoteServerHasKey);

  const handleCreate = useCallback(async () => {
    if (!canCreate) return;
    setCreating(true);
    setError("");
    try {
      await createJiraProjectAt({
        path: folder,
        serverId: remoteServer?.id,
        claudeTemplatePath:
          addTemplate && jiraTemplatePath && !hasExistingClaudeMd ? jiraTemplatePath : undefined,
        siteId: siteId || undefined,
      });
      onClose();
    } catch (e) {
      setError(String(e));
      setCreating(false);
    }
  }, [canCreate, folder, remoteServer, addTemplate, jiraTemplatePath, hasExistingClaudeMd, siteId, onClose]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const labelStyle: React.CSSProperties = {
    fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
    color: "var(--ezy-text-muted)",
    marginBottom: 6,
    fontWeight: 500,
  };

  return (
    <>
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
            backgroundColor: "var(--ezy-surface-raised)",
            border: "1px solid var(--ezy-border)",
            borderRadius: "calc(var(--ezy-radius-scale, 1) * 10px)",
            overflow: "hidden",
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
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="var(--ezy-text-muted)"
              strokeWidth="1.5"
              strokeLinecap="round"
              style={{ cursor: "pointer" }}
              onClick={onClose}
            >
              <line x1="4" y1="4" x2="12" y2="12" />
              <line x1="12" y1="4" x2="4" y2="12" />
            </svg>
          </div>

          {/* Body */}
          <div style={{ padding: 16 }}>
            {/* Location */}
            {servers.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={labelStyle}>Location</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {[{ id: "local", label: "This computer" }, ...servers.map((s) => ({ id: s.id, label: s.name }))].map(
                    (loc) => (
                      <div
                        key={loc.id}
                        onClick={() => pickLocation(loc.id)}
                        style={{
                          padding: "5px 12px",
                          fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                          fontWeight: 600,
                          borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
                          cursor: "pointer",
                          color: locationId === loc.id ? "#fff" : "var(--ezy-text-muted)",
                          backgroundColor: locationId === loc.id ? "var(--ezy-accent-dim)" : "var(--ezy-surface)",
                          border: `1px solid ${locationId === loc.id ? "var(--ezy-accent-dim)" : "var(--ezy-border)"}`,
                          transition: "all 120ms ease",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {loc.label}
                      </div>
                    ),
                  )}
                </div>
                {remoteServer && !remoteServerHasKey && (
                  <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 11px)", color: "#e55", marginTop: 6 }}>
                    This server needs a working SSH key first — set one up in the Servers panel.
                  </div>
                )}
              </div>
            )}

            {/* Jira site — only when there is a real choice to make. One site
                per project; new tickets in this project open on it. */}
            {jiraSites.length > 1 && (
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
                </div>
              </div>
            )}

            {/* Source folder */}
            <div style={{ marginBottom: 14 }}>
              <div style={labelStyle}>
                Source folder{remoteServer ? ` on ${remoteServer.name}` : ""}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <div
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: "8px 10px",
                    fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                    color: folder ? "var(--ezy-text)" : "var(--ezy-text-muted)",
                    fontStyle: folder ? "normal" : "italic",
                    backgroundColor: "var(--ezy-surface)",
                    border: "1px solid var(--ezy-border)",
                    borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  data-tooltip={folder || undefined}
                >
                  {folder || "No folder selected"}
                </div>
                <button
                  onClick={() => (remoteServer ? setShowRemoteBrowser(true) : void browseLocal())}
                  disabled={!!remoteServer && !remoteServerHasKey}
                  style={{
                    padding: "3px 12px",
                    fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                    fontWeight: 500,
                    color: "var(--ezy-text-secondary)",
                    backgroundColor: "var(--ezy-surface-raised)",
                    border: "1px solid var(--ezy-border)",
                    borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
                    cursor: remoteServer && !remoteServerHasKey ? "not-allowed" : "pointer",
                    opacity: remoteServer && !remoteServerHasKey ? 0.5 : 1,
                    fontFamily: "inherit",
                    flexShrink: 0,
                  }}
                >
                  Browse
                </button>
              </div>
            </div>

            {/* Jira CLAUDE.md template */}
            {jiraTemplatePath ? (
              <label
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  padding: "8px 10px",
                  border: "1px solid var(--ezy-border)",
                  borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
                  backgroundColor: "var(--ezy-surface)",
                  cursor: hasExistingClaudeMd ? "default" : "pointer",
                  userSelect: "none",
                  opacity: hasExistingClaudeMd ? 0.6 : 1,
                }}
              >
                <input
                  type="checkbox"
                  checked={addTemplate && !hasExistingClaudeMd}
                  disabled={hasExistingClaudeMd}
                  onChange={(e) => setAddTemplate(e.target.checked)}
                  style={{ marginTop: 2 }}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-text)" }}>
                    Add CLAUDE.md from the Jira template
                  </div>
                  <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 11px)", color: "var(--ezy-text-muted)", marginTop: 2, lineHeight: 1.3 }}>
                    {hasExistingClaudeMd
                      ? "This folder already has a CLAUDE.md — it stays untouched."
                      : "Copied into the source folder so Jira panes get Jira-specific guidelines."}
                  </div>
                </div>
              </label>
            ) : (
              <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 11px)", color: "var(--ezy-text-muted)" }}>
                Tip: set a "Default Jira CLAUDE.md" in Settings → Jira to seed Jira projects with
                their own guidelines.
              </div>
            )}

            {error && <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 11px)", color: "#e55", marginTop: 10 }}>{error}</div>}

            <button
              disabled={!canCreate}
              onClick={handleCreate}
              style={{
                marginTop: 16,
                width: "100%",
                padding: "8px 0",
                fontSize: "calc(var(--ezy-font-scale, 1) * 13px)",
                fontWeight: 600,
                color: canCreate ? "#fff" : "var(--ezy-text-muted)",
                backgroundColor: canCreate ? "var(--ezy-accent)" : "var(--ezy-surface)",
                border: canCreate ? "none" : "1px solid var(--ezy-border)",
                borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
                cursor: canCreate ? "pointer" : "not-allowed",
                fontFamily: "inherit",
                transition: "background-color 150ms ease",
              }}
            >
              {creating ? <LoadingDots>Creating</LoadingDots> : "Create Jira Project"}
            </button>
          </div>
        </div>
      </div>
      {showRemoteBrowser && remoteServer && (
        <RemoteFileBrowser
          server={remoteServer}
          initialPath={remoteServer.projectsDir?.startsWith("/") ? remoteServer.projectsDir : undefined}
          onSelect={(p) => {
            setFolder(p);
            setShowRemoteBrowser(false);
          }}
          onClose={() => setShowRemoteBrowser(false)}
        />
      )}
    </>
  );
}
