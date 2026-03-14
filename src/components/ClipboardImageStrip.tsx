import { useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { BiScreenshot } from "react-icons/bi";
import { FaExpand } from "react-icons/fa";
import { useClipboardImageStore } from "../store/clipboardImageStore";
import { insertImagePath, resolveImagePath } from "../lib/clipboard-insert";
import { useAppStore } from "../store";
import ImagePreviewModal from "./ImagePreviewModal";

/** Shows a snip button + the 3 most recent session clipboard images in the TabBar. */
export default function ClipboardImageStrip() {
  const images = useClipboardImageStore((s) => s.images);
  const removeImage = useClipboardImageStore((s) => s.removeImage);
  const setPendingComposerImage = useClipboardImageStore((s) => s.setPendingComposerImage);
  const composerEnabled = useAppStore((s) => s.promptComposerEnabled);
  const activeComposerId = useClipboardImageStore((s) => s.activeComposerTerminalId);
  const [previewImage, setPreviewImage] = useState<{
    dataUri: string;
    winPath: string;
  } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; imgId: string } | null>(null);

  const latest3 = images.slice(0, 3);

  const attachToPrompt = (imgId: string) => {
    const img = images.find((i) => i.id === imgId);
    if (!img) return;
    if (composerEnabled && activeComposerId) {
      setPendingComposerImage({ image: img, terminalId: activeComposerId });
    } else {
      insertImagePath(img.winPath);
    }
  };

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
            onClick={() => attachToPrompt(img.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setCtxMenu({ x: e.clientX, y: e.clientY, imgId: img.id });
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
          onDelete={() => {
            const img = images.find((i) => i.winPath === previewImage.winPath);
            if (img) removeImage(img.id);
            setPreviewImage(null);
          }}
          onClose={() => setPreviewImage(null)}
        />
      )}

      {/* Right-click context menu — portaled to body */}
      {ctxMenu && (() => {
        const ctxImg = images.find((im) => im.id === ctxMenu.imgId);
        if (!ctxImg) return null;
        const items: { label: string; action: () => void; color?: string }[] = [
          {
            label: "Expand",
            action: () => {
              setPreviewImage({ dataUri: ctxImg.dataUri, winPath: ctxImg.winPath });
              setCtxMenu(null);
            },
          },
          {
            label: "Copy",
            action: () => {
              fetch(ctxImg.dataUri)
                .then((r) => r.blob())
                .then((blob) => navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]))
                .catch(() => {});
              setCtxMenu(null);
            },
          },
          {
            label: "Copy filepath",
            action: () => {
              navigator.clipboard.writeText(resolveImagePath(ctxImg.winPath)).catch(() => {});
              setCtxMenu(null);
            },
          },
          {
            label: "Attach to prompt",
            action: () => {
              attachToPrompt(ctxImg.id);
              setCtxMenu(null);
            },
          },
          {
            label: "Delete",
            action: () => {
              removeImage(ctxImg.id);
              setCtxMenu(null);
            },
            color: "#f87171",
          },
        ];
        return createPortal(
          <div
            style={{ position: "fixed", inset: 0, zIndex: 210 }}
            onClick={() => setCtxMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }}
          >
            <div
              style={{
                position: "absolute",
                top: Math.min(ctxMenu.y, window.innerHeight - 200),
                left: Math.min(ctxMenu.x, window.innerWidth - 170),
                backgroundColor: "var(--ezy-surface-raised)",
                border: "1px solid var(--ezy-border)",
                borderRadius: 6,
                padding: "4px 0",
                minWidth: 160,
                boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {items.map((item) => (
                <div
                  key={item.label}
                  onClick={item.action}
                  style={{
                    padding: "6px 12px",
                    fontSize: 12,
                    color: item.color ?? "var(--ezy-text)",
                    cursor: "pointer",
                    transition: "background-color 80ms ease",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--ezy-surface)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
                >
                  {item.label}
                </div>
              ))}
            </div>
          </div>,
          document.body,
        );
      })()}
    </>
  );
}
