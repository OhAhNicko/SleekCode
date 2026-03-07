import { useEffect, useRef, useCallback } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import type { TerminalType } from "../types";
import { getTerminalConfig, getPooledInitCommand, isWslTerminal, toWslPath, getSshCommand } from "../lib/terminal-config";
import { getCachedDistro, wslReady } from "../lib/wsl-cache";
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
}: UsePtyOptions) {
  const ptyIdRef = useRef<number | null>(null);
  const spawnIdRef = useRef(0);
  // Capture resume ID via ref — read once at spawn time, never triggers re-spawn.
  // The ID is persisted to localStorage on exit and used on next app restart.
  const sessionResumeIdRef = useRef(sessionResumeId);
  sessionResumeIdRef.current = sessionResumeId;

  useEffect(() => {
    const thisSpawnId = ++spawnIdRef.current;
    let cancelled = false;

    // Defer spawn to next macrotask. In React StrictMode's
    // mount->cleanup->remount cycle, the first mount's timer is
    // cancelled before it fires, so only ONE ConPTY is ever created.
    const timerId = setTimeout(async () => {
      // For resume spawns, wait for WSL to boot before invoking wsl.exe.
      // Fresh spawns can race ahead and use the pool (or start wsl.exe cold).
      if (isWslTerminal(terminalType) && sessionResumeIdRef.current) {
        await wslReady;
        if (cancelled) return;
      }
      let command: string;
      let args: string[];
      let cwd: string | undefined;

      if (serverId) {
        const server = useAppStore.getState().servers.find((s) => s.id === serverId);
        if (!server) {
          onExit(1);
          return;
        }
        const remoteCwd = workingDir || server.defaultDirectory;
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
        cwd = workingDir || undefined;
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
        onData(new Uint8Array(data));
      };

      const onExitChan = new Channel<number>();
      onExitChan.onmessage = (code) => {
        if (spawnIdRef.current === thisSpawnId) {
          onExit(code);
        }
      };

      try {
        let id: number | undefined;

        // Try pre-warmed WSL pool first (near-instant, skips wsl.exe startup).
        // Skip pool for session resume — pooled bash uses --norc --noprofile
        // which may lack env setup that Claude needs for --resume.
        // The normal spawn path uses bash -lic (full login shell) for resume.
        if (!serverId && isWslTerminal(terminalType) && !sessionResumeIdRef.current) {
          const wslCwd = workingDir ? toWslPath(workingDir) : undefined;
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
                cols: Math.max(cols, 2),
                rows: Math.max(rows, 2),
                onData: onDataChan,
                onExit: onExitChan,
              });
              // Replenish pool in background
              invoke("pty_pool_warm", { count: 1, distro: getCachedDistro() ?? null }).catch(() => {});
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

        if (cancelled) {
          invoke("pty_kill", { ptyId: id }).catch(() => {});
          return;
        }

        ptyIdRef.current = id;

        if (injectShellIntegration) {
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
        if (!cancelled) {
          onExit(1);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalType, workingDir, serverId, injectShellIntegration]);

  const write = useCallback((data: string) => {
    if (ptyIdRef.current !== null) {
      invoke("pty_write", { ptyId: ptyIdRef.current, data });
    }
  }, []);

  const resize = useCallback((newCols: number, newRows: number) => {
    if (ptyIdRef.current !== null) {
      invoke("pty_resize", { ptyId: ptyIdRef.current, cols: newCols, rows: newRows });
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
