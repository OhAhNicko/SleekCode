import { platform as tauriPlatform } from "@tauri-apps/plugin-os";
import type { TerminalBackend } from "../types";

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

/**
 * Pick the terminal backend for a project path. macOS/Linux always return "native".
 * On Windows:
 *  - WSL-filesystem paths (`/home/`, `/root/`, `\\wsl.localhost\`, `\\wsl$\`)
 *    → "wsl"
 *  - Windows-filesystem paths (`C:\…` drive paths, `/mnt/<drive>/…` WSL views
 *    of Windows drives, non-WSL UNCs `\\server\share\…`)
 *    → "windows" (NOT the global fallback — those projects belong in PowerShell
 *    regardless of the user's default backend setting; `/mnt/c/foo` is just a
 *    WSL view of `C:\foo`, the underlying filesystem is Windows)
 *  - Anything else (relative, malformed, empty) → fallback
 */
export function detectBackendForPath(rawPath: string, fallback: TerminalBackend): TerminalBackend {
  if (getPlatform() !== "windows") return "native";
  if (!rawPath) return fallback;
  const p = rawPath.replace(/\\/g, "/").toLowerCase();
  // WSL filesystem
  if (p.startsWith("/home/")) return "wsl";
  if (p.startsWith("/root/")) return "wsl";
  if (p.startsWith("//wsl.localhost/")) return "wsl";
  if (p.startsWith("//wsl$/")) return "wsl";
  // Windows filesystem — drive path, /mnt/<drive>/ view, or non-WSL UNC.
  if (/^[a-z]:\//.test(p)) return "windows";
  if (/^\/mnt\/[a-z]\//.test(p)) return "windows";
  if (p.startsWith("//")) return "windows";
  return fallback;
}
