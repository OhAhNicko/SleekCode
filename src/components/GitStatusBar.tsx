import { useState, useEffect, useRef, useCallback, useId } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GitOverview } from "../types";
import { setCachedBranch } from "../lib/git-branch-cache";
import { gitOverview } from "../lib/git-invoke";
import { getGitOverviewSnapshot, setGitOverviewSnapshot } from "../lib/git-status-cache";
import { useAppStore } from "../store";
import { useOverlayPopupAnchor } from "../native-term/useOverlayPopupAnchor";
import { validateBranchName } from "../lib/git-branch-validate";

interface Props {
  workingDir: string;
  /** Set for a project on an SSH server. Reads route to the `git_*_ssh`
   *  commands; the write actions (pull, switch, create branch) are hidden,
   *  because they would run under the REMOTE machine's git identity and
   *  credentials rather than the user's. See `lib/git-invoke.ts`. */
  serverId?: string;
  compact?: boolean;
}

interface GitPullResult {
  ok: boolean;
  message: string;
  hasConflicts: boolean;
  conflicts: string[];
}

export default function GitStatusBar({ workingDir, serverId, compact = false }: Props) {
  /** Remote projects get the read-only bar: branch, dirty counts, ahead/behind. */
  const readOnly = !!serverId;
  // One instance per directory (both mount sites key on serverId:workingDir),
  // seeded SYNCHRONOUSLY from the snapshot cache: a tab switch paints the new
  // directory's last-known numbers on the same frame instead of showing the
  // previous tab's data for the whole fetch round trip.
  const [overview, setOverview] = useState<GitOverview | null>(() =>
    getGitOverviewSnapshot(workingDir, serverId),
  );
  const isGitRepo = overview?.isRepo ?? false;
  const branches = overview?.isRepo
    ? { current: overview.current, branches: overview.branches }
    : null;
  const diffStats = overview?.isRepo
    ? {
        filesChanged: overview.filesChanged,
        insertions: overview.insertions,
        deletions: overview.deletions,
      }
    : null;
  const aheadBehind = overview?.isRepo
    ? { ahead: overview.ahead, behind: overview.behind, hasRemote: overview.hasRemote }
    : null;
  const [showDropdown, setShowDropdown] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState("");
  const [pulling, setPulling] = useState(false);
  const [pullToast, setPullToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const pullWithRebase = useAppStore((s) => s.pullWithRebase);

  // Branch creation busy/error (form itself renders in the overlay)
  const [creatingBranchBusy, setCreatingBranchBusy] = useState(false);
  const [createBranchError, setCreateBranchError] = useState("");
  const triggerRef = useRef<HTMLDivElement>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Unique per mount — GitStatusBar mounts in both TabBar and VerticalTabBar.
  const menuId = `git-branch-menu-${useId()}`;

  // Sequential poll: wait for completion before scheduling next poll.
  // Prevents stacking when WSL git commands are slow.
  const mountedRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const fetchAll = useCallback(async () => {
    try {
      const ov = await gitOverview(workingDir, serverId);
      // Publish to the caches FIRST, and unconditionally: a fetch whose tab
      // was switched away mid-flight still warms the snapshot for the next
      // visit — it must never touch the live bar, though (mountedRef), or a
      // slow old-tab response would clobber the new tab's numbers.
      setGitOverviewSnapshot(workingDir, serverId, ov);
      // Shared branch cache: lets the right-click menu show the branch
      // synchronously instead of filling it in after the menu is open.
      setCachedBranch(
        workingDir,
        ov.isRepo ? { isRepo: true, branch: ov.current } : { isRepo: false },
      );
      if (mountedRef.current) setOverview(ov);
    } catch {
      // Hide the live bar, but keep the snapshot: a transient invoke failure
      // shouldn't cost the warm start on the next visit.
      if (mountedRef.current) setOverview(null);
    }
  }, [workingDir, serverId]);

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
    window.addEventListener("made:git-refresh", handler);
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      window.removeEventListener("made:git-refresh", handler);
    };
  }, [fetchAll, schedulePoll]);

  // Reset errors when the dropdown opens (the overlay menu owns search text,
  // the create form, outside-click dismiss, Escape and input focus).
  useEffect(() => {
    if (showDropdown) {
      setSwitchError("");
      setCreateBranchError("");
    }
  }, [showDropdown]);

  const handlePull = useCallback(async () => {
    if (pulling || !workingDir) return;
    setPulling(true);
    setPullToast(null);
    try {
      const result = await invoke<GitPullResult>("git_pull", {
        directory: workingDir,
        rebase: pullWithRebase,
      });
      if (result.ok) {
        setPullToast({ kind: "ok", msg: "Pulled" });
      } else if (result.hasConflicts) {
        setPullToast({
          kind: "err",
          msg: `Conflicts in ${result.conflicts.length} file${result.conflicts.length === 1 ? "" : "s"} — resolve in Code Review`,
        });
      } else {
        setPullToast({ kind: "err", msg: result.message || "Pull failed" });
      }
      window.dispatchEvent(new Event("made:git-refresh"));
      setTimeout(() => setPullToast(null), 4000);
    } catch (err) {
      const msg = typeof err === "string" ? err : (err as Error).message || "Pull failed";
      setPullToast({ kind: "err", msg });
      setTimeout(() => setPullToast(null), 4000);
    } finally {
      setPulling(false);
    }
  }, [pulling, workingDir, pullWithRebase]);

  const handleCreateBranch = useCallback(
    async (name: string, switchAfter: boolean) => {
      const trimmed = name.trim();
      const err = validateBranchName(trimmed);
      if (!trimmed || err || creatingBranchBusy) {
        if (err) setCreateBranchError(err);
        return;
      }
      setCreatingBranchBusy(true);
      setCreateBranchError("");
      try {
        await invoke("git_create_branch", {
          directory: workingDir,
          name: trimmed,
          fromRef: null,
          switch: switchAfter,
        });
        setShowDropdown(false);
        fetchAll();
      } catch (e) {
        setCreateBranchError(typeof e === "string" ? e : (e as Error).message || "Failed to create branch");
      } finally {
        setCreatingBranchBusy(false);
      }
    },
    [creatingBranchBusy, workingDir, fetchAll],
  );

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

  // Branch dropdown — overlay-rendered with focus handoff (search + create
  // inputs live in the overlay; data/busy/errors stream from here).
  useOverlayPopupAnchor({
    id: menuId,
    kind: "git-branch-menu",
    open: showDropdown && !!branches,
    anchorRef: triggerRef,
    payload:
      showDropdown && branches
        ? {
            branches: branches.branches,
            current: branches.current,
            creatingBusy: creatingBranchBusy,
            createError: createBranchError,
            switchError,
          }
        : null,
    onAction: (action, data) => {
      switch (action) {
        case "__dismiss__":
          setShowDropdown(false);
          break;
        case "switch": {
          const branch = (data as { branch?: string } | undefined)?.branch;
          if (branch) void handleSwitch(branch);
          setShowDropdown(false);
          break;
        }
        case "create": {
          const d = data as { name?: string; switchAfter?: boolean } | undefined;
          if (d?.name) void handleCreateBranch(d.name, d.switchAfter ?? true);
          break;
        }
        case "create-error-clear":
          setCreateBranchError("");
          break;
      }
    },
  });

  if (!isGitRepo || !branches) return null;

  const stats = diffStats ?? { filesChanged: 0, insertions: 0, deletions: 0 };
  const isDetached = branches.current === "HEAD";

  // Warp-exact: [branch-icon] main  [file-icon] 15186  •  +121819  -195
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: compact ? 3 : 8,
        flexWrap: compact ? "wrap" : "nowrap",
        rowGap: compact ? 2 : undefined,
        // The compact strip is 80px wide: rows have to CENTRE and the box must
        // never exceed it, or the diff numbers run off the right edge.
        justifyContent: compact ? "center" : undefined,
        width: compact ? "100%" : undefined,
        minWidth: 0,
        position: "relative",
        fontSize: compact ? 10 : 12,
        fontVariantNumeric: "tabular-nums",
        marginLeft: compact ? 0 : 6,
        marginRight: compact ? 0 : 6,
        color: "var(--ezy-text-muted)",
      }}
    >
      {/* Branch — clickable to open the switch/create dropdown, EXCEPT on
          remote projects: both of those actions run git locally, so on a
          remote project they would act on the wrong machine. Inert rather than
          disabled-looking — the branch name itself is still real information,
          and the tooltip says why there is nothing to click. */}
      <div
        ref={triggerRef}
        onClick={() => { if (!readOnly) setShowDropdown(!showDropdown); }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: compact ? 3 : 5,
          minWidth: 0,
          maxWidth: "100%",
          cursor: readOnly ? "default" : "pointer",
          padding: compact ? "1px 2px" : "2px 4px",
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
          backgroundColor: "transparent",
          transition: "background-color 120ms ease",
        }}
        onMouseEnter={(e) => { if (!readOnly) e.currentTarget.style.backgroundColor = "var(--ezy-surface)"; }}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
        data-tooltip={
          readOnly
            ? `${branches.current} — remote project, branch switching is local-only`
            : branches.current
        }
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
            maxWidth: compact ? 40 : 140,
            fontStyle: isDetached ? "italic" : undefined,
          }}
        >
          {branches.current}
        </span>
      </div>

      {/* Divider between branch and file count — hidden in compact mode (rows wrap instead) */}
      {!compact && (
        <div style={{ width: 1, height: 14, backgroundColor: "var(--ezy-border)", opacity: 0.5, flexShrink: 0 }} />
      )}

      {/* View changes — file count + bullet + diff stats as one clickable unit (Warp-style) */}
      <div
        onClick={() => window.dispatchEvent(new Event("made:open-codereview"))}
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: compact ? "wrap" : "nowrap",
          justifyContent: compact ? "center" : undefined,
          rowGap: compact ? 2 : undefined,
          gap: compact ? 3 : 6,
          minWidth: 0,
          maxWidth: "100%",
          cursor: "pointer",
          padding: compact ? "1px 2px" : "2px 4px",
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
          backgroundColor: "transparent",
          transition: "background-color 120ms ease",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--ezy-surface)")}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
        data-tooltip="View changes"
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
          <path
            d="M3.75 0A1.75 1.75 0 002 1.75v12.5c0 .966.784 1.75 1.75 1.75h8.5A1.75 1.75 0 0014 14.25V4.664a1.75 1.75 0 00-.513-1.237L10.573.513A1.75 1.75 0 009.336 0H3.75zM3.5 1.75a.25.25 0 01.25-.25h5.586a.25.25 0 01.177.073l2.914 2.914a.25.25 0 01.073.177v9.586a.25.25 0 01-.25.25h-8.5a.25.25 0 01-.25-.25V1.75z"
            fill="var(--ezy-text-muted)"
          />
        </svg>
        <span style={{ color: "var(--ezy-text-secondary)" }}>{stats.filesChanged}</span>
        {!compact && (
          <span style={{ color: "var(--ezy-text-muted)", opacity: 0.6, fontSize: "calc(var(--ezy-font-scale, 1) * 10px)", lineHeight: 1 }}>&bull;</span>
        )}
        <span style={{ color: "var(--ezy-diff-add)" }}>+{stats.insertions}</span>
        <span style={{ color: "var(--ezy-diff-remove)" }}>-{stats.deletions}</span>
      </div>

      {/* Pull button — only when behind the remote, and never on a remote
          project: `git_pull` runs on THIS machine, so offering it here would
          either fail or pull an unrelated local checkout. The behind-count
          above still shows, which is the information the button was for. */}
      {!readOnly && aheadBehind && aheadBehind.hasRemote && aheadBehind.behind > 0 && (
        <div
          onClick={(e) => {
            e.stopPropagation();
            if (!pulling) handlePull();
          }}
          data-tooltip={
            pullWithRebase
              ? `Pull with rebase — ${aheadBehind.behind} behind`
              : `Pull — ${aheadBehind.behind} behind`
          }
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            cursor: pulling ? "default" : "pointer",
            padding: "2px 4px",
            borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
            backgroundColor: "transparent",
            transition: "background-color 120ms ease",
            opacity: pulling ? 0.6 : 1,
          }}
          onMouseEnter={(e) => {
            if (!pulling) e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
          }}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
        >
          {pulling ? (
            <svg
              width="11"
              height="11"
              viewBox="0 0 16 16"
              fill="none"
              style={{ flexShrink: 0, animation: "ezy-spin 0.8s linear infinite" }}
            >
              <circle
                cx="8"
                cy="8"
                r="6"
                stroke="currentColor"
                strokeWidth="2"
                strokeDasharray="28"
                strokeDashoffset="8"
                strokeLinecap="round"
              />
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
              <path
                d="M8 4v8M5 9.5L8 12.5L11 9.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
          <span style={{ color: "var(--ezy-text-secondary)" }}>
            {compact ? aheadBehind.behind : `Pull ${aheadBehind.behind}`}
          </span>
        </div>
      )}

      {/* Branch switcher dropdown */}
      {/* Trailing divider — separates git stats from the toolbar icons that
          follow it in the HORIZONTAL bar. The vertical strip has nothing to its
          right, so the divider would just be a stray mark eating 3px of 80. */}
      {!compact && (
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
      )}

      {/* Branch dropdown — overlay-rendered (kind "git-branch-menu", hook above). */}

      {/* Pull toast */}
      {pullToast && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            zIndex: 120,
            padding: "6px 10px",
            backgroundColor: "var(--ezy-surface-raised)",
            border: "1px solid var(--ezy-border)",
            borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
            color: pullToast.kind === "ok" ? "#34d399" : "var(--ezy-red)",
            whiteSpace: "nowrap",
            maxWidth: 360,
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          data-tooltip={pullToast.msg}
        >
          {pullToast.msg}
        </div>
      )}
    </div>
  );
}
