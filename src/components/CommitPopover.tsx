import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { statusBadge } from "./CodeReviewFileList";
import { generateCommitMsg } from "../lib/generate-commit-msg";
import { useAppStore } from "../store";
import type { GitFileStatus } from "../types";

interface CommitPopoverProps {
  workingDir: string;
  gitFiles: GitFileStatus[];
  diffText: string;
  onClose: () => void;
  onCommitSuccess: () => void;
}

type CheckStatus = "idle" | "running" | "passed" | "failed" | "skipped";

interface CheckState {
  status: CheckStatus;
  output: string;
  expanded: boolean;
}

const INITIAL_CHECK: CheckState = { status: "idle", output: "", expanded: false };

/** Reusable row for a single safety check */
function CheckRow({
  label,
  state,
  onToggleExpanded,
  isFirst,
}: {
  label: string;
  state: CheckState;
  onToggleExpanded: () => void;
  isFirst: boolean;
}) {
  const { status, output, expanded } = state;
  return (
    <>
      <div
        className="flex items-center gap-1.5"
        style={{
          padding: "8px 10px",
          ...(isFirst ? { borderTop: "1px solid var(--ezy-border-subtle)", marginTop: 6 } : {}),
        }}
      >
        {/* Icon */}
        {status === "running" && (
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ animation: "ezy-spin 0.8s linear infinite", flexShrink: 0 }}>
            <circle cx="8" cy="8" r="6" stroke="var(--ezy-text-muted)" strokeWidth="2" strokeDasharray="28" strokeDashoffset="8" strokeLinecap="round" />
          </svg>
        )}
        {status === "passed" && (
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
            <path d="M3 8.5L6.5 12L13 4" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        {status === "failed" && (
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
            <path d="M4 4L12 12M12 4L4 12" stroke="#f87171" strokeWidth="2" strokeLinecap="round" />
          </svg>
        )}
        {status === "skipped" && (
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
            <path d="M4 8h8" stroke="var(--ezy-text-muted)" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        )}
        {status === "idle" && (
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
            <circle cx="8" cy="8" r="6" stroke="var(--ezy-text-muted)" strokeWidth="1.5" />
          </svg>
        )}

        <span className="text-[10px]" style={{ color: "var(--ezy-text-secondary)" }}>
          {label}:
        </span>
        <span
          className="text-[10px] font-medium"
          style={{
            color:
              status === "passed" ? "#34d399"
                : status === "failed" ? "#f87171"
                  : "var(--ezy-text-muted)",
          }}
        >
          {status === "idle" && "Waiting"}
          {status === "running" && "Running..."}
          {status === "passed" && "Passed"}
          {status === "failed" && "Failed"}
          {status === "skipped" && "Skipped"}
        </span>

        {status === "failed" && output && (
          <button
            onClick={onToggleExpanded}
            className="text-[10px] hover:opacity-80 transition-opacity ml-auto"
            style={{ color: "var(--ezy-text-muted)", background: "none", border: "none", cursor: "pointer", padding: 0 }}
          >
            {expanded ? "Hide" : "Show"}
          </button>
        )}
      </div>

      {/* Error output */}
      {expanded && output && (
        <div style={{ maxHeight: 120, overflowY: "auto", padding: "0 10px 8px 10px" }}>
          <pre
            className="text-[10px]"
            style={{
              color: "#f87171",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              margin: 0,
              backgroundColor: "var(--ezy-bg)",
              borderRadius: 4,
              padding: "6px 8px",
              lineHeight: 1.4,
            }}
          >
            {output}
          </pre>
        </div>
      )}
    </>
  );
}

