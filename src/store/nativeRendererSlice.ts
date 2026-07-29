import type { StateCreator } from "zustand";
import type { NativeTermId } from "../lib/native-term-bridge";

export type PaneRendererOverride = "native" | "xterm" | null;

export interface NativeRendererTelemetry {
  panes: number;
  crashes: number;
  lastCrashAt: number | null;
}

export interface NativeRendererSlice {
  /** Browser pane engine for LOCALHOST urls only.
   *
   *  The browser pane's surface is normally a native wry webview, which is the
   *  only engine that can actually browse the web: the old iframe path points at
   *  a single-origin proxy, so it cannot follow a cross-origin redirect and
   *  cannot open even google.se (any real site's X-Frame-Options refuses the
   *  frame once navigation escapes the proxy).
   *
   *  The iframe is still the proven path for the dev-server preview it was built
   *  for, so it keeps serving localhost while the native surface earns parity.
   *  Defaults ON for that reason. Scoped to localhost deliberately — a global
   *  switch would be a footgun, since flipping it would silently break external
   *  browsing rather than degrade it. Flip off (then delete the iframe path)
   *  once native is signed off. */
  browserIframeForLocalhost: boolean;
  /** The native browser pane's webview holds real Win32 focus while you type in
   *  it, which blurs MADE's main webview. Without folding this into
   *  `appWindowFocused` the app reads as unfocused and drops its accent ring the
   *  moment you click into a page. Transient — deliberately NOT persisted. */
  browserViewFocused: boolean;
  /** Ask before saving a download (shelf shows Save/Block), or save straight away.
   *
   *  Defaults to asking: nothing reaches disk until you approve it. Turning it
   *  off reproduces Chrome's default, and is also the only mode that issues a
   *  SINGLE request — approving re-issues the download so it can pick up cookies,
   *  which a one-time-token or POST download will not survive. */
  browserAskBeforeDownload: boolean;
  useNativeTerminalRenderer: boolean;
  /** EXPERIMENTAL: native panes share ONE wgpu Device/Queue instead of building
   *  their own. Much faster to open a pane; the trade is that a lost device
   *  takes every shared pane with it rather than one. Applies to panes opened
   *  after the flip — existing panes keep the device they were built with. */
  nativeSharedGpu: boolean;
  /** Sticky mode for the tab bar's "Add pane" dropdown: when on, panes opened
   * from that menu are stamped `renderer: "native"` on their layout leaf. Does
   * NOT touch already-open panes — that's the whole point of it existing
   * alongside `useNativeTerminalRenderer`. Ctrl+clicking a menu item forces
   * native for that one pane regardless of this flag. */
  newPaneNativeRenderer: boolean;
  /** Velocity acceleration when dragging a native pane's fullscreen-TUI
   * scrollbar: a fast drag scrolls further per pixel than a slow one. On by
   * default (it makes a long scrollback reachable without a huge drag), but
   * it compounds with Claude's own wheel ramp, so it's switchable. Off = a
   * strictly 1:1 mapping, where dragging the thumb to the top lands at the
   * top. */
  scrollThumbAcceleration: boolean;
  /** Warp-style velocity acceleration for the mouse wheel on MADE's OWN
   * scrollback (native panes, normal buffer). Does NOT affect fullscreen TUIs:
   * those receive raw wheel notches and apply their own ramp — Claude has
   * `wheelScrollAccelerationEnabled` — so stacking ours would make the
   * distance per flick unpredictable. */
  wheelAcceleration: boolean;
  /** TERM_PROGRAM advertised to the AI CLIs. Claude gates synchronized output,
   * progress reporting and its automatic notification channel on recognising
   * the terminal; blank advertises nothing. Free-form so every name in
   * Claude's table can be tried — which set contains which capability could not
   * be reconstructed from the binary. See termProgramEnvPairs. */
  termProgram: string;
  /** Reported alongside it. Blank uses a sensible default for known names —
   * Claude enforces per-terminal minimums. */
  termProgramVersion: string;
  paneRendererOverride: Record<string, Exclude<PaneRendererOverride, null>>;
  nativeRendererTelemetry: NativeRendererTelemetry;
  // Tracks every alive native-term HWND id so coordinators (e.g. modal
  // visibility broadcaster owned by workstream-O) can iterate them.
  // Always replaced immutably — never mutated via .add()/.delete() — so
  // Zustand selector identity flips only on actual content change.
  liveNativeTerms: ReadonlySet<NativeTermId>;
  // P2b focus model. On Windows, tauri's getCurrentWindow().onFocusChanged
  // mirrors the WEBVIEW's focus (WebView2 GotFocus/LostFocus), NOT the OS
  // window's — clicking a native terminal HWND blurs the webview even though
  // the app window is still foreground. So the app-focus truth is split into
  // two raw inputs and one derived output:
  //   - webviewFocused: raw onFocusChanged payload (App.tsx single writer).
  //   - nativePaneFocused: a native term HWND owns Win32 keyboard focus.
  //     Set by the per-pane focus_gained (WM_SETFOCUS) subscription, cleared
  //     by focus_lost (WM_KILLFOCUS) and by webview GotFocus.
  //   - appWindowFocused (derived) = webviewFocused || nativePaneFocused.
  // A pane's cursor is "focused" iff isActive && appWindowFocused — computed
  // in JS only; Win32 keyboard focus never drives visuals directly
  // (composer/search inputs take webview focus while the pane stays active
  // and must keep blinking).
  // NOT persisted — `partialize` in store/index.ts is an allowlist and these
  // fields are intentionally excluded (stale focus across launches is wrong).
  webviewFocused: boolean;
  nativePaneFocused: boolean;
  /** The overlay webview holds OS focus (focus-handoff popups: pane search).
   * Folded into appWindowFocused so search doesn't dim the app. */
  overlayFocused: boolean;
  appWindowFocused: boolean;
  /** OS window is minimized (WM_SIZE/SIZE_MINIMIZED transition events from the
   * win32_border wnd_proc — NOT webview focus, which stays foreground-agnostic).
   * Gates pane-notification suppression and the auto-switch-while-minimized
   * setting. NOT persisted (same rationale as the focus fields above). */
  windowMinimized: boolean;

