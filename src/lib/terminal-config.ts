import type { TerminalConfig, TerminalType } from "../types";

// Tauri PTY uses Windows ConPTY. AI CLIs are installed in WSL,
// so they must be launched via wsl.exe with a login shell (to get PATH).
// `bash -lic "exec <cmd>"` sources .bashrc/.profile then replaces bash with the command.
export const TERMINAL_CONFIGS: Record<TerminalType, TerminalConfig> = {
  claude: {
    command: "wsl.exe",
    args: ["--", "bash", "-lic", "exec claude"],
    label: "Claude Code",
    description: "Anthropic's AI coding assistant",
  },
  codex: {
    command: "wsl.exe",
    args: ["--", "bash", "-lic", "exec codex"],
    label: "Codex CLI",
    description: "OpenAI's coding CLI",
  },
  gemini: {
    command: "wsl.exe",
    args: ["--", "bash", "-lic", "exec gemini"],
    label: "Gemini CLI",
    description: "Google's AI coding CLI",
  },
  shell: {
    command: "powershell.exe",
    args: [],
    label: "PowerShell",
    description: "Windows PowerShell",
  },
};

/**
 * Convert a Windows path to a WSL Linux path.
 * Handles both drive paths and UNC WSL paths:
 *   C:\Users\foo       → /mnt/c/Users/foo
 *   \\wsl.localhost\Ubuntu-24.04\home\foo → /home/foo
 *   \\wsl$\Ubuntu-24.04\home\foo         → /home/foo
 */
export function toWslPath(winPath: string): string {
  if (!winPath) return "";

  // UNC WSL path: \\wsl.localhost\Distro\path or \\wsl$\Distro\path
  const uncMatch = winPath.match(
    /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/][^\\/]+[\\/]?(.*)/i
  );
  if (uncMatch) {
    const rest = uncMatch[1].replace(/\\/g, "/");
    return rest ? `/${rest}` : "/";
  }

  // Standard drive path: C:\foo\bar → /mnt/c/foo/bar
  return winPath
    .replace(
      /^([A-Za-z]):\\/,
      (_m, drive: string) => `/mnt/${drive.toLowerCase()}/`
    )
    .replace(/\\/g, "/");
}

/** Returns true if the terminal type runs inside WSL */
export function isWslTerminal(type: TerminalType): boolean {
  return type !== "shell";
}

/** Map terminal type to the remote command to exec over SSH */
function getRemoteExecCommand(type: TerminalType): string {
  switch (type) {
    case "claude":
      return "exec claude";
    case "codex":
      return "exec codex";
    case "gemini":
      return "exec gemini";
    case "shell":
      return "exec bash -l";
  }
}

/**
 * Build SSH command + args for spawning a remote terminal.
 * Uses native Windows ssh.exe (no WSL wrapping needed).
 */
export function getSshCommand(
  server: { username: string; localIp: string; tailscaleHostname: string; preferTailscale: boolean; authMethod: string; sshKeyPath?: string },
  terminalType: TerminalType,
  remoteCwd?: string
): { command: string; args: string[] } {
  const host = server.preferTailscale ? server.tailscaleHostname : server.localIp;
  const userHost = `${server.username}@${host}`;

  const args: string[] = ["-t"];

  // Add identity file for ssh-key auth
  if (server.authMethod === "ssh-key" && server.sshKeyPath) {
    args.push("-i", server.sshKeyPath);
  }

  // Disable strict host key checking for convenience (local network / Tailscale)
  args.push("-o", "StrictHostKeyChecking=no");

  args.push(userHost);

  // Build the remote command: cd to dir (if specified) then exec the tool
  const remoteCmd = getRemoteExecCommand(terminalType);
  if (remoteCwd) {
    args.push(`cd ${remoteCwd} && ${remoteCmd}`);
  } else {
    args.push(remoteCmd);
  }

  return { command: "ssh.exe", args };
}
