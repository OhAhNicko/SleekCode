/**
 * Session context poll — the single source of the header's model / context % /
 * cost / session-name / rate-limit data, shared by BOTH terminal renderers.
 *
 * This used to live inline in TerminalPaneXterm. TerminalPaneNative had a
 * stripped-down copy that only polled once the pane had locked its own session,
 * so native panes showed a bare `Claude Code · path` header — TerminalHeader
 * gates its whole right-hand info block on `contextInfo` being non-null — and
 * never got late detection, drift detection or registry auto-naming. Keeping one
 * implementation is the point: a renderer-specific copy is exactly how the two
 * headers drifted apart in the first place.
 *
 * Side effects owned here (all previously inside the xterm poll):
 *   • contextInfo state, with rate-limit merge across partial reads
 *   • "__latest__" ambiguity suppression when a sibling pane shares the cwd
 *   • late session detection (pane never locked a session)
 *   • session drift detection every 6th poll (~30s), e.g. after CLI /resume
 *   • project-session registry insert + auto-naming from the CLI's own title
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import type { TerminalType, TerminalBackend } from "../types";
import { readSessionContext, type ContextInfo } from "../lib/context-parser";
import { supportsSessionResume } from "../lib/session-resume";
import { toWslPath } from "../lib/terminal-config";
import { getCachedDistro } from "../lib/wsl-cache";
import {
  claimedSessionIds,
  claimSessionId,
  lookupClaudeBySpawn,
  newerResumablePaneStillResolving,
  otherResumablePaneSharesDir,
  sessionDebug,
} from "../lib/session-dedup";

interface UseSessionContextArgs {
  terminalId: string;
  terminalType: TerminalType;
  workingDir: string;
  /** Live session id this pane owns, or undefined while unlocked. */
  sessionResumeId?: string;
  /** Refs so the effect can stay mounted across prop changes (xterm parity). */
  serverIdRef: React.MutableRefObject<string | undefined>;
  backendRef: React.MutableRefObject<TerminalBackend | undefined>;
  workingDirRef: React.MutableRefObject<string>;
  /** First-PTY-data timestamp minus cushion; floor for spawn-based lookups. */
  ptySpawnTimeRef: React.MutableRefObject<number>;
  /** Eagerly-updated mirror of the sessionResumeId prop. */
  sessionResumeIdPropRef: React.MutableRefObject<string | undefined>;
  onSessionResumeIdRef: React.MutableRefObject<((id: string) => void) | undefined>;
  setSessionTrusted: (trusted: boolean) => void;
}

export interface UseSessionContextResult {
  contextInfo: ContextInfo | null;
  setContextInfo: React.Dispatch<React.SetStateAction<ContextInfo | null>>;
  /** Manual re-read (header click). No drift/registry side effects. */
  refreshContext: () => Promise<void>;
}

/** CLI types that write a readable session transcript. */
function contextSupported(type: TerminalType): boolean {
  return type === "claude" || type === "codex" || type === "gemini";
}

