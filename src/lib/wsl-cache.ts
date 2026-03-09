import { invoke } from "@tauri-apps/api/core";

interface WslCliCache {
  path: string;
  distro: string;
  resolvedPaths: Record<string, string>;
  timestamp: number;
}

const CACHE_KEY = "ezydev-wsl-cli-cache";
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

let cache: WslCliCache | null = null;
let resolving = false;

// Promise that resolves once WSL is booted, paths are cached, and pool is warm.
// Consumers can `await wslReady` before spawning WSL terminals.
let readyResolve: () => void;
export const wslReady = new Promise<void>((resolve) => { readyResolve = resolve; });

function loadCache(): WslCliCache | null {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WslCliCache;
    if (Date.now() - parsed.timestamp > CACHE_TTL) return null;
    cache = parsed;
    return cache;
  } catch {
    return null;
  }
}

function saveCache(data: WslCliCache) {
  cache = data;
  localStorage.setItem(CACHE_KEY, JSON.stringify(data));
}

/**
 * Resolve CLI paths and PATH inside WSL. Called once at app startup.
 * Also serves as WSL pre-warm (boots the WSL instance).
 */
export async function resolveWslCliPaths(): Promise<void> {
  if (resolving) return;
  resolving = true;
  try {
    const result = await invoke<Record<string, string>>("wsl_resolve_cli_env", {
      cliNames: ["claude", "codex", "gemini"],
    });
    const path = result["PATH"] || "";
    const distro = result["DISTRO"] || "";
    const resolvedPaths: Record<string, string> = {};
    for (const [key, value] of Object.entries(result)) {
      if (key !== "PATH" && key !== "DISTRO" && value) {
        resolvedPaths[key] = value;
      }
    }
    saveCache({ path, distro, resolvedPaths, timestamp: Date.now() });
    console.log("[wsl-cache] resolved:", Object.keys(resolvedPaths).join(", "), distro ? `(${distro})` : "");
    // Pre-warm the WSL pool now that WSL VM is booted and cache is ready.
    // Await so that wslReady consumers can use the pooled spawn path.
    await invoke("pty_pool_warm", { count: 16, distro: distro || null }).catch(() => {});
  } catch (e) {
    console.error("[wsl-cache] Resolution failed:", e);
  } finally {
    resolving = false;
    readyResolve(); // Signal ready even on failure — spawns will use fallback path
  }
}

/**
 * Get cached WSL PATH string, or null if not yet resolved.
 */
export function getCachedWslPath(): string | null {
  return loadCache()?.path || null;
}

/**
 * Get the cached absolute path for a CLI tool, or null if not cached.
 */
export function getCachedCliPath(name: string): string | null {
  return loadCache()?.resolvedPaths[name] || null;
}

/**
 * Get the cached WSL distro name, or null if not cached.
 */
export function getCachedDistro(): string | null {
  return loadCache()?.distro || null;
}
