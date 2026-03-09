import { useEffect, useRef, useCallback } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import type { TerminalType } from "../types";
import { getTerminalConfig, getPooledInitCommand, isWslTerminal, toWslPath, getSshCommand } from "../lib/terminal-config";
import { wslReady } from "../lib/wsl-cache";
import { useAppStore } from "../store";
import { getShellIntegrationCommand } from "../lib/shell-integration";

interface UsePtyOptions {
  terminalType: TerminalType;
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
}

export function usePty({
  terminalType,
  workingDir,
  cols,
  rows,
  onData,
  onExit,
  serverId,
  sessionResumeId,
  injectShellIntegration = false,
  ready = true,
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
  const workingDirRef = useRef(workingDir);
  workingDirRef.current = workingDir;
  const serverIdRef = useRef(serverId);
  serverIdRef.current = serverId;
  const injectShellIntegrationRef = useRef(injectShellIntegration);
  injectShellIntegrationRef.current = injectShellIntegration;
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

      // For resume spawns, wait for WSL to boot before invoking wsl.exe.
      // Fresh spawns can race ahead and use the pool (or start wsl.exe cold).
      if (isWslTerminal(terminalType) && sessionResumeIdRef.current) {
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
        if (terminalType === "claude" && useAppStore.getState().claudeYolo) {
          extraArgs.push("--dangerously-skip-permissions");
        }
        const resumeId = sessionResumeIdRef.current;
        cwd = currentWorkingDir || undefined;
        let wslCwd: string | undefined;
        if (cwd && isWslTerminal(terminalType)) {
          wslCwd = toWslPath(cwd);
        }

        // For resume spawns, pass wslCwd so cd is baked into bash -lic command
        // (avoids wsl.exe --cd flag which can cause arg parsing issues)
        const config = getTerminalConfig(terminalType, resumeId, extraArgs, resumeId ? wslCwd : undefined);
        command = config.command;

        args = [...config.args];
        if (isWslTerminal(terminalType) && wslCwd && !resumeId) {
          // Fresh spawns: use wsl.exe --cd flag
          args = ["--cd", wslCwd, ...args];
        }
        cwd = undefined;
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
        if (!currentServerId && isWslTerminal(terminalType) && !sessionResumeIdRef.current) {
          const wslCwd = currentWorkingDir ? toWslPath(currentWorkingDir) : undefined;
          const poolExtraArgs: string[] = [];
          if (terminalType === "claude" && useAppStore.getState().claudeYolo) {
            poolExtraArgs.push("--dangerously-skip-permissions");
          }
          const initCmd = getPooledInitCommand(terminalType, wslCwd, sessionResumeIdRef.current, poolExtraArgs);
          if (initCmd) {
            console.log(`[PTY] using pool for ${terminalType}`);
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
    // All other config is read from refs at spawn time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalType, ready]);

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
