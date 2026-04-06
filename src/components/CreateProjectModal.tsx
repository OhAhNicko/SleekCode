import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";

interface CreateProjectModalProps {
  onCreated: (name: string, dir: string) => void;
  onClose: () => void;
}

const INVALID_CHARS = /[/\\:*?"<>|]/;

function validateName(name: string): string | null {
  if (!name) return null; // empty is not an error, just disables button
  if (INVALID_CHARS.test(name)) return "Name contains invalid characters";
  if (name === "." || name === "..") return "Invalid name";
  if (name.length > 255) return "Name is too long";
  return null;
}

export default function CreateProjectModal({ onCreated, onClose }: CreateProjectModalProps) {
  const projectsDir = useAppStore((s) => s.projectsDir);
  const defaultClaudeMdPath = useAppStore((s) => s.defaultClaudeMdPath);
  const defaultAgentsMdPath = useAppStore((s) => s.defaultAgentsMdPath);

  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [existsWarning, setExistsWarning] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const trimmed = name.trim();
  const validationError = validateName(trimmed);
  const canCreate = trimmed.length > 0 && !validationError && !creating;

  // Build full path using OS-appropriate separator
  const sep = projectsDir.includes("\\") ? "\\" : "/";
  const fullPath = trimmed ? `${projectsDir}${sep}${trimmed}` : "";

  // Auto-focus input
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Check if folder already exists (debounced)
  useEffect(() => {
    if (!trimmed || validationError) {
      setExistsWarning(false);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const entries = await invoke<{ name: string }[]>("list_dir", { path: projectsDir });
        const exists = entries.some(
          (e) => e.name.toLowerCase() === trimmed.toLowerCase()
        );
        setExistsWarning(exists);
      } catch {
        setExistsWarning(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [trimmed, projectsDir, validationError]);

  const handleCreate = useCallback(async () => {
    if (!canCreate) return;
    setCreating(true);
    setError("");
    try {
      await invoke("create_project", {
        projectDir: fullPath,
        claudeMdSource: defaultClaudeMdPath || null,
        agentsMdSource: defaultAgentsMdPath || null,
      });
      onCreated(trimmed, fullPath);
    } catch (err) {
      setError(String(err));
      setCreating(false);
    }
  }, [canCreate, fullPath, defaultClaudeMdPath, defaultAgentsMdPath, trimmed, onCreated]);

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
        paddingTop: "15vh",
        zIndex: 200,
      }}
      onClick={onClose}
    >
      <div
        style={{
          maxWidth: 440,
          width: "100%",
          backgroundColor: "var(--ezy-surface-raised)",
          border: "1px solid var(--ezy-border)",
          borderRadius: 10,
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
        <div style={{ padding: "16px" }}>
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

          {/* Validation error */}
          {validationError && (
            <div style={{ fontSize: 11, color: "#e55", marginTop: 4 }}>
              {validationError}
            </div>
          )}

          {/* Exists warning */}
          {existsWarning && !validationError && (
            <div style={{ fontSize: 11, color: "var(--ezy-text-muted)", marginTop: 4 }}>
              A folder with this name already exists — template files will be overwritten.
            </div>
          )}

          {/* Backend error */}
          {error && (
            <div style={{ fontSize: 11, color: "#e55", marginTop: 4 }}>
              {error}
            </div>
          )}

          {/* Path preview */}
          {fullPath && !validationError && (
            <div style={{
              fontSize: 11,
              color: "var(--ezy-text-muted)",
              marginTop: 8,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}>
              {fullPath}
            </div>
          )}

          {/* Template files info */}
          {(defaultClaudeMdPath || defaultAgentsMdPath) && (
            <div style={{ fontSize: 11, color: "var(--ezy-text-muted)", marginTop: 8 }}>
              {defaultClaudeMdPath && defaultAgentsMdPath
                ? "CLAUDE.md and AGENTS.md will be copied from templates."
                : defaultClaudeMdPath
                  ? "CLAUDE.md will be copied from template."
                  : "AGENTS.md will be copied from template."}
            </div>
          )}

          {/* Create button */}
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
