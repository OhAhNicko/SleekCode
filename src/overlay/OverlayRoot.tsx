import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  emitOverlayAction,
  emitOverlayFocus,
  emitOverlayInteraction,
  emitOverlayReady,
  listenOverlayPopup,
  listenOverlayTheme,
  type OverlayPopupMsg,
} from "../lib/overlay-bridge";
import {
  CTX_ICONS,
} from "../lib/menu-icons";
import type { OverlayToastPayload } from "../lib/useOverlayToast";
import type { OverlayMenuPayload } from "../lib/overlay-menu-model";
import { validateBranchName } from "../lib/git-branch-validate";
import {
  JUMP_BTN_BOTTOM_CLAMP_PX,
  JUMP_BTN_GAP_PX,
  JUMP_BTN_IDLE_MS,
} from "../native-term/tui-scroll-model";
import {
  clipOutOfResizeFrame,
  WINDOW_RESIZE_EDGE_PX,
} from "../lib/window-resize-frame";

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
/**
 * Identity of a popup's CONTENT (anchor + model), used to tell a stale re-send
 * of the popup we just closed from a genuine re-open. Deliberately excludes
 * `id`: the id is shared across every right-click of the global context menu.
 */
function popupSignature(msg: OverlayPopupMsg): string {
  return JSON.stringify([msg.rect ?? null, msg.payload ?? null]);
}

/**
 * Menu-class popups: they carry a real CSS drop shadow, so their clip region is
 * inflated by MENU_SHADOW_PAD to give it room (a tight clip would slice the
 * shadow off at the panel edge). Ambient popups (toasts, tooltips, jump button)
 * are deliberately NOT padded — a region under the pointer steals the mouse
 * from the pane beneath and re-triggers hover-close oscillation.
 *
 * These used to be BACKDROP_KINDS, meaning "make the whole overlay window
 * hit-testable so an outside click lands on the backdrop div". That mode is
 * gone (see the region effect and lib/overlay-dismiss.ts).
 */
const SHADOW_PAD_KINDS = new Set([
  "anchored-menu",
  "swatch-menu",
  "recent-menu",
  "git-branch-menu",
  "session-picker",
  "sound-picker",
]);