/** Generate a conventional commit message from file statuses */
function generateCommitMessage(files: GitFileStatus[]): string {
  if (files.length === 0) return "";

  const stripExt = (p: string) => (p.split("/").pop() || p).replace(/\.[^.]+$/, "");
  const getDir = (p: string) => {
    const parts = p.split("/");
    // Return meaningful directory: "src/components" → "components", "src-tauri/src" → "backend"
    if (parts.length <= 1) return "";
    const dir = parts[parts.length - 2];
    if (dir === "src" && parts.length > 2) return parts[parts.length - 3] === "src-tauri" ? "backend" : "";
    return dir;
  };

  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const dirs = new Set<string>();

  for (const f of files) {
    const name = stripExt(f.path);
    const dir = getDir(f.path);
    if (dir) dirs.add(dir);
    if (f.status === "A" || f.status === "??") added.push(name);
    else if (f.status === "D") deleted.push(name);
    else modified.push(name);
  }

  // Determine prefix
  let prefix: string;
  if (deleted.length > 0 && added.length === 0 && modified.length === 0) {
    prefix = "chore";
  } else if (added.length > modified.length) {
    prefix = "feat";
  } else {
    // Check if all changes are config/build files
    const configFiles = ["package", "tsconfig", "vite.config", "tailwind.config", "Cargo", ".gitignore"];
    const allConfig = files.every((f) => configFiles.some((c) => f.path.includes(c)));
    prefix = allConfig ? "chore" : "chore";
  }

  // Scope from common directory
  const scope = dirs.size === 1 ? dirs.values().next().value : "";

  // Build description
  const parts: string[] = [];
  const listNames = (verb: string, names: string[], max = 3) => {
    if (names.length === 0) return;
    if (names.length === 1) {
      parts.push(`${verb} ${names[0]}`);
    } else if (names.length <= max) {
      parts.push(`${verb} ${names.join(", ")}`);
    } else {
      parts.push(`${verb} ${names.slice(0, max).join(", ")}, and ${names.length - max} more`);
    }
  };

  listNames("update", modified);
  listNames("add", added);
  listNames("remove", deleted);

  const desc = parts.join("; ");
  return scope ? `${prefix}(${scope}): ${desc}` : `${prefix}: ${desc}`;
}

