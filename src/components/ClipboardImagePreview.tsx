import { useRef } from "react";
import { useOverlayPublisher } from "../store/overlayRegionSlice";

interface ClipboardImagePreviewProps {
  thumbnailUrl: string;
  filePath: string;
  onDismiss: () => void;
  /** Unique per pane instance — publishes the toast's rect so native GPU
   * panes cut a hole for it (without this the toast is fully occluded on
   * the native renderer). */
  overlayKey: string;
}

export default function ClipboardImagePreview({
  thumbnailUrl,
  filePath,
  onDismiss,
  overlayKey,
}: ClipboardImagePreviewProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  useOverlayPublisher(overlayKey, rootRef);
  return (
    <div
      ref={rootRef}
      className="absolute bottom-3 right-3 flex items-center gap-2.5 rounded-lg px-3 py-2 shadow-lg"
      style={{
        backgroundColor: "var(--ezy-surface-raised)",
        border: "1px solid var(--ezy-border)",
        zIndex: 20,
        maxWidth: 320,
      }}
    >
      <img
        src={thumbnailUrl}
        alt="Pasted image"
        className="rounded"
        style={{
          width: 48,
          height: 48,
          objectFit: "cover",
          flexShrink: 0,
        }}
      />
      <div className="min-w-0 flex-1">
        <div
          className="text-xs font-medium"
          style={{ color: "var(--ezy-text)" }}
        >
          Image pasted
        </div>
        <div
          className="text-[11px] truncate mt-0.5"
          style={{ color: "var(--ezy-text-muted)" }}
          title={filePath}
        >
          {filePath}
        </div>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
        className="flex items-center justify-center rounded hover:opacity-80"
        style={{
          width: 20,
          height: 20,
          color: "var(--ezy-text-muted)",
          flexShrink: 0,
        }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path
            d="M2.5 2.5L9.5 9.5M9.5 2.5L2.5 9.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}
