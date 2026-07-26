import { create } from "zustand";

export interface ClipboardImage {
  /** Unique ID */
  id: string;
  /**
   * The path everything else in the app uses — insert, attach, copy, mask.
   *
   * Stays on the temp copy whenever there is one. The `Pictures\Screenshots`
   * original is the more permanent file, but OS screenshot names contain
   * spaces (`Screenshot 2026-07-26 141530.png`) where `clipboard-<ms>.png`
   * never does, and this string gets typed into a live shell. `originalPath`
   * is tracked separately for deleting and revealing.
   */
  winPath: string;
  /** `%TEMP%\made\clipboard-<ms>.png` — set when the clipboard produced this. */
  tempPath?: string;
  /** The OS Screenshots-folder original, when we've matched or watched one. */
  originalPath?: string;
  /** Data URI for thumbnail/preview */
  dataUri: string;
  /** Timestamp when detected */
  timestamp: number;
  /** Pixel dimensions — drives the same-capture match and the metadata line. */
  width?: number;
  height?: number;
  /** File size in bytes. */
  bytes?: number;
  /** Where we first saw it. */
  source?: "clipboard" | "folder";
}

/** A file the folder watcher reported (mirrors Rust's `ScreenshotEntry`). */
export interface ScreenshotEntry {
  path: string;
  modifiedMs: number;
  width: number;
  height: number;
  bytes: number;
}

/**
 * Two files are the same capture when their pixel dimensions match and they
 * were written close enough together. Mirrors `same_capture` in
 * `src-tauri/src/screenshots.rs` — keep the two in step.
 */
export const SAME_CAPTURE_WINDOW_MS = 15_000;

export interface LastInsertion {
  /** The text that was written to the terminal */
  text: string;
  /** Terminal ID it was written to */
  terminalId: string;
  /** Timestamp */
  timestamp: number;
}

export interface UploadError {
  /** Display title (e.g. "Upload to Mac mini failed") */
  title: string;
  /** Underlying error detail */
  detail: string;
  /** Timestamp — used to dedupe rapid-fire errors */
  timestamp: number;
}

interface ClipboardImageStore {
  images: ClipboardImage[];
  /** Clipboard sequence number from the last poll */
  lastSeq: number;
  /** Clipboard sequence number when the most recent image was detected */
  lastImageSeq: number;
  /** Last path insertion (for undo) — cleared after 5 seconds or after undo */
  lastInsertion: LastInsertion | null;
  /** Last upload failure — drives a transient toast, cleared after ~6 seconds */
  uploadError: UploadError | null;
  /** Pending image for a specific MadeComposer to pick up (set by TabBar/auto-paste, consumed by composer) */
  pendingComposerImage: { image: ClipboardImage; terminalId: string } | null;
  /** Terminal ID of the last focused MadeComposer (set by composer on focus) */
  activeComposerTerminalId: string | null;
  addImage: (image: Omit<ClipboardImage, "id" | "timestamp">, seq: number) => void;
  /**
   * Report a file the folder watcher saw. Merges into an existing entry when it
   * is the same capture, so a snip that reaches us twice — once through the
   * clipboard, once through the folder — stays one row.
   */
  addFolderImage: (entry: ScreenshotEntry, dataUri: string) => void;
  /**
   * Add an image MADE produced from another one (a flattened markup export).
   *
   * Separate from `addImage` because that action's `seq` is clipboard-poll
   * bookkeeping — faking one would make the poller think it had already seen a
   * clipboard state it hasn't. Returns the new row's id so the caller can
   * select it.
   */
  addDerivedImage: (image: Omit<ClipboardImage, "id" | "timestamp">) => string;
  /**
   * Swap in new pixels for an entry whose FILES were just rewritten in place.
   *
   * Paths are deliberately untouched: an in-place save overwrites the very
   * files this row already points at, so its identity — which every consumer
   * keys off `winPath` — must not move.
   */
  replaceImageBytes: (
    id: string,
    next: { dataUri: string; width: number; height: number; bytes: number },
  ) => void;
  /** Record the Screenshots-folder original for an entry (delete/reveal use it). */
  attachOriginalPath: (id: string, originalPath: string) => void;
  updateImageMeta: (
    id: string,
    meta: Partial<Pick<ClipboardImage, "width" | "height" | "bytes">>,
  ) => void;
  removeImage: (id: string) => void;
  clearAll: () => void;
  setLastSeq: (seq: number) => void;
  setLastInsertion: (insertion: LastInsertion | null) => void;
  setUploadError: (err: UploadError | null) => void;
  setPendingComposerImage: (pending: { image: ClipboardImage; terminalId: string } | null) => void;
  setActiveComposerTerminalId: (id: string | null) => void;
}

const MAX_CLIPBOARD_IMAGES = 50;

