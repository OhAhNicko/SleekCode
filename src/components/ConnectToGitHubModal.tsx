import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

interface GhStatus {
  installed: boolean;
  authed: boolean;
  user: string | null;
  platform: "wsl" | "windows" | "macos" | "linux";
}

interface GhCreateRepoResult {
  url: string;
  output: string;
}

interface ConnectToGitHubModalProps {
  workingDir: string;
  /** Default repo name — typically the project folder's basename. */
  defaultName: string;
  onClose: () => void;
  onConnected: (url: string) => void;
}

type Phase = "checking" | "not-installed" | "not-authed" | "ready" | "creating" | "error";

const INSTALL_INSTRUCTIONS: Record<GhStatus["platform"], { label: string; command: string; help?: string }> = {
  windows: { label: "Windows (winget)", command: "winget install --id GitHub.cli" },
  macos: { label: "macOS (Homebrew)", command: "brew install gh" },
  linux: { label: "Linux", command: "sudo apt install gh", help: "Or see cli.github.com for your distribution." },
  wsl: { label: "WSL (Ubuntu/Debian)", command: "sudo apt install gh", help: "Install inside your WSL distro, not on Windows." },
};

const REPO_NAME_RE = /^[A-Za-z0-9_.-]+$/;

export default function ConnectToGitHubModal({
  workingDir,
  defaultName,
  onClose,
  onConnected,
}: ConnectToGitHubModalProps) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [status, setStatus] = useState<GhStatus | null>(null);
  const [fatalError, setFatalError] = useState("");
  const [createError, setCreateError] = useState("");

  const [name, setName] = useState(defaultName);
  const [visibility, setVisibility] = useState<"public" | "private">("private");
  const [description, setDescription] = useState("");
  const [push, setPush] = useState(true);

  const nameRef = useRef<HTMLInputElement>(null);

  const runStatusCheck = useCallback(async () => {
    setPhase("checking");
    setFatalError("");
    try {
      const s = await invoke<GhStatus>("gh_status", { directory: workingDir });
      setStatus(s);
      if (!s.installed) setPhase("not-installed");
      else if (!s.authed) setPhase("not-authed");
      else setPhase("ready");
    } catch (err) {
      setFatalError(String(err));
      setPhase("error");
    }
  }, [workingDir]);

  useEffect(() => {
    runStatusCheck();
  }, [runStatusCheck]);

  useEffect(() => {
    if (phase === "ready") nameRef.current?.focus();
  }, [phase]);

  // Escape closes
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const trimmedName = name.trim();
  const nameInvalid = trimmedName.length > 0 && !REPO_NAME_RE.test(trimmedName);
  const canCreate = phase === "ready" && trimmedName.length > 0 && !nameInvalid;

  const handleCreate = useCallback(async () => {
    if (!canCreate) return;
    setPhase("creating");
    setCreateError("");
    try {
      const result = await invoke<GhCreateRepoResult>("gh_create_repo", {
        directory: workingDir,
        name: trimmedName,
        visibility,
        description: description.trim() || null,
        push,
      });
      onConnected(result.url);
    } catch (err) {
      setCreateError(String(err));
      setPhase("ready");
    }
  }, [canCreate, workingDir, trimmedName, visibility, description, push, onConnected]);

  const copyToClipboard = useCallback((text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
  }, []);

  const install = status ? INSTALL_INSTRUCTIONS[status.platform] : INSTALL_INSTRUCTIONS.linux;

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
          maxWidth: 480,
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
            height: 36,
            padding: "0 16px",
            borderBottom: "1px solid var(--ezy-border)",
            backgroundColor: "var(--ezy-surface)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="var(--ezy-text)" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 005.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ezy-text)" }}>
              Connect to GitHub
            </span>
          </div>
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
          {phase === "checking" && (
            <div style={{ fontSize: 12, color: "var(--ezy-text-muted)", padding: "8px 0" }}>
              Checking for the GitHub CLI...
            </div>
          )}

          {phase === "error" && (
            <>
              <div style={{ fontSize: 12, color: "var(--ezy-red, #e55)", marginBottom: 10 }}>
                {fatalError}
              </div>
              <button
                onClick={runStatusCheck}
                style={buttonStyle(true, false)}
              >
                Retry
              </button>
            </>
          )}

          {phase === "not-installed" && status && (
            <>
              <div style={{ fontSize: 13, color: "var(--ezy-text)", marginBottom: 6, fontWeight: 500 }}>
                GitHub CLI is not installed
              </div>
              <div style={{ fontSize: 12, color: "var(--ezy-text-secondary)", marginBottom: 12, lineHeight: 1.5 }}>
                EzyDev uses the <code style={inlineCodeStyle}>gh</code> CLI to create a repository and push your code
                without storing any GitHub credentials inside the app.
              </div>
              <div style={{ fontSize: 11, color: "var(--ezy-text-muted)", marginBottom: 4, fontWeight: 500 }}>
                Install command ({install.label})
              </div>
              <CommandRow command={install.command} onCopy={() => copyToClipboard(install.command)} />
              {install.help && (
                <div style={{ fontSize: 11, color: "var(--ezy-text-muted)", marginTop: 6 }}>
                  {install.help}
                </div>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <button onClick={runStatusCheck} style={buttonStyle(true, false)}>
                  Check again
                </button>
                <button onClick={onClose} style={buttonStyle(false, false)}>
                  Cancel
                </button>
              </div>
            </>
          )}

          {phase === "not-authed" && (
            <>
              <div style={{ fontSize: 13, color: "var(--ezy-text)", marginBottom: 6, fontWeight: 500 }}>
                Sign in to GitHub
              </div>
              <div style={{ fontSize: 12, color: "var(--ezy-text-secondary)", marginBottom: 12, lineHeight: 1.5 }}>
                The <code style={inlineCodeStyle}>gh</code> CLI is installed but not signed in. Run this in your terminal —
                it will open a browser for OAuth device login.
              </div>
              <CommandRow command="gh auth login" onCopy={() => copyToClipboard("gh auth login")} />
              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <button onClick={runStatusCheck} style={buttonStyle(true, false)}>
                  Check again
                </button>
                <button onClick={onClose} style={buttonStyle(false, false)}>
                  Cancel
                </button>
              </div>
            </>
          )}

          {(phase === "ready" || phase === "creating") && status && (
            <>
              {status.user && (
                <div style={{ fontSize: 11, color: "var(--ezy-text-muted)", marginBottom: 12 }}>
                  Signed in as{" "}
                  <span style={{ color: "var(--ezy-text-secondary)", fontWeight: 500 }}>{status.user}</span>
                </div>
              )}

              <FieldLabel>Repository name</FieldLabel>
              <input
                ref={nameRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-project"
                disabled={phase === "creating"}
                style={inputStyle(nameInvalid)}
              />
              {nameInvalid && (
                <div style={{ fontSize: 11, color: "var(--ezy-red, #e55)", marginTop: 4 }}>
                  Use letters, numbers, dashes, underscores, or dots only.
                </div>
              )}

              <div style={{ height: 12 }} />

              <FieldLabel>Visibility</FieldLabel>
              <div style={{ display: "flex", gap: 8 }}>
                <VisibilityChip
                  active={visibility === "private"}
                  label="Private"
                  hint="Only you"
                  onClick={() => setVisibility("private")}
                  disabled={phase === "creating"}
                />
                <VisibilityChip
                  active={visibility === "public"}
                  label="Public"
                  hint="Anyone on GitHub"
                  onClick={() => setVisibility("public")}
                  disabled={phase === "creating"}
                />
              </div>

              <div style={{ height: 12 }} />

              <FieldLabel>Description (optional)</FieldLabel>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder=""
                disabled={phase === "creating"}
                style={inputStyle(false)}
              />

              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginTop: 14,
                  fontSize: 12,
                  color: "var(--ezy-text-secondary)",
                  cursor: phase === "creating" ? "not-allowed" : "pointer",
                  userSelect: "none",
                }}
              >
                <input
                  type="checkbox"
                  checked={push}
                  disabled={phase === "creating"}
                  onChange={(e) => setPush(e.target.checked)}
                />
                Push current branch to the new repository
              </label>

              {createError && (
                <pre
                  style={{
                    fontSize: 11,
                    color: "var(--ezy-red, #e55)",
                    marginTop: 12,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    lineHeight: 1.5,
                    maxHeight: 160,
                    overflow: "auto",
                  }}
                >
                  {createError}
                </pre>
              )}

              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <button
                  onClick={handleCreate}
                  disabled={!canCreate}
                  style={buttonStyle(true, !canCreate)}
                >
                  {phase === "creating" ? "Creating..." : "Create repository"}
                </button>
                <button onClick={onClose} disabled={phase === "creating"} style={buttonStyle(false, phase === "creating")}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, color: "var(--ezy-text-muted)", marginBottom: 6, fontWeight: 500 }}>
      {children}
    </div>
  );
}

