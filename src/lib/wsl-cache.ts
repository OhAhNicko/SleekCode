import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";

interface WslCliCache {
  path: string;
  distro: string;
  resolvedPaths: Record<string, string>;
  timestamp: number;
}

const CACHE_KEY = "made-wsl-cli-cache";
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

let cache: WslCliCache | null = null;
let resolving = false;
/** One delayed re-resolve when startup resolution finds zero CLIs. */
let retriedEmptyResolve = false;

// Promise that resolves once WSL is booted, paths are cached, and pool is warm.
// Consumers can `await wslReady` before spawning WSL terminals.
let readyResolve: () => void;
export const wslReady = new Promise<void>((resolve) => { readyResolve = resolve; });

/**
 * Distros registered by container tooling (Docker Desktop, Rancher Desktop,
 * Podman). They are minimal busybox images — no bash login shell, no CLIs —
 * and never a valid terminal target, yet any of them can end up as wsl.exe's
 * DEFAULT distro (registered first, or left as a stale default after an
 * Ubuntu reinstall). Hidden from the Settings picker and skipped by the
 * default-distro fallback below.
 */
const UTILITY_DISTRO = /^(docker-desktop|rancher-desktop|podman-machine)/i;

export function isUtilityDistro(name: string): boolean {
  return UTILITY_DISTRO.test(name.trim());
}

/** First installed distro that is a real terminal target, or null. */
async function firstRealDistro(): Promise<string | null> {
  try {
    const distros = await invoke<string[]>("wsl_list_distros");
    return distros.find((d) => !isUtilityDistro(d)) ?? null;
  } catch {
    return null;
  }
}

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
    // Resolve INSIDE the selected distro (Settings > Terminal > Backend) —
    // CLI install paths differ per distro. null = wsl.exe's default distro.
    const selectedDistro = useAppStore.getState().wslDistro;
    let result: Record<string, string>;
    try {
      result = await invoke<Record<string, string>>("wsl_resolve_cli_env", {
        cliNames: ["claude", "codex", "gemini"],
        distro: selectedDistro,
      });
      // Landing in a container utility distro is the failure case even when
      // bash happened to run — never pin spawns to docker-desktop.
      if (!selectedDistro && isUtilityDistro(result["DISTRO"] || "")) {
        throw new Error(`wsl.exe default distro "${result["DISTRO"]}" is a container utility distro`);
      }
    } catch (e) {
      // "Default" mode and the resolve died: wsl.exe's default is typically a
      // utility distro (docker-desktop has no bash) or a stale registration,
      // and retrying it can never succeed. Resolve in the first real installed
      // distro instead — caching its DISTRO below pins pane spawns and the
      // pool warm to it for the TTL, so terminals keep working. An explicit
      // Settings override never falls back; that would silently ignore the
      // user's choice.
      const fallback = selectedDistro ? null : await firstRealDistro();
      if (!fallback) throw e;
      console.warn(`[wsl-cache] default distro failed (${String(e)}) — retrying in "${fallback}"`);
      result = await invoke<Record<string, string>>("wsl_resolve_cli_env", {
        cliNames: ["claude", "codex", "gemini"],
        distro: fallback,
      });
    }
    // Distro changed mid-flight (Settings clears the cache, then re-resolves):
    // these paths belong to the OLD distro — saving them would poison the fast
    // spawn path until the 24h TTL. Drop them and resolve again.
    if (useAppStore.getState().wslDistro !== selectedDistro) {
      resolving = false;
      return resolveWslCliPaths();
    }
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
    if (Object.keys(resolvedPaths).length === 0) {
      // No CLI resolved at all — pooled spawns lose their absolute-path fast
      // form for the next 24h (the login-shell fallback still pools). Seen
      // shipping {} on real hardware while the same script resolved fine by
      // hand; Rust dlogs the raw output, and one delayed retry covers a
      // WSL-still-booting first attempt.
      console.error("[wsl-cache] resolution returned NO CLI paths (PATH ok:", !!path, ") — retrying once in 15s");
      if (!retriedEmptyResolve) {
        retriedEmptyResolve = true;
        setTimeout(() => void resolveWslCliPaths(), 15000);
      }
    }
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
 * The distro every WSL spawn should target: the user's Settings override
 * first, else the detected default distro from the cache, else null
 * (= let wsl.exe pick its default).
 */
export function getCachedDistro(): string | null {
  return useAppStore.getState().wslDistro || loadCache()?.distro || null;
}

/**
 * Drop the resolved-paths cache. Called when the distro override changes:
 * cached absolute CLI paths (e.g. ~/.nvm/.../claude) belong to the OLD
 * distro, and the fast spawn path would exec a nonexistent file in the new
 * one. Follow with resolveWslCliPaths() to re-resolve and re-warm the pool.
 */
export function clearWslCliCache(): void {
  cache = null;
  localStorage.removeItem(CACHE_KEY);
}
