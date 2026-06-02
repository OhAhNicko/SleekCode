import {
  cursorPosition,
  getCurrentWindow,
  PhysicalPosition,
  PhysicalSize,
} from "@tauri-apps/api/window";
import type { PointerEvent as ReactPointerEvent } from "react";

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

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

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

export function startCustomWindowDrag(event: ReactPointerEvent<HTMLElement>) {
  if (event.button !== 0) return;

  stopPointerDefaults(event);

  const target = event.currentTarget;
  const pointerId = event.pointerId;
  const clickedXRatio = window.innerWidth > 0 ? event.clientX / window.innerWidth : 0.5;
  const clickedY = event.clientY;
  const previousCursor = document.body.style.cursor;

  capturePointer(target, pointerId);
  document.body.style.cursor = "grabbing";

  void (async () => {
    const win = getCurrentWindow();
    let disposed = false;
    let updating = false;
    let queued = false;
    let offsetX = 0;
    let offsetY = 0;

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

    const applyMove = async () => {
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
          await win.setPosition(
            new PhysicalPosition(round(cursor.x - offsetX), round(cursor.y - offsetY))
          );
        } while (queued && !disposed);
      } catch {
        cleanup();
      } finally {
        updating = false;
      }
    };

    function onMove() {
      void applyMove();
    }

    document.addEventListener("pointerup", cleanup);
    window.addEventListener("blur", cleanup);
    target.addEventListener("lostpointercapture", cleanup);

    try {
      const cursor = await cursorPosition();

      if (await win.isMaximized()) {
        await win.unmaximize();
        await nextFrame();
        await nextFrame();

        const restoredSize = await win.outerSize();
        const restoredScaleFactor = await win.scaleFactor();
        const safeInset = 24 * restoredScaleFactor;
        offsetX = clamp(
          restoredSize.width * clickedXRatio,
          Math.min(safeInset, restoredSize.width / 2),
          Math.max(restoredSize.width - safeInset, restoredSize.width / 2)
        );
        offsetY = clamp(clickedY * restoredScaleFactor, 0, restoredSize.height);

        const restoredCursor = await cursorPosition();
        await win.setPosition(
          new PhysicalPosition(round(restoredCursor.x - offsetX), round(restoredCursor.y - offsetY))
        );
      } else {
        const position = await win.outerPosition();
        offsetX = cursor.x - position.x;
        offsetY = cursor.y - position.y;
      }

      if (disposed) return;
      document.addEventListener("pointermove", onMove);
    } catch {
      cleanup();
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
