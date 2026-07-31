import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useClipboardImageStore, type ClipboardImage } from "../store/clipboardImageStore";
import { useAppStore } from "../store";
import { useModalWhen } from "../store/modalCoordinationSlice";
import { useOverlayMenu } from "../lib/useOverlayMenu";
import { attachImage, resolveImagePath } from "../lib/clipboard-insert";
import {
  deleteAllScreenshots,
  deleteScreenshot,
  fileCount,
  fileNameOf,
  formatBytes,
  materializeMarkup,
  relativeTime,
  saveMarkupInPlace,
} from "../lib/screenshots";
import {
  isRealCrop,
  resolveThickness,
  viewRegion,
  type CropVariant,
  type Shape,
  type Tool,
} from "../lib/annotations";
import { useAnnotationStore } from "../store/screenshotAnnotationStore";
import { MARKUP_INK_PRESETS } from "../store/recentProjectsSlice";
import ScreenshotAnnotationLayer from "./ScreenshotAnnotationLayer";
import ScreenshotAnnotationToolbar from "./ScreenshotAnnotationToolbar";

interface ScreenshotsOverlayProps {
  open: boolean;
  /** Screenshot to select when it opens. Falls back to the newest. */
  initialImageId?: string | null;
  /**
   * Unique per mounting parent. The strip mounts in both TabBar and
   * VerticalTabBar, and a shared key lets one instance's unregister clear the
   * other's — which un-hides the native panes straight over an open overlay.
   */
  overlayKey: string;
  onClose: () => void;
}

/** Manual zoom bounds, in image pixels per device pixel. Fit may go below MIN. */
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STOPS = [0.25, 0.5, 1, 2, 4];
const THUMB_HEIGHT = 60;
/** How long a destructive button stays armed before it disarms itself. */
const ARM_MS = 3500;

/**
 * Size floor for the viewer window. Below this the filmstrip, the stage and the
 * inspector stop coexisting and the thing is useless rather than merely small.
 */
const MIN_WIN_W = 640;
const MIN_WIN_H = 420;
/** Breathing room kept between the window and the app edge. */
const WIN_MARGIN = 8;

interface WinRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Centred, sitting high — the same geometry the viewer has always opened at. */
function defaultWindowRect(): WinRect {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.max(MIN_WIN_W, Math.min(1416, vw - 64));
  const h = Math.max(MIN_WIN_H, Math.min(912, vh - 140));
  return { x: Math.round((vw - w) / 2), y: Math.round(vh * 0.07), w, h };
}

/**
 * Keep the window on screen and within its size bounds.
 *
 * Always applied on open, not just after a drag: a remembered rect can outlive
 * the monitor it was sized for, and restoring it blind would put the viewer
 * partly or entirely off screen with no way to drag it back.
 */
function clampWindowRect(r: WinRect): WinRect {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(Math.max(MIN_WIN_W, r.w), Math.max(MIN_WIN_W, vw - WIN_MARGIN * 2));
  const h = Math.min(Math.max(MIN_WIN_H, r.h), Math.max(MIN_WIN_H, vh - WIN_MARGIN * 2));
  return {
    w,
    h,
    x: Math.min(vw - w - WIN_MARGIN, Math.max(WIN_MARGIN, r.x)),
    y: Math.min(vh - h - WIN_MARGIN, Math.max(WIN_MARGIN, r.y)),
  };
}

type WinAnchor = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const WIN_HANDLES: ReadonlyArray<{ anchor: WinAnchor; style: React.CSSProperties }> = [
  { anchor: "n", style: { top: 0, left: 8, right: 8, height: 5, cursor: "ns-resize", zIndex: 2 } },
  { anchor: "s", style: { bottom: 0, left: 8, right: 8, height: 5, cursor: "ns-resize", zIndex: 2 } },
  { anchor: "e", style: { top: 8, right: 0, bottom: 8, width: 5, cursor: "ew-resize", zIndex: 2 } },
  { anchor: "w", style: { top: 8, left: 0, bottom: 8, width: 5, cursor: "ew-resize", zIndex: 2 } },
  { anchor: "nw", style: { top: 0, left: 0, width: 12, height: 12, cursor: "nwse-resize", zIndex: 3 } },
  { anchor: "ne", style: { top: 0, right: 0, width: 12, height: 12, cursor: "nesw-resize", zIndex: 3 } },
  { anchor: "sw", style: { bottom: 0, left: 0, width: 12, height: 12, cursor: "nesw-resize", zIndex: 3 } },
  { anchor: "se", style: { bottom: 0, right: 0, width: 12, height: 12, cursor: "nwse-resize", zIndex: 3 } },
];

