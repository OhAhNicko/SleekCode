import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useClipboardImageStore } from "../store/clipboardImageStore";
import { insertImagePath } from "../lib/clipboard-insert";
import ImagePreviewModal from "./ImagePreviewModal";

/** Shows a snip button + the 3 most recent session clipboard images in the TabBar. */
export default function ClipboardImageStrip() {
  const images = useClipboardImageStore((s) => s.images);
  const [previewImage, setPreviewImage] = useState<{
    dataUri: string;
    winPath: string;
  } | null>(null);

  const latest3 = images.slice(0, 3);

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "0 6px",
          flexShrink: 0,
        }}
      >
        {/* Snip button — launches Windows Snipping Tool (Win+Shift+S) */}
        <div
          onClick={() => invoke("launch_snipping_tool").catch(() => {})}
          title="Screenshot (Snipping Tool)"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 26,
            height: 26,
            borderRadius: 4,
            cursor: "pointer",
            border: "1px solid var(--ezy-border)",
            backgroundColor: "transparent",
            transition: "background-color 120ms ease",
            flexShrink: 0,
          }}
          onMouseEnter={(e) =>
            (e.currentTarget.style.backgroundColor = "var(--ezy-surface)")
          }
          onMouseLeave={(e) =>
            (e.currentTarget.style.backgroundColor = "transparent")
          }
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="var(--ezy-text-muted)"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="3" width="10" height="10" rx="1" strokeDasharray="2.5 2" />
            <path d="M1 5V2a1 1 0 0 1 1-1h3" />
            <path d="M11 1h3a1 1 0 0 1 1 1v3" />
            <path d="M15 11v3a1 1 0 0 1-1 1h-3" />
            <path d="M5 15H2a1 1 0 0 1-1-1v-3" />
          </svg>
        </div>

        {/* Thumbnails */}
        {latest3.map((img, i) => (
          <div
            key={img.id}
            style={{
              position: "relative",
              width: 26,
              height: 26,
              borderRadius: 4,
              overflow: "hidden",
              cursor: "pointer",
              border: "1px solid var(--ezy-border)",
              flexShrink: 0,
            }}
            title="Click to insert path into active terminal"
            onClick={() => insertImagePath(img.winPath)}
          >
            <img
              src={img.dataUri}
              alt="Clipboard screenshot"
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                display: "block",
              }}
            />
            {/* Number badge (top-left) */}
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: 12,
                height: 12,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: "var(--ezy-accent)",
                borderBottomRightRadius: 3,
                fontSize: 8,
                fontWeight: 700,
                color: "#fff",
                lineHeight: 1,
              }}
            >
              {i + 1}
            </div>
            {/* View button overlay (top-right corner) */}
            <div
              onClick={(e) => {
                e.stopPropagation();
                setPreviewImage({
                  dataUri: img.dataUri,
                  winPath: img.winPath,
                });
              }}
              title="View full image"
              style={{
                position: "absolute",
                top: 0,
                right: 0,
                width: 14,
                height: 14,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: "rgba(0,0,0,0.6)",
                borderBottomLeftRadius: 3,
                opacity: 0,
                transition: "opacity 120ms ease",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.opacity = "1";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = "0";
              }}
            >
              <svg
                width="8"
                height="8"
                viewBox="0 0 12 12"
                fill="none"
                stroke="white"
                strokeWidth="1.5"
                strokeLinecap="round"
              >
                <path d="M1 11L5 7M1 11V7.5M1 11H4.5" />
                <path d="M11 1L7 5M11 1V4.5M11 1H7.5" />
              </svg>
            </div>
          </div>
        ))}
      </div>

      {previewImage && (
        <ImagePreviewModal
          dataUri={previewImage.dataUri}
          winPath={previewImage.winPath}
          onInsert={() => {
            insertImagePath(previewImage.winPath);
            setPreviewImage(null);
          }}
          onClose={() => setPreviewImage(null)}
        />
      )}
    </>
  );
}
