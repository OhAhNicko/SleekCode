import { invoke } from "@tauri-apps/api/core";
import { getCachedDistro } from "./wsl-cache";
import { isWindows } from "./platform";
import { useAppStore } from "../store";

/** Per-process dedup: each server only gets installed once per app session. */
const installedServers = new Set<string>();
let localInstalled = false;

/**
 * Install the EzyDev statusline wrapper.
 *
 * - Local (no serverId): installs into the current host's ~/.ezydev/.
 *   On Windows/WSL: installs via wsl.exe with optional distro.
 *   On macOS/Linux: installs directly via bash.
 *
 * - SSH (serverId set): installs onto the remote host's ~/.ezydev/ via SSH.
 *   Required before context % can be read for SSH Claude tabs.
 *
 * Creates ~/.ezydev/statusline-wrapper.sh and updates ~/.claude/settings.json
 * to chain through our wrapper before the user's original statusline script.
 *
 * Safe to call multiple times — dedups per session both locally and per server.
 */
export async function installStatuslineWrapper(serverId?: string): Promise<void> {
  if (serverId) {
    if (installedServers.has(serverId)) return;
    installedServers.add(serverId);
    const server = useAppStore.getState().servers.find((s) => s.id === serverId);
    if (!server || server.authMethod !== "ssh-key" || !server.sshKeyPath) {
      console.warn("[statusline-setup] SSH install skipped: ssh-key auth required for server", serverId);
      return;
    }
    try {
      const result = await invoke<string>("install_statusline_wrapper_ssh", {
        host: server.host,
        username: server.username,
        identityFile: server.sshKeyPath,
      });
      console.log("[statusline-setup] ssh", server.name || server.host, ":", result);
    } catch (e) {
      console.error("[statusline-setup] ssh installation failed:", e);
      // Allow retry on next spawn rather than locking the user out.
      installedServers.delete(serverId);
    }
    return;
  }

  if (localInstalled) return;
  localInstalled = true;
  const distro = isWindows() ? getCachedDistro() : null;
  try {
    const result = await invoke<string>("install_statusline_wrapper", {
      distro: distro || null,
    });
    console.log("[statusline-setup]", result);
  } catch (e) {
    console.error("[statusline-setup] installation failed:", e);
    localInstalled = false;
  }
}

/**
 * Read the context percentage from the temp file written by the statusline wrapper.
 * Returns a number 0-100, or null if no data available.
 */
export async function readContextPercent(terminalId: string): Promise<number | null> {
  const distro = isWindows() ? getCachedDistro() : null;
  try {
    const raw = await invoke<string>("read_context_percent", {
      terminalId,
      distro: distro || null,
    });
    if (!raw) return null;
    const pct = parseInt(raw, 10);
    if (isNaN(pct) || pct < 0 || pct > 100) return null;
    return pct;
  } catch {
    return null;
  }
}
