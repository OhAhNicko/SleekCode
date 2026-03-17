import { useState, useEffect } from "react";
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
  const clearAll = useClipboardImageStore((s) => s.clearAll);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; imgId: string } | null>(null);
  const [snipCtxMenu, setSnipCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [showGallery, setShowGallery] = useState(false);
  const [galleryCtxMenu, setGalleryCtxMenu] = useState<{ x: number; y: number; imgId: string } | null>(null);
  const [previewFromGallery, setPreviewFromGallery] = useState(false);

  const latest3 = images.slice(0, 3);

  // Escape key closes gallery
  useEffect(() => {
    if (!showGallery) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowGallery(false);
        setGalleryCtxMenu(null);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [showGallery]);

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
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setSnipCtxMenu({ x: e.clientX, y: e.clientY });
          }}
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
          onClose={() => {
            setPreviewImage(null);
            if (previewFromGallery) {
              setPreviewFromGallery(false);
              setShowGallery(true);
            }
          }}
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

      {/* Snip button right-click context menu */}
      {snipCtxMenu && createPortal(
        <div
          style={{ position: "fixed", inset: 0, zIndex: 210 }}
          onClick={() => setSnipCtxMenu(null)}
          onContextMenu={(e) => { e.preventDefault(); setSnipCtxMenu(null); }}
        >
          <div
            className="dropdown-enter"
            style={{
              position: "absolute",
              top: Math.min(snipCtxMenu.y, window.innerHeight - 100),
              left: Math.min(snipCtxMenu.x, window.innerWidth - 170),
              backgroundColor: "var(--ezy-surface-raised)",
              border: "1px solid var(--ezy-border)",
              borderRadius: 6,
              padding: "4px 0",
              minWidth: 160,
              boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              onClick={images.length > 0 ? () => { setShowGallery(true); setSnipCtxMenu(null); } : undefined}
              style={{
                padding: "6px 12px",
                fontSize: 12,
                color: images.length > 0 ? "var(--ezy-text)" : "var(--ezy-text-muted)",
                cursor: images.length > 0 ? "pointer" : "default",
                opacity: images.length > 0 ? 1 : 0.5,
                transition: "background-color 80ms ease",
              }}
              onMouseEnter={(e) => { if (images.length > 0) e.currentTarget.style.backgroundColor = "var(--ezy-surface)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
            >
              View all screenshots
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* All screenshots gallery popup */}
      {showGallery && createPortal(
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 200,
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            paddingTop: "10vh",
            backgroundColor: "rgba(0,0,0,0.6)",
          }}
          onClick={() => { setShowGallery(false); setGalleryCtxMenu(null); }}
        >
          <div
            className="dropdown-enter"
            style={{
              backgroundColor: "var(--ezy-surface-raised)",
              border: "1px solid var(--ezy-border)",
              borderRadius: 8,
              padding: 16,
              maxWidth: 520,
              width: "90%",
              maxHeight: "70vh",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--ezy-text)" }}>
                All Screenshots ({images.length})
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                {images.length > 0 && (
                  <button
                    onClick={() => { clearAll(); setShowGallery(false); }}
                    style={{
                      fontSize: 11,
                      padding: "4px 10px",
                      borderRadius: 4,
                      backgroundColor: "#dc2626",
                      color: "#fff",
                      border: "none",
                      cursor: "pointer",
                    }}
                  >
                    Clear all
                  </button>
                )}
                <button
                  onClick={() => { setShowGallery(false); setGalleryCtxMenu(null); }}
                  style={{
                    fontSize: 11,
                    padding: "4px 10px",
                    borderRadius: 4,
                    backgroundColor: "var(--ezy-surface)",
                    color: "var(--ezy-text-muted)",
                    border: "1px solid var(--ezy-border)",
                    cursor: "pointer",
                  }}
                >
                  Close
                </button>
              </div>
            </div>

            {/* Body */}
            <div style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
              {images.length === 0 ? (
                <div style={{ padding: "32px 16px", textAlign: "center", fontSize: 13, color: "var(--ezy-text-muted)" }}>
                  No screenshots this session
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 8 }}>
                  {images.map((img, i) => (
                    <div
                      key={img.id}
                      style={{
                        position: "relative",
                        borderRadius: 6,
                        overflow: "hidden",
                        border: "1px solid var(--ezy-border)",
                        cursor: "pointer",
                        aspectRatio: "16/9",
                      }}
                      onClick={() => {
                        setShowGallery(false);
                        setGalleryCtxMenu(null);
                        setPreviewFromGallery(true);
                        setPreviewImage({ dataUri: img.dataUri, winPath: img.winPath });
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setGalleryCtxMenu({ x: e.clientX, y: e.clientY, imgId: img.id });
                      }}
                    >
                      <img
                        src={img.dataUri}
                        alt="Screenshot"
                        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                      />
                      {/* Number badge */}
                      <div
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: 16,
                          height: 16,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          backgroundColor: "var(--ezy-accent)",
                          borderBottomRightRadius: 4,
                          fontSize: 9,
                          fontWeight: 700,
                          color: "#fff",
                          lineHeight: 1,
                        }}
                      >
                        {i + 1}
                      </div>
                      {/* Attach button (top-right, visible on hover) */}
                      <div
                        onClick={(e) => {
                          e.stopPropagation();
                          attachToPrompt(img.id);
                        }}
                        title={composerEnabled ? "Attach to prompt" : "Insert path into terminal"}
                        style={{
                          position: "absolute",
                          top: 0,
                          right: 0,
                          padding: "2px 6px",
                          backgroundColor: "var(--ezy-accent)",
                          borderBottomLeftRadius: 4,
                          fontSize: 9,
                          fontWeight: 600,
                          color: "#fff",
                          cursor: "pointer",
                          opacity: 0,
                          transition: "opacity 120ms ease",
                          lineHeight: 1.4,
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.opacity = "0"; }}
                      >
                        Attach
                      </div>
                      {/* Timestamp overlay */}
                      <div
                        style={{
                          position: "absolute",
                          bottom: 0,
                          left: 0,
                          right: 0,
                          backgroundColor: "rgba(0,0,0,0.6)",
                          padding: "2px 4px",
                          fontSize: 9,
                          color: "#ccc",
                          textAlign: "center",
                          lineHeight: 1.2,
                        }}
                      >
                        {new Date(img.timestamp).toLocaleTimeString()}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* Gallery per-image context menu */}
      {galleryCtxMenu && (() => {
        const gImg = images.find((im) => im.id === galleryCtxMenu.imgId);
        if (!gImg) return null;
        const gItems: { label: string; action: () => void; color?: string }[] = [
          {
            label: "Expand",
            action: () => {
              setShowGallery(false);
              setGalleryCtxMenu(null);
              setPreviewFromGallery(true);
              setPreviewImage({ dataUri: gImg.dataUri, winPath: gImg.winPath });
            },
          },
          {
            label: "Copy",
            action: () => {
              fetch(gImg.dataUri)
                .then((r) => r.blob())
                .then((blob) => navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]))
                .catch(() => {});
              setGalleryCtxMenu(null);
            },
          },
          {
            label: "Copy filepath",
            action: () => {
              navigator.clipboard.writeText(resolveImagePath(gImg.winPath)).catch(() => {});
              setGalleryCtxMenu(null);
            },
          },
          {
            label: "Attach to prompt",
            action: () => {
              attachToPrompt(gImg.id);
              setGalleryCtxMenu(null);
            },
          },
          {
            label: "Delete",
            action: () => {
              removeImage(gImg.id);
              setGalleryCtxMenu(null);
            },
            color: "#f87171",
          },
        ];
        return createPortal(
          <div
            style={{ position: "fixed", inset: 0, zIndex: 210 }}
            onClick={() => setGalleryCtxMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setGalleryCtxMenu(null); }}
          >
            <div
              className="dropdown-enter"
              style={{
                position: "absolute",
                top: Math.min(galleryCtxMenu.y, window.innerHeight - 200),
                left: Math.min(galleryCtxMenu.x, window.innerWidth - 170),
                backgroundColor: "var(--ezy-surface-raised)",
                border: "1px solid var(--ezy-border)",
                borderRadius: 6,
                padding: "4px 0",
                minWidth: 160,
                boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {gItems.map((item) => (
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
