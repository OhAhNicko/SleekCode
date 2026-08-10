import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import LoadingDots from "./LoadingDots";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../store";
import { useModal } from "../store/modalCoordinationSlice";
import { createRemoteProject, remoteJoin } from "../lib/remote-project";
import RemoteFileBrowser from "./RemoteFileBrowser";
import ModalCloseButton from "./ModalCloseButton";
import { MODAL_BACKDROP, MODAL_MAX_HEIGHT } from "../lib/modal-layout";

interface CreateProjectModalProps {
  /** serverId is set when the project was created on a remote server. */
  onCreated: (name: string, dir: string, serverId?: string) => void;
  onClose: () => void;
}

const INVALID_CHARS = /[/\\:*?"<>|]/;

type AgentRole = "claude" | "agents" | "gemini";
type ScaffoldRole = AgentRole | "custom";

interface ScaffoldRow {
  /** Stable id for React keys + overrides. */
  key: string;
  filename: string;
  role: ScaffoldRole;
  /** Source path used for this project — defaults to the global default but can be overridden. */
  sourcePath: string;
  checked: boolean;
}

function validateName(name: string): string | null {
  if (!name) return null;
  if (INVALID_CHARS.test(name)) return "Name contains invalid characters";
  if (name === "." || name === "..") return "Invalid name";
  if (name.length > 255) return "Name is too long";
  return null;
}

function basename(path: string): string {
  if (!path) return "";
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export default function CreateProjectModal({ onCreated, onClose }: CreateProjectModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  useModal("create-project");
  const projectsDir = useAppStore((s) => s.projectsDir);
  const defaultClaudeMdPath = useAppStore((s) => s.defaultClaudeMdPath);
  const defaultAgentsMdPath = useAppStore((s) => s.defaultAgentsMdPath);
  const defaultGeminiMdPath = useAppStore((s) => s.defaultGeminiMdPath);
  const defaultUseSingleSourcePointers = useAppStore((s) => s.defaultUseSingleSourcePointers);
  const customScaffolds = useAppStore((s) => s.customScaffolds);
  const servers = useAppStore((s) => s.servers);

  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [existsWarning, setExistsWarning] = useState(false);
  // "local" or a RemoteServer id.
  const [locationId, setLocationId] = useState<string>("local");
  const [remoteParent, setRemoteParent] = useState("");
  const [showRemoteBrowser, setShowRemoteBrowser] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const remoteServer = locationId === "local" ? null : servers.find((s) => s.id === locationId) ?? null;
  const remoteServerHasKey = !!(remoteServer && remoteServer.authMethod === "ssh-key" && remoteServer.sshKeyPath);

  const pickLocation = (id: string) => {
    setLocationId(id);
    setError("");
    if (id !== "local") {
      const sv = servers.find((s) => s.id === id);
      setRemoteParent(sv?.projectsDir || "");
    }
  };

  // Build initial scaffold rows from settings. Rebuilt only when defaults/customs change.
  const [rows, setRows] = useState<ScaffoldRow[]>(() =>
    buildInitialRows(
      defaultClaudeMdPath,
      defaultAgentsMdPath,
      defaultGeminiMdPath,
      customScaffolds,
    ),
  );
  const [singleSource, setSingleSource] = useState(defaultUseSingleSourcePointers);

  // If the user opens Settings and changes defaults while the modal is open, refresh rows.
  useEffect(() => {
    setRows(
      buildInitialRows(
        defaultClaudeMdPath,
        defaultAgentsMdPath,
        defaultGeminiMdPath,
        customScaffolds,
      ),
    );
  }, [defaultClaudeMdPath, defaultAgentsMdPath, defaultGeminiMdPath, customScaffolds]);

  const trimmed = name.trim();
  const validationError = validateName(trimmed);

  const isRemote = remoteServer !== null;
  const remoteParentTrimmed = remoteParent.trim();
  const remoteParentOk = remoteParentTrimmed.startsWith("/");
  const sep = projectsDir.includes("\\") ? "\\" : "/";
  const fullPath = !trimmed
    ? ""
    : isRemote
      ? remoteParentOk
        ? remoteJoin(remoteParentTrimmed, trimmed)
        : ""
      : `${projectsDir}${sep}${trimmed}`;

  const agentsRow = useMemo(() => rows.find((r) => r.role === "agents"), [rows]);
  const agentsHasSource = !!agentsRow?.sourcePath;
  const singleSourceBlocked = singleSource && (!agentsRow?.checked || !agentsHasSource);

  const localBlocked = !isRemote && !projectsDir;
  const remoteBlocked = isRemote && (!remoteParentOk || !remoteServerHasKey);
  const canCreate =
    trimmed.length > 0 &&
    !validationError &&
    !creating &&
    !singleSourceBlocked &&
    !localBlocked &&
    !remoteBlocked;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!trimmed || validationError) {
      setExistsWarning(false);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        if (isRemote) {
          if (!remoteServer || !remoteParentOk) {
            setExistsWarning(false);
            return;
          }
          const entries = await invoke<string[]>("ssh_ls", {
            host: remoteServer.host,
            username: remoteServer.username,
            path: remoteParentTrimmed,
            identityFile: remoteServerHasKey ? remoteServer.sshKeyPath : null,
          });
          const exists = entries.some(
            (e) => e.replace(/\/$/, "").toLowerCase() === trimmed.toLowerCase(),
          );
          setExistsWarning(exists);
        } else {
          const entries = await invoke<{ name: string }[]>("list_dir", { path: projectsDir });
          const exists = entries.some((e) => e.name.toLowerCase() === trimmed.toLowerCase());
          setExistsWarning(exists);
        }
      } catch {
        setExistsWarning(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [trimmed, projectsDir, validationError, isRemote, remoteServer, remoteParentTrimmed, remoteParentOk, remoteServerHasKey]);

  // When pointer mode flips on, force-check AGENTS.md.
  useEffect(() => {
    if (!singleSource) return;
    setRows((prev) =>
      prev.map((r) => (r.role === "agents" ? { ...r, checked: true } : r)),
    );
  }, [singleSource]);

  const toggleRow = (key: string) => {
    setRows((prev) =>
      prev.map((r) => {
        if (r.key !== key) return r;
        // In pointer mode, AGENTS.md cannot be unchecked.
        if (singleSource && r.role === "agents") return r;
        return { ...r, checked: !r.checked };
      }),
    );
  };

  const browseRow = async (key: string) => {
    try {
      const selected = await openDialog({
        directory: false,
        multiple: false,
        title: "Select template file",
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (selected && typeof selected === "string") {
        setRows((prev) =>
          prev.map((r) => (r.key === key ? { ...r, sourcePath: selected, checked: true } : r)),
        );
      }
    } catch {
      /* cancelled */
    }
  };

  const handleCreate = useCallback(async () => {
    if (!canCreate) return;
    setCreating(true);
    setError("");
    try {
      const scaffolds = rows
        .filter((r) => r.checked && r.filename.length > 0)
        .map((r) => ({
          filename: r.filename,
          source: r.sourcePath || null,
          role: r.role,
        }));
      if (remoteServer) {
        await createRemoteProject(remoteServer, fullPath, scaffolds, singleSource);
        onCreated(trimmed, fullPath, remoteServer.id);
      } else {
        await invoke("create_project", {
          projectDir: fullPath,
          scaffolds,
          singleSourcePointers: singleSource,
        });
        onCreated(trimmed, fullPath);
      }
    } catch (err) {
      setError(String(err));
      setCreating(false);
    }
  }, [canCreate, fullPath, rows, singleSource, trimmed, onCreated, remoteServer]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && canCreate) {
        e.preventDefault();
        handleCreate();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [canCreate, handleCreate, onClose],
  );

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
        ref={overlayRef}
        style={{
          maxWidth: 520,
          width: "100%",
          backgroundColor: "var(--ezy-surface-raised)",
          border: "1px solid var(--ezy-border)",
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 10px)",
          overflow: "hidden",
          boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
          // FIXED height, not `maxHeight`. Under `align-items: center` an
          // auto-height panel grows in BOTH directions, so every line that
          // appears while typing — the path preview, the exists warning —
          // moved the whole dialog out from under the pointer. A constant
          // height is the only thing that holds it still across all of them.
          //
          // Scaled by the font token because the content is text, and clamped
          // by the shared 68vh ceiling so a short window scrolls the body
          // instead of overflowing off the top (see modal-layout.ts).
          //
          // 500 was measured, not guessed: it is the natural height of the
          // fullest ordinary case — servers configured, a name typed, three
          // scaffold rows — with a little slack. Configurations beyond that
          // (many custom scaffolds, several servers) scroll the body, which is
          // the deal a fixed height makes.
          height: `min(calc(var(--ezy-font-scale, 1) * 500px), ${MODAL_MAX_HEIGHT})`,
          display: "flex",
          flexDirection: "column",
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
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 13px)", fontWeight: 600, color: "var(--ezy-text)" }}>
            Create New Project
          </span>
          <ModalCloseButton onClose={onClose} />
        </div>

        {/* Body — the only scrolling region. `flex: 1` + `minHeight: 0` are
            both load-bearing: a flex child defaults to `min-height: auto` and
            refuses to shrink below its content, so `overflowY` alone never
            scrolls. */}
        <div style={{ padding: "16px", flex: 1, minHeight: 0, overflowY: "auto" }}>
          {/* Location — local machine or one of the configured servers */}
          {servers.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 11px)", color: "var(--ezy-text-muted)", marginBottom: 6, fontWeight: 500 }}>
                Location
              </div>
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
              {isRemote && !remoteServerHasKey && (
                <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 11px)", color: "#e55", marginTop: 6 }}>
                  This server needs a working SSH key first — set one up in the Servers panel.
                </div>
              )}
            </div>
          )}

          {/* Remote parent directory */}
          {isRemote && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 11px)", color: "var(--ezy-text-muted)", marginBottom: 6, fontWeight: 500 }}>
                Parent directory on {remoteServer?.name}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  type="text"
                  value={remoteParent}
                  onChange={(e) => setRemoteParent(e.target.value)}
                  placeholder="/home/user/projects"
                  spellCheck={false}
                  style={{
                    flex: 1,
                    padding: "8px 10px",
                    fontSize: "calc(var(--ezy-font-scale, 1) * 13px)",
                    color: "var(--ezy-text)",
                    backgroundColor: "var(--ezy-surface)",
                    border: "1px solid var(--ezy-border)",
                    borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
                    outline: "none",
                    fontFamily: "inherit",
                    boxSizing: "border-box",
                    minWidth: 0,
                  }}
                />
                <button
                  onClick={() => setShowRemoteBrowser(true)}
                  disabled={!remoteServerHasKey}
                  style={{
                    padding: "3px 12px",
                    fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                    fontWeight: 500,
                    color: "var(--ezy-text-secondary)",
                    backgroundColor: "var(--ezy-surface-raised)",
                    border: "1px solid var(--ezy-border)",
                    borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
                    cursor: remoteServerHasKey ? "pointer" : "not-allowed",
                    opacity: remoteServerHasKey ? 1 : 0.5,
                    fontFamily: "inherit",
                    flexShrink: 0,
                  }}
                >
                  Browse
                </button>
              </div>
              {remoteParentTrimmed.length > 0 && !remoteParentOk && (
                <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 11px)", color: "#e55", marginTop: 4 }}>
                  Use an absolute path starting with / (no ~).
                </div>
              )}
            </div>
          )}

          {localBlocked && (
            <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 11px)", color: "var(--ezy-text-muted)", marginBottom: 12 }}>
              Set a projects directory in Settings to create local projects
              {servers.length > 0 ? ", or pick a server above." : "."}
            </div>
          )}

          <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 11px)", color: "var(--ezy-text-muted)", marginBottom: 6, fontWeight: 500 }}>
            Project Name
          </div>
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError("");
            }}
            onKeyDown={handleKeyDown}
            placeholder="my-project"
            style={{
              width: "100%",
              padding: "8px 10px",
              fontSize: "calc(var(--ezy-font-scale, 1) * 13px)",
              color: "var(--ezy-text)",
              backgroundColor: "var(--ezy-surface)",
              border: `1px solid ${validationError ? "#e55" : "var(--ezy-border)"}`,
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
              outline: "none",
              fontFamily: "inherit",
              boxSizing: "border-box",
            }}
          />

          {/* Reserved slot for everything the name field can say.
              These three lines used to mount and unmount as you typed, which
              is what made the panel breathe. The slot is always here at a
              constant height, so the scaffold section below never moves —
              44px is the measured height of the tallest combination, a
              one-line warning plus the path. The warning copy is kept short
              enough to stay on one line at a raised font scale. */}
          <div style={{ height: "calc(var(--ezy-font-scale, 1) * 44px)", overflow: "hidden" }}>
            {validationError ? (
              <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 11px)", color: "#e55", marginTop: 4, lineHeight: 1.35 }}>
                {validationError}
              </div>
            ) : existsWarning ? (
              <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 11px)", color: "var(--ezy-text-muted)", marginTop: 4, lineHeight: 1.35 }}>
                This folder exists — scaffold files will overwrite it.
              </div>
            ) : null}

            {fullPath && !validationError && (
              <div
                style={{
                  fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                  color: "var(--ezy-text-muted)",
                  marginTop: 8,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {fullPath}
              </div>
            )}
          </div>

          {/* Scaffold section — 8, not 16: the reserved slot above already
              supplies the separation whether or not it has anything to say. */}
          <div style={{ marginTop: 8 }}>
            <div
              style={{
                fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                color: "var(--ezy-text-muted)",
                fontWeight: 500,
                marginBottom: 6,
              }}
            >
              Scaffold files
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {rows.map((row) => (
                <ScaffoldRowView
                  key={row.key}
                  row={row}
                  pointerMode={singleSource}
                  onToggle={() => toggleRow(row.key)}
                  onBrowse={() => browseRow(row.key)}
                />
              ))}
            </div>

            <label
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                marginTop: 12,
                padding: "8px 10px",
                border: "1px solid var(--ezy-border)",
                borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
                backgroundColor: "var(--ezy-surface)",
                cursor: "pointer",
                userSelect: "none",
              }}
            >
              <input
                type="checkbox"
                checked={singleSource}
                onChange={(e) => setSingleSource(e.target.checked)}
                style={{ marginTop: 2 }}
              />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-text)" }}>
                  Single source + pointers
                </div>
                <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 11px)", color: "var(--ezy-text-muted)", marginTop: 2, lineHeight: 1.3 }}>
                  AGENTS.md holds the canonical instructions. CLAUDE.md and GEMINI.md (if checked) are written as small pointer files that reference it.
                </div>
              </div>
            </label>

            {singleSource && !agentsHasSource && (
              <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 11px)", color: "#e55", marginTop: 6 }}>
                AGENTS.md needs a template path to use single-source mode. Set one in Settings or click Browse on the AGENTS.md row.
              </div>
            )}
          </div>

          {error && (
            <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 11px)", color: "#e55", marginTop: 8 }}>{error}</div>
          )}
        </div>

        {/* Footer — pinned, like RemoteFileBrowser's. Inside the scroll region
            the primary action could be scrolled out of reach the moment the
            body overflows, which a fixed-height panel makes routine. */}
        <div
          style={{
            padding: "12px 16px",
            borderTop: "1px solid var(--ezy-border)",
            backgroundColor: "var(--ezy-surface)",
            flexShrink: 0,
          }}
        >
          <button
            disabled={!canCreate}
            onClick={handleCreate}
            style={{
              width: "100%",
              padding: "8px 0",
              fontSize: "calc(var(--ezy-font-scale, 1) * 13px)",
              fontWeight: 600,
              color: canCreate ? "#fff" : "var(--ezy-text-muted)",
              backgroundColor: canCreate ? "var(--ezy-accent)" : "var(--ezy-surface-raised)",
              border: canCreate ? "none" : "1px solid var(--ezy-border)",
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
              cursor: canCreate ? "pointer" : "not-allowed",
              fontFamily: "inherit",
              transition: "background-color 150ms ease",
            }}
          >
            {creating ? <LoadingDots>Creating</LoadingDots> : "Create Project"}
          </button>
        </div>
      </div>
    </div>
    {showRemoteBrowser && remoteServer && (
      <RemoteFileBrowser
        server={remoteServer}
        initialPath={remoteParentOk ? remoteParentTrimmed : undefined}
        onSelect={(p) => {
          setRemoteParent(p);
          setShowRemoteBrowser(false);
        }}
        onClose={() => setShowRemoteBrowser(false)}
      />
    )}
    </>
  );
}

