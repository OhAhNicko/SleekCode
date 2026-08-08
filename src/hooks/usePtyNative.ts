import { useEffect, useRef, useCallback } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import type { TerminalType, TerminalBackend } from "../types";
import { sessionStillExists } from "../lib/session-exists";
import { claudeSessionIdArgs, firstPromptArgs, getTerminalConfig, getPooledInitCommand, isWslTerminal, toWslPath, getSshCommand, getYoloFlag, safePaneId } from "../lib/terminal-config";
import { shellPsModeFor } from "../lib/shell-mode";
import { notePtyChunk } from "../lib/pty-flood-stats";
import { wslReady } from "../lib/wsl-cache";
import { windowsReady } from "../lib/windows-cli-cache";
import { nativeReady } from "../lib/macos-cli-cache";
import { useAppStore } from "../store";
import { takePendingPrompt } from "../store/terminalSlice";
import { nameTicketSession, peekTicketForTerminal, parkedTicketName } from "../lib/jira-session";
import { getShellIntegrationCommand } from "../lib/shell-integration";
import { installStatuslineWrapper } from "../lib/statusline-setup";
import { createKeychainUnlockWatcher, needsKeychainUnlock } from "../lib/keychain";
import { ensureRemoteCliShells, pickExecShell } from "../lib/remote-cli-shells";
import type { NativeTermId } from "../lib/native-term-bridge";

// Phase 1 J1 sibling of usePty.ts. Same spawn/restart logic, plus an
// optional `attachTo` that wires the resulting pty_id into a native
// terminal HWND via the bridge. Existing `onData`/`onExit` channels stay
// live (see plan: PTY-route hard requirement during rollout).
//
// Will be folded back into usePty.ts once the M-list refactor lands.

interface UsePtyNativeOptions {
  terminalType: TerminalType;
  terminalId: string;
  workingDir: string;
  cols: number;
  rows: number;
  onData: (data: Uint8Array) => void;
  onExit: (exitCode: number) => void;
  serverId?: string;
  sessionResumeId?: string;
  /** Called with the session id MADE ASSIGNED to a freshly-spawned Claude
   * session (via `--session-id`). Lets the pane claim it directly instead of
   * guessing it back from the newest .jsonl mtime. */
  onSessionIdAssigned?: (id: string) => void;
  /** Fired once the PTY process actually exists — the first moment `write()`
   *  can deliver instead of silently dropping (it no-ops while ptyIdRef is
   *  null). Initial-command senders (dev-server auto-start) must key on this,
   *  not on mount or surface creation. */
  onSpawned?: () => void;
  injectShellIntegration?: boolean;
  ready?: boolean;
  restartKey?: number;
  forceYolo?: boolean;
  backend?: TerminalBackend;
  /** When set, attaches the spawned PTY to this native term id via the
   *  bridge after spawn resolves. JS-side onData channel still fires;
   *  the consumer chooses whether to write into a JS-side renderer. */
  attachTo?: NativeTermId | null;
}

