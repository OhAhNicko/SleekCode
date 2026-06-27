import {
  cursorPosition,
  getCurrentWindow,
  PhysicalPosition,
  PhysicalSize,
} from "@tauri-apps/api/window";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";

export type CustomResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

const MIN_LOGICAL_WIDTH = 720;
const MIN_LOGICAL_HEIGHT = 420;

function round(value: number): number {
  return Math.round(value);
}

function stopPointerDefaults(event: ReactPointerEvent<HTMLElement>) {
  event.preventDefault();
  event.stopPropagation();
}

function capturePointer(target: HTMLElement, pointerId: number) {
  try {
    target.setPointerCapture(pointerId);
  } catch {
    // The pointer can disappear during maximize/restore transitions.
  }
}

function releasePointer(target: HTMLElement, pointerId: number) {
  try {
    target.releasePointerCapture(pointerId);
  } catch {
    // It may already have been released by the browser.
  }
}

const DRAG_THRESHOLD_PX = 4;

export function startCustomWindowDrag(event: ReactPointerEvent<HTMLElement>) {
  if (event.button !== 0) return;

  // Begin a NATIVE OS window drag once the pointer crosses the drag threshold.
  // `startDragging()` (WM_NCLBUTTONDOWN / HTCAPTION on Windows) hands the move
  // loop to the OS, which is far smoother than the old per-frame `setPosition`
  // IPC — essential with a transparent window, where every position change
  // forces DWM to recomposite the window's alpha + CSS shadow against the live
  // desktop. Waiting for the threshold keeps a plain click (and double-click to
  // maximize) working; Windows also restores a maximized window under the
  // cursor when you drag its titlebar, so we don't reimplement that ourselves.
  const startClientX = event.clientX;
  const startClientY = event.clientY;
  const win = getCurrentWindow();
  let started = false;

  const cleanup = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", cleanup);
    window.removeEventListener("blur", cleanup);
  };

  function onMove(e: PointerEvent) {
    if (started) return;
    const dx = e.clientX - startClientX;
    const dy = e.clientY - startClientY;
    if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
    // Real drag, not a click — hand off to the OS and stop listening (the OS
    // move loop captures the pointer; our listeners won't fire again).
    started = true;
    cleanup();
    void win.startDragging().catch(() => {});
  }

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", cleanup);
  window.addEventListener("blur", cleanup);
}

/** Double-clicking the topbar toggles maximize (fills the work area, keeps the taskbar). */
export function toggleMaximizeOnDoubleClick(event: ReactMouseEvent<HTMLElement>) {
  if (event.button !== 0) return;
  void (async () => {
    try {
      const win = getCurrentWindow();
      if (await win.isMaximized()) {
        await win.unmaximize();
      } else {
        await win.maximize();
      }
    } catch {
      // Ignore — the window may be mid-transition.
    }
  })();
}

export function startCustomWindowResize(
  event: ReactPointerEvent<HTMLElement>,
  direction: CustomResizeDirection
) {
  if (event.button !== 0) return;

  stopPointerDefaults(event);

  const target = event.currentTarget;
  const pointerId = event.pointerId;
  const cursorStyle = target.style.cursor;
  const previousCursor = document.body.style.cursor;

  capturePointer(target, pointerId);
  document.body.style.cursor = cursorStyle;

  void (async () => {
    const win = getCurrentWindow();
    let disposed = false;
    let updating = false;
    let queued = false;
    let applyResize: (() => Promise<void>) | undefined;

    const onMove = () => {
      if (applyResize) void applyResize();
    };

    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", cleanup);
      window.removeEventListener("blur", cleanup);
      target.removeEventListener("lostpointercapture", cleanup);
      releasePointer(target, pointerId);
      document.body.style.cursor = previousCursor;
    };

    document.addEventListener("pointerup", cleanup);
    window.addEventListener("blur", cleanup);
    target.addEventListener("lostpointercapture", cleanup);

    try {
      if (await win.isMaximized()) {
        cleanup();
        return;
      }

      const scaleFactor = await win.scaleFactor();
      const startCursor = await cursorPosition();
      const startPosition = await win.outerPosition();
      const startSize = await win.outerSize();
      const minWidth = MIN_LOGICAL_WIDTH * scaleFactor;
      const minHeight = MIN_LOGICAL_HEIGHT * scaleFactor;
      const startRight = startPosition.x + startSize.width;
      const startBottom = startPosition.y + startSize.height;
      const resizesNorth = direction.includes("North");
      const resizesSouth = direction.includes("South");
      const resizesWest = direction.includes("West");
      const resizesEast = direction.includes("East");

      applyResize = async () => {
        if (updating) {
          queued = true;
          return;
        }

        updating = true;
        try {
          do {
            queued = false;
            const cursor = await cursorPosition();
            if (disposed) return;

            const dx = cursor.x - startCursor.x;
            const dy = cursor.y - startCursor.y;
            let x = startPosition.x;
            let y = startPosition.y;
            let width = startSize.width;
            let height = startSize.height;

            if (resizesEast) width = startSize.width + dx;
            if (resizesWest) {
              width = startSize.width - dx;
              x = startPosition.x + dx;
            }
            if (resizesSouth) height = startSize.height + dy;
            if (resizesNorth) {
              height = startSize.height - dy;
              y = startPosition.y + dy;
            }

            if (width < minWidth) {
              width = minWidth;
              if (resizesWest) x = startRight - width;
            }
            if (height < minHeight) {
              height = minHeight;
              if (resizesNorth) y = startBottom - height;
            }

            if (resizesNorth || resizesWest) {
              await win.setPosition(new PhysicalPosition(round(x), round(y)));
              if (disposed) return;
            }
            await win.setSize(new PhysicalSize(round(width), round(height)));
          } while (queued && !disposed);
        } catch {
          cleanup();
        } finally {
          updating = false;
        }
      };

      if (disposed) return;
      document.addEventListener("pointermove", onMove);
    } catch {
      cleanup();
    }
  })();
}
