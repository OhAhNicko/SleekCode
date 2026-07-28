import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BiScreenshot } from "react-icons/bi";
import { useClipboardImageStore } from "../store/clipboardImageStore";
import { insertImagePath, resolveImagePath } from "../lib/clipboard-insert";
import { useAppStore } from "../store";
import { useOverlayMenu } from "../lib/useOverlayMenu";
import { deleteScreenshot, materializeMarkup } from "../lib/screenshots";
import { registerScreenshotViewerOpener } from "../lib/screenshot-viewer";
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
  const setPendingComposerImage = useClipboardImageStore((s) => s.setPendingComposerImage);
  const composerEnabled = useAppStore((s) => s.promptComposerEnabled);
  const activeComposerId = useClipboardImageStore((s) => s.activeComposerTerminalId);
  // With the folder watcher on, the viewer is reachable even before the first
  // capture of the session — shots can land in it at any moment.
  const watchScreenshotsFolder = useAppStore((s) => s.watchScreenshotsFolder);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; imgId: string } | null>(null);
  const [snipCtxMenu, setSnipCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [viewer, setViewer] = useState<{ imageId: string | null } | null>(null);
  const clickTimerRef = useRef<number | null>(null);

  const cancelPendingClick = () => {
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
  };
  useEffect(() => cancelPendingClick, []);

  // Let outsiders (the image-paste toast) open the viewer. When both strip
  // orientations mount, the last one registered wins.
  useEffect(() => {
    return registerScreenshotViewerOpener((imageId) => setViewer({ imageId }));
  }, []);

  const latestThumbnails = images.slice(0, isVertical ? 4 : 5);

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
                { actionId: "expand", label: "Open in viewer" },
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
          setViewer({ imageId: img.id });
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
          void deleteScreenshot(img);
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
                  // The watcher can fill the viewer at any moment, so it opens
                  // (to its empty state) even before the session's first shot.
                  disabled: images.length === 0 && !watchScreenshotsFolder,
                },
              ],
            },
          ],
        }
      : null,
    onAction: (actionId) => {
      if (actionId !== "open-gallery") return;
      setViewer({ imageId: null });
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
              composerEnabled
                ? "Click to view · Double-click or Ctrl+Click to attach"
                : "Click to view · Double-click or Ctrl+Click to insert path"
            }
            onClick={(e) => {
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

    </>
  );
}
