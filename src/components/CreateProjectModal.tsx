import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../store";

interface CreateProjectModalProps {
  onCreated: (name: string, dir: string) => void;
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
  const projectsDir = useAppStore((s) => s.projectsDir);
  const defaultClaudeMdPath = useAppStore((s) => s.defaultClaudeMdPath);
  const defaultAgentsMdPath = useAppStore((s) => s.defaultAgentsMdPath);
  const defaultGeminiMdPath = useAppStore((s) => s.defaultGeminiMdPath);
  const defaultUseSingleSourcePointers = useAppStore((s) => s.defaultUseSingleSourcePointers);
  const customScaffolds = useAppStore((s) => s.customScaffolds);

  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [existsWarning, setExistsWarning] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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

  const sep = projectsDir.includes("\\") ? "\\" : "/";
  const fullPath = trimmed ? `${projectsDir}${sep}${trimmed}` : "";

  const agentsRow = useMemo(() => rows.find((r) => r.role === "agents"), [rows]);
  const agentsHasSource = !!agentsRow?.sourcePath;
  const singleSourceBlocked = singleSource && (!agentsRow?.checked || !agentsHasSource);

  const canCreate =
    trimmed.length > 0 && !validationError && !creating && !singleSourceBlocked;

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
        const entries = await invoke<{ name: string }[]>("list_dir", { path: projectsDir });
        const exists = entries.some((e) => e.name.toLowerCase() === trimmed.toLowerCase());
        setExistsWarning(exists);
      } catch {
        setExistsWarning(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [trimmed, projectsDir, validationError]);

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
      await invoke("create_project", {
        projectDir: fullPath,
        scaffolds,
        singleSourcePointers: singleSource,
      });
      onCreated(trimmed, fullPath);
    } catch (err) {
      setError(String(err));
      setCreating(false);
    }
  }, [canCreate, fullPath, rows, singleSource, trimmed, onCreated]);

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
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "12vh",
        zIndex: 200,
      }}
      onClick={onClose}
    >
      <div
        style={{
          maxWidth: 520,
          width: "100%",
          backgroundColor: "var(--ezy-surface-raised)",
          border: "1px solid var(--ezy-border)",
          borderRadius: 10,
          overflow: "hidden",
          boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
          maxHeight: "80vh",
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
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ezy-text)" }}>
            Create New Project
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
        <div style={{ padding: "16px", overflowY: "auto" }}>
          <div style={{ fontSize: 11, color: "var(--ezy-text-muted)", marginBottom: 6, fontWeight: 500 }}>
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
              fontSize: 13,
              color: "var(--ezy-text)",
              backgroundColor: "var(--ezy-surface)",
              border: `1px solid ${validationError ? "#e55" : "var(--ezy-border)"}`,
              borderRadius: 6,
              outline: "none",
              fontFamily: "inherit",
              boxSizing: "border-box",
            }}
          />

          {validationError && (
            <div style={{ fontSize: 11, color: "#e55", marginTop: 4 }}>{validationError}</div>
          )}

          {existsWarning && !validationError && (
            <div style={{ fontSize: 11, color: "var(--ezy-text-muted)", marginTop: 4 }}>
              A folder with this name already exists — scaffold files will overwrite existing ones.
            </div>
          )}

          {fullPath && !validationError && (
            <div
              style={{
                fontSize: 11,
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

          {/* Scaffold section */}
          <div style={{ marginTop: 16 }}>
            <div
              style={{
                fontSize: 11,
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
                borderRadius: 6,
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
                <div style={{ fontSize: 12, color: "var(--ezy-text)" }}>
                  Single source + pointers
                </div>
                <div style={{ fontSize: 11, color: "var(--ezy-text-muted)", marginTop: 2, lineHeight: 1.3 }}>
                  AGENTS.md holds the canonical instructions. CLAUDE.md and GEMINI.md (if checked) are written as small pointer files that reference it.
                </div>
              </div>
            </label>

            {singleSource && !agentsHasSource && (
              <div style={{ fontSize: 11, color: "#e55", marginTop: 6 }}>
                AGENTS.md needs a template path to use single-source mode. Set one in Settings or click Browse on the AGENTS.md row.
              </div>
            )}
          </div>

          {error && (
            <div style={{ fontSize: 11, color: "#e55", marginTop: 8 }}>{error}</div>
          )}

          <button
            disabled={!canCreate}
            onClick={handleCreate}
            style={{
              marginTop: 16,
              width: "100%",
              padding: "8px 0",
              fontSize: 13,
              fontWeight: 600,
              color: canCreate ? "#fff" : "var(--ezy-text-muted)",
              backgroundColor: canCreate ? "var(--ezy-accent)" : "var(--ezy-surface)",
              border: canCreate ? "none" : "1px solid var(--ezy-border)",
              borderRadius: 6,
              cursor: canCreate ? "pointer" : "not-allowed",
              fontFamily: "inherit",
              transition: "background-color 150ms ease",
            }}
          >
            {creating ? "Creating..." : "Create Project"}
          </button>
        </div>
      </div>
    </div>
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
        borderRadius: 6,
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
        <span style={{ fontSize: 12, color: "var(--ezy-text)", flexShrink: 0 }}>
          {row.filename}
        </span>
        {row.role === "custom" && (
          <span style={{ fontSize: 10, color: "var(--ezy-text-muted)", flexShrink: 0 }}>
            (custom)
          </span>
        )}
        <span
          style={{
            fontSize: 11,
            color: willBePointer ? "var(--ezy-text-secondary)" : "var(--ezy-text-muted)",
            fontStyle: row.sourcePath ? "normal" : "italic",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
          title={row.sourcePath || undefined}
        >
          {hint}
        </span>
      </label>
      <button
        onClick={onBrowse}
        style={{
          padding: "3px 10px",
          fontSize: 11,
          fontWeight: 500,
          color: "var(--ezy-text-secondary)",
          backgroundColor: "var(--ezy-surface-raised)",
          border: "1px solid var(--ezy-border)",
          borderRadius: 5,
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
