/**
 * Tab-hibernation engine. Mount once (App). Three jobs:
 *
 * 1. Wake safety net: whatever path makes a hibernated tab active (boot
 *    restore, programmatic activation), it never renders asleep.
 * 2. Signal collection: periodic MADE_PANE_ID CPU sweep (wsl_pane_activity)
 *    and Claude transcript mtime checks, feeding pane-idle.ts. Runs whenever
 *    WSL panes exist — the tab context menu's verdict needs it even while
 *    auto mode is off.
 * 3. Auto mode (Settings > General > "Auto-hibernate idle tabs", default
 *    off): background tabs whose EVERY pane has been quiet on EVERY signal
 *    for the configured window are hibernated. Signals that cannot be read
 *    fail safe (pane counts as working — see pane-idle.ts).
 */
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { isWindows } from "../lib/platform";
import { getCachedDistro } from "../lib/wsl-cache";
import { toWslPath } from "../lib/terminal-config";
import { findAllTerminalLeaves } from "../lib/layout-utils";
import {
  SWEEP_INTERVAL_MS,
  ingestCpuSweep,
  ingestSessionActivity,
  dropSessionActivity,
  tabIdleVerdict,
  type PaneCpuSample,
} from "../lib/pane-idle";

const AUTO_CHECK_MS = 60_000;

export default function HibernationEngine() {
  // 1. Wake safety net.
  const activeTabId = useAppStore((s) => s.activeTabId);
  const activeHibernated = useAppStore(
    (s) => !!s.tabs.find((t) => t.id === s.activeTabId)?.isHibernated,
  );
  useEffect(() => {
    if (activeHibernated) useAppStore.getState().wakeTab(activeTabId);
  }, [activeHibernated, activeTabId]);

  // 2. Signal collection.
  useEffect(() => {
    if (!isWindows()) return;
    let stopped = false;
    let inFlight = false;
    const tick = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const s = useAppStore.getState();
        if (s.terminalBackend !== "wsl" || Object.keys(s.terminals).length === 0) return;
        const distro = getCachedDistro() || null;
        try {
          const samples = await invoke<PaneCpuSample[]>("wsl_pane_activity", { distro });
          if (!stopped) ingestCpuSweep(samples, Date.now());
        } catch {
          // Sweep failed (VM wedged?): samples go stale → every pane reads
          // "CPU signal unavailable" → nothing auto-hibernates. Exactly right.
        }
        for (const tab of s.tabs) {
          if (stopped) return;
          if (!tab.layout || tab.serverId || tab.isHibernated) continue;
          for (const leaf of findAllTerminalLeaves(tab.layout)) {
            const term = s.terminals[leaf.terminalId];
            if (!term || term.type !== "claude" || !leaf.sessionResumeId) continue;
            try {
              const mtime = await invoke<number>("claude_session_activity_mtime", {
                projectPath: toWslPath(tab.workingDir),
                sessionId: leaf.sessionResumeId,
                distro,
              });
              if (!stopped) ingestSessionActivity(leaf.terminalId, mtime, Date.now());
            } catch {
              if (!stopped) dropSessionActivity(leaf.terminalId);
            }
          }
        }
      } finally {
        inFlight = false;
      }
    };
    const iv = setInterval(() => void tick(), SWEEP_INTERVAL_MS);
    void tick();
    return () => {
      stopped = true;
      clearInterval(iv);
    };
  }, []);

  // 3. Auto mode.
  const autoEnabled = useAppStore((s) => s.autoHibernateEnabled);
  const autoMinutes = useAppStore((s) => s.autoHibernateMinutes);
  useEffect(() => {
    if (!autoEnabled || !isWindows()) return;
    const quietMs = Math.max(5, autoMinutes) * 60_000;
    const iv = setInterval(() => {
      const s = useAppStore.getState();
      if (s.terminalBackend !== "wsl") return;
      for (const tab of s.tabs) {
        if (tab.id === s.activeTabId || tab.isHibernated) continue;
        const v = tabIdleVerdict(tab, s.terminals, quietMs);
        if (v.eligible && !v.working) s.hibernateTab(tab.id);
      }
    }, AUTO_CHECK_MS);
    return () => clearInterval(iv);
  }, [autoEnabled, autoMinutes]);

  return null;
}
