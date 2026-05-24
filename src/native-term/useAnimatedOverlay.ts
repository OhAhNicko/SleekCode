import { useEffect } from "react";

type Params = {
  overlayRef: React.RefObject<HTMLElement | null>;
  periodMs?: number;
  amplitudePx?: number;
  originX?: number;
  originY?: number;
};

// Phase-0 spike-only: drives an overlay element on a circular path so the
// hole-cut can be visually confirmed to track. Imperative style mutation
// (no React re-render per frame) — pairs with useNativePaneRegion which
// reads getBoundingClientRect each rAF and emits the hole rect.
export function useAnimatedOverlay({
  overlayRef,
  periodMs = 100,
  amplitudePx = 60,
  originX = 80,
  originY = 80,
}: Params): void {
  useEffect(() => {
    const el = overlayRef.current;
    if (!el) return;
    let raf = 0;
    const start = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const t = ((now - start) % periodMs) / periodMs;
      const dx = Math.sin(t * Math.PI * 2) * amplitudePx;
      const dy = Math.cos(t * Math.PI * 2) * amplitudePx;
      el.style.left = `${originX + dx}px`;
      el.style.top = `${originY + dy}px`;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [overlayRef, periodMs, amplitudePx, originX, originY]);
}
