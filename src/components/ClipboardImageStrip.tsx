import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { BiScreenshot } from "react-icons/bi";
import { FaExpand } from "react-icons/fa";
import { useClipboardImageStore } from "../store/clipboardImageStore";
import { insertImagePath, resolveImagePath } from "../lib/clipboard-insert";
import { useAppStore } from "../store";
import { useOverlayMenu } from "../lib/useOverlayMenu";
import { useModalWhen } from "../store/modalCoordinationSlice";
import { deleteScreenshot, materializeMarkup } from "../lib/screenshots";
import ImagePreviewModal from "./ImagePreviewModal";
import ScreenshotsOverlay from "./ScreenshotsOverlay";

/**
 * How long a single click waits before it commits to opening the viewer.
 *
 * A double-click always fires a single click first, so the two gestures can
 * only be told apart by waiting. 200ms is under the OS double-click threshold
 * and short enough that the open still feels immediate; Ctrl+Click skips the
 * wait entirely for anyone who wants to attach without one.
 */
const CLICK_RESOLVE_MS = 200;

interface ClipboardImageStripProps {
  orientation?: "horizontal" | "vertical";
}

/** Shows a snip button + the 5 most recent session clipboard images in the TabBar. */
export default function ClipboardImageStrip({ orientation = "horizontal" }: ClipboardImageStripProps = {}) {
  const isVertical = orientation === "vertical";
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

  // Revamped viewer — the legacy gallery/preview pair below is untouched so
  // both can be exercised in the same build.
  const revamped = useAppStore((s) => s.screenshotsRevampEnabled);
  const [viewer, setViewer] = useState<{ imageId: string | null } | null>(null);
  const clickTimerRef = useRef<number | null>(null);

  const cancelPendingClick = () => {
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
  };
  useEffect(() => cancelPendingClick, []);

  // Strip context menus are overlay-rendered (kind "anchored-menu") — the
  // hooks live below, after the handlers they need. The gallery's own
  // context menu stays DOM: it only ever opens over the gallery modal, and
  // the panes are hidden while that modal is open (useModalWhen).
  useModalWhen('clipboard-image-strip-gallery', showGallery);

  const latestThumbnails = images.slice(0, isVertical ? 4 : 5);

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
    // Bake in any markup first. Editing a screenshot in the viewer, closing it
    // and then double-clicking its thumbnail must not hand over the original —
    // that is the whole point of the edit tools, and the failure is silent.
    void materializeMarkup(img).then((target) => {
      if (composerEnabled && activeComposerId) {
        setPendingComposerImage({ image: target, terminalId: activeComposerId });
      } else {
        void insertImagePath(target.winPath);
      }
    });
  };

  // Thumbnail right-click menu — overlay-rendered at the cursor.
  useOverlayMenu({
    id: "clipboard-strip-ctx-menu",
    open: !!ctxMenu,
    anchorPoint: ctxMenu ? { x: ctxMenu.x, y: ctxMenu.y } : null,
    payload: ctxMenu
      ? {
          placement: "below-start",
          width: 160,
          sections: [
            {
              items: [
                { actionId: "expand", label: revamped ? "Open in viewer" : "Expand" },
                { actionId: "copy", label: "Copy" },
                { actionId: "copy-path", label: "Copy filepath" },
                { actionId: "open-path", label: "Open screenshot filepath" },
                { actionId: "attach", label: "Attach to prompt" },
                { actionId: "delete", label: "Delete", danger: true },
              ],
            },
          ],
        }
      : null,
    onAction: (actionId) => {
      const img = ctxMenu ? images.find((im) => im.id === ctxMenu.imgId) : null;
      if (!img) return;
      switch (actionId) {
        case "expand":
          if (revamped) setViewer({ imageId: img.id });
          else setPreviewImage({ dataUri: img.dataUri, winPath: img.winPath });
          break;
        case "copy":
          void invoke("copy_image_to_clipboard", { path: img.winPath }).catch(
            () => {},
          );
          break;
        case "copy-path":
          void resolveImagePath(img.winPath, "clipboard").then((p) => {
            if (p) navigator.clipboard.writeText(p).catch(() => {});
          });
          break;
        case "open-path":
          void invoke("reveal_in_explorer", { path: img.winPath }).catch(
            () => {},
          );
          break;
        case "attach":
          attachToPrompt(img.id);
          break;
        case "delete":
          // Revamp deletes the files; legacy only drops the list entry.
          if (revamped) void deleteScreenshot(img);
          else removeImage(img.id);
          break;
      }
    },
    onClose: () => setCtxMenu(null),
  });

  // Snip-button right-click menu — overlay-rendered at the cursor.
  useOverlayMenu({
    id: "clipboard-strip-snip-menu",
    open: !!snipCtxMenu,
    anchorPoint: snipCtxMenu,
    payload: snipCtxMenu
      ? {
          placement: "below-start",
          width: 160,
          sections: [
            {
              items: [
                {
                  actionId: "open-gallery",
                  label: "View all screenshots",
                  disabled: images.length === 0,
                },
              ],
            },
          ],
        }
      : null,
    onAction: (actionId) => {
      if (actionId !== "open-gallery") return;
      if (revamped) setViewer({ imageId: null });
      else setShowGallery(true);
    },
    onClose: () => setSnipCtxMenu(null),
  });

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "0 6px",
          flexShrink: 0,
          flexWrap: isVertical ? "wrap" : "nowrap",
          justifyContent: isVertical ? "flex-start" : undefined,
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
          data-tooltip="Screenshot (Snipping Tool)"
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
        {latestThumbnails.map((img, i) => (
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
              transformOrigin: "center",
              transition: "transform 140ms ease, box-shadow 140ms ease",
            }}
            data-tooltip={
              revamped
                ? composerEnabled
                  ? "Click to view · Double-click or Ctrl+Click to attach"
                  : "Click to view · Double-click or Ctrl+Click to insert path"
                : composerEnabled
                  ? "Click to attach to prompt"
                  : "Click to insert path into active terminal"
            }
            onClick={(e) => {
              if (!revamped) {
                attachToPrompt(img.id);
                return;
              }
              // Ctrl+Click is unambiguous, so it never pays the wait.
              if (e.ctrlKey || e.metaKey) {
                cancelPendingClick();
                attachToPrompt(img.id);
                return;
              }
              cancelPendingClick();
              clickTimerRef.current = window.setTimeout(() => {
                clickTimerRef.current = null;
                setViewer({ imageId: img.id });
              }, CLICK_RESOLVE_MS);
            }}
            onDoubleClick={() => {
              if (!revamped) return;
              cancelPendingClick();
              attachToPrompt(img.id);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setCtxMenu({ x: e.clientX, y: e.clientY, imgId: img.id });
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = "scale(1.5)";
              e.currentTarget.style.zIndex = "5";
              e.currentTarget.style.boxShadow = "0 4px 10px rgba(0,0,0,0.4)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "";
              e.currentTarget.style.zIndex = "";
              e.currentTarget.style.boxShadow = "";
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
                width: 11,
                height: 11,
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
            {/*
              View button overlay (top-right corner). Legacy only — in the
              revamp a plain click opens the viewer, so this 11×11 hidden
              target has nothing left to do.
            */}
            {!revamped && (
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  setPreviewImage({
                    dataUri: img.dataUri,
                    winPath: img.winPath,
                  });
                }}
                style={{
                  position: "absolute",
                  top: 0,
                  right: 0,
                  width: 11,
                  height: 11,
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
                <FaExpand size={6} color="white" />
              </div>
            )}
          </div>
        ))}
      </div>

      {/*
        Revamped viewer. The modal key is orientation-scoped because this
        component mounts in both TabBar and VerticalTabBar — a shared key lets
        one instance's unregister un-hide the native panes over the other's
        open overlay.
      */}
      <ScreenshotsOverlay
        open={!!viewer}
        initialImageId={viewer?.imageId ?? null}
        overlayKey={`screenshots-overlay-${orientation}`}
        onClose={() => setViewer(null)}
      />

      {previewImage && (
        <ImagePreviewModal
          dataUri={previewImage.dataUri}
          winPath={previewImage.winPath}
          overlayKey="image-preview-strip"
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
                        data-tooltip={composerEnabled ? "Attach to prompt" : "Insert path into terminal"}
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
              void invoke("copy_image_to_clipboard", { path: gImg.winPath }).catch(() => {});
              setGalleryCtxMenu(null);
            },
          },
          {
            label: "Copy filepath",
            action: () => {
              void resolveImagePath(gImg.winPath, "clipboard").then((p) => {
                if (p) navigator.clipboard.writeText(p).catch(() => {});
              });
              setGalleryCtxMenu(null);
            },
          },
          {
            label: "Open screenshot filepath",
            action: () => {
              void invoke("reveal_in_explorer", { path: gImg.winPath }).catch(() => {});
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