  setBrowserIframeForLocalhost: (v: boolean) => void;
  setBrowserViewFocused: (v: boolean) => void;
  setBrowserAskBeforeDownload: (v: boolean) => void;
  setUseNativeTerminalRenderer: (v: boolean) => void;
  setNativeSharedGpu: (v: boolean) => void;
  setNewPaneNativeRenderer: (v: boolean) => void;
  setScrollThumbAcceleration: (v: boolean) => void;
  setWheelAcceleration: (v: boolean) => void;
  setTermProgram: (v: string) => void;
  setTermProgramVersion: (v: string) => void;
  setPaneRendererOverride: (paneId: string, override: PaneRendererOverride) => void;
  recordNativeRendererCrash: () => void;
  registerNativeTerm: (id: NativeTermId) => void;
  unregisterNativeTerm: (id: NativeTermId) => void;
  setWebviewFocused: (focused: boolean) => void;
  setNativePaneFocused: (focused: boolean) => void;
  setOverlayFocused: (focused: boolean) => void;
  setWindowMinimized: (minimized: boolean) => void;
}

const EMPTY_LIVE: ReadonlySet<NativeTermId> = new Set();

export const createNativeRendererSlice: StateCreator<
  NativeRendererSlice,
  [],
  [],
  NativeRendererSlice
