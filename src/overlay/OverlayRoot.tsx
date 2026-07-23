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
  emitOverlayFocus,
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
import type { OverlayMenuPayload } from "../lib/overlay-menu-model";
import { validateBranchName } from "../lib/git-branch-validate";

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
const BACKDROP_KINDS = new Set([
  "context-menu",
  "anchored-menu",
  "swatch-menu",
  "recent-menu",
  "git-branch-menu",
  "session-picker",
]);

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

  // Stamp of the last message per popup id — feeds the ghost sweep below.
  const lastSeen = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    let un: UnlistenFn | undefined;
    let disposed = false;
    listenOverlayPopup((msg) => {
      if (msg.open && msg.rect) lastSeen.current.set(msg.id, Date.now());
      else lastSeen.current.delete(msg.id);
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

  // GHOST SWEEP: the popup bus is fire-and-forget — if a close event is ever
  // lost (focus-handoff churn, webview reload), a popup would linger here
  // forever with no owner listening for its actions (observed on hardware:
  // an unclosable stale search bar). Every main-side popup hook re-emits a
  // keepalive at ~750ms while open, so anything not refreshed within 2.5s
  // has no living owner and is dropped.
  useEffect(() => {
    const iv = setInterval(() => {
      const cutoff = Date.now() - 2500;
      const stale: string[] = [];
      for (const [id, ts] of lastSeen.current) {
        if (ts < cutoff) stale.push(id);
      }
      if (stale.length === 0) return;
      for (const id of stale) lastSeen.current.delete(id);
      setPopups((prev) => {
        const next = new Map(prev);
        for (const id of stale) next.delete(id);
        return next;
      });
    }, 1000);
    return () => clearInterval(iv);
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
    if (import.meta.env.DEV) {
      // Debug seam readable from OUTSIDE (GetWindowTextW): expose the live
      // popup ids + region mode in the window title. DEV only.
      document.title = `OV[${needsBackdrop ? "B" : "A"}] ${Array.from(
        popups.keys(),
      ).join(",")}`;
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
    case "file-link-tooltip":
      return <FileLinkTip msg={msg} registerEl={registerEl} />;
    case "ime-composition":
      return <ImeComposition msg={msg} registerEl={registerEl} />;
    case "jump-btn":
      return <JumpButton msg={msg} registerEl={registerEl} />;
    case "clipboard-image-preview":
      return <ClipboardPreview msg={msg} registerEl={registerEl} />;
    case "anchored-menu":
      return (
        <AnchoredMenu msg={msg} registerEl={registerEl} closeLocal={closeLocal} />
      );
    case "voice-hud":
      return <VoiceHudCard msg={msg} registerEl={registerEl} />;
    case "pane-search":
      return <PaneSearch msg={msg} registerEl={registerEl} />;
    case "git-branch-menu":
      return (
        <GitBranchMenu msg={msg} registerEl={registerEl} closeLocal={closeLocal} />
      );
    case "session-picker":
      return (
        <SessionPickerMenu
          msg={msg}
          registerEl={registerEl}
          closeLocal={closeLocal}
        />
      );
    case "tooltip":
      return <Tooltip msg={msg} registerEl={registerEl} />;
    case "swatch-menu":
      return (
        <SwatchMenu msg={msg} registerEl={registerEl} closeLocal={closeLocal} />
      );
    case "recent-menu":
      return (
        <RecentMenu msg={msg} registerEl={registerEl} closeLocal={closeLocal} />
      );
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

/**
 * Hovered file-path tooltip (native pane). Display-only; positioned at a
 * pane-LOCAL offset computed by the main webview (payload.top/left) plus the
 * live pane rect. Being in the region makes its pixels visible but also
 * click-dead — acceptable for a hover tooltip. Colors are the component's
 * original untthemed values.
 */
function FileLinkTip({
  msg,
  registerEl,
}: {
  msg: OverlayPopupMsg;
  registerEl: (id: string, el: HTMLElement | null) => void;
}) {
  const p = (msg.payload ?? {}) as {
    top?: number;
    left?: number;
    above?: boolean;
  };
  const ref = useCallback(
    (el: HTMLElement | null) => registerEl(msg.id, el),
    [registerEl, msg.id],
  );
  const rect = msg.rect!;
  return (
    <div
      ref={ref}
      aria-hidden
      style={{
        position: "fixed",
        top: rect.y + (p.top ?? 0),
        left: rect.x + (p.left ?? 0),
        // `above`: p.top is the hovered line's top — anchor the tooltip's
        // BOTTOM there so it sits above the line, clear of the cursor.
        transform: p.above ? "translateY(-100%)" : undefined,
        pointerEvents: "none",
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 10px",
        background: "var(--ezy-surface-raised, #1c2128)",
        boxShadow: "inset 0 0 0 1px var(--ezy-border, rgba(255,255,255,0.12))",
        borderRadius: 6,
        whiteSpace: "nowrap",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <span
        style={{
          fontSize: 12,
          color: "var(--ezy-text-secondary, rgba(230,237,243,0.8))",
        }}
      >
        Open in MADE
      </span>
      <span
        style={{
          fontSize: 11,
          padding: "1px 5px",
          background: "var(--ezy-surface, #161b22)",
          boxShadow: "inset 0 0 0 1px var(--ezy-border, rgba(255,255,255,0.12))",
          borderRadius: 3,
          color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
        }}
      >
        Ctrl+Click
      </span>
    </div>
  );
}

/**
 * IME pre-edit popup (native pane). Display-only; pane-local caret offset from
 * the main webview + live pane rect. Caret split rendered as a 1px bar.
 */
function ImeComposition({
  msg,
  registerEl,
}: {
  msg: OverlayPopupMsg;
  registerEl: (id: string, el: HTMLElement | null) => void;
}) {
  const p = (msg.payload ?? {}) as {
    top?: number;
    left?: number;
    before?: string;
    after?: string;
  };
  const ref = useCallback(
    (el: HTMLElement | null) => registerEl(msg.id, el),
    [registerEl, msg.id],
  );
  const rect = msg.rect!;
  return (
    <div
      ref={ref}
      aria-hidden
      style={{
        position: "fixed",
        top: rect.y + (p.top ?? 0),
        left: rect.x + (p.left ?? 0),
        pointerEvents: "none",
        padding: "4px 8px",
        background: "rgb(20,20,24)",
        color: "#ffffff",
        border: "1px solid rgba(255,255,255,0.15)",
        borderRadius: 4,
        fontSize: 14,
        lineHeight: 1.2,
        whiteSpace: "nowrap",
        maxWidth: Math.max(80, rect.width - 32),
        overflow: "hidden",
        textOverflow: "ellipsis",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <span>{p.before ?? ""}</span>
      <span
        style={{
          display: "inline-block",
          width: 1,
          height: "1em",
          background: "#ffffff",
          verticalAlign: "text-bottom",
          margin: "0 1px",
        }}
      />
      <span>{p.after ?? ""}</span>
    </div>
  );
}

/**
 * Jump-to-bottom button (native pane, bottom-right). Interactive ambient
 * popup: click bounces "jump" to the main webview, which scrolls the pane.
 */
function JumpButton({
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
  return (
    <div
      ref={ref}
      title="Jump to bottom"
      onClick={() => emitOverlayAction({ id: msg.id, action: "jump" })}
      onMouseEnter={(e) => {
        e.currentTarget.style.opacity = "1";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.opacity = "0.85";
      }}
      style={{
        position: "fixed",
        left: rect.x + rect.width - 12 - 22,
        top: rect.y + rect.height - 12 - 22,
        width: 22,
        height: 22,
        borderRadius: 4,
        background: "var(--ezy-surface-raised, #1c2128)",
        boxShadow: "inset 0 0 0 1px var(--ezy-border, rgba(255,255,255,0.12))",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        opacity: 0.85,
        transition: "opacity 120ms ease",
        pointerEvents: "auto",
      }}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        stroke="var(--ezy-text-muted, rgba(230,237,243,0.6))"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="2,3 6,7 10,3" />
        <line x1="3" y1="9.5" x2="9" y2="9.5" />
      </svg>
    </div>
  );
}

/**
 * "Image pasted" preview card (native pane, bottom-right). Thumbnail is a
 * data: URI so it crosses the event bus. X bounces "dismiss" back to main.
 */
function ClipboardPreview({
  msg,
  registerEl,
}: {
  msg: OverlayPopupMsg;
  registerEl: (id: string, el: HTMLElement | null) => void;
}) {
  const p = (msg.payload ?? {}) as { thumbnailUrl?: string; filePath?: string };
  const ref = useCallback(
    (el: HTMLElement | null) => registerEl(msg.id, el),
    [registerEl, msg.id],
  );
  const rect = msg.rect!;
  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        // Anchor the card's bottom-right corner 12px inside the pane's
        // bottom-right corner (intrinsic width → translate(-100%,-100%)).
        left: rect.x + rect.width - 12,
        top: rect.y + rect.height - 12,
        transform: "translate(-100%, -100%)",
        display: "flex",
        alignItems: "center",
        gap: 10,
        borderRadius: 8,
        padding: "8px 12px",
        background: "var(--ezy-surface-raised, #1c2128)",
        boxShadow: "inset 0 0 0 1px var(--ezy-border, rgba(255,255,255,0.12))",
        maxWidth: 320,
        fontFamily: "Inter, system-ui, sans-serif",
        pointerEvents: "auto",
      }}
    >
      {p.thumbnailUrl && (
        <img
          src={p.thumbnailUrl}
          alt="Pasted image"
          style={{
            width: 48,
            height: 48,
            objectFit: "cover",
            borderRadius: 4,
            flexShrink: 0,
          }}
        />
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: "var(--ezy-text, #e6edf3)",
          }}
        >
          Image pasted
        </div>
        <div
          title={p.filePath}
          style={{
            fontSize: 11,
            marginTop: 2,
            color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {p.filePath ?? ""}
        </div>
      </div>
      <svg
        role="button"
        aria-label="Dismiss"
        onClick={() => emitOverlayAction({ id: msg.id, action: "dismiss" })}
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        style={{
          cursor: "pointer",
          color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
          flexShrink: 0,
        }}
      >
        <path
          d="M2.5 2.5L9.5 9.5M9.5 2.5L2.5 9.5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}

/**
 * Generic anchored dropdown menu (kind "anchored-menu") — tabbar menus, header
 * pickers, git dropdown, tool selector, etc. Backdrop popup: full-overlay
 * hit-test while open (outside press dismisses, transparency intact => real
 * shadow). The menu positions itself against the streamed anchor rect using
 * payload.placement, clamped to the viewport. Items bounce their actionId to
 * the main webview, which owns the closures.
 */
function AnchoredMenu({
  msg,
  registerEl,
  closeLocal,
}: {
  msg: OverlayPopupMsg;
  registerEl: (id: string, el: HTMLElement | null) => void;
  closeLocal: (id: string) => void;
}) {
  const p = (msg.payload ?? {}) as Partial<OverlayMenuPayload>;
  const sections = p.sections ?? [];
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuSize, setMenuSize] = useState<{ w: number; h: number }>({
    w: 0,
    h: 0,
  });

  useLayoutEffect(() => {
    if (menuRef.current) {
      setMenuSize({
        w: menuRef.current.offsetWidth,
        h: menuRef.current.offsetHeight,
      });
    }
  }, [msg]);

  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      menuRef.current = el;
      registerEl(msg.id, el);
    },
    [registerEl, msg.id],
  );

  const dismiss = () => {
    closeLocal(msg.id);
    emitOverlayAction({ id: msg.id, action: "__dismiss__" });
  };
  // Modifier state rides along (Chromium fills MouseEvent modifiers from the
  // OS message even though this NOACTIVATE window never has keyboard focus) —
  // the URL popover uses ctrl-click for open-in-external-browser.
  const runItem = (actionId: string, e?: { ctrlKey: boolean; metaKey: boolean }) => {
    closeLocal(msg.id);
    emitOverlayAction({
      id: msg.id,
      action: actionId,
      data: { ctrl: !!e && (e.ctrlKey || e.metaKey) },
    });
  };

  const anchor = msg.rect!;
  const gap = p.gap ?? 4;
  const placement = p.placement ?? "below-start";
  let top: number;
  if (placement.startsWith("below")) {
    top = anchor.y + anchor.height + gap;
    if (menuSize.h > 0 && top + menuSize.h > window.innerHeight - 8) {
      top = Math.max(8, anchor.y - gap - menuSize.h);
    }
  } else {
    top = anchor.y - gap - menuSize.h;
    if (top < 8) top = Math.min(anchor.y + anchor.height + gap, window.innerHeight - 8 - menuSize.h);
  }
  let left: number;
  if (placement.endsWith("start")) {
    left = anchor.x;
  } else {
    left = anchor.x + anchor.width - menuSize.w;
  }
  left = Math.max(8, Math.min(left, window.innerWidth - menuSize.w - 8));
  top = Math.max(8, top);

  return (
    <div
      style={{ position: "fixed", inset: 0, pointerEvents: "auto" }}
      onPointerDown={dismiss}
      onContextMenu={(e) => {
        e.preventDefault();
      }}
    >
      <div
        ref={setRef}
        style={{
          position: "absolute",
          top,
          left,
          // Until measured, render invisibly at the anchor so the first
          // frame doesn't flash the menu in a wrong corner.
          visibility: menuSize.h === 0 ? "hidden" : "visible",
          width: p.width,
          minWidth: p.width ? undefined : 200,
          maxHeight: p.maxHeight,
          overflowY: p.maxHeight ? "auto" : undefined,
          padding: "4px 0",
          borderRadius: 8,
          background: "var(--ezy-surface-raised, #1c2128)",
          border: "1px solid var(--ezy-border, rgba(255,255,255,0.08))",
          boxShadow: "0 10px 30px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.35)",
          color: "var(--ezy-text, #e6edf3)",
          fontFamily: "Inter, system-ui, sans-serif",
        }}
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
            {section.title && (
              <div
                style={{
                  padding: "4px 12px 2px",
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: 0.4,
                  textTransform: "uppercase",
                  color: "var(--ezy-text-muted, rgba(230,237,243,0.45))",
                  userSelect: "none",
                }}
              >
                {section.title}
              </div>
            )}
            {section.items.map((item) => (
              <div
                key={item.actionId}
                onClick={
                  item.disabled ? undefined : (e) => runItem(item.actionId, e)
                }
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 12px",
                  fontSize: 12,
                  cursor: item.disabled ? "default" : "pointer",
                  opacity: item.disabled ? 0.4 : 1,
                  color: item.danger
                    ? "var(--ezy-red, #f85149)"
                    : "var(--ezy-text, #e6edf3)",
                }}
                onMouseEnter={(e) => {
                  if (!item.disabled)
                    e.currentTarget.style.background =
                      "var(--ezy-surface, rgba(255,255,255,0.06))";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
              >
                {item.swatch && (
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 3,
                      background: item.swatch,
                      flexShrink: 0,
                    }}
                  />
                )}
                {item.iconId && CTX_ICONS[item.iconId] && (
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
                )}
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span
                    style={{
                      display: "block",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {item.label}
                  </span>
                  {item.sublabel && (
                    <span
                      style={{
                        display: "block",
                        fontSize: 10,
                        marginTop: 1,
                        color: "var(--ezy-text-muted, rgba(230,237,243,0.45))",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {item.sublabel}
                    </span>
                  )}
                </span>
                {item.checked && (
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    style={{
                      color: "var(--ezy-accent, #10a37f)",
                      flexShrink: 0,
                    }}
                  >
                    <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
                  </svg>
                )}
                {item.shortcut && (
                  <span
                    style={{
                      color: "var(--ezy-text-muted, rgba(230,237,243,0.45))",
                      fontSize: 11,
                      flexShrink: 0,
                    }}
                  >
                    {item.shortcut}
                  </span>
                )}
                {item.badge && (
                  <span
                    style={{
                      background: "var(--ezy-red, #f85149)",
                      color: "#fff",
                      fontSize: 9,
                      fontWeight: 700,
                      letterSpacing: 0.4,
                      padding: "1px 5px",
                      borderRadius: 3,
                      flexShrink: 0,
                    }}
                  >
                    {item.badge}
                  </span>
                )}
                {item.trailing && (
                  <span
                    title={item.trailing.title}
                    onClick={(e) => {
                      e.stopPropagation();
                      runItem(item.trailing!.actionId, e);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 24,
                      height: 24,
                      borderRadius: 4,
                      color: "var(--ezy-text-muted, rgba(230,237,243,0.6))",
                      flexShrink: 0,
                      cursor: "pointer",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background =
                        "var(--ezy-surface-raised, rgba(255,255,255,0.1))";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "transparent";
                    }}
                  >
                    {CTX_ICONS[item.trailing.iconId]}
                  </span>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Voice agent HUD (kind "voice-hud") — bottom-left status card, interactive
 * ambient popup (tight clip: flat, inset-ring border). All voice state lives
 * in the main webview; buttons bounce clarify-cancel / confirm-run /
 * confirm-cancel back over overlay:action.
 */
function VoiceHudCard({
  msg,
  registerEl,
}: {
  msg: OverlayPopupMsg;
  registerEl: (id: string, el: HTMLElement | null) => void;
}) {
  const p = (msg.payload ?? {}) as {
    state?: string;
    title?: string;
    transcript?: string;
    tool?: string;
    error?: string;
    clarifyQuestion?: string;
    confirmSummary?: string;
  };
  const ref = useCallback(
    (el: HTMLElement | null) => registerEl(msg.id, el),
    [registerEl, msg.id],
  );
  const act = (action: string) => emitOverlayAction({ id: msg.id, action });
  const isError = p.state === "error";
  const active = p.state !== "idle" && !isError;

  const smallBtn: CSSProperties = {
    fontSize: 11,
    color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
    background: "transparent",
    boxShadow: "inset 0 0 0 1px var(--ezy-border, rgba(255,255,255,0.15))",
    border: "none",
    borderRadius: 4,
    padding: "4px 10px",
    cursor: "pointer",
    fontFamily: "inherit",
  };

  return (
    <div
      ref={ref}
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        bottom: 16,
        left: 16,
        minWidth: 240,
        maxWidth: 360,
        background: "var(--ezy-surface-raised, #1c2128)",
        boxShadow: `inset 0 0 0 1px ${
          isError
            ? "var(--ezy-red, #f85149)"
            : "var(--ezy-border, rgba(255,255,255,0.12))"
        }`,
        borderRadius: 8,
        padding: "10px 12px",
        color: "var(--ezy-text, #e6edf3)",
        fontSize: 12,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        fontFamily: "Inter, system-ui, sans-serif",
        pointerEvents: "auto",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: 8,
            background: active
              ? "var(--ezy-accent, #10a37f)"
              : "var(--ezy-text-muted, rgba(230,237,243,0.5))",
            opacity: active ? 1 : 0.4,
            flexShrink: 0,
            transition: "opacity 200ms ease",
          }}
        />
        <span style={{ fontWeight: 600 }}>{p.title ?? "Voice"}</span>
        {!isError && p.state && (
          <span
            style={{
              marginLeft: "auto",
              fontSize: 10,
              color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
            }}
          >
            {p.state}
          </span>
        )}
      </div>
      {p.transcript && (
        <div
          style={{
            color: "var(--ezy-text-secondary, rgba(230,237,243,0.8))",
            fontStyle: "italic",
          }}
        >
          "{p.transcript}"
        </div>
      )}
      {p.tool && (
        <div
          style={{
            color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
            fontSize: 11,
          }}
        >
          {p.tool}
        </div>
      )}
      {p.error && (
        <div
          style={{
            color: "var(--ezy-red, #f85149)",
            fontSize: 11,
            lineHeight: 1.4,
          }}
        >
          {p.error}
        </div>
      )}
      {p.clarifyQuestion && (
        <div
          style={{
            borderTop: "1px solid var(--ezy-border-subtle, rgba(255,255,255,0.06))",
            paddingTop: 8,
            marginTop: 2,
          }}
        >
          <div
            style={{
              color: "var(--ezy-text-secondary, rgba(230,237,243,0.8))",
              marginBottom: 6,
            }}
          >
            {p.clarifyQuestion}
          </div>
          <button onClick={() => act("clarify-cancel")} style={smallBtn}>
            Cancel
          </button>
        </div>
      )}
      {p.confirmSummary && (
        <div
          style={{
            borderTop: "1px solid var(--ezy-border-subtle, rgba(255,255,255,0.06))",
            paddingTop: 8,
            marginTop: 2,
          }}
        >
          <div
            style={{
              color: "var(--ezy-text-secondary, rgba(230,237,243,0.8))",
              marginBottom: 8,
            }}
          >
            {p.confirmSummary}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => act("confirm-run")}
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: "#fff",
                background: "var(--ezy-red, #f85149)",
                border: "none",
                borderRadius: 4,
                padding: "4px 10px",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Confirm
            </button>
            <button onClick={() => act("confirm-cancel")} style={smallBtn}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Generic display-only tooltip (kind "tooltip") — payload { x, y, text },
 * anchored top-center at the given point (tab-path hover tooltip).
 */
function Tooltip({
  msg,
  registerEl,
}: {
  msg: OverlayPopupMsg;
  registerEl: (id: string, el: HTMLElement | null) => void;
}) {
  const p = (msg.payload ?? {}) as { x?: number; y?: number; text?: string };
  const ref = useCallback(
    (el: HTMLElement | null) => registerEl(msg.id, el),
    [registerEl, msg.id],
  );
  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        left: p.x ?? 0,
        top: p.y ?? 0,
        transform: "translateX(-50%)",
        background: "var(--ezy-surface-raised, #1c2128)",
        boxShadow: "inset 0 0 0 1px var(--ezy-border, rgba(255,255,255,0.12))",
        borderRadius: 6,
        padding: "4px 8px",
        fontSize: 11,
        color: "var(--ezy-text-secondary, rgba(230,237,243,0.8))",
        whiteSpace: "nowrap",
        pointerEvents: "none",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      {p.text ?? ""}
    </div>
  );
}

/**
 * Tab color swatch grid (kind "swatch-menu", backdrop). Payload:
 * { x, y, title, selected, swatches: [{id,label,color}] }. Bounces
 * "color:none" / "color:<id>".
 */
function SwatchMenu({
  msg,
  registerEl,
  closeLocal,
}: {
  msg: OverlayPopupMsg;
  registerEl: (id: string, el: HTMLElement | null) => void;
  closeLocal: (id: string) => void;
}) {
  const p = (msg.payload ?? {}) as {
    x?: number;
    y?: number;
    title?: string;
    selected?: string | null;
    swatches?: Array<{ id: string; label: string; color: string }>;
  };
  const ref = useCallback(
    (el: HTMLElement | null) => registerEl(msg.id, el),
    [registerEl, msg.id],
  );
  const act = (action: string) => {
    closeLocal(msg.id);
    emitOverlayAction({ id: msg.id, action });
  };
  return (
    <div
      style={{ position: "fixed", inset: 0, pointerEvents: "auto" }}
      onPointerDown={() => act("__dismiss__")}
      onContextMenu={(e) => {
        e.preventDefault();
      }}
    >
      <div
        ref={ref}
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          left: Math.min(p.x ?? 0, window.innerWidth - 170),
          top: Math.min(p.y ?? 0, window.innerHeight - 120),
          background: "var(--ezy-surface-raised, #1c2128)",
          border: "1px solid var(--ezy-border, rgba(255,255,255,0.12))",
          borderRadius: 8,
          padding: 8,
          boxShadow: "0 12px 36px rgba(0,0,0,0.5)",
          fontFamily: "Inter, system-ui, sans-serif",
        }}
      >
        <div
          style={{
            fontSize: 10,
            color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
            marginBottom: 6,
            fontWeight: 500,
            letterSpacing: "0.04em",
          }}
        >
          {p.title ?? "TAB COLOR"}
        </div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", maxWidth: 140 }}>
          <div
            title="None"
            onClick={() => act("color:none")}
            style={{
              width: 20,
              height: 20,
              borderRadius: 4,
              background: "var(--ezy-surface, #161b22)",
              border:
                p.selected == null
                  ? "2px solid var(--ezy-text, #e6edf3)"
                  : "1px solid var(--ezy-border, rgba(255,255,255,0.12))",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 10,
              color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
            }}
          >
            ×
          </div>
          {(p.swatches ?? []).map((sw) => (
            <div
              key={sw.id}
              title={sw.label}
              onClick={() => act(`color:${sw.id}`)}
              style={{
                width: 20,
                height: 20,
                borderRadius: 4,
                background: sw.color,
                border:
                  p.selected === sw.id
                    ? "2px solid #fff"
                    : "1px solid transparent",
                cursor: "pointer",
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Payload row for the recent-projects menu (kind "recent-menu"). */
type RecentMenuProject = {
  key: string;
  name: string;
  subtitle: string;
  tooltip: string;
  disabled: boolean;
  badge?: string;
  badgeMuted?: boolean;
  showFresh: boolean;
  showQuick: boolean;
  quickOn: boolean;
  paneCount: string;
  backendLabel?: string;
};

/**
 * Recent-projects dropdown (kind "recent-menu", backdrop). Rich rows with up
 * to four per-row buttons; quick/backend/remove actions keep the menu open —
 * the main webview re-emits the payload and the rows update in place.
 */
function RecentMenu({
  msg,
  registerEl,
  closeLocal,
}: {
  msg: OverlayPopupMsg;
  registerEl: (id: string, el: HTMLElement | null) => void;
  closeLocal: (id: string) => void;
}) {
  const p = (msg.payload ?? {}) as {
    projects?: RecentMenuProject[];
    canCreate?: boolean;
    servers?: Array<{ id: string; name: string }>;
  };
  const ref = useCallback(
    (el: HTMLElement | null) => registerEl(msg.id, el),
    [registerEl, msg.id],
  );
  const anchor = msg.rect!;
  const dismiss = () => {
    closeLocal(msg.id);
    emitOverlayAction({ id: msg.id, action: "__dismiss__" });
  };
  // Closing actions remove the popup locally; row-level toggles keep it open
  // (main re-emits fresh payload).
  const act = (action: string, closes: boolean) => {
    if (closes) closeLocal(msg.id);
    emitOverlayAction({ id: msg.id, action });
  };

  const headerStyle: CSSProperties = {
    padding: "6px 12px",
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
  };
  const rowBtn: CSSProperties = {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    padding: "2px 6px",
    border: "1px solid var(--ezy-border, rgba(255,255,255,0.15))",
    borderRadius: 4,
    background: "transparent",
    color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
    fontSize: 10,
    fontWeight: 600,
    cursor: "pointer",
    lineHeight: 1,
    fontFamily: "inherit",
  };

  const left = Math.max(8, Math.min(anchor.x, window.innerWidth - 300 - 8));
  const top = anchor.y + anchor.height + 2;

  return (
    <div
      style={{ position: "fixed", inset: 0, pointerEvents: "auto" }}
      onPointerDown={dismiss}
      onContextMenu={(e) => {
        e.preventDefault();
      }}
    >
      <div
        ref={ref}
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          top,
          left,
          width: 300,
          maxHeight: Math.max(120, window.innerHeight - top - 8),
          overflowY: "auto",
          background: "var(--ezy-surface-raised, #1c2128)",
          border: "1px solid var(--ezy-border, rgba(255,255,255,0.12))",
          borderRadius: 8,
          boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
          color: "var(--ezy-text, #e6edf3)",
          fontFamily: "Inter, system-ui, sans-serif",
        }}
      >
        <div
          style={{
            ...headerStyle,
            borderBottom: "1px solid var(--ezy-border, rgba(255,255,255,0.12))",
          }}
        >
          Recent Projects
        </div>
        {(p.projects ?? []).map((project) => (
          <div
            key={project.key}
            title={project.tooltip}
            onClick={() => {
              if (!project.disabled) act(`open:${project.key}`, true);
            }}
            onMouseEnter={(e) => {
              if (!project.disabled)
                e.currentTarget.style.background =
                  "var(--ezy-accent-glow, rgba(16,185,129,0.12))";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "7px 12px",
              cursor: project.disabled ? "not-allowed" : "pointer",
              fontSize: 13,
              opacity: project.disabled ? 0.5 : 1,
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="var(--ezy-text-muted, rgba(230,237,243,0.5))"
              style={{ flexShrink: 0 }}
            >
              <path d="M1.75 1h4.19c.51 0 .99.23 1.31.62l1 1.22c.09.12.24.16.38.16h5.62c.97 0 1.75.78 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25V2.75C0 1.78.78 1 1.75 1Z" />
            </svg>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontWeight: 500,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  overflow: "hidden",
                }}
              >
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {project.name}
                </span>
                {project.badge && (
                  <span
                    style={{
                      flexShrink: 0,
                      fontSize: 9,
                      fontWeight: 600,
                      padding: "1px 6px",
                      borderRadius: 3,
                      background: project.badgeMuted
                        ? "var(--ezy-surface, #161b22)"
                        : "var(--ezy-neutral-700, #404040)",
                      color: project.badgeMuted
                        ? "var(--ezy-text-muted, rgba(230,237,243,0.5))"
                        : "#ffffff",
                      letterSpacing: "0.02em",
                      textTransform: "uppercase",
                      border: project.badgeMuted
                        ? "1px solid var(--ezy-border, rgba(255,255,255,0.15))"
                        : "none",
                    }}
                  >
                    {project.badge}
                  </span>
                )}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {project.subtitle}
              </div>
            </div>
            {project.showFresh && (
              <button
                title="Start fresh — same layout, new sessions"
                style={rowBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  act(`fresh:${project.key}`, true);
                }}
              >
                <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 3a5 5 0 1 0 4.546 2.914.75.75 0 0 1 1.364-.626A6.5 6.5 0 1 1 8 1.5v-1a.25.25 0 0 1 .41-.192l2.36 1.966a.25.25 0 0 1 0 .384L8.41 4.624A.25.25 0 0 1 8 4.432V3Z" />
                </svg>
              </button>
            )}
            {project.showQuick && (
              <button
                title={
                  project.quickOn
                    ? `Quick open ON (${project.paneCount} panes) — click to disable`
                    : `Quick open OFF — click to enable (reuse last ${project.paneCount}-pane layout)`
                }
                style={{
                  ...rowBtn,
                  gap: 4,
                  borderColor: project.quickOn
                    ? "var(--ezy-accent, #10b981)"
                    : "var(--ezy-border, rgba(255,255,255,0.15))",
                  background: project.quickOn
                    ? "var(--ezy-accent-glow, rgba(16,185,129,0.12))"
                    : "transparent",
                  color: project.quickOn
                    ? "var(--ezy-accent, #10b981)"
                    : "var(--ezy-text-muted, rgba(230,237,243,0.5))",
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  act(`quick:${project.key}`, false);
                }}
              >
                <svg width="10" height="10" viewBox="0 0 448 512" fill="currentColor">
                  <path d="M349.4 44.6c5.9-13.7 1.5-29.7-10.6-38.5s-28.6-8-39.9 1.8l-256 224c-10 8.8-13.6 22.9-8.9 35.3S50.7 288 64 288h111.5L98.6 467.4c-5.9 13.7-1.5 29.7 10.6 38.5s28.6 8 39.9-1.8l256-224c10-8.8 13.6-22.9 8.9-35.3s-16.6-20.7-30-20.7H272.5L349.4 44.6z" />
                </svg>
                {project.paneCount}
              </button>
            )}
            {project.backendLabel && (
              <button
                title={`Backend: ${project.backendLabel} — click to switch`}
                style={{ ...rowBtn, letterSpacing: "0.04em" }}
                onClick={(e) => {
                  e.stopPropagation();
                  act(`backend:${project.key}`, false);
                }}
              >
                {project.backendLabel}
              </button>
            )}
            <svg
              width="14"
              height="14"
              viewBox="0 0 384 512"
              fill="var(--ezy-text-muted, rgba(230,237,243,0.5))"
              style={{ flexShrink: 0, cursor: "pointer", opacity: 0.5 }}
              onClick={(e) => {
                e.stopPropagation();
                act(`remove:${project.key}`, false);
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.opacity = "1";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = "0.5";
              }}
            >
              <path d="M342.6 150.6c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L192 210.7 86.6 105.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3L146.7 256 41.4 361.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0L192 301.3l105.4 105.3c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3L237.3 256l105.3-105.4z" />
            </svg>
          </div>
        ))}
        <div
          style={{
            height: 1,
            background: "var(--ezy-border, rgba(255,255,255,0.12))",
            margin: "2px 0",
          }}
        />
        <div
          onClick={() => {
            if (p.canCreate) act("create", true);
          }}
          onMouseEnter={(e) => {
            if (p.canCreate)
              e.currentTarget.style.background =
                "var(--ezy-accent-glow, rgba(16,185,129,0.12))";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 12px",
            cursor: p.canCreate ? "pointer" : "not-allowed",
            fontSize: 13,
            color: "var(--ezy-text-secondary, rgba(230,237,243,0.8))",
            opacity: p.canCreate ? 1 : 0.45,
          }}
          title={
            p.canCreate
              ? "Create a new project folder"
              : "Set a projects directory in Settings first"
          }
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="var(--ezy-text-muted, rgba(230,237,243,0.5))"
          >
            <path d="M1.75 1h4.19c.51 0 .99.23 1.31.62l1 1.22c.09.12.24.16.38.16h5.62c.97 0 1.75.78 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25V2.75C0 1.78.78 1 1.75 1Z" />
          </svg>
          Create New Project
        </div>
        <div
          onClick={() => act("browse", true)}
          onMouseEnter={(e) => {
            e.currentTarget.style.background =
              "var(--ezy-accent-glow, rgba(16,185,129,0.12))";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 12px",
            cursor: "pointer",
            fontSize: 13,
            color: "var(--ezy-text-secondary, rgba(230,237,243,0.8))",
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 448 512"
            fill="var(--ezy-text-muted, rgba(230,237,243,0.5))"
          >
            <path d="M256 80c0-17.7-14.3-32-32-32s-32 14.3-32 32V224H48c-17.7 0-32 14.3-32 32s14.3 32 32 32H192V432c0 17.7 14.3 32 32 32s32-14.3 32-32V288H400c17.7 0 32-14.3 32-32s-14.3-32-32-32H256V80z" />
          </svg>
          Browse for Folder...
        </div>
        {(p.servers ?? []).length > 0 && (
          <>
            <div
              style={{
                height: 1,
                background: "var(--ezy-border, rgba(255,255,255,0.12))",
                margin: "2px 0",
              }}
            />
            <div style={headerStyle}>Remote Servers</div>
            {(p.servers ?? []).map((server) => (
              <div
                key={server.id}
                onClick={() => act(`server:${server.id}`, true)}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background =
                    "var(--ezy-accent-glow, rgba(16,185,129,0.12))";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 12px",
                  cursor: "pointer",
                  fontSize: 13,
                  color: "var(--ezy-text-secondary, rgba(230,237,243,0.8))",
                }}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 512 512"
                  fill="var(--ezy-text-muted, rgba(230,237,243,0.5))"
                >
                  <path d="M64 32C28.7 32 0 60.7 0 96v64c0 35.3 28.7 64 64 64H448c35.3 0 64-28.7 64-64V96c0-35.3-28.7-64-64-64H64zm280 72a24 24 0 1 1 0 48 24 24 0 1 1 0-48zm48 24a24 24 0 1 1 48 0 24 24 0 1 1-48 0zM64 288c-35.3 0-64 28.7-64 64v64c0 35.3 28.7 64 64 64H448c35.3 0 64-28.7 64-64V352c0-35.3-28.7-64-64-64H64zm280 72a24 24 0 1 1 0 48 24 24 0 1 1 0-48zm56 24a24 24 0 1 1 48 0 24 24 0 1 1-48 0z" />
                </svg>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  Open folder on {server.name}…
                </span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Pane search bar (kind "pane-search") — the FIRST focus-handoff popup: it
 * hosts a real <input>, so while open the overlay window is made focusable
 * (overlay_set_focusable) and takes the foreground; on unmount it restores
 * WS_EX_NOACTIVATE and hands focus back (main then re-focuses the pane).
 * Ambient region: only the bar is hit-testable — the terminal stays visible
 * and clickable around it (clicking the pane de-focuses the bar but keeps it
 * open; clicking the bar re-activates the overlay). 1:1 port of
 * PaneSearchBar's design (xterm/native parity rule). The input TEXT lives
 * here (typing stays local + latency-free); every change bounces the "query"
 * action with { q } so the main webview drives the Rust search backend.
 */
function PaneSearch({
  msg,
  registerEl,
}: {
  msg: OverlayPopupMsg;
  registerEl: (id: string, el: HTMLElement | null) => void;
}) {
  const p = (msg.payload ?? {}) as {
    caseSensitive?: boolean;
    regex?: boolean;
    wholeWord?: boolean;
    matchIndex?: number;
    matchCount?: number;
    hasMatchInfo?: boolean;
    focusBump?: number;
    placeholder?: string;
  };
  const ref = useCallback(
    (el: HTMLElement | null) => registerEl(msg.id, el),
    [registerEl, msg.id],
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const act = (action: string, data?: unknown) =>
    emitOverlayAction({ id: msg.id, action, data });

  // Focus handoff lifecycle: focusable while mounted; focus the input once
  // the window can take the foreground. Restore NOACTIVATE on unmount.
  useEffect(() => {
    let disposed = false;
    invoke("overlay_set_focusable", { focusable: true })
      .then(() => {
        if (disposed) return;
        requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        });
      })
      .catch((e) => console.error("[overlay] set_focusable(true) failed", e));
    return () => {
      disposed = true;
      emitOverlayFocus(false);
      invoke("overlay_set_focusable", { focusable: false }).catch((e) =>
        console.error("[overlay] set_focusable(false) failed", e),
      );
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-pressed Ctrl+F in main bumps focusBump — refocus + select.
  useEffect(() => {
    if (p.focusBump !== undefined && p.focusBump > 0) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.focusBump]);

  const rect = msg.rect!;
  const matchInfo = p.hasMatchInfo
    ? { index: p.matchIndex ?? 0, count: p.matchCount ?? 0 }
    : null;
  const matchDisplay = query
    ? matchInfo
      ? matchInfo.count > 0
        ? `${matchInfo.index + 1} of ${matchInfo.count}`
        : "No results"
      : null
    : null;
  const noResults = matchInfo !== null && matchInfo.count === 0 && query.length > 0;

  const sep = (
    <div
      style={{
        width: 1,
        height: 16,
        background: "var(--ezy-border, rgba(255,255,255,0.12))",
        margin: "0 2px",
        flexShrink: 0,
      }}
    />
  );

  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        left: rect.x + rect.width - 6,
        top: rect.y + 6,
        transform: "translateX(-100%)",
        display: "flex",
        alignItems: "center",
        gap: 1,
        background: "var(--ezy-surface-raised, #1c2128)",
        boxShadow: "inset 0 0 0 1px var(--ezy-border, rgba(255,255,255,0.12))",
        borderRadius: 6,
        padding: "3px 4px",
        fontFamily: "system-ui, -apple-system, sans-serif",
        fontSize: 12,
        pointerEvents: "auto",
      }}
    >
      <div style={{ padding: "0 4px", display: "flex", alignItems: "center" }}>
        <svg
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill="none"
          stroke="var(--ezy-text-muted, rgba(230,237,243,0.5))"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="7" cy="7" r="5" />
          <line x1="11" y1="11" x2="14.5" y2="14.5" />
        </svg>
      </div>
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          act("query", { q: e.target.value });
        }}
        // overlayFocused tracks the INPUT, not the window: Chromium gives the
        // overlay window a focus event whenever ANY popup is clicked (even
        // without activation) and no paired blur — a window-level emitter got
        // the flag stuck true and every pane cursor went permanently hollow.
        onFocus={() => emitOverlayFocus(true)}
        onBlur={() => emitOverlayFocus(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            act("close");
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            act(e.shiftKey ? "prev" : "next");
            return;
          }
          if (e.key === "f" && (e.ctrlKey || e.metaKey)) {
            // Re-pressed Ctrl+F while searching: select-all (xterm parity) —
            // and NEVER let it fall through to WebView2's built-in Find bar.
            e.preventDefault();
            e.currentTarget.select();
          }
        }}
        placeholder={p.placeholder ?? "Find"}
        spellCheck={false}
        autoComplete="off"
        style={{
          width: 140,
          height: 24,
          background: "var(--ezy-surface, #161b22)",
          border: `1px solid ${
            noResults
              ? "var(--ezy-red, #f85149)"
              : "var(--ezy-border, rgba(255,255,255,0.12))"
          }`,
          borderRadius: 4,
          padding: "0 6px",
          color: "var(--ezy-text, #e6edf3)",
          fontSize: 12,
          outline: "none",
          caretColor: "var(--ezy-accent, #10a37f)",
          transition: "border-color 120ms ease",
        }}
      />
      {matchDisplay && (
        <span
          style={{
            fontSize: 11,
            color: noResults
              ? "var(--ezy-red, #f85149)"
              : "var(--ezy-text-muted, rgba(230,237,243,0.5))",
            padding: "0 4px",
            whiteSpace: "nowrap",
            minWidth: 48,
            textAlign: "center",
            userSelect: "none",
          }}
        >
          {matchDisplay}
        </span>
      )}
      {sep}
      <OvNavButton
        title="Previous match (Shift+Enter)"
        onClick={() => act("prev")}
        disabled={!query}
      >
        <polyline points="4,9 8,5 12,9" />
      </OvNavButton>
      <OvNavButton
        title="Next match (Enter)"
        onClick={() => act("next")}
        disabled={!query}
      >
        <polyline points="4,7 8,11 12,7" />
      </OvNavButton>
      {sep}
      <OvToggleButton
        active={!!p.caseSensitive}
        onClick={() => act("toggle-case")}
        title="Match case"
        label="Aa"
      />
      <OvToggleButton
        active={!!p.regex}
        onClick={() => act("toggle-regex")}
        title="Use regular expression"
        label=".*"
      />
      <OvToggleButton
        active={!!p.wholeWord}
        onClick={() => act("toggle-word")}
        title="Match whole word"
        label="W"
        underline
      />
      {sep}
      <OvNavButton title="Close (Escape)" onClick={() => act("close")}>
        <line x1="5" y1="5" x2="11" y2="11" />
        <line x1="11" y1="5" x2="5" y2="11" />
      </OvNavButton>
    </div>
  );
}

function OvNavButton({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      title={title}
      onClick={disabled ? undefined : onClick}
      style={{
        width: 24,
        height: 24,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 4,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.35 : 0.8,
        transition: "opacity 100ms ease, background-color 100ms ease",
      }}
      onMouseEnter={(e) => {
        if (!disabled) {
          e.currentTarget.style.opacity = "1";
          e.currentTarget.style.backgroundColor =
            "var(--ezy-accent-glow, rgba(16,185,129,0.12))";
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.opacity = disabled ? "0.35" : "0.8";
        e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="var(--ezy-text-muted, rgba(230,237,243,0.5))"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </svg>
    </div>
  );
}

function OvToggleButton({
  active,
  onClick,
  title,
  label,
  underline,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  label: string;
  underline?: boolean;
}) {
  return (
    <div
      title={title}
      onClick={onClick}
      style={{
        height: 24,
        minWidth: 24,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 4,
        padding: "0 4px",
        cursor: "pointer",
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.01em",
        backgroundColor: active
          ? "var(--ezy-accent-dim, rgba(16,185,129,0.5))"
          : "transparent",
        color: active ? "#fff" : "var(--ezy-text-muted, rgba(230,237,243,0.5))",
        textDecoration: underline ? "underline" : "none",
        textDecorationThickness: "1.5px",
        textUnderlineOffset: "2px",
        transition: "background-color 100ms ease, color 100ms ease",
        userSelect: "none",
      }}
      onMouseEnter={(e) => {
        if (!active)
          e.currentTarget.style.backgroundColor =
            "var(--ezy-accent-glow, rgba(16,185,129,0.12))";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      {label}
    </div>
  );
}

/**
 * Git branch dropdown (kind "git-branch-menu") — the second focus-handoff
 * popup: hosts the branch-search input and the inline new-branch form.
 * Backdrop popup (outside press dismisses, real shadow). Search text +
 * create-form state live HERE; branch data / busy flags / errors come from
 * the main webview's payload (live re-emits), and switch/create bounce back
 * as actions. 1:1 port of GitStatusBar's dropdown design.
 */
function GitBranchMenu({
  msg,
  registerEl,
  closeLocal,
}: {
  msg: OverlayPopupMsg;
  registerEl: (el: string, e: HTMLElement | null) => void;
  closeLocal: (id: string) => void;
}) {
  const p = (msg.payload ?? {}) as {
    branches?: string[];
    current?: string;
    creatingBusy?: boolean;
    createError?: string;
    switchError?: string;
  };
  const ref = useCallback(
    (el: HTMLElement | null) => registerEl(msg.id, el),
    [registerEl, msg.id],
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [switchAfter, setSwitchAfter] = useState(true);

  const act = (action: string, data?: unknown) =>
    emitOverlayAction({ id: msg.id, action, data });
  const dismiss = () => {
    closeLocal(msg.id);
    act("__dismiss__");
  };

  // Focus handoff: focusable while mounted; search input autofocus (parity
  // with the old dropdown's setTimeout(focus, 0)).
  useEffect(() => {
    let disposed = false;
    invoke("overlay_set_focusable", { focusable: true })
      .then(() => {
        if (disposed) return;
        requestAnimationFrame(() => searchRef.current?.focus());
      })
      .catch(() => {});
    return () => {
      disposed = true;
      emitOverlayFocus(false);
      invoke("overlay_set_focusable", { focusable: false }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Create-row expand → autofocus the name input.
  useEffect(() => {
    if (createOpen) requestAnimationFrame(() => nameRef.current?.focus());
  }, [createOpen]);

  // Escape closes even when no input has focus (the overlay window is the
  // foreground window while this popup is open).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        dismiss();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const anchor = msg.rect!;
  const current = p.current ?? "";
  const branches = p.branches ?? [];
  const filtered = branches.filter((b) =>
    b.toLowerCase().includes(search.toLowerCase()),
  );
  const nameErr = validateBranchName(newName);
  const createDisabled = !!p.creatingBusy || !newName.trim() || !!nameErr;

  const top = anchor.y + anchor.height + 4;
  const left = Math.max(8, Math.min(anchor.x, window.innerWidth - 260 - 8));
  const maxHeight = Math.min(300, window.innerHeight - top - 8);

  const inputStyle: CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    background: "var(--ezy-bg, #0d1117)",
    border: "1px solid var(--ezy-border, rgba(255,255,255,0.12))",
    borderRadius: 4,
    padding: "5px 8px",
    fontSize: 12,
    color: "var(--ezy-text, #e6edf3)",
    outline: "none",
    fontFamily: "inherit",
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, pointerEvents: "auto" }}
      onPointerDown={dismiss}
      onContextMenu={(e) => {
        e.preventDefault();
      }}
    >
      <div
        ref={ref}
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          top,
          left,
          width: 260,
          maxHeight,
          overflowY: "auto",
          background: "var(--ezy-surface-raised, #1c2128)",
          border: "1px solid var(--ezy-border, rgba(255,255,255,0.12))",
          borderRadius: 8,
          boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        <div style={{ padding: "6px 6px 4px" }}>
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onFocus={(e) => {
              emitOverlayFocus(true);
              e.currentTarget.style.borderColor = "var(--ezy-accent, #10a37f)";
            }}
            onBlur={(e) => {
              emitOverlayFocus(false);
              e.currentTarget.style.borderColor =
                "var(--ezy-border, rgba(255,255,255,0.12))";
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                dismiss();
              }
            }}
            placeholder="Search branches..."
            spellCheck={false}
            style={{ ...inputStyle, color: "var(--ezy-text-secondary, rgba(230,237,243,0.8))" }}
          />
        </div>
        <div style={{ padding: "2px 4px 0" }}>
          {!createOpen ? (
            <div
              onClick={() => setCreateOpen(true)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "5px 8px",
                borderRadius: 4,
                cursor: "pointer",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.backgroundColor =
                  "var(--ezy-surface, #161b22)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.backgroundColor = "transparent")
              }
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                <path
                  d="M8 3v10M3 8h10"
                  stroke="var(--ezy-text-muted, rgba(230,237,243,0.5))"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
              <span
                style={{
                  fontSize: 12,
                  color: "var(--ezy-text-secondary, rgba(230,237,243,0.8))",
                }}
              >
                New branch from {current}
              </span>
            </div>
          ) : (
            <div
              style={{
                padding: "6px 8px 8px",
                backgroundColor: "var(--ezy-surface, #161b22)",
                borderRadius: 4,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              <input
                ref={nameRef}
                value={newName}
                onChange={(e) => {
                  setNewName(e.target.value);
                  if (p.createError) act("create-error-clear");
                }}
                onFocus={() => emitOverlayFocus(true)}
                onBlur={() => emitOverlayFocus(false)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (!createDisabled)
                      act("create", { name: newName.trim(), switchAfter });
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setCreateOpen(false);
                  }
                }}
                placeholder="new-branch-name"
                spellCheck={false}
                style={inputStyle}
              />
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div
                  role="checkbox"
                  aria-checked={switchAfter}
                  onClick={() => setSwitchAfter((v) => !v)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    cursor: "pointer",
                    userSelect: "none",
                    flex: 1,
                  }}
                >
                  <div
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: 3,
                      border: switchAfter
                        ? "none"
                        : "1px solid var(--ezy-border-light, rgba(255,255,255,0.25))",
                      backgroundColor: switchAfter
                        ? "var(--ezy-accent, #10a37f)"
                        : "transparent",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    {switchAfter && (
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                        <path
                          d="M1.5 5.2 4 7.5 8.5 2.5"
                          stroke="#0d1117"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </div>
                  <span
                    style={{
                      fontSize: 11,
                      color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
                    }}
                  >
                    Switch after create
                  </span>
                </div>
                <button
                  onClick={() => setCreateOpen(false)}
                  disabled={!!p.creatingBusy}
                  style={{
                    height: 24,
                    padding: "0 8px",
                    borderRadius: 4,
                    border: "1px solid var(--ezy-border, rgba(255,255,255,0.12))",
                    background: "transparent",
                    color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
                    fontSize: 11,
                    cursor: p.creatingBusy ? "not-allowed" : "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={() =>
                    !createDisabled &&
                    act("create", { name: newName.trim(), switchAfter })
                  }
                  disabled={createDisabled}
                  style={{
                    height: 24,
                    padding: "0 10px",
                    borderRadius: 4,
                    border: "none",
                    background: "var(--ezy-accent, #10a37f)",
                    color: "#0d1117",
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: createDisabled ? "not-allowed" : "pointer",
                    opacity: createDisabled ? 0.5 : 1,
                    fontFamily: "inherit",
                  }}
                >
                  {p.creatingBusy ? "Creating…" : "Create"}
                </button>
              </div>
              {(p.createError || nameErr) && (
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--ezy-red, #f85149)",
                    wordBreak: "break-word",
                  }}
                >
                  {p.createError || nameErr}
                </div>
              )}
            </div>
          )}
        </div>
        <div style={{ padding: "2px 4px 4px" }}>
          {filtered.length === 0 && (
            <div
              style={{
                padding: "8px 12px",
                fontSize: 12,
                color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
              }}
            >
              No branches found
            </div>
          )}
          {filtered.map((b) => {
            const isCurrent = b === current;
            return (
              <div
                key={b}
                onClick={() => {
                  if (!isCurrent) {
                    closeLocal(msg.id);
                    act("switch", { branch: b });
                  }
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "5px 8px",
                  borderRadius: 4,
                  cursor: isCurrent ? "default" : "pointer",
                  backgroundColor: isCurrent
                    ? "var(--ezy-accent, #10a37f)"
                    : "transparent",
                }}
                onMouseEnter={(e) => {
                  if (!isCurrent)
                    e.currentTarget.style.backgroundColor =
                      "var(--ezy-surface, #161b22)";
                }}
                onMouseLeave={(e) => {
                  if (!isCurrent)
                    e.currentTarget.style.backgroundColor = "transparent";
                }}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                  <path
                    d="M5 3.25a2.25 2.25 0 114.5 0 2.25 2.25 0 01-4.5 0zM7.25 1.75a1.5 1.5 0 100 3 1.5 1.5 0 000-3zM4 12.75a2.25 2.25 0 114.5 0 2.25 2.25 0 01-4.5 0zM6.25 11.5a1.25 1.25 0 100 2.5 1.25 1.25 0 000-2.5z"
                    fill={isCurrent ? "white" : "var(--ezy-text-muted, rgba(230,237,243,0.5))"}
                  />
                  <path
                    d="M7.25 5.5v5.25"
                    stroke={isCurrent ? "white" : "var(--ezy-text-muted, rgba(230,237,243,0.5))"}
                    strokeWidth="1.5"
                  />
                </svg>
                <span
                  style={{
                    fontSize: 12,
                    color: isCurrent
                      ? "white"
                      : "var(--ezy-text-secondary, rgba(230,237,243,0.8))",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    flex: 1,
                    fontWeight: isCurrent ? 500 : 400,
                  }}
                >
                  {b}
                </span>
              </div>
            );
          })}
        </div>
        {p.switchError && (
          <div
            style={{
              padding: "6px 12px",
              fontSize: 11,
              color: "var(--ezy-red, #f85149)",
              borderTop: "1px solid var(--ezy-border, rgba(255,255,255,0.12))",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {p.switchError}
          </div>
        )}
      </div>
    </div>
  );
}

/** Row shape for the session picker (kind "session-picker"). */
type SessionRow = {
  id: string;
  name: string;
  isFromStore: boolean;
  isCurrent: boolean;
  timeLabel?: string;
};

/**
 * Session picker (kind "session-picker") — third focus-handoff popup: hosts
 * the inline rename input. Backdrop popup, right-aligned to its trigger.
 * Rename edit state lives HERE; the session list streams from the main
 * webview (index polling / slug merging stay there). Actions: pick / rename /
 * new / dismiss. 1:1 port of TerminalHeader's SessionPicker design.
 */
function SessionPickerMenu({
  msg,
  registerEl,
  closeLocal,
}: {
  msg: OverlayPopupMsg;
  registerEl: (id: string, el: HTMLElement | null) => void;
  closeLocal: (id: string) => void;
}) {
  const p = (msg.payload ?? {}) as { sessions?: SessionRow[] };
  const sessions = p.sessions ?? [];
  const ref = useCallback(
    (el: HTMLElement | null) => registerEl(msg.id, el),
    [registerEl, msg.id],
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const editingIdRef = useRef<string | null>(null);
  editingIdRef.current = editingId;

  const act = (action: string, data?: unknown) =>
    emitOverlayAction({ id: msg.id, action, data });
  const dismiss = () => {
    closeLocal(msg.id);
    act("__dismiss__");
  };

  // Focus handoff while mounted (the rename input needs real keystrokes).
  useEffect(() => {
    invoke("overlay_set_focusable", { focusable: true }).catch(() => {});
    return () => {
      emitOverlayFocus(false);
      invoke("overlay_set_focusable", { focusable: false }).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  // Escape: cancel an active rename first, else dismiss (original behavior).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (editingIdRef.current) setEditingId(null);
        else dismiss();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitRename = () => {
    if (editingId && editValue.trim()) {
      act("rename", { id: editingId, name: editValue.trim() });
    }
    setEditingId(null);
  };

  const anchor = msg.rect!;
  const top = anchor.y + anchor.height + 2;
  const left = Math.max(8, anchor.x + anchor.width - 260);

  return (
    <div
      style={{ position: "fixed", inset: 0, pointerEvents: "auto" }}
      onPointerDown={dismiss}
      onContextMenu={(e) => {
        e.preventDefault();
      }}
    >
      <div
        ref={ref}
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          top,
          left,
          width: 260,
          background: "var(--ezy-surface-raised, #1c2128)",
          border: "1px solid var(--ezy-border, rgba(255,255,255,0.12))",
          borderRadius: 8,
          overflow: "hidden",
          boxShadow: "0 12px 36px rgba(0,0,0,0.5)",
          maxHeight: 340,
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        <div style={{ overflowY: "auto", maxHeight: 296 }}>
          {sessions.length === 0 && (
            <div
              style={{
                padding: "8px 10px",
                fontSize: 11,
                color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
                opacity: 0.6,
              }}
            >
              No saved sessions
            </div>
          )}
          {sessions.map((session) => {
            const isEditing = editingId === session.id;
            const rowHover = hoveredId === session.id;
            return (
              <div
                key={session.id}
                onMouseEnter={() => setHoveredId(session.id)}
                onMouseLeave={() =>
                  setHoveredId((h) => (h === session.id ? null : h))
                }
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "0 4px 0 0",
                  backgroundColor:
                    session.isCurrent || rowHover
                      ? "var(--ezy-accent-glow, rgba(16,185,129,0.12))"
                      : "transparent",
                }}
              >
                {isEditing ? (
                  <input
                    ref={inputRef}
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onFocus={() => emitOverlayFocus(true)}
                    onBlur={() => {
                      emitOverlayFocus(false);
                      submitRename();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitRename();
                      if (e.key === "Escape") setEditingId(null);
                      e.stopPropagation();
                    }}
                    style={{
                      flex: 1,
                      padding: "5px 10px",
                      fontSize: 12,
                      fontFamily: "inherit",
                      backgroundColor: "var(--ezy-bg, #0d1117)",
                      border: "1px solid var(--ezy-accent, #10a37f)",
                      borderRadius: 4,
                      color: "var(--ezy-text, #e6edf3)",
                      outline: "none",
                      margin: "2px 0",
                    }}
                  />
                ) : (
                  <>
                    <button
                      style={{
                        flex: 1,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "6px 10px",
                        backgroundColor: "transparent",
                        border: "none",
                        cursor: "pointer",
                        fontSize: 12,
                        textAlign: "left",
                        fontWeight: session.isCurrent ? 600 : 400,
                        color: session.isCurrent
                          ? "var(--ezy-text, #e6edf3)"
                          : session.isFromStore
                            ? "var(--ezy-text-secondary, rgba(230,237,243,0.8))"
                            : "var(--ezy-text-muted, rgba(230,237,243,0.5))",
                        fontFamily: "inherit",
                        overflow: "hidden",
                      }}
                      onClick={() => {
                        closeLocal(msg.id);
                        if (!session.isCurrent) act("pick", { id: session.id });
                        else act("__dismiss__");
                      }}
                    >
                      <span
                        title={
                          session.isFromStore
                            ? "Session saved"
                            : "Historical session"
                        }
                        style={{
                          width: 5,
                          height: 5,
                          borderRadius: "50%",
                          backgroundColor: session.isFromStore
                            ? "var(--ezy-accent, #10a37f)"
                            : "var(--ezy-text-muted, rgba(230,237,243,0.5))",
                          flexShrink: 0,
                          opacity: session.isFromStore ? 0.7 : 0.4,
                        }}
                      />
                      <span
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          flex: 1,
                        }}
                        title={session.name}
                      >
                        {session.name}
                      </span>
                      {session.timeLabel && (
                        <span
                          style={{
                            fontSize: 10,
                            color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
                            opacity: 0.6,
                            flexShrink: 0,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {session.timeLabel}
                        </span>
                      )}
                      {session.isCurrent && (
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 16 16"
                          fill="var(--ezy-accent, #10a37f)"
                          style={{ flexShrink: 0 }}
                        >
                          <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
                        </svg>
                      )}
                    </button>
                    {session.isFromStore && rowHover && (
                      <div
                        role="button"
                        title="Rename session"
                        style={{
                          cursor: "pointer",
                          padding: 4,
                          borderRadius: 4,
                          flexShrink: 0,
                          display: "flex",
                          alignItems: "center",
                        }}
                        onMouseEnter={(e) =>
                          (e.currentTarget.style.backgroundColor =
                            "var(--ezy-border, rgba(255,255,255,0.15))")
                        }
                        onMouseLeave={(e) =>
                          (e.currentTarget.style.backgroundColor = "transparent")
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingId(session.id);
                          setEditValue(session.name);
                        }}
                      >
                        <svg
                          width="9"
                          height="9"
                          viewBox="0 0 512 512"
                          fill="var(--ezy-text-muted, rgba(230,237,243,0.5))"
                        >
                          <path d="M362.7 19.3L314.3 67.7 444.3 197.7l48.4-48.4c25-25 25-65.5 0-90.5L453.3 19.3c-25-25-65.5-25-90.5 0zm-71 71L58.6 323.5c-10.4 10.4-18 23.3-22.2 37.4L1 481.2C-1.5 489.7 .8 498.8 7 505s15.3 8.5 23.7 6.1l120.3-35.4c14.1-4.2 27-11.8 37.4-22.2L421.7 220.3 291.7 90.3z" />
                        </svg>
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
        <div
          style={{
            borderTop: "1px solid var(--ezy-border, rgba(255,255,255,0.12))",
          }}
        >
          <button
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 10px",
              backgroundColor: "transparent",
              border: "none",
              cursor: "pointer",
              fontSize: 12,
              textAlign: "left",
              color: "var(--ezy-text-secondary, rgba(230,237,243,0.8))",
              fontFamily: "inherit",
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.backgroundColor =
                "var(--ezy-accent-glow, rgba(16,185,129,0.12))")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.backgroundColor = "transparent")
            }
            onClick={() => {
              closeLocal(msg.id);
              act("new");
            }}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 16 16"
              fill="var(--ezy-text-muted, rgba(230,237,243,0.5))"
            >
              <path d="M8 2a.75.75 0 01.75.75v4.5h4.5a.75.75 0 010 1.5h-4.5v4.5a.75.75 0 01-1.5 0v-4.5h-4.5a.75.75 0 010-1.5h4.5v-4.5A.75.75 0 018 2z" />
            </svg>
            <span>New session</span>
          </button>
        </div>
      </div>
    </div>
  );
}
