import type { StateCreator } from "zustand";
import { isoWeekKey } from "../lib/iso-week";

export interface AiTimeBurst {
  week: string;           // ISO week key, e.g. "2026-W12"
  project: string;        // Normalized path (forward slashes)
  cli: "claude" | "codex" | "gemini";
  durationMs: number;
  endedAt: number;        // Timestamp
}

export interface AiTimeSlice {
  aiTimeBursts: AiTimeBurst[];
  recordAiBurst: (burst: Omit<AiTimeBurst, "week">) => void;
  clearAiTimeStats: () => void;
}

const MAX_BURSTS = 5000;

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

export const createAiTimeSlice: StateCreator<
  AiTimeSlice,
  [],
  [],
  AiTimeSlice
> = (set) => ({
  aiTimeBursts: [],

  recordAiBurst: (burst) => {
    const entry: AiTimeBurst = {
      ...burst,
      project: normalizePath(burst.project),
      week: isoWeekKey(burst.endedAt),
    };
    set((state) => {
      const next = [...state.aiTimeBursts, entry];
      // Cap at MAX_BURSTS — drop oldest
      if (next.length > MAX_BURSTS) {
        return { aiTimeBursts: next.slice(next.length - MAX_BURSTS) };
      }
      return { aiTimeBursts: next };
    });
  },

  clearAiTimeStats: () => set({ aiTimeBursts: [] }),
});