export function useSessionContext({
  terminalId,
  terminalType,
  workingDir,
  sessionResumeId,
  serverIdRef,
  backendRef,
  workingDirRef,
  ptySpawnTimeRef,
  sessionResumeIdPropRef,
  onSessionResumeIdRef,
  setSessionTrusted,
}: UseSessionContextArgs): UseSessionContextResult {
  const [contextInfo, setContextInfo] = useState<ContextInfo | null>(null);

  // Periodically read context percentage from CLI session JSONL files.
  // Starts immediately — backend searches all recent sessions when no
  // specific session ID is available yet. Once sessionResumeId is
  // discovered, polls switch to the specific session for precise data.
  useEffect(() => {
    if (!contextSupported(terminalType)) return;

    let pollCount = 0;

    const poll = async () => {
      const isSsh = !!serverIdRef.current;
      const backend = isSsh
        ? "ssh"
        : (backendRef.current ?? useAppStore.getState().terminalBackend ?? "wsl");
      const info = await readSessionContext(terminalType, sessionResumeId || undefined, backend, serverIdRef.current, isSsh ? workingDirRef.current : undefined);
      if (info !== null) {
        // When this pane hasn't locked its own session, `info` came from the
        // "__latest__" fallback. That's only safe to display if no sibling
        // resumable pane shares this working dir — otherwise it may be another
        // pane's session. Suppress display (but keep late detection below).
        const latestIsAmbiguous =
          !sessionResumeId && otherResumablePaneSharesDir(terminalId, workingDir.replace(/\\/g, "/"));
        if (latestIsAmbiguous) {
          setContextInfo(null);
        } else {
          // Merge partial updates — rate_limits and info come from different
          // server events. Keep previous rate_limits when new poll has none.
          setContextInfo((prev) => ({
            ...info,
            rateLimitFiveHour: info.rateLimitFiveHour ?? prev?.rateLimitFiveHour ?? null,
            rateLimitWeekly: info.rateLimitWeekly ?? prev?.rateLimitWeekly ?? null,
          }));
        }
        // Auto-update session name in registry from CLI output.
        // Claude: CUSTOM_TITLE only appears from /rename → authoritative (always overrides).
        // Codex/Gemini: auto-generated titles → soft update (won't override MADE renames).
        // Late session detection: if we still don't have a sessionResumeId,
        // try precise (spawn-based) lookup first, then mtime-based as fallback.
        if (!sessionResumeId && supportsSessionResume(terminalType)) {
          try {
            const type = terminalType;
            const excludeIds = [...claimedSessionIds];
            let id: string | null = null;
            const isSsh = backend === "ssh";
            const sshServer = isSsh
              ? useAppStore.getState().servers.find((s) => s.id === serverIdRef.current)
              : undefined;
            // Precise spawn-based lookup for Claude (only session files started
            // after this pane's PTY spawned, in this exact cwd). Skipped for SSH.
            if (type === "claude" && ptySpawnTimeRef.current > 0 && !isSsh) {
              id = await lookupClaudeBySpawn(backend, workingDir, ptySpawnTimeRef.current, excludeIds, "late");
            }
            // Fallback: mtime-based for Codex/Gemini, or Claude if precise lookup returned nothing.
            if (!id) {
              if (isSsh && sshServer && sshServer.authMethod === "ssh-key" && sshServer.sshKeyPath) {
                const sshArgs = {
                  host: sshServer.host,
                  username: sshServer.username,
                  identityFile: sshServer.sshKeyPath,
                  remoteProjectPath: workingDir,
                  excludeIds,
                  maxAgeSecs: null,
                };
                if (type === "claude") id = await invoke<string | null>("get_claude_session_id_ssh", sshArgs);
                else if (type === "codex") id = await invoke<string | null>("get_codex_session_id_ssh", sshArgs);
                else if (type === "gemini") id = await invoke<string | null>("get_gemini_session_id_ssh", sshArgs);
              } else if (backend === "native") {
                const cwd = workingDir;
                if (type === "claude") id = await invoke<string | null>("get_claude_session_id_native", { projectPath: cwd, excludeIds });
                else if (type === "codex") id = await invoke<string | null>("get_codex_session_id_native", { projectPath: cwd, excludeIds });
                else if (type === "gemini") id = await invoke<string | null>("get_gemini_session_id_native", { projectPath: cwd, excludeIds });
              } else if (backend === "windows") {
                const cwd = workingDir;
                if (type === "claude") id = await invoke<string | null>("get_claude_session_id_windows", { projectPath: cwd, excludeIds });
                else if (type === "codex") id = await invoke<string | null>("get_codex_session_id_windows", { projectPath: cwd, excludeIds });
                else if (type === "gemini") id = await invoke<string | null>("get_gemini_session_id_windows", { projectPath: cwd, excludeIds });
              } else {
                const wslCwd = toWslPath(workingDir);
                if (wslCwd) {
                  if (type === "claude") id = await invoke<string | null>("get_claude_session_id", { projectPath: wslCwd, excludeIds, distro: getCachedDistro() });
                  else if (type === "codex") id = await invoke<string | null>("get_codex_session_id", { projectPath: wslCwd, excludeIds, distro: getCachedDistro() });
                  else if (type === "gemini") id = await invoke<string | null>("get_gemini_session_id", { projectPath: wslCwd, excludeIds, distro: getCachedDistro() });
                }
              }
            }
            if (id) {
              const deferred = newerResumablePaneStillResolving(terminalId);
              if (!deferred && claimSessionId(id)) {
                console.log(`[SessionResume] late detection found: ${id.slice(0, 8)}`);
                setSessionTrusted(true);
                sessionResumeIdPropRef.current = id;
                onSessionResumeIdRef.current?.(id);
              } else {
                sessionDebug("late detection NOT adopted", { id: id.slice(0, 8), deferredToNewerPane: deferred, alreadyClaimed: claimedSessionIds.has(id) });
              }
            }
          } catch (e) {
            console.error("[SessionResume] late detection failed:", e);
          }
        }
        if (sessionResumeId) {
          const store = useAppStore.getState();
          const key = workingDir.replace(/\\/g, "/");
          const existing = (store.projectSessions[key] ?? []).find((s) => s.id === sessionResumeId);
          const autoName = info.sessionName || info.summary;

          // Ensure session exists in registry (disk detection doesn't register)
          if (!existing) {
            store.registerProjectSession(workingDir, {
              id: sessionResumeId,
              name: autoName || "",
              type: terminalType,
              createdAt: Date.now(),
              isRenamed: false,
            });
          } else if (autoName) {
            if (terminalType === "claude") {
              // Claude /rename is intentional — always override, even MADE user renames
              if (existing.name !== autoName) {
                store.renameProjectSession(workingDir, sessionResumeId, autoName);
              }
            } else {
              // Codex/Gemini auto-titles — only update if user hasn't renamed in MADE
              store.updateProjectSessionAutoName(workingDir, sessionResumeId, autoName);
            }
          }
        }

        // Session drift detection: every 6th poll (~30s), check if the CLI
        // switched sessions via /resume. For Claude, only consider session
        // files started AFTER this pane's PTY spawn — prevents stealing
        // another pane's session.
        pollCount++;
        if (sessionResumeId && supportsSessionResume(terminalType) && pollCount % 6 === 0) {
          try {
            const type = terminalType;
            const excludeIds = [...claimedSessionIds].filter((id) => id !== sessionResumeId);
            let newId: string | null = null;
            if (type === "claude" && ptySpawnTimeRef.current > 0) {
              // Precise spawn-based drift check
              newId = await lookupClaudeBySpawn(backend, workingDir, ptySpawnTimeRef.current, excludeIds, "drift");
            } else {
              // Codex/Gemini keep the mtime-based approach for drift
              if (backend === "native") {
                const cwd = workingDir;
                if (type === "codex") newId = await invoke<string | null>("get_codex_session_id_native", { projectPath: cwd, excludeIds });
                else if (type === "gemini") newId = await invoke<string | null>("get_gemini_session_id_native", { projectPath: cwd, excludeIds });
              } else if (backend === "windows") {
                const cwd = workingDir;
                if (type === "codex") newId = await invoke<string | null>("get_codex_session_id_windows", { projectPath: cwd, excludeIds });
                else if (type === "gemini") newId = await invoke<string | null>("get_gemini_session_id_windows", { projectPath: cwd, excludeIds });
              } else {
                const wslCwd = toWslPath(workingDir);
                if (wslCwd) {
                  if (type === "codex") newId = await invoke<string | null>("get_codex_session_id", { projectPath: wslCwd, excludeIds, distro: getCachedDistro() });
                  else if (type === "gemini") newId = await invoke<string | null>("get_gemini_session_id", { projectPath: wslCwd, excludeIds, distro: getCachedDistro() });
                }
              }
            }
            if (newId && newId !== sessionResumeId) {
              const deferred = newerResumablePaneStillResolving(terminalId);
              if (!deferred && claimSessionId(newId)) {
                console.log(`[SessionResume] drift detected: ${sessionResumeId.slice(0, 8)} → ${newId.slice(0, 8)}`);
                claimedSessionIds.delete(sessionResumeId);
                setSessionTrusted(true);
                sessionResumeIdPropRef.current = newId;
                onSessionResumeIdRef.current?.(newId);
              } else {
                sessionDebug("drift NOT adopted", { from: sessionResumeId.slice(0, 8), to: newId.slice(0, 8), deferredToNewerPane: deferred, alreadyClaimed: claimedSessionIds.has(newId) });
              }
            }
          } catch (e) {
            console.error("[SessionResume] drift check failed:", e);
          }
        }
      }
      // On null, retain previous value (stale > absent)
    };

    // Short delay (2s) for WSL to be ready on cold start, then poll.
    // If data isn't available yet, null is returned and we retain the previous value.
    //
    // Remote panes poll far less often. A local read is a file read; an SSH
    // read is an entire new ssh connection, because Windows OpenSSH has no
    // ControlMaster and `ssh_exec_internal` therefore cannot multiplex — so
    // every poll pays a full TCP + crypto handshake. At 5s, four remote panes
    // would open ~48 connections a minute across Tailscale for a header that
    // changes slowly.
    const intervalMs = serverIdRef.current ? 15_000 : 5_000;
    const startTimer = setTimeout(() => {
      poll();
      intervalId = setInterval(poll, intervalMs);
    }, 2000);
    let intervalId: ReturnType<typeof setInterval> | undefined;

    return () => {
      clearTimeout(startTimer);
      if (intervalId) clearInterval(intervalId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalType, sessionResumeId, terminalId, workingDir]);

  // Manual context refresh — called when the user clicks the context-left
  // percentage in TerminalHeader. Same read path as the periodic poll, minus
  // the session-drift / registry side-effects (those stay on the timer).
  const refreshContext = useCallback(async () => {
    if (!contextSupported(terminalType)) return;
    const isSsh = !!serverIdRef.current;
    const backend = isSsh
      ? "ssh"
      : (backendRef.current ?? useAppStore.getState().terminalBackend ?? "wsl");
    const info = await readSessionContext(terminalType, sessionResumeId || undefined, backend, serverIdRef.current, isSsh ? workingDirRef.current : undefined);
    if (info !== null) {
      // Don't display an ambiguous "__latest__" result that may belong to a
      // sibling pane in the same dir (see the poll for the full rationale).
      if (!sessionResumeId && otherResumablePaneSharesDir(terminalId, workingDir.replace(/\\/g, "/"))) {
        return;
      }
      setContextInfo((prev) => ({
        ...info,
        rateLimitFiveHour: info.rateLimitFiveHour ?? prev?.rateLimitFiveHour ?? null,
        rateLimitWeekly: info.rateLimitWeekly ?? prev?.rateLimitWeekly ?? null,
      }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalType, sessionResumeId, terminalId, workingDir]);

  return { contextInfo, setContextInfo, refreshContext };
}
