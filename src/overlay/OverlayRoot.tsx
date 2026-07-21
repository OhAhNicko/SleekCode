import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { listenOverlayPopup, type OverlayPopupMsg } from "../lib/overlay-bridge";

type PopupRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  radius?: number;
};

/**
 * The overlay webview's popup host.
 *
 * It listens for `overlay:popup` events from the main webview (open/close +
 * anchor rect + payload), renders each open popup above the native panes, and
 * publishes the union of the rendered popups' OWN rects to the Win32
 * click-through region — so popups are visible + hit-testable and everywhere
 * else the overlay is click-through to the panes below.
 */
export function OverlayRoot() {
  const [popups, setPopups] = useState<Map<string, OverlayPopupMsg>>(
    () => new Map(),
  );
  // Live DOM element of each rendered popup, for measuring its real rect.
  const els = useRef<Map<string, HTMLElement>>(new Map());

  useEffect(() => {
    let un: UnlistenFn | undefined;
    let disposed = false;
    listenOverlayPopup((msg) => {
      setPopups((prev) => {
        const next = new Map(prev);
        if (msg.open && msg.rect) next.set(msg.id, msg);
        else next.delete(msg.id);
        return next;
      });
    }).then((u) => {
      if (disposed) u();
      else un = u;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  const publishRegion = useCallback(() => {
    const rects: PopupRect[] = [];
    for (const el of els.current.values()) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
      rects.push({
        x: r.left,
        y: r.top,
        width: r.width,
        height: r.height,
        radius,
      });
    }
    invoke("overlay_set_region", { rects }).catch((e) =>
      console.error("[overlay] overlay_set_region failed", e),
    );
  }, []);

  // Re-clip whenever the open popups (or their anchor rects → new msgs) change.
  useLayoutEffect(() => {
    publishRegion();
  }, [popups, publishRegion]);

  const registerEl = useCallback((id: string, el: HTMLElement | null) => {
    if (el) els.current.set(id, el);
    else els.current.delete(id);
  }, []);

  return (
    <>
      {Array.from(popups.values()).map((msg) => (
        <OverlayPopup key={msg.id} msg={msg} registerEl={registerEl} />
      ))}
    </>
  );
}

function OverlayPopup({
  msg,
  registerEl,
}: {
  msg: OverlayPopupMsg;
  registerEl: (id: string, el: HTMLElement | null) => void;
}) {
  const ref = useCallback(
    (el: HTMLElement | null) => registerEl(msg.id, el),
    [registerEl, msg.id],
  );

  switch (msg.kind) {
    case "exit-banner":
      return <ExitBanner rect={msg.rect!} innerRef={ref} />;
    default:
      return null;
  }
}

/**
 * "[Process exited]" pill, at bottom-center of the pane rect (matches the old
 * in-pane banner: left:50%, bottom:12). Display-only. rect is main-client-local
 * == overlay-local logical px. Theme CSS vars don't exist in the overlay
 * document, so colors are inlined.
 */
function ExitBanner({
  rect,
  innerRef,
}: {
  rect: NonNullable<OverlayPopupMsg["rect"]>;
  innerRef: (el: HTMLElement | null) => void;
}) {
  const style: CSSProperties = {
    position: "fixed",
    left: rect.x + rect.width / 2,
    top: rect.y + rect.height - 12,
    transform: "translate(-50%, -100%)",
    pointerEvents: "none",
    padding: "3px 10px",
    borderRadius: 4,
    background: "#1c2128",
    boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.12)",
    color: "rgba(230,237,243,0.65)",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 12,
    lineHeight: 1.4,
    letterSpacing: 0.2,
    userSelect: "none",
    whiteSpace: "nowrap",
  };
  return (
    <div ref={innerRef} style={style}>
      [Process exited]
    </div>
  );
}
