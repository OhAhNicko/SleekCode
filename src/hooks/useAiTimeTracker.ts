import { useEffect, useRef } from "react";
import { useAppStore } from "../store";
import { flushStaleBursts } from "../lib/terminal-activity";

/**
 * Listens for `ezydev:ai-done` CustomEvents and records each burst
 * into the aiTimeBursts persistence layer.
 *
 * Also runs a periodic sweep to flush stale bursts from idle terminals.
 */
export function useAiTimeTracker(): void {
  const recordAiBurst = useAppStore((s) => s.recordAiBurst);
  const recordRef = useRef(recordAiBurst);
  recordRef.current = recordAiBurst;

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail) return;

      const { terminalId, terminalType, durationMs } = detail as {
        terminalId: string;
        terminalType: string;
        durationMs: number;
      };

      if (!terminalId || !durationMs || durationMs < 0) return;

      // Only track AI CLI types
      const cli = terminalType as "claude" | "codex" | "gemini";
      if (cli !== "claude" && cli !== "codex" && cli !== "gemini") return;

      // Look up working dir from terminal store
      const terminals = useAppStore.getState().terminals;
      const terminal = terminals[terminalId];
      const project = terminal?.workingDir || "unknown";

      recordRef.current({
        project,
        cli,
        durationMs,
        endedAt: Date.now(),
      });
    };

    window.addEventListener("ezydev:ai-done", handler);

    // Periodic sweep to flush stale bursts (terminals that went idle)
    const interval = setInterval(() => {
      flushStaleBursts();
    }, 5000);

    return () => {
      window.removeEventListener("ezydev:ai-done", handler);
      clearInterval(interval);
    };
  }, []);
}
