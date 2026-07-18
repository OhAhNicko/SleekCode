import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from "react";
import type { Terminal } from "@xterm/xterm";
import { useAppStore } from "../store";
import type { TerminalType, TerminalBackend } from "../types";
import type { CommandBlock } from "../lib/command-block-parser";
import {
  type NativeTermId,
  type SearchResult,
  type TerminalTheme as NativeTermTheme,
  rectOf,
  subscribeResized,
  subscribeExit,
  subscribeRButton,
  subscribeMousePassthrough,
  subscribeKeyDownPreview,
  subscribeScroll,
  subscribeFocusGained,
  subscribeFocusLost,
  nativeTermCreate,
  nativeTermDestroy,
  nativeTermSetFocused,
  nativeTermFocusKeyboard,
  nativeTermScrollToBottom,
  nativeTermScrollToLine,
  nativeTermSearch,
  nativeTermSearchClear,
  nativeTermSetSearchHighlights,
  nativeTermGetBufferLines,
  nativeTermGetViewportState,
  nativeTermSetTheme,
  nativeTermSetCursorStyle,
  nativeTermSetFont,
  nativeTermProposeDimensions,
} from "../lib/native-term-bridge";
import type { MadeTheme } from "../lib/themes";
import { useNativeCommandBlocks } from "../hooks/useNativeCommandBlocks";
import { useNativeFileLinks } from "../native-term/useNativeFileLinks";
import { usePtyNative } from "../hooks/usePtyNative";
import type { NativeRendererSlice } from "../store/nativeRendererSlice";
import ImeCompositionPopup from "../native-term/ImeCompositionPopup";
import FileLinkTooltip from "../native-term/FileLinkTooltip";
import { useNativePaneRegion } from "../native-term/useNativePaneRegion";
import { queueGeom } from "../native-term/frameSync";
import { useOverlayPublisher } from "../store/overlayRegionSlice";
import TerminalHeader, { type PromptEntry } from "./TerminalHeader";
import PromptComposer from "./PromptComposer";
import PaneSearchBar from "./PaneSearchBar";
import ClipboardImagePreview from "./ClipboardImagePreview";
import { useClipboardImagePaste } from "../hooks/useClipboardImagePaste";
import { registerPaneSearch, unregisterPaneSearch } from "../lib/pane-search-registry";
import { getTheme } from "../lib/themes";
import { DEFAULT_CLI_FONT_SIZE } from "../store/recentProjectsSlice";
import { TERMINAL_FONT_FAMILY } from "../lib/terminal-fonts";

// Until `store/index.ts` (M-list) registers `createNativeRendererSlice`,
// these fields aren't visible on AppStore at the type level. Cast through
// the slice interface. Patch plan in J1 wrap-up adds the slice; the cast
// can be removed afterwards.
type AppStoreWithNative = ReturnType<typeof useAppStore.getState> & NativeRendererSlice;

// Fallback ANSI palette mirrored from the Rust default in
// renderer/mod.rs::ThemeColors::default_tango. Used to fill in any slot a
// MADE theme doesn't define (defensive — current themes provide all 16, but
// guarantees we always ship a complete wire payload).
const FALLBACK_ANSI: Record<string, string> = {
  ansi0: "#000000",
  ansi1: "#cc0000",
  ansi2: "#4e9a06",
  ansi3: "#c4a000",
  ansi4: "#3465a4",
  ansi5: "#75507b",
  ansi6: "#06989a",
  ansi7: "#d3d7cf",
  ansi8: "#555753",
  ansi9: "#ef2929",
  ansi10: "#8ae234",
  ansi11: "#fce94f",
  ansi12: "#729fcf",
  ansi13: "#ad7fa8",
  ansi14: "#34e2e2",
  ansi15: "#eeeeec",
};

/// Convert a MadeTheme to the native_term wire-format TerminalTheme.
/// xterm ITheme uses `selectionBackground` / `black`/.../`brightWhite`; the
/// Rust side wants `selection` and `ansi0..15`. A few defensive fallbacks for
/// keys MadeTheme might not declare on every theme.
function madeThemeToNative(theme: MadeTheme): NativeTermTheme {
  const t = theme.terminal;
  const pick = (key: string, fallback: string): string =>
    (t as Record<string, string | undefined>)[key] ?? fallback;
  return {
    background: pick("background", "#0d0d11"),
    foreground: pick("foreground", "#d3d7cf"),
    cursor: pick("cursor", "#dbd6cf"),
    cursorAccent: pick("cursorAccent", "#0d0d11"),
    selection: pick("selectionBackground", "#44556b"),
    ansi0: pick("black", FALLBACK_ANSI.ansi0),
    ansi1: pick("red", FALLBACK_ANSI.ansi1),
    ansi2: pick("green", FALLBACK_ANSI.ansi2),
    ansi3: pick("yellow", FALLBACK_ANSI.ansi3),
    ansi4: pick("blue", FALLBACK_ANSI.ansi4),
    ansi5: pick("magenta", FALLBACK_ANSI.ansi5),
    ansi6: pick("cyan", FALLBACK_ANSI.ansi6),
    ansi7: pick("white", FALLBACK_ANSI.ansi7),
    ansi8: pick("brightBlack", FALLBACK_ANSI.ansi8),
    ansi9: pick("brightRed", FALLBACK_ANSI.ansi9),
    ansi10: pick("brightGreen", FALLBACK_ANSI.ansi10),
    ansi11: pick("brightYellow", FALLBACK_ANSI.ansi11),
    ansi12: pick("brightBlue", FALLBACK_ANSI.ansi12),
    ansi13: pick("brightMagenta", FALLBACK_ANSI.ansi13),
    ansi14: pick("brightCyan", FALLBACK_ANSI.ansi14),
    ansi15: pick("brightWhite", FALLBACK_ANSI.ansi15),
  };
}

