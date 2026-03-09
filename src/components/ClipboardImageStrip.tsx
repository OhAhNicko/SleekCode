import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BiScreenshot } from "react-icons/bi";
import { FaExpand } from "react-icons/fa";
import { useClipboardImageStore } from "../store/clipboardImageStore";
import { insertImagePath } from "../lib/clipboard-insert";
import { useAppStore } from "../store";
import ImagePreviewModal from "./ImagePreviewModal";

/** Shows a snip button + the 3 most recent session clipboard images in the TabBar. */
export default function ClipboardImageStrip() {
  const images = useClipboardImageStore((s) => s.images);
  const setPendingComposerImage = useClipboardImageStore((s) => s.setPendingComposerImage);
  const composerEnabled = useAppStore((s) => s.promptComposerEnabled);
  const activeComposerId = useClipboardImageStore((s) => s.activeComposerTerminalId);
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
          <BiScreenshot size={14} color="var(--ezy-text-muted)" />
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
            title={composerEnabled ? "Click to attach to prompt" : "Click to insert path into active terminal"}
            onClick={() => {
              if (composerEnabled && activeComposerId) {
                setPendingComposerImage({ image: img, terminalId: activeComposerId });
              } else {
                insertImagePath(img.winPath);
              }
            }}
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
              <FaExpand size={8} color="white" />
            </div>
          </div>
        ))}
      </div>

      {previewImage && (
        <ImagePreviewModal
          dataUri={previewImage.dataUri}
          winPath={previewImage.winPath}
          onInsert={() => {
            if (composerEnabled) {
              const img = images.find((i) => i.winPath === previewImage.winPath);
              if (img && activeComposerId) setPendingComposerImage({ image: img, terminalId: activeComposerId });
            } else {
              insertImagePath(previewImage.winPath);
            }
            setPreviewImage(null);
          }}
          onClose={() => setPreviewImage(null)}
        />
      )}
    </>
  );
}
