import { create } from "zustand";

export interface ClipboardImage {
  /** Unique ID */
  id: string;
  /** Windows file path */
  winPath: string;
  /** Data URI for thumbnail/preview */
  dataUri: string;
  /** Timestamp when detected */
  timestamp: number;
}

export interface LastInsertion {
  /** The text that was written to the terminal */
  text: string;
  /** Terminal ID it was written to */
  terminalId: string;
  /** Timestamp */
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
  addImage: (image: Omit<ClipboardImage, "id" | "timestamp">, seq: number) => void;
  setLastSeq: (seq: number) => void;
  setLastInsertion: (insertion: LastInsertion | null) => void;
}

/** Session-only store for clipboard images (not persisted across restarts) */
export const useClipboardImageStore = create<ClipboardImageStore>((set) => ({
  images: [],
  lastSeq: 0,
  lastImageSeq: 0,
  lastInsertion: null,
  addImage: (image, seq) =>
    set((state) => ({
      images: [
        { ...image, id: crypto.randomUUID(), timestamp: Date.now() },
        ...state.images,
      ],
      lastImageSeq: seq,
    })),
  setLastSeq: (seq) => set({ lastSeq: seq }),
  setLastInsertion: (insertion) => set({ lastInsertion: insertion }),
}));
