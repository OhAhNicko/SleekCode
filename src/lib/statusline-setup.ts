import { invoke } from "@tauri-apps/api/core";
import { getCachedDistro } from "./wsl-cache";
import { isWindows } from "./platform";

/**
 * Install the EzyDev statusline wrapper.
 * On Windows/WSL: installs via wsl.exe with optional distro.
 * On macOS/Linux: installs directly via bash.
 *
 * Creates ~/.ezydev/statusline-wrapper.sh and updates ~/.claude/settings.json
 * to chain through our wrapper before the user's original statusline script.
 *
 * Safe to call multiple times — skips if already installed.
 */
export async function installStatuslineWrapper(): Promise<void> {
  const distro = isWindows() ? getCachedDistro() : null;
  try {
    const result = await invoke<string>("install_statusline_wrapper", {
      distro: distro || null,
    });
    console.log("[statusline-setup]", result);
  } catch (e) {
    console.error("[statusline-setup] installation failed:", e);
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