/** Room for the menu drop shadow inside the clip region (CSS px). */
const MENU_SHADOW_PAD = 36;

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

  // Mirror of `popups` for callbacks that must not re-subscribe on every
  // change (closeLocal needs the message it is closing, to signature it).
  const popupsRef = useRef(popups);
  popupsRef.current = popups;

  // Stamp of the last message per popup id — feeds the ghost sweep below.
  const lastSeen = useRef<Map<string, number>>(new Map());

  // RESURRECT GUARD: id -> when this overlay closed it locally.
  //
  // `closeLocal` drops a popup the instant the user dismisses or picks — but
  // MAIN doesn't know yet. Its rAF rect stream (and the ~750ms keepalive) keep
  // emitting `open:true` for the whole overlay->main->overlay round-trip, and
  // every one of those stale messages re-added the popup here: the dropdown
  // blinked 3-4 times before it finally closed. Dismissing INTO a native pane
  // made it worse — the pane's focus/mouse events re-render the owner, which
  // changes the payload and forces an immediate re-emit. (Escape never blinked:
  // main flips its own state with no round-trip.)
  //
  // So a locally-closed popup ignores re-sends of ITS OWN CONTENT until main's
  // `open:false` echo confirms it caught up. Keyed by content, not by id — see
  // the listener below for why the id alone is not identity here.
  const closedLocally = useRef<Map<string, { sig: string }>>(new Map());

  /** Rect count of the last push — tells a growing region from a shrinking one. */
  const lastRectCount = useRef(0);
  /** Serialized rects of the last push — skips no-op re-pushes. */
  const lastRegionSig = useRef("");

  useEffect(() => {
    let un: UnlistenFn | undefined;
    let disposed = false;
    listenOverlayPopup((msg) => {
      const closed = closedLocally.current.get(msg.id);
      if (msg.open && msg.rect) {
        if (closed !== undefined) {
          // Drop ONLY the popup we just closed coming back UNCHANGED. Identity
          // is the content (anchor + model), never the id — the global context
          // menu reuses one id ("made:menu") for every right-click, and an
          // id-only guard blocked genuine re-opens outright.
          //
          // No time bound on identical content: while main still believes the
          // popup is open it re-emits the SAME message every ~750ms
          // (GlobalContextMenu's keepalive), and any of those landing after a
          // short window would re-add the menu at its old anchor — a real,
          // DOM-backed ghost lasting until the next close. Identical content
          // can only be a stale re-send, so suppress it until main's own
          // `open:false` echo says it caught up. A re-open the user actually
          // asked for differs in rect or payload and passes untouched.
          if (closed.sig === popupSignature(msg)) return;
          closedLocally.current.delete(msg.id);
        }
      } else if (closed !== undefined) {
        // Main caught up — a later `open:true` is a genuine re-open.
        closedLocally.current.delete(msg.id);
      }
      // Diagnostic: a fresh open arriving long after its emit means the event
      // bus (main-thread eval queue) is backlogged — the historical cause of
      // "menu takes seconds to appear". Silent when healthy.
      if (msg.open && msg.rect && msg._ts && !popupsRef.current.has(msg.id)) {
        const transportMs = Date.now() - msg._ts;
        if (transportMs > 150) {
          console.warn(
            `[MenuLatency] overlay:popup '${msg.id}' (${msg.kind}) transport took ${transportMs}ms`,
          );
        }
      }
      if (msg.open && msg.rect) lastSeen.current.set(msg.id, Date.now());
      else lastSeen.current.delete(msg.id);
      setPopups((prev) => {
        // Identity-stable no-ops: every popup hook emits `open:false` on mount
        // and unmount, so a burst of closes for ids that were never open used
        // to allocate a new Map each time -> re-render -> a fresh
        // overlay_set_region invoke per message (hardware-logged 2026-07-24:
        // a dozen redundant region/show-hide round-trips inside a single ms).
        // Returning `prev` unchanged keeps the region call on real changes only.
        if (!(msg.open && msg.rect)) {
          if (!prev.has(msg.id)) return prev;
          const next = new Map(prev);
          next.delete(msg.id);
          return next;
        }
        // Unchanged re-send => keep the SAME state object, so React does not
        // re-render at all. Anchored popups re-emit continuously — the TUI
        // scrollbar streams its rect ~16x/s while an alt-screen pane is live,
        // and every popup keepalives at ~750ms — and each of those used to
        // allocate a new Map and re-render the whole overlay tree. That is
        // work competing with the popup you are trying to open, which is why
        // menus felt slower over a busy TUI pane (user-reported 2026-07-26).
        const cur = prev.get(msg.id);
        if (cur && popupSignature(cur) === popupSignature(msg)) return prev;
        const next = new Map(prev);
        next.set(msg.id, msg);
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

  // REGION DRIVER — a continuous rAF re-read of the popups' RENDERED geometry
  // with a no-change guard. Mirrors the pane geometry driver in
  // TerminalPaneNative.
  //
  // Why a loop and not a `popups` effect: a popup's FINAL geometry comes from
  // its own measurement pass (menus render once hidden to measure themselves,
  // then re-render flipped/clamped), which changes no message. An effect keyed
  // on messages therefore clipped to the pre-measurement rect and never
  // corrected — the menu came up clipped to whatever region was installed
  // before, e.g. a 16px TUI scrollbar strip (user-reported 2026-07-26, with a
  // screenshot). It only appeared to work while anchored popups happened to
  // re-emit ~16x/s and re-ran the effect for us; deduping those re-sends
  // removed the accident that was hiding this.
  //
  // Report every pointerdown to main. The window region only ever covers the
  // open popups (effect below), so a press this document receives is by
  // definition INSIDE a popup — yet it still makes our WebView2 child take
  // Win32 focus, which fires the main webview's DOM blur. Without this ping
  // OverlayDismissOwner's deferred blur check reads that blur as "another app
  // took over" and dismisses the very popup being clicked (the recent-menu
  // quick/backend toggles died this way; same mechanism as the session-picker
  // self-dismiss, which is why focus-handoff popups emit overlayFocused).
  // Capture phase so a popup's own stopPropagation cannot swallow it.
  useEffect(() => {
    const onPointerDown = () => emitOverlayInteraction();
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  // NO BACKDROP MODE (2026-07-26). The region is ALWAYS the union of the open
  // popups' own rects — the window is never regionless and never hidden. Both
  // of those states are what produced the ghost bugs: a hidden window keeps its
  // last COMPOSITED frame, and a region only CLIPS stale pixels rather than
  // repainting them, so the next show / clear_region re-displayed a menu at its
  // previous position. Outside clicks are now reported by the main webview
  // (src/lib/overlay-dismiss.ts) instead of by covering the screen.
  useLayoutEffect(() => {
    let raf = 0;
    // A growth is applied one frame LATE on purpose: revealing surface the
    // popup has not painted into yet shows an empty rectangle. Since this loop
    // re-reads every frame, "next tick" IS that one-frame wait, and by then the
    // paint has landed. Shrinks apply immediately so click-through comes back
    // in the same frame the popup goes away.
    let pending: PopupRect[] | null = null;

    const tick = () => {
      raf = requestAnimationFrame(tick);

      if (pending) {
        const rectsToPush = pending;
        pending = null;
        push(rectsToPush);
        return;
      }

      const rects: PopupRect[] = [];
      for (const [id, el] of els.current) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const cs = getComputedStyle(el);
        // Skip surfaces that are laid out but NOT yet shown: a menu's first
        // pass is `visibility: hidden` purely so it can measure itself before
        // deciding whether to flip above/left of the cursor. Clipping to that
        // pre-measurement rect made the menu appear to "render 50% and then
        // the rest".
        if (cs.visibility === "hidden") continue;
        const radius = parseFloat(cs.borderTopLeftRadius) || 0;
        // Menu-class popups keep their real drop shadow: a tight clip would cut
        // it off at the panel edge, so their rect is inflated to give it room
        // INSIDE the region. That margin is not dead space — the menu's own
        // full-screen backdrop div covers it and dismisses on pointerdown.
        const popup = popupsRef.current.get(id);
        const kind = popup?.kind;
        const pad = kind && SHADOW_PAD_KINDS.has(kind) ? MENU_SHADOW_PAD : 0;
        let x = r.left - pad;
        let y = r.top - pad;
        let w = r.width + pad * 2;
        let h = r.height + pad * 2;

        // The ring must never cover the control that opened the popup.
        //
        // Menus open flush against their anchor (a 2px gap), so a 36px ring
        // reaches ~34px back OVER the button. The overlay is a separate window:
        // once its region covers those pixels, the main webview stops seeing
        // the pointer there. For hover-opened menus that is a feedback loop —
        // open → region covers the button → button fires `mouseleave` →
        // scheduled close → region shrinks → button hovered again → reopen —
        // which reads as a menu blinking and jittering under the cursor. It
        // also silently breaks moving between two adjacent trigger buttons,
        // since the second one never receives `mouseenter`.
        //
        // Trimming only the anchor-facing edge costs nothing visually: that is
        // the side pressed against the button, where there is no shadow to
        // show anyway.
        const a = popup?.rect;
        if (pad > 0 && a) {
          const aRight = a.x + a.width;
          const aBottom = a.y + a.height;
          if (r.top >= aBottom) {
            const clamped = Math.max(y, aBottom);
            h -= clamped - y;
            y = clamped;
          } else if (r.bottom <= a.y) {
            h = Math.min(y + h, a.y) - y;
          }
          if (r.left >= aRight) {
            const clamped = Math.max(x, aRight);
            w -= clamped - x;
            x = clamped;
          } else if (r.right <= a.x) {
            w = Math.min(x + w, a.x) - x;
          }
        }

        // The window's resize frame is NOT ours to claim.
        //
        // Those handles are 6px DOM divs in the MAIN webview
        // (components/WindowResizeHandles.tsx). This overlay is a separate
        // always-on-top OS window sized to main's whole client area, and every
        // pixel inside this region belongs to it — the main webview never sees
        // the pointer there. So a popup that reaches a window edge takes window
        // resizing away from the user for its entire span, silently, with no
        // visual tell.
        //
        // That is exactly what the far-right pane's TUI scrollbar did: its
        // hit-strip is pinned to the pane's right edge, the rightmost pane is
        // flush with the window, and the strip is 16px wide (44 while scrolled
        // up) — so it covered the 6px East handle for the pane's full height
        // and the window could not be resized from the right at all
        // (user-reported 2026-08-04). The 2026-07-26 fix for the same symptom
        // did not help: it trims the PANE's HWND, and this is a different
        // window.
        //
        // Clipped HERE, at the one place rects become the region, rather than
        // in each popup: any popup that ever reaches an edge — a toast, a menu
        // opened against the frame, something not written yet — is covered by
        // construction. Popups are still responsible for LOOKING right (see
        // TuiScrollbar, which insets itself so this clip never bites it); this
        // is the floor, not the plan.
        const safe = clipOutOfResizeFrame(
          { x, y, width: w, height: h },
          window.innerWidth,
          window.innerHeight,
        );
        if (!safe) continue;
        rects.push({ ...safe, radius });
      }

      const sig = JSON.stringify(rects);
      if (sig === lastRegionSig.current) return;
      const grewArea = rects.length > lastRectCount.current;
      lastRegionSig.current = sig;
      lastRectCount.current = rects.length;
      if (grewArea) pending = rects;
      else push(rects);
    };

    // Backpressure: at most ONE overlay_set_region invoke in flight, with
    // latest-wins merging while the wire is busy (same reasoning as
    // frameSync.ts). overlay_set_region is a sync command, so on Windows it
    // runs inline on the UI thread — firing it un-awaited from a rAF loop can
    // stack invokes behind a backlogged queue, each one a SetWindowRgn that
    // invalidates every window beneath the overlay.
    let inFlight = false;
    let queued: PopupRect[] | null = null;
    const push = (rects: PopupRect[]) => {
      if (inFlight) {
        queued = rects;
        return;
      }
      inFlight = true;
      const t0 = Date.now();
      invoke("overlay_set_region", { rects, backdrop: false })
        .catch((e) => console.error("[overlay] overlay_set_region failed", e))
        .finally(() => {
          inFlight = false;
          const took = Date.now() - t0;
          if (took > 150) {
            console.warn(`[MenuLatency] overlay_set_region took ${took}ms`);
          }
          if (queued) {
            const next = queued;
            queued = null;
            push(next);
          }
        });
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

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
    // Tombstone FIRST: main's in-flight `open:true` messages must not be able
    // to resurrect this popup between here and its `open:false` echo (see
    // closedLocally). Applies to every popup that closes locally — context
    // menus, anchored dropdowns, git branch, session picker, swatches.
    const open = popupsRef.current.get(id);
    closedLocally.current.set(id, {
      sig: open ? popupSignature(open) : "",
    });
    lastSeen.current.delete(id);
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
    case "toast":
      return <Toast msg={msg} registerEl={registerEl} />;
    case "notif-stack":
      return <NotifStack msg={msg} registerEl={registerEl} />;
    case "file-link-tooltip":
      return <FileLinkTip msg={msg} registerEl={registerEl} />;
    case "tui-scrollbar":
      return <TuiScrollbar msg={msg} registerEl={registerEl} />;
    case "ime-composition":
      return <ImeComposition msg={msg} registerEl={registerEl} />;
    case "jump-btn":
      return <JumpButton msg={msg} registerEl={registerEl} />;
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
    case "sound-picker":
      return (
        <SoundPickerMenu msg={msg} registerEl={registerEl} closeLocal={closeLocal} />
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
    borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
    background: "var(--ezy-surface-raised, #1c2128)",
    boxShadow: "inset 0 0 0 1px var(--ezy-border, rgba(255,255,255,0.12))",
    color: "var(--ezy-text-muted, rgba(230,237,243,0.65))",
    fontFamily: "var(--ezy-font-ui, Inter, system-ui, sans-serif)",
    fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
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
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
          background: p.bg ?? "#404040",
          color: "#ffffff",
          maxWidth: 420,
          fontFamily: "var(--ezy-font-ui, Inter, system-ui, sans-serif)",
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
          <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", fontWeight: 600, letterSpacing: "-0.01em" }}>
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
              fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
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

  // Thumbnail form (image-paste toast): 48px thumb + title/filename column.
  // Plain form (undo-close/-clear, pane notifications): single title line with
  // `detail` as its tooltip — unchanged.
  const hasThumb = !!p.thumbnailUrl;

  return (
    <div
      ref={ref}
      onClick={p.clickAction ? () => act(p.clickAction!) : undefined}
      style={{
        ...placement,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: hasThumb ? "8px 10px 8px 8px" : "8px 12px",
        borderRadius: "calc(var(--ezy-radius-scale, 1) * 8px)",
        background: "var(--ezy-surface-raised, #1c2128)",
        boxShadow: "inset 0 0 0 1px var(--ezy-border, rgba(255,255,255,0.12))",
        fontFamily: "var(--ezy-font-ui, Inter, system-ui, sans-serif)",
        pointerEvents: "auto",
        cursor: p.clickAction ? "pointer" : undefined,
      }}
    >
      {hasThumb && (
        <img
          src={p.thumbnailUrl}
          alt=""
          style={{
            width: 48,
            height: 48,
            objectFit: "cover",
            borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
            flexShrink: 0,
          }}
        />
      )}
      {hasThumb ? (
        <div style={{ minWidth: 0, maxWidth: 240 }}>
          <div
            style={{
              fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
              fontWeight: 500,
              color: "var(--ezy-text, #e6edf3)",
              whiteSpace: "nowrap",
            }}
          >
            {p.title}
          </div>
          {p.detail && (
            <div
              title={p.detailTooltip ?? undefined}
              style={{
                fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                marginTop: 2,
                color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {p.detail}
            </div>
          )}
        </div>
      ) : (
        <span
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
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
      )}
      {p.button && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            act(p.button!.action);
          }}
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
            fontWeight: 500,
            padding: "4px 10px",
            borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
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
            fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
            color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
            flexShrink: 0,
          }}
        >
          {p.shortcutHint}
        </span>
      )}
      {p.dismissable && (
        <svg
          onClick={(e) => {
            e.stopPropagation();
            act("dismiss");
          }}
          role="button"
          aria-label="Dismiss"
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
      )}
    </div>
  );
}

/** One card in the pane-notification stack (see NotifStack below). */
interface NotifStackCard {
  id: string;
  projectName: string;
  paneLabel: string;
  timeHHMM: string;
  body: string;
  kind: "permission" | "finished";
}

/** Below the 38px tab bar plus a deliberate 12px gap. Never smaller: the
 * window close button sits top-right INSIDE the bar, and the top card's own
 * dismiss X lands right under it — too little clearance turns an overshoot
 * aimed at a card into closing the whole app. Top-right (vs the old
 * bottom-right) also keeps cards off the TUI composer. */
const NOTIF_STACK_TOP = 50;
/** Spawn/close animation timing. Subtle by design. */
const NOTIF_IN_MS = 160;
const NOTIF_OUT_MS = 140;

/**
 * Persistent pane-notification stack, top-right below the tab bar. Ambient
 * popup (no backdrop, no focus handoff, tight 1-bit clip) like
 * Toast/VoiceHudCard, but ONE popup whose payload is the whole card list:
 *
 *  - Each CARD registers its own region rect (`${msg.id}::n-${card.id}`), so
 *    the 8px gaps between cards stay click-through to the pane beneath, and
 *    adding a card grows the rect COUNT — taking the region driver's
 *    one-frame-late growth path instead of an immediate same-rect stretch.
 *  - Top-anchored column, oldest first: a NEW card appends at the BOTTOM, so
 *    existing cards never move under the pointer. (Bottom-right was rejected —
 *    it sat on top of the TUI composer.)
 *  - Animations never touch measured geometry (each frame of rect change is a
 *    SetWindowRgn on the Win32 UI thread): the REGISTERED outer div is static;
 *    a Web-Animations fade + ≤3% inner scale runs inside it. scale stays <1 so
 *    nothing escapes the clip. Dismissed cards linger as non-interactive
 *    ghosts for the fade-out, holding their slot so the reflow happens after.
 *    prefers-reduced-motion skips both.
 *
 * Card actions are string-encoded with the per-item id (`focus:<id>`,
 * `dismiss:<id>`) because the toast transport forwards only the action string.
 */
function NotifStack({
  msg,
  registerEl,
}: {
  msg: OverlayPopupMsg;
  registerEl: (id: string, el: HTMLElement | null) => void;
}) {
  const p = (msg.payload ?? {}) as { cards?: NotifStackCard[] };
  // Payload arrives newest-first; render oldest-first so the stack grows
  // downward and existing cards keep their position.
  const cardsJson = JSON.stringify(p.cards ?? []);
  const cards = useMemo(
    () => [...(JSON.parse(cardsJson) as NotifStackCard[])].reverse(),
    [cardsJson],
  );
  const act = (action: string) => emitOverlayAction({ id: msg.id, action });

  const reducedMotion = useMemo(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );
  // Live cards plus fading ghosts of dismissed ones (leaving: true).
  const [display, setDisplay] = useState<Array<NotifStackCard & { leaving?: boolean }>>([]);
  /** Inner (animated) element per card id — exit animations need the mounted el. */
  const innerElsRef = useRef(new Map<string, HTMLElement>());
  /** Ids whose entry animation already ran. NEVER pruned on ref-null: inline
   * ref callbacks re-fire on every render (old(null) + new(el)), so pruning
   * there would replay the entry animation on each keepalive re-render. Ids
   * are unique per card lifetime; the set stays session-bounded. */
  const enteredRef = useRef(new Set<string>());
  /** Ids whose exit fade already started — a later dismissal must not restart
   * an in-flight ghost's animation from opacity 1. */
  const exitStartedRef = useRef(new Set<string>());

  useEffect(() => {
    setDisplay((prev) => {
      const liveIds = new Set(cards.map((c: NotifStackCard) => c.id));
      // Keep order: existing entries hold their slot (missing ones become
      // ghosts), genuinely new cards append at the end (= bottom).
      const kept = prev
        .map((entry) => {
          if (liveIds.has(entry.id)) {
            return {
              ...cards.find((c: NotifStackCard) => c.id === entry.id)!,
              leaving: false,
            };
          }
          return entry.leaving ? entry : { ...entry, leaving: true };
        })
        .filter((entry) => !entry.leaving || !reducedMotion);
      const knownIds = new Set(kept.map((e) => e.id));
      const added = cards.filter((c: NotifStackCard) => !knownIds.has(c.id));
      return [...kept, ...added];
    });
  }, [cardsJson, reducedMotion]); // eslint-disable-line react-hooks/exhaustive-deps

  // Run exit fades + schedule ghost removal. A ghost that arrives while an
  // earlier one is mid-fade restarts only the removal TIMER (harmless — the
  // finished ghost holds opacity 0 via fill:forwards), never the animation.
  useEffect(() => {
    const leaving = display.filter((e) => e.leaving);
    if (leaving.length === 0) return;
    for (const entry of leaving) {
      if (exitStartedRef.current.has(entry.id)) continue;
      exitStartedRef.current.add(entry.id);
      innerElsRef.current.get(entry.id)?.animate(
        [
          { opacity: 1, transform: "scale(1)" },
          { opacity: 0, transform: "scale(0.97)" },
        ],
        { duration: NOTIF_OUT_MS, easing: "ease-in", fill: "forwards" },
      );
    }
    const timer = window.setTimeout(() => {
      setDisplay((prev) =>
        prev.filter((e) => {
          if (e.leaving) {
            exitStartedRef.current.delete(e.id);
            return false;
          }
          return true;
        }),
      );
    }, NOTIF_OUT_MS + 20);
    return () => clearTimeout(timer);
  }, [display]);

  return (
    <div
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: "fixed",
        top: NOTIF_STACK_TOP,
        right: 16,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 8,
        // The container itself must not eat pointer events — only the cards
        // do, so the gaps stay click-through (the region excludes them too).
        pointerEvents: "none",
        fontFamily: "var(--ezy-font-ui, Inter, system-ui, sans-serif)",
      }}
    >
      {display.map((card) => {
        const permission = card.kind === "permission";
        return (
          // Outer div: REGISTERED region element — static geometry, never
          // animated. Ghosts keep pointer events off so a fading card can't
          // swallow a click.
          <div
            key={card.id}
            ref={(el) => registerEl(`${msg.id}::n-${card.id}`, el)}
            onClick={card.leaving ? undefined : () => act(`focus:${card.id}`)}
            style={{
              width: 320,
              pointerEvents: card.leaving ? "none" : "auto",
              cursor: card.leaving ? undefined : "pointer",
            }}
          >
          {/* Inner div: the visible card — the only thing that animates
              (opacity + ≤3% scale, always inside the outer rect). */}
          <div
            ref={(el) => {
              if (el) {
                innerElsRef.current.set(card.id, el);
                if (!enteredRef.current.has(card.id)) {
                  enteredRef.current.add(card.id);
                  if (!reducedMotion && !card.leaving) {
                    el.animate(
                      [
                        { opacity: 0, transform: "scale(0.97)" },
                        { opacity: 1, transform: "scale(1)" },
                      ],
                      { duration: NOTIF_IN_MS, easing: "cubic-bezier(0.2, 0, 0, 1)" },
                    );
                  }
                }
              } else {
                // Only the element map — see enteredRef doc for why the
                // entered set must survive ref-null churn.
                innerElsRef.current.delete(card.id);
              }
            }}
            style={{
              transformOrigin: "top right",
              background: "var(--ezy-surface-raised, #1c2128)",
              boxShadow: "inset 0 0 0 1px var(--ezy-border, rgba(255,255,255,0.12))",
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 8px)",
              padding: "9px 12px",
              display: "flex",
              flexDirection: "column",
              gap: 5,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <span
                style={{
                  fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
                  fontWeight: 600,
                  lineHeight: "16px",
                  padding: "0 6px",
                  borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                  background: permission
                    ? "var(--ezy-red, #dc2626)"
                    : "var(--ezy-accent, #10a37f)",
                  color: "#ffffff",
                  flexShrink: 0,
                }}
              >
                {permission ? "Permission" : "Done"}
              </span>
              <span
                style={{
                  fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                  fontWeight: 600,
                  color: "var(--ezy-text, #e6edf3)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  minWidth: 0,
                  flex: 1,
                }}
              >
                {card.projectName}
              </span>
              <span
                style={{
                  fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                  color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
                  fontVariantNumeric: "tabular-nums",
                  flexShrink: 0,
                }}
              >
                {card.timeHHMM}
              </span>
              <svg
                onClick={(e) => {
                  e.stopPropagation();
                  act(`dismiss:${card.id}`);
                }}
                role="button"
                aria-label="Dismiss notification"
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
            {card.paneLabel && (
              <div
                style={{
                  fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                  color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {card.paneLabel}
              </div>
            )}
            <div
              style={{
                fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                lineHeight: 1.45,
                color: "var(--ezy-text-secondary, rgba(230,237,243,0.8))",
                display: "-webkit-box",
                WebkitLineClamp: 3,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
                wordBreak: "break-word",
              }}
            >
              {card.body}
            </div>
          </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Hovered file-path tooltip (native pane). Display-only; positioned at a
 * pane-LOCAL offset computed by the main webview (payload.top/left) plus the
 * live pane rect. 1:1 port of the xterm pane's `.ezy-file-link-tooltip`
 * (index.css): same background/border/radius/shadow, `.ezy-flt-label` +
 * `.ezy-flt-kbd` typography (xterm/native design-parity rule).
 *
 * The pill sits inside a transparent PADDED wrapper (the registered region
 * element): the padding gives the `0 4px 12px` drop shadow room INSIDE the
 * 1-bit clip instead of being cropped at the pill's edge, and keeps the
 * region clear of the hovered line so the pointer never enters it (region
 * under the cursor would steal the mouse from the pane → hover-close
 * oscillation).
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
  // Shadow bleed room inside the clip region (>= the shadow's max extent:
  // y-offset 4 + blur 12). p.top/p.left are the PILL's top-left (xterm's
  // clientY-36 / clientX placement); the wrapper offsets by the padding so
  // the pill lands exactly there. In above-mode the bottom padding is 0 —
  // the region's bottom edge must never reach the pointer (a region under
  // the cursor steals the mouse from the pane → hover-close oscillation),
  // so the below-the-pill part of the shadow is sacrificed there.
  const PAD = 14;
  const padBottom = p.above ? 0 : PAD;
  return (
    <div
      ref={ref}
      aria-hidden
      style={{
        position: "fixed",
        top: rect.y + (p.top ?? 0) - PAD,
        left: rect.x + (p.left ?? 0) - PAD,
        padding: `${PAD}px ${PAD}px ${padBottom}px ${PAD}px`,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 10px",
          background: "var(--ezy-surface-raised, #1c2128)",
          border: "1px solid var(--ezy-border, rgba(255,255,255,0.12))",
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
          boxShadow: "0 4px 12px rgba(0, 0, 0, 0.4)",
          whiteSpace: "nowrap",
          fontFamily: "var(--ezy-font-ui, system-ui, -apple-system, sans-serif)",
        }}
      >
        <span
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
            color: "var(--ezy-text-secondary, rgba(230,237,243,0.8))",
          }}
        >
          Open in MADE
        </span>
        <kbd
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
            padding: "1px 5px",
            background: "var(--ezy-surface, #161b22)",
            border: "1px solid var(--ezy-border, rgba(255,255,255,0.12))",
            borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
            color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
            fontFamily: "var(--ezy-font-ui, system-ui, -apple-system, sans-serif)",
          }}
        >
          Ctrl+Click
        </kbd>
      </div>
    </div>
  );
}

/**
 * Fullscreen-TUI scrollbar (kind "tui-scrollbar") for native panes. The pane is
 * running an alternate-screen TUI that owns its own scrollback, so this bar does
 * not show MADE history — it DRIVES the TUI by bouncing actions back to the
 * pane, which sends PgUp/PgDn. payload { pagesUp, span }: pagesUp 0 = bottom
 * (newest), pagesUp === span = top (oldest). The thumb is a FIXED size because
 * the TUI never reports how long its scrollback is; its position is the pane's
 * dead-reckoning estimate.
 *
 * The registered region element is a wide transparent hit-strip (not just the
 * visible track) so a vertical drag has horizontal slop before the pointer
 * leaves the overlay's clip region — outside it, events fall through to the
 * pane and the drag stalls (the overlay cannot OS-capture the mouse).
 *
 * Visual language is ported 1:1 from the xterm pane's jump-to-bottom button
 * (TerminalPaneXterm.tsx) per the xterm/native design-parity rule.
 */
function TuiScrollbar({
  msg,
  registerEl,
}: {
  msg: OverlayPopupMsg;
  registerEl: (id: string, el: HTMLElement | null) => void;
}) {
  const p = (msg.payload ?? {}) as {
    pos?: number;
    span?: number;
    accel?: boolean;
  };
  // Forwarded from the main webview's store — the overlay has no store.
  // Default ON so a payload from an older build still behaves as before.
  const accelOn = p.accel !== false;
  const span = Math.max(1, p.span ?? 300);
  const pos = Math.min(Math.max(0, p.pos ?? 0), span);
  const atBottom = pos === 0;

  const ref = useCallback(
    (el: HTMLElement | null) => registerEl(msg.id, el),
    [registerEl, msg.id],
  );
  const stripRef = useRef<HTMLDivElement | null>(null);
  const rect = msg.rect!;

  // The registered region steals the mouse from the native pane underneath, so
  // it must stay as narrow as possible: a permanent wide strip would break
  // text selection and clicks down the pane's right edge. At the bottom (the
  // common case) only the thin track is grabbable; once the user is scrolled
  // up they are already in "scrolling" mode, so we widen for drag slop and to
  // cover the jump-to-bottom button.
  const TRACK_W = 6;
  const PAD_Y = 6;
  const THUMB_H = 40; // FIXED — true length is unknown
  const trackH = Math.max(0, rect.height - PAD_Y * 2);
  // RELATIVE drag: pointer MOVEMENT maps to wheel notches, exactly like a
  // physical wheel where a detent is one notch. We deliberately do NOT seek to
  // an absolute position: the TUI never reports its scrollback length, so
  // "40% down the track" is a coordinate we invented, and walking to it forced
  // us to also invent a scroll RATE. Here the user's hand sets the rate, which
  // is the whole reason wheeling feels right.
  //
  // Base ratio maps a full-track drag onto the whole KNOWN scrollback.
  const pxPerNotch = Math.max(1, (trackH - THUMB_H) / span);

  // ── Drag acceleration ──────────────────────────────────────────────────
  // Slow drags stay 1:1 with the pointer so you can position precisely; fast
  // drags multiply, so a flick covers a lot of ground. Same idea as pointer
  // acceleration, and the reason a scrollbar over an unknown-length buffer can
  // feel good: precision when you want it, reach when you need it.
  //
  // Velocity is px/ms. Below ACCEL_FLOOR nothing changes (factor 1). Above it
  // the factor ramps linearly and is capped, so a violent flick cannot fire an
  // unbounded burst.
  const ACCEL_FLOOR = 0.4; // px/ms — below this, no acceleration at all
  const ACCEL_GAIN = 1.6; // multiplier growth per px/ms above the floor
  const ACCEL_MAX = 5; // hard cap
  const MIN_DT_MS = 8; // guards against divide-by-tiny on coalesced events

  const lastYRef = useRef(0);
  const lastTRef = useRef(0);
  const accumRef = useRef(0);
  // Optimistic position, used ONLY while dragging. The authoritative count
  // lives in the pane, but waiting for it (overlay -> IPC -> React -> payload
  // -> overlay) puts the thumb a frame or two behind the pointer, which reads
  // as the thumb "not keeping up" on fast drags. Render locally instead and
  // let the echoed payload take over again on release.
  const [dragPos, setDragPos] = useState<number | null>(null);
  const [hovered, setHovered] = useState(false);
  const dragPosRef = useRef(0);

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    lastYRef.current = e.clientY;
    lastTRef.current = e.timeStamp;
    accumRef.current = 0;
    dragPosRef.current = pos;
    setDragPos(pos);
  };

  const endDrag = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    setDragPos(null); // hand the thumb back to the authoritative count
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!(e.buttons & 1)) return;
    const dy = e.clientY - lastYRef.current;
    const dt = Math.max(MIN_DT_MS, e.timeStamp - lastTRef.current);
    lastYRef.current = e.clientY;
    lastTRef.current = e.timeStamp;

    // Setting off => strict 1:1, so dragging the thumb to the top lands at
    // the top. On => fast drags multiply, capped.
    const velocity = Math.abs(dy) / dt;
    const accel = accelOn
      ? Math.min(ACCEL_MAX, 1 + Math.max(0, velocity - ACCEL_FLOOR) * ACCEL_GAIN)
      : 1;

    // Dragging UP (dy < 0) scrolls toward OLDER content (positive notches).
    accumRef.current += (-dy / pxPerNotch) * accel;
    const whole = Math.trunc(accumRef.current);
    if (whole === 0) return;
    accumRef.current -= whole;

    dragPosRef.current = Math.max(0, dragPosRef.current + whole);
    setDragPos(dragPosRef.current);
    emitOverlayAction({ id: msg.id, action: "scrollBy", data: { notches: whole } });
  };

  // Hit-strip width. This region steals the mouse from the native pane, so it
  // stays narrow at rest (a permanent wide strip would kill text selection and
  // clicks down the pane's right edge). It MUST widen while dragging: if the
  // pointer drifts outside the region mid-drag the OS routes events to the
  // pane HWND instead of the overlay and the drag stalls — pointer capture
  // cannot save it, because capture is inside the webview and the routing
  // decision happens above it.
  const STRIP_W = dragPos !== null || !atBottom ? 44 : 16;

  // Right edge of the bar, held one resize-frame width inside the pane.
  //
  // The rightmost pane is flush with the window, so without this the strip
  // covers the window's East resize handle for the pane's whole height and the
  // window cannot be resized from the right (user-reported 2026-08-04). The
  // region clip in the popup-region loop already refuses to hand those pixels
  // to the overlay — but a clip alone would only shave the outer 2px off this
  // bar's 6px thumb, leaving it visibly narrower and lop-sidedly rounded on
  // that one pane.
  //
  // Applied in EVERY pane, not just the flush one, so every bar sits the same
  // distance inside its own pane and none of them looks like the odd one out.
  // Costs the inner panes 6px of inward shift over content the bar already
  // floats above.
  const stripRight = rect.x + rect.width - WINDOW_RESIZE_EDGE_PX;

  // While dragging, the thumb follows the optimistic count (and therefore
  // outruns the pointer when acceleration kicks in — that is the point).
  const shownPos = dragPos ?? pos;
  // frac 0 = bottom, 1 = top. Thumb travels the track minus its own height.
  const frac = Math.min(1, shownPos / Math.max(span, shownPos || 1));
  const thumbY = Math.max(0, (1 - frac) * (trackH - THUMB_H));

  // Jump-to-bottom rides just below the thumb (ported from the normal-buffer
  // xterm button) and only exists while the bar is STILL: any position change
  // hides it and restarts the idle timer, so it never chases a moving thumb.
  const [still, setStill] = useState(false);
  useEffect(() => {
    setStill(false);
    const t = window.setTimeout(() => setStill(true), JUMP_BTN_IDLE_MS);
    return () => clearTimeout(t);
  }, [shownPos]);
  const btnTop = Math.min(
    PAD_Y + thumbY + THUMB_H + JUMP_BTN_GAP_PX,
    rect.height - JUMP_BTN_BOTTOM_CLAMP_PX,
  );

  return (
    <div
      ref={(el) => {
        stripRef.current = el;
        ref(el);
      }}
      style={{
        position: "fixed",
        left: stripRight - STRIP_W,
        top: rect.y,
        width: STRIP_W,
        height: rect.height,
        pointerEvents: "auto",
        display: "flex",
        justifyContent: "flex-end",
        touchAction: "none",
      }}
    >
      {/* Track + thumb.
          Deliberately the SAME language as every other scrollbar in MADE
          (index.css:80-93 / overlay.css): transparent track, --ezy-border
          thumb, --ezy-border-light on hover. It previously used
          --ezy-text-muted (#8b949e) for the thumb over an always-filled track,
          which made it the brightest scrollbar in the app and read as a
          foreign widget pasted onto the pane. The track now only materialises
          on hover — the bar should be findable, not permanently loud, over a
          terminal already full of syntax colour. */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        style={{
          position: "relative",
          width: TRACK_W,
          margin: `${PAD_Y}px 4px`,
          borderRadius: TRACK_W / 2,
          // Track stays transparent at ALL times — exactly like the shell /
          // PowerShell pane's scrollbar (index.css:80-93 + .xterm-viewport).
          // The thumb alone carries the affordance.
          background: "transparent",
          cursor: "default",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: thumbY,
            left: 0,
            width: TRACK_W,
            height: THUMB_H,
            borderRadius: TRACK_W / 2,
            background:
              hovered || dragPos !== null
                ? "var(--ezy-border-light, #484f58)"
                : "var(--ezy-border, #30363d)",
            // Wheel notches arrive as discrete, unevenly-timed events, so the
            // raw position steps and reads as jitter. A short linear tween
            // absorbs that. NOT applied while dragging: there the thumb must
            // sit exactly under the pointer, and easing would feel like lag.
            transition:
              dragPos === null
                ? "top 90ms linear, background-color 120ms ease"
                : "background-color 120ms ease",
          }}
        />
      </div>

      {/* Jump-to-bottom — only while scrolled up AND the bar is still,
          positioned below the thumb exactly like the xterm pane's button. */}
      {!atBottom && still && dragPos === null && (
        <div
          onClick={() => emitOverlayAction({ id: msg.id, action: "toBottom" })}
          title="Jump to bottom"
          style={{
            position: "absolute",
            right: 12,
            top: btnTop,
            width: 22,
            height: 22,
            borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
            backgroundColor: "var(--ezy-surface-raised, #1c2128)",
            border: "1px solid var(--ezy-border, rgba(255,255,255,0.12))",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            opacity: 0.85,
            transition: "opacity 120ms ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.opacity = "1";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.opacity = "0.85";
          }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="var(--ezy-text-muted, rgba(230,237,243,0.5))"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="2,3 6,7 10,3" />
            <line x1="3" y1="9.5" x2="9" y2="9.5" />
          </svg>
        </div>
      )}
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
        borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
        fontSize: "calc(var(--ezy-font-scale, 1) * 14px)",
        lineHeight: 1.2,
        whiteSpace: "nowrap",
        maxWidth: Math.max(80, rect.width - 32),
        overflow: "hidden",
        textOverflow: "ellipsis",
        fontFamily: "var(--ezy-font-ui, Inter, system-ui, sans-serif)",
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
        borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
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
  // Menu items render their own tooltips — the overlay cannot publish a popup
  // to itself, so `title=` here would be the OS tooltip the rest of the app no
  // longer uses (this is why "Split Down" still looked like Windows chrome).
  //
  // Registered as its own region element: a chip for the FIRST row is drawn
  // above the panel, well outside the shadow-pad slack, and anything outside a
  // registered rect is clipped away by the window region and never painted.
  const registerTip = useCallback(
    (el: HTMLDivElement | null) => registerEl(`${msg.id}::tip`, el),
    [registerEl, msg.id],
  );
  const tip = useOverlayTip(registerTip);
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
    tip.hide();
    closeLocal(msg.id);
    emitOverlayAction({ id: msg.id, action: "__dismiss__" });
  };
  // Modifier state rides along (Chromium fills MouseEvent modifiers from the
  // OS message even though this NOACTIVATE window never has keyboard focus) —
  // the URL popover uses ctrl-click for open-in-external-browser.
  // `sticky` items keep the menu OPEN (mode toggles): no local close, so the
  // overlay window is never hidden and re-shown — main just pushes an updated
  // payload and the row's checkmark flips in place. Everything else keeps the
  // optimistic local close (see closeLocal's docs: the region must be restored
  // in the same commit, not after the overlay->main->overlay round-trip).
  const runItem = (
    actionId: string,
    e?: { ctrlKey: boolean; metaKey: boolean },
    sticky?: boolean,
  ) => {
    // Deliberate interaction — the label has done its job and is now in the way
    // (a sticky row keeps the menu open, so a stale chip would just sit there).
    tip.hide();
    if (!sticky) closeLocal(msg.id);
    emitOverlayAction({
      id: msg.id,
      action: actionId,
      data: { ctrl: !!e && (e.ctrlKey || e.metaKey) },
    });
  };

  const anchor = msg.rect!;
  const placement = p.placement ?? "below-start";
  // Cursor placement touches the pointer; every other placement keeps its gap.
  const gap = placement === "cursor" ? 0 : (p.gap ?? 4);
  let top: number;
  let left: number;

  if (placement === "cursor") {
    // Native right-click convention: top-left corner at the point, and FLIP to
    // the other side of the cursor when it would overflow. Clamping instead
    // would slide the menu under the pointer, so the button-up that opened it
    // could land on a row.
    top = anchor.y;
    if (menuSize.h > 0 && top + menuSize.h > window.innerHeight - 8) {
      top = Math.max(8, anchor.y - menuSize.h);
    }
    left = anchor.x;
    if (menuSize.w > 0 && left + menuSize.w > window.innerWidth - 8) {
      left = Math.max(8, anchor.x - menuSize.w);
    }
  } else {
    if (placement.startsWith("below")) {
      top = anchor.y + anchor.height + gap;
      if (menuSize.h > 0 && top + menuSize.h > window.innerHeight - 8) {
        top = Math.max(8, anchor.y - gap - menuSize.h);
      }
    } else {
      top = anchor.y - gap - menuSize.h;
      if (top < 8) top = Math.min(anchor.y + anchor.height + gap, window.innerHeight - 8 - menuSize.h);
    }
    if (placement.endsWith("start")) {
      left = anchor.x;
    } else {
      left = anchor.x + anchor.width - menuSize.w;
    }
    left = Math.max(8, Math.min(left, window.innerWidth - menuSize.w - 8));
  }
  top = Math.max(8, top);

  return (
    <div
      // NOT a full-screen `pointerEvents: "auto"` catcher, which is what this
      // was. The overlay window is hit-testable wherever ANY popup has a rect —
      // the region driver unions them all, and a tooltip is a popup too. So a
      // full-screen catcher here swallowed presses nowhere near this menu:
      // hovering any button in the app puts a tooltip rect into the region, and
      // a press inside that rect fell through the tooltip (which is correctly
      // `pointerEvents: none`) straight onto this backdrop and dismissed a menu
      // the user never touched.
      //
      // The catcher only ever needed to cover the shadow-pad ring around the
      // panel — the margin the region adds so the drop shadow is not clipped
      // (MENU_SHADOW_PAD, see the region driver). The user reads that ring as
      // part of the menu, so a press there should dismiss. Anywhere else in the
      // overlay is not this menu's business.
      style={{ position: "fixed", inset: 0, pointerEvents: "none" }}
      onContextMenu={(e) => {
        e.preventDefault();
      }}
    >
      {/* Dismiss catcher: exactly the panel plus its shadow ring. Rendered
          BEFORE the panel so the panel stacks above it and its own handlers
          win. Gated on a measured panel — before that the rect is meaningless
          and the menu is still `visibility: hidden`. */}
      {menuSize.h > 0 && (
        <div
          style={{
            position: "absolute",
            top: top - MENU_SHADOW_PAD,
            left: left - MENU_SHADOW_PAD,
            width: menuSize.w + MENU_SHADOW_PAD * 2,
            height: menuSize.h + MENU_SHADOW_PAD * 2,
            pointerEvents: "auto",
          }}
          onPointerDown={dismiss}
        />
      )}
      <div
        ref={setRef}
        // Popup panels sit on --ezy-surface-raised, several steps lighter than
        // a terminal pane, so the pane scrollbar's --ezy-border thumb nearly
        // disappears against them. See `.ezy-popup-scroll` in overlay.css.
        className="ezy-popup-scroll"
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
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 8px)",
          background: "var(--ezy-surface-raised, #1c2128)",
          border: "1px solid var(--ezy-border, rgba(255,255,255,0.08))",
          boxShadow: "0 10px 30px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.35)",
          color: "var(--ezy-text, #e6edf3)",
          fontFamily: "var(--ezy-font-ui, Inter, system-ui, sans-serif)",
          // REQUIRED: the wrapper is now `pointerEvents: none` (see above), and
          // that inherits. Without this the panel — and every item in it — is
          // click-dead, which is a far worse bug than the one being fixed.
          pointerEvents: "auto",
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        // A scrolling list (prompt history) drags rows out from under an open
        // chip, which would then describe whatever row slid into its place.
        onScroll={() => tip.hide()}
        // Hover-to-open mode: report pointer presence so the main side keeps
        // the menu open only while the pointer is inside button or menu.
        onMouseEnter={
          p.hoverTracking
            ? () => emitOverlayAction({ id: msg.id, action: "__hoverin__" })
            : undefined
        }
        onMouseLeave={
          p.hoverTracking
            ? () => emitOverlayAction({ id: msg.id, action: "__hoverout__" })
            : undefined
        }
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
                  fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
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
                  item.disabled
                    ? undefined
                    : (e) => runItem(item.actionId, e, item.sticky)
                }
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 12px",
                  paddingLeft: 12 + (item.indent ?? 0) * 14,
                  fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                  cursor: item.disabled ? "default" : "pointer",
                  // Disabled rows stay legible rather than ghosting out: the
                  // point of showing them is to say "this belongs here, just
                  // not right now", and the reason tooltip has to be readable
                  // enough that people hover it.
                  opacity: item.disabled ? 0.45 : 1,
                  color: item.danger
                    ? "var(--ezy-red, #f85149)"
                    : "var(--ezy-text, #e6edf3)",
                }}
                onMouseEnter={(e) => {
                  if (!item.disabled)
                    e.currentTarget.style.background =
                      "var(--ezy-surface, rgba(255,255,255,0.06))";
                  // Two tooltips share one code path. A disabled row explains
                  // ITSELF (and still receives mouse events, which is what makes
                  // the explanation reachable at all); an enabled row shows the
                  // full text behind an ellipsized label. Never both — a reason
                  // beats a label the row is not offering anyway.
                  const text = item.disabledReason ?? item.tooltip;
                  if (text && !echoesRowText(e.currentTarget, text)) {
                    tip.showAfterDelay(
                      e.currentTarget,
                      text,
                      item.disabledReason ? undefined : item.tooltipHint,
                    );
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                  tip.hide();
                }}
              >
                {item.swatch && (
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
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
                        fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
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
                      fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
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
                      fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
                      fontWeight: 700,
                      letterSpacing: 0.4,
                      padding: "1px 5px",
                      borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
                      flexShrink: 0,
                    }}
                  >
                    {item.badge}
                  </span>
                )}
                {item.trailing && (
                  <span
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
                      borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                      color: "var(--ezy-text-muted, rgba(230,237,243,0.6))",
                      flexShrink: 0,
                      cursor: "pointer",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background =
                        "var(--ezy-surface-raised, rgba(255,255,255,0.1))";
                      if (item.trailing?.title)
                        tip.showAfterDelay(e.currentTarget, item.trailing.title);
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "transparent";
                      tip.hide();
                    }}
                  >
                    {CTX_ICONS[item.trailing.iconId]}
                  </span>
                )}
              </div>
            ))}
            {section.swatches && section.swatches.length > 0 && (
              // Swatch grid, ported from the standalone SwatchMenu renderer so
              // a colour picker can be a SECTION of a menu rather than a second
              // popup. Same 20px tiles, same selected ring — this must not
              // become a parallel design.
              <div
                style={{
                  display: "flex",
                  gap: 4,
                  flexWrap: "wrap",
                  padding: "4px 12px 6px",
                  maxWidth: 176,
                }}
              >
                {section.swatches.map((sw) => (
                  <div
                    key={sw.actionId}
                    onClick={(e) => runItem(sw.actionId, e)}
                    onMouseEnter={(e) => tip.showAfterDelay(e.currentTarget, sw.label)}
                    onMouseLeave={() => tip.hide()}
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                      background: sw.color ?? "var(--ezy-surface, #161b22)",
                      border: sw.selected
                        ? sw.color
                          ? "2px solid #fff"
                          : "2px solid var(--ezy-text, #e6edf3)"
                        : sw.color
                          ? "1px solid transparent"
                          : "1px solid var(--ezy-border, rgba(255,255,255,0.12))",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
                      color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
                    }}
                  >
                    {sw.color ? "" : "×"}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {tip.node}
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
    fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
    color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
    background: "transparent",
    boxShadow: "inset 0 0 0 1px var(--ezy-border, rgba(255,255,255,0.15))",
    border: "none",
    borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
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
        borderRadius: "calc(var(--ezy-radius-scale, 1) * 8px)",
        padding: "10px 12px",
        color: "var(--ezy-text, #e6edf3)",
        fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        fontFamily: "var(--ezy-font-ui, Inter, system-ui, sans-serif)",
        pointerEvents: "auto",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: "calc(var(--ezy-radius-scale, 1) * 8px)",
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
              fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
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
            fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
          }}
        >
          {p.tool}
        </div>
      )}
      {p.error && (
        <div
          style={{
            color: "var(--ezy-red, #f85149)",
            fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
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
                fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                fontWeight: 600,
                color: "#fff",
                background: "var(--ezy-red, #f85149)",
                border: "none",
                borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
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
 * The tooltip chip itself — the ONE tooltip visual in the app.
 *
 * Used by two callers: `Tooltip` (every `data-tooltip` element in the main
 * webview, routed here by TooltipHost) and the overlay's own menus, which
 * cannot publish a popup to themselves and so render this directly.
 *
 * Every colour comes from the active theme — the app ships 14, from Black Steel
 * (#09090b) to the LIGHT Panini (#f3ecd8), so nothing here may be hardcoded.
 * Fill is --ezy-surface-raised, ink is --ezy-text.
 *
 * The outline and the hard offset are both --ezy-border-light, which is the one
 * token guaranteed to contrast against the background in every theme (mid-tones
 * on the dark ones, #bfb492 on the light one). A literal black shadow was not an
 * option: it disappears on the near-black themes and is wrong on the light one.
 * Using a single colour for outline + offset also matches the sticker-style
 * reference this was designed from.
 *
 * Geometry is set imperatively in a layout effect, NOT via state: OverlayRoot's
 * region effect reads these rects in the same commit (child layout effects run
 * before the parent's), so a state round-trip would clip the window region to
 * the pre-positioned rect for a frame. The arrow lives INSIDE the wrapper for
 * the same reason — anything outside that rect is outside the window region
 * and simply is not drawn.
 */
export interface TipAnchor {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Hard-offset shadow distance, px. Drives BOTH the drop-shadow filter and the
 *  wrapper padding that keeps the offset inside the registered rect — keep it
 *  one constant so those two can never drift apart. */
const TIP_SHADOW = 2;

/** Hover dwell for the overlay's own tooltips. Must match TooltipHost's
 *  SHOW_DELAY_MS — a menu tooltip that appears on a different beat than the
 *  rest of the app reads as a different feature. */
const TIP_DELAY_MS = 600;

function TipChip({
  anchor,
  text,
  shortcut,
  hint,
  register,
}: {
  anchor: TipAnchor;
  text: string;
  shortcut?: string;
  /** Secondary line, always on its own row under the main text. For the
   *  "what you can do with this" half of a label — an instruction like
   *  "Double-click to open in file manager" must not reflow into the middle of
   *  a wrapped file path. */
  hint?: string;
  /** Registers the wrapper for the window region. Omit inside backdrop popups,
   *  which set no region at all and can paint anywhere. */
  register?: (el: HTMLDivElement | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const chipRef = useRef<HTMLDivElement | null>(null);
  const outerRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      wrapRef.current = el;
      register?.(el);
    },
    [register],
  );

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const chip = chipRef.current;
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!wrap || !chip || !outer || !inner) return;

    const GAP = 6; // clear space between the chip edge and the anchor
    const EDGE = 6; // minimum distance from the window edge
    const IN = 6; // inner (fill) triangle half-width / height
    const OUT = 7; // outer (outline) triangle — 1px larger, so the outline shows
    const SHADOW = TIP_SHADOW; // hard offset; also padded for, below

    const cw = chip.offsetWidth;
    const ch = chip.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Prefer above the anchor. The tooltip must never land under the cursor:
    // its pixels belong to the overlay window, so hovering it would steal the
    // pointer from the pane below and oscillate open/closed. Anchoring to the
    // element rect (never the cursor) plus GAP guarantees clearance.
    const totalH = ch + OUT;
    const below = anchor.top - GAP < totalH + EDGE;
    const top = below ? anchor.bottom + GAP : anchor.top - GAP - totalH;

    const centerX = (anchor.left + anchor.right) / 2;
    // Clamp against the chip plus its shadow, so the offset never falls off
    // the right edge of the window.
    const left = Math.max(
      EDGE,
      Math.min(centerX - cw / 2, vw - cw - SHADOW - EDGE),
    );

    // The arrow sits in wrapper padding and the shadow gets its own padding on
    // the right/bottom, so the entire silhouette stays inside the wrapper's
    // rect — the window region is built from that rect, and anything outside
    // it is clipped away and never painted.
    wrap.style.paddingTop = below ? `${OUT}px` : "0px";
    wrap.style.paddingBottom = below ? `${SHADOW}px` : `${OUT + SHADOW}px`;
    wrap.style.paddingRight = `${SHADOW}px`;
    wrap.style.left = `${Math.round(left)}px`;
    wrap.style.top = `${Math.round(Math.max(EDGE, Math.min(top, vh - totalH - SHADOW - EDGE)))}px`;
    wrap.style.visibility = "visible";

    // Arrow tracks the anchor's centre even after the chip is clamped to the
    // window edge, so it keeps pointing at the thing it describes.
    const arrowX = Math.max(OUT + 2, Math.min(centerX - left, cw - OUT - 2));

    // Two stacked triangles: the outer one is the outline colour, the inner
    // one is the fill, pulled 1px back over the chip's own border so the
    // outline runs continuously around the point instead of being cut off by
    // the chip edge.
    if (below) {
      // Points UP at the anchor above it.
      outer.style.top = "0px";
      outer.style.borderTopWidth = "0px";
      outer.style.borderBottomWidth = `${OUT}px`;
      outer.style.borderBottomColor = "var(--ezy-border-light, #484f58)";
      // Base lands at OUT+1 (just past the chip's 1px top border) so the
      // border does not draw a line across the arrow's mouth.
      inner.style.top = `${OUT - IN + 1}px`;
      inner.style.borderTopWidth = "0px";
      inner.style.borderBottomWidth = `${IN}px`;
      inner.style.borderBottomColor = "var(--ezy-surface-raised, #1c2128)";
    } else {
      // Points DOWN at the anchor below it.
      outer.style.top = `${ch}px`;
      outer.style.borderBottomWidth = "0px";
      outer.style.borderTopWidth = `${OUT}px`;
      outer.style.borderTopColor = "var(--ezy-border-light, #484f58)";
      inner.style.top = `${ch - 1}px`;
      inner.style.borderBottomWidth = "0px";
      inner.style.borderTopWidth = `${IN}px`;
      inner.style.borderTopColor = "var(--ezy-surface-raised, #1c2128)";
    }
    outer.style.left = `${Math.round(arrowX - OUT)}px`;
    inner.style.left = `${Math.round(arrowX - IN)}px`;
  });

  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        left: 0,
        top: 0,
        // max-content, not a measured width: an absolutely-positioned chip in a
        // zero-width container would wrap every label to one character.
        width: "max-content",
        visibility: "hidden",
        pointerEvents: "none",
        zIndex: 100,
        // drop-shadow (not box-shadow) so the hard offset follows the composite
        // silhouette — chip AND arrow — as one shape. A box-shadow would draw a
        // rectangle behind the chip and ignore the point.
        filter: `drop-shadow(${TIP_SHADOW}px ${TIP_SHADOW}px 0 var(--ezy-border-light, #484f58))`,
        // Placed in the layout effect above.
      }}
    >
      <div
        ref={chipRef}
        style={{
          position: "relative",
          background: "var(--ezy-surface-raised, #1c2128)",
          color: "var(--ezy-text, #e6edf3)",
          border: "1px solid var(--ezy-border-light, #484f58)",
          // Rectangular by design; 2px only takes the bite off the corners.
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 2px)",
          padding: "5px 9px",
          fontSize: "calc(var(--ezy-font-scale, 1) * 11.5px)",
          fontWeight: 500,
          lineHeight: 1.35,
          letterSpacing: "0.01em",
          maxWidth: 280,
          // Long file paths are the common case here — wrap them instead of
          // running off the edge of the window like the old nowrap chip did.
          overflowWrap: "anywhere",
          fontFamily: "var(--ezy-font-ui, Inter, system-ui, sans-serif)",
          display: "flex",
          flexDirection: "column",
          alignItems: "stretch",
          gap: 4,
          animation: "ezy-tip-in 90ms ease-out",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span>{text}</span>
        {shortcut && (
          <span
            style={{
              flexShrink: 0,
              background: "var(--ezy-surface, #161b22)",
              color: "var(--ezy-text-secondary, #c9d1d9)",
              border: "1px solid var(--ezy-border-light, #484f58)",
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 2px)",
              padding: "0 4px",
              fontSize: "calc(var(--ezy-font-scale, 1) * 10.5px)",
              fontWeight: 600,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {shortcut}
          </span>
        )}
        </div>
        {hint && (
          <div
            style={{
              borderTop: "1px solid var(--ezy-border, #30363d)",
              paddingTop: 4,
              fontSize: "calc(var(--ezy-font-scale, 1) * 10.5px)",
              fontWeight: 500,
              color: "var(--ezy-text-muted, #8b949e)",
            }}
          >
            {hint}
          </div>
        )}
      </div>
      <div
        ref={outerRef}
        style={{
          position: "absolute",
          width: 0,
          height: 0,
          borderLeftWidth: 7,
          borderRightWidth: 7,
          borderStyle: "solid",
          borderLeftColor: "transparent",
          borderRightColor: "transparent",
          borderTopColor: "transparent",
          borderBottomColor: "transparent",
          borderTopWidth: 0,
          borderBottomWidth: 0,
        }}
      />
      <div
        ref={innerRef}
        style={{
          position: "absolute",
          width: 0,
          height: 0,
          borderLeftWidth: 6,
          borderRightWidth: 6,
          borderStyle: "solid",
          borderLeftColor: "transparent",
          borderRightColor: "transparent",
          borderTopColor: "transparent",
          borderBottomColor: "transparent",
          borderTopWidth: 0,
          borderBottomWidth: 0,
        }}
      />
    </div>
  );
}

/**
 * True when a row already shows the whole tooltip on screen, so the chip would
 * only repeat it back.
 *
 * The main webview drops those in TooltipHost (`repeatsVisibleText`); overlay
 * rows need the same rule or the two tooltip surfaces disagree about what is
 * worth saying. A prompt-history row is the case that matters: the label is
 * `#12  <prompt>` clipped at 320px, so the full prompt is genuinely unreadable
 * — until the prompt is short, and then a chip saying exactly what the row says
 * is pure noise.
 *
 * `includes`, not equality: the visible text carries extras the tooltip does
 * not (the `#12` index, the right-aligned timestamp, a session's relative
 * time). Clipping is measured on the descendants too — the ellipsized node is
 * a child span, never the row itself.
 */
function echoesRowText(row: HTMLElement, text: string): boolean {
  const visible = (row.textContent ?? "").replace(/\s+/g, " ").trim();
  const tip = text.replace(/\s+/g, " ").trim();
  if (!visible || !tip || !visible.includes(tip)) return false;
  if (row.scrollWidth > row.clientWidth + 1) return false;
  for (const child of row.querySelectorAll<HTMLElement>("*")) {
    if (child.scrollWidth > child.clientWidth + 1) return false;
  }
  return true;
}

/**
 * Hover tooltip for the overlay's OWN elements (menu rows, trailing buttons).
 *
 * The main webview drives its tooltips through TooltipHost -> kind "tooltip".
 * The overlay cannot do that: it would be publishing a popup to itself. So
 * anything inside a menu tracks its own hover here and renders TipChip
 * directly — same chip, same 400ms dwell, so the two are indistinguishable.
 *
 * The window region is the union of the REGISTERED popup rects (backdrop mode
 * is gone), so a chip that can stray outside its menu's padded rect must be
 * registered as its own region element or it gets clipped — pass `register`
 * for that. Menus whose chips always stay inside the MENU_SHADOW_PAD slack
 * (the compact context menus) may omit it.
 */
function useOverlayTip(register?: (el: HTMLDivElement | null) => void) {
  const [tip, setTip] = useState<{
    anchor: TipAnchor;
    text: string;
    hint?: string;
  } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hide = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setTip(null);
  }, []);

  const showAfterDelay = useCallback(
    (el: HTMLElement, text: string, hint?: string) => {
      if (timer.current) clearTimeout(timer.current);
      // Settings > General > Behavior > "Hover tooltips". The overlay has no
      // store, so the flag rides the theme-var channel (App.tsx) — read live
      // rather than cached, since a toggle re-emits the vars mid-session.
      if (
        getComputedStyle(document.documentElement)
          .getPropertyValue("--ezy-hover-tips")
          .trim() === "0"
      ) {
        return;
      }
      timer.current = setTimeout(() => {
        timer.current = null;
        if (!el.isConnected) return;
        const r = el.getBoundingClientRect();
        setTip({
          anchor: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
          text,
          hint,
        });
      }, TIP_DELAY_MS);
    },
    [],
  );

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const node = tip ? (
    <TipChip
      anchor={tip.anchor}
      text={tip.text}
      hint={tip.hint}
      register={register}
    />
  ) : null;
  return { showAfterDelay, hide, node };
}

/**
 * Generic display-only tooltip (kind "tooltip") — the main webview's tooltips,
 * published by TooltipHost. Payload: { anchor, text, shortcut? }; the legacy
 * { x, y, text } point form is still accepted as a zero-size anchor.
 */
function Tooltip({
  msg,
  registerEl,
}: {
  msg: OverlayPopupMsg;
  registerEl: (id: string, el: HTMLElement | null) => void;
}) {
  const p = (msg.payload ?? {}) as {
    x?: number;
    y?: number;
    text?: string;
    shortcut?: string;
    hint?: string;
    anchor?: TipAnchor;
  };
  const register = useCallback(
    (el: HTMLDivElement | null) => registerEl(msg.id, el),
    [registerEl, msg.id],
  );
  const anchor = p.anchor ?? {
    left: p.x ?? 0,
    right: p.x ?? 0,
    top: p.y ?? 0,
    bottom: p.y ?? 0,
  };
  return (
    <TipChip
      anchor={anchor}
      text={p.text ?? ""}
      shortcut={p.shortcut}
      hint={p.hint}
      register={register}
    />
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
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 8px)",
          padding: 8,
          boxShadow: "0 12px 36px rgba(0,0,0,0.5)",
          fontFamily: "var(--ezy-font-ui, Inter, system-ui, sans-serif)",
        }}
      >
        <div
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
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
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
              background: "var(--ezy-surface, #161b22)",
              border:
                p.selected == null
                  ? "2px solid var(--ezy-text, #e6edf3)"
                  : "1px solid var(--ezy-border, rgba(255,255,255,0.12))",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
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
                borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
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
  /** Jira project — gets a distinct JIRA chip so it can't be mistaken for a
   *  normal project row. */
  jira?: boolean;
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
/**
 * Per-project notification-sound picker (kind "sound-picker"), opened from the
 * tab context menu's "Notification sound…" item. Same backdrop/shell contract
 * as RecentMenu below. Rows: 10 sounds then "No sound"; each shows a reserved
 * checkmark slot (labels stay aligned), the sound name, which projects use it
 * (solid project-color dot + muted name, capped, "+N" overflow — so an unused
 * sound is easy to spot), and a ▶ preview that plays WITHOUT closing (the
 * act(action, false) stay-open contract). Payload is frozen at open by the
 * main-side host — the menu never changes size while visible.
 */
function SoundPickerMenu({
  msg,
  registerEl,
  closeLocal,
}: {
  msg: OverlayPopupMsg;
  registerEl: (id: string, el: HTMLElement | null) => void;
  closeLocal: (id: string) => void;
}) {
  const p = (msg.payload ?? {}) as {
    current?: string | null;
    rows?: Array<{
      id: string;
      label: string;
      users: Array<{ name: string; color: string | null }>;
      overflow: number;
    }>;
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
  const act = (action: string, closes: boolean) => {
    if (closes) closeLocal(msg.id);
    emitOverlayAction({ id: msg.id, action });
  };

  const WIDTH = 300;
  const left = Math.max(8, Math.min(anchor.x, window.innerWidth - WIDTH - 8));
  const top = anchor.y + anchor.height + 2;

  const check = (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06l2.72 2.72 6.72-6.72a.75.75 0 011.06 0z" />
    </svg>
  );

  const row = (opts: {
    key: string;
    label: string;
    selected: boolean;
    users?: Array<{ name: string; color: string | null }>;
    overflow?: number;
    previewId?: string;
    pickAction: string;
    muted?: boolean;
  }) => (
    <div
      key={opts.key}
      onClick={() => act(opts.pickAction, true)}
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
        padding: "6px 12px",
        cursor: "pointer",
        fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
        minWidth: 0,
      }}
    >
      {/* Reserved slot: labels align whether or not a checkmark shows. */}
      <span
        style={{
          width: 14,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          color: "var(--ezy-accent, #10a37f)",
        }}
      >
        {opts.selected ? check : null}
      </span>
      <span
        style={{
          color: opts.muted
            ? "var(--ezy-text-muted, rgba(230,237,243,0.5))"
            : "var(--ezy-text, #e6edf3)",
          flexShrink: 0,
        }}
      >
        {opts.label}
      </span>
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginLeft: "auto",
          minWidth: 0,
          overflow: "hidden",
        }}
      >
        {(opts.users ?? []).map((u, i) => (
          <span
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              minWidth: 0,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "calc(var(--ezy-radius-scale, 1) * 8px)",
                background: u.color ?? "var(--ezy-text-muted, rgba(230,237,243,0.5))",
                flexShrink: 0,
              }}
            />
            <span
              style={{
                fontSize: "calc(var(--ezy-font-scale, 1) * 10.5px)",
                color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
                maxWidth: 72,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {u.name}
            </span>
          </span>
        ))}
        {(opts.overflow ?? 0) > 0 && (
          <span
            style={{
              fontSize: "calc(var(--ezy-font-scale, 1) * 10.5px)",
              color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
              flexShrink: 0,
            }}
          >
            +{opts.overflow}
          </span>
        )}
      </span>
      {opts.previewId ? (
        <svg
          onClick={(e) => {
            e.stopPropagation();
            act(`preview:${opts.previewId}`, false);
          }}
          role="button"
          aria-label={`Preview ${opts.label}`}
          width="20"
          height="20"
          viewBox="0 0 16 16"
          fill="currentColor"
          style={{
            flexShrink: 0,
            padding: 2,
            cursor: "pointer",
            color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--ezy-text, #e6edf3)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color =
              "var(--ezy-text-muted, rgba(230,237,243,0.5))";
          }}
        >
          <path d="M4.75 2.57a.75.75 0 011.14-.64l8 5.43a.75.75 0 010 1.28l-8 5.43a.75.75 0 01-1.14-.64V2.57z" />
        </svg>
      ) : (
        // Keep row height/width identical to preview rows.
        <span style={{ width: 20, height: 20, flexShrink: 0 }} />
      )}
    </div>
  );

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
          width: WIDTH,
          maxHeight: Math.max(120, window.innerHeight - top - 8),
          overflowY: "auto",
          background: "var(--ezy-surface-raised, #1c2128)",
          border: "1px solid var(--ezy-border, rgba(255,255,255,0.12))",
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 8px)",
          boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
          color: "var(--ezy-text, #e6edf3)",
          fontFamily: "var(--ezy-font-ui, Inter, system-ui, sans-serif)",
        }}
      >
        <div
          style={{
            padding: "6px 12px",
            fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
            borderBottom: "1px solid var(--ezy-border, rgba(255,255,255,0.12))",
          }}
        >
          Notification sound
        </div>
        {(p.rows ?? []).map((r) =>
          row({
            key: r.id,
            label: r.label,
            selected: p.current === r.id,
            users: r.users,
            overflow: r.overflow,
            previewId: r.id,
            pickAction: `pick:${r.id}`,
          }),
        )}
        <div
          style={{
            height: 1,
            background: "var(--ezy-border, rgba(255,255,255,0.12))",
            margin: "4px 0",
          }}
        />
        {row({
          key: "none",
          label: "No sound",
          selected: p.current === null,
          pickAction: "pick:none",
          muted: true,
        })}
      </div>
    </div>
  );
}

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
    hoverTracking?: boolean;
  };
  const ref = useCallback(
    (el: HTMLElement | null) => registerEl(msg.id, el),
    [registerEl, msg.id],
  );
  // Branded hover tooltips (TipChip — same chip as the main webview's
  // TooltipHost; never `title=`, which renders the unthemed OS tooltip).
  // Registered as its own region element: rows anchor chips near the menu's
  // top edge, outside the shadow-pad slack.
  const registerTip = useCallback(
    (el: HTMLDivElement | null) => registerEl(`${msg.id}::tip`, el),
    [registerEl, msg.id],
  );
  const tip = useOverlayTip(registerTip);
  const anchor = msg.rect!;
  const dismiss = () => {
    tip.hide();
    closeLocal(msg.id);
    emitOverlayAction({ id: msg.id, action: "__dismiss__" });
  };
  // Closing actions remove the popup locally; row-level toggles keep it open
  // (main re-emits fresh payload).
  const act = (action: string, closes: boolean) => {
    tip.hide(); // deliberate interaction — the label has served its purpose
    if (closes) closeLocal(msg.id);
    emitOverlayAction({ id: msg.id, action });
  };

  const headerStyle: CSSProperties = {
    padding: "6px 12px",
    fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
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
    borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
    background: "transparent",
    color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
    fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
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
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 8px)",
          boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
          color: "var(--ezy-text, #e6edf3)",
          fontFamily: "var(--ezy-font-ui, Inter, system-ui, sans-serif)",
          // Flex + per-child `order`: CREATE and OPEN render first, the recent
          // list sinks below them (order 29+ on its header/rows) without
          // relocating 200 lines of row JSX.
          display: "flex",
          flexDirection: "column",
        }}
        // Hover-to-open mode: report pointer presence so the main side keeps
        // the menu open only while the pointer is inside button or menu.
        onMouseEnter={p.hoverTracking ? () => act("__hoverin__", false) : undefined}
        onMouseLeave={p.hoverTracking ? () => act("__hoverout__", false) : undefined}
      >
        <div style={{ ...headerStyle, order: 30 }}>Recent Projects</div>
        {(p.projects ?? []).map((project) => (
          <div
            key={project.key}
            onClick={() => {
              if (!project.disabled) act(`open:${project.key}`, true);
            }}
            onMouseEnter={(e) => {
              if (!project.disabled)
                e.currentTarget.style.background =
                  "var(--ezy-accent-glow, rgba(16,185,129,0.12))";
              tip.showAfterDelay(e.currentTarget, project.tooltip);
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              tip.hide();
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "7px 12px",
              cursor: project.disabled ? "not-allowed" : "pointer",
              fontSize: "calc(var(--ezy-font-scale, 1) * 13px)",
              opacity: project.disabled ? 0.5 : 1,
              order: 31,
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
                {project.jira && (
                  <span
                    style={{
                      flexShrink: 0,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 3,
                      fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
                      fontWeight: 700,
                      padding: "1px 6px",
                      borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
                      background: "var(--ezy-accent-dim, #0d8a6a)",
                      color: "#ffffff",
                      letterSpacing: "0.04em",
                    }}
                  >
                    <svg
                      width="8"
                      height="8"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
                      <path d="M5.5 6h5M5.5 9h3" />
                    </svg>
                    JIRA
                  </span>
                )}
                {project.badge && (
                  <span
                    style={{
                      flexShrink: 0,
                      fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
                      fontWeight: 600,
                      padding: "1px 6px",
                      borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
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
                  fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
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
                style={rowBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  act(`fresh:${project.key}`, true);
                }}
                onMouseEnter={(e) =>
                  tip.showAfterDelay(
                    e.currentTarget,
                    "Start fresh",
                    "Same layout, new sessions",
                  )
                }
                onMouseLeave={tip.hide}
              >
                <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 3a5 5 0 1 0 4.546 2.914.75.75 0 0 1 1.364-.626A6.5 6.5 0 1 1 8 1.5v-1a.25.25 0 0 1 .41-.192l2.36 1.966a.25.25 0 0 1 0 .384L8.41 4.624A.25.25 0 0 1 8 4.432V3Z" />
                </svg>
              </button>
            )}
            {project.showQuick && (
              <button
                onMouseEnter={(e) =>
                  tip.showAfterDelay(
                    e.currentTarget,
                    project.quickOn
                      ? `Quick open on — opens the saved ${project.paneCount}-pane layout`
                      : "Quick open off — opening asks for a layout",
                    project.quickOn ? "Click to disable" : "Click to enable",
                  )
                }
                onMouseLeave={tip.hide}
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
                style={{ ...rowBtn, letterSpacing: "0.04em" }}
                onClick={(e) => {
                  e.stopPropagation();
                  act(`backend:${project.key}`, false);
                }}
                onMouseEnter={(e) =>
                  tip.showAfterDelay(
                    e.currentTarget,
                    `Backend: ${project.backendLabel}`,
                    "Click to switch",
                  )
                }
                onMouseLeave={tip.hide}
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
        {/* Divider ABOVE the recent list (order 29 puts it just before the
            order-30 header at the menu's bottom). */}
        <div
          style={{
            height: 1,
            background: "var(--ezy-border, rgba(255,255,255,0.12))",
            margin: "2px 0",
            order: 29,
          }}
        />
        {/* CREATE — new work, locally or on a server (the modals ask where). */}
        <div style={headerStyle}>Create</div>
        <div
          onClick={() => {
            if (p.canCreate) act("create", true);
          }}
          onMouseEnter={(e) => {
            if (p.canCreate)
              e.currentTarget.style.background =
                "var(--ezy-accent-glow, rgba(16,185,129,0.12))";
            tip.showAfterDelay(
              e.currentTarget,
              p.canCreate
                ? "Create a new project folder — locally or on a remote server"
                : "Set a projects directory in Settings or add a remote server first",
            );
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            tip.hide();
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 12px",
            cursor: p.canCreate ? "pointer" : "not-allowed",
            fontSize: "calc(var(--ezy-font-scale, 1) * 13px)",
            color: "var(--ezy-text-secondary, rgba(230,237,243,0.8))",
            opacity: p.canCreate ? 1 : 0.45,
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="var(--ezy-text-muted, rgba(230,237,243,0.5))"
          >
            <path d="M1.75 1h4.19c.51 0 .99.23 1.31.62l1 1.22c.09.12.24.16.38.16h5.62c.97 0 1.75.78 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25V2.75C0 1.78.78 1 1.75 1Z" />
          </svg>
          New Project...
        </div>
        <div
          onClick={() => act("jira", true)}
          onMouseEnter={(e) => {
            e.currentTarget.style.background =
              "var(--ezy-accent-glow, rgba(16,185,129,0.12))";
            tip.showAfterDelay(
              e.currentTarget,
              "Work Jira tickets against a source folder (local or remote), one pane per ticket",
            );
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            tip.hide();
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 12px",
            cursor: "pointer",
            fontSize: "calc(var(--ezy-font-scale, 1) * 13px)",
            color: "var(--ezy-text-secondary, rgba(230,237,243,0.8))",
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
            <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
            <path d="M5.5 6h5M5.5 9h3" />
          </svg>
          New Jira Project...
        </div>

        {/* OPEN — existing folders, local or on a server. */}
        <div
          style={{
            height: 1,
            background: "var(--ezy-border, rgba(255,255,255,0.12))",
            margin: "2px 0",
          }}
        />
        <div style={headerStyle}>Open</div>
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
            fontSize: "calc(var(--ezy-font-scale, 1) * 13px)",
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
          Local Folder...
        </div>
        {(p.servers ?? []).length > 0 && (
          <>
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
                  fontSize: "calc(var(--ezy-font-scale, 1) * 13px)",
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
                  Folder on {server.name}…
                </span>
              </div>
            ))}
          </>
        )}
      </div>
      {tip.node}
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
        borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
        padding: "3px 4px",
        fontFamily: "var(--ezy-font-ui, system-ui, -apple-system, sans-serif)",
        fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
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
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
          padding: "0 6px",
          color: "var(--ezy-text, #e6edf3)",
          fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
          outline: "none",
          caretColor: "var(--ezy-accent, #10a37f)",
          transition: "border-color 120ms ease",
        }}
      />
      {matchDisplay && (
        <span
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
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
        borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
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
        borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
        padding: "0 4px",
        cursor: "pointer",
        fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
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
    borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
    padding: "5px 8px",
    fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
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
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 8px)",
          boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
          fontFamily: "var(--ezy-font-ui, system-ui, -apple-system, sans-serif)",
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
                borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
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
                  fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
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
                borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
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
                      borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
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
                      fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
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
                    borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                    border: "1px solid var(--ezy-border, rgba(255,255,255,0.12))",
                    background: "transparent",
                    color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
                    fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
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
                    borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                    border: "none",
                    background: "var(--ezy-accent, #10a37f)",
                    color: "#0d1117",
                    fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
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
                    fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
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
                fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
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
                  borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
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
                    fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
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
              fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
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
  // Branded hover tooltips (TipChip — the same chip TooltipHost shows in the
  // main webview; never `title=`, which draws the unthemed OS tooltip this app
  // dropped everywhere else). Registered as its own region element: the top
  // row's chip is drawn above the panel, outside the panel's own rect.
  const registerTip = useCallback(
    (el: HTMLDivElement | null) => registerEl(`${msg.id}::tip`, el),
    [registerEl, msg.id],
  );
  const tip = useOverlayTip(registerTip);
  const inputRef = useRef<HTMLInputElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // Row awaiting "Remove from list" confirmation. One row at a time, and the
  // confirm renders INSIDE the row so the popup keeps its height — a list that
  // grows under the pointer is how you mis-click the row below.
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const editingIdRef = useRef<string | null>(null);
  editingIdRef.current = editingId;

  const act = (action: string, data?: unknown) => {
    tip.hide(); // deliberate interaction — the label has served its purpose
    emitOverlayAction({ id: msg.id, action, data });
  };
  const dismiss = () => {
    closeLocal(msg.id);
    act("__dismiss__");
  };

  // Focus handoff while mounted (the rename input needs real keystrokes).
  // Unlike the other two focus-handoff popups, nothing is autofocused on
  // mount (the rename input exists only after a rename click), so no input
  // onFocus ever reports the handoff to main. But taking the foreground blurs
  // the main webview, and OverlayDismissOwner's deferred blur check dismisses
  // every popup unless appWindowFocused recovers — which folds in
  // overlayFocused. Report the handoff explicitly or this popup dismisses
  // ITSELF ~150ms after opening. The unmount cleanup below is the paired
  // emit(false), so the flag cannot stick true (the hazard that forbids a
  // window-level focus emitter — see PaneSearch's input comment).
  useEffect(() => {
    let disposed = false;
    invoke("overlay_set_focusable", { focusable: true })
      .then(() => {
        if (!disposed) emitOverlayFocus(true);
      })
      .catch(() => {});
    return () => {
      disposed = true;
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

  // Escape: back out of whichever sub-state is open (rename, then remove
  // confirm), else dismiss (original behavior).
  const confirmRemoveIdRef = useRef<string | null>(null);
  confirmRemoveIdRef.current = confirmRemoveId;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (editingIdRef.current) setEditingId(null);
        else if (confirmRemoveIdRef.current) setConfirmRemoveId(null);
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
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 8px)",
          overflow: "hidden",
          boxShadow: "0 12px 36px rgba(0,0,0,0.5)",
          maxHeight: 340,
          fontFamily: "var(--ezy-font-ui, system-ui, -apple-system, sans-serif)",
        }}
      >
        <div
          style={{ overflowY: "auto", maxHeight: 296 }}
          // Rows scrolling under an open chip would leave it labelling the row
          // that slid into its place.
          onScroll={() => tip.hide()}
        >
          {sessions.length === 0 && (
            <div
              style={{
                padding: "8px 10px",
                fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
                opacity: 0.6,
              }}
            >
              No saved sessions
            </div>
          )}
          {sessions.map((session) => {
            const isEditing = editingId === session.id;
            const isConfirmingRemove = confirmRemoveId === session.id;
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
                {isConfirmingRemove ? (
                  <div
                    style={{
                      flex: 1,
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "6px 10px",
                      minWidth: 0,
                    }}
                  >
                    <span
                      style={{
                        flex: 1,
                        fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                        color: "var(--ezy-text-secondary, rgba(230,237,243,0.8))",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      // The prompt replaces the row, so the name it is asking
                      // about is no longer on screen — the chip is the only way
                      // to check you are about to forget the right one.
                      onMouseEnter={(e) =>
                        tip.showAfterDelay(
                          e.currentTarget,
                          session.name,
                          "Removes it from this list only — the CLI's own transcript stays on disk",
                        )
                      }
                      onMouseLeave={() => tip.hide()}
                    >
                      Remove from list?
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        act("remove", { id: session.id });
                        setConfirmRemoveId(null);
                      }}
                      style={{
                        fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                        fontWeight: 600,
                        color: "#fff",
                        background: "var(--ezy-red, #f85149)",
                        border: "none",
                        borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                        padding: "2px 8px",
                        cursor: "pointer",
                        fontFamily: "inherit",
                        flexShrink: 0,
                      }}
                    >
                      Remove
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmRemoveId(null);
                      }}
                      style={{
                        fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                        color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
                        background: "transparent",
                        boxShadow:
                          "inset 0 0 0 1px var(--ezy-border, rgba(255,255,255,0.15))",
                        border: "none",
                        borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                        padding: "2px 8px",
                        cursor: "pointer",
                        fontFamily: "inherit",
                        flexShrink: 0,
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : isEditing ? (
                  <input
                    ref={inputRef}
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    // No per-input emitOverlayFocus here: the mount effect owns
                    // the flag for this popup's whole lifetime (the handoff
                    // persists after the rename input blurs — the overlay stays
                    // the foreground window until the popup closes).
                    onBlur={submitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitRename();
                      if (e.key === "Escape") setEditingId(null);
                      e.stopPropagation();
                    }}
                    style={{
                      flex: 1,
                      padding: "5px 10px",
                      fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                      fontFamily: "inherit",
                      backgroundColor: "var(--ezy-bg, #0d1117)",
                      border: "1px solid var(--ezy-accent, #10a37f)",
                      borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
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
                        fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
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
                      // Whole row, not the name span: the dot and the time are
                      // part of the same target, and a 5px dot with its own
                      // tooltip is a thing nobody can hit on purpose. What the
                      // dot MEANT now rides in the hint line instead.
                      onMouseEnter={(e) => {
                        if (echoesRowText(e.currentTarget, session.name)) return;
                        tip.showAfterDelay(
                          e.currentTarget,
                          session.name,
                          session.isCurrent
                            ? "Current session"
                            : session.isFromStore
                              ? "Saved session — click to switch"
                              : "Historical session — click to resume",
                        );
                      }}
                      onMouseLeave={() => tip.hide()}
                    >
                      <span
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
                      >
                        {session.name}
                      </span>
                      {session.timeLabel && (
                        <span
                          style={{
                            fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
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
                        aria-label="Rename session"
                        style={{
                          cursor: "pointer",
                          padding: 4,
                          borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                          flexShrink: 0,
                          display: "flex",
                          alignItems: "center",
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.backgroundColor =
                            "var(--ezy-border, rgba(255,255,255,0.15))";
                          tip.showAfterDelay(e.currentTarget, "Rename session");
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.backgroundColor = "transparent";
                          tip.hide();
                        }}
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
                    {/* Remove from list. Registry rows only — a historical row
                        comes from the CLI's own transcripts and is not ours to
                        forget. Disabled on the pane's live session, which the
                        context poll re-registers within ~5s: a control that
                        undoes itself reads as broken, so say why instead. */}
                    {session.isFromStore && rowHover && (
                      <div
                        role="button"
                        aria-disabled={session.isCurrent || undefined}
                        aria-label="Remove from list"
                        style={{
                          cursor: session.isCurrent ? "default" : "pointer",
                          opacity: session.isCurrent ? 0.35 : 1,
                          padding: 4,
                          borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                          flexShrink: 0,
                          display: "flex",
                          alignItems: "center",
                        }}
                        // Dimmed-and-disabled needs its reason MORE than the
                        // live control does — the label says what the button is
                        // for, the hint says why it is not offering it here.
                        onMouseEnter={(e) => {
                          if (!session.isCurrent)
                            e.currentTarget.style.backgroundColor =
                              "var(--ezy-border, rgba(255,255,255,0.15))";
                          tip.showAfterDelay(
                            e.currentTarget,
                            "Remove from list",
                            session.isCurrent
                              ? "This pane is using the session — start or pick another one first"
                              : undefined,
                          );
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.backgroundColor = "transparent";
                          tip.hide();
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (session.isCurrent) return;
                          setConfirmRemoveId(session.id);
                        }}
                      >
                        <svg
                          width="9"
                          height="9"
                          viewBox="0 0 384 512"
                          fill="var(--ezy-text-muted, rgba(230,237,243,0.5))"
                        >
                          <path d="M342.6 150.6c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L192 210.7 86.6 105.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3L146.7 256 41.4 361.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0L192 301.3 297.4 406.6c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3L237.3 256 342.6 150.6z" />
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
              fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
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
      {tip.node}
    </div>
  );
}
