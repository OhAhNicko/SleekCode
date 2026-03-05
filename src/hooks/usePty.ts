import { useEffect, useRef, useCallback } from "react";
import { spawn } from "tauri-pty";
import type { TerminalType } from "../types";
import { TERMINAL_CONFIGS, isWslTerminal, toWslPath, getSshCommand } from "../lib/terminal-config";
import { useAppStore } from "../store";
import { getShellIntegrationCommand } from "../lib/shell-integration";

interface IPty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: number): void;
  onData(callback: (data: Uint8Array) => void): void;
  onExit(callback: (e: { exitCode: number }) => void): void;
}

interface UsePtyOptions {
  terminalType: TerminalType;
  workingDir: string;
  cols: number;
  rows: number;
  onData: (data: Uint8Array) => void;
  onExit: (exitCode: number) => void;
  serverId?: string;
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
  injectShellIntegration = false,
}: UsePtyOptions) {
  const ptyRef = useRef<IPty | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

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
      const ssh = getSshCommand(server, terminalType, remoteCwd);
      command = ssh.command;
      args = ssh.args;
      cwd = undefined;
    } else {
      const config = TERMINAL_CONFIGS[terminalType];
      command = config.command;
      cwd = workingDir || undefined;

      if (cwd && isWslTerminal(terminalType)) {
        cwd = toWslPath(cwd);
      }

      args = [...config.args];
      if (isWslTerminal(terminalType) && cwd) {
        args = ["--cd", cwd, ...args];
        cwd = undefined;
      }
    }

    const pty = spawn(command, args, {
      cols,
      rows,
      cwd,
      env: { TERM: "xterm-256color" },
    }) as unknown as IPty;

    ptyRef.current = pty;

    if (injectShellIntegration) {
      setTimeout(() => {
        if (mountedRef.current && ptyRef.current) {
          ptyRef.current.write(getShellIntegrationCommand());
        }
      }, 300);
    }

    pty.onData((data: Uint8Array) => {
      if (mountedRef.current) {
        onData(data);
      }
    });

    pty.onExit(({ exitCode }: { exitCode: number }) => {
      if (mountedRef.current) {
        onExit(exitCode);
      }
    });

    return () => {
      mountedRef.current = false;
      try {
        pty.kill();
      } catch {
        // PTY may already be dead
      }
      ptyRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalType, workingDir, serverId, injectShellIntegration]);

  const write = useCallback((data: string) => {
    ptyRef.current?.write(data);
  }, []);

  const resize = useCallback((newCols: number, newRows: number) => {
    ptyRef.current?.resize(newCols, newRows);
  }, []);

  const kill = useCallback(() => {
    try {
      ptyRef.current?.kill();
    } catch {
      // Already dead
    }
  }, []);

  return { write, resize, kill };
}
