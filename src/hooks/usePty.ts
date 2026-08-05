import { useEffect, useRef, useCallback } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import type { TerminalType } from "../types";
import { sessionStillExists } from "../lib/session-exists";
import { claudeSessionIdArgs, firstPromptArgs, getTerminalConfig, getPooledInitCommand, isWslTerminal, toWslPath, getSshCommand, getYoloFlag } from "../lib/terminal-config";
import { shellPsModeFor } from "../lib/shell-mode";
import { notePtyChunk } from "../lib/pty-flood-stats";
import { wslReady } from "../lib/wsl-cache";
import { windowsReady } from "../lib/windows-cli-cache";
import { nativeReady } from "../lib/macos-cli-cache";
import { useAppStore } from "../store";
import { takePendingPrompt } from "../store/terminalSlice";
import { nameTicketSession, peekTicketForTerminal, parkedTicketName } from "../lib/jira-session";
import type { TerminalBackend } from "../types";
import { getShellIntegrationCommand } from "../lib/shell-integration";
import { installStatuslineWrapper } from "../lib/statusline-setup";
import { createKeychainUnlockWatcher, needsKeychainUnlock } from "../lib/keychain";
import { ensureRemoteCliShells, pickExecShell } from "../lib/remote-cli-shells";

interface UsePtyOptions {
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
   *  null). Consumers that need to send an initial command (dev-server
   *  auto-start) MUST key on this, not on React mount: on cold boot the spawn
   *  awaits WSL/CLI caches for seconds, so anything mount-timed writes into
   *  the void. */
  onSpawned?: () => void;
  injectShellIntegration?: boolean;
  /** When false, PTY spawn is deferred until the terminal has measured
   *  its real dimensions via fitAddon.fit(). This prevents spawning at
   *  the default 80×24 and racing with TUI apps that draw immediately. */
  ready?: boolean;
  /** Bump to trigger PTY kill + re-spawn (restart). */
  restartKey?: number;
  /** When true, YOLO flag is always applied regardless of current global setting. */
  forceYolo?: boolean;
  /** Per-tab backend override (wsl/windows). Falls back to global setting if omitted. */
  backend?: TerminalBackend;
  /** When set, signals usePty that the resulting PTY will be routed through
   *  the native renderer at this id. In native mode the JS-side `term.write`
   *  consumer is skipped — the parser bridge in Rust owns byte routing. */
  attachTo?: number | null;
}