export default function CommitPopover({
  workingDir,
  gitFiles,
  diffText,
  onClose,
  onCommitSuccess,
}: CommitPopoverProps) {
  const commitMsgMode = useAppStore((s) => s.commitMsgMode ?? "simple");
  const [message, setMessage] = useState(() =>
    commitMsgMode === "simple" ? generateCommitMessage(gitFiles) : ""
  );
  const [generating, setGenerating] = useState(commitMsgMode === "advanced");
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(
    () => new Set(gitFiles.map((f) => f.path))
  );
  const [typecheckState, setTypecheckState] = useState<CheckState>(INITIAL_CHECK);
  const [lintState, setLintState] = useState<CheckState>(INITIAL_CHECK);
  const [testState, setTestState] = useState<CheckState>(INITIAL_CHECK);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [confirmBypass, setConfirmBypass] = useState(false);

  const popoverRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-focus textarea on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Auto-run all three checks in parallel on mount
  useEffect(() => {
    let cancelled = false;

    // Helper to run a check and update its state setter
    const runCheck = (
      command: string,
      setState: React.Dispatch<React.SetStateAction<CheckState>>,
    ) => {
      setState((s) => ({ ...s, status: "running" }));
      invoke<string>(command, { directory: workingDir })
        .then((output) => {
          if (cancelled) return;
          if (output === "__SKIP__") {
            setState({ status: "skipped", output: "", expanded: false });
          } else if (output === "") {
            setState({ status: "passed", output: "", expanded: false });
          } else {
            setState({ status: "failed", output, expanded: false });
          }
        })
        .catch((err) => {
          if (cancelled) return;
          setState({ status: "failed", output: String(err), expanded: false });
        });
    };

    runCheck("git_run_typecheck", setTypecheckState);
    runCheck("git_run_lint", setLintState);
    runCheck("git_run_tests", setTestState);

    return () => { cancelled = true; };
  }, [workingDir]);

  // Secrets scanning (frontend-only, informational)
  const secretsWarnings = useMemo(() => {
    const warnings: string[] = [];
    const patterns: [RegExp, string][] = [
      [/AKIA[0-9A-Z]{16}/, "AWS access key"],
      [/sk_live_[a-zA-Z0-9]+/, "Stripe live key"],
      [/BEGIN (RSA |OPENSSH )?PRIVATE KEY/, "Private key"],
      [/(password|secret|token|api_key)\s*[:=]\s*["'][^"']{4,}/i, "Credential value"],
    ];
    for (const [re, label] of patterns) {
      if (re.test(diffText)) warnings.push(label);
    }
    // Check for .env files in staged list
    for (const f of gitFiles) {
      if (/\.env($|\.)/.test(f.path)) {
        warnings.push(`.env file (${f.path})`);
      }
    }
    return warnings;
  }, [diffText, gitFiles]);

  // Reusable AI generation trigger
  const cancelRef = useRef(false);
  const triggerAiGeneration = useCallback(() => {
    if (!diffText) return;
    cancelRef.current = false;
    setGenerating(true);
    setMessage("");
    generateCommitMsg(diffText)
      .then((msg) => {
        if (cancelRef.current) return;
        setMessage(msg);
        setGenerating(false);
      })
      .catch((err) => {
        console.error("[CommitPopover] AI msg generation failed:", err);
        if (!cancelRef.current) {
          setMessage(generateCommitMessage(gitFiles));
          setGenerating(false);
        }
      });
  }, [diffText, gitFiles]);

  // Auto-generate AI commit message on mount (advanced mode only)
  useEffect(() => {
    if (commitMsgMode !== "advanced" || !diffText) return;
    triggerAiGeneration();
    return () => { cancelRef.current = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Click-outside to close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const toggleFile = useCallback((path: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelectedFiles((prev) => {
      if (prev.size === gitFiles.length) return new Set();
      return new Set(gitFiles.map((f) => f.path));
    });
  }, [gitFiles]);

  const anyCheckFailed = typecheckState.status === "failed" || lintState.status === "failed" || testState.status === "failed";
  const anyCheckRunning = typecheckState.status === "running" || lintState.status === "running" || testState.status === "running";

  const handleCommit = useCallback(async () => {
    if (!message.trim() || selectedFiles.size === 0) return;

    // If any check failed and user hasn't confirmed bypass
    if (anyCheckFailed && !confirmBypass) {
      setConfirmBypass(true);
      return;
    }

    setCommitting(true);
    setCommitError(null);
    try {
      // Unstage any unchecked files that may have been previously staged
      const uncheckedFiles = gitFiles
        .map((f) => f.path)
        .filter((p) => !selectedFiles.has(p));
      if (uncheckedFiles.length > 0) {
        await invoke("git_reset_files", {
          directory: workingDir,
          files: uncheckedFiles,
        });
      }
      await invoke("git_add", {
        directory: workingDir,
        files: [...selectedFiles],
      });
      await invoke<string>("git_commit", {
        directory: workingDir,
        message: message.trim(),
      });
      onCommitSuccess();
    } catch (err) {
      setCommitError(String(err));
    } finally {
      setCommitting(false);
    }
  }, [message, selectedFiles, anyCheckFailed, confirmBypass, workingDir, onCommitSuccess, gitFiles]);

  const allSelected = selectedFiles.size === gitFiles.length;
  const canCommit = message.trim().length > 0 && selectedFiles.size > 0 && !committing && !anyCheckRunning;

  return (
    <div
      ref={popoverRef}
      style={{
        position: "absolute",
        top: "calc(100% + 4px)",
        right: 0,
        width: 380,
        zIndex: 50,
        backgroundColor: "var(--ezy-surface-raised)",
        border: "1px solid var(--ezy-border)",
        borderRadius: 6,
        boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
        overflow: "hidden",
      }}
    >
      {/* Commit message */}
      <div style={{ padding: "10px 10px 0 10px", position: "relative" }}>
        {generating ? (
          /* Loading state — replaces textarea while AI generates */
          <div
            style={{
              width: "100%",
              backgroundColor: "var(--ezy-bg)",
              border: "1px solid var(--ezy-border-subtle)",
              borderRadius: 4,
              padding: "6px 8px",
              minHeight: 62,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 7,
            }}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 16 16"
              fill="none"
              style={{ animation: "ezy-spin 0.7s linear infinite", flexShrink: 0 }}
            >
              <circle cx="8" cy="8" r="6.5" stroke="var(--ezy-border)" strokeWidth="1.5" />
              <path d="M14.5 8a6.5 6.5 0 0 0-6.5-6.5" stroke="var(--ezy-text-muted)" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <span
              style={{
                color: "var(--ezy-text-muted)",
                fontSize: 11.5,
                fontFamily: "inherit",
                letterSpacing: "0.01em",
                animation: "ezy-fade 2s ease-in-out infinite",
              }}
            >
              Generating commit message…
            </span>
          </div>
        ) : (
          <>
            <textarea
              ref={textareaRef}
              value={message}
              onChange={(e) => {
                setMessage(e.target.value);
                // Auto-resize
                const ta = e.target;
                ta.style.height = "auto";
                ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleCommit();
                }
              }}
              placeholder="Commit message..."
              rows={3}
              style={{
                width: "100%",
                backgroundColor: "var(--ezy-bg)",
                border: "1px solid var(--ezy-border-subtle)",
                borderRadius: 4,
                padding: commitMsgMode === "advanced" ? "6px 42px 6px 8px" : "6px 24px 6px 8px",
                color: "var(--ezy-text)",
                fontSize: 12,
                lineHeight: 1.4,
                resize: "none",
                outline: "none",
                fontFamily: "inherit",
              }}
            />
            {/* Regenerate button — AI mode only */}
            {commitMsgMode === "advanced" && message.length > 0 && (
              <button
                onClick={() => {
                  triggerAiGeneration();
                }}
                title="Regenerate commit message"
                style={{
                  position: "absolute",
                  top: 14,
                  right: 30,
                  width: 16,
                  height: 16,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: 0,
                  borderRadius: 2,
                  color: "var(--ezy-text-muted)",
                  opacity: 0.6,
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = "1"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = "0.6"; }}
              >
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                  <path d="M13.5 3V6.5H10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M12.3 10a5 5 0 1 1-.9-5.4L13.5 6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
            {/* Clear button — top-right corner of textarea */}
            {message.length > 0 && (
              <button
                onClick={() => {
                  setMessage("");
                  textareaRef.current?.focus();
                }}
                title="Clear message"
                style={{
                  position: "absolute",
                  top: 14,
                  right: 14,
                  width: 16,
                  height: 16,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: 0,
                  borderRadius: 2,
                  color: "var(--ezy-text-muted)",
                  opacity: 0.6,
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = "1"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = "0.6"; }}
              >
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                  <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </>
        )}
      </div>

      {/* File staging header */}
      <div
        className="flex items-center justify-between"
        style={{
          padding: "8px 10px 4px 10px",
        }}
      >
        <span
          className="text-[10px] font-medium"
          style={{ color: "var(--ezy-text-secondary)" }}
        >
          Staged files ({selectedFiles.size}/{gitFiles.length})
        </span>
        <button
          onClick={toggleAll}
          className="text-[10px] hover:opacity-80 transition-opacity"
          style={{ color: "var(--ezy-accent)", background: "none", border: "none", cursor: "pointer", padding: 0 }}
        >
          {allSelected ? "Deselect all" : "Select all"}
        </button>
      </div>

      {/* File staging list */}
      <div
        style={{
          maxHeight: 160,
          overflowY: "auto",
          padding: "0 10px",
        }}
      >
        {gitFiles.map((file) => {
          const fileName = file.path.split("/").pop() || file.path;
          const dirPath = file.path.includes("/")
            ? file.path.substring(0, file.path.lastIndexOf("/") + 1)
            : "";
          const checked = selectedFiles.has(file.path);

          return (
            <label
              key={file.path}
              className="flex items-center gap-1.5 py-[3px] cursor-pointer hover:opacity-90"
              style={{ color: "var(--ezy-text)" }}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggleFile(file.path)}
                style={{
                  accentColor: "var(--ezy-accent)",
                  width: 13,
                  height: 13,
                  flexShrink: 0,
                  cursor: "pointer",
                }}
              />
              {statusBadge(file.status)}
              <span className="text-[11px] truncate min-w-0 flex-1">
                {dirPath && (
                  <span style={{ color: "var(--ezy-text-muted)" }}>{dirPath}</span>
                )}
                {fileName}
              </span>
            </label>
          );
        })}
      </div>

      {/* Secrets warning banner — always visible when secrets detected */}
      {secretsWarnings.length > 0 && (
        <div
          className="flex items-start gap-1.5 rounded"
          style={{
            margin: "6px 10px 0 10px",
            padding: "6px 8px",
            backgroundColor: "#3b1418",
            border: "1px solid #7f1d1d",
          }}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, marginTop: 1 }}>
            <path d="M8 1L15 14H1L8 1Z" stroke="#f87171" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M8 6V9" stroke="#f87171" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="8" cy="11.5" r="0.75" fill="#f87171" />
          </svg>
          <span className="text-[10px]" style={{ color: "#fca5a5", lineHeight: 1.4 }}>
            Possible secrets detected: {secretsWarnings.join(", ")}
          </span>
        </div>
      )}

      {/* Safety check rows */}
      <CheckRow
        label="Typecheck"
        state={typecheckState}
        onToggleExpanded={() => setTypecheckState((s) => ({ ...s, expanded: !s.expanded }))}
        isFirst
      />
      <CheckRow
        label="Lint"
        state={lintState}
        onToggleExpanded={() => setLintState((s) => ({ ...s, expanded: !s.expanded }))}
        isFirst={false}
      />
      <CheckRow
        label="Tests"
        state={testState}
        onToggleExpanded={() => setTestState((s) => ({ ...s, expanded: !s.expanded }))}
        isFirst={false}
      />

      {/* Commit error */}
      {commitError && (
        <div
          className="text-[10px]"
          style={{
            color: "#f87171",
            padding: "0 10px 6px 10px",
          }}
        >
          {commitError}
        </div>
      )}

      {/* Action row */}
      <div
        style={{
          padding: "8px 10px",
          borderTop: "1px solid var(--ezy-border-subtle)",
        }}
      >
        {/* Bypass warning banner — shown when any check failed and user clicked Commit once */}
        {confirmBypass && (
          <div
            className="flex items-center gap-1.5 rounded mb-2"
            style={{
              padding: "6px 8px",
              backgroundColor: "#3b1418",
              border: "1px solid #7f1d1d",
            }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
              <path d="M8 1L15 14H1L8 1Z" stroke="#f87171" strokeWidth="1.5" strokeLinejoin="round" />
              <path d="M8 6V9" stroke="#f87171" strokeWidth="1.5" strokeLinecap="round" />
              <circle cx="8" cy="11.5" r="0.75" fill="#f87171" />
            </svg>
            <span className="text-[10px]" style={{ color: "#fca5a5" }}>
              {[
                typecheckState.status === "failed" && "Typecheck",
                lintState.status === "failed" && "Lint",
                testState.status === "failed" && "Tests",
              ].filter(Boolean).join(", ")}{" "}
              {[typecheckState.status, lintState.status, testState.status].filter((s) => s === "failed").length === 1 ? "has" : "have"} errors. Commit with caution.
            </span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            onClick={() => { if (confirmBypass) { setConfirmBypass(false); } else { onClose(); } }}
            className="text-[11px] hover:opacity-80 transition-opacity"
            style={{
              color: "var(--ezy-text-muted)",
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: "4px 10px",
            }}
          >
            {confirmBypass ? "Back" : "Cancel"}
          </button>
          <button
            onClick={handleCommit}
            disabled={!canCommit}
            className="flex items-center gap-1 text-[11px] font-medium transition-opacity"
            style={{
              backgroundColor: confirmBypass ? "#991b1b" : "var(--ezy-accent)",
              color: "#fff",
              border: confirmBypass ? "1px solid #7f1d1d" : "none",
              borderRadius: 4,
              padding: confirmBypass ? "5px 16px" : "4px 14px",
              cursor: canCommit ? "pointer" : "default",
              opacity: canCommit ? 1 : 0.4,
            }}
          >
            {committing ? (
              <>
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 16 16"
                  fill="none"
                  style={{ animation: "ezy-spin 0.8s linear infinite" }}
                >
                  <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="28" strokeDashoffset="8" strokeLinecap="round" />
                </svg>
                Committing...
              </>
            ) : confirmBypass ? (
              "Commit anyway"
            ) : (
              "Commit"
            )}
          </button>
        </div>
      </div>

      {/* CSS keyframes for spinner + fade */}
      <style>{`
        @keyframes ezy-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes ezy-fade {
          0%, 100% { opacity: 0.5; }
          50% { opacity: 1; }
        }
      `}</style>
    </div>
  );
}
