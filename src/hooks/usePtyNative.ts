import { useEffect, useRef, useCallback } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import type { TerminalType, TerminalBackend } from "../types";
import { sessionStillExists } from "../lib/session-exists";
import { claudeSessionIdArgs, getTerminalConfig, getPooledInitCommand, isWslTerminal, toWslPath, getSshCommand, getYoloFlag } from "../lib/terminal-config";
import { shellPsModeFor } from "../lib/shell-mode";
import { wslReady } from "../lib/wsl-cache";
import { windowsReady } from "../lib/windows-cli-cache";
import { nativeReady } from "../lib/macos-cli-cache";
import { useAppStore } from "../store";
import { takePendingPrompt } from "../store/terminalSlice";
import { nameTicketSession } from "../lib/jira-session";
import { getShellIntegrationCommand } from "../lib/shell-integration";
import { installStatuslineWrapper } from "../lib/statusline-setup";
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
      // Shared with the pooled spawn below — see the note in usePty.ts. A
      // separate pool-only list drops `--session-id`, which desyncs the id MADE
      // stores from the one Claude actually uses.
      const extraArgs: string[] = [];

      if (currentServerId) {
        const server = useAppStore.getState().servers.find((s) => s.id === currentServerId);
        if (!server) {
          onExitRef.current(1);
          return;
        }
        if (terminalType === "claude") {
          void installStatuslineWrapper(currentServerId);
        }
        const remoteCwd = currentWorkingDir || undefined;
        const ssh = getSshCommand(server, terminalType, remoteCwd, sessionResumeIdRef.current);
        command = ssh.command;
        args = ssh.args;
        cwd = undefined;
      } else {
        const yoloFlag = getYoloFlag(terminalType);
        if (yoloFlag && (forceYoloRef.current || useAppStore.getState().cliYolo[terminalType])) {
          extraArgs.push(yoloFlag);
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
        // and for resumes.
        const assigned = claudeSessionIdArgs(terminalType, resumeId);
        if (assigned.sessionId) {
          extraArgs.push(...assigned.args);
          onSessionIdAssignedRef.current?.(assigned.sessionId);
          nameTicketSession(termId, assigned.sessionId, currentWorkingDir || "");
        }
        // First prompt for a Jira ticket pane — see the twin in usePty.ts. Must
        // stay LAST in extraArgs: getTerminalConfig emits `<extraArgs> <resume>`,
        // so a positional placed earlier would swallow `--session-id`'s uuid.
        const pendingPrompt = takePendingPrompt(termId);
        if (pendingPrompt) extraArgs.push(pendingPrompt);
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
          const config = getTerminalConfig(terminalType, resumeId, extraArgs, cwdForConfig, undefined, termProgram, termProgramVersion, psMode);
          command = config.command;
          args = [...config.args];
          if (isWslTerminal(terminalType, backend) && wslCwd && !resumeId) {
            args = ["--cd", wslCwd, ...args];
          }
          cwd = undefined;
        }
      }

      const onDataChan = new Channel<number[]>();
      onDataChan.onmessage = (data) => {
        if (spawnIdRef.current !== thisSpawnId) return;
        onDataRef.current(new Uint8Array(data));
      };

      const onExitChan = new Channel<number>();
      onExitChan.onmessage = (code) => {
        if (spawnIdRef.current !== thisSpawnId) return;
        onExitRef.current(code);
      };

      try {
        let id: number | undefined;

        if (!currentServerId && backend !== "windows" && isWslTerminal(terminalType, backend) && !sessionResumeIdRef.current) {
          const wslCwd = currentWorkingDir ? toWslPath(currentWorkingDir) : undefined;
          const initCmd = getPooledInitCommand(terminalType, wslCwd, sessionResumeIdRef.current, extraArgs, backend);
          if (initCmd) {
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
