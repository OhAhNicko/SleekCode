/**
 * One-shot WSL host-config health check (see src-tauri/src/wsl_health.rs).
 *
 * Every MADE user running WSL panes gets the memory-reclaim fix, not just
 * machines someone edited by hand: on startup this invokes
 * `wsl_ensure_memory_reclaim`, which adds `autoMemoryReclaim=gradual` +
 * `sparseVhd=true` to `%USERPROFILE%\.wslconfig` (additive only, backed up,
 * `[experimental]` section). Without it the WSL2 VM hoards freed memory until
 * it OOM-wedges under a dozen AI sessions — the "WSL died, had to
 * `wsl --shutdown`" failure.
 *
 * The localStorage marker makes the whole flow at-most-once per install: a
 * user who later deletes the keys from their file has made a decision, and
 * re-running would fight it. The Rust side is additionally idempotent
 * ("already") if the marker is ever cleared.
 *
 * Never restarts WSL — that kills live sessions. The toast tells the user the
 * change applies on their next `wsl --shutdown`.
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { isWindows } from "../lib/platform";
import { useOverlayToast } from "../lib/useOverlayToast";

const DONE_KEY = "made-wsl-reclaim-checked";
const TOAST_MS = 15000;

export default function WslHealthCheck() {
  const terminalBackend = useAppStore((s) => s.terminalBackend);
  const [toastOpen, setToastOpen] = useState(false);

  useEffect(() => {
    if (!isWindows() || terminalBackend !== "wsl") return;
    if (localStorage.getItem(DONE_KEY) === "1") return;
    let disposed = false;
    invoke<string>("wsl_ensure_memory_reclaim")
      .then((result) => {
        localStorage.setItem(DONE_KEY, "1");
        if (disposed) return;
        if (result === "applied" || result === "created") setToastOpen(true);
      })
      .catch(() => {
        // Unreadable profile dir etc. — leave the marker unset so the next
        // launch retries.
      });
    return () => {
      disposed = true;
    };
  }, [terminalBackend]);

  useEffect(() => {
    if (!toastOpen) return;
    const t = setTimeout(() => setToastOpen(false), TOAST_MS);
    return () => clearTimeout(t);
  }, [toastOpen]);

  useOverlayToast({
    id: "wsl-health-toast",
    open: toastOpen,
    payload: toastOpen
      ? {
          placement: "bottom-right",
          variant: "surface",
          title: "WSL memory fix applied",
          detail:
            "MADE enabled WSL's memory reclaim so heavy sessions can't wedge the VM. Takes effect after the next WSL restart (run: wsl --shutdown).",
          dismissable: true,
        }
      : null,
    onAction: () => setToastOpen(false),
  });

  return null;
}