// Phase 1 J1 — native-mode terminal pane.
// Public prop shape mirrors TerminalPane (the xterm-backed pane) so the
// 30-line selector wrapping both is a drop-in. Heavy lifting (full overlay
// parity, OSC 133 plumbing, prompt-detection, jump-to-bottom, search,
// IME popup, command-block overlay) lands in Phase 2 — this file owns:
//
//   1. Lifecycle: create the native HWND, drive resize, destroy on unmount.
//   2. PTY hookup via usePtyNative, attach_pty wired post-create.
//   3. Event subscription scaffold for the bridge channels.
//   4. Slot for overlay components (Phase 2 plugs them into terminalDivRef).
//   5. Registry registration via nativeRendererSlice so O's coordinator can
//      see this pane.
//
// P7a: lifecycle runs on the production command surface — one
// `native_term_create` carries the full CreateOpts (theme/font/cursor/
// scrollback/focused), so the first frame already paints with the user's
// settings; hot-swap effects below handle every later change.

interface TerminalPaneNativeProps {
  terminalId: string;
  terminalType: TerminalType;
  workingDir: string;
  isActive: boolean;
  paneCount?: number;
  onClose: () => void;
  onChangeType: (type: TerminalType) => void;
  onFocus: () => void;
  onSwapPane?: (fromTerminalId: string, toTerminalId: string) => void;
  onExplainError?: (block: CommandBlock) => void;
  onPtyReady?: () => void;
  onPtyExit?: (exitCode: number) => void;
  hideChrome?: boolean;
  serverId?: string;
  sessionResumeId?: string;
  onSessionResumeId?: (id: string) => void;
  onSwitchSession?: (newSessionId: string | undefined) => void;
  backend?: TerminalBackend;
}