export function usePtyNative({
  terminalType,
  terminalId: termId,
  workingDir,
  cols,
  rows,
  onData,
  onExit,
  serverId,
  sessionResumeId,
  onSessionIdAssigned,
  onSpawned,
  injectShellIntegration = false,
  ready = true,
  restartKey = 0,
  forceYolo = false,
  backend: backendProp,
  attachTo,
}: UsePtyNativeOptions) {
  const ptyIdRef = useRef<number | null>(null);
  const spawnIdRef = useRef(0);
  const pendingResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const sessionResumeIdRef = useRef(sessionResumeId);
  const onSessionIdAssignedRef = useRef(onSessionIdAssigned);
  onSessionIdAssignedRef.current = onSessionIdAssigned;
  sessionResumeIdRef.current = sessionResumeId;
  const onSpawnedRef = useRef(onSpawned);
  onSpawnedRef.current = onSpawned;

  const termIdRef = useRef(termId);
  termIdRef.current = termId;
  const workingDirRef = useRef(workingDir);
  workingDirRef.current = workingDir;
  const serverIdRef = useRef(serverId);
  serverIdRef.current = serverId;
  const injectShellIntegrationRef = useRef(injectShellIntegration);
  injectShellIntegrationRef.current = injectShellIntegration;
  const backendRef = useRef<TerminalBackend>(backendProp ?? useAppStore.getState().terminalBackend ?? "wsl");
  const forceYoloRef = useRef(forceYolo);
  forceYoloRef.current = forceYolo;

  const onDataRef = useRef(onData);
  onDataRef.current = onData;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const colsRef = useRef(cols);
  colsRef.current = cols;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const attachToRef = useRef(attachTo ?? null);
  attachToRef.current = attachTo ?? null;
  const attachedTermIdRef = useRef<NativeTermId | null>(null);

  // When attachTo flips from null → number after the PTY has already
  // spawned (TerminalPaneNative resolves its create after usePtyNative
  // has begun spawning), wire the existing pty_id to the new term id.
  useEffect(() => {
    const ptyId = ptyIdRef.current;
    const want = attachTo ?? null;
    if (want != null && ptyId != null && attachedTermIdRef.current !== want) {
      attachedTermIdRef.current = want;
      void invoke("native_term_attach_pty", {
        id: want,
        ptyId,
        cols: Math.max(colsRef.current, 2),
        rows: Math.max(rowsRef.current, 2),
      }).catch((e) => console.error("[usePtyNative] attach_pty late-wire failed:", e));
    }
  }, [attachTo]);

  useEffect(() => {
    if (!ready) return;

    const thisSpawnId = ++spawnIdRef.current;
    let cancelled = false;

    const timerId = setTimeout(async () => {
      const currentWorkingDir = workingDirRef.current;
      const currentServerId = serverIdRef.current;
      const currentInjectShellIntegration = injectShellIntegrationRef.current;

      const isStale = () => cancelled || spawnIdRef.current !== thisSpawnId;
      const backend = backendRef.current;

      if (backend === "native") {
        await nativeReady;
        if (isStale()) return;
      } else if (backend === "windows") {
        await windowsReady;
        if (isStale()) return;
      } else if (isWslTerminal(terminalType, backend) && sessionResumeIdRef.current) {
        await wslReady;
        if (isStale()) return;
      }

      let command: string;
      let args: string[];
      let cwd: string | undefined;
      // Answers the keychain-unlock preamble's sentinels for remote panes.
      let kcWatcher: ((chunk: Uint8Array) => void) | null = null;
      // Shared with the pooled spawn below — see the note in usePty.ts. A
      // separate pool-only list drops `--session-id`, which desyncs the id MADE
      // stores from the one Claude actually uses.
      const extraArgs: string[] = [];
      // Jira ticket panes: name the Claude session after the ticket right at
      // launch (`--name`), so the resume picker and terminal title show
      // SUPPORT-24920 instead of the investigation prompt. Peek, not take —
      // nameTicketSession still consumes the entry at session-id mint time.
      //
      // Codex and Gemini ticket panes park too, but claim far less of this:
      // `--name`, `--session-id`, `--permission-mode` and `--fork-session` are
      // Claude flags with no equivalent, so they take only `-m` plus their
      // first prompt (see firstPromptArgs — Gemini needs `-i` there, not a
      // positional), and their rail row is named once the pane detects its
      // session id (see Workspace's onSessionResumeId).
      const parkedTicket =
        terminalType === "claude" || terminalType === "codex" || terminalType === "gemini"
          ? peekTicketForTerminal(termId)
          : undefined;

      if (currentServerId) {
        const server = useAppStore.getState().servers.find((s) => s.id === currentServerId);
        if (!server) {
          onExitRef.current(1);
          return;
        }
        if (terminalType === "claude") {
          // AWAITED, not fire-and-forget: the install patches the remote
          // ~/.claude/settings.json, and Claude reads statusLine when it
          // STARTS. Racing it against the spawn meant the first pane on a
          // server came up with no statusline — so no model, cost, duration or
          // version in its header for that pane's whole life. Deduped per
          // server per app run, so only the first pane pays the round trip.
          await installStatuslineWrapper(currentServerId);
          if (isStale()) return;
        }
        const remoteCwd = currentWorkingDir || undefined;
        // Which shell can actually resolve this CLI on that server (probed
        // once, persisted on the server; instant afterwards).
        const cliInfo = await ensureRemoteCliShells(server);
        if (isStale()) return;
        // Jira ticket panes over SSH need the SAME handoffs the local branch
        // does below: `--name`, a minted `--session-id` (names the rail row,
        // lets the pane claim its session without mtime guessing), and the
        // parked first prompt as the positional LAST argument. Without these
        // a remote ticket pane spawned silently promptless and railless.
        const remoteClaudeArgs: string[] = [];
        if (parkedTicket && terminalType !== "claude") {
          // Codex/Gemini: `-m <slug>` is the only launch flag they share here.
          if (parkedTicket.model) remoteClaudeArgs.push("-m", parkedTicket.model);
        } else if (parkedTicket) {
          remoteClaudeArgs.push("--name", parkedTicketName(parkedTicket));
          // Jira ticket panes start in auto permission mode — the whole point
          // of a ticket pane is unattended investigation.
          remoteClaudeArgs.push("--permission-mode", "auto");
          if (parkedTicket.model) remoteClaudeArgs.push("--model", parkedTicket.model);
          if (parkedTicket.fork) {
            // Duplicate-as-fork: resume the SOURCE conversation into a NEW
            // session id chosen by MADE, so the rail row and the pane agree
            // on the id before the CLI even starts.
            remoteClaudeArgs.push(
              "--resume", parkedTicket.fork.sourceSessionId,
              "--fork-session",
              "--session-id", parkedTicket.fork.newSessionId,
            );
            onSessionIdAssignedRef.current?.(parkedTicket.fork.newSessionId);
            nameTicketSession(termId, parkedTicket.fork.newSessionId, currentWorkingDir || "");
          } else if (!sessionResumeIdRef.current) {
            const assigned = claudeSessionIdArgs(terminalType, undefined);
            if (assigned.sessionId) {
              remoteClaudeArgs.push(...assigned.args);
              onSessionIdAssignedRef.current?.(assigned.sessionId);
              nameTicketSession(termId, assigned.sessionId, currentWorkingDir || "");
            }
          }
        }
        // Every OTHER remote Claude pane gets the same up-front id the local
        // branch mints below. Without it a remote pane had to GUESS its
        // session back from the newest .jsonl mtime minutes later — racy on
        // any server, and outright impossible on a macOS one until the BSD
        // `stat` fix in get_claude_session_id_ssh, so the pane never learned
        // an id and the NEXT launch had nothing to --resume. Skipped when
        // already resuming: reusing that id here would collide.
        if (!parkedTicket && !sessionResumeIdRef.current) {
          const assigned = claudeSessionIdArgs(terminalType, undefined);
          if (assigned.sessionId) {
            remoteClaudeArgs.push(...assigned.args);
            onSessionIdAssignedRef.current?.(assigned.sessionId);
          }
        }
        // Must stay LAST — getRemoteExecCommand emits `<resume> <extraArgs>`,
        // so a positional placed earlier would swallow the next flag's value.
        const remotePendingPrompt = takePendingPrompt(termId);
        if (remotePendingPrompt) remoteClaudeArgs.push(...firstPromptArgs(terminalType, remotePendingPrompt));
        const ssh = getSshCommand(
          server,
          terminalType,
          remoteCwd,
          sessionResumeIdRef.current,
          remoteClaudeArgs.length ? remoteClaudeArgs : undefined,
          pickExecShell(cliInfo, terminalType),
        );
        command = ssh.command;
        args = ssh.args;
        cwd = undefined;
        if (needsKeychainUnlock(server, terminalType)) {
          kcWatcher = createKeychainUnlockWatcher(server, (data) => {
            const id = ptyIdRef.current;
            if (id !== null) {
              invoke("pty_write", { ptyId: id, data }).catch(() => {});
            } else {
              // Chunk raced the spawn invoke's resolution — deliver shortly.
              setTimeout(() => {
                if (spawnIdRef.current === thisSpawnId && ptyIdRef.current !== null) {
                  invoke("pty_write", { ptyId: ptyIdRef.current, data }).catch(() => {});
                }
              }, 100);
            }
          });
        }
      } else {
        const yoloFlag = getYoloFlag(terminalType);
        if (yoloFlag && (forceYoloRef.current || useAppStore.getState().cliYolo[terminalType])) {
          extraArgs.push(yoloFlag);
        }
        if (parkedTicket && terminalType !== "claude") {
          // Codex/Gemini — see the twin in the SSH branch above.
          if (parkedTicket.model) extraArgs.push("-m", parkedTicket.model);
        } else if (parkedTicket) {
          extraArgs.push("--name", parkedTicketName(parkedTicket));
          // Jira ticket panes start in auto permission mode — the whole point
          // of a ticket pane is unattended investigation.
          extraArgs.push("--permission-mode", "auto");
          if (parkedTicket.model) extraArgs.push("--model", parkedTicket.model);
          if (parkedTicket.fork) {
            // Duplicate-as-fork — see the twin in the SSH branch above.
            extraArgs.push(
              "--resume", parkedTicket.fork.sourceSessionId,
              "--fork-session",
              "--session-id", parkedTicket.fork.newSessionId,
            );
            onSessionIdAssignedRef.current?.(parkedTicket.fork.newSessionId);
            nameTicketSession(termId, parkedTicket.fork.newSessionId, currentWorkingDir || "");
          }
        }
        // Terminal identity advertised to the CLI (TERM_PROGRAM). Read at
        // spawn so a settings change applies to the next pane without a
        // restart.
        const { termProgram, termProgramVersion } = useAppStore.getState();
        // Never resume an id the CLI can no longer find: it drops into its
        // interactive "Resume session" picker, which MADE mishandles (the
        // composer steals banner text into the search box — the "Welcome"
        // glitch). Checking first means the picker never appears. Fails OPEN,
        // so an unreadable index can never discard a real conversation.
        let resumeId = sessionResumeIdRef.current;
        if (resumeId) {
          const alive = await sessionStillExists(
            terminalType,
            resumeId,
            currentWorkingDir || "",
            backend ?? "wsl",
            serverIdRef.current,
          );
          if (!alive) {
            console.warn(
              `[SessionResume] ${resumeId.slice(0, 8)} no longer exists — starting a fresh session instead of dropping into the CLI's resume picker`,
            );
            resumeId = undefined;
            // Drop the dead id so the pane stops retrying it every launch, and
            // unregister it so it stops appearing as an unpickable row in the
            // session picker.
            useAppStore.getState().removeProjectSession(currentWorkingDir || "", sessionResumeIdRef.current!);
            onSessionIdAssignedRef.current?.("");
          }
        }
        // Assign the Claude session id up front rather than detecting it after
        // the fact (see claudeSessionIdArgs). No-op for every other pane type
        // and for resumes. A fork pane already fixed its id above — passing it
        // as the "resume" id suppresses minting a second one.
        const assigned = claudeSessionIdArgs(
          terminalType,
          resumeId ?? parkedTicket?.fork?.newSessionId,
        );
        if (assigned.sessionId) {
          extraArgs.push(...assigned.args);
          onSessionIdAssignedRef.current?.(assigned.sessionId);
          nameTicketSession(termId, assigned.sessionId, currentWorkingDir || "");
        }
        // First prompt for a Jira ticket pane — see the twin in usePty.ts. Must
        // stay LAST in extraArgs: getTerminalConfig emits `<extraArgs> <resume>`,
        // so a positional placed earlier would swallow `--session-id`'s uuid.
        const pendingPrompt = takePendingPrompt(termId);
        if (pendingPrompt) extraArgs.push(...firstPromptArgs(terminalType, pendingPrompt));
        cwd = currentWorkingDir || undefined;

        if (backend === "native") {
          const config = getTerminalConfig(terminalType, resumeId, extraArgs, undefined, "native", termProgram, termProgramVersion);
          command = config.command;
          args = [...config.args];
        } else if (backend === "windows") {
          // Shell AND devserver pass the project cwd so PowerShell launches with
          // -NoExit -Command "Set-Location ..." baked in (a Tauri dev server
          // routed here must land in the project dir to run `npm run tauri:dev`).
          const cwdForConfig = terminalType === "shell" || terminalType === "devserver"
            ? (currentWorkingDir || undefined)
            : undefined;
          const psMode = terminalType === "shell"
            ? shellPsModeFor(currentWorkingDir, currentServerId, backend)
            : undefined;
          const config = getTerminalConfig(terminalType, resumeId, extraArgs, cwdForConfig, "windows", termProgram, termProgramVersion, psMode);
          command = config.command;
          args = [...config.args];
          if (terminalType === "devserver") {
            // Set-Location (baked into args) handles the directory; don't also
            // hand a possibly-/mnt-form cwd to CreateProcessW.
            cwd = undefined;
          }
        } else {
          let wslCwd: string | undefined;
          if (cwd && isWslTerminal(terminalType, backend)) {
            wslCwd = toWslPath(cwd);
          }
          const cwdForConfig = terminalType === "shell"
            ? (currentWorkingDir || undefined)
            : (resumeId ? wslCwd : undefined);
          // Shell panes: per-project WSL/WIN badge override, else the pane's
          // backend — wsl-backed projects preload WSL bash inside PowerShell.
          const psMode = terminalType === "shell"
            ? shellPsModeFor(currentWorkingDir, currentServerId, backend)
            : undefined;
          const config = getTerminalConfig(terminalType, resumeId, extraArgs, cwdForConfig, undefined, termProgram, termProgramVersion, psMode, termId);
          command = config.command;
          args = [...config.args];
          if (isWslTerminal(terminalType, backend) && wslCwd && !resumeId) {
            args = ["--cd", wslCwd, ...args];
          }
          cwd = undefined;
        }
      }

      // ArrayBuffer, not number[]: Rust sends InvokeResponseBody::Raw (see
      // usePty.ts for why — JSON number arrays backlogged the UI thread).
      const onDataChan = new Channel<ArrayBuffer>();
      onDataChan.onmessage = (data) => {
        if (spawnIdRef.current !== thisSpawnId) return;
        notePtyChunk(data.byteLength);
        const bytes = new Uint8Array(data);
        kcWatcher?.(bytes);
        onDataRef.current(bytes);
      };

      const onExitChan = new Channel<number>();
      onExitChan.onmessage = (code) => {
        if (spawnIdRef.current !== thisSpawnId) return;
        onExitRef.current(code);
      };

      try {
        let id: number | undefined;
        const tSpawn = performance.now();

        if (!currentServerId && backend !== "windows" && isWslTerminal(terminalType, backend) && !sessionResumeIdRef.current) {
          const wslCwd = currentWorkingDir ? toWslPath(currentWorkingDir) : undefined;
          const initCmd = getPooledInitCommand(terminalType, wslCwd, sessionResumeIdRef.current, extraArgs, backend, termId);
          if (initCmd) {
            console.log(`[PTY] using pool for ${terminalType}`, extraArgs.length ? `extraArgs: ${extraArgs.join(" ")}` : "(no extra args)");
            try {
              id = await invoke<number>("pty_spawn_pooled", {
                initCommand: initCmd,
                cols: Math.max(colsRef.current, 2),
                rows: Math.max(rowsRef.current, 2),
                onData: onDataChan,
                onExit: onExitChan,
              });
            } catch {
              // pool empty — fall through to pty_spawn
            }
          }
        }

        if (id === undefined) {
          console.log(`[PTY] normal spawn for ${terminalType} (pool skipped or empty)`);
          id = await invoke<number>("pty_spawn", {
            command,
            args,
            cols: Math.max(cols, 2),
            rows: Math.max(rows, 2),
            cwd: cwd ?? null,
            // MADE_PANE_ID identifies which pane an agent's knowledge writes
            // came from. The WSL paths plant it inside the distro themselves
            // (terminal-config); this is the Windows-backend route, where the
            // spawn env IS the process env. Only AI panes — a shell pane has
            // no agent identity to attribute.
            env: {
              TERM: "xterm-256color",
              COLORTERM: "truecolor",
              ...(terminalType === "claude" || terminalType === "codex" || terminalType === "gemini"
                ? { MADE_PANE_ID: safePaneId(termId) }
                : {}),
            },
            onData: onDataChan,
            onExit: onExitChan,
          });
        }

        if (isStale()) {
          invoke("pty_kill", { ptyId: id }).catch(() => {});
          return;
        }

        console.log(`[PTY] ${terminalType} spawned in ${(performance.now() - tSpawn).toFixed(0)}ms`);
        ptyIdRef.current = id;

        // Attach to native term if requested. Attempts once per spawn;
        // if attachTo is still null here, the effect above will wire it
        // when the consumer eventually sets it.
        const wantAttach = attachToRef.current;
        if (wantAttach != null) {
          attachedTermIdRef.current = wantAttach;
          void invoke("native_term_attach_pty", {
            id: wantAttach,
            ptyId: id,
            cols: Math.max(cols, 2),
            rows: Math.max(rows, 2),
          }).catch((e) => console.error("[usePtyNative] attach_pty failed:", e));
        }

        if (pendingResizeRef.current) {
          const { cols: pc, rows: pr } = pendingResizeRef.current;
          pendingResizeRef.current = null;
          invoke("pty_resize", { ptyId: id, cols: pc, rows: pr });
        }

        onSpawnedRef.current?.();

        if (currentInjectShellIntegration) {
          setTimeout(() => {
            if (spawnIdRef.current === thisSpawnId && ptyIdRef.current !== null) {
              invoke("pty_write", {
                ptyId: ptyIdRef.current,
                data: getShellIntegrationCommand(),
              });
            }
          }, 300);
        }
      } catch (e) {
        console.error("[usePtyNative] spawn failed:", e);
        if (!isStale()) {
          onExitRef.current(1);
        }
      }
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timerId);
      const id = ptyIdRef.current;
      const attached = attachedTermIdRef.current;
      if (id !== null) {
        if (attached != null) {
          invoke("native_term_detach_pty", { id: attached }).catch(() => {});
        }
        invoke("pty_kill", { ptyId: id }).catch(() => {});
        ptyIdRef.current = null;
        attachedTermIdRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalType, ready, restartKey]);

  const write = useCallback((data: string) => {
    if (ptyIdRef.current !== null) {
      invoke("pty_write", { ptyId: ptyIdRef.current, data });
    }
  }, []);

  const resize = useCallback((newCols: number, newRows: number) => {
    if (ptyIdRef.current !== null) {
      invoke("pty_resize", { ptyId: ptyIdRef.current, cols: newCols, rows: newRows });
    } else {
      pendingResizeRef.current = { cols: newCols, rows: newRows };
    }
  }, []);

  const kill = useCallback(() => {
    if (ptyIdRef.current !== null) {
      invoke("pty_kill", { ptyId: ptyIdRef.current }).catch(() => {});
      ptyIdRef.current = null;
    }
  }, []);

  return { write, resize, kill };
}