> = (set, get) => ({
  browserIframeForLocalhost: true,
  browserViewFocused: false,
  browserAskBeforeDownload: true,
  useNativeTerminalRenderer: false,
  nativeSharedGpu: false,
  newPaneNativeRenderer: false,
  scrollThumbAcceleration: true,
  wheelAcceleration: true,
  termProgram: "ghostty",
  termProgramVersion: "",
  paneRendererOverride: {},
  nativeRendererTelemetry: { panes: 0, crashes: 0, lastCrashAt: null },
  liveNativeTerms: EMPTY_LIVE,
  webviewFocused: true,
  nativePaneFocused: false,
  overlayFocused: false,
  appWindowFocused: true,
  windowMinimized: false,

  setBrowserIframeForLocalhost: (v) => set({ browserIframeForLocalhost: v }),

  setBrowserAskBeforeDownload: (v) => set({ browserAskBeforeDownload: v }),

  setBrowserViewFocused: (focused) => {
    const s = get();
    if (s.browserViewFocused === focused) return;
    set({
      browserViewFocused: focused,
      appWindowFocused:
        s.webviewFocused || s.nativePaneFocused || s.overlayFocused || focused,
    });
  },

  setUseNativeTerminalRenderer: (v) => set({ useNativeTerminalRenderer: v }),

  setNativeSharedGpu: (v) => set({ nativeSharedGpu: v }),

  setNewPaneNativeRenderer: (v) => set({ newPaneNativeRenderer: v }),

  setScrollThumbAcceleration: (v) => set({ scrollThumbAcceleration: v }),

  setWheelAcceleration: (v) => set({ wheelAcceleration: v }),

  setTermProgram: (v) => set({ termProgram: v }),

  setTermProgramVersion: (v) => set({ termProgramVersion: v }),

  setWebviewFocused: (focused) => {
    const s = get();
    // Webview GotFocus proves Win32 focus left any native pane — clear the
    // native flag too (belt-and-suspenders with the focus_lost event, which
    // can race this in either order; both converge).
    const nativePaneFocused = focused ? false : s.nativePaneFocused;
    if (s.webviewFocused === focused && s.nativePaneFocused === nativePaneFocused) {
      return;
    }
    set({
      webviewFocused: focused,
      nativePaneFocused,
      appWindowFocused:
        focused || nativePaneFocused || s.overlayFocused || s.browserViewFocused,
    });
  },

  setNativePaneFocused: (focused) => {
    const s = get();
    if (s.nativePaneFocused === focused) return;
    set({
      nativePaneFocused: focused,
      appWindowFocused:
        s.webviewFocused || focused || s.overlayFocused || s.browserViewFocused,
    });
  },

  setOverlayFocused: (focused) => {
    const s = get();
    if (s.overlayFocused === focused) return;
    set({
      overlayFocused: focused,
      appWindowFocused:
        s.webviewFocused || s.nativePaneFocused || focused || s.browserViewFocused,
    });
  },

  setWindowMinimized: (minimized) => {
    if (get().windowMinimized === minimized) return;
    set({ windowMinimized: minimized });
  },

  setPaneRendererOverride: (paneId, override) => {
    const prev = get().paneRendererOverride;
    if (override === null) {
      if (!(paneId in prev)) return;
      const next = { ...prev };
      delete next[paneId];
      set({ paneRendererOverride: next });
    } else {
      if (prev[paneId] === override) return;
      set({ paneRendererOverride: { ...prev, [paneId]: override } });
    }
  },

  recordNativeRendererCrash: () =>
    set((s) => ({
      nativeRendererTelemetry: {
        ...s.nativeRendererTelemetry,
        crashes: s.nativeRendererTelemetry.crashes + 1,
        lastCrashAt: Date.now(),
      },
    })),

  registerNativeTerm: (id) => {
    const prev = get().liveNativeTerms;
    if (prev.has(id)) return;
    const next = new Set(prev);
    next.add(id);
    set({
      liveNativeTerms: next,
      nativeRendererTelemetry: {
        ...get().nativeRendererTelemetry,
        panes: next.size,
      },
    });
  },

  unregisterNativeTerm: (id) => {
    const prev = get().liveNativeTerms;
    if (!prev.has(id)) return;
    const next = new Set(prev);
    next.delete(id);
    set({
      liveNativeTerms: next,
      nativeRendererTelemetry: {
        ...get().nativeRendererTelemetry,
        panes: next.size,
      },
    });
  },
});