function VisibilityChip({
  active,
  label,
  hint,
  onClick,
  disabled,
}: {
  active: boolean;
  label: string;
  hint: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        flex: 1,
        padding: "10px 12px",
        borderRadius: 6,
        border: `1px solid ${active ? "var(--ezy-accent)" : "var(--ezy-border)"}`,
        backgroundColor: active ? "var(--ezy-accent-glow)" : "var(--ezy-surface)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
        textAlign: "left",
        fontFamily: "inherit",
        transition: "border-color 120ms ease, background-color 120ms ease",
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ezy-text)" }}>{label}</div>
      <div style={{ fontSize: 10, color: "var(--ezy-text-muted)", marginTop: 2 }}>{hint}</div>
    </button>
  );
}

function CommandRow({ command, onCopy }: { command: string; onCopy: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 10px",
        border: "1px solid var(--ezy-border)",
        borderRadius: 6,
        backgroundColor: "var(--ezy-surface)",
      }}
    >
      <span
        style={{
          flex: 1,
          fontSize: 12,
          color: "var(--ezy-text)",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          overflow: "auto",
          whiteSpace: "nowrap",
        }}
      >
        {command}
      </span>
      <button
        onClick={() => {
          onCopy();
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        style={{
          fontSize: 11,
          padding: "4px 8px",
          borderRadius: 4,
          border: "1px solid var(--ezy-border)",
          backgroundColor: "var(--ezy-surface-raised)",
          color: copied ? "var(--ezy-accent)" : "var(--ezy-text-secondary)",
          cursor: "pointer",
          fontFamily: "inherit",
          flexShrink: 0,
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

const inlineCodeStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  backgroundColor: "var(--ezy-surface)",
  padding: "1px 5px",
  borderRadius: 3,
  fontSize: "0.9em",
  color: "var(--ezy-text)",
};

function inputStyle(invalid: boolean): React.CSSProperties {
  return {
    width: "100%",
    padding: "8px 10px",
    fontSize: 13,
    color: "var(--ezy-text)",
    backgroundColor: "var(--ezy-surface)",
    border: `1px solid ${invalid ? "var(--ezy-red, #e55)" : "var(--ezy-border)"}`,
    borderRadius: 6,
    outline: "none",
    fontFamily: "inherit",
    boxSizing: "border-box",
  };
}

function buttonStyle(primary: boolean, disabled: boolean): React.CSSProperties {
  return {
    padding: "8px 14px",
    fontSize: 13,
    fontWeight: 600,
    color: primary ? (disabled ? "var(--ezy-text-muted)" : "#fff") : "var(--ezy-text)",
    backgroundColor: primary
      ? disabled
        ? "var(--ezy-surface)"
        : "var(--ezy-accent)"
      : "var(--ezy-surface-raised)",
    border: primary ? (disabled ? "1px solid var(--ezy-border)" : "none") : "1px solid var(--ezy-border)",
    borderRadius: 6,
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: "inherit",
    transition: "background-color 150ms ease",
    flexShrink: 0,
  };
}
