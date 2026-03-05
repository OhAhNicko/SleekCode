import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { parseUnifiedDiff, buildHunkPatch } from "../lib/diff-parser";
import CodeReviewFileList from "./CodeReviewFileList";
import CodeReviewDiffView from "./CodeReviewDiffView";
import type {
  ComparisonMode,
  GitFileStatus,
  GitBranchInfo,
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

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

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

      const [statusResult, diffResult, branchResult] = await Promise.all([
        invoke<GitFileStatus[]>("git_status", { directory: workingDir }),
        invoke<string>("git_diff", {
          directory: workingDir,
          filePath: null,
          compareTo: compareArg ?? null,
        }),
        invoke<GitBranchInfo>("git_branches", { directory: workingDir }),
      ]);

      setGitFiles(statusResult);
      setFileDiffs(parseUnifiedDiff(diffResult));
      setBranches(branchResult);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [workingDir, getCompareArg]);

  // Initial fetch
  useEffect(() => {
    setLoading(true);
    fetchData();
  }, [fetchData]);

  // Poll every 2s
  useEffect(() => {
    pollRef.current = setInterval(fetchData, 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchData]);

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

  const modeLabel =
    comparisonMode === "uncommitted"
      ? "Uncommitted"
      : comparisonMode === "vs-main"
        ? "vs main"
        : `vs ${customBranch}`;

  return (
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

        {/* Right: refresh + close */}
        <div className="flex items-center gap-1">
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

          {/* Close */}
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            className="cursor-pointer hover:opacity-80 transition-opacity"
            style={{ color: "var(--ezy-text-muted)" }}
            onClick={onClose}
          >
            <path
              d="M4 4L12 12M12 4L4 12"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </div>
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
}
