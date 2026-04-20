import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FaXmark } from "react-icons/fa6";

interface CreatePullRequestModalProps {
  workingDir: string;
  currentBranch: string;
  branches: string[];
  onClose: () => void;
  onCreated: (url: string) => void;
}

type PrCreateResult = { url: string; output: string };

const COMMON_DEFAULT_BASES = ["main", "master", "develop", "trunk"];

function pickDefaultBase(branches: string[], currentBranch: string): string {
  // Prefer the first common default branch that exists; otherwise first branch
  // in the list that isn't the current one.
  for (const candidate of COMMON_DEFAULT_BASES) {
    if (branches.includes(candidate)) return candidate;
  }
  const fallback = branches.find((b) => b !== currentBranch);
  return fallback ?? "main";
}

function bulletFromSubjects(subjects: string[]): string {
  if (subjects.length === 0) return "";
  return subjects.map((s) => `- ${s}`).join("\n");
}

export default function CreatePullRequestModal({
  workingDir,
  currentBranch,
  branches,
  onClose,
  onCreated,
}: CreatePullRequestModalProps) {
  const [base, setBase] = useState(() => pickDefaultBase(branches, currentBranch));
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [loadingCommits, setLoadingCommits] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const titleRef = useRef<HTMLInputElement>(null);

  // Escape-to-close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [submitting, onClose]);

  // Auto-focus title
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  // Prefill title+body from commits between base..HEAD.
  useEffect(() => {
    if (!workingDir || !base) return;
    let cancelled = false;
    setLoadingCommits(true);
    invoke<string[]>("git_commits_between", { directory: workingDir, base })
      .then((subjects) => {
        if (cancelled) return;
        if (subjects.length === 0) {
          setTitle((prev) => prev || currentBranch.replace(/[-_/]+/g, " ").trim());
          setBody((prev) => prev || "");
          return;
        }
        setTitle((prev) => prev || subjects[0]);
        setBody((prev) => prev || bulletFromSubjects(subjects));
      })
      .catch(() => {
        if (cancelled) return;
        setTitle((prev) => prev || currentBranch.replace(/[-_/]+/g, " ").trim());
      })
      .finally(() => {
        if (!cancelled) setLoadingCommits(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workingDir, base, currentBranch]);

  const canSubmit = !!title.trim() && !!base && !submitting && !!workingDir;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await invoke<PrCreateResult>("gh_pr_create", {
        directory: workingDir,
        title: title.trim(),
        body,
        base,
        draft,
      });
      onCreated(result.url);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, workingDir, title, body, base, draft, onCreated]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "10vh",
        zIndex: 220,
      }}
      onClick={() => {
        if (!submitting) onClose();
      }}
    >
      <div
        style={{
          maxWidth: 560,
          width: "calc(100% - 48px)",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
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
            display: "flex",
            alignItems: "center",
            padding: "14px 18px",
            borderBottom: "1px solid var(--ezy-border)",
            flexShrink: 0,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 11,
                color: "var(--ezy-text-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                marginBottom: 2,
              }}
            >
              New pull request
            </div>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--ezy-text)" }}>
              {currentBranch} → {base}
            </div>
          </div>
          <div
            role="button"
            tabIndex={0}
            title="Close"
            onClick={() => {
              if (!submitting) onClose();
            }}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === " ") && !submitting) onClose();
            }}
            style={{
              width: 28,
              height: 28,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 4,
              cursor: submitting ? "default" : "pointer",
              color: "var(--ezy-text-muted)",
              opacity: submitting ? 0.5 : 1,
              marginLeft: 12,
            }}
          >
            <FaXmark size={14} color="currentColor" />
          </div>
        </div>

        {/* Body */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            padding: "14px 18px",
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          {/* Base branch */}
          <div>
            <label
              style={{
                display: "block",
                fontSize: 11,
                fontWeight: 600,
                color: "var(--ezy-text-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                marginBottom: 6,
              }}
            >
              Base branch
            </label>
            <select
              value={base}
              onChange={(e) => setBase(e.target.value)}
              disabled={submitting}
              style={{
                width: "100%",
                height: 32,
                backgroundColor: "var(--ezy-bg)",
                color: "var(--ezy-text)",
                border: "1px solid var(--ezy-border)",
                borderRadius: 6,
                padding: "0 10px",
                fontSize: 13,
                fontFamily: "inherit",
                outline: "none",
                cursor: submitting ? "not-allowed" : "pointer",
              }}
            >
              {branches
                .filter((b) => b !== currentBranch)
                .map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
            </select>
          </div>

          {/* Title */}
          <div>
            <label
              style={{
                display: "block",
                fontSize: 11,
                fontWeight: 600,
                color: "var(--ezy-text-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                marginBottom: 6,
              }}
            >
              Title
            </label>
            <input
              ref={titleRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={submitting}
              placeholder={loadingCommits ? "Loading commits…" : "Pull request title"}
              spellCheck={false}
              style={{
                width: "100%",
                boxSizing: "border-box",
                height: 32,
                backgroundColor: "var(--ezy-bg)",
                color: "var(--ezy-text)",
                border: "1px solid var(--ezy-border)",
                borderRadius: 6,
                padding: "0 10px",
                fontSize: 13,
                fontFamily: "inherit",
                outline: "none",
              }}
            />
          </div>

          {/* Body */}
          <div>
            <label
              style={{
                display: "block",
                fontSize: 11,
                fontWeight: 600,
                color: "var(--ezy-text-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                marginBottom: 6,
              }}
            >
              Description
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={submitting}
              spellCheck={false}
              rows={8}
              placeholder={
                loadingCommits
                  ? "Prefilled from commits…"
                  : "Describe your changes (markdown supported)"
              }
              style={{
                width: "100%",
                boxSizing: "border-box",
                backgroundColor: "var(--ezy-bg)",
                color: "var(--ezy-text)",
                border: "1px solid var(--ezy-border)",
                borderRadius: 6,
                padding: "8px 10px",
                fontSize: 12,
                lineHeight: 1.5,
                fontFamily: "inherit",
                resize: "vertical",
                minHeight: 140,
                outline: "none",
                whiteSpace: "pre-wrap",
              }}
            />
          </div>

          {/* Draft toggle */}
          <div
            role="checkbox"
            aria-checked={draft}
            tabIndex={0}
            onClick={() => {
              if (!submitting) setDraft((v) => !v);
            }}
            onKeyDown={(e) => {
              if (!submitting && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault();
                setDraft((v) => !v);
              }
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              cursor: submitting ? "default" : "pointer",
              userSelect: "none",
            }}
          >
            <div
              style={{
                width: 16,
                height: 16,
                borderRadius: 4,
                border: draft ? "none" : "1px solid var(--ezy-border-light)",
                backgroundColor: draft ? "var(--ezy-accent)" : "transparent",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
                transition: "background-color 120ms ease",
              }}
            >
              {draft && (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path
                    d="M1.5 5.2 4 7.5 8.5 2.5"
                    stroke="#0d1117"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </div>
            <span style={{ fontSize: 12, color: "var(--ezy-text-secondary)" }}>
              Open as draft
            </span>
          </div>

          {error && (
            <div
              style={{
                fontSize: 12,
                color: "var(--ezy-red)",
                lineHeight: 1.5,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 18px",
            borderTop: "1px solid var(--ezy-border)",
            backgroundColor: "var(--ezy-surface)",
            flexShrink: 0,
          }}
        >
          <div style={{ flex: 1 }} />
          <button
            onClick={() => {
              if (!submitting) onClose();
            }}
            disabled={submitting}
            style={{
              height: 30,
              padding: "0 14px",
              borderRadius: 6,
              border: "1px solid var(--ezy-border)",
              backgroundColor: "var(--ezy-surface-raised)",
              color: "var(--ezy-text)",
              fontSize: 12,
              fontWeight: 500,
              cursor: submitting ? "not-allowed" : "pointer",
              opacity: submitting ? 0.6 : 1,
              fontFamily: "inherit",
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            style={{
              height: 30,
              padding: "0 14px",
              borderRadius: 6,
              border: "none",
              backgroundColor: "var(--ezy-accent)",
              color: "#0d1117",
              fontSize: 12,
              fontWeight: 600,
              cursor: canSubmit ? "pointer" : "not-allowed",
              opacity: canSubmit ? 1 : 0.6,
              fontFamily: "inherit",
            }}
          >
            {submitting ? "Creating…" : draft ? "Create draft PR" : "Create pull request"}
          </button>
        </div>
      </div>
    </div>
  );
}
