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
 * On Windows, only paths that unambiguously live in the WSL filesystem
 * (`/home/`, `/root/`, `\\wsl.localhost\`, `\\wsl$\`) return "wsl"; everything
 * else (Windows drives, `/mnt/<drive>/`, non-WSL UNCs) falls through to the
 * supplied fallback so the user's global preference still wins. This matches
 * v0.1.34 behavior — actively returning "windows" introduced regressions in
 * the Windows-backend spawn path (npm `.cmd` shim execution, CLI cache
 * timing) that v0.1.35-v0.1.38 couldn't reliably fix.
 */
export function detectBackendForPath(rawPath: string, fallback: TerminalBackend): TerminalBackend {
  if (getPlatform() !== "windows") return "native";
  if (!rawPath) return fallback;
  const p = rawPath.replace(/\\/g, "/").toLowerCase();
  if (p.startsWith("/mnt/")) return "wsl";
  if (p.startsWith("/home/")) return "wsl";
  if (p.startsWith("/root/")) return "wsl";
  if (p.startsWith("//wsl.localhost/")) return "wsl";
  if (p.startsWith("//wsl$/")) return "wsl";
  return fallback;
}
