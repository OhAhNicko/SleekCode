import type { StateCreator } from "zustand";
import type { NativeTermId } from "../lib/native-term-bridge";

export type PaneRendererOverride = "native" | "xterm" | null;

export interface NativeRendererTelemetry {
  panes: number;
  crashes: number;
  lastCrashAt: number | null;
}

export interface NativeRendererSlice {
  useNativeTerminalRenderer: boolean;
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

  setUseNativeTerminalRenderer: (v: boolean) => void;
  setPaneRendererOverride: (paneId: string, override: PaneRendererOverride) => void;
  recordNativeRendererCrash: () => void;
  registerNativeTerm: (id: NativeTermId) => void;
  unregisterNativeTerm: (id: NativeTermId) => void;
  setWebviewFocused: (focused: boolean) => void;
  setNativePaneFocused: (focused: boolean) => void;
  setOverlayFocused: (focused: boolean) => void;
}

const EMPTY_LIVE: ReadonlySet<NativeTermId> = new Set();

export const createNativeRendererSlice: StateCreator<
  NativeRendererSlice,
  [],
  [],
  NativeRendererSlice
> = (set, get) => ({
  useNativeTerminalRenderer: false,
  paneRendererOverride: {},
  nativeRendererTelemetry: { panes: 0, crashes: 0, lastCrashAt: null },
  liveNativeTerms: EMPTY_LIVE,
  webviewFocused: true,
  nativePaneFocused: false,
  overlayFocused: false,
  appWindowFocused: true,

  setUseNativeTerminalRenderer: (v) => set({ useNativeTerminalRenderer: v }),

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
      appWindowFocused: focused || nativePaneFocused || s.overlayFocused,
    });
  },

  setNativePaneFocused: (focused) => {
    const s = get();
    if (s.nativePaneFocused === focused) return;
    set({
      nativePaneFocused: focused,
      appWindowFocused: s.webviewFocused || focused || s.overlayFocused,
    });
  },

  setOverlayFocused: (focused) => {
    const s = get();
    if (s.overlayFocused === focused) return;
    set({
      overlayFocused: focused,
      appWindowFocused: s.webviewFocused || s.nativePaneFocused || focused,
    });
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
