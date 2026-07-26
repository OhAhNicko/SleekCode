import { create } from "zustand";
import type { CropState, Rect, Shape } from "../lib/annotations";

/**
 * Markup state per screenshot, keyed by `ClipboardImage.id`.
 *
 * Kept OUT of `clipboardImageStore` on purpose. Annotations are editor state,
 * not part of a screenshot's identity, and every consumer of `ClipboardImage`
 * (the composer, the terminal insert path, the strip) would otherwise have to
 * learn to ignore a field it can do nothing with. Keying by image id also means
 * clicking through the filmstrip and coming back preserves in-progress work,
 * which local component state would lose.
 *
 * ## One history for shapes AND crop
 *
 * Undo snapshots the whole editor state, not just the shape list. It used to
 * cover shapes only, which made Ctrl+Z actively wrong rather than merely
 * incomplete: draw two boxes, drag a crop, press Ctrl+Z, and it skipped the
 * crop and reverted box two. Undo must unwind actions in the order they
 * happened or it cannot be trusted at all.
 *
 * Whole-state snapshots follow `undoCloseStore.ts` — the house pattern is
 * snapshot-before-mutate, not a command/diff log. A snapshot is a shape array
 * and a rect; copying one per edit is far cheaper than the machinery needed to
 * avoid it.
 *
 * Session-only, like the screenshots themselves.
 */

/** Deepest the per-image undo stack goes before the oldest entry is dropped. */
const UNDO_LIMIT = 50;

interface Snapshot {
  shapes: Shape[];
  crop: CropState | null;
}

interface AnnotationState {
  shapes: Record<string, Shape[]>;
  crop: Record<string, CropState | null>;
  past: Record<string, Snapshot[]>;
  future: Record<string, Snapshot[]>;

  /** Replace the shape list, pushing the previous state onto the undo stack. */
  commit: (imageId: string, next: Shape[]) => void;
  /** Set (or clear) the pending crop region. */
  setCrop: (imageId: string, rect: Rect | null) => void;
  /** Apply the pending crop — the view clips to it from here on. */
  confirmCrop: (imageId: string) => void;
  undo: (imageId: string) => void;
  redo: (imageId: string) => void;
  clear: (imageId: string) => void;
}

const EMPTY: Shape[] = [];

export const useAnnotationStore = create<AnnotationState>((set) => {
  /**
   * Snapshot the current state for this image and drop the redo branch.
   * Every mutating action funnels through here so none can forget.
   */
  const advance = (
    s: AnnotationState,
    imageId: string,
    next: Partial<Snapshot>,
  ): Partial<AnnotationState> => {
    const prev: Snapshot = {
      shapes: s.shapes[imageId] ?? EMPTY,
      crop: s.crop[imageId] ?? null,
    };
    return {
      shapes: { ...s.shapes, [imageId]: next.shapes ?? prev.shapes },
      crop: { ...s.crop, [imageId]: next.crop !== undefined ? next.crop : prev.crop },
      past: { ...s.past, [imageId]: [...(s.past[imageId] ?? []), prev].slice(-UNDO_LIMIT) },
      future: { ...s.future, [imageId]: [] },
    };
  };

  /** Move one step along the history, snapshotting the current state the other way. */
  const step = (imageId: string, dir: "undo" | "redo") =>
    set((s) => {
      const from = dir === "undo" ? s.past[imageId] ?? [] : s.future[imageId] ?? [];
      if (from.length === 0) return {};
      const target = dir === "undo" ? from[from.length - 1] : from[0];
      const current: Snapshot = {
        shapes: s.shapes[imageId] ?? EMPTY,
        crop: s.crop[imageId] ?? null,
      };
      const remaining = dir === "undo" ? from.slice(0, -1) : from.slice(1);
      const other = dir === "undo" ? s.future[imageId] ?? [] : s.past[imageId] ?? [];
      const pushed =
        dir === "undo"
          ? [current, ...other]
          : [...other, current].slice(-UNDO_LIMIT);
      return {
        shapes: { ...s.shapes, [imageId]: target.shapes },
        crop: { ...s.crop, [imageId]: target.crop },
        past: { ...s.past, [imageId]: dir === "undo" ? remaining : pushed },
        future: { ...s.future, [imageId]: dir === "undo" ? pushed : remaining },
      };
    });

  return {
    shapes: {},
    crop: {},
    past: {},
    future: {},

    commit: (imageId, next) => set((s) => advance(s, imageId, { shapes: next })),

    setCrop: (imageId, rect) =>
      set((s) => {
        const prev = s.crop[imageId] ?? null;
        // Re-dragging an already-confirmed crop puts it back in the pending
        // state, so the dimming returns and Confirm has something to do.
        const next: CropState | null = rect ? { rect, confirmed: false } : null;
        if (!rect && !prev) return {};
        return advance(s, imageId, { crop: next });
      }),

    confirmCrop: (imageId) =>
      set((s) => {
        const cur = s.crop[imageId];
        if (!cur || cur.confirmed) return {};
        return advance(s, imageId, { crop: { rect: cur.rect, confirmed: true } });
      }),

    undo: (imageId) => step(imageId, "undo"),
    redo: (imageId) => step(imageId, "redo"),

    clear: (imageId) =>
      set((s) => {
        const shapes = { ...s.shapes };
        const crop = { ...s.crop };
        const past = { ...s.past };
        const future = { ...s.future };
        delete shapes[imageId];
        delete crop[imageId];
        delete past[imageId];
        delete future[imageId];
        return { shapes, crop, past, future };
      }),
  };
});

/** True when this screenshot has markup that has not been flattened to a file. */
export function hasUnsavedMarkup(imageId: string): boolean {
  const s = useAnnotationStore.getState();
  return (s.shapes[imageId]?.length ?? 0) > 0 || !!s.crop[imageId];
}