/** Session-only store for clipboard images (not persisted across restarts) */
export const useClipboardImageStore = create<ClipboardImageStore>((set, get) => ({
  images: [],
  lastSeq: 0,
  lastImageSeq: 0,
  lastInsertion: null,
  uploadError: null,
  pendingComposerImage: null,
  activeComposerTerminalId: null,
  addImage: (image, seq) =>
    set((state) => {
      const now = Date.now();

      // Same bytes as something we already hold => same capture, however it got
      // here. `GetClipboardSequenceNumber` ticks when ANY app touches the
      // clipboard — including MADE's own "Copy image" — and every tick made the
      // poller re-save the still-present image under a fresh
      // `clipboard-<ms>.png`, so one snip piled up a row every couple of
      // seconds. Comparing the encoded bytes is exact where dimensions-and-time
      // is a guess: PowerShell's GetImage + Save(Png) is deterministic for a
      // given bitmap, so a re-save is byte-identical.
      //
      // Two genuinely separate snips of an unchanged screen also collapse into
      // one row. They are the same picture, so that is the right answer.
      const sameBytes = state.images.findIndex((im) => im.dataUri === image.dataUri);
      if (sameBytes >= 0) {
        const prev = state.images[sameBytes];
        // Keep the temp path we already had — the caller's copy is redundant
        // and gets unlinked by the poller.
        if (prev.tempPath) return { lastImageSeq: seq };
        const images = [...state.images];
        images[sameBytes] = { ...prev, tempPath: image.tempPath ?? image.winPath };
        return { images, lastImageSeq: seq };
      }

      // The folder watcher usually beats us here: Snipping Tool writes the
      // original the instant you snip, while the clipboard poll runs on a
      // 1500ms tick. So look for a folder-sourced row describing this same
      // capture and fill in its temp copy instead of adding a duplicate.
      const twinIdx = image.width
        ? state.images.findIndex(
            (im) =>
              !im.tempPath &&
              im.source === "folder" &&
              im.width === image.width &&
              im.height === image.height &&
              Math.abs(im.timestamp - now) <= SAME_CAPTURE_WINDOW_MS,
          )
        : -1;

      if (twinIdx >= 0) {
        const images = [...state.images];
        images[twinIdx] = { ...images[twinIdx], tempPath: image.winPath };
        return { images, lastImageSeq: seq };
      }

      return {
        images: [
          {
            source: "clipboard" as const,
            ...image,
            tempPath: image.tempPath ?? image.winPath,
            id: crypto.randomUUID(),
            timestamp: now,
          },
          ...state.images,
        ].slice(0, MAX_CLIPBOARD_IMAGES),
        lastImageSeq: seq,
      };
    }),
  addFolderImage: (entry, dataUri) =>
    set((state) => {
      // Already know this exact file.
      if (
        state.images.some(
          (im) =>
            im.originalPath === entry.path ||
            im.winPath === entry.path ||
            im.tempPath === entry.path,
        )
      ) {
        return {};
      }

      // Same capture as a row we already have? Record the original alongside
      // it — `winPath` stays on the temp copy (see the field's note).
      const twinIdx = state.images.findIndex(
        (im) =>
          !im.originalPath &&
          im.width === entry.width &&
          im.height === entry.height &&
          Math.abs(im.timestamp - entry.modifiedMs) <= SAME_CAPTURE_WINDOW_MS,
      );
      if (twinIdx >= 0) {
        const images = [...state.images];
        const prev = images[twinIdx];
        images[twinIdx] = {
          ...prev,
          originalPath: entry.path,
          bytes: prev.bytes ?? entry.bytes,
        };
        return { images };
      }

      // Genuinely new. Keep the list ordered newest-first — a backfill walks
      // older files after newer ones already landed.
      const next: ClipboardImage = {
        id: crypto.randomUUID(),
        winPath: entry.path,
        originalPath: entry.path,
        dataUri,
        timestamp: entry.modifiedMs,
        width: entry.width,
        height: entry.height,
        bytes: entry.bytes,
        source: "folder",
      };
      return {
        images: [...state.images, next]
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, MAX_CLIPBOARD_IMAGES),
      };
    }),
  addDerivedImage: (image) => {
    // Same byte-dedupe as addImage: re-exporting unchanged markup reuses the
    // existing row instead of stacking identical screenshots.
    const twin = get().images.find((im) => im.dataUri === image.dataUri);
    if (twin) return twin.id;

    const id = crypto.randomUUID();
    set((state) => ({
      images: [
        { ...image, id, timestamp: Date.now() },
        ...state.images,
      ].slice(0, MAX_CLIPBOARD_IMAGES),
    }));
    return id;
  },
  replaceImageBytes: (id, next) =>
    set((state) => ({
      images: state.images.map((im) => (im.id === id ? { ...im, ...next } : im)),
    })),
  attachOriginalPath: (id, originalPath) =>
    set((state) => ({
      images: state.images.map((im) => (im.id === id ? { ...im, originalPath } : im)),
    })),
  updateImageMeta: (id, meta) =>
    set((state) => ({
      images: state.images.map((im) => (im.id === id ? { ...im, ...meta } : im)),
    })),
  removeImage: (id) =>
    set((state) => ({ images: state.images.filter((img) => img.id !== id) })),
  clearAll: () => set({ images: [] }),
  setLastSeq: (seq) => set({ lastSeq: seq }),
  setLastInsertion: (insertion) => set({ lastInsertion: insertion }),
  setUploadError: (err) => set({ uploadError: err }),
  setPendingComposerImage: (pending) => set({ pendingComposerImage: pending }),
  setActiveComposerTerminalId: (id) => set({ activeComposerTerminalId: id }),
}));
