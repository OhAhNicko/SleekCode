import { invoke } from "@tauri-apps/api/core";

interface NativeCliCache {
  resolvedPaths: Record<string, string>;
  timestamp: number;
}

const CACHE_KEY = "ezydev-native-cli-cache";
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

let cache: NativeCliCache | null = null;
let resolving = false;

// Promise that resolves once native CLI paths are cached.
let readyResolve: () => void;
export const nativeReady = new Promise<void>((resolve) => { readyResolve = resolve; });

function loadCache(): NativeCliCache | null {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as NativeCliCache;
    if (Date.now() - parsed.timestamp > CACHE_TTL) return null;
    cache = parsed;
    return cache;
  } catch {
    return null;
  }
}

function saveCache(data: NativeCliCache) {
  cache = data;
  localStorage.setItem(CACHE_KEY, JSON.stringify(data));
}

/**
 * Resolve CLI paths on macOS/Linux using `which`.
 * Called once at app startup when terminalBackend === "native".
 */
export async function resolveNativeCliPaths(): Promise<void> {
  if (resolving) return;
  resolving = true;
  try {
    const result = await invoke<Record<string, string>>("native_resolve_cli_env", {
      cliNames: ["claude", "codex", "gemini"],
    });
    const resolvedPaths: Record<string, string> = {};
    for (const [key, value] of Object.entries(result)) {
      if (value) {
        resolvedPaths[key] = value;
      }
    }
    saveCache({ resolvedPaths, timestamp: Date.now() });
    console.log("[native-cli-cache] resolved:", Object.keys(resolvedPaths).join(", "));
  } catch (e) {
    console.error("[native-cli-cache] Resolution failed:", e);
  } finally {
    resolving = false;
    readyResolve();
  }
}

/**
 * Get the cached native executable path for a CLI tool, or null if not cached.
 */
export function getCachedNativeCliPath(name: string): string | null {
  return loadCache()?.resolvedPaths[name] || null;
}
