import { invoke } from "@tauri-apps/api/core";

interface WindowsCliCache {
  resolvedPaths: Record<string, string>;
  timestamp: number;
}

const CACHE_KEY = "ezydev-windows-cli-cache";
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

let cache: WindowsCliCache | null = null;
let resolving = false;

// Promise that resolves once Windows CLI paths are cached.
// Resolves fast — no WSL VM boot needed.
let readyResolve: () => void;
export const windowsReady = new Promise<void>((resolve) => { readyResolve = resolve; });

function loadCache(): WindowsCliCache | null {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WindowsCliCache;
    if (Date.now() - parsed.timestamp > CACHE_TTL) return null;
    cache = parsed;
    return cache;
  } catch {
    return null;
  }
}

function saveCache(data: WindowsCliCache) {
  cache = data;
  localStorage.setItem(CACHE_KEY, JSON.stringify(data));
}

/**
 * Resolve CLI paths on native Windows using where.exe.
 * Called once at app startup when terminalBackend === "windows".
 */
export async function resolveWindowsCliPaths(): Promise<void> {
  if (resolving) return;
  resolving = true;
  try {
    const result = await invoke<Record<string, string>>("windows_resolve_cli_env", {
      cliNames: ["claude", "codex", "gemini"],
    });
    const resolvedPaths: Record<string, string> = {};
    for (const [key, value] of Object.entries(result)) {
      if (value) {
        resolvedPaths[key] = value;
      }
    }
    saveCache({ resolvedPaths, timestamp: Date.now() });
    console.log("[windows-cli-cache] resolved:", Object.keys(resolvedPaths).join(", "));
    // No pool warming needed for Windows mode
  } catch (e) {
    console.error("[windows-cli-cache] Resolution failed:", e);
  } finally {
    resolving = false;
    readyResolve(); // Signal ready even on failure
  }
}

/**
 * Get the cached Windows executable path for a CLI tool, or null if not cached.
 */
export function getCachedWindowsCliPath(name: string): string | null {
  return loadCache()?.resolvedPaths[name] || null;
}