function buildInitialRows(
  claudePath: string,
  agentsPath: string,
  geminiPath: string,
  customs: { id: string; filename: string; templatePath: string; enabledByDefault: boolean }[],
): ScaffoldRow[] {
  const builtIn: ScaffoldRow[] = [
    {
      key: "builtin-claude",
      filename: "CLAUDE.md",
      role: "claude",
      sourcePath: claudePath,
      checked: !!claudePath,
    },
    {
      key: "builtin-agents",
      filename: "AGENTS.md",
      role: "agents",
      sourcePath: agentsPath,
      checked: !!agentsPath,
    },
    {
      key: "builtin-gemini",
      filename: "GEMINI.md",
      role: "gemini",
      sourcePath: geminiPath,
      checked: !!geminiPath,
    },
  ];

  const validCustoms = customs
    .filter((c) => c.filename.trim().length > 0 && !INVALID_CHARS.test(c.filename))
    .map<ScaffoldRow>((c) => ({
      key: `custom-${c.id}`,
      filename: c.filename.trim(),
      role: "custom",
      sourcePath: c.templatePath,
      checked: c.enabledByDefault,
    }))
    .sort((a, b) => a.filename.localeCompare(b.filename));

  return [...builtIn, ...validCustoms];
}

function ScaffoldRowView({
  row,
  pointerMode,
  onToggle,
  onBrowse,
}: {
  row: ScaffoldRow;
  pointerMode: boolean;
  onToggle: () => void;
  onBrowse: () => void;
}) {
  const isAgents = row.role === "agents";
  const isAgent = row.role === "claude" || row.role === "agents" || row.role === "gemini";
  const willBePointer = pointerMode && isAgent && !isAgents && row.checked;
  const disabled = pointerMode && isAgents;

  const hint = !row.sourcePath
    ? "no template — file will be empty"
    : willBePointer
      ? "will be a pointer to AGENTS.md"
      : basename(row.sourcePath);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 8px",
        borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
        backgroundColor: row.checked ? "var(--ezy-surface)" : "transparent",
        border: "1px solid",
        borderColor: row.checked ? "var(--ezy-border)" : "transparent",
      }}
    >
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flex: 1,
          minWidth: 0,
          cursor: disabled ? "default" : "pointer",
          userSelect: "none",
        }}
      >
        <input
          type="checkbox"
          checked={row.checked}
          onChange={onToggle}
          disabled={disabled}
        />
        <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-text)", flexShrink: 0 }}>
          {row.filename}
        </span>
        {row.role === "custom" && (
          <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 10px)", color: "var(--ezy-text-muted)", flexShrink: 0 }}>
            (custom)
          </span>
        )}
        <span
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
            color: willBePointer ? "var(--ezy-text-secondary)" : "var(--ezy-text-muted)",
            fontStyle: row.sourcePath ? "normal" : "italic",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
          data-tooltip={row.sourcePath || undefined}
        >
          {hint}
        </span>
      </label>
      <button
        onClick={onBrowse}
        style={{
          padding: "3px 10px",
          fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
          fontWeight: 500,
          color: "var(--ezy-text-secondary)",
          backgroundColor: "var(--ezy-surface-raised)",
          border: "1px solid var(--ezy-border)",
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
          cursor: "pointer",
          fontFamily: "inherit",
          flexShrink: 0,
        }}
      >
        Browse
      </button>
    </div>
  );
}
