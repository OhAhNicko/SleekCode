import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FaExpand, FaCompress } from "react-icons/fa6";
import { useAppStore } from "../store";
import { parseUnifiedDiff, buildHunkPatch } from "../lib/diff-parser";
import CodeReviewFileList from "./CodeReviewFileList";
import CodeReviewDiffView from "./CodeReviewDiffView";
import CommitPopover from "./CommitPopover";
import ConnectToGitHubModal from "./ConnectToGitHubModal";
import ReleaseModal from "./ReleaseModal";
import CreatePullRequestModal from "./CreatePullRequestModal";
import PaneSearchBar from "./PaneSearchBar";
import { useDomTextSearch } from "../hooks/usePaneSearch";
import { registerPaneSearch, unregisterPaneSearch } from "../lib/pane-search-registry";
import type {
  ComparisonMode,
  GitFileStatus,
  GitBranchInfo,
  GitAheadBehind,
  FileDiff,
} from "../types";

interface CodeReviewPaneProps {
  onClose: () => void;
  paneId?: string;
}

export default function CodeReviewPane({ onClose, paneId }: CodeReviewPaneProps) {
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
  const [showConnectModal, setShowConnectModal] = useState(false);
  const [connectedToast, setConnectedToast] = useState<string | null>(null);
  const [showReleaseModal, setShowReleaseModal] = useState(false);
  const [releasedToast, setReleasedToast] = useState(false);
  const [showPrModal, setShowPrModal] = useState(false);
  const [prStatus, setPrStatus] = useState<{
    exists: boolean;
    number: number | null;
    url: string | null;
    state: string | null;
    isDraft: boolean | null;
  } | null>(null);
  const [prToast, setPrToast] = useState<string | null>(null);
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);

  const currentBranch = branches?.current ?? "";
  // Heuristic: treat main / master / develop / trunk as "base" branches where
  // a PR from the current branch doesn't make sense.
  const isOnBaseBranch =
    currentBranch === "main" ||
    currentBranch === "master" ||
    currentBranch === "develop" ||
    currentBranch === "trunk";
  const canCreatePr = !!isGitRepo && aheadBehind?.hasRemote === true && !isOnBaseBranch;

  const dropdownRef = useRef<HTMLDivElement>(null);
  const commitBtnRef = useRef<HTMLDivElement>(null);
  const pushErrorRef = useRef<HTMLDivElement>(null);
  const diffSearchRef = useRef<HTMLDivElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const domSearch = useDomTextSearch(diffSearchRef);

  useEffect(() => {
    if (!paneId) return;
    registerPaneSearch(paneId, () => setSearchOpen(true));
    return () => unregisterPaneSearch(paneId);
  }, [paneId]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    domSearch.reset();
  }, [domSearch]);

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

  const defaultRepoName = (() => {
    if (!workingDir) return "";
    const parts = workingDir.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts[parts.length - 1] || "";
  })();

  const handleConnected = useCallback((url: string) => {
    setShowConnectModal(false);
    setConnectedToast(url || "Connected to GitHub");
    window.dispatchEvent(new Event("ezydev:git-refresh"));
    setTimeout(() => setConnectedToast(null), 4500);
  }, []);

  const handleCommitAndPush = useCallback(async () => {
    setShowCommitPopover(false);
    window.dispatchEvent(new Event("ezydev:git-refresh"));
    setPushing(true);
    setPushError(null);
    setPushResult(null);
    const prePushBranch = branches?.current ?? "";
    try {
      const msg = await invoke<string>("git_push", {
        directory: workingDir,
        setUpstream: !aheadBehind?.hasRemote,
      });
      setPushResult({ ok: true, msg, branch: prePushBranch, count: 1 });
      window.dispatchEvent(new Event("ezydev:git-refresh"));
      setTimeout(() => setPushResult(null), 3000);
    } catch (err) {
      setPushError(String(err));
    } finally {
      setPushing(false);
    }
  }, [workingDir, aheadBehind, branches]);

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

  // Fetch remote URL once per workingDir so we know where "Issues" links to.
  useEffect(() => {
    if (!isGitRepo || !workingDir || aheadBehind?.hasRemote !== true) {
      setRemoteUrl(null);
      return;
    }
    let cancelled = false;
    invoke<{ url: string; owner: string; repo: string }>("git_remote_info", {
      directory: workingDir,
    })
      .then((r) => {
        if (cancelled) return;
        setRemoteUrl(r.url && r.url.includes("github.com") ? r.url : null);
      })
      .catch(() => {
        if (!cancelled) setRemoteUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isGitRepo, workingDir, aheadBehind?.hasRemote]);

  // Probe PR status when the branch has a remote and isn't the base branch.
  // Refetch on branch change or working-dir change.
  useEffect(() => {
    if (!canCreatePr || !workingDir) {
      setPrStatus(null);
      return;
    }
    let cancelled = false;
    invoke<{
      exists: boolean;
      number: number | null;
      url: string | null;
      state: string | null;
      title: string | null;
      isDraft: boolean | null;
    }>("gh_pr_status", { directory: workingDir })
      .then((s) => {
        if (cancelled) return;
        setPrStatus({
          exists: s.exists,
          number: s.number,
          url: s.url,
          state: s.state,
          isDraft: s.isDraft,
        });
      })
      .catch(() => {
        if (!cancelled) setPrStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [canCreatePr, workingDir, currentBranch]);

  const openExternalUrl = useCallback((url: string) => {
    invoke("plugin:opener|open_url", { url }).catch(() => {
      window.open(url, "_blank");
    });
  }, []);

  const handleOpenPrFlow = useCallback(async () => {
    if (!workingDir) return;
    // If a PR already exists, just open it.
    if (prStatus?.exists && prStatus.url) {
      openExternalUrl(prStatus.url);
      return;
    }
    // Check gh auth first — route to ConnectToGitHubModal if not signed in.
    try {
      const gh = await invoke<{ installed: boolean; authed: boolean }>(
        "gh_status",
        { directory: workingDir },
      );
      if (!gh.installed || !gh.authed) {
        setShowConnectModal(true);
        return;
      }
    } catch {
      setShowConnectModal(true);
      return;
    }
    setShowPrModal(true);
  }, [workingDir, prStatus, openExternalUrl]);

  const handlePrCreated = useCallback(
    (url: string) => {
      setShowPrModal(false);
      setPrToast(url || "Pull request opened");
      // Refetch status so the button flips to "View PR".
      invoke<{
        exists: boolean;
        number: number | null;
        url: string | null;
        state: string | null;
        title: string | null;
        isDraft: boolean | null;
      }>("gh_pr_status", { directory: workingDir })
        .then((s) =>
          setPrStatus({
            exists: s.exists,
            number: s.number,
            url: s.url,
            state: s.state,
            isDraft: s.isDraft,
          }),
        )
        .catch(() => {});
      setTimeout(() => setPrToast(null), 4500);
    },
    [workingDir],
  );

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
    <div
      className="flex flex-col h-full w-full"
      data-pane-id={paneId}
      style={{ backgroundColor: "var(--ezy-bg)", position: "relative" }}
    >
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
                onCommitAndPush={handleCommitAndPush}
              />
            )}
          </div>

          {/* Connect to GitHub — shown only when current branch has no upstream */}
          {isGitRepo && aheadBehind && !aheadBehind.hasRemote && (
            <button
              onClick={() => setShowConnectModal(true)}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-opacity hover:opacity-80"
              style={{
                backgroundColor: "#1f2937",
                color: "#fff",
                border: "1px solid #1f2937",
              }}
              title="Create a GitHub repository and push this project"
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 005.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
              </svg>
              Connect
            </button>
          )}

          {/* Release — shown when repo has an upstream (otherwise no-op to push a tag) */}
          {isGitRepo && aheadBehind?.hasRemote && (
            <button
              onClick={() => setShowReleaseModal(true)}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-opacity hover:opacity-80"
              style={{
                backgroundColor: "transparent",
                color: "var(--ezy-text-secondary)",
                border: "1px solid var(--ezy-border-subtle)",
              }}
              title="Bump version, commit, tag, and push"
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M3 2h7l3 3v9H3V2z"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M10 2v3h3"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Release
            </button>
          )}

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

          {/* Issues link — opens remote /issues in default browser */}
          {remoteUrl && (
            <button
              onClick={() => openExternalUrl(`${remoteUrl}/issues`)}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-opacity hover:opacity-80"
              style={{
                backgroundColor: "transparent",
                color: "var(--ezy-text-secondary)",
                border: "1px solid var(--ezy-border-subtle)",
              }}
              title="Open issues on GitHub"
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle
                  cx="8"
                  cy="8"
                  r="6"
                  stroke="currentColor"
                  strokeWidth="1.3"
                />
                <circle cx="8" cy="8" r="1.3" fill="currentColor" />
              </svg>
              Issues
            </button>
          )}

          {/* Pull Request button */}
          {canCreatePr && (
            <button
              onClick={handleOpenPrFlow}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-opacity hover:opacity-80"
              style={{
                backgroundColor: "transparent",
                color: "var(--ezy-text-secondary)",
                border: "1px solid var(--ezy-border-subtle)",
              }}
              title={
                prStatus?.exists
                  ? `View PR #${prStatus.number} on GitHub`
                  : "Open a pull request for this branch"
              }
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M5 2.5a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zM5 13.5a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zM14 13.5a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zM3.5 4v8M10 4a3 3 0 013 3v5"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {prStatus?.exists
                ? `PR #${prStatus.number}${
                    prStatus.state === "MERGED"
                      ? " (merged)"
                      : prStatus.state === "CLOSED"
                        ? " (closed)"
                        : prStatus.isDraft
                          ? " (draft)"
                          : ""
                  }`
                : "Open PR"}
            </button>
          )}

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

      {/* Connect-success toast */}
      {connectedToast && (
        <div
          style={{
            position: "absolute",
            top: 36,
            right: 10,
            zIndex: 150,
            padding: "8px 12px",
            backgroundColor: "var(--ezy-surface-raised)",
            border: "1px solid var(--ezy-border)",
            borderRadius: 6,
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            maxWidth: 340,
          }}
        >
          <div className="flex items-center gap-1.5">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
              <path d="M3 8.5L6.5 12L13 4" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="text-[11px] font-medium" style={{ color: "#34d399" }}>
              Connected to GitHub
            </span>
          </div>
          {connectedToast.startsWith("http") && (
            <div
              className="text-[10px] mt-1"
              style={{
                color: "var(--ezy-text-secondary)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {connectedToast}
            </div>
          )}
        </div>
      )}

      {/* Connect modal */}
      {showConnectModal && (
        <ConnectToGitHubModal
          workingDir={workingDir}
          defaultName={defaultRepoName}
          onClose={() => setShowConnectModal(false)}
          onConnected={handleConnected}
        />
      )}

      {/* Release modal */}
      {showReleaseModal && (
        <ReleaseModal
          workingDir={workingDir}
          onClose={() => setShowReleaseModal(false)}
          onReleased={() => {
            setReleasedToast(true);
            window.dispatchEvent(new Event("ezydev:git-refresh"));
            setTimeout(() => setReleasedToast(false), 4500);
          }}
        />
      )}

      {/* Create PR modal */}
      {showPrModal && branches && (
        <CreatePullRequestModal
          workingDir={workingDir}
          currentBranch={currentBranch}
          branches={branches.branches}
          onClose={() => setShowPrModal(false)}
          onCreated={handlePrCreated}
        />
      )}

      {/* PR opened toast */}
      {prToast && (
        <div
          style={{
            position: "absolute",
            top: 36,
            right: 10,
            zIndex: 150,
            padding: "8px 12px",
            backgroundColor: "var(--ezy-surface-raised)",
            border: "1px solid var(--ezy-border)",
            borderRadius: 6,
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            maxWidth: 340,
          }}
        >
          <div className="flex items-center gap-1.5">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
              <path
                d="M3 8.5L6.5 12L13 4"
                stroke="#34d399"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="text-[11px] font-medium" style={{ color: "#34d399" }}>
              Pull request opened
            </span>
          </div>
          {prToast.startsWith("http") && (
            <button
              onClick={() => openExternalUrl(prToast)}
              className="text-[10px] mt-1 underline"
              style={{
                color: "var(--ezy-text-secondary)",
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              View on GitHub
            </button>
          )}
        </div>
      )}

      {/* Released toast */}
      {releasedToast && (
        <div
          style={{
            position: "absolute",
            top: 36,
            right: 10,
            zIndex: 150,
            padding: "8px 12px",
            backgroundColor: "var(--ezy-surface-raised)",
            border: "1px solid var(--ezy-border)",
            borderRadius: 6,
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            maxWidth: 340,
          }}
        >
          <div className="flex items-center gap-1.5">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
              <path
                d="M3 8.5L6.5 12L13 4"
                stroke="#34d399"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="text-[11px] font-medium" style={{ color: "#34d399" }}>
              Release tag pushed
            </span>
          </div>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 min-h-0 flex">
        <CodeReviewFileList
          files={gitFiles}
          selectedFile={selectedFile}
          onSelectFile={setSelectedFile}
          collapsed={fileListCollapsed}
          onToggleCollapse={() => setFileListCollapsed((v) => !v)}
        />
        <div
          ref={diffSearchRef}
          style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
        >
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
          {searchOpen && (
            <PaneSearchBar
              {...domSearch}
              onClose={closeSearch}
              isActive={true}
            />
          )}
        </div>
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
