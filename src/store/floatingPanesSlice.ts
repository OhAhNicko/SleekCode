import type { StateCreator } from "zustand";
import type { PaneMode, FloatRect } from "../types";

const MIN_W = 320;
const MIN_H = 200;

function clampRect(r: FloatRect): FloatRect {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const w = Math.max(MIN_W, Math.min(r.w, vw));
  const h = Math.max(MIN_H, Math.min(r.h, vh));
  const x = Math.max(0, Math.min(r.x, vw - 80));
  const y = Math.max(0, Math.min(r.y, vh - 32));
  return { x, y, w, h };
}

function defaultFloatRect(): FloatRect {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const w = Math.round(vw * 0.7);
  const h = Math.round(vh * 0.7);
  return { x: Math.round((vw - w) / 2), y: Math.round((vh - h) / 2), w, h };
}

export interface FloatingPanesSlice {
  paneModes: Record<string, PaneMode>;
  floatRects: Record<string, FloatRect>;
  floatOrder: string[];
  /** Transient: panes mid close-animation. PaneGrid skips them so siblings stay expanded. Not persisted. */
  closingPanes: Record<string, true>;
  expandPane: (paneId: string) => void;
  popoutPane: (paneId: string) => void;
  minimizePane: (paneId: string) => void;
  bringToFront: (paneId: string) => void;
  setFloatRect: (paneId: string, rect: FloatRect) => void;
  cleanupPaneMode: (paneId: string) => void;
  markClosed: (paneId: string) => void;
}

export const createFloatingPanesSlice: StateCreator<
  FloatingPanesSlice,
  [],
  [],
  FloatingPanesSlice
> = (set) => ({
  paneModes: {},
  floatRects: {},
  floatOrder: [],
  closingPanes: {},

  expandPane: (paneId) => {
    set((state) => {
      const nextModes: Record<string, PaneMode> = { ...state.paneModes };
      // Only one expanded at a time — if any other pane is expanded, send it back to grid.
      for (const [id, mode] of Object.entries(nextModes)) {
        if (id !== paneId && mode === "expanded") {
          delete nextModes[id];
        }
      }
      nextModes[paneId] = "expanded";
      const nextOrder = state.floatOrder.filter((id) => id !== paneId).concat(paneId);
      const nextClosing = { ...state.closingPanes };
      delete nextClosing[paneId];
      return { paneModes: nextModes, floatOrder: nextOrder, closingPanes: nextClosing };
    });
  },

  popoutPane: (paneId) => {
    set((state) => {
      const rect = state.floatRects[paneId] ?? defaultFloatRect();
      const nextOrder = state.floatOrder.filter((id) => id !== paneId).concat(paneId);
      const nextClosing = { ...state.closingPanes };
      delete nextClosing[paneId];
      return {
        paneModes: { ...state.paneModes, [paneId]: "float" },
        floatRects: { ...state.floatRects, [paneId]: clampRect(rect) },
        floatOrder: nextOrder,
        closingPanes: nextClosing,
      };
    });
  },

  minimizePane: (paneId) => {
    set((state) => {
      const nextModes = { ...state.paneModes };
      delete nextModes[paneId]; // absence == "grid"
      const nextOrder = state.floatOrder.filter((id) => id !== paneId);
      // Mark closing atomically so PaneGrid keeps skipping the leaf (siblings stay
      // expanded) while FloatingPanesLayer animates the shrink-back.
      const nextClosing = { ...state.closingPanes, [paneId]: true as const };
      return { paneModes: nextModes, floatOrder: nextOrder, closingPanes: nextClosing };
    });
  },

  bringToFront: (paneId) => {
    set((state) => {
      if (state.floatOrder[state.floatOrder.length - 1] === paneId) return {};
      const nextOrder = state.floatOrder.filter((id) => id !== paneId).concat(paneId);
      return { floatOrder: nextOrder };
    });
  },

  setFloatRect: (paneId, rect) => {
    set((state) => ({ floatRects: { ...state.floatRects, [paneId]: clampRect(rect) } }));
  },

  cleanupPaneMode: (paneId) => {
    set((state) => {
      const nextModes = { ...state.paneModes };
      delete nextModes[paneId];
      const nextRects = { ...state.floatRects };
      delete nextRects[paneId];
      const nextOrder = state.floatOrder.filter((id) => id !== paneId);
      const nextClosing = { ...state.closingPanes };
      delete nextClosing[paneId];
      return { paneModes: nextModes, floatRects: nextRects, floatOrder: nextOrder, closingPanes: nextClosing };
    });
  },

  markClosed: (paneId) => {
    set((state) => {
      if (!state.closingPanes[paneId]) return {};
      const nextClosing = { ...state.closingPanes };
      delete nextClosing[paneId];
      return { closingPanes: nextClosing };
    });
  },
});
