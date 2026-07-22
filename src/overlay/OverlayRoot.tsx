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
import {
  emitOverlayAction,
  listenOverlayPopup,
  type OverlayPopupMsg,
} from "../lib/overlay-bridge";
import {
  CTX_ICONS,
  CTX_MENU_WIDTH,
  type CtxMenuSection,
} from "../lib/context-menu-model";

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
 * Listens for `overlay:popup` from the main webview, renders each open popup
 * above the native panes, and clips the Win32 region so popups are visible +
 * hit-testable while everything else stays click-through to the panes.
 *
 * Two region modes:
 *  - **backdrop popups** (context menus / dropdowns that dismiss on outside
 *    click) → the region is the WHOLE overlay so an outside click can be caught.
 *    Because there's no TIGHT clip in this mode, webview transparency is intact,
 *    so these popups CAN carry a real drop shadow.
 *  - **ambient popups** (toasts / banners / tooltips) → the region is the union
 *    of the popups' own rects (flat, since a 1-bit clip can't do soft shadows).
 */
export function OverlayRoot() {
  const [popups, setPopups] = useState<Map<string, OverlayPopupMsg>>(
    () => new Map(),
  );
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

  // Re-clip whenever the open popups (or their anchor rects → new msgs) change.
  useLayoutEffect(() => {
    const needsBackdrop = Array.from(popups.values()).some(
      (m) => m.kind === "context-menu",
    );
    let rects: PopupRect[];
    if (needsBackdrop) {
      rects = [
        { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
      ];
    } else {
      rects = [];
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
    }
    invoke("overlay_set_region", { rects }).catch((e) =>
      console.error("[overlay] overlay_set_region failed", e),
    );
  }, [popups]);

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
  switch (msg.kind) {
    case "exit-banner":
      return <ExitBanner msg={msg} registerEl={registerEl} />;
    case "context-menu":
      return <ContextMenu msg={msg} registerEl={registerEl} />;
    default:
      return null;
  }
}

/**
 * "[Process exited]" pill at bottom-center of the pane rect. Display-only.
 * Flat (ambient popup → tight 1-bit clip, no soft shadow). Theme vars don't
 * exist in the overlay document, so colors are inlined.
 */
function ExitBanner({
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
  const rect = msg.rect!;
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
    <div ref={ref} style={style}>
      [Process exited]
    </div>
  );
}

/**
 * Global right-click context menu. Backdrop popup → full-overlay region while
 * open (an outside click dismisses it), so transparency is intact and it gets a
 * real drop shadow. Item click / dismiss round-trips to the main webview via
 * `overlay:action`; the main webview owns the action closures.
 */
function ContextMenu({
  msg,
  registerEl,
}: {
  msg: OverlayPopupMsg;
  registerEl: (id: string, el: HTMLElement | null) => void;
}) {
  const sections =
    (msg.payload as { sections?: CtxMenuSection[] } | undefined)?.sections ?? [];
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuH, setMenuH] = useState(0);

  useLayoutEffect(() => {
    if (menuRef.current) setMenuH(menuRef.current.offsetHeight);
  }, [msg]);

  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      menuRef.current = el;
      registerEl(msg.id, el);
    },
    [registerEl, msg.id],
  );

  const dismiss = () => emitOverlayAction({ id: msg.id, action: "__dismiss__" });

  const ax = msg.rect?.x ?? 0;
  const ay = msg.rect?.y ?? 0;
  const clampedX = Math.min(ax, window.innerWidth - CTX_MENU_WIDTH - 8);
  let clampedY = ay;
  if (menuH > 0 && ay + menuH > window.innerHeight - 8) {
    clampedY = Math.max(8, ay - menuH);
  }
  clampedY = Math.max(8, clampedY);

  return (
    <div
      style={{ position: "fixed", inset: 0, pointerEvents: "auto" }}
      onClick={dismiss}
      onContextMenu={(e) => {
        e.preventDefault();
        dismiss();
      }}
    >
      <div
        ref={setRef}
        style={{
          position: "absolute",
          top: clampedY,
          left: clampedX,
          minWidth: CTX_MENU_WIDTH,
          padding: "4px 0",
          borderRadius: 8,
          background: "#1c2128",
          border: "1px solid rgba(255,255,255,0.08)",
          boxShadow: "0 10px 30px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.35)",
          color: "#e6edf3",
          fontFamily: "Inter, system-ui, sans-serif",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {sections.map((section, si) => (
          <div key={si}>
            {si > 0 && (
              <div
                style={{
                  height: 1,
                  background: "rgba(255,255,255,0.06)",
                  margin: "4px 0",
                }}
              />
            )}
            {section.items.map((item) => (
              <div
                key={item.actionId}
                onClick={() =>
                  emitOverlayAction({ id: msg.id, action: item.actionId })
                }
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 12px",
                  fontSize: 12,
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(255,255,255,0.06)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
              >
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    color: "rgba(230,237,243,0.6)",
                    flexShrink: 0,
                  }}
                >
                  {CTX_ICONS[item.iconId]}
                </span>
                <span style={{ flex: 1 }}>{item.label}</span>
                <span
                  style={{
                    color: "rgba(230,237,243,0.45)",
                    fontSize: 11,
                    flexShrink: 0,
                  }}
                >
                  {item.shortcut}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