export default function TerminalPaneNative({
  terminalId,
  terminalType,
  workingDir,
  isActive,
  onClose,
  onChangeType,
  onFocus,
  onSwapPane,
  onExplainError: _onExplainError,
  onPtyReady,
  onPtyExit,
  hideChrome,
  serverId,
  sessionResumeId,
  onSessionResumeId: _onSessionResumeId,
  onSwitchSession,
  paneCount: _paneCount = 1,
  backend,
}: TerminalPaneNativeProps) {
  void terminalId;

  const paneDivRef = useRef<HTMLDivElement | null>(null);
  const terminalDivRef = useRef<HTMLDivElement | null>(null);
  const [termId, setTermId] = useState<NativeTermId | null>(null);
  const [cols, setCols] = useState(80);
  const [rows, setRows] = useState(24);
  const [ptyReady, setPtyReady] = useState(false);

  // ── Overlay state (parity with TerminalPaneXterm) ────────────────────
  const [composerOpen, setComposerOpen] = useState(false);
  const composerDidStealRef = useRef(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFocusBump, setSearchFocusBump] = useState(0);
  // Local PaneSearchBar state — wired to native_term_search (R3).
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchRegex, setSearchRegex] = useState(false);
  const [searchWholeWord, setSearchWholeWord] = useState(false);
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);

  // Native pane has no xterm Terminal — pass a typed-null ref to hooks that
  // expect one. TODO(R3): swap for a Rust-backed shim once buffer reads exist.
  const nullTerminalRef = useRef<Terminal | null>(null);

  // Theme + font for PromptComposer styling (read from store like xterm pane).
  const themeId = useAppStore((s) => s.themeId);
  const theme = useMemo(() => getTheme(themeId), [themeId]);
  // P7a: mirror themeId into a ref so the create effect can build the
  // CreateOpts.theme payload without adding themeId to its dep array
  // (which would tear down + recreate the HWND on every theme switch).
  // Live changes flow through the theme hot-swap effect below.
  const themeIdRef = useRef(themeId);
  useEffect(() => { themeIdRef.current = themeId; }, [themeId]);
  const nativeCursorStyle = useAppStore((s) => s.nativeCursorStyle);
  const nativeCursorBlink = useAppStore((s) => s.nativeCursorBlink);
  // Mirror cursor settings into refs so the create effect can read the
  // latest values without rerunning when the user toggles them. Live updates
  // are handled by the separate hot-swap effect below.
  const nativeCursorStyleRef = useRef(nativeCursorStyle);
  const nativeCursorBlinkRef = useRef(nativeCursorBlink);
  useEffect(() => { nativeCursorStyleRef.current = nativeCursorStyle; }, [nativeCursorStyle]);
  useEffect(() => { nativeCursorBlinkRef.current = nativeCursorBlink; }, [nativeCursorBlink]);
  // P2b: whether the app effectively has focus. Derived in the store as
  // webviewFocused || nativePaneFocused, because on Windows tauri's
  // onFocusChanged mirrors WEBVIEW focus only — clicking a native pane blurs
  // the webview while the app stays foreground; the pane's own
  // focus_gained/focus_lost events (below) supply the native half. A pane's
  // cursor is focused iff isActive && appWindowFocused — computed here in JS
  // only (composer/search inputs take webview focus while the pane stays
  // active and must keep blinking).
  const appWindowFocused = useAppStore((s) => s.appWindowFocused);
  // Mirror isActive + the pane-activation callback into refs so the
  // focus_gained subscription (registered in the event effect below) can
  // read the latest values without growing that effect's dep array —
  // same pattern as the cursor-style refs above. appWindowFocused is
  // mirrored too (P7a) so the create effect can seed CreateOpts.focused
  // with the live `isActive && appWindowFocused` value.
  const isActiveRef = useRef(isActive);
  const onFocusRef = useRef(onFocus);
  const appWindowFocusedRef = useRef(appWindowFocused);
  useEffect(() => { isActiveRef.current = isActive; }, [isActive]);
  useEffect(() => { onFocusRef.current = onFocus; }, [onFocus]);
  useEffect(() => { appWindowFocusedRef.current = appWindowFocused; }, [appWindowFocused]);
  const cliFontSize = useAppStore((s) => s.cliFontSizes[terminalType] ?? DEFAULT_CLI_FONT_SIZE);
  // P5b: mirror the CLI font size into a ref so the create effect can push
  // the initial set_font without adding cliFontSize to its dep array (which
  // would tear down + recreate the HWND on every size change). Live changes
  // flow through the dedicated font hot-swap effect below.
  const cliFontSizeRef = useRef(cliFontSize);
  useEffect(() => { cliFontSizeRef.current = cliFontSize; }, [cliFontSize]);
  const composerAlwaysVisible = useAppStore(
    (s) => s.promptComposerEnabled && s.promptComposerAlwaysVisible,
  );
  // MadeComposer is only for AI CLI terminals — not plain shell or devserver
  const composerSupported = terminalType !== "shell" && terminalType !== "devserver";

  // Jump-to-bottom: tracks viewportY vs baseY from native `scroll` events.
  // viewportY is negative when scrolled up into scrollback; 3-line tolerance
  // (per repo memory feedback_viewport_at_bottom_tolerance.md) prevents
  // race-condition flicker during rapid output.
  const jumpBtnRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  // D-review: the button floats over the native-HWND-covered area, so it
  // must publish its rect for the hole-cut driver or it renders occluded
  // and click-dead under the native surface. Publishes null automatically
  // while hidden (display:none → zero-size rect).
  useOverlayPublisher(`native-jump-btn-${terminalId}`, jumpBtnRef);

  const registerNativeTerm = useAppStore(
    (s) => (s as AppStoreWithNative).registerNativeTerm,
  );
  const unregisterNativeTerm = useAppStore(
    (s) => (s as AppStoreWithNative).unregisterNativeTerm,
  );

  // ── HWND lifecycle ────────────────────────────────────────────────────
  useLayoutEffect(() => {
    const el = terminalDivRef.current;
    if (!el) return;
    let cancelled = false;
    let createdId: NativeTermId | null = null;
    let raf2Id = 0;

    const raf1 = requestAnimationFrame(() => {
      raf2Id = requestAnimationFrame(async () => {
        if (cancelled) return;
        try {
          // P7a: ONE `native_term_create` carries the full CreateOpts —
          // theme, font (Hack + the user's CLI font size), cursor
          // style/blink, scrollback and the live focus state — so the
          // first frame already paints with the user's settings and the
          // dimension handshake below runs against the real font metrics.
          // Everything is read through refs so this effect's dep array
          // stays create-once; live changes flow through the dedicated
          // hot-swap effects below.
          const id = await nativeTermCreate({
            rect: rectOf(el),
            dpr: window.devicePixelRatio,
            theme: madeThemeToNative(getTheme(themeIdRef.current)),
            font: {
              family: TERMINAL_FONT_FAMILY,
              sizePx: cliFontSizeRef.current,
            },
            cursorStyle: nativeCursorStyleRef.current,
            cursorBlink: nativeCursorBlinkRef.current,
            scrollback: 10000,
            focused: isActiveRef.current && appWindowFocusedRef.current,
          });
          if (cancelled) {
            void nativeTermDestroy(id).catch(() => {});
            return;
          }
          createdId = id;
          registerNativeTerm(id);
          // ── P1c: initial-size handshake (kills the 80x24 flash) ────────
          // Re-read the anchor rect: during pane-grid mount the div can
          // report 0x0 for a frame or two. Retry on successive rAFs
          // (bounded) rather than spawning the PTY at guessed dims
          // (learnings: pty-spawn-dimensions-race). On exhaustion we still
          // call propose — its Rust-side floors (cols>=20, rows>=1) keep
          // the spawn sane.
          let rect = rectOf(el);
          for (
            let attempt = 0;
            attempt < 10 && (rect.width <= 0 || rect.height <= 0);
            attempt++
          ) {
            await new Promise<void>((r) => requestAnimationFrame(() => r()));
            if (cancelled) return;
            rect = rectOf(el);
          }
          // Ask Rust for the real cols/rows for this rect (LOGICAL px —
          // rectOf convention; Rust multiplies by its cached dpr).
          let dims = { cols: 80, rows: 24 };
          try {
            dims = await nativeTermProposeDimensions(
              id,
              rect.width,
              rect.height,
            );
          } catch (e) {
            console.error("[TerminalPaneNative] propose_dimensions failed", e);
          }
          if (cancelled) return;
          // Publish dims BEFORE termId, all in one synchronous block —
          // React batches these, so when usePtyNative's spawn effect fires
          // (keyed on `ready: termId != null`) the cols/rows props and
          // colsRef/rowsRef already hold the real values and the PTY spawns
          // at the correct size. Do NOT add a JS pty_resize on `resized`
          // events — Rust resizes the PTY itself (double-resize otherwise).
          setCols(dims.cols);
          setRows(dims.rows);
          setTermId(id);
          setPtyReady(true);
        } catch (err) {
          console.error("[TerminalPaneNative] create failed", err);
        }
      });
    });

    // Geometry driver: a continuous rAF re-read with a no-change guard.
    // A bare ResizeObserver (the previous approach) misses POSITION-only
    // changes — e.g. the header settling into flow pushes this inner div down
    // without changing its size, so the surface stayed at the pane top and the
    // header drew over the first rows. RO also coalesces during a fast divider
    // drag, so the native surface lagged the DOM header. Re-reading rectOf(el)
    // every frame and pushing only on change fixes both. Mirrors the existing
    // region driver in useNativePaneRegion.ts:47-103.
    let geomRafId = 0;
    let lastGeomJson = "";
    const pushGeom = () => {
      geomRafId = requestAnimationFrame(pushGeom);
      if (createdId == null || !el.isConnected) return;
      const rect = rectOf(el);
      if (rect.width <= 0 || rect.height <= 0) return;
      const dpr = window.devicePixelRatio;
      const json = JSON.stringify([rect, dpr]);
      if (json === lastGeomJson) return;
      lastGeomJson = json;
      // P4b: route through the frame-sync coalescer instead of a direct
      // resize invoke — all panes' geometry (and hole) updates for a frame
      // merge into ONE `native_term_frame_sync` batch, applied Rust-side in
      // a single DeferWindowPos transaction (atomic splitter moves).
      queueGeom(createdId, rect, dpr);
    };
    geomRafId = requestAnimationFrame(pushGeom);

    // ResizeObserver now only resets the guard so the next rAF tick re-pushes
    // promptly after a size change (the rAF read covers position changes).
    const ro = new ResizeObserver(() => {
      lastGeomJson = "";
    });
    ro.observe(el);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1);
      if (raf2Id) cancelAnimationFrame(raf2Id);
      if (geomRafId) cancelAnimationFrame(geomRafId);
      ro.disconnect();
      if (createdId != null) {
        unregisterNativeTerm(createdId);
        void nativeTermDestroy(createdId).catch(() => {});
      }
    };
  }, [registerNativeTerm, unregisterNativeTerm]);

  // ── Event subscriptions ──────────────────────────────────────────────
  // Subscribes to per-id channels emitted by the Rust renderer. Subscriber
  // shapes match `NativeTermEventPayloadMap` in native-term-bridge.ts.
  useEffect(() => {
    if (termId == null) return;
    let cancelled = false;
    const unlistens: Array<() => void> = [];

    (async () => {
      const u1 = await subscribeResized(termId, (p) => {
        if (cancelled) return;
        setCols(p.cols);
        setRows(p.rows);
      });
      unlistens.push(u1);

      const u2 = await subscribeExit(termId, (p) => {
        if (cancelled) return;
        onPtyExit?.(p.code);
      });
      unlistens.push(u2);

      // Right-click bridge: native pane reports pane-local (x, y) in
      // logical px. GlobalContextMenu installs a window-level
      // `contextmenu` listener (see GlobalContextMenu.tsx) and reads
      // `clientX/clientY` plus `[data-terminal-id]` ancestry from the
      // event target. We synthesize a contextmenu event at the right
      // viewport coords with the terminal anchor as the target so the
      // "isTerminal" branch (Clear / Split / Close Pane items) lights up.
      const u3 = await subscribeRButton(termId, (p) => {
        if (cancelled) return;
        const paneEl = paneDivRef.current;
        if (!paneEl) return;
        const r = paneEl.getBoundingClientRect();
        const clientX = r.left + p.x;
        const clientY = r.top + p.y;
        // Prefer dispatching on an element annotated with
        // [data-terminal-id] so GlobalContextMenu detects "terminal"
        // context. The xterm pane sets this on its root; for the native
        // pane we tag the terminal anchor in JSX below.
        const target =
          (terminalDivRef.current as Element | null) ?? (paneEl as Element);
        const evt = new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          button: 2,
        });
        target.dispatchEvent(evt);
      });
      unlistens.push(u3);

      // Splitter mouse-passthrough bridge.
      // TODO(J-track): real wiring. This project uses
      // `react-resizable-panels` (see src/components/PaneGrid.tsx),
      // which attaches pointer listeners on the handle itself rather
      // than document-level listeners during drag. Synthesizing a
      // `mousemove` on `document` does NOT initiate a panel resize —
      // the library only starts dragging on a real pointerdown atop
      // the handle. Until we have a custom splitter or a library
      // upgrade with an imperative API, we just log so we can confirm
      // the event reaches JS in dev builds.
      const u4 = await subscribeMousePassthrough(termId, (p) => {
        if (cancelled) return;
        if (import.meta.env.DEV) {
          console.debug(
            "[TerminalPaneNative] mouse_passthrough (stub)",
            termId,
            p,
          );
        }
      });
      unlistens.push(u4);

      // key_down_preview bridge: native HWND captures keyboard focus when
      // clicked, so React's window-level shortcut listener (App.tsx ~line 599)
      // never sees Ctrl+K et al. Rust whitelists UI shortcuts (Ctrl+K/B/F/,, Slash,
      // Alt+1..9) and emits this event; we synthesize a window-level
      // KeyboardEvent so the existing handler dispatches without modification.
      const u5 = await subscribeKeyDownPreview(termId, (p) => {
        if (cancelled) return;
        const ev = new KeyboardEvent("keydown", {
          key: p.ev.key,
          code: p.ev.code,
          ctrlKey: p.ev.ctrl,
          shiftKey: p.ev.shift,
          altKey: p.ev.alt,
          metaKey: p.ev.meta,
          repeat: p.ev.repeat,
          bubbles: true,
          cancelable: true,
        });
        window.dispatchEvent(ev);
      });
      unlistens.push(u5);

      // scroll → jump-to-bottom button visibility.
      // viewportY is the top visible row relative to baseY; at the very
      // bottom viewportY == 0 (or close to it). Use a 3-line tolerance.
      const u6 = await subscribeScroll(termId, (p) => {
        if (cancelled) return;
        setIsAtBottom(p.viewportY >= -3);
      });
      unlistens.push(u6);

      // focus_gained (P2a click-to-focus): the native HWND took Win32
      // keyboard focus. Set the store's nativePaneFocused flag (the webview
      // is about to fire — or already fired — a blur, since WebView2's
      // LostFocus triggers whenever a sibling HWND takes Win32 focus; the
      // derived appWindowFocused stays true through that) and activate this
      // pane — mirrors the onPaneClick delegation. Refs keep this effect's
      // dep array stable.
      const u7 = await subscribeFocusGained(termId, () => {
        if (cancelled) return;
        useAppStore.getState().setNativePaneFocused(true);
        if (!isActiveRef.current) onFocusRef.current();
      });
      unlistens.push(u7);

      // focus_lost (P2b): the native HWND lost Win32 keyboard focus. Clear
      // the store's native flag — this is the ONLY blur signal when the
      // user Alt-Tabs away while a native pane holds focus (the webview
      // already blurred earlier, so onFocusChanged stays silent). Focus
      // moving pane→pane is safe: WM_KILLFOCUS (old) precedes WM_SETFOCUS
      // (new), so the paired focus_gained lands after this and re-sets the
      // flag; clicking back into the webview re-asserts via
      // onFocusChanged(true).
      const u8 = await subscribeFocusLost(termId, () => {
        if (cancelled) return;
        useAppStore.getState().setNativePaneFocused(false);
      });
      unlistens.push(u8);

      // Phase 2 wires: osc133 → useNativeCommandBlocks (hook below),
      // cell_hover/link_click → useNativeFileLinks (hook below),
      // selection → clipboard, data_rate → terminal-activity.
      // cursor + ime_composition: ImeCompositionPopup subscribes directly.

      // ── Attach-race re-sync (Run A review finding) ────────────────────
      // Rust's attach-tail commit_dims can emit `resized` BEFORE the
      // listen() registrations above complete, leaving cols/rows stale at
      // their pre-attach values. Now that the resized listener is live,
      // re-read the anchor rect and re-propose once. Idempotent — any
      // later `resized` event simply overwrites these values, and
      // propose_dimensions has no Rust-side side effects.
      if (cancelled) return;
      const el = terminalDivRef.current;
      if (el) {
        const rect = rectOf(el);
        if (rect.width > 0 && rect.height > 0) {
          try {
            const dims = await nativeTermProposeDimensions(
              termId,
              rect.width,
              rect.height,
            );
            if (cancelled) return;
            setCols(dims.cols);
            setRows(dims.rows);
          } catch {
            // Benign race: pane destroyed mid-invoke.
          }
        }
      }
    })();

    return () => {
      cancelled = true;
      for (const u of unlistens) u();
    };
  }, [termId, onPtyExit]);

  // ── Notify parent of PTY readiness once create + spawn both resolved ──
  useEffect(() => {
    if (ptyReady && termId != null) onPtyReady?.();
  }, [ptyReady, termId, onPtyReady]);

  // ── Theme hot-swap ────────────────────────────────────────────────────
  // Re-push the palette to the native renderer whenever the user switches
  // themes. The first apply happens inside the create flow above; this
  // effect handles every subsequent change. Cheap: one IPC + atomic Rust
  // swap. Dep array is intentionally `[termId, themeId]` only — `theme`
  // is derived from `themeId` and would cause a redundant re-render trigger.
  useEffect(() => {
    if (termId == null) return;
    void nativeTermSetTheme(termId, madeThemeToNative(getTheme(themeId))).catch(
      (e) => console.error("[TerminalPaneNative] set_theme update failed", e),
    );
  }, [termId, themeId]);

  // ── Cursor style/blink hot-swap ───────────────────────────────────────
  // Re-push the cursor settings whenever the user changes them in Settings.
  // First apply happens in the create flow above.
  useEffect(() => {
    if (termId == null) return;
    void nativeTermSetCursorStyle(termId, nativeCursorStyle, nativeCursorBlink).catch(
      (e) => console.error("[TerminalPaneNative] set_cursor_style update failed", e),
    );
  }, [termId, nativeCursorStyle, nativeCursorBlink]);

  // ── Font hot-swap (P5b) ───────────────────────────────────────────────
  // Re-push the font whenever the user changes the CLI font size (same
  // store field the xterm pane reads). Rust-side set_font re-derives the
  // cell metrics and runs commit_dims (Term::resize → resize_grid →
  // resize_pty_sync → `resized` emit), so cols/rows and the PTY adjust
  // automatically. First apply happens in the create flow above (the
  // termId-flip firing here re-sends the same values — idempotent:
  // commit_dims no-ops when the grid already matches).
  useEffect(() => {
    if (termId == null) return;
    void nativeTermSetFont(termId, TERMINAL_FONT_FAMILY, cliFontSize).catch(
      (e) => console.error("[TerminalPaneNative] set_font update failed", e),
    );
  }, [termId, cliFontSize]);

  // ── Cursor focus push (P2b) ───────────────────────────────────────────
  // JS-authoritative: the store computes the single source of truth
  // (isActive && appWindowFocused) and pushes it to the renderer. Errors
  // are benign races (pane tearing down mid-invoke).
  useEffect(() => {
    if (termId == null) return;
    void nativeTermSetFocused(termId, isActive && appWindowFocused).catch(() => {});
  }, [termId, isActive, appWindowFocused]);

  // ── Win32 keyboard-focus routing (P7b) ────────────────────────────────
  // Parity with the xterm pane, which calls term.focus() when it becomes
  // the active pane: route Win32 keyboard focus to the native HWND so
  // typing works without an extra click. DELIBERATELY its own effect —
  // isolated so it can be reverted alone if a focus-steal case surfaces
  // (repo history: composer mount steal, background .focus() theft).
  // ALL guards must hold, or we do nothing:
  //   - isActive: never focus a background pane
  //     (feedback_focus_calls_isactive).
  //   - appWindowFocused: never fight another app for focus.
  //   - document.activeElement === document.body: NON-NEGOTIABLE — if the
  //     composer, pane search, tab rename, or ANY other webview input owns
  //     focus, this effect must not steal it. Only when webview focus is
  //     parked on <body> (nothing interactive focused) may the HWND claim
  //     keyboard focus.
  useEffect(() => {
    if (termId == null || !isActive || !appWindowFocused) return;
    if (document.activeElement !== document.body) return;
    void nativeTermFocusKeyboard(termId).catch(() => {});
  }, [termId, isActive, appWindowFocused]);

  // ── PTY hookup ────────────────────────────────────────────────────────
  // Native mode: bytes route to Rust via R's pty_route::sender_for(id)
  // branch in pty.rs. The JS-side onData channel stays live during rollout
  // (plan hard requirement) — we just don't write into a JS renderer.
  const handlePtyData = useCallback((_data: Uint8Array) => {
    // No-op: native side consumes bytes directly via the attached pty_id.
    // Phase 2 may surface bytes here for log/recording features.
  }, []);

  const handlePtyExit = useCallback(
    (code: number) => {
      onPtyExit?.(code);
    },
    [onPtyExit],
  );

  const { write: ptyWrite } = usePtyNative({
    terminalType,
    terminalId,
    workingDir,
    cols,
    rows,
    onData: handlePtyData,
    onExit: handlePtyExit,
    serverId,
    sessionResumeId,
    ready: termId != null,
    backend,
    attachTo: termId,
  });

  // ── Hole-cut driver ───────────────────────────────────────────────────
  // Reads globally-published overlay rects from `overlayRegionSlice`,
  // intersects each with this pane's bounding rect, and emits pane-local
  // holes via `native_term_set_region` every rAF (with no-change skip).
  // Slice-sourced variant: no overlayRefs prop drilling needed.
  useNativePaneRegion({ termId: termId ?? 0, paneRef: paneDivRef });

  // ── Focus delegation ──────────────────────────────────────────────────
  const onPaneClick = useCallback(() => {
    if (!isActive) onFocus();
  }, [isActive, onFocus]);

  // ── PromptComposer handlers ───────────────────────────────────────────
  const composerWrite = useCallback(
    (data: string) => {
      ptyWrite(data);
    },
    [ptyWrite],
  );
  const handleComposerSubmit = useCallback(
    (_text: string) => {
      // PromptComposer writes the prompt itself via composerWrite; nothing
      // else to do here for the native pane (no command-block tracking yet).
    },
    [],
  );
  const handleComposerClose = useCallback(() => {
    setComposerOpen(false);
  }, []);
  // TODO(R3): scroll-to-prompt + scroll-to-next-prompt need OSC 133 buffer.
  const stubScrollToPrompt = useCallback(() => {}, []);
  const stubScrollToNextPrompt = useCallback(() => {}, []);

  // ── Native command blocks + file links ────────────────────────────────
  const { commandBlocks, promptLines } = useNativeCommandBlocks(termId);
  const { hover: fileLinkHover } = useNativeFileLinks({ termId, workingDir });

  // ── PaneSearchBar handlers ────────────────────────────────────────────
  const handleSearchClose = useCallback(() => {
    setSearchOpen(false);
    setSearchResult(null);
    if (termId != null) {
      void nativeTermSearchClear(termId).catch(() => {});
    }
  }, [termId]);

  const runSearch = useCallback(
    (direction: "forward" | "backward") => {
      if (termId == null || searchQuery.length === 0) {
        setSearchResult(null);
        return;
      }
      nativeTermSearch(
        termId,
        searchQuery,
        {
          caseSensitive: searchCaseSensitive,
          regex: searchRegex,
          wholeWord: searchWholeWord,
        },
        direction,
      )
        .then((r) => {
          setSearchResult(r);
          // Push rects to the renderer so the highlight overlay draws.
          // Best-effort: a destroyed pane racing this call is benign.
          void nativeTermSetSearchHighlights(termId, r.rects).catch(() => {});
          // D-review: bring the active match into the viewport — the
          // renderer clips off-viewport rects by design, so without this
          // Find Next/Prev against a scrollback match updated the counter
          // while visibly doing nothing. activeLine is Rust-computed in
          // the same signed space nativeTermScrollToLine consumes.
          if (r.activeIndex >= 0) {
            void nativeTermScrollToLine(termId, r.activeLine).catch(() => {});
          }
        })
        .catch(() => setSearchResult(null));
    },
    [termId, searchQuery, searchCaseSensitive, searchRegex, searchWholeWord],
  );
  const onSearchNext = useCallback(() => runSearch("forward"), [runSearch]);
  const onSearchPrev = useCallback(() => runSearch("backward"), [runSearch]);

  // PaneSearchBar wants { index, count } — translate from SearchResult.
  const searchMatchInfo = useMemo(
    () =>
      searchResult
        ? { index: searchResult.activeIndex, count: searchResult.total }
        : null,
    [searchResult],
  );

  // Register this pane's "open search" callback so the central Ctrl+F handler
  // in App.tsx can reach us (matches xterm pane behavior).
  useEffect(() => {
    registerPaneSearch(terminalId, () => {
      setSearchOpen(true);
      setSearchFocusBump((n) => n + 1);
    });
    return () => unregisterPaneSearch(terminalId);
  }, [terminalId]);

  // ── Clipboard image paste ─────────────────────────────────────────────
  // Native HWND captures most paste events directly, but mount the hook so
  // any pastes that reach the React container (e.g. focus outside HWND) work.
  const { pastedImage, dismissPreview } = useClipboardImagePaste({
    containerRef: terminalDivRef,
    terminalRef: nullTerminalRef,
    terminalType,
    terminalId,
    write: composerWrite,
    exited: false,
    onFocus,
  });

  // Auto-dismiss image preview after 8 seconds (matches xterm pane).
  useEffect(() => {
    if (!pastedImage) return;
    const timer = setTimeout(dismissPreview, 8000);
    return () => clearTimeout(timer);
  }, [pastedImage, dismissPreview]);

  // ── TerminalHeader props ──────────────────────────────────────────────
  // Native pane doesn't yet have OSC 133 buffer parsing (R3), so the
  // context-derived props are stubbed: no context bar, no prompt history.
  // The header still renders correctly with the tab/title/picker/close
  // controls — those don't depend on buffer content.
  const handleClose = useCallback(() => onClose(), [onClose]);
  const handleRestart = useCallback(() => {
    // Restart not yet implemented for native panes — would tear down the PTY
    // and respawn. For now, just close the pane and let the user reopen.
    onClose();
  }, [onClose]);
  const handleSwitchSession = useCallback(
    (sid: string | undefined) => {
      onSwitchSession?.(sid);
    },
    [onSwitchSession],
  );
  // Prompt-entry cache: keyed by absolute line, populated lazily on
  // getPromptEntries() calls. Avoids re-fetching the same buffer line per
  // render. New OSC 133;A events show up in `promptLines`; lines not yet
  // in the cache are fetched and merged into the cache (and the resulting
  // entries returned via the ref so the next getPromptEntries() call sees
  // them without another await).
  const promptEntriesRef = useRef<PromptEntry[]>([]);
  const promptCacheRef = useRef<Map<number, PromptEntry>>(new Map());
  const inflightLinesRef = useRef<Set<number>>(new Set());
  const [, bumpPromptCache] = useState(0);

  useEffect(() => {
    if (termId == null) return;
    const cache = promptCacheRef.current;
    const inflight = inflightLinesRef.current;
    const needs = promptLines.filter(
      (line) => !cache.has(line) && !inflight.has(line),
    );

    // Track which prompt-lines came from a command block (so we can mark
    // fromComposer=false reliably; future composer-originated entries can
    // set true). Currently all native-detected prompts are non-composer.
    void commandBlocks;

    if (needs.length === 0) {
      // Rebuild the array even if nothing was fetched — promptLines may
      // have shrunk (e.g. term reset).
      promptEntriesRef.current = promptLines
        .map((line) => cache.get(line))
        .filter((e): e is PromptEntry => !!e);
      return;
    }

    let cancelled = false;
    (async () => {
      // D-review coordinate fix: promptLines hold OSC 133 absLine values
      // (scrollback-origin space, 0 = oldest buffered line) while
      // nativeTermGetBufferLines takes alacritty's SIGNED space
      // [-history, screen) — map through the LIVE baseY (= -history) at
      // fetch time or every read returns empty once history exists. The
      // cache stays keyed by absLine (stable identifier).
      let baseY = 0;
      try {
        baseY = (await nativeTermGetViewportState(termId)).baseY;
      } catch {
        // No PTY attached yet — keep 0 (fresh pane, no history).
      }
      if (cancelled) return;
      for (const line of needs) {
        inflight.add(line);
        try {
          const lines = await nativeTermGetBufferLines(
            termId,
            line + baseY,
            line + baseY + 1,
          );
          if (cancelled) return;
          const text = (lines[0] ?? "").trimEnd();
          cache.set(line, { line, text, fromComposer: false });
        } catch {
          // Mark with empty text so we don't refetch indefinitely.
          cache.set(line, { line, text: "", fromComposer: false });
        } finally {
          inflight.delete(line);
        }
      }
      if (cancelled) return;
      promptEntriesRef.current = promptLines
        .map((line) => cache.get(line))
        .filter((e): e is PromptEntry => !!e);
      // Bump a state counter so TerminalHeader (which calls getPromptEntries
      // on each render via onRefreshContext) re-reads. Cheap — just an int.
      bumpPromptCache((n) => n + 1);
    })();

    return () => {
      cancelled = true;
    };
  }, [termId, promptLines, commandBlocks]);

  const getPromptEntries = useCallback(
    (): PromptEntry[] => promptEntriesRef.current,
    [],
  );
  const handleScrollToPromptLine = useCallback(
    (line: number) => {
      if (termId == null) return;
      // D-review coordinate fix: `line` is an OSC 133 absLine
      // (scrollback-origin space); nativeTermScrollToLine takes alacritty's
      // SIGNED space where 0 = bottom of the live screen. Convert through
      // the live baseY (= -history) at CLICK time — passing the raw
      // positive value clamped to offset 0 and jumped to the bottom
      // instead of the prompt.
      void (async () => {
        try {
          const vp = await nativeTermGetViewportState(termId);
          await nativeTermScrollToLine(termId, line + vp.baseY);
        } catch {
          // Benign race: pane torn down mid-invoke.
        }
      })();
    },
    [termId],
  );
  const refreshContext = useCallback((): void => {
    // TerminalHeader passes its internal "refresh" callback through this
    // prop. We stash it so the prompt-cache async loop can trigger it
    // after a fetch resolves.
    // (No-op when called directly — actual nudges flow via the ref above.)
  }, []);

  return (
    <div
      ref={paneDivRef}
      onClick={onPaneClick}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        minWidth: 0,
      }}
    >
      {!hideChrome && (
        <TerminalHeader
          terminalId={terminalId}
          terminalType={terminalType}
          isActive={isActive}
          onChangeType={onChangeType}
          onClose={handleClose}
          onRestart={handleRestart}
          onSwapPane={onSwapPane}
          serverId={serverId}
          isYolo={false}
          contextInfo={null}
          workingDir={workingDir}
          backend={backend}
          sessionResumeId={sessionResumeId}
          sessionTrusted={false}
          onSwitchSession={handleSwitchSession}
          getPromptEntries={getPromptEntries}
          onScrollToPromptLine={handleScrollToPromptLine}
          onRefreshContext={refreshContext}
        />
      )}
      {/* Terminal anchor — R's HWND positions itself over this div's bounding rect. */}
      <div
        ref={terminalDivRef}
        data-native-term-anchor
        data-pane-id={terminalId}
        data-terminal-id={terminalId}
        style={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          position: "relative",
          background: "transparent",
        }}
      />
      {/* IME pre-edit overlay. Subscribes to ime_composition + cursor
          directly so cursor moves don't re-render the whole pane. */}
      {termId != null && (
        <ImeCompositionPopup termId={termId} paneRef={paneDivRef} />
      )}
      {/* File-link tooltip — shown on cell_hover when the hovered text
          matches a file path. Publishes its rect via useOverlayPublisher
          so the native HWND cuts a hole and the tooltip is visible above
          WebView2. Click-to-open uses the existing Rust-side Ctrl+click
          flow on OSC 8 hyperlinks; this tooltip is display-only. */}
      {termId != null && (
        <FileLinkTooltip
          termId={termId}
          hover={fileLinkHover}
          paneRef={paneDivRef}
        />
      )}
      {/* PaneSearchBar — Ctrl+F overlay. Search backend (native_term_search)
          lands in R3; for now onNext/onPrev are no-ops. */}
      {searchOpen && (
        <PaneSearchBar
          query={searchQuery}
          setQuery={setSearchQuery}
          caseSensitive={searchCaseSensitive}
          setCaseSensitive={setSearchCaseSensitive}
          regex={searchRegex}
          setRegex={setSearchRegex}
          wholeWord={searchWholeWord}
          setWholeWord={setSearchWholeWord}
          matchInfo={searchMatchInfo}
          onNext={onSearchNext}
          onPrev={onSearchPrev}
          onClose={handleSearchClose}
          isActive={isActive}
          focusBump={searchFocusBump}
        />
      )}
      {/* ClipboardImagePreview — floats bottom-right when an image is pasted. */}
      {pastedImage && (
        <ClipboardImagePreview
          thumbnailUrl={pastedImage.thumbnailUrl}
          filePath={pastedImage.filePath}
          onDismiss={dismissPreview}
        />
      )}
      {/* PromptComposer — AI CLI prompt input. Internal effects guard on
          null terminal; cursor/buffer-dependent features are inert until
          R3 surfaces a Rust-backed terminal shim. */}
      {composerOpen && !hideChrome && composerSupported && (
        <PromptComposer
          onSubmit={handleComposerSubmit}
          onClose={handleComposerClose}
          write={composerWrite}
          alwaysVisible={composerAlwaysVisible}
          terminalBg={theme.terminal.background ?? "#0d1117"}
          terminalFg={theme.terminal.foreground ?? "#e6edf3"}
          terminalCursor={theme.terminal.cursor ?? "#58a6ff"}
          fontSize={cliFontSize}
          containerRef={terminalDivRef}
          terminal={null}
          terminalId={terminalId}
          terminalType={terminalType}
          workingDir={workingDir}
          scrollToPrompt={stubScrollToPrompt}
          scrollToNextPrompt={stubScrollToNextPrompt}
          isActive={isActive}
          didStealRef={composerDidStealRef}
          suppressAutoFocus={false}
        />
      )}
      {/* Jump-to-bottom — appears while scrolled into history (driven by
          `scroll` events). Anchored bottom-right; its rect is published via
          useOverlayPublisher above so the native HWND cuts a hole for it. */}
      <div
        ref={jumpBtnRef}
        style={{
          display: isAtBottom ? "none" : "flex",
          position: "absolute",
          right: 12,
          bottom: 12,
          width: 22,
          height: 22,
          borderRadius: 4,
          backgroundColor: "var(--ezy-surface-raised)",
          border: "1px solid var(--ezy-border)",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          zIndex: 10,
          opacity: 0.85,
          transition: "opacity 120ms ease",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.85"; }}
        onClick={() => {
          if (termId == null) return;
          void nativeTermScrollToBottom(termId).catch(() => {});
        }}
        title="Jump to bottom"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="2,3 6,7 10,3" />
          <line x1="3" y1="9.5" x2="9" y2="9.5" />
        </svg>
      </div>
    </div>
  );
}