export default function ScreenshotsOverlay({
  open,
  initialImageId,
  overlayKey,
  onClose,
}: ScreenshotsOverlayProps) {
  const images = useClipboardImageStore((s) => s.images);
  const updateImageMeta = useClipboardImageStore((s) => s.updateImageMeta);
  // Only drives button labels — the actual composer-vs-PTY routing decision
  // lives in attachImage, resolved against the caret pane at attach time.
  const composerEnabled = useAppStore((s) => s.promptComposerEnabled);

  // Native panes are child HWNDs — no DOM z-index can cover them. Without this
  // the terminal paints straight over the overlay.
  useModalWhen(overlayKey, open);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [zoomMode, setZoomMode] = useState<"fit" | "manual">("fit");
  const [manualZoom, setManualZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [armDelete, setArmDelete] = useState(false);
  const [armClear, setArmClear] = useState(false);
  /**
   * Copy button just fired — swaps its icon for a green check, then reverts.
   * A counter, not a boolean: it keys the check SVG so copying again while
   * the check is still showing remounts it and replays the pop-in.
   */
  const [copied, setCopied] = useState(0);
  const copiedTimerRef = useRef<number | null>(null);

  // The check confirms THIS image was copied — moving through the filmstrip
  // or reopening the viewer goes back to the plain copy icon immediately.
  useEffect(() => {
    setCopied(0);
  }, [activeId, open]);
  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    },
    [],
  );
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; imgId: string } | null>(null);
  const [stripEdges, setStripEdges] = useState({ left: false, right: false });
  /** Fills the window. Zoom, pan and every control behave identically. */
  const [expanded, setExpanded] = useState(false);
  /**
   * Chrome-free lightbox: the image alone at 100% native pixels over the whole
   * app viewport. Distinct from `expanded`, which grows the window but keeps
   * every control. Exited via the hover circle-X or Escape.
   */
  const [maximized, setMaximized] = useState(false);
  /** Viewport position of the lightbox close button; null while hidden. */
  const [maxCloseBtn, setMaxCloseBtn] = useState<{ x: number; y: number } | null>(null);
  const maxImgRef = useRef<HTMLImageElement | null>(null);
  const maxScrollRef = useRef<HTMLDivElement | null>(null);

  // ── window geometry ──────────────────────────────────────────────────────
  const rememberWindow = useAppStore((s) => s.rememberScreenshotWindow ?? false);
  const storedRect = useAppStore((s) => s.screenshotWindowRect);
  const setStoredRect = useAppStore((s) => s.setScreenshotWindowRect);
  const [winRect, setWinRect] = useState<WinRect | null>(null);
  const winDragRef = useRef<{ start: WinRect; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    // Clamp even a remembered rect: it may have been sized for a monitor that
    // is no longer attached.
    setWinRect(clampWindowRect(rememberWindow && storedRect ? storedRect : defaultWindowRect()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // A window resize can strand the viewer off screen or larger than the app.
  useEffect(() => {
    if (!open) return;
    const onResize = () => setWinRect((r) => (r ? clampWindowRect(r) : r));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open]);

  const commitWinRect = useCallback(
    (r: WinRect) => {
      if (rememberWindow) setStoredRect(r);
    },
    [rememberWindow, setStoredRect],
  );

  /** Shared driver for the header drag and the eight resize handles. */
  const startWindowGesture = useCallback(
    (e: React.PointerEvent, anchor: WinAnchor | null) => {
      if (e.button !== 0 || !winRect || expanded) return;
      e.preventDefault();
      e.stopPropagation();
      const target = e.currentTarget as HTMLElement;
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        /* pointer can vanish between down and capture */
      }
      winDragRef.current = { start: winRect, x: e.clientX, y: e.clientY };

      let latest = winRect;
      let disposed = false;
      const onMove = (ev: PointerEvent) => {
        const d = winDragRef.current;
        if (!d) return;
        const dx = ev.clientX - d.x;
        const dy = ev.clientY - d.y;
        let next: WinRect;
        if (!anchor) {
          next = { ...d.start, x: d.start.x + dx, y: d.start.y + dy };
        } else {
          let { x, y, w, h } = d.start;
          if (anchor.includes("e")) w = Math.max(MIN_WIN_W, d.start.w + dx);
          if (anchor.includes("s")) h = Math.max(MIN_WIN_H, d.start.h + dy);
          // Clamping to the minimum pins the opposite edge rather than letting
          // the window jitter around the cursor.
          if (anchor.includes("w")) {
            const nw = Math.max(MIN_WIN_W, d.start.w - dx);
            x = d.start.x + (d.start.w - nw);
            w = nw;
          }
          if (anchor.includes("n")) {
            const nh = Math.max(MIN_WIN_H, d.start.h - dy);
            y = d.start.y + (d.start.h - nh);
            h = nh;
          }
          next = { x, y, w, h };
        }
        latest = clampWindowRect(next);
        setWinRect(latest);
      };
      const finish = () => {
        if (disposed) return;
        disposed = true;
        winDragRef.current = null;
        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", finish);
        target.removeEventListener("pointercancel", finish);
        target.removeEventListener("lostpointercapture", finish);
        try {
          target.releasePointerCapture(e.pointerId);
        } catch {
          /* already released */
        }
        commitWinRect(latest);
      };
      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", finish);
      target.addEventListener("pointercancel", finish);
      target.addEventListener("lostpointercapture", finish);
    },
    [winRect, expanded, commitWinRect],
  );

  // ── markup ───────────────────────────────────────────────────────────────
  /**
   * The toolbar is open on arrival — markup is the reason to open a screenshot,
   * not a mode to go hunting for. The default TOOL is still `select`, so the
   * viewer keeps behaving like a viewer (drag pans, double-click zooms) until
   * you actually arm something.
   */
  const [toolbarOpen, setToolbarOpen] = useState(true);
  const [tool, setTool] = useState<Tool>("select");
  /** All inks, most-recently-used first. */
  const [inks, setInks] = useState<ReadonlyArray<{ id: string; label: string; color: string }>>(
    () => MARKUP_INK_PRESETS.map((p) => ({ id: p.id, label: p.label, color: p.color })),
  );
  const [inksExpanded, setInksExpanded] = useState(false);
  const [cropVariant, setCropVariant] = useState<CropVariant>("v1");
  const [inkColor, setInkColor] = useState<string>(MARKUP_INK_PRESETS[1].color); // red
  const [thicknessIndex, setThicknessIndex] = useState(1);

  const pickInk = useCallback((c: string) => {
    setInkColor(c);
    // Move to the front so the four visible swatches are the four you reach
    // for most, newest first.
    setInks((prev) => {
      const i = prev.findIndex((p) => p.color === c);
      if (i <= 0) return prev;
      const next = [...prev];
      const [hit] = next.splice(i, 1);
      next.unshift(hit);
      return next;
    });
  }, []);

  const thickness = resolveThickness(tool, thicknessIndex);
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);

  const annShapes = useAnnotationStore((s) => s.shapes);
  const annCrop = useAnnotationStore((s) => s.crop);
  const annPast = useAnnotationStore((s) => s.past);
  const annFuture = useAnnotationStore((s) => s.future);
  const commitShapes = useAnnotationStore((s) => s.commit);
  const setCrop = useAnnotationStore((s) => s.setCrop);
  const confirmCrop = useAnnotationStore((s) => s.confirmCrop);
  const undoMarkup = useAnnotationStore((s) => s.undo);
  const redoMarkup = useAnnotationStore((s) => s.redo);

  const stageRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  // Wheel handlers are bound natively (see the effect below), so they need a
  // stable box the render can keep refreshing.
  const stageWheelRef = useRef<(e: WheelEvent) => void>(() => {});
  const stripWheelRef = useRef<(e: WheelEvent) => void>(() => {});
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  /** Set by "New screenshot" so the next capture auto-selects itself. */
  const awaitingCaptureRef = useRef(false);
  const prevCountRef = useRef(images.length);

  const active = useMemo(
    () => images.find((im) => im.id === activeId) ?? images[0] ?? null,
    [images, activeId],
  );
  const activeIndex = active ? images.findIndex((im) => im.id === active.id) : -1;

  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;

  // ── selection ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!open) return;
    setActiveId(initialImageId ?? images[0]?.id ?? null);
    setArmDelete(false);
    setArmClear(false);
    setExpanded(false);
    setMaximized(false);
    setMaxCloseBtn(null);
    setToolbarOpen(true);
    setTool("select");
    setSelectedShapeId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialImageId]);

  // A capture that arrives while the overlay is open should only steal the
  // selection when the user asked for it via "New screenshot".
  useEffect(() => {
    if (images.length > prevCountRef.current && awaitingCaptureRef.current) {
      awaitingCaptureRef.current = false;
      setActiveId(images[0]?.id ?? null);
    }
    prevCountRef.current = images.length;
  }, [images]);

  // Deleting the selected shot lands on its neighbour rather than the newest.
  const selectNeighbour = useCallback(
    (deletedIndex: number) => {
      const next = images[deletedIndex + 1] ?? images[deletedIndex - 1] ?? null;
      setActiveId(next?.id ?? null);
    },
    [images],
  );

  // ── measurement ──────────────────────────────────────────────────────────

  useEffect(() => {
    const el = stageRef.current;
    if (!el || !open) return;
    const ro = new ResizeObserver(() => {
      setStage({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setStage({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [open]);

  // Reset the view whenever the image changes.
  useEffect(() => {
    setZoomMode("fit");
    setManualZoom(1);
    setPan({ x: 0, y: 0 });
    setNatural(
      active?.width && active?.height ? { w: active.width, h: active.height } : null,
    );
    setArmDelete(false);
  }, [active?.id, active?.width, active?.height]);

  const EMPTY_SHAPES = useMemo<Shape[]>(() => [], []);
  const shapes = active ? (annShapes[active.id] ?? EMPTY_SHAPES) : EMPTY_SHAPES;
  const cropRect = active ? (annCrop[active.id] ?? null) : null;
  // A full-bounds crop is v2's starting state, not an edit — counting it would
  // light up "Save as new" before the user has trimmed anything.
  const cropIsReal = isRealCrop(cropRect, natural);
  /**
   * What the stage shows: the confirmed crop, else the whole bitmap. Every size
   * calculation below runs on THIS, not on the image, so confirming a crop
   * genuinely clips the view instead of just dimming what falls outside it.
   */
  const view = useMemo(
    () => (natural ? viewRegion(cropRect, natural) : null),
    [cropRect, natural],
  );
  const markupDirty = shapes.length > 0 || cropIsReal;

  // v2 has no draw step: arming it puts a frame on the image bounds that you
  // trim inward. Seeding here rather than in the layer keeps the layer a pure
  // renderer of whatever crop it is handed.
  useEffect(() => {
    if (tool !== "crop" || cropVariant !== "v2") return;
    if (!active || !natural || annCrop[active.id]) return;
    setCrop(active.id, { x: 0, y: 0, w: natural.w, h: natural.h });
  }, [tool, cropVariant, active, natural, annCrop, setCrop]);
  const canUndo = !!active && (annPast[active.id]?.length ?? 0) > 0;

  /**
   * Scale that fits the image in the stage, in image pixels per device pixel.
   *
   * Fit DOES enlarge. A 169×103 snip pinned at 100% is a stamp adrift in a
   * 1400px stage and reads as a broken image — "fit" has to mean "use the
   * space". MAX_ZOOM keeps a tiny crop from becoming a wall of mush, and the
   * readout says 400% so the enlargement is never a surprise; 1:1 is always one
   * click away for true size.
   */
  const fitScale = useMemo(() => {
    if (!view || !stage.w || !stage.h) return 1;
    return Math.min(MAX_ZOOM, (stage.w * dpr) / view.w, (stage.h * dpr) / view.h);
  }, [view, stage.w, stage.h, dpr]);

  const scale = zoomMode === "fit" ? fitScale : manualZoom;

  // CSS size. scale === 1 means one image pixel per DEVICE pixel, so the shot
  // appears exactly as large as it was on screen when it was captured — that
  // is what "true to size" means, and on a 100% display it equals plain 100%.
  const dispW = view ? (view.w * scale) / dpr : 0;
  const dispH = view ? (view.h * scale) / dpr : 0;

  // Growing the stage (expand, window resize) shrinks the overflow the pan was
  // clamped against, so a previously-valid offset can strand the image
  // off-centre. Returning the SAME object when nothing moved is what keeps this
  // from re-rendering forever.
  useEffect(() => {
    setPan((p) => {
      const maxX = Math.max(0, (dispW - stage.w) / 2);
      const maxY = Math.max(0, (dispH - stage.h) / 2);
      const x = Math.min(maxX, Math.max(-maxX, p.x));
      const y = Math.min(maxY, Math.max(-maxY, p.y));
      return x === p.x && y === p.y ? p : { x, y };
    });
  }, [dispW, dispH, stage.w, stage.h]);

  const clampPan = useCallback(
    (x: number, y: number, w: number, h: number) => {
      const maxX = Math.max(0, (w - stage.w) / 2);
      const maxY = Math.max(0, (h - stage.h) / 2);
      return {
        x: Math.min(maxX, Math.max(-maxX, x)),
        y: Math.min(maxY, Math.max(-maxY, y)),
      };
    },
    [stage.w, stage.h],
  );

  const applyZoom = useCallback(
    (next: number, originX?: number, originY?: number) => {
      const lo = Math.min(MIN_ZOOM, fitScale);
      const clamped = Math.min(MAX_ZOOM, Math.max(lo, next));
      if (!natural) return;

      setZoomMode("manual");
      setManualZoom(clamped);
      setPan((prev) => {
        const nw = (natural.w * clamped) / dpr;
        const nh = (natural.h * clamped) / dpr;
        if (originX === undefined || originY === undefined) {
          return clampPan(prev.x, prev.y, nw, nh);
        }
        // Keep the pixel under the cursor under the cursor.
        const ratio = clamped / scale;
        return clampPan(
          originX - (originX - prev.x) * ratio,
          originY - (originY - prev.y) * ratio,
          nw,
          nh,
        );
      });
    },
    [natural, dpr, scale, fitScale, clampPan],
  );

  const stepZoom = useCallback(
    (dir: 1 | -1) => {
      const current = scale;
      const next =
        dir > 0
          ? ZOOM_STOPS.find((z) => z > current + 0.001) ?? MAX_ZOOM
          : [...ZOOM_STOPS].reverse().find((z) => z < current - 0.001) ?? MIN_ZOOM;
      applyZoom(next);
    },
    [scale, applyZoom],
  );

  // ── actions ──────────────────────────────────────────────────────────────

  const canRedo = !!active && (annFuture[active.id]?.length ?? 0) > 0;

  /**
   * Flatten the markup to a real PNG and add it as its own screenshot.
   *
   * Returns the new row, or the untouched original when there is nothing to
   * flatten, so callers can act on "whatever the user actually sees".
   */
  const flushMarkup = useCallback(
    async (img: ClipboardImage | null): Promise<ClipboardImage | null> => {
      if (!img) return null;
      setSaving(true);
      try {
        const target = await materializeMarkup(img);
        if (target.id !== img.id) {
          setSelectedShapeId(null);
          setActiveId(target.id);
        }
        return target;
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  const attach = useCallback(
    (img: ClipboardImage | null) => {
      if (!img) return;
      // Attaching the un-annotated original after the user just marked it up
      // would be the worst possible outcome, so flatten first.
      void flushMarkup(img).then((target) => {
        if (!target) return;
        void attachImage(target);
      });
    },
    [flushMarkup],
  );

  const copyImage = useCallback(
    (img: ClipboardImage | null) => {
      if (!img) return;
      void flushMarkup(img).then((target) => {
        if (!target) return;
        void invoke("copy_image_to_clipboard", { path: target.winPath }).then(() => {
          // Confirm only what actually happened — a failed copy keeps the
          // plain icon rather than lying with a check mark.
          setCopied((n) => n + 1);
          if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
          copiedTimerRef.current = window.setTimeout(() => {
            copiedTimerRef.current = null;
            setCopied(0);
          }, 2600);
        }).catch(() => {});
      });
    },
    [flushMarkup],
  );

  const reveal = useCallback((img: ClipboardImage | null) => {
    if (!img) return;
    // The Screenshots original is the file worth showing when we have one.
    void invoke("reveal_in_explorer", { path: img.originalPath ?? img.winPath }).catch(
      () => {},
    );
  }, []);

  const copyPath = useCallback((img: ClipboardImage | null) => {
    if (!img) return;
    void resolveImagePath(img.winPath, "clipboard").then((p) => {
      if (p) navigator.clipboard.writeText(p).catch(() => {});
    });
  }, []);

  const doDelete = useCallback(
    (img: ClipboardImage | null) => {
      if (!img) return;
      const idx = images.findIndex((im) => im.id === img.id);
      void deleteScreenshot(img);
      selectNeighbour(idx);
      setArmDelete(false);
    },
    [images, selectNeighbour],
  );

  const newScreenshot = useCallback(() => {
    awaitingCaptureRef.current = true;
    void invoke("launch_snipping_tool").catch(() => {
      awaitingCaptureRef.current = false;
    });
  }, []);

  // Destructive buttons disarm themselves so a stray click much later can't
  // land on a primed Delete.
  useEffect(() => {
    if (!armDelete) return;
    const t = window.setTimeout(() => setArmDelete(false), ARM_MS);
    return () => window.clearTimeout(t);
  }, [armDelete]);

  useEffect(() => {
    if (!armClear) return;
    const t = window.setTimeout(() => setArmClear(false), ARM_MS);
    return () => window.clearTimeout(t);
  }, [armClear]);

  // ── keyboard ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (typing) return;

      // Lightbox mode: only Escape (exit) and the arrows (navigate) apply —
      // every other shortcut drives chrome that is not on screen.
      if (maximized) {
        if (e.key === "Escape") {
          e.preventDefault();
          setMaximized(false);
          setMaxCloseBtn(null);
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          if (activeIndex > 0) setActiveId(images[activeIndex - 1].id);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          if (activeIndex >= 0 && activeIndex < images.length - 1) {
            setActiveId(images[activeIndex + 1].id);
          }
        }
        return;
      }

      // Markup history, before the plain-key switch so Ctrl+Z is never
      // swallowed by a tool shortcut.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && active) {
        e.preventDefault();
        if (e.shiftKey) redoMarkup(active.id);
        else undoMarkup(active.id);
        setSelectedShapeId(null);
        return;
      }

      // Tool shortcuts, only while the toolbar is up and no modifier is held.
      if (toolbarOpen && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const toolKey: Record<string, Tool> = {
          v: "select",
          h: "marker",
          r: "rect",
          e: "ellipse",
          a: "arrow",
          c: "crop",
        };
        const picked = toolKey[e.key.toLowerCase()];
        if (picked) {
          e.preventDefault();
          setTool(picked);
          return;
        }
      }

      if (!e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "m") {
        e.preventDefault();
        setToolbarOpen((v) => !v);
        return;
      }

      switch (e.key) {
        case "Escape":
          e.preventDefault();
          // Unwind the most local thing first: an in-flight drag, then a
          // selection, then a primed destructive button, and only then close.
          if (drafting) return; // the layer's own pointer gesture owns this
          if (selectedShapeId) {
            setSelectedShapeId(null);
            return;
          }
          // Disarm the tool before anything global — Escape with a rectangle
          // armed should put the pointer back, not close the viewer.
          if (tool !== "select") {
            setTool("select");
            return;
          }
          if (armDelete || armClear) {
            setArmDelete(false);
            setArmClear(false);
            return;
          }
          onClose();
          return;
        case "ArrowLeft":
          e.preventDefault();
          if (activeIndex > 0) setActiveId(images[activeIndex - 1].id);
          return;
        case "ArrowRight":
          e.preventDefault();
          if (activeIndex >= 0 && activeIndex < images.length - 1) {
            setActiveId(images[activeIndex + 1].id);
          }
          return;
        case "Enter":
          if (target?.closest("button")) return; // let the focused button act
          e.preventDefault();
          attach(active);
          onClose();
          return;
        case "Delete":
        case "Backspace":
          e.preventDefault();
          // A selected shape consumes this key. Without the branch, pressing
          // Delete to remove an annotation would arm deletion of the whole
          // screenshot instead.
          if (selectedShapeId && active) {
            commitShapes(
              active.id,
              shapes.filter((s) => s.id !== selectedShapeId),
            );
            setSelectedShapeId(null);
            return;
          }
          if (armDelete) doDelete(active);
          else setArmDelete(true);
          return;
        case "0":
          e.preventDefault();
          setZoomMode("fit");
          setPan({ x: 0, y: 0 });
          return;
        case "1":
          e.preventDefault();
          applyZoom(1);
          return;
        case "+":
        case "=":
          e.preventDefault();
          stepZoom(1);
          return;
        case "-":
        case "_":
          e.preventDefault();
          stepZoom(-1);
          return;
        case "f":
        case "F":
          e.preventDefault();
          setExpanded((v) => !v);
          return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
        e.preventDefault();
        copyImage(active);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    open,
    images,
    activeIndex,
    active,
    armDelete,
    armClear,
    onClose,
    attach,
    doDelete,
    applyZoom,
    stepZoom,
    copyImage,
    toolbarOpen,
    tool,
    drafting,
    selectedShapeId,
    shapes,
    commitShapes,
    undoMarkup,
    redoMarkup,
    maximized,
  ]);

  // ── lightbox (maximized) ─────────────────────────────────────────────────

  /**
   * The circle-X exists only while the cursor is near the top of the image:
   * inside the image's top 25% (with a little grace around the edges). Its
   * anchor is the top-center of the VISIBLE part of the image, so it stays
   * reachable however far a large image is scrolled.
   */
  const handleMaxPointerMove = useCallback((e: React.PointerEvent) => {
    const img = maxImgRef.current;
    if (!img) return;
    const r = img.getBoundingClientRect();
    const pad = 40;
    const inZone =
      e.clientX >= r.left - pad &&
      e.clientX <= r.right + pad &&
      e.clientY >= r.top - pad &&
      e.clientY <= r.top + r.height * 0.25;
    if (!inZone) {
      setMaxCloseBtn((prev) => (prev ? null : prev));
      return;
    }
    const x = Math.round((Math.max(r.left, 0) + Math.min(r.right, window.innerWidth)) / 2);
    const y = Math.round(Math.max(r.top, 0) + 14);
    setMaxCloseBtn((prev) => (prev && prev.x === x && prev.y === y ? prev : { x, y }));
  }, []);

  /** Drag pans an overflowing image by driving the container's scroll. */
  const startMaxPan = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    const sc = maxScrollRef.current;
    if (!sc) return;
    if (sc.scrollWidth <= sc.clientWidth && sc.scrollHeight <= sc.clientHeight) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* pointer can vanish between down and capture */
    }
    const start = { x: e.clientX, y: e.clientY, l: sc.scrollLeft, t: sc.scrollTop };
    let disposed = false;
    const onMove = (ev: PointerEvent) => {
      sc.scrollLeft = start.l - (ev.clientX - start.x);
      sc.scrollTop = start.t - (ev.clientY - start.y);
    };
    const finish = () => {
      if (disposed) return;
      disposed = true;
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", finish);
      el.removeEventListener("pointercancel", finish);
      el.removeEventListener("lostpointercapture", finish);
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", finish);
    el.addEventListener("pointercancel", finish);
    el.addEventListener("lostpointercapture", finish);
  }, []);

  // React registers `wheel` as a PASSIVE listener on its root container, so a
  // preventDefault inside an onWheel prop silently does nothing and logs a
  // warning. Both wheel surfaces here repurpose the gesture — the stage zooms,
  // the rail scrolls sideways — so both have to suppress the default scroll,
  // which means binding them natively.
  stageWheelRef.current = (e: WheelEvent) => {
    if (!natural) return;
    e.preventDefault();
    const el = stageRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    applyZoom(
      scale * Math.pow(1.1, -e.deltaY / 100),
      e.clientX - rect.left - rect.width / 2,
      e.clientY - rect.top - rect.height / 2,
    );
  };

  stripWheelRef.current = (e: WheelEvent) => {
    const el = stripRef.current;
    if (!el || e.deltaY === 0) return;
    // A vertical wheel is the only wheel most mice have, and this rail only
    // scrolls sideways.
    e.preventDefault();
    el.scrollLeft += e.deltaY;
  };

  const hasImages = images.length > 0;
  useEffect(() => {
    if (!open || !hasImages) return;
    const stageEl = stageRef.current;
    const stripEl = stripRef.current;
    const onStage = (e: WheelEvent) => stageWheelRef.current(e);
    const onStrip = (e: WheelEvent) => stripWheelRef.current(e);
    stageEl?.addEventListener("wheel", onStage, { passive: false });
    stripEl?.addEventListener("wheel", onStrip, { passive: false });
    return () => {
      stageEl?.removeEventListener("wheel", onStage);
      stripEl?.removeEventListener("wheel", onStrip);
    };
  }, [open, hasImages]);

  // ── filmstrip ────────────────────────────────────────────────────────────

  const syncStripEdges = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    // Gate both arrows on the strip actually being scrollable. Without this a
    // single thumbnail still showed a right arrow: `scrollWidth` and
    // `clientWidth` are both rounded integers, and the rail's 14px padding is
    // enough for them to disagree by a pixel or two with nothing to scroll to.
    const maxScroll = el.scrollWidth - el.clientWidth;
    const scrollable = maxScroll > 4;
    setStripEdges({
      left: scrollable && el.scrollLeft > 2,
      right: scrollable && el.scrollLeft < maxScroll - 2,
    });
  }, []);

  // Hover-to-scroll arrows. The rAF loop stops itself at the end of the track,
  // because the arrow hides at exactly that moment and a hidden element never
  // fires the mouseleave that would otherwise stop it.
  const autoScrollRef = useRef<number | null>(null);
  const stopAutoScroll = useCallback(() => {
    if (autoScrollRef.current !== null) {
      cancelAnimationFrame(autoScrollRef.current);
      autoScrollRef.current = null;
    }
  }, []);
  const startAutoScroll = useCallback(
    (dir: -1 | 1) => {
      stopAutoScroll();
      const step = () => {
        const el = stripRef.current;
        if (!el) return stopAutoScroll();
        const atEnd =
          dir < 0
            ? el.scrollLeft <= 0
            : el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
        if (atEnd) return stopAutoScroll();
        el.scrollLeft += dir * 7;
        autoScrollRef.current = requestAnimationFrame(step);
      };
      autoScrollRef.current = requestAnimationFrame(step);
    },
    [stopAutoScroll],
  );
  useEffect(() => stopAutoScroll, [stopAutoScroll]);
  useEffect(() => {
    if (!open) stopAutoScroll();
  }, [open, stopAutoScroll]);

  useEffect(() => {
    if (!open) return;
    syncStripEdges();
  }, [open, images.length, syncStripEdges]);

  // Thumbnails are lazy and sized `width: auto`, so the rail's real content
  // width does not exist yet when the effect above first runs — and the viewer
  // window is resizable, which changes whether the rail scrolls at all. Watch
  // the element itself rather than trying to enumerate the causes.
  useEffect(() => {
    const el = stripRef.current;
    if (!open || !el) return;
    const ro = new ResizeObserver(() => syncStripEdges());
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, images.length, syncStripEdges]);

  // Keep the selected thumb in view when the arrow keys walk past the edge.
  useEffect(() => {
    if (!open || !active) return;
    const el = stripRef.current?.querySelector<HTMLElement>(`[data-shot-id="${active.id}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [open, active?.id]);

  useOverlayMenu({
    id: `screenshots-overlay-ctx-${overlayKey}`,
    open: !!ctxMenu,
    anchorPoint: ctxMenu ? { x: ctxMenu.x, y: ctxMenu.y } : null,
    payload: ctxMenu
      ? {
          placement: "below-start",
          width: 180,
          sections: [
            {
              items: [
                {
                  actionId: "attach",
                  label: composerEnabled ? "Attach to prompt" : "Insert path",
                },
                { actionId: "copy", label: "Copy image" },
                { actionId: "copy-path", label: "Copy filepath" },
                { actionId: "reveal", label: "Show in folder" },
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
        case "attach":
          attach(img);
          break;
        case "copy":
          copyImage(img);
          break;
        case "copy-path":
          copyPath(img);
          break;
        case "reveal":
          reveal(img);
          break;
        case "delete":
          doDelete(img);
          break;
      }
    },
    onClose: () => setCtxMenu(null),
  });

  if (!open) return null;

  const sized = !!natural && stage.w > 0 && stage.h > 0;
  const overflows = sized && (dispW > stage.w + 1 || dispH > stage.h + 1);
  const zoomPct = Math.round(scale * 100);
  const totalFiles = images.reduce((n, im) => n + fileCount(im), 0);

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 250,
        backgroundColor: "rgba(0,0,0,0.66)",
      }}
      onClick={onClose}
    >
      <div
        className="dropdown-enter"
        style={{
          // Explicit geometry rather than flex centring — the window is
          // draggable and resizable, so it needs a position to own.
          position: "fixed",
          left: expanded ? 16 : (winRect?.x ?? 0),
          top: expanded ? 16 : (winRect?.y ?? 0),
          width: expanded ? "calc(100vw - 32px)" : (winRect?.w ?? 0),
          height: expanded ? "calc(100vh - 32px)" : (winRect?.h ?? 0),
          // Only animate the expand toggle; a drag must track the pointer
          // exactly, and a transition would make it lag behind.
          transition: winDragRef.current
            ? "none"
            : "left 140ms ease, top 140ms ease, width 140ms ease, height 140ms ease",
          visibility: winRect || expanded ? "visible" : "hidden",
          display: "flex",
          flexDirection: "column",
          backgroundColor: "var(--ezy-surface-raised)",
          border: "1px solid var(--ezy-border)",
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 10px)",
          overflow: "hidden",
          boxShadow: "0 24px 64px rgba(0,0,0,0.55)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Resize edges. Rendered first so the header's own drag handler wins
            wherever they overlap. */}
        {!expanded &&
          WIN_HANDLES.map(({ anchor, style }) => (
            <div
              key={anchor}
              onPointerDown={(e) => startWindowGesture(e, anchor)}
              style={{ position: "absolute", ...style }}
            />
          ))}

        {/* ── Header ─────────────────────────────────────────────────── */}
        <div
          onPointerDown={(e) => {
            // Buttons inside the drag surface keep their clicks.
            if ((e.target as HTMLElement).closest("button")) return;
            startWindowGesture(e, null);
          }}
          style={{
            height: 48,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "0 14px",
            borderBottom: "1px solid var(--ezy-border)",
            cursor: expanded ? "default" : "grab",
            userSelect: "none",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ezy-text)" }}>
              Screenshots
            </span>
            {images.length > 0 && (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  lineHeight: 1,
                  padding: "3px 7px",
                  borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                  backgroundColor: "var(--ezy-surface)",
                  border: "1px solid var(--ezy-border)",
                  color: "var(--ezy-text-secondary)",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {images.length}
              </span>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <GhostButton onClick={newScreenshot} tooltip="Opens the snipping tool">
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <path
                  d="M2 4.5 H10 V10 H2 Z M4.2 4.5 L5 2.5 H7 L7.8 4.5"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  fill="none"
                  strokeLinejoin="round"
                />
                <circle cx="6" cy="7.2" r="1.6" stroke="currentColor" strokeWidth="1.2" fill="none" />
              </svg>
              New screenshot
            </GhostButton>

            {images.length > 0 &&
              (armClear ? (
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <button
                    onClick={() => {
                      void deleteAllScreenshots(images);
                      setArmClear(false);
                      onClose();
                    }}
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      fontFamily: "inherit",
                      height: 26,
                      padding: "0 10px",
                      borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
                      border: "none",
                      backgroundColor: "var(--ezy-red, #dc2626)",
                      color: "#fff",
                      cursor: "pointer",
                    }}
                  >
                    Delete {totalFiles} {totalFiles === 1 ? "file" : "files"}?
                  </button>
                  <GhostButton onClick={() => setArmClear(false)}>Cancel</GhostButton>
                </div>
              ) : (
                <GhostButton onClick={() => setArmClear(true)}>Clear all</GhostButton>
              ))}

            {active && (
              <GhostButton
                onClick={() => setMaximized(true)}
                square
                tooltip="Maximize image to full size"
                aria-label="Maximize image"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <path
                    d="M7 1.5 H10.5 V5 M10.5 1.5 L7 5 M5 10.5 H1.5 V7 M1.5 10.5 L5 7"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </GhostButton>
            )}

            <GhostButton
              onClick={() => setExpanded((v) => !v)}
              square
              tooltip={expanded ? "Shrink (F)" : "Fill the window (F)"}
              aria-label={expanded ? "Shrink viewer" : "Expand viewer"}
            >
              {expanded ? (
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <path
                    d="M5 1.5 V5 H1.5 M7 10.5 V7 H10.5"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <path
                    d="M7 1.5 H10.5 V5 M5 10.5 H1.5 V7"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </GhostButton>

            <GhostButton onClick={onClose} tooltip="Close (Esc)" square aria-label="Close">
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <path
                  d="M3 3 L9 9 M9 3 L3 9"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            </GhostButton>
          </div>
        </div>

        {images.length === 0 ? (
          <EmptyState onSnip={newScreenshot} />
        ) : (
          <>
            {/* ── Filmstrip ────────────────────────────────────────────── */}
            <div style={{ position: "relative", flexShrink: 0 }}>
              <div
                ref={stripRef}
                onScroll={syncStripEdges}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "12px 14px",
                  overflowX: "auto",
                  overflowY: "hidden",
                  scrollSnapType: "x proximity",
                  borderBottom: "1px solid var(--ezy-border-subtle)",
                }}
              >
                {images.map((img, i) => {
                  const isActive = img.id === active?.id;
                  return (
                    <div
                      key={img.id}
                      data-shot-id={img.id}
                      onClick={() => setActiveId(img.id)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setActiveId(img.id);
                        setCtxMenu({ x: e.clientX, y: e.clientY, imgId: img.id });
                      }}
                      data-tooltip={`${fileNameOf(img.originalPath ?? img.winPath)}  ·  ${new Date(
                        img.timestamp,
                      ).toLocaleTimeString()}`}
                      style={{
                        position: "relative",
                        height: THUMB_HEIGHT,
                        flexShrink: 0,
                        borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
                        overflow: "hidden",
                        cursor: "pointer",
                        scrollSnapAlign: "center",
                        opacity: isActive ? 1 : 0.5,
                        boxShadow: isActive
                          ? "0 0 0 2px var(--ezy-accent)"
                          : "0 0 0 1px var(--ezy-border-subtle)",
                        transition: "opacity 120ms ease, box-shadow 120ms ease",
                      }}
                      onMouseEnter={(e) => {
                        if (!isActive) e.currentTarget.style.opacity = "0.85";
                      }}
                      onMouseLeave={(e) => {
                        if (!isActive) e.currentTarget.style.opacity = "0.5";
                      }}
                    >
                      {/*
                        Height-constrained with auto width, so each thumb keeps
                        its true aspect ratio. Screenshots are arbitrary crops
                        and their shape is how you recognise them — a uniform
                        16/9 cover crop throws that away.
                      */}
                      <img
                        src={img.dataUri}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        // A thumb is zero-width until it decodes, so the rail's
                        // content width only becomes real here. The container's
                        // own box never changes, so the ResizeObserver above
                        // cannot see this.
                        onLoad={syncStripEdges}
                        style={{
                          height: THUMB_HEIGHT,
                          width: "auto",
                          maxWidth: 200,
                          objectFit: "cover",
                          display: "block",
                        }}
                      />
                      {isActive && (
                        <div
                          style={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            minWidth: 16,
                            height: 15,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            padding: "0 3px",
                            backgroundColor: "var(--ezy-accent)",
                            borderBottomRightRadius: 4,
                            fontSize: 9,
                            fontWeight: 700,
                            color: "#fff",
                            lineHeight: 1,
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {i + 1}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <EdgeFade side="left" visible={stripEdges.left} />
              <EdgeFade side="right" visible={stripEdges.right} />
              {/* Each arrow only exists while there is track left that way. */}
              <ScrollArrow
                side="left"
                visible={stripEdges.left}
                onEnter={() => startAutoScroll(-1)}
                onLeave={stopAutoScroll}
                onClick={() => stripRef.current?.scrollBy({ left: -240, behavior: "smooth" })}
              />
              <ScrollArrow
                side="right"
                visible={stripEdges.right}
                onEnter={() => startAutoScroll(1)}
                onLeave={stopAutoScroll}
                onClick={() => stripRef.current?.scrollBy({ left: 240, behavior: "smooth" })}
              />
            </div>

            {natural && (
              <ScreenshotAnnotationToolbar
                tool={tool}
                onTool={setTool}
                color={inkColor}
                onColor={pickInk}
                inks={inks}
                inksExpanded={inksExpanded}
                onToggleInks={() => setInksExpanded((v) => !v)}
                thicknessIndex={thicknessIndex}
                onThicknessIndex={setThicknessIndex}
                cropVariant={cropVariant}
                onCropVariant={setCropVariant}
                open={toolbarOpen}
                onToggleOpen={() => setToolbarOpen((v) => !v)}
                canUndo={canUndo}
                canRedo={canRedo}
                onUndo={() => {
                  if (active) undoMarkup(active.id);
                  setSelectedShapeId(null);
                }}
                onRedo={() => {
                  if (active) redoMarkup(active.id);
                  setSelectedShapeId(null);
                }}
                hasCrop={cropIsReal}
                cropPending={!!cropRect && !cropRect.confirmed && cropIsReal}
                onConfirmCrop={() => {
                  if (!active) return;
                  confirmCrop(active.id);
                  // The crop is applied; leaving the tool armed would invite an
                  // accidental re-crop of what was just settled.
                  setTool("select");
                }}
                onClearCrop={() => active && setCrop(active.id, null)}
                dirty={markupDirty}
                saving={saving}
                onSave={() => {
                  if (!active) return;
                  setSaving(true);
                  void saveMarkupInPlace(active)
                    .then(() => setSelectedShapeId(null))
                    .finally(() => setSaving(false));
                }}
                saveTargets={active ? fileCount(active) : 0}
                onSaveAsNew={() => void flushMarkup(active)}
              />
            )}

            {/* ── Stage ────────────────────────────────────────────────── */}
            <div
              ref={stageRef}
              onDoubleClick={() => {
                // An armed tool owns double-clicks; plain viewing keeps zoom.
                if (tool !== "select") return;
                if (zoomMode === "fit") applyZoom(1);
                else {
                  setZoomMode("fit");
                  setPan({ x: 0, y: 0 });
                }
              }}
              onPointerDown={(e) => {
                if (!overflows || e.button !== 0) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                dragRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
              }}
              onPointerMove={(e) => {
                const d = dragRef.current;
                if (!d) return;
                setPan(
                  clampPan(
                    d.panX + (e.clientX - d.x),
                    d.panY + (e.clientY - d.y),
                    dispW,
                    dispH,
                  ),
                );
              }}
              onPointerUp={(e) => {
                dragRef.current = null;
                e.currentTarget.releasePointerCapture(e.pointerId);
              }}
              onPointerCancel={() => {
                dragRef.current = null;
              }}
              style={{
                flex: 1,
                minHeight: 0,
                margin: "12px 14px",
                position: "relative",
                overflow: "hidden",
                borderRadius: "calc(var(--ezy-radius-scale, 1) * 8px)",
                // A recessed well, so a white screenshot has an edge to sit
                // against instead of bleeding into the card.
                backgroundColor: "rgba(0,0,0,0.28)",
                boxShadow: "inset 0 1px 0 rgba(255,255,255,0.03)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                // An armed tool owns the cursor over the image; the stage keeps
                // grab for the margin around it, which still pans.
                cursor: tool !== "select"
                  ? "default"
                  : overflows
                    ? dragRef.current
                      ? "grabbing"
                      : "grab"
                    : "default",
                touchAction: "none",
              }}
            >
              {active && (
                <div
                  // The frame lives on this wrapper, NOT the <img>. Tailwind's
                  // preflight sets box-sizing:border-box, so a bordered image
                  // sized `dispW` has a content box of `dispW - 2` — every
                  // markup coordinate would be off, worsening with zoom. Here
                  // the bitmap fills the wrapper exactly and the annotation
                  // layer can sit at inset:0 over it.
                  style={{
                    position: "relative",
                    width: sized ? dispW : undefined,
                    height: sized ? dispH : undefined,
                    maxWidth: sized ? undefined : "100%",
                    maxHeight: sized ? undefined : "100%",
                    transform: `translate(${pan.x}px, ${pan.y}px)`,
                    borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
                    flexShrink: 0,
                    overflow: "hidden",
                  }}
                >
                  <img
                    key={active.id}
                    src={active.dataUri}
                    alt={fileNameOf(active.winPath)}
                    draggable={false}
                    onLoad={(e) => {
                      const el = e.currentTarget;
                      setNatural({ w: el.naturalWidth, h: el.naturalHeight });
                      if (!active.width || !active.height) {
                        updateImageMeta(active.id, {
                          width: el.naturalWidth,
                          height: el.naturalHeight,
                        });
                      }
                    }}
                    style={{
                      // Sized explicitly rather than via CSS transform scale so
                      // the browser resamples at the target resolution — a
                      // transform-scaled bitmap looks soft at 1:1.
                      //
                      // The wrapper is the size of the VIEW; the bitmap is drawn
                      // at full size and slid so the view's top-left lands at
                      // 0,0. A confirmed crop is therefore a real clip, not a
                      // dimmed overlay, and it costs no re-encoding.
                      position: "absolute",
                      display: "block",
                      width: sized && view && natural ? (natural.w * dispW) / view.w : "100%",
                      height: sized && view && natural ? (natural.h * dispH) / view.h : "100%",
                      left: sized && view ? -(view.x * dispW) / view.w : 0,
                      top: sized && view ? -(view.y * dispH) / view.h : 0,
                      imageRendering: scale >= 2 ? "pixelated" : "auto",
                      userSelect: "none",
                    }}
                  />
                  {natural && view && sized && active && (
                    <ScreenshotAnnotationLayer
                      imageId={active.id}
                      view={view}
                      dispW={dispW}
                      dispH={dispH}
                      pan={pan}
                      stageRef={stageRef}
                      tool={tool}
                      color={inkColor}
                      thickness={thickness}
                      shapes={shapes}
                      crop={cropRect}
                      cropVariant={cropVariant}
                      selectedId={selectedShapeId}
                      onSelect={setSelectedShapeId}
                      onCommit={(next) => commitShapes(active.id, next)}
                      onCrop={(r) => setCrop(active.id, r)}
                      onDraftChange={setDrafting}
                    />
                  )}
                </div>
              )}
            </div>

            {/* ── Inspector ────────────────────────────────────────────── */}
            <div
              style={{
                height: 56,
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                gap: 16,
                padding: "0 14px",
                borderTop: "1px solid var(--ezy-border)",
                backgroundColor: "var(--ezy-surface)",
              }}
            >
              {/* Identity + metadata */}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  className="truncate"
                  style={{ fontSize: 12, color: "var(--ezy-text)" }}
                  data-tooltip={active?.originalPath ?? active?.winPath}
                >
                  {active ? fileNameOf(active.originalPath ?? active.winPath) : ""}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--ezy-text-muted)",
                    marginTop: 2,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {[
                    natural ? `${natural.w} × ${natural.h}` : null,
                    formatBytes(active?.bytes),
                    // Both readings, as the legacy gallery had: the clock time
                    // is what you match against your own memory of the session,
                    // the relative one is what you skim.
                    active ? new Date(active.timestamp).toLocaleTimeString() : null,
                    active ? relativeTime(active.timestamp) : null,
                  ]
                    .filter(Boolean)
                    .join("  ·  ")}
                </div>
              </div>

              {/* Zoom */}
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                <GhostButton onClick={() => stepZoom(-1)} square tooltip="Zoom out (−)">
                  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                    <path d="M3 6 H9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                </GhostButton>
                <span
                  style={{
                    fontSize: 11,
                    color: "var(--ezy-text-secondary)",
                    minWidth: 40,
                    textAlign: "center",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {zoomPct}%
                </span>
                <GhostButton onClick={() => stepZoom(1)} square tooltip="Zoom in (+)">
                  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                    <path
                      d="M3 6 H9 M6 3 V9"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                    />
                  </svg>
                </GhostButton>

                <div
                  style={{
                    display: "flex",
                    marginLeft: 4,
                    borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
                    overflow: "hidden",
                    border: "1px solid var(--ezy-border)",
                  }}
                >
                  <SegButton
                    active={zoomMode === "fit"}
                    onClick={() => {
                      setZoomMode("fit");
                      setPan({ x: 0, y: 0 });
                    }}
                    tooltip="Fit to window (0)"
                  >
                    Fit
                  </SegButton>
                  <SegButton
                    active={zoomMode === "manual" && Math.abs(scale - 1) < 0.001}
                    onClick={() => applyZoom(1)}
                    tooltip="True to size (1)"
                  >
                    1:1
                  </SegButton>
                </div>
              </div>

              {/* Actions */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                <button
                  onClick={() => {
                    attach(active);
                    onClose();
                  }}
                  style={{
                    height: 28,
                    padding: "0 12px",
                    borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
                    border: "none",
                    backgroundColor: "var(--ezy-accent)",
                    color: "#fff",
                    fontSize: 12,
                    fontWeight: 600,
                    fontFamily: "inherit",
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                 
                >
                  <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
                    <path
                      d="M6 2 V8 M3 5 L6 8 L9 5 M2.5 10 H9.5"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      fill="none"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  {composerEnabled ? "Attach to prompt" : "Insert path"}
                </button>

                <GhostButton
                  onClick={() => copyImage(active)}
                  square
                  tooltip={copied ? "Copied" : "Copy image (Ctrl+C)"}
                  aria-label="Copy image"
                >
                  {copied > 0 ? (
                    <svg
                      key={copied}
                      width="12"
                      height="12"
                      viewBox="0 0 12 12"
                      aria-hidden="true"
                      className="check-pop-in"
                    >
                      <path
                        d="M2.5 6.5 L5 9 L9.5 3.5"
                        stroke="#3fb950"
                        strokeWidth="1.6"
                        fill="none"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                      <rect x="3" y="3" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.3" fill="none" />
                      <path
                        d="M4.5 3 V2 H10 V8 H8.5"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        fill="none"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </GhostButton>

                <GhostButton
                  onClick={() => reveal(active)}
                  square
                  tooltip="Show in folder"
                  aria-label="Show in folder"
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                    <path
                      d="M1.5 3.5 H5 L6 5 H10.5 V9 H1.5 Z"
                      stroke="currentColor"
                      strokeWidth="1.2"
                      fill="none"
                      strokeLinejoin="round"
                    />
                  </svg>
                </GhostButton>

                {armDelete ? (
                  <button
                    onClick={() => doDelete(active)}
                    style={{
                      height: 28,
                      padding: "0 10px",
                      borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
                      border: "none",
                      backgroundColor: "var(--ezy-red, #dc2626)",
                      color: "#fff",
                      fontSize: 11,
                      fontWeight: 600,
                      fontFamily: "inherit",
                      cursor: "pointer",
                    }}
                    data-tooltip={
                      active && fileCount(active) > 1
                        ? "Deletes the temp copy and the original in your Screenshots folder"
                        : "Deletes the temp copy only — no original was matched"
                    }
                  >
                    Delete {active ? fileCount(active) : 0}{" "}
                    {active && fileCount(active) === 1 ? "file" : "files"}?
                  </button>
                ) : (
                  <GhostButton
                    onClick={() => setArmDelete(true)}
                    square
                    danger
                    tooltip="Delete from disk (Del)"
                    aria-label="Delete screenshot"
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                      <path
                        d="M3 4 H9 M4.5 4 V2.5 H7.5 V4 M4 4 L4.5 10 H7.5 L8 4"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        fill="none"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </GhostButton>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Maximized lightbox ─────────────────────────────────────────────
          The image alone at 100% native pixels (1 image px : 1 device px),
          fully covering the viewer. Overflow pans by drag or scrolls by
          wheel; smaller images sit centered. Exit: hover circle-X near the
          top of the image, or Escape. */}
      {maximized && active && (
        <div
          ref={maxScrollRef}
          onClick={(e) => e.stopPropagation()}
          onPointerMove={handleMaxPointerMove}
          onPointerLeave={() => setMaxCloseBtn(null)}
          onPointerDown={startMaxPan}
          style={{
            position: "fixed",
            inset: 0,
            overflow: "auto",
            backgroundColor: "#0a0a0a",
          }}
        >
          <div
            style={{
              display: "flex",
              minWidth: "100%",
              minHeight: "100%",
              width: "max-content",
              height: "max-content",
            }}
          >
            <img
              ref={maxImgRef}
              src={active.dataUri}
              alt={fileNameOf(active.winPath)}
              draggable={false}
              onLoad={(e) => {
                const el = e.currentTarget;
                if (!natural) setNatural({ w: el.naturalWidth, h: el.naturalHeight });
              }}
              style={{
                // margin:auto centres in both axes AND keeps every edge
                // reachable when the image overflows (flex centring clips the
                // top-left corner off a scroll container).
                margin: "auto",
                width: natural ? natural.w / dpr : undefined,
                height: natural ? natural.h / dpr : undefined,
                maxWidth: "none",
                flexShrink: 0,
                display: "block",
              }}
            />
          </div>
          {maxCloseBtn && (
            <button
              onClick={() => {
                setMaximized(false);
                setMaxCloseBtn(null);
              }}
              aria-label="Close maximized image (Esc)"
              data-tooltip="Close (Esc)"
              style={{
                position: "fixed",
                left: maxCloseBtn.x,
                top: maxCloseBtn.y,
                transform: "translateX(-50%)",
                width: 32,
                height: 32,
                borderRadius: "50%",
                border: "1px solid rgba(255,255,255,0.22)",
                backgroundColor: "#262626",
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                padding: 0,
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <path
                  d="M3 3 L9 9 M9 3 L3 9"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}

// ───────────────────────────────────────────────────────────────────────────

function GhostButton({
  children,
  onClick,
  tooltip,
  square,
  danger,
  ...rest
}: {
  children: React.ReactNode;
  onClick: () => void;
  tooltip?: string;
  square?: boolean;
  danger?: boolean;
} & React.AriaAttributes) {
  return (
    <button
      onClick={onClick}
      data-tooltip={tooltip}
      {...rest}
      style={{
        height: 26,
        width: square ? 26 : undefined,
        padding: square ? 0 : "0 10px",
        borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
        border: "1px solid var(--ezy-border)",
        backgroundColor: "transparent",
        color: danger ? "var(--ezy-red, #dc2626)" : "var(--ezy-text-secondary)",
        fontSize: 11,
        fontWeight: 500,
        fontFamily: "inherit",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        transition: "background-color 120ms ease, color 120ms ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
        if (!danger) e.currentTarget.style.color = "var(--ezy-text)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = "transparent";
        if (!danger) e.currentTarget.style.color = "var(--ezy-text-secondary)";
      }}
    >
      {children}
    </button>
  );
}

function SegButton({
  children,
  active,
  onClick,
  tooltip,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
  tooltip?: string;
}) {
  return (
    <button
      onClick={onClick}
      data-tooltip={tooltip}
      style={{
        height: 26,
        padding: "0 10px",
        border: "none",
        backgroundColor: active ? "var(--ezy-accent)" : "transparent",
        color: active ? "#fff" : "var(--ezy-text-secondary)",
        fontSize: 11,
        fontWeight: 600,
        fontFamily: "inherit",
        cursor: "pointer",
        transition: "background-color 120ms ease, color 120ms ease",
      }}
    >
      {children}
    </button>
  );
}

/**
 * Hover-to-scroll arrow for the filmstrip. Rendered only when there is track
 * left in that direction, so at the far left you get the right arrow alone.
 */
function ScrollArrow({
  side,
  visible,
  onEnter,
  onLeave,
  onClick,
}: {
  side: "left" | "right";
  visible: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onClick: () => void;
}) {
  if (!visible) return null;
  return (
    <button
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={onClick}
      aria-label={side === "left" ? "Scroll left" : "Scroll right"}
      style={{
        position: "absolute",
        [side]: 6,
        top: "50%",
        transform: "translateY(-50%)",
        width: 22,
        height: 22,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        borderRadius: "50%",
        border: "1px solid var(--ezy-border)",
        backgroundColor: "var(--ezy-surface-raised)",
        color: "var(--ezy-text-secondary)",
        cursor: "pointer",
        boxShadow: "0 2px 8px rgba(0,0,0,0.45)",
        transition: "color 120ms ease, border-color 120ms ease",
      }}
      onFocus={(e) => {
        e.currentTarget.style.color = "var(--ezy-text)";
      }}
      onBlur={(e) => {
        e.currentTarget.style.color = "var(--ezy-text-secondary)";
      }}
    >
      <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
        <path
          d={side === "left" ? "M7.5 2 L4 6 L7.5 10" : "M4.5 2 L8 6 L4.5 10"}
          stroke="currentColor"
          strokeWidth="1.5"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/** Signals that the filmstrip scrolls further in that direction. */
function EdgeFade({ side, visible }: { side: "left" | "right"; visible: boolean }) {
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        bottom: 1,
        [side]: 0,
        width: 32,
        pointerEvents: "none",
        opacity: visible ? 1 : 0,
        transition: "opacity 150ms ease",
        background: `linear-gradient(to ${side}, transparent, var(--ezy-surface-raised))`,
      }}
    />
  );
}

function EmptyState({ onSnip }: { onSnip: () => void }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
      }}
    >
      <div style={{ fontSize: 14, color: "var(--ezy-text-secondary)" }}>No screenshots yet</div>
      <button
        onClick={onSnip}
        style={{
          height: 30,
          padding: "0 14px",
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
          border: "none",
          backgroundColor: "var(--ezy-accent)",
          color: "#fff",
          fontSize: 12,
          fontWeight: 600,
          fontFamily: "inherit",
          cursor: "pointer",
        }}
      >
        Take a screenshot
      </button>
      <div style={{ fontSize: 11, color: "var(--ezy-text-muted)" }}>
        Win+Shift+S, or paste an image
      </div>
    </div>
  );
}
