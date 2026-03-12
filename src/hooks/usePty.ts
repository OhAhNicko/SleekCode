import { useEffect, useRef, useCallback } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import type { TerminalType } from "../types";
import { getTerminalConfig, getPooledInitCommand, isWslTerminal, toWslPath, getSshCommand, getYoloFlag } from "../lib/terminal-config";
import { wslReady } from "../lib/wsl-cache";
import { windowsReady } from "../lib/windows-cli-cache";
import { useAppStore } from "../store";
import type { TerminalBackend } from "../types";
import { getShellIntegrationCommand } from "../lib/shell-integration";

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
  injectShellIntegration?: boolean;
  /** When false, PTY spawn is deferred until the terminal has measured
   *  its real dimensions via fitAddon.fit(). This prevents spawning at
   *  the default 80×24 and racing with TUI apps that draw immediately. */
  ready?: boolean;
  /** Bump to trigger PTY kill + re-spawn (restart). */
  restartKey?: number;
  /** When true, YOLO flag is always applied regardless of current global setting. */
  forceYolo?: boolean;
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
  injectShellIntegration = false,
  ready = true,
  restartKey = 0,
  forceYolo = false,
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
  sessionResumeIdRef.current = sessionResumeId;

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
  // Read terminal backend setting via ref (never triggers re-spawn)
  const backendRef = useRef<TerminalBackend>(useAppStore.getState().terminalBackend ?? "wsl");
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
      if (backend === "windows") {
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

      if (currentServerId) {
        const server = useAppStore.getState().servers.find((s) => s.id === currentServerId);
        if (!server) {
          onExitRef.current(1);
          return;
        }
        const remoteCwd = currentWorkingDir || server.defaultDirectory;
        const ssh = getSshCommand(server, terminalType, remoteCwd, sessionResumeIdRef.current);
        command = ssh.command;
        args = ssh.args;
        cwd = undefined;
      } else {
        const extraArgs: string[] = [];
        const yoloFlag = getYoloFlag(terminalType);
        if (yoloFlag && (forceYoloRef.current || useAppStore.getState().cliYolo[terminalType])) {
          extraArgs.push(yoloFlag);
        }
        console.log(`[PTY] spawn ${terminalType}`, extraArgs.length ? `extraArgs: ${extraArgs.join(" ")}` : "(no extra args)", `forceYolo=${forceYoloRef.current}`);
        const resumeId = sessionResumeIdRef.current;
        cwd = currentWorkingDir || undefined;

        if (backend === "windows") {
          // Windows native: use resolved CLI path directly, native Windows cwd
          const config = getTerminalConfig(terminalType, resumeId, extraArgs, undefined, "windows");
          command = config.command;
          args = [...config.args];
          // cwd stays as native Windows path
        } else {
          // WSL backend
          let wslCwd: string | undefined;
          if (cwd && isWslTerminal(terminalType, backend)) {
            wslCwd = toWslPath(cwd);
          }

          // For resume spawns, pass wslCwd so cd is baked into bash -lic command
          // (avoids wsl.exe --cd flag which can cause arg parsing issues)
          const config = getTerminalConfig(terminalType, resumeId, extraArgs, resumeId ? wslCwd : undefined);
          command = config.command;

          args = [...config.args];
          if (isWslTerminal(terminalType, backend) && wslCwd && !resumeId) {
            // Fresh spawns: use wsl.exe --cd flag
            args = ["--cd", wslCwd, ...args];
          }
          cwd = undefined;
        }
      }

      const onDataChan = new Channel<number[]>();
      onDataChan.onmessage = (data) => {
        // Guard: discard data from stale spawns (e.g. React StrictMode double-fire
        // where the first PTY starts before cleanup cancels it)
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

        // Try pre-warmed WSL pool first (near-instant, skips wsl.exe startup).
        // Skip pool for session resume — pooled bash uses --norc --noprofile
        // which may lack env setup that Claude needs for --resume.
        // The normal spawn path uses bash -lic (full login shell) for resume.
        // Windows mode skips pool entirely (no WSL pool).
        if (!currentServerId && backend !== "windows" && isWslTerminal(terminalType, backend) && !sessionResumeIdRef.current) {
          const wslCwd = currentWorkingDir ? toWslPath(currentWorkingDir) : undefined;
          const poolExtraArgs: string[] = [];
          const poolYoloFlag = getYoloFlag(terminalType);
          if (poolYoloFlag && (forceYoloRef.current || useAppStore.getState().cliYolo[terminalType])) {
            poolExtraArgs.push(poolYoloFlag);
          }
          const initCmd = getPooledInitCommand(terminalType, wslCwd, sessionResumeIdRef.current, poolExtraArgs, backend);
          if (initCmd) {
            console.log(`[PTY] using pool for ${terminalType}`, poolExtraArgs.length ? `extraArgs: ${poolExtraArgs.join(" ")}` : "(no extra args)");
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
