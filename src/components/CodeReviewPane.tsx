import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FaExpand, FaCompress } from "react-icons/fa6";
import { useAppStore } from "../store";
import { parseUnifiedDiff, buildHunkPatch } from "../lib/diff-parser";
import CodeReviewFileList from "./CodeReviewFileList";
import CodeReviewDiffView from "./CodeReviewDiffView";
import CommitPopover from "./CommitPopover";
import type {
  ComparisonMode,
  GitFileStatus,
  GitBranchInfo,
  GitAheadBehind,
  FileDiff,
} from "../types";

interface CodeReviewPaneProps {
  onClose: () => void;
}

export default function CodeReviewPane({ onClose }: CodeReviewPaneProps) {
  const activeTabId = useAppStore((s) => s.activeTabId);
  const tabs = useAppStore((s) => s.tabs);
  const workingDir =
    tabs.find((t) => t.id === activeTabId)?.workingDir || "";

  const [isGitRepo, setIsGitRepo] = useState(false);
  const [gitFiles, setGitFiles] = useState<GitFileStatus[]>([]);
  const [fileDiffs, setFileDiffs] = useState<FileDiff[]>([]);
  const [branches, setBranches] = useState<GitBranchInfo | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fileListCollapsed, setFileListCollapsed] = useState(false);
  const [comparisonMode, setComparisonMode] = useState<ComparisonMode>("uncommitted");
  const [customBranch, setCustomBranch] = useState("");
  const [showModeDropdown, setShowModeDropdown] = useState(false);
  const [showBranchPicker, setShowBranchPicker] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  const [showCommitPopover, setShowCommitPopover] = useState(false);
  const [aheadBehind, setAheadBehind] = useState<GitAheadBehind | null>(null);
  const [pushing, setPushing] = useState(false);
  const [pushResult, setPushResult] = useState<{ ok: boolean; msg: string; branch?: string; count?: number } | null>(null);
  const [pushError, setPushError] = useState<string | null>(null);

  const dropdownRef = useRef<HTMLDivElement>(null);
  const commitBtnRef = useRef<HTMLDivElement>(null);
  const pushErrorRef = useRef<HTMLDivElement>(null);

  const getCompareArg = useCallback((): string | undefined => {
    if (comparisonMode === "vs-main") return "main";
    if (comparisonMode === "vs-branch" && customBranch) return customBranch;
    return undefined;
  }, [comparisonMode, customBranch]);

  const fetchData = useCallback(async () => {
    if (!workingDir) return;

    try {
      const isRepo = await invoke<boolean>("git_is_repo", { directory: workingDir });
      setIsGitRepo(isRepo);

      if (!isRepo) {
        setLoading(false);
        return;
      }

      const compareArg = getCompareArg();

      const [statusResult, diffResult, branchResult, abResult] = await Promise.all([
        invoke<GitFileStatus[]>("git_status", { directory: workingDir }),
        invoke<string>("git_diff", {
          directory: workingDir,
          filePath: null,
          compareTo: compareArg ?? null,
        }),
        invoke<GitBranchInfo>("git_branches", { directory: workingDir }),
        invoke<GitAheadBehind>("git_ahead_behind", { directory: workingDir }),
      ]);

      setGitFiles(statusResult);
      setFileDiffs(parseUnifiedDiff(diffResult));
      setBranches(branchResult);
      setAheadBehind(abResult);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [workingDir, getCompareArg]);

  // Sequential poll (4s) + refresh when AI finishes working
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(async () => {
        if (!mountedRef.current) return;
        await fetchData();
        if (mountedRef.current) schedule();
      }, 20000);
    };
    fetchData().then(() => { if (mountedRef.current) schedule(); });
    const handler = () => {
      clearTimeout(timer);
      fetchData().then(() => { if (mountedRef.current) schedule(); });
    };
    window.addEventListener("ezydev:git-refresh", handler);
    return () => {
      mountedRef.current = false;
      clearTimeout(timer);
      window.removeEventListener("ezydev:git-refresh", handler);
    };
  }, [fetchData]);

  // Escape key closes fullscreen
  useEffect(() => {
    if (!fullscreen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [fullscreen]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowModeDropdown(false);
        setShowBranchPicker(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleRevertHunk = useCallback(
    async (fileDiff: FileDiff, hunkIndex: number) => {
      try {
        const patch = buildHunkPatch(fileDiff, hunkIndex);
        if (!patch) return;
        await invoke("git_revert_hunk", { directory: workingDir, patch });
        fetchData();
      } catch (err) {
        setError(`Revert failed: ${err}`);
      }
    },
    [workingDir, fetchData]
  );

  const handleDiscardFile = useCallback(
    async (filePath: string, isUntracked: boolean) => {
      try {
        await invoke("git_discard_file", {
          directory: workingDir,
          filePath,
          isUntracked,
        });
        fetchData();
      } catch (err) {
        setError(`Discard failed: ${err}`);
      }
    },
    [workingDir, fetchData]
  );

  const handleOpenInEditor = useCallback((filePath: string) => {
    const fullPath = workingDir
      ? `${workingDir}/${filePath}`
      : filePath;
    window.dispatchEvent(
      new CustomEvent("ezydev:open-file", { detail: { filePath: fullPath } })
    );
  }, [workingDir]);

  const handleSetMode = useCallback((mode: ComparisonMode, branch?: string) => {
    setComparisonMode(mode);
    if (branch) setCustomBranch(branch);
    setShowModeDropdown(false);
    setShowBranchPicker(false);
    setLoading(true);
  }, []);

  const handleCommitSuccess = useCallback(() => {
    setShowCommitPopover(false);
    window.dispatchEvent(new Event("ezydev:git-refresh"));
  }, []);

  const handlePush = useCallback(async () => {
    if (pushing) return;
    setPushing(true);
    setPushError(null);
    setPushResult(null);
    // Capture pre-push snapshot for the report
    const prePushBranch = branches?.current ?? "";
    const prePushCount = aheadBehind?.ahead ?? 0;
    try {
      const msg = await invoke<string>("git_push", {
        directory: workingDir,
        setUpstream: !aheadBehind?.hasRemote,
      });
      setPushResult({ ok: true, msg, branch: prePushBranch, count: prePushCount });
      window.dispatchEvent(new Event("ezydev:git-refresh"));
      setTimeout(() => setPushResult(null), 3000);
    } catch (err) {
      setPushError(String(err));
    } finally {
      setPushing(false);
    }
  }, [workingDir, aheadBehind, branches, pushing]);

  // Close push error on outside click
  useEffect(() => {
    if (!pushError) return;
    const handler = (e: MouseEvent) => {
      if (pushErrorRef.current && !pushErrorRef.current.contains(e.target as Node)) {
        setPushError(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [pushError]);

  const modeLabel =
    comparisonMode === "uncommitted"
      ? "Uncommitted"
      : comparisonMode === "vs-main"
        ? "vs main"
        : `vs ${customBranch}`;

  const content = (
    <div className="flex flex-col h-full w-full" style={{ backgroundColor: "var(--ezy-bg)" }}>
      {/* Header */}
      <div
        className="flex items-center gap-2 px-2 shrink-0"
        style={{
          height: 28,
          backgroundColor: "var(--ezy-surface)",
          borderBottom: "1px solid var(--ezy-border-subtle)",
        }}
      >
        {/* Left: git icon + branch + mode */}
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          {/* Git branch icon */}
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0">
            <path
              d="M5 3.25a2.25 2.25 0 114.5 0 2.25 2.25 0 01-4.5 0zM7.25 1.75a1.5 1.5 0 100 3 1.5 1.5 0 000-3zM4 12.75a2.25 2.25 0 114.5 0 2.25 2.25 0 01-4.5 0zM6.25 11.5a1.25 1.25 0 100 2.5 1.25 1.25 0 000-2.5z"
              fill="var(--ezy-accent)"
            />
            <path d="M7.25 5.5v5.25" stroke="var(--ezy-accent)" strokeWidth="1.5" />
          </svg>

          {branches && (
            <span
              className="text-[11px] font-medium truncate"
              style={{ color: "var(--ezy-text-secondary)" }}
            >
              {branches.current}
            </span>
          )}

          {/* Comparison mode dropdown */}
          <div className="relative" ref={dropdownRef}>
            <button
              onClick={() => setShowModeDropdown((v) => !v)}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] hover:opacity-80 transition-opacity"
              style={{
                color: "var(--ezy-text-muted)",
                border: "1px solid var(--ezy-border-subtle)",
              }}
            >
              {modeLabel}
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>

            {showModeDropdown && (
              <div
                className="absolute top-full left-0 mt-1 z-50 rounded shadow-lg py-1"
                style={{
                  backgroundColor: "var(--ezy-surface-raised)",
                  border: "1px solid var(--ezy-border)",
                  minWidth: 180,
                }}
              >
                <button
                  onClick={() => handleSetMode("uncommitted")}
                  className="w-full text-left px-3 py-1 text-[11px] hover:opacity-80"
                  style={{
                    color: comparisonMode === "uncommitted" ? "var(--ezy-accent)" : "var(--ezy-text)",
                  }}
                >
                  Uncommitted changes
                </button>
                <button
                  onClick={() => handleSetMode("vs-main")}
                  className="w-full text-left px-3 py-1 text-[11px] hover:opacity-80"
                  style={{
                    color: comparisonMode === "vs-main" ? "var(--ezy-accent)" : "var(--ezy-text)",
                  }}
                >
                  Changes vs main
                </button>
                <button
                  onClick={() => {
                    setShowBranchPicker(true);
                    setShowModeDropdown(false);
                  }}
                  className="w-full text-left px-3 py-1 text-[11px] hover:opacity-80"
                  style={{
                    color: comparisonMode === "vs-branch" ? "var(--ezy-accent)" : "var(--ezy-text)",
                  }}
                >
                  Changes vs branch...
                </button>
              </div>
            )}

            {showBranchPicker && branches && (
              <div
                className="absolute top-full left-0 mt-1 z-50 rounded shadow-lg py-1 max-h-[200px] overflow-y-auto"
                style={{
                  backgroundColor: "var(--ezy-surface-raised)",
                  border: "1px solid var(--ezy-border)",
                  minWidth: 200,
                }}
              >
                {branches.branches
                  .filter((b) => b !== branches.current)
                  .map((branch) => (
                    <button
                      key={branch}
                      onClick={() => handleSetMode("vs-branch", branch)}
                      className="w-full text-left px-3 py-1 text-[11px] hover:opacity-80 truncate"
                      style={{ color: "var(--ezy-text)" }}
                    >
                      {branch}
                    </button>
                  ))}
                {branches.branches.filter((b) => b !== branches.current).length === 0 && (
                  <div className="px-3 py-1 text-[11px]" style={{ color: "var(--ezy-text-muted)" }}>
                    No other branches
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right: commit + push + divider + refresh + fullscreen + close */}
        <div className="flex items-center gap-1">
          {/* Commit button */}
          <div ref={commitBtnRef} style={{ position: "relative" }}>
            <button
              onClick={() => setShowCommitPopover((v) => !v)}
              disabled={gitFiles.length === 0}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-opacity hover:opacity-80"
              style={{
                backgroundColor: gitFiles.length > 0 ? "#059669" : "transparent",
                color: gitFiles.length > 0 ? "#fff" : "var(--ezy-text-muted)",
                border: `1px solid ${gitFiles.length > 0 ? "#059669" : "var(--ezy-border-subtle)"}`,
                opacity: gitFiles.length === 0 ? 0.35 : 1,
                cursor: gitFiles.length === 0 ? "default" : "pointer",
              }}
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                <path d="M3 8.5L6.5 12L13 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Commit
            </button>
            {showCommitPopover && gitFiles.length > 0 && (
              <CommitPopover
                workingDir={workingDir}
                gitFiles={gitFiles}
                diffText={fileDiffs.map((d) => d.rawDiff).join("\n")}
                onClose={() => setShowCommitPopover(false)}
                onCommitSuccess={handleCommitSuccess}
              />
            )}
          </div>

          {/* Push button */}
          <div style={{ position: "relative" }}>
            <button
              onClick={handlePush}
              disabled={pushing || (!aheadBehind?.ahead && aheadBehind?.hasRemote !== false)}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-opacity hover:opacity-80"
              style={{
                backgroundColor: "transparent",
                color: "var(--ezy-text-secondary)",
                border: "1px solid var(--ezy-border-subtle)",
                opacity: (aheadBehind?.ahead || !aheadBehind?.hasRemote) && !pushing ? 1 : 0.35,
                cursor: (aheadBehind?.ahead || !aheadBehind?.hasRemote) && !pushing ? "pointer" : "default",
              }}
            >
              {pushing ? (
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 16 16"
                  fill="none"
                  style={{ animation: "ezy-spin 0.8s linear infinite" }}
                >
                  <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="28" strokeDashoffset="8" strokeLinecap="round" />
                </svg>
              ) : pushResult?.ok ? (
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                  <path d="M3 8.5L6.5 12L13 4" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                  <path d="M8 12V4M5 6.5L8 3.5L11 6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
              {pushResult?.ok
                ? "Pushed"
                : aheadBehind?.ahead
                  ? `Push ${aheadBehind.ahead}`
                  : "Push"}
            </button>

            {/* Push success popover */}
            {pushResult?.ok && (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  right: 0,
                  width: 200,
                  zIndex: 50,
                  backgroundColor: "var(--ezy-surface-raised)",
                  border: "1px solid var(--ezy-border)",
                  borderRadius: 6,
                  boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                  padding: "8px 10px",
                }}
              >
                <div className="flex items-center gap-1.5">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                    <path d="M3 8.5L6.5 12L13 4" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span className="text-[10px] font-medium" style={{ color: "#34d399" }}>
                    Push successful
                  </span>
                </div>
                {pushResult.branch && (
                  <div className="text-[10px] mt-1" style={{ color: "var(--ezy-text-secondary)" }}>
                    {pushResult.branch}
                    {pushResult.count ? ` — ${pushResult.count} commit${pushResult.count === 1 ? "" : "s"} pushed` : ""}
                  </div>
                )}
              </div>
            )}

            {/* Push error popover */}
            {pushError && (
              <div
                ref={pushErrorRef}
                style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  right: 0,
                  width: 280,
                  zIndex: 50,
                  backgroundColor: "var(--ezy-surface-raised)",
                  border: "1px solid var(--ezy-border)",
                  borderRadius: 6,
                  boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                  padding: "8px 10px",
                }}
              >
                <div className="text-[10px] font-medium" style={{ color: "#f87171", marginBottom: 6 }}>
                  Push failed
                </div>
                <pre
                  className="text-[10px]"
                  style={{
                    color: "var(--ezy-text-secondary)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    margin: 0,
                    lineHeight: 1.4,
                  }}
                >
                  {pushError}
                </pre>
                <button
                  onClick={() => setPushError(null)}
                  className="text-[10px] hover:opacity-80 transition-opacity mt-1.5"
                  style={{
                    color: "var(--ezy-text-muted)",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    padding: 0,
                  }}
                >
                  Dismiss
                </button>
              </div>
            )}
          </div>

          {/* 1px divider */}
          <div style={{ width: 1, height: 14, backgroundColor: "var(--ezy-border-subtle)", margin: "0 2px" }} />

          {/* Refresh */}
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            className="cursor-pointer hover:opacity-80 transition-opacity"
            style={{ color: "var(--ezy-text-muted)" }}
            onClick={() => {
              setLoading(true);
              fetchData();
            }}
          >
            <path
              d="M13 2.5v3h-3M3 13.5v-3h3"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M3.5 6A5 5 0 0112.5 5L13 5.5M12.5 10a5 5 0 01-9 1L3 10.5"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>

          {/* Expand / Collapse fullscreen */}
          {fullscreen ? (
            <FaCompress
              size={12}
              className="cursor-pointer hover:opacity-80 transition-opacity"
              style={{ color: "var(--ezy-text-muted)", flexShrink: 0 }}
              onClick={() => setFullscreen(false)}
            />
          ) : (
            <FaExpand
              size={12}
              className="cursor-pointer hover:opacity-80 transition-opacity"
              style={{ color: "var(--ezy-text-muted)", flexShrink: 0 }}
              onClick={() => setFullscreen(true)}
            />
          )}

          {/* Close */}
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            className="cursor-pointer hover:opacity-80 transition-opacity"
            style={{ color: "var(--ezy-text-muted)" }}
            onClick={() => { if (fullscreen) setFullscreen(false); else onClose(); }}
          >
            <path
              d="M4 4L12 12M12 4L4 12"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </div>

        {/* CSS keyframes for push spinner */}
        <style>{`
          @keyframes ezy-spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
        `}</style>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 flex">
        <CodeReviewFileList
          files={gitFiles}
          selectedFile={selectedFile}
          onSelectFile={setSelectedFile}
          collapsed={fileListCollapsed}
          onToggleCollapse={() => setFileListCollapsed((v) => !v)}
        />
        <CodeReviewDiffView
          fileDiffs={fileDiffs}
          selectedFile={selectedFile}
          onRevertHunk={handleRevertHunk}
          onDiscardFile={handleDiscardFile}
          onOpenInEditor={handleOpenInEditor}
          isGitRepo={isGitRepo}
          loading={loading}
          error={error}
        />
      </div>
    </div>
  );

  if (!fullscreen) return content;

  return (
    <>
      {/* Inline placeholder so the sidebar slot doesn't collapse */}
      <div style={{ width: "100%", height: "100%" }} />
      {/* Fullscreen overlay */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 200,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "rgba(0,0,0,0.6)",
        }}
        onClick={(e) => { if (e.target === e.currentTarget) setFullscreen(false); }}
      >
        <div
          style={{
            width: "95vw",
            height: "95vh",
            borderRadius: 10,
            overflow: "hidden",
            boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
            border: "1px solid var(--ezy-border)",
          }}
        >
          {content}
        </div>
      </div>
    </>
  );
}
