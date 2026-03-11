import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GitBranchInfo, GitDiffStats } from "../types";

interface Props {
  workingDir: string;
}

export default function GitStatusBar({ workingDir }: Props) {
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [branches, setBranches] = useState<GitBranchInfo | null>(null);
  const [diffStats, setDiffStats] = useState<GitDiffStats | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [branchSearch, setBranchSearch] = useState("");
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Sequential poll: wait for completion before scheduling next poll.
  // Prevents stacking when WSL git commands are slow.
  const mountedRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const fetchAll = useCallback(async () => {
    try {
      const repo = await invoke<boolean>("git_is_repo", { directory: workingDir });
      setIsGitRepo(repo);
      if (!repo) return;

      const [br, ds] = await Promise.allSettled([
        invoke<GitBranchInfo>("git_branches", { directory: workingDir }),
        invoke<GitDiffStats>("git_diff_stats", { directory: workingDir }),
      ]);
      if (br.status === "fulfilled") setBranches(br.value);
      if (ds.status === "fulfilled") {
        setDiffStats(ds.value);
      } else {
        setDiffStats({ filesChanged: 0, insertions: 0, deletions: 0 });
      }
    } catch {
      setIsGitRepo(false);
    }
  }, [workingDir]);

  const schedulePoll = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      if (!mountedRef.current) return;
      await fetchAll();
      if (mountedRef.current) schedulePoll();
    }, 20000);
  }, [fetchAll]);

  useEffect(() => {
    mountedRef.current = true;
    fetchAll().then(() => { if (mountedRef.current) schedulePoll(); });
    const handler = () => {
      fetchAll();
      // Reset poll timer so we don't double-fetch right after an event
      if (mountedRef.current) schedulePoll();
    };
    window.addEventListener("ezydev:git-refresh", handler);
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      window.removeEventListener("ezydev:git-refresh", handler);
    };
  }, [fetchAll, schedulePoll]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        triggerRef.current && !triggerRef.current.contains(e.target as Node)
      ) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Close dropdown on Escape
  useEffect(() => {
    if (!showDropdown) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowDropdown(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [showDropdown]);

  // Auto-focus search when dropdown opens
  useEffect(() => {
    if (showDropdown) {
      setBranchSearch("");
      setSwitchError("");
      setTimeout(() => searchRef.current?.focus(), 0);
    }
  }, [showDropdown]);

  const handleSwitch = async (branch: string) => {
    if (switching) return;
    setSwitching(true);
    setSwitchError("");
    try {
      await invoke("git_switch_branch", { directory: workingDir, branch });
      setShowDropdown(false);
      fetchAll();
    } catch (err) {
      const msg = typeof err === "string" ? err : (err as Error).message || "Switch failed";
      setSwitchError(msg);
      if (errorTimer.current) clearTimeout(errorTimer.current);
      errorTimer.current = setTimeout(() => setSwitchError(""), 3000);
    } finally {
      setSwitching(false);
    }
  };

  if (!isGitRepo || !branches) return null;

  const stats = diffStats ?? { filesChanged: 0, insertions: 0, deletions: 0 };
  const isDetached = branches.current === "HEAD";

  const filtered = branches.branches.filter(
    (b) => b.toLowerCase().includes(branchSearch.toLowerCase())
  );

  // Warp-exact: [branch-icon] main  [file-icon] 15186  •  +121819  -195
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        position: "relative",
        fontSize: 12,
        fontVariantNumeric: "tabular-nums",
        marginLeft: 6,
        marginRight: 6,
        color: "var(--ezy-text-muted)",
      }}
    >
      {/* Branch — clickable to open dropdown */}
      <div
        ref={triggerRef}
        onClick={() => setShowDropdown(!showDropdown)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          cursor: "pointer",
          padding: "2px 4px",
          borderRadius: 3,
          backgroundColor: "transparent",
          transition: "background-color 120ms ease",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--ezy-surface)")}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
        title={branches.current}
      >
        {/* Git branch icon */}
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
          <path
            d="M5 3.25a2.25 2.25 0 114.5 0 2.25 2.25 0 01-4.5 0zM7.25 1.75a1.5 1.5 0 100 3 1.5 1.5 0 000-3zM4 12.75a2.25 2.25 0 114.5 0 2.25 2.25 0 01-4.5 0zM6.25 11.5a1.25 1.25 0 100 2.5 1.25 1.25 0 000-2.5z"
            fill="var(--ezy-text-muted)"
          />
          <path d="M7.25 5.5v5.25" stroke="var(--ezy-text-muted)" strokeWidth="1.5" />
        </svg>
        <span
          style={{
            color: isDetached ? "var(--ezy-text-muted)" : "var(--ezy-text-secondary)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: 140,
            fontStyle: isDetached ? "italic" : undefined,
          }}
        >
          {branches.current}
        </span>
      </div>

      {/* Divider between branch and file count */}
      <div style={{ width: 1, height: 14, backgroundColor: "var(--ezy-border)", opacity: 0.5, flexShrink: 0 }} />

      {/* View changes — file count + bullet + diff stats as one clickable unit (Warp-style) */}
      <div
        onClick={() => window.dispatchEvent(new Event("ezydev:open-codereview"))}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          cursor: "pointer",
          padding: "2px 4px",
          borderRadius: 3,
          backgroundColor: "transparent",
          transition: "background-color 120ms ease",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--ezy-surface)")}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
        title="View changes"
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
          <path
            d="M3.75 0A1.75 1.75 0 002 1.75v12.5c0 .966.784 1.75 1.75 1.75h8.5A1.75 1.75 0 0014 14.25V4.664a1.75 1.75 0 00-.513-1.237L10.573.513A1.75 1.75 0 009.336 0H3.75zM3.5 1.75a.25.25 0 01.25-.25h5.586a.25.25 0 01.177.073l2.914 2.914a.25.25 0 01.073.177v9.586a.25.25 0 01-.25.25h-8.5a.25.25 0 01-.25-.25V1.75z"
            fill="var(--ezy-text-muted)"
          />
        </svg>
        <span style={{ color: "var(--ezy-text-secondary)" }}>{stats.filesChanged}</span>
        <span style={{ color: "var(--ezy-text-muted)", opacity: 0.6, fontSize: 10, lineHeight: 1 }}>&bull;</span>
        <span style={{ color: "var(--ezy-accent)" }}>+{stats.insertions}</span>
        <span style={{ color: "var(--ezy-red)" }}>-{stats.deletions}</span>
      </div>

      {/* Branch switcher dropdown */}
      {/* Trailing divider — separates git stats from toolbar icons */}
      <div
        style={{
          width: 1,
          height: 14,
          backgroundColor: "var(--ezy-text-muted)",
          opacity: 0.2,
          flexShrink: 0,
          marginLeft: 2,
        }}
      />

      {showDropdown && (
        <div
          ref={dropdownRef}
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            width: 260,
            maxHeight: 300,
            overflowY: "auto",
            backgroundColor: "var(--ezy-surface-raised)",
            border: "1px solid var(--ezy-border)",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            zIndex: 100,
          }}
        >
          {/* Search */}
          <div style={{ padding: "6px 6px 4px" }}>
            <input
              ref={searchRef}
              value={branchSearch}
              onChange={(e) => setBranchSearch(e.target.value)}
              placeholder="Search branches..."
              style={{
                width: "100%",
                background: "var(--ezy-bg)",
                border: "1px solid var(--ezy-border)",
                borderRadius: 4,
                padding: "5px 8px",
                fontSize: 12,
                color: "var(--ezy-text-secondary)",
                outline: "none",
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = "var(--ezy-accent)")}
              onBlur={(e) => (e.currentTarget.style.borderColor = "var(--ezy-border)")}
            />
          </div>

          {/* Branch list */}
          <div style={{ padding: "2px 4px 4px" }}>
            {filtered.length === 0 && (
              <div style={{ padding: "8px 12px", fontSize: 12, color: "var(--ezy-text-muted)" }}>
                No branches found
              </div>
            )}
            {filtered.map((b) => {
              const isCurrent = b === branches.current;
              return (
                <div
                  key={b}
                  onClick={() => !isCurrent && handleSwitch(b)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "5px 8px",
                    borderRadius: 4,
                    cursor: isCurrent ? "default" : "pointer",
                    backgroundColor: isCurrent ? "var(--ezy-accent)" : "transparent",
                    transition: "background-color 100ms ease",
                  }}
                  onMouseEnter={(e) => {
                    if (!isCurrent) e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
                  }}
                  onMouseLeave={(e) => {
                    if (!isCurrent) e.currentTarget.style.backgroundColor = isCurrent ? "var(--ezy-accent)" : "transparent";
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                    <path
                      d="M5 3.25a2.25 2.25 0 114.5 0 2.25 2.25 0 01-4.5 0zM7.25 1.75a1.5 1.5 0 100 3 1.5 1.5 0 000-3zM4 12.75a2.25 2.25 0 114.5 0 2.25 2.25 0 01-4.5 0zM6.25 11.5a1.25 1.25 0 100 2.5 1.25 1.25 0 000-2.5z"
                      fill={isCurrent ? "white" : "var(--ezy-text-muted)"}
                    />
                    <path
                      d="M7.25 5.5v5.25"
                      stroke={isCurrent ? "white" : "var(--ezy-text-muted)"}
                      strokeWidth="1.5"
                    />
                  </svg>
                  <span
                    style={{
                      fontSize: 12,
                      color: isCurrent ? "white" : "var(--ezy-text-secondary)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      flex: 1,
                      fontWeight: isCurrent ? 500 : 400,
                    }}
                  >
                    {b}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Switch error */}
          {switchError && (
            <div
              style={{
                padding: "6px 12px",
                fontSize: 11,
                color: "var(--ezy-red)",
                borderTop: "1px solid var(--ezy-border)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {switchError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