export function usePty({
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
}: UsePtyOptions) {
  const ptyIdRef = useRef<number | null>(null);
  const spawnIdRef = useRef(0);
  // Buffer the latest resize request when PTY hasn't spawned yet.
  // fitAddon.fit() fires before the async PTY spawn completes, so
  // resize() silently drops the IPC.  We replay after spawn.
  const pendingResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  // Capture resume ID via ref — read once at spawn time, never triggers re-spawn.
  // The ID is persisted to localStorage on exit and used on next app restart.
  const sessionResumeIdRef = useRef(sessionResumeId);
  const onSessionIdAssignedRef = useRef(onSessionIdAssigned);
  onSessionIdAssignedRef.current = onSessionIdAssigned;
  sessionResumeIdRef.current = sessionResumeId;
  const onSpawnedRef = useRef(onSpawned);
  onSpawnedRef.current = onSpawned;

  // Store stable config in refs so only terminalType triggers PTY restart.
  // workingDir, serverId, and injectShellIntegration never change for an
  // existing terminal — but parent re-renders could pass new references
  // or subtly different values, causing spurious PTY restarts (Claude CLI
  // would restart mid-session showing /remote-control banner again).
  const termIdRef = useRef(termId);
  termIdRef.current = termId;
  const workingDirRef = useRef(workingDir);
  workingDirRef.current = workingDir;
  const serverIdRef = useRef(serverId);
  serverIdRef.current = serverId;
  const injectShellIntegrationRef = useRef(injectShellIntegration);
  injectShellIntegrationRef.current = injectShellIntegration;
  // Per-tab backend takes priority; fall back to global setting
  const backendRef = useRef<TerminalBackend>(backendProp ?? useAppStore.getState().terminalBackend ?? "wsl");
  // Force YOLO on restart — preserves launch-time YOLO state regardless of global toggle
  const forceYoloRef = useRef(forceYolo);
  forceYoloRef.current = forceYolo;

  const onDataRef = useRef(onData);
  onDataRef.current = onData;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  // Read latest cols/rows at spawn time (updated by setTermReady re-render)
  const colsRef = useRef(cols);
  colsRef.current = cols;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    // Don't spawn until the terminal has measured real dimensions
    if (!ready) return;

    const thisSpawnId = ++spawnIdRef.current;
    let cancelled = false;

    // Defer spawn to next macrotask. In React StrictMode's
    // mount->cleanup->remount cycle, the first mount's timer is
    // cancelled before it fires, so only ONE ConPTY is ever created.
    const timerId = setTimeout(async () => {
      const currentWorkingDir = workingDirRef.current;
      const currentServerId = serverIdRef.current;
      const currentInjectShellIntegration = injectShellIntegrationRef.current;

      // Bail-out helper: check if this spawn has been superseded
      const isStale = () => cancelled || spawnIdRef.current !== thisSpawnId;

      const backend = backendRef.current;

      // Wait for the correct CLI cache to be ready before spawning
      if (backend === "native") {
        await nativeReady;
        if (isStale()) return;
      } else if (backend === "windows") {
        await windowsReady;
        if (isStale()) return;
      } else if (isWslTerminal(terminalType, backend) && sessionResumeIdRef.current) {
        // For WSL resume spawns, wait for WSL to boot before invoking wsl.exe.
        // Fresh spawns can race ahead and use the pool (or start wsl.exe cold).
        await wslReady;
        if (isStale()) return;
      }
      let command: string;
      let args: string[];
      let cwd: string | undefined;
      // Answers the keychain-unlock preamble's sentinels for remote panes.
      let kcWatcher: ((chunk: Uint8Array) => void) | null = null;
      // Declared out here because the pooled spawn below needs the SAME list.
      // It used to build its own, which silently dropped `--session-id` on
      // every fresh WSL Claude pane — MADE then owned a uuid Claude had never
      // been told about, and the next launch resumed a session that had never
      // existed ("No conversation found with session ID: …").
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
        // Install the statusline wrapper on the remote so context-window %
        // can be read for Claude tabs. Idempotent + per-server dedup.
        // Fire-and-forget: install in parallel with the spawn.
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
        // [DIAG-SSH-RESUME] temporary: log SSH spawn boundary. Remove once verified.
        console.log("[DIAG-SSH-RESUME] usePty SSH spawn", {
          terminalType,
          currentServerId,
          sessionResumeId: sessionResumeIdRef.current,
          remoteCwd,
        });
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
        // [DIAG-SSH-RESUME] temporary: log local spawn for SSH-tab debugging. Remove once verified.
        if (sessionResumeIdRef.current) {
          console.log("[DIAG-SSH-RESUME] usePty LOCAL spawn (no serverId)", {
            terminalType,
            sessionResumeId: sessionResumeIdRef.current,
            backend: backendRef.current,
          });
        }
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
        console.log(`[PTY] spawn ${terminalType}`, extraArgs.length ? `extraArgs: ${extraArgs.join(" ")}` : "(no extra args)", `forceYolo=${forceYoloRef.current}`);
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
        // First prompt for a Jira ticket pane, handed over as the CLI's
        // POSITIONAL argument so the investigation is already running when the
        // pane appears — no waiting for the TUI to become interactive, no
        // synthetic typing to race with it.
        //
        // Must be pushed LAST: getTerminalConfig emits `<extraArgs> <resumeArgs>`,
        // and a positional placed before `--session-id <uuid>` would swallow the
        // uuid as a second positional.
        const pendingPrompt = takePendingPrompt(termId);
        if (pendingPrompt) extraArgs.push(...firstPromptArgs(terminalType, pendingPrompt));
        cwd = currentWorkingDir || undefined;

        if (backend === "native") {
          // macOS/Linux native: use resolved CLI path directly, native cwd
          const config = getTerminalConfig(terminalType, resumeId, extraArgs, undefined, "native", termProgram, termProgramVersion);
          command = config.command;
          args = [...config.args];
          // cwd stays as native path
        } else if (backend === "windows") {
          // Windows native: use resolved CLI path directly, native Windows cwd.
          // For shell AND devserver, pass the project cwd so PowerShell launches
          // with -NoExit -Command "Set-Location ..." baked in (a Tauri dev server
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
            // hand a possibly-/mnt-form cwd to CreateProcessW, which can't chdir
            // into a WSL-style path.
            cwd = undefined;
          }
          // (shell keeps cwd as the native Windows path, as before)
        } else {
          // WSL backend
          let wslCwd: string | undefined;
          if (cwd && isWslTerminal(terminalType, backend)) {
            wslCwd = toWslPath(cwd);
          }

          // For shell type on WSL backend we still spawn powershell.exe, so
          // pass the original (possibly Linux) cwd; getTerminalConfig will
          // translate it into either Set-Location (Windows path) or `wsl --cd`
          // (Linux path) launch args.
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
            // Fresh spawns: use wsl.exe --cd flag
            args = ["--cd", wslCwd, ...args];
          }
          cwd = undefined;
        }
      }

      // ArrayBuffer, not number[]: Rust sends InvokeResponseBody::Raw, so the
      // chunk arrives as raw bytes instead of a JSON number array that would
      // need parsing on the UI thread (that parse backlog delayed overlay
      // popups by seconds under heavy output).
      const onDataChan = new Channel<ArrayBuffer>();
      onDataChan.onmessage = (data) => {
        // Guard: discard data from stale spawns (e.g. React StrictMode double-fire
        // where the first PTY starts before cleanup cancels it)
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

        // Try pre-warmed WSL pool first (near-instant, skips wsl.exe startup).
        // Skip pool for session resume — pooled bash uses --norc --noprofile
        // which may lack env setup that Claude needs for --resume.
        // The normal spawn path uses bash -lic (full login shell) for resume.
        // Windows mode skips pool entirely (no WSL pool).
        if (!currentServerId && backend !== "windows" && isWslTerminal(terminalType, backend) && !sessionResumeIdRef.current) {
          const wslCwd = currentWorkingDir ? toWslPath(currentWorkingDir) : undefined;
          // Must be the same extraArgs the non-pooled path uses: it carries
          // `--session-id <uuid>`, which the pane has ALREADY committed to via
          // onSessionIdAssigned. Rebuilding a yolo-only list here is what made
          // MADE's stored id and Claude's real id diverge.
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
              // Pool auto-replenishes in Rust (pty_spawn_pooled spawns a replacement session)
            } catch {
              // Pool empty — fall through to normal spawn
            }
          }
        }

        // Normal spawn (SSH, PowerShell, or pool was empty)
        if (id === undefined) {
          console.log(`[PTY] normal spawn for ${terminalType} (pool skipped or empty)`);
          id = await invoke<number>("pty_spawn", {
            command,
            args,
            cols: Math.max(cols, 2),
            rows: Math.max(rows, 2),
            cwd: cwd ?? null,
            env: { TERM: "xterm-256color", COLORTERM: "truecolor" },
            onData: onDataChan,
            onExit: onExitChan,
          });
        }

        if (isStale()) {
          invoke("pty_kill", { ptyId: id }).catch(() => {});
          return;
        }

        ptyIdRef.current = id;

        // Replay buffered resize — fitAddon.fit() likely fired before
        // spawn completed, so the PTY has stale 80×24 dimensions.
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
        console.error("Failed to spawn PTY:", e);
        if (!isStale()) {
          onExitRef.current(1);
        }
      }
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timerId);
      const id = ptyIdRef.current;
      if (id !== null) {
        invoke("pty_kill", { ptyId: id }).catch(() => {});
        ptyIdRef.current = null;
      }
    };
    // terminalType triggers PTY restart (explicit CLI type switch).
    // ready gates first spawn until terminal has real dimensions.
    // restartKey triggers PTY restart (user clicked restart button).
    // All other config is read from refs at spawn time.
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
      // PTY not spawned yet — buffer for replay after spawn
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
