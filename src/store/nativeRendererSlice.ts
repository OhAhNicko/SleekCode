import type { StateCreator } from "zustand";
import type { NativeTermId } from "../lib/native-term-bridge";

export type PaneRendererOverride = "native" | "xterm" | null;

export interface NativeRendererTelemetry {
  panes: number;
  crashes: number;
  lastCrashAt: number | null;
}

export interface NativeRendererSlice {
  useNativeTerminalRenderer: boolean;
  paneRendererOverride: Record<string, Exclude<PaneRendererOverride, null>>;
  nativeRendererTelemetry: NativeRendererTelemetry;
  // Tracks every alive native-term HWND id so coordinators (e.g. modal
  // visibility broadcaster owned by workstream-O) can iterate them.
  // Always replaced immutably — never mutated via .add()/.delete() — so
  // Zustand selector identity flips only on actual content change.
  liveNativeTerms: ReadonlySet<NativeTermId>;

  setUseNativeTerminalRenderer: (v: boolean) => void;
  setPaneRendererOverride: (paneId: string, override: PaneRendererOverride) => void;
  recordNativeRendererCrash: () => void;
  registerNativeTerm: (id: NativeTermId) => void;
  unregisterNativeTerm: (id: NativeTermId) => void;
}

const EMPTY_LIVE: ReadonlySet<NativeTermId> = new Set();

export const createNativeRendererSlice: StateCreator<
  NativeRendererSlice,
  [],
  [],
  NativeRendererSlice
> = (set, get) => ({
  useNativeTerminalRenderer: false,
  paneRendererOverride: {},
  nativeRendererTelemetry: { panes: 0, crashes: 0, lastCrashAt: null },
  liveNativeTerms: EMPTY_LIVE,

  setUseNativeTerminalRenderer: (v) => set({ useNativeTerminalRenderer: v }),

  setPaneRendererOverride: (paneId, override) => {
    const prev = get().paneRendererOverride;
    if (override === null) {
      if (!(paneId in prev)) return;
      const next = { ...prev };
      delete next[paneId];
      set({ paneRendererOverride: next });
    } else {
      if (prev[paneId] === override) return;
      set({ paneRendererOverride: { ...prev, [paneId]: override } });
    }
  },

  recordNativeRendererCrash: () =>
    set((s) => ({
      nativeRendererTelemetry: {
        ...s.nativeRendererTelemetry,
        crashes: s.nativeRendererTelemetry.crashes + 1,
        lastCrashAt: Date.now(),
      },
    })),

  registerNativeTerm: (id) => {
    const prev = get().liveNativeTerms;
    if (prev.has(id)) return;
    const next = new Set(prev);
    next.add(id);
    set({
      liveNativeTerms: next,
      nativeRendererTelemetry: {
        ...get().nativeRendererTelemetry,
        panes: next.size,
      },
    });
  },

  unregisterNativeTerm: (id) => {
    const prev = get().liveNativeTerms;
    if (!prev.has(id)) return;
    const next = new Set(prev);
    next.delete(id);
    set({
      liveNativeTerms: next,
      nativeRendererTelemetry: {
        ...get().nativeRendererTelemetry,
        panes: next.size,
      },
    });
  },
});
