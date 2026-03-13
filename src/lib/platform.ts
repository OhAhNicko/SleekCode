import { platform as tauriPlatform } from "@tauri-apps/plugin-os";

type Platform = "windows" | "macos" | "linux";

let cached: Platform | null = null;

/** Get the current platform. Caches after first call. */
export function getPlatform(): Platform {
  if (cached) return cached;
  try {
    const p = tauriPlatform();
    if (p === "macos") cached = "macos";
    else if (p === "linux") cached = "linux";
    else cached = "windows";
  } catch {
    // Fallback: assume windows (original target)
    cached = "windows";
  }
  return cached;
}

export function isMacOS(): boolean {
  return getPlatform() === "macos";
}

export function isWindows(): boolean {
  return getPlatform() === "windows";
}

export function isLinux(): boolean {
  return getPlatform() === "linux";
}

/** Returns the default terminal backend for the current platform. */
export function getDefaultBackend(): "wsl" | "windows" | "native" {
  const p = getPlatform();
  if (p === "macos" || p === "linux") return "native";
  return "wsl";
}
