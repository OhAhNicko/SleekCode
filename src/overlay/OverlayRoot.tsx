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
  emitOverlayReady,
  listenOverlayPopup,
  listenOverlayTheme,
  type OverlayPopupMsg,
} from "../lib/overlay-bridge";
import {
  CTX_ICONS,
  CTX_MENU_WIDTH,
  type CtxMenuSection,
} from "../lib/context-menu-model";
import type { OverlayToastPayload } from "../lib/useOverlayToast";

type PopupRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  radius?: number;
};

/**
 * Popup kinds that dismiss on outside click. While one is open the region is
 * the WHOLE overlay (so the outside click can be caught) — and because there
 * is no tight clip in that mode, webview transparency is intact and these
 * popups CAN carry a real drop shadow. Everything else is an ambient popup
 * (tight 1-bit clip → flat, crisp corners, no soft shadow).
 */
const BACKDROP_KINDS = new Set(["context-menu"]);

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

  // Theme: adopt the main webview's --ezy-* vars so popup renderers use the
  // same tokens as the app. The listener is registered BEFORE `overlay:ready`
  // is announced so the theme re-emit it triggers is never missed.
  useEffect(() => {
    let un: UnlistenFn | undefined;
    let disposed = false;
    listenOverlayTheme((vars) => {
      const root = document.documentElement;
      for (const [name, value] of Object.entries(vars)) {
        root.style.setProperty(name, value);
      }
    }).then((u) => {
      if (disposed) {
        u();
        return;
      }
      un = u;
      emitOverlayReady();
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  // Re-clip whenever the open popups (or their anchor rects → new msgs) change.
  useLayoutEffect(() => {
    const needsBackdrop = Array.from(popups.values()).some((m) =>
      BACKDROP_KINDS.has(m.kind),
    );
    // Backdrop mode passes NO region at all (SetWindowRgn NULL): the window
    // stays DWM-composed (a region forces the classic-NC fallback renderer —
    // the "Tauri App" caption bug) and every pixel is hit-testable, which a
    // dismiss-on-outside-click popup needs anyway.
    const rects: PopupRect[] = [];
    if (!needsBackdrop) {
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
    invoke("overlay_set_region", { rects, backdrop: needsBackdrop }).catch((e) =>
      console.error("[overlay] overlay_set_region failed", e),
    );
  }, [popups]);

  const registerEl = useCallback((id: string, el: HTMLElement | null) => {
    if (el) els.current.set(id, el);
    else els.current.delete(id);
  }, []);

  // Optimistic local close for backdrop popups. Dismissal must restore the
  // click-through region SYNCHRONOUSLY (same React commit → useLayoutEffect →
  // overlay_set_region), not after the overlay→main→overlay round-trip —
  // otherwise the user's next click still lands on a click-dead overlay (the
  // "dragging the topbar needs 2-3 clicks" bug). Main is still notified via
  // overlay:action; its open:false echo is a no-op by the time it arrives.
  const closeLocal = useCallback((id: string) => {
    setPopups((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  return (
    <>
      {Array.from(popups.values()).map((msg) => (
        <OverlayPopup
          key={msg.id}
          msg={msg}
          registerEl={registerEl}
          closeLocal={closeLocal}
        />
      ))}
    </>
  );
}

function OverlayPopup({
  msg,
  registerEl,
  closeLocal,
}: {
  msg: OverlayPopupMsg;
  registerEl: (id: string, el: HTMLElement | null) => void;
  closeLocal: (id: string) => void;
}) {
  switch (msg.kind) {
    case "exit-banner":
      return <ExitBanner msg={msg} registerEl={registerEl} />;
    case "context-menu":
      return (
        <ContextMenu msg={msg} registerEl={registerEl} closeLocal={closeLocal} />
      );
    case "toast":
      return <Toast msg={msg} registerEl={registerEl} />;
    default:
      return null;
  }
}

/**
 * "[Process exited]" pill at bottom-center of the pane rect. Display-only.
 * Flat (ambient popup → tight 1-bit clip, no soft shadow). Theme vars arrive
 * over the `overlay:theme` bridge; the fallbacks match the default theme so
 * the popup still renders sanely if a var is missing.
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
    background: "var(--ezy-surface-raised, #1c2128)",
    boxShadow: "inset 0 0 0 1px var(--ezy-border, rgba(255,255,255,0.12))",
    color: "var(--ezy-text-muted, rgba(230,237,243,0.65))",
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
  closeLocal,
}: {
  msg: OverlayPopupMsg;
  registerEl: (id: string, el: HTMLElement | null) => void;
  closeLocal: (id: string) => void;
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

  // Close locally first (region restored this frame), then tell main.
  const dismiss = () => {
    closeLocal(msg.id);
    emitOverlayAction({ id: msg.id, action: "__dismiss__" });
  };
  const runItem = (actionId: string) => {
    closeLocal(msg.id);
    emitOverlayAction({ id: msg.id, action: actionId });
  };

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
      // Dismiss on pointer-DOWN (native menu semantics): a press-and-drag on
      // the topbar closes the menu on the press instead of dangling until the
      // release, and the synchronous local close means the NEXT press already
      // reaches the app. A right-click press falls through here too, so the
      // follow-up contextmenu (fired on release, now over the app) reopens
      // the menu at the new spot — reposition works in one gesture.
      onPointerDown={dismiss}
      onContextMenu={(e) => {
        e.preventDefault();
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
          background: "var(--ezy-surface-raised, #1c2128)",
          border: "1px solid var(--ezy-border, rgba(255,255,255,0.08))",
          boxShadow: "0 10px 30px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.35)",
          color: "var(--ezy-text, #e6edf3)",
          fontFamily: "Inter, system-ui, sans-serif",
        }}
        // Keep presses inside the menu from reaching the backdrop's
        // pointer-down dismiss — items activate on click (release).
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {sections.map((section, si) => (
          <div key={si}>
            {si > 0 && (
              <div
                style={{
                  height: 1,
                  background: "var(--ezy-border-subtle, rgba(255,255,255,0.06))",
                  margin: "4px 0",
                }}
              />
            )}
            {section.items.map((item) => (
              <div
                key={item.actionId}
                onClick={() => runItem(item.actionId)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 12px",
                  fontSize: 12,
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background =
                    "var(--ezy-surface, rgba(255,255,255,0.06))";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
              >
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    color: "var(--ezy-text-muted, rgba(230,237,243,0.6))",
                    flexShrink: 0,
                  }}
                >
                  {CTX_ICONS[item.iconId]}
                </span>
                <span style={{ flex: 1 }}>{item.label}</span>
                <span
                  style={{
                    color: "var(--ezy-text-muted, rgba(230,237,243,0.45))",
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

/**
 * Generic floating toast (undo-close / undo-clear / image-insert-undo /
 * upload-error / dev-server-restore). Ambient popup → tight 1-bit clip: flat,
 * no drop shadow (it would be cropped by the region anyway), border drawn as
 * an inset ring so the clip edge stays crisp. Viewport-anchored — positions
 * itself from `payload.placement`, ignores the msg rect. Button/dismiss round-
 * trip to the main webview via overlay:action; keyboard shortcuts stay there.
 */
function Toast({
  msg,
  registerEl,
}: {
  msg: OverlayPopupMsg;
  registerEl: (id: string, el: HTMLElement | null) => void;
}) {
  const p = (msg.payload ?? {}) as OverlayToastPayload;
  const ref = useCallback(
    (el: HTMLElement | null) => registerEl(msg.id, el),
    [registerEl, msg.id],
  );
  const act = (action: string) => emitOverlayAction({ id: msg.id, action });

  const placement: CSSProperties =
    p.placement === "bottom-right"
      ? { position: "fixed", bottom: 16, right: 16 }
      : {
          position: "fixed",
          bottom: 16,
          left: "50%",
          transform: "translateX(-50%)",
        };

  if (p.variant === "solid") {
    return (
      <div
        ref={ref}
        style={{
          ...placement,
          display: "flex",
          flexDirection: "column",
          gap: 4,
          padding: "10px 14px",
          borderRadius: 6,
          background: p.bg ?? "#404040",
          color: "#ffffff",
          maxWidth: 420,
          fontFamily: "Inter, system-ui, sans-serif",
          pointerEvents: "auto",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: "-0.01em" }}>
            {p.title}
          </span>
          {p.dismissable && (
            <svg
              onClick={() => act("dismiss")}
              role="button"
              aria-label="Dismiss"
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="currentColor"
              style={{ cursor: "pointer", opacity: 0.8, flexShrink: 0 }}
            >
              <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
            </svg>
          )}
        </div>
        {p.detail && (
          <span
            style={{
              fontSize: 11,
              opacity: 0.95,
              lineHeight: 1.45,
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {p.detail}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      style={{
        ...placement,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 12px",
        borderRadius: 8,
        background: "var(--ezy-surface-raised, #1c2128)",
        boxShadow: "inset 0 0 0 1px var(--ezy-border, rgba(255,255,255,0.12))",
        fontFamily: "Inter, system-ui, sans-serif",
        pointerEvents: "auto",
      }}
    >
      <span
        style={{
          fontSize: 12,
          color: "var(--ezy-text-secondary, rgba(230,237,243,0.8))",
          maxWidth: 260,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={p.detail ?? undefined}
      >
        {p.title}
      </span>
      {p.button && (
        <button
          onClick={() => act(p.button!.action)}
          style={{
            fontSize: 12,
            fontWeight: 500,
            padding: "4px 10px",
            borderRadius: 4,
            background: "var(--ezy-accent, #10a37f)",
            color: "#fff",
            border: "none",
            cursor: "pointer",
            flexShrink: 0,
            whiteSpace: "nowrap",
            fontFamily: "inherit",
          }}
        >
          {p.button.label}
        </button>
      )}
      {p.shortcutHint && (
        <span
          style={{
            fontSize: 10,
            color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
            flexShrink: 0,
          }}
        >
          {p.shortcutHint}
        </span>
      )}
    </div>
  );
}
