import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { BiScreenshot } from "react-icons/bi";
import { useClipboardImageStore } from "../store/clipboardImageStore";
import { attachImage, resolveImagePath } from "../lib/clipboard-insert";
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

/**
 * Pointer travel (px) before a press on a thumbnail becomes a drag instead of
 * a click. Below this, click / double-click / Ctrl+click behave as before.
 */
const DRAG_THRESHOLD_PX = 5;

interface ClipboardImageStripProps {
  orientation?: "horizontal" | "vertical";
}

interface DragState {
  imgId: string;
  dataUri: string;
  /** Pane currently under the cursor (null → drop would do nothing) */
  over: { terminalId: string; rect: DOMRect } | null;
}

/** Shows a snip button + the 5 most recent session clipboard images in the TabBar. */
export default function ClipboardImageStrip({ orientation = "horizontal" }: ClipboardImageStripProps = {}) {
  const isVertical = orientation === "vertical";
  const images = useClipboardImageStore((s) => s.images);
  const composerEnabled = useAppStore((s) => s.promptComposerEnabled);
  // With the folder watcher on, the viewer is reachable even before the first
  // capture of the session — shots can land in it at any moment.
  const watchScreenshotsFolder = useAppStore((s) => s.watchScreenshotsFolder);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; imgId: string } | null>(null);
  const [snipCtxMenu, setSnipCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [viewer, setViewer] = useState<{ imageId: string | null } | null>(null);
  const clickTimerRef = useRef<number | null>(null);

  // Drag-a-thumbnail-onto-a-pane. State drives mount/unmount of the ghost and
  // the target ring; the ghost's per-move position goes through a ref +
  // direct style writes so 120Hz pointermove doesn't re-render the strip.
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  // Press that hasn't crossed the threshold yet (null once dragging or released)
  const pendingDragRef = useRef<{
    imgId: string;
    dataUri: string;
    pointerId: number;
    startX: number;
    startY: number;
  } | null>(null);
  // Set for the remainder of the event cycle after a real drag, so the click
  // that the browser fires on release doesn't also open the viewer.
  const didDragRef = useRef(false);

  // Last pointer position — the ghost mounts a frame after the drag starts,
  // so its ref callback needs somewhere to read the initial position from.
  const lastPosRef = useRef({ x: 0, y: 0 });

  const positionGhost = (x: number, y: number) => {
    lastPosRef.current = { x, y };
    const el = ghostRef.current;
    if (!el) return;
    // Offset keeps the ghost out from under the hotspot — elementFromPoint
    // must see the pane, and the cursor tip stays visible.
    el.style.transform = `translate(${x + 12}px, ${y + 14}px)`;
  };

  const paneUnderPoint = (x: number, y: number): { terminalId: string; rect: DOMRect } | null => {
    // The ghost/ring are pointer-events:none, so elementFromPoint skips them.
    const el = document.elementFromPoint(x, y);
    const pane = el?.closest("[data-terminal-id]");
    const terminalId = pane?.getAttribute("data-terminal-id");
    if (!pane || !terminalId) return null;
    return { terminalId, rect: pane.getBoundingClientRect() };
  };

  const endDrag = () => {
    pendingDragRef.current = null;
    dragRef.current = null;
    setDrag(null);
  };

  const handleThumbPointerDown = (e: React.PointerEvent<HTMLDivElement>, imgId: string, dataUri: string) => {
    // Left button only; Ctrl/meta presses stay pure clicks (attach shortcut).
    if (e.button !== 0 || e.ctrlKey || e.metaKey) return;
    didDragRef.current = false;
    pendingDragRef.current = {
      imgId,
      dataUri,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
    };
  };

  const handleThumbPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const pending = pendingDragRef.current;
    if (pending && !dragRef.current) {
      if (
        Math.abs(e.clientX - pending.startX) < DRAG_THRESHOLD_PX &&
        Math.abs(e.clientY - pending.startY) < DRAG_THRESHOLD_PX
      ) {
        return;
      }
      // Threshold crossed — this press is a drag, not a click.
      cancelPendingClick();
      didDragRef.current = true;
      e.currentTarget.setPointerCapture(pending.pointerId);
      // Reset the hover zoom so the source thumbnail sits still during the drag.
      e.currentTarget.style.transform = "";
      e.currentTarget.style.zIndex = "";
      e.currentTarget.style.boxShadow = "";
      const next: DragState = { imgId: pending.imgId, dataUri: pending.dataUri, over: null };
      dragRef.current = next;
      setDrag(next);
    }
    if (!dragRef.current) return;
    positionGhost(e.clientX, e.clientY);
    const over = paneUnderPoint(e.clientX, e.clientY);
    const prev = dragRef.current.over;
    if ((over?.terminalId ?? null) !== (prev?.terminalId ?? null)) {
      const next = { ...dragRef.current, over };
      dragRef.current = next;
      setDrag(next);
    }
  };

  const handleThumbPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const dragging = dragRef.current;
    pendingDragRef.current = null;
    if (!dragging) return;
    const over = paneUnderPoint(e.clientX, e.clientY);
    if (over) attachToPrompt(dragging.imgId, over.terminalId);
    endDrag();
  };

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

  const attachToPrompt = (imgId: string, targetTerminalId?: string) => {
    const img = images.find((i) => i.id === imgId);
    if (!img) return;
    // Bake in any markup first. Editing a screenshot in the viewer, closing it
    // and then double-clicking its thumbnail must not hand over the original —
    // that is the whole point of the edit tools, and the failure is silent.
    void materializeMarkup(img).then((target) => {
      void attachImage(target, targetTerminalId);
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
            borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
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
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
              overflow: "hidden",
              // The captured element's cursor is what the user sees for the
              // whole drag, so the grab feedback must live here, not on body.
              cursor: drag?.imgId === img.id ? "grabbing" : "pointer",
              border: "1px solid var(--ezy-border)",
              flexShrink: 0,
              transformOrigin: "center",
              transition: "transform 140ms ease, box-shadow 140ms ease",
            }}
            data-tooltip={
              composerEnabled
                ? "Click to view · Double-click or Ctrl+Click to attach · Drag onto a pane"
                : "Click to view · Double-click or Ctrl+Click to insert path · Drag onto a pane"
            }
            onPointerDown={(e) => handleThumbPointerDown(e, img.id, img.dataUri)}
            onPointerMove={handleThumbPointerMove}
            onPointerUp={handleThumbPointerUp}
            onPointerCancel={endDrag}
            onLostPointerCapture={endDrag}
            onClick={(e) => {
              // A release that ended a drag is not a click.
              if (didDragRef.current) return;
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
              if (didDragRef.current) return;
              cancelPendingClick();
              attachToPrompt(img.id);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setCtxMenu({ x: e.clientX, y: e.clientY, imgId: img.id });
            }}
            onMouseEnter={(e) => {
              if (dragRef.current) return; // no hover zoom mid-drag
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
              draggable={false}
              onDragStart={(e) => e.preventDefault()}
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
                fontSize: "calc(var(--ezy-font-scale, 1) * 8px)",
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

      {/* Drag ghost + drop-target ring. Both are pointer-events:none so the
          drop hit-test (elementFromPoint) sees through them. The ring cannot
          paint over native child-HWND panes — there the dimming/undimming of
          the ghost is the drop affordance. */}
      {drag &&
        createPortal(
          <>
            {drag.over && (
              <div
                style={{
                  position: "fixed",
                  left: drag.over.rect.left + 3,
                  top: drag.over.rect.top + 3,
                  width: drag.over.rect.width - 6,
                  height: drag.over.rect.height - 6,
                  border: "1.5px solid var(--ezy-accent)",
                  borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
                  pointerEvents: "none",
                  zIndex: 9998,
                }}
              />
            )}
            <div
              ref={(el) => {
                ghostRef.current = el;
                if (el) {
                  el.style.transform = `translate(${lastPosRef.current.x + 12}px, ${lastPosRef.current.y + 14}px)`;
                }
              }}
              style={{
                position: "fixed",
                left: 0,
                top: 0,
                width: 44,
                height: 44,
                borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                overflow: "hidden",
                border: "1px solid var(--ezy-border)",
                boxShadow: "0 6px 18px rgba(0,0,0,0.5)",
                pointerEvents: "none",
                zIndex: 9999,
                opacity: drag.over ? 0.95 : 0.55,
                willChange: "transform",
                transition: "opacity 120ms ease",
              }}
            >
              <img
                src={drag.dataUri}
                alt=""
                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
              />
            </div>
          </>,
          document.body
        )}
    </>
  );
}
