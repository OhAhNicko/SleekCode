import { useState, useRef, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../store";
import { registerSurfaceActions, unregisterSurfaceActions } from "../lib/surface-actions";
import { useBrowserConsoleStore, type ConsoleEntry } from "../store/browserConsoleStore";
import { FaCheck, FaChevronLeft, FaChevronRight, FaGlobe, FaExternalLinkAlt, FaCrosshairs, FaTerminal, FaDesktop, FaTrash, FaLock, FaLockOpen, FaBug } from "react-icons/fa";
import { FaArrowsRotate, FaXmark } from "react-icons/fa6";
import { FaDownload } from "react-icons/fa";
import { BiRefresh, BiTimer } from "react-icons/bi";
import PaneExpandButton from "./PaneExpandButton";
import { resolveOmniboxInput } from "../lib/omnibox";
import { jiraOriginFromUrl } from "../lib/jira";
import { useBrowserViewSurface } from "../browser-view/useBrowserViewSurface";
import { subscribeBrowserCtxMenu, type BrowserCtxMenuEvent } from "../browser-view/bridge";
import {
  setBrowserPageContext,
  clearBrowserPageContext,
  BROWSER_SURFACE_ID,
} from "../browser-view/page-context";
import {
  browserViewBack,
  browserViewAllowDownload,
  browserViewDenyDownload,
  browserViewEnableDevtools,
  browserViewEval,
  browserViewSetPromptDownloads,
  browserViewForward,
  browserViewHardReload,
  browserViewNavigate,
  browserViewReload,
  subscribeBrowserBlocked,
  subscribeBrowserDevtools,
  subscribeBrowserDownload,
  subscribeBrowserNavigated,
  subscribeBrowserPopup,
} from "../browser-view/bridge";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface BrowserPreviewProps {
  initialUrl: string;
  onClose: () => void;
  /** When set, the pane mirrors the live dev-server URL of this tab. While the
   *  server isn't ready yet, the iframe area shows a "Waiting for dev server"
   *  placeholder instead of attempting to load an unreachable URL. */
  linkedTabId?: string;
}

interface NetworkEntry {
  id: number;
  method: string;
  url: string;
  status: number; // -1 = pending
  statusText: string;
  duration: number;
  size: number;
  error?: string;
  timestamp: number;
}

interface InspectedElement {
  tag: string;
  id: string;
  classes: string;
  rect: { width: number; height: number; top: number; left: number };
  styles: Record<string, string>;
}

interface StorageSnapshot {
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  cookies: Record<string, string>;
  timestamp: number;
}

type ViewportMode =
  | "responsive"
  | "mobile"
  | "fold"
  | "tablet"
  | "desktop"
  | "custom";

type DevtoolsTab = "console" | "network" | "elements" | "storage";

/** One row in the downloads shelf.
 *
 *  `pending` is the important state: the download was CANCELLED at the webview,
 *  so nothing is on disk and it stays that way unless approved. */
interface DownloadItem {
  url: string;
  name: string;
  status: "pending" | "downloading" | "done" | "failed" | "denied";
  path: string | null;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const VIEWPORT_PRESETS: {
  label: string;
  mode: ViewportMode;
  width?: number;
  height?: number;
}[] = [
  { label: "Responsive", mode: "responsive" },
  { label: "Mobile", mode: "mobile", width: 375, height: 667 },
  { label: "Fold 7", mode: "fold", width: 720, height: 960 },
  { label: "Tablet", mode: "tablet", width: 768, height: 1024 },
  { label: "Desktop", mode: "desktop", width: 1280, height: 800 },
  { label: "Custom", mode: "custom" },
];

/** Corner radius of the viewport-preset device frame, in logical CSS px.
 *  Shared by the CSS wrapper and the native surface's Win32 clip region so the
 *  two can never disagree. */
const PREVIEW_FRAME_RADIUS = 4;

/** The one legal payload `type` for each envelope `kind` the native surface may
 *  send. Rust validates `kind` (browser_view/policy.rs); this pins the payload
 *  to it so the two cannot disagree. */
const KIND_TO_MESSAGE_TYPE: Record<string, string> = {
  console: "made-console",
  network: "made-network",
  storage: "made-storage",
  "inspect-result": "made-inspect-result",
  url: "made-url",
  ready: "made-ready",
  focus: "made-focus",
  // Owned by the context-menu workstream (browser_view/mod.rs emits it from a
  // passive contextmenu listener). Listed here so this validator does not
  // silently drop their records — without the entry the kind/type check fails
  // closed and the menu would never fire, with nothing to show why.
  ctxmenu: "made-ctxmenu",
};

const DEVTOOLS_TABS: { tab: DevtoolsTab; label: string }[] = [
  { tab: "console", label: "Console" },
  { tab: "network", label: "Network" },
  { tab: "elements", label: "Elements" },
  { tab: "storage", label: "Storage" },
];

/* ------------------------------------------------------------------ */
/*  NavButton — uses <div role="button"> to avoid <button> height     */
/*  inflation in compact headers (see CSS/React gotchas in CLAUDE.md) */
/* ------------------------------------------------------------------ */

function NavButton({
  title,
  onClick,
  disabled,
  active,
  hoverColor,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  hoverColor?: string;
  children: React.ReactNode;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      data-tooltip={title}
      onClick={disabled ? undefined : onClick}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) onClick();
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 24,
        height: 24,
        borderRadius: 4,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.3 : 1,
        pointerEvents: disabled ? "none" : "auto",
        backgroundColor: active
          ? "var(--ezy-accent-dim)"
          : hovered
            ? "var(--ezy-border)"
            : "transparent",
        color: active
          ? "#ffffff"
          : hovered && hoverColor
            ? hoverColor
            : "var(--ezy-text-muted)",
        transition: "background-color 0.15s, color 0.15s",
        outline: "none",
        flexShrink: 0,
      }}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const fmtTime = (ts: number) => {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
};

const fmtSize = (bytes: number): string => {
  if (bytes <= 0) return "\u2014";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
};

const fmtDuration = (ms: number): string => {
  if (ms <= 0) return "\u2014";
  if (ms < 1000) return ms + "ms";
  return (ms / 1000).toFixed(1) + "s";
};

/** Is this URL served from the machine MADE is running on?
 *
 *  Only these keep the option of the legacy iframe+proxy path. Everything else
 *  must use the native webview: the proxy holds ONE target origin, so the first
 *  cross-origin redirect leaves it and the destination's X-Frame-Options refuses
 *  the frame — which is why google.se could never load. */
const isLocalhostUrl = (raw: string): boolean => {
  try {
    const h = new URL(raw).hostname.toLowerCase();
    return (
      h === "localhost" ||
      h === "127.0.0.1" ||
      h === "::1" ||
      h === "[::1]" ||
      h.endsWith(".localhost")
    );
  } catch {
    return false;
  }
};

const consoleMethodColor = (m: ConsoleEntry["method"]) => {
  switch (m) {
    case "error":
      return "var(--ezy-red)";
    case "warn":
      return "var(--ezy-text-secondary)";
    case "info":
      return "var(--ezy-cyan)";
    default:
      return "var(--ezy-text)";
  }
};

const statusColor = (status: number): string => {
  if (status === -1) return "var(--ezy-text-muted)";
  if (status === 0) return "var(--ezy-red)";
  if (status >= 200 && status < 300) return "var(--ezy-accent)";
  if (status >= 300 && status < 400) return "var(--ezy-text-secondary)";
  return "var(--ezy-red)";
};

/* ------------------------------------------------------------------ */
/*  BrowserPreview                                                     */
/* ------------------------------------------------------------------ */

export default function BrowserPreview({
  initialUrl,
  onClose,
  linkedTabId,
}: BrowserPreviewProps) {
  /* ---- Linked dev server (live URL + waiting state) ---- */
  // Subscribe to the dev server attached to linkedTabId. The pane is "ready"
  // when the server reports running with a real port — for SSH this is the
  // forwarded local port set by DevServerTerminalHost after the tunnel binds.
  // (See note in DevServerTerminalHost: for SSH we no longer set port until
  // the tunnel is bound, so port > 0 always means "URL is reachable".)
  const linkedDevServer = useAppStore((s) =>
    linkedTabId ? s.devServers.find((d) => d.tabId === linkedTabId) : undefined
  );
  const linkedReady =
    !!linkedDevServer &&
    linkedDevServer.status === "running" &&
    linkedDevServer.port > 0;
  const linkedLiveUrl = linkedReady
    ? `http://localhost:${linkedDevServer!.port}`
    : null;

  /* ---- URL & History ---- */
  // For linked panes, prefer the live URL once known; otherwise fall back to
  // initialUrl (which may be about:blank or a stored URL from a saved layout).
  const initialResolvedUrl = linkedLiveUrl ?? initialUrl;
  const [url, setUrl] = useState(initialResolvedUrl);
  const [inputUrl, setInputUrl] = useState(initialResolvedUrl);
  const [history, setHistory] = useState<string[]>([initialResolvedUrl]);
  const [historyIndex, setHistoryIndex] = useState(0);

  // One-shot waiting gate: show the "Waiting for dev server" overlay UNTIL
  // the dev server has been ready at least once. After that, never block —
  // even if the dev server later restarts/drops, we trust the user's URL.
  // This avoids two failure modes:
  //   1. Saved layouts with a stored URL load too early (iframe shows a
  //      stale "can't reach page" before the dev server has a chance to
  //      start). The waiting state must "win" over saved URLs.
  //   2. Once the page loads successfully, brief drops in port (e.g. SSH
  //      tunnel re-bind) shouldn't blank the page.
  const [hasEverBeenReady, setHasEverBeenReady] = useState(linkedReady);
  useEffect(() => {
    if (linkedReady && !hasEverBeenReady) setHasEverBeenReady(true);
  }, [linkedReady, hasEverBeenReady]);

  // ESCAPE HATCH — third failure mode, and the one that made the pane useless:
  // if the dev server's port is never detected, `linkedReady` stays false
  // forever, so the waiting overlay replaced the surface AND blocked it from
  // being created. Typing a URL then did nothing at all: the state changed with
  // no webview to navigate. Any explicit user action — entering a URL, or
  // pressing Stop — now abandons the wait for good.
  const [waitAbandoned, setWaitAbandoned] = useState(false);

  const showWaiting =
    !!linkedTabId &&
    !!linkedDevServer &&
    !linkedReady &&
    !hasEverBeenReady &&
    !waitAbandoned;

  // Time-box the wait. Even with the status/port contradiction fixed, a missed
  // port scrape (the output can arrive before the listener attaches) would
  // otherwise leave this overlay up forever with no way past it except the Stop
  // button. After the timeout we load the pane's URL regardless: if the server
  // really is down the page says so, which beats an eternal spinner.
  useEffect(() => {
    if (!showWaiting) return;
    const t = setTimeout(() => setWaitAbandoned(true), 15_000);
    return () => clearTimeout(t);
  }, [showWaiting]);

  // When the linked dev server transitions to ready, navigate the pane to its
  // live URL. Re-runs only when liveUrl actually changes (rare port change on
  // restart) so the user's manual in-iframe navigation isn't disrupted.
  const lastAppliedLiveUrlRef = useRef<string | null>(linkedLiveUrl);
  useEffect(() => {
    if (!linkedTabId) return;
    if (!linkedLiveUrl) return;
    if (lastAppliedLiveUrlRef.current === linkedLiveUrl) return;
    lastAppliedLiveUrlRef.current = linkedLiveUrl;
    setUrl(linkedLiveUrl);
    setInputUrl(linkedLiveUrl);
    setHistory((h) => (h[h.length - 1] === linkedLiveUrl ? h : [...h, linkedLiveUrl]));
    setHistoryIndex((_) => 0);
  }, [linkedLiveUrl, linkedTabId]);

  /* ---- Viewport ---- */
  const [viewportMode, setViewportMode] =
    useState<ViewportMode>("responsive");
  const [customWidth, setCustomWidth] = useState(1280);
  const [customHeight, setCustomHeight] = useState(800);
  const [showViewportBar, setShowViewportBar] = useState(false);

  /* ---- DevTools panel ---- */
  const [devtoolsPinned, setDevtoolsPinned] = useState(
    () => localStorage.getItem("made-devtools-pinned") === "true"
  );
  const [devtoolsTab, setDevtoolsTab] = useState<DevtoolsTab | null>(
    () => localStorage.getItem("made-devtools-pinned") === "true" ? "console" : null
  );
  const lastTabRef = useRef<DevtoolsTab>("console");
  const [devtoolsHeight, setDevtoolsHeight] = useState<number>(() => {
    const saved = Number(localStorage.getItem("made-devtools-height"));
    return Number.isFinite(saved) && saved >= 80 ? saved : 220;
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const resizingRef = useRef(false);

  /* ---- Console ---- */
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([]);
  const consoleEndRef = useRef<HTMLDivElement>(null);
  const entryIdRef = useRef(0);
  const consoleSelectMode = useBrowserConsoleStore((s) => s.selectMode);
  const consoleSelectedIds = useBrowserConsoleStore((s) => s.selectedIds);
  const toggleConsoleSelected = useBrowserConsoleStore((s) => s.toggleSelected);
  const autoDebug = useBrowserConsoleStore((s) => s.autoDebug);

  // Mirror console entries to standalone store for MadeComposer access
  useEffect(() => {
    useBrowserConsoleStore.getState().setEntries(consoleEntries);
  }, [consoleEntries]);
  // Mark browser preview as active; clear on unmount
  useEffect(() => {
    useBrowserConsoleStore.getState().setActive(true);
    return () => {
      const s = useBrowserConsoleStore.getState();
      s.setActive(false);
      s.setEntries([]);
    };
  }, []);
  // Listen for MadeComposer requesting console tab to open
  const requestOpenConsole = useBrowserConsoleStore((s) => s.requestOpenConsole);
  useEffect(() => {
    if (requestOpenConsole) {
      setDevtoolsTab("console");
      useBrowserConsoleStore.getState().setRequestOpenConsole(false);
    }
  }, [requestOpenConsole]);

  /* ---- Network ---- */
  const [networkEntries, setNetworkEntries] = useState<NetworkEntry[]>([]);
  const networkEndRef = useRef<HTMLDivElement>(null);

  /* ---- Element inspector ---- */
  const [inspectMode, setInspectMode] = useState(false);
  const inspectModeRef = useRef(false);
  const [inspectedElement, setInspectedElement] =
    useState<InspectedElement | null>(null);

  /* ---- Storage ---- */
  const [storageData, setStorageData] = useState<StorageSnapshot | null>(null);

  /* ---- Auto-reload ---- */
  const [autoReload, setAutoReload] = useState(false);

  /* ---- Loading ----
   *  Drives the Reload <-> Stop swap in the toolbar, the way Chrome does it.
   *  Set on navigate/refresh, cleared when the page reports ready, when a
   *  navigation is blocked, or when the user presses Stop. */
  const [isLoading, setIsLoading] = useState(false);

  /* ---- Downloads shelf ---- */
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const downloadsBtnRef = useRef<HTMLDivElement>(null);
  const downloadsPanelRef = useRef<HTMLDivElement>(null);
  const [downloadsAnchor, setDownloadsAnchor] = useState({ top: 0, right: 0 });
  const pendingDownloads = downloads.filter((d) => d.status === "pending").length;

  /* ---- Proxy state ---- */
  const [proxyPort, setProxyPort] = useState<number | null>(null);
  const [iframeKey, setIframeKey] = useState(0);
  const [proxyActive, setProxyActive] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement>(null);

  /* ---- Engine selection ---------------------------------------------
   *  The native wry webview is the browser; the iframe+proxy is the legacy
   *  dev-server previewer, kept until native reaches parity (Settings >
   *  Native renderer > "Use iframe preview for localhost", default on).
   *
   *  Scoped to localhost on purpose: the iframe physically cannot load an
   *  external site, so letting the toggle cover them would turn a preference
   *  into a breakage.                                                      */
  const iframeForLocalhost = useAppStore((s) => s.browserIframeForLocalhost);
  const askBeforeDownload = useAppStore((s) => s.browserAskBeforeDownload);
  const useIframe = iframeForLocalhost && isLocalhostUrl(url);

  const surfaceAnchorRef = useRef<HTMLDivElement>(null);
  /** Has the address bar already been clicked while focused? Drives Chrome's
   *  "first click selects all, second click places the caret" behaviour. */
  const urlFocusedRef = useRef(false);
  const { id: browserViewId, error: surfaceError } = useBrowserViewSurface({
    anchorRef: surfaceAnchorRef,
    initialUrl: url,
    // Never build a surface while the waiting state is up: there is no URL
    // worth loading yet, and the anchor is not rendered.
    enabled: !useIframe && !showWaiting,
    // Matches the viewport-preset frame's CSS borderRadius below. Responsive
    // mode has no frame, so no clip.
    cornerRadius: viewportMode === "responsive" ? 0 : PREVIEW_FRAME_RADIUS,
    // The shelf is DOM and the webview is a child HWND, which always paints on
    // top. The surface therefore steps aside while the shelf is open — z-index
    // cannot solve this.
    hidden: downloadsOpen,
  });

  // Bridge the native webview's right-click into MADE's context menu.
  //
  // The webview is a child HWND and WebView2 owns input inside it, so the DOM
  // never sees a `contextmenu` event — the click is reported from the page's
  // injected script instead. We park what was under the cursor, then synthesize
  // the DOM event on the surface anchor at the matching viewport point, exactly
  // as TerminalPaneNative does for its pane.
  const openPageContextMenu = useCallback((e: BrowserCtxMenuEvent) => {
    // Native engine anchors on the surface div; iframe engine on the frame.
    const el = surfaceAnchorRef.current ?? iframeRef.current;
    if (!el) return;
    setBrowserPageContext(BROWSER_SURFACE_ID, e);
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: r.left + e.x,
      clientY: r.top + e.y,
      button: 2,
    }));
  }, []);

  useEffect(() => {
    if (browserViewId == null) return;
    let un: (() => void) | undefined;
    let cancelled = false;
    void subscribeBrowserCtxMenu(browserViewId, (e) => {
      if (cancelled) return;
      openPageContextMenu(e);
    }).then((u) => {
      if (cancelled) u();
      else un = u;
    });
    return () => {
      cancelled = true;
      un?.();
      clearBrowserPageContext(BROWSER_SURFACE_ID);
    };
  }, [browserViewId, openPageContextMenu]);

  // Mirror the download preference into Rust. Process-wide there, so pushing it
  // from whichever pane is mounted is enough; re-pushed on change.
  useEffect(() => {
    void browserViewSetPromptDownloads(askBeforeDownload).catch(() => {});
  }, [askBeforeDownload]);

  /** Is DevTools capture wired up, whichever engine is running the pane?
   *  The panel's badges and empty-states key off this rather than the proxy, so
   *  they read correctly on the native surface (which has no proxy at all). */
  const captureActive = useIframe ? proxyActive : browserViewId != null;
  const devtoolsTabRef = useRef<DevtoolsTab | null>(null);
  devtoolsTabRef.current = devtoolsTab;

  /* ---- Navigation ---- */


  const navigateTo = useCallback(
    (raw: string) => {
      // Chrome's omnibox rule: `google.se` navigates, `jira atlassian` searches.
      const target = resolveOmniboxInput(raw);
      if (!target) return;
      // Entering a URL is an explicit "browse this now": it must win over a
      // dev-server wait that may never finish (see waitAbandoned).
      setWaitAbandoned(true);
      setIsLoading(true);
      setHistory((prev) => [...prev.slice(0, historyIndex + 1), target]);
      setHistoryIndex((prev) => prev + 1);
      setUrl(target);
      setInputUrl(target);
    },
    [historyIndex],
  );

  // The native surface keeps its own history and exposes no way to query depth,
  // so the buttons stay live and a no-op back is simply a no-op — the same thing
  // a real browser does at the start of its history.
  const canGoBack = browserViewId != null || historyIndex > 0;
  const canGoForward =
    browserViewId != null || historyIndex < history.length - 1;

  // On the native surface the WEBVIEW owns history, so back/forward drive its
  // own history object (exactly what a browser's buttons do) rather than
  // replaying MADE's list — that list only tracks URLs typed into the bar, and
  // would skip every in-page navigation.
  const goBack = useCallback(() => {
    if (browserViewId != null) {
      void browserViewBack(browserViewId).catch(() => {});
      return;
    }
    if (!canGoBack) return;
    const idx = historyIndex - 1;
    setHistoryIndex(idx);
    setUrl(history[idx]);
    setInputUrl(history[idx]);
  }, [browserViewId, canGoBack, history, historyIndex]);

  const goForward = useCallback(() => {
    if (browserViewId != null) {
      void browserViewForward(browserViewId).catch(() => {});
      return;
    }
    if (!canGoForward) return;
    const idx = historyIndex + 1;
    setHistoryIndex(idx);
    setUrl(history[idx]);
    setInputUrl(history[idx]);
  }, [browserViewId, canGoForward, history, historyIndex]);

  /* ---- Refresh / Hard Reload ---- */

  const refresh = useCallback(() => {
    setIsLoading(true);
    if (browserViewId != null) {
      void browserViewReload(browserViewId).catch(() => {});
      return;
    }
    setIframeKey((k) => k + 1);
  }, [browserViewId]);

  /** Stop loading — and abandon a dev-server wait that may never end.
   *
   *  Both halves matter: while the pane was waiting for a port it could not be
   *  used for anything else, which is what made it feel stuck. */
  const stopLoading = useCallback(() => {
    setIsLoading(false);
    setWaitAbandoned(true);
    if (browserViewId != null) {
      void browserViewEval(browserViewId, "window.stop&&window.stop()").catch(
        () => {},
      );
    }
  }, [browserViewId]);

  const hardReload = useCallback(() => {
    if (browserViewId != null) {
      // Clears this browsing profile's data, then reloads — the native
      // equivalent of the iframe path's storage wipe.
      void browserViewHardReload(browserViewId).catch(() => {});
      return;
    }
    try {
      iframeRef.current?.contentWindow?.postMessage(
        { type: "made-clear-storage" },
        "*",
      );
    } catch {
      /* cross-origin safety */
    }
    setTimeout(() => setIframeKey((k) => k + 1), 150);
  }, [browserViewId]);

  /* ---- DevTools toggle / tab switching ---- */

  // Expose navigation to the context menu — these are component-local
  // closures, so a provider cannot reach them any other way.
  const browserRef = useRef<Record<string, () => void>>({});
  useEffect(() => {
    registerSurfaceActions("browser", {
      back: () => browserRef.current.back?.(),
      forward: () => browserRef.current.forward?.(),
      reload: () => browserRef.current.reload?.(),
      hardReload: () => browserRef.current.hardReload?.(),
      openExternal: () => browserRef.current.openExternal?.(),
      devtools: () => browserRef.current.devtools?.(),
    });
    return () => unregisterSurfaceActions("browser");
  }, []);

  const toggleDevtools = useCallback(() => {
    setDevtoolsTab((prev) => {
      if (prev !== null) return null;
      return lastTabRef.current;
    });
  }, []);
  browserRef.current = {
    back: goBack,
    forward: goForward,
    reload: refresh,
    hardReload,
    openExternal: () => { void openUrl(url).catch(() => {}); },
    devtools: toggleDevtools,
  };

  /* ---- Downloads shelf ---- */

  const toggleDownloads = useCallback(() => {
    setDownloadsOpen((open) => {
      if (open) return false;
      // Fixed positioning, measured on open: the pane lives inside an
      // overflow:hidden slot, so an absolutely-positioned panel would be clipped.
      const r = downloadsBtnRef.current?.getBoundingClientRect();
      if (r) {
        setDownloadsAnchor({
          top: Math.round(r.bottom + 6),
          right: Math.round(window.innerWidth - r.right),
        });
      }
      return true;
    });
  }, []);

  const allowDownload = useCallback(
    (item: DownloadItem) => {
      if (browserViewId == null) return;
      setDownloads((prev) =>
        prev.map((d) =>
          d.url === item.url ? { ...d, status: "downloading" } : d,
        ),
      );
      void browserViewAllowDownload(browserViewId, item.url, item.name).catch(
        () => {
          setDownloads((prev) =>
            prev.map((d) =>
              d.url === item.url ? { ...d, status: "failed" } : d,
            ),
          );
        },
      );
    },
    [browserViewId],
  );

  const denyDownload = useCallback(
    (item: DownloadItem) => {
      setDownloads((prev) =>
        prev.map((d) => (d.url === item.url ? { ...d, status: "denied" } : d)),
      );
      if (browserViewId != null) {
        void browserViewDenyDownload(browserViewId, item.url).catch(() => {});
      }
    },
    [browserViewId],
  );

  // Dismiss on outside click. A CAPTURE-phase listener is used deliberately: it
  // runs before React's root handlers, so it cannot be defeated by a
  // stopPropagation somewhere in the tree. Containment is tested by ref rather
  // than by comparing targets.
  useEffect(() => {
    if (!downloadsOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (downloadsPanelRef.current?.contains(t)) return;
      if (downloadsBtnRef.current?.contains(t)) return;
      setDownloadsOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [downloadsOpen]);

  const switchTab = useCallback((tab: DevtoolsTab) => {
    setDevtoolsTab(tab);
    lastTabRef.current = tab;
  }, []);

  /* ---- Element inspector toggle ---- */

  const toggleInspect = useCallback(() => {
    const newVal = !inspectModeRef.current;
    setInspectMode(newVal);
    inspectModeRef.current = newVal;
    if (browserViewId != null) {
      // Same commands, delivered by eval instead of postMessage — a child
      // webview has no parent frame to message.
      const fn = newVal ? "__madeInspectStart" : "__madeInspectStop";
      void browserViewEval(browserViewId, `window.${fn}&&window.${fn}()`).catch(
        () => {},
      );
      return;
    }
    const msg = newVal ? "made-inspect-start" : "made-inspect-stop";
    iframeRef.current?.contentWindow?.postMessage({ type: msg }, "*");
  }, [browserViewId]);

  /* ---- Fetch proxy port on mount (with retry) ----                  */
  /*  The preview proxy lives in the Tauri Rust backend so it works in  */
  /*  both `npm run tauri:dev` and a packaged production build.         */

  useEffect(() => {
    let cancelled = false;
    const fetchPort = async (retries = 3) => {
      try {
        const port = await invoke<number>("preview_proxy_port");
        if (cancelled) return;
        if (port > 0) {
          setProxyPort(port);
        } else if (retries > 0) {
          setTimeout(() => fetchPort(retries - 1), 500);
        }
      } catch {
        if (!cancelled && retries > 0) {
          setTimeout(() => fetchPort(retries - 1), 500);
        }
      }
    };
    fetchPort();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---- Configure proxy target when URL changes ---- */

  useEffect(() => {
    if (!proxyPort) {
      setProxyActive(false);
      return;
    }
    try {
      const parsed = new URL(url);
      invoke("preview_proxy_set_target", { url: parsed.origin })
        .then(() => setProxyActive(true))
        .catch(() => setProxyActive(false));
    } catch {
      setProxyActive(false);
    }
  }, [url, proxyPort]);

  /* ---- Compute iframe src ---- */

  const iframeSrc = (() => {
    if (!proxyPort || !proxyActive) return url;
    try {
      const parsed = new URL(url);
      return `http://127.0.0.1:${proxyPort}${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return url;
    }
  })();

  /* ---- Native surface: navigation ---- */

  // The surface opens at the URL it was created with, so skip the first run;
  // after that a URL change is a navigate command, never a remount.
  const lastNavigatedRef = useRef<string | null>(null);
  useEffect(() => {
    if (browserViewId == null) return;
    if (lastNavigatedRef.current === null) {
      lastNavigatedRef.current = url;
      return;
    }
    if (lastNavigatedRef.current === url) return;
    lastNavigatedRef.current = url;
    void browserViewNavigate(browserViewId, url).catch(() => {});
  }, [browserViewId, url]);

  /* ---- Native surface: DevTools + policy events ---- */

  useEffect(() => {
    if (browserViewId == null) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const track = (p: Promise<() => void>) => {
      void p.then((un) => (disposed ? un() : unlisteners.push(un))).catch(() => {});
    };

    // The injected script's records arrive already validated by Rust (closed
    // kind set, size/batch caps, rate limit). They are still UNTRUSTED page
    // output, so they are only ever parsed into panel state and rendered as
    // text — never interpreted, never injected as HTML.
    track(
      subscribeBrowserDevtools(browserViewId, (e) => {
        for (const item of e.items) {
          // Every payload is the same message object the iframe path posts.
          let parsed: { type?: string; url?: string; focused?: boolean } | null =
            null;
          try {
            parsed = JSON.parse(item.payload);
          } catch {
            continue;
          }
          if (!parsed || typeof parsed.type !== "string") continue;
          // The envelope's `kind` is validated in Rust, but the payload's own
          // `type` is page-controlled. Require the two to AGREE, so a page
          // cannot send kind:"console" carrying a payload labelled as storage
          // or inspect-result and inject into a panel it was never allowed to
          // reach. (Only this component listens on the window bus today, so the
          // reach is small — but an unvalidated type is how that stops being
          // true the next time a listener is added.)
          if (parsed.type !== KIND_TO_MESSAGE_TYPE[item.kind]) continue;

          if (parsed.type === "made-focus") {
            // The surface owns real Win32 focus while you type in it, which
            // blurs MADE's main webview. Folded into appWindowFocused so the
            // accent ring doesn't drop the moment you click a page.
            useAppStore.getState().setBrowserViewFocused(!!parsed.focused);
            continue;
          }
          if (parsed.type === "made-url") {
            // Native reports the REAL url. (The iframe path has to rewrite a
            // proxy url back onto the target origin — no such step here.)
            if (typeof parsed.url === "string") setInputUrl(parsed.url);
            continue;
          }
          if (parsed.type === "made-ready") {
            setIsLoading(false);
            if (inspectModeRef.current) {
              void browserViewEval(
                browserViewId,
                "window.__madeInspectStart&&window.__madeInspectStart()",
              ).catch(() => {});
            }
            if (devtoolsTabRef.current === "storage") {
              void browserViewEval(
                browserViewId,
                "window.__madeReadStorage&&window.__madeReadStorage()",
              ).catch(() => {});
            }
            continue;
          }
          // console / network / storage / inspect-result: hand straight to the
          // existing panel reducers, unchanged.
          window.postMessage(parsed, "*");
        }
      }),
    );

    // A navigation the security policy refused. Surfaced in the console panel
    // so a blocked click is visible rather than mysteriously doing nothing.
    track(
      subscribeBrowserBlocked(browserViewId, (e) => {
        setIsLoading(false);
        setConsoleEntries((prev) => {
          const next = [
            ...prev,
            {
              id: ++entryIdRef.current,
              method: "warn" as ConsoleEntry["method"],
              text: `Blocked navigation to ${e.url} — ${e.reason}`,
              timestamp: Date.now(),
            },
          ];
          return next.length > 500 ? next.slice(-500) : next;
        });
      }),
    );

    // window.open / target=_blank are denied at the webview (no uncontrolled
    // popups). Same-pane navigation is the browser-like behaviour here.
    track(
      subscribeBrowserPopup(browserViewId, (e) => {
        navigateTo(e.url);
      }),
    );

    // Address bar follows real navigations, reported by Rust rather than by a
    // patched history.pushState.
    track(
      subscribeBrowserNavigated(browserViewId, (e) => {
        setInputUrl(e.url);
        // Learn the Jira site the first time one is seen, so a Jira project
        // doesn't have to be told an address it could just watch you visit.
        // Only fills a BLANK setting — never overrides a configured one.
        const store = useAppStore.getState();
        if (!store.jiraBaseUrl?.trim()) {
          const origin = jiraOriginFromUrl(e.url);
          if (origin) store.setJiraBaseUrl(origin);
        }
      }),
    );

    // Downloads follow Chrome: allowed, into the Downloads folder, conflicts
    // uniquified. Reported into the console so a download is never silent —
    // Chrome shows a shelf; this is the equivalent affordance until the pane
    // grows a proper one.
    track(
      subscribeBrowserDownload(browserViewId, (e) => {
        setDownloads((prev) => {
          const idx = prev.findIndex((d) => d.url === e.url);
          const next = [...prev];
          const patch: DownloadItem =
            e.phase === "request"
              ? {
                  url: e.url,
                  name: e.name ?? "download",
                  status: "pending",
                  path: null,
                }
              : e.phase === "start"
                ? {
                    url: e.url,
                    name: prev[idx]?.name ?? "download",
                    status: "downloading",
                    path: e.path ?? null,
                  }
                : {
                    url: e.url,
                    name: prev[idx]?.name ?? "download",
                    status: e.success ? "done" : "failed",
                    path: e.path ?? prev[idx]?.path ?? null,
                  };
          if (idx === -1) next.push(patch);
          else next[idx] = patch;
          // Newest first, capped — a shelf is not a history page.
          return next.slice(-20);
        });
        // A download needing a decision must be visible without hunting for it.
        if (e.phase === "request") setDownloadsOpen(true);
      }),
    );

    return () => {
      disposed = true;
      for (const un of unlisteners) un();
      // A pane closed while its page held focus would otherwise pin
      // appWindowFocused true forever — no blur can arrive from a dead surface.
      useAppStore.getState().setBrowserViewFocused(false);
    };
  }, [browserViewId, navigateTo]);

  /* ---- Listen for all postMessage events from injected script ---- */

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!e.data?.type) return;

      if (e.data.type === "made-console") {
        setConsoleEntries((prev) => {
          const next = [
            ...prev,
            {
              id: ++entryIdRef.current,
              method: e.data.method as ConsoleEntry["method"],
              text: e.data.text as string,
              timestamp: e.data.timestamp as number,
            },
          ];
          return next.length > 500 ? next.slice(-500) : next;
        });
      }

      if (e.data.type === "made-network") {
        if (e.data.phase === "start") {
          setNetworkEntries((prev) => {
            const next = [
              ...prev,
              {
                id: e.data.id as number,
                method: e.data.method as string,
                url: e.data.url as string,
                status: -1,
                statusText: "",
                duration: 0,
                size: 0,
                timestamp: e.data.timestamp as number,
              },
            ];
            return next.length > 500 ? next.slice(-500) : next;
          });
        }
        if (e.data.phase === "end") {
          const id = e.data.id as number;
          setNetworkEntries((prev) => {
            const idx = prev.findIndex(
              (entry) => entry.id === id && entry.status === -1,
            );
            if (idx === -1) return prev;
            const next = [...prev];
            next[idx] = {
              ...next[idx],
              status: e.data.status as number,
              statusText: e.data.statusText as string,
              duration: e.data.duration as number,
              size: e.data.size as number,
              error: e.data.error as string | undefined,
            };
            return next;
          });
        }
      }

      if (e.data.type === "made-inspect-result") {
        const el = e.data.element as InspectedElement;
        setInspectedElement(el);
        setDevtoolsTab("elements");
        lastTabRef.current = "elements";
      }

      if (e.data.type === "made-storage") {
        setStorageData({
          localStorage: e.data.localStorage as Record<string, string>,
          sessionStorage: e.data.sessionStorage as Record<string, string>,
          cookies: e.data.cookies as Record<string, string>,
          timestamp: e.data.timestamp as number,
        });
      }

      if (e.data.type === "made-url") {
        try {
          const proxyUrl = new URL(e.data.url as string);
          const parsed = new URL(url);
          const original = `${parsed.origin}${proxyUrl.pathname}${proxyUrl.search}${proxyUrl.hash}`;
          setInputUrl(original);
        } catch {
          /* ignore */
        }
      }

      if (e.data.type === "made-ctxmenu") {
        // Iframe engine: a right-click inside the frame never bubbles out, so
        // the injected script forwards it here.
        const d = e.data as unknown as Partial<BrowserCtxMenuEvent>;
        openPageContextMenu({
          x: Number(d.x) || 0,
          y: Number(d.y) || 0,
          linkUrl: typeof d.linkUrl === "string" ? d.linkUrl : "",
          linkText: typeof d.linkText === "string" ? d.linkText : "",
          imgUrl: typeof d.imgUrl === "string" ? d.imgUrl : "",
          selText: typeof d.selText === "string" ? d.selText : "",
          editable: !!d.editable,
        });
      }

      if (e.data.type === "made-ready") {
        // Re-enable inspect mode on new page loads
        if (inspectModeRef.current) {
          iframeRef.current?.contentWindow?.postMessage(
            { type: "made-inspect-start" },
            "*",
          );
        }
        // Auto-fetch storage if Storage tab is active
        if (devtoolsTabRef.current === "storage") {
          iframeRef.current?.contentWindow?.postMessage(
            { type: "made-read-storage" },
            "*",
          );
        }
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [url, openPageContextMenu]);

  /* ---- DevTools capture is OPT-IN per page ----
   *  The instrumentation patches window.fetch / XHR / console, which reads as
   *  automation to bot detection (it tripped Google's reCAPTCHA on an ordinary
   *  search). So it is injected only while the panel is open. Re-injected on
   *  every page load, since a navigation wipes the page's world.
   *
   *  Consequence worth knowing: capture starts when you OPEN the panel, so
   *  console/network from before that is not retained — same as Chrome, which
   *  also needs DevTools open to record network. */
  const devtoolsArmedRef = useRef<string>("");
  useEffect(() => {
    if (browserViewId == null || devtoolsTab === null) return;
    const token = `${browserViewId}:${url}`;
    if (devtoolsArmedRef.current === token) return;
    devtoolsArmedRef.current = token;
    void browserViewEnableDevtools(browserViewId).catch(() => {});
  }, [browserViewId, devtoolsTab, url]);

  /* ---- Auto-fetch storage when switching to Storage tab ---- */

  useEffect(() => {
    if (devtoolsTab !== "storage" || !captureActive) return;
    // Inlined rather than calling refreshStorage: that callback is declared
    // further down the component, and a dep array is evaluated DURING render —
    // referencing it here would throw on every render (TDZ).
    if (browserViewId != null) {
      void browserViewEval(
        browserViewId,
        "window.__madeReadStorage&&window.__madeReadStorage()",
      ).catch(() => {});
      return;
    }
    iframeRef.current?.contentWindow?.postMessage(
      { type: "made-read-storage" },
      "*",
    );
  }, [devtoolsTab, captureActive, browserViewId]);

  /* ---- Auto-scroll console + network to bottom ---- */

  useEffect(() => {
    if (devtoolsTab === "console") {
      consoleEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [consoleEntries, devtoolsTab]);

  useEffect(() => {
    if (devtoolsTab === "network") {
      networkEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [networkEntries, devtoolsTab]);

  /* ---- Auto-reload interval ---- */

  useEffect(() => {
    if (!autoReload) return;
    const id = setInterval(() => setIframeKey((k) => k + 1), 2000);
    return () => clearInterval(id);
  }, [autoReload]);

  /* ---- Persist DevTools pin ---- */

  useEffect(() => {
    localStorage.setItem("made-devtools-pinned", String(devtoolsPinned));
  }, [devtoolsPinned]);

  const togglePin = useCallback(() => setDevtoolsPinned((v) => !v), []);

  /* ---- DevTools resize ---- */

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      // Distance from cursor to bottom of container = new panel height.
      // Reserve ~120px for URL bar + iframe minimum.
      const next = Math.max(80, Math.min(rect.bottom - ev.clientY, rect.height - 120));
      setDevtoolsHeight(next);
    };

    const onUp = () => {
      resizingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      // Persist final height
      setDevtoolsHeight((h) => {
        localStorage.setItem("made-devtools-height", String(h));
        return h;
      });
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  /* ---- Viewport dimensions ---- */

  const getViewportDims = (): { width: number; height: number } | null => {
    if (viewportMode === "responsive") return null;
    if (viewportMode === "custom")
      return { width: customWidth, height: customHeight };
    const preset = VIEWPORT_PRESETS.find((p) => p.mode === viewportMode);
    return preset?.width && preset?.height
      ? { width: preset.width, height: preset.height }
      : null;
  };

  const vpDims = getViewportDims();

  /* ---- Devtools context actions ---- */

  const clearActive = useCallback(() => {
    if (devtoolsTab === "console") setConsoleEntries([]);
    if (devtoolsTab === "network") setNetworkEntries([]);
    if (devtoolsTab === "elements") setInspectedElement(null);
  }, [devtoolsTab]);

  const refreshStorage = useCallback(() => {
    if (browserViewId != null) {
      void browserViewEval(
        browserViewId,
        "window.__madeReadStorage&&window.__madeReadStorage()",
      ).catch(() => {});
      return;
    }
    iframeRef.current?.contentWindow?.postMessage(
      { type: "made-read-storage" },
      "*",
    );
  }, [browserViewId]);

  /* ---- Badge count for active tab ---- */

  const tabBadgeCount = (): number => {
    switch (devtoolsTab) {
      case "console":
        return consoleEntries.length;
      case "network":
        return networkEntries.length;
      case "storage":
        return storageData
          ? Object.keys(storageData.localStorage).length +
              Object.keys(storageData.sessionStorage).length +
              Object.keys(storageData.cookies).length
          : 0;
      default:
        return 0;
    }
  };

  /* ================================================================ */
  /*  Render                                                           */
  /* ================================================================ */

  return (
    <div
      ref={containerRef}
      data-ctx-surface="browser"
      data-ctx-id="browser"
      data-ctx-url={url}
      data-ctx-can-back={canGoBack ? "1" : ""}
      data-ctx-can-forward={canGoForward ? "1" : ""}
      className="flex flex-col h-full w-full"
      style={{ backgroundColor: "var(--ezy-bg)" }}
    >
      {/* ---- URL Bar ---- */}
      <div
        className="flex items-center gap-1.5 select-none"
        style={{
          height: 36,
          backgroundColor: "var(--ezy-surface)",
          borderBottom: "1px solid var(--ezy-border)",
          padding: "0 8px",
        }}
      >
        <NavButton title="Back" disabled={!canGoBack} onClick={goBack}>
          <FaChevronLeft size={14} color="currentColor" />
        </NavButton>

        <NavButton title="Forward" disabled={!canGoForward} onClick={goForward}>
          <FaChevronRight size={14} color="currentColor" />
        </NavButton>

        {isLoading || showWaiting ? (
          <NavButton title="Stop loading" onClick={stopLoading}>
            <FaXmark size={13} color="currentColor" />
          </NavButton>
        ) : (
          <NavButton title="Refresh" onClick={refresh}>
            <BiRefresh size={14} color="currentColor" />
          </NavButton>
        )}

        <NavButton title="Hard Reload (clear storage)" onClick={hardReload}>
          <FaArrowsRotate size={14} color="currentColor" />
        </NavButton>

        {/* URL input */}
        <div
          className="flex-1 flex items-center"
          style={{
            height: 24,
            backgroundColor: "var(--ezy-bg)",
            borderRadius: 4,
            border: "1px solid var(--ezy-border)",
            padding: "0 8px",
          }}
        >
          <FaGlobe size={12} color="var(--ezy-text-muted)" style={{ flexShrink: 0, marginRight: 6 }} />
          <input
            type="text"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") navigateTo(inputUrl);
              // Esc restores the address bar to the page you are actually on,
              // matching Chrome.
              if (e.key === "Escape") {
                setInputUrl(url);
                e.currentTarget.blur();
              }
            }}
            // Chrome's address-bar behaviour: the first click selects the whole
            // URL so you can type over it, and only a second click inside an
            // already-focused field places the caret.
            onFocus={(e) => {
              urlFocusedRef.current = false;
              e.currentTarget.select();
            }}
            onMouseUp={(e) => {
              if (!urlFocusedRef.current) {
                urlFocusedRef.current = true;
                // Cancel the caret placement this click would otherwise do.
                e.preventDefault();
              }
            }}
            onBlur={() => {
              urlFocusedRef.current = false;
            }}
            className="flex-1 bg-transparent outline-none"
            style={{
              fontSize: 12,
              color: "var(--ezy-text)",
              border: "none",
              fontFamily: "inherit",
            }}
            spellCheck={false}
          />
        </div>

        {/* Open in default browser */}
        <NavButton
          title="Open in Default Browser"
          onClick={() => openUrl(url).catch(() => {})}
        >
          <FaExternalLinkAlt size={14} color="currentColor" />
        </NavButton>

        {/* Inspect element */}
        <NavButton
          title={inspectMode ? "Stop Inspecting" : "Inspect Element"}
          onClick={toggleInspect}
          active={inspectMode}
        >
          <FaCrosshairs size={14} color="currentColor" />
        </NavButton>

        {/* DevTools toggle */}
        <NavButton
          title={devtoolsTab !== null ? "Hide DevTools" : "Show DevTools"}
          onClick={toggleDevtools}
          active={devtoolsTab !== null}
        >
          <FaTerminal size={14} color="currentColor" />
        </NavButton>

        {/* Downloads */}
        <div ref={downloadsBtnRef} style={{ position: "relative", flexShrink: 0 }}>
          <NavButton
            title="Downloads"
            onClick={toggleDownloads}
            active={downloadsOpen}
          >
            <FaDownload size={12} color="currentColor" />
          </NavButton>
          {pendingDownloads > 0 && (
            <span
              style={{
                position: "absolute",
                top: -1,
                right: -1,
                minWidth: 13,
                height: 13,
                padding: "0 3px",
                borderRadius: 7,
                backgroundColor: "var(--ezy-accent)",
                color: "#000",
                fontSize: 10,
                lineHeight: "13px",
                fontWeight: 700,
                textAlign: "center",
                fontVariantNumeric: "tabular-nums",
                pointerEvents: "none",
              }}
            >
              {pendingDownloads}
            </span>
          )}
        </div>

        {/* Viewport bar toggle */}
        <NavButton
          title={showViewportBar ? "Hide Viewport Bar" : "Show Viewport Bar"}
          onClick={() => setShowViewportBar((v) => !v)}
          active={showViewportBar}
        >
          <FaDesktop size={14} color="currentColor" />
        </NavButton>

        {/* Auto-reload toggle */}
        <NavButton
          title={autoReload ? "Stop Auto-reload" : "Auto-reload every 2s"}
          onClick={() => setAutoReload((v) => !v)}
          active={autoReload}
        >
          <BiTimer size={14} color="currentColor" />
        </NavButton>

        {/* Expand */}
        <PaneExpandButton className="p-1.5 rounded transition-colors hover:bg-[var(--ezy-border)]" />

        {/* Close */}
        <NavButton title="Close Preview" onClick={onClose} hoverColor="var(--ezy-red)">
          <FaXmark size={12} color="currentColor" />
        </NavButton>
      </div>

      {/* ---- Viewport Toolbar ---- */}
      {showViewportBar && (
        <div
          className="flex items-center gap-1.5 select-none"
          style={{
            height: 32,
            backgroundColor: "var(--ezy-surface)",
            borderBottom: "1px solid var(--ezy-border)",
            padding: "0 8px",
          }}
        >
          {VIEWPORT_PRESETS.map((preset) => (
            <button
              key={preset.mode}
              onClick={() => setViewportMode(preset.mode)}
              style={{
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: 10,
                border: "none",
                cursor: "pointer",
                backgroundColor:
                  viewportMode === preset.mode
                    ? "var(--ezy-accent)"
                    : "var(--ezy-surface-raised)",
                color:
                  viewportMode === preset.mode ? "#000" : "var(--ezy-text-muted)",
                fontFamily: "inherit",
                fontWeight: viewportMode === preset.mode ? 600 : 400,
                transition: "background-color 0.15s, color 0.15s",
              }}
            >
              {preset.label}
            </button>
          ))}

          {viewportMode === "custom" ? (
            <div className="flex items-center gap-1" style={{ marginLeft: 4 }}>
              <input
                type="number"
                value={customWidth}
                onChange={(e) => setCustomWidth(Number(e.target.value) || 0)}
                style={{
                  width: 52, height: 20, fontSize: 11,
                  backgroundColor: "var(--ezy-bg)", color: "var(--ezy-text)",
                  border: "1px solid var(--ezy-border)", borderRadius: 3,
                  padding: "0 4px", fontFamily: "inherit",
                  fontVariantNumeric: "tabular-nums", outline: "none",
                }}
              />
              <span style={{ fontSize: 11, color: "var(--ezy-text-muted)" }}>x</span>
              <input
                type="number"
                value={customHeight}
                onChange={(e) => setCustomHeight(Number(e.target.value) || 0)}
                style={{
                  width: 52, height: 20, fontSize: 11,
                  backgroundColor: "var(--ezy-bg)", color: "var(--ezy-text)",
                  border: "1px solid var(--ezy-border)", borderRadius: 3,
                  padding: "0 4px", fontFamily: "inherit",
                  fontVariantNumeric: "tabular-nums", outline: "none",
                }}
              />
            </div>
          ) : vpDims ? (
            <span
              style={{
                fontSize: 11, color: "var(--ezy-text-muted)",
                marginLeft: 4, fontVariantNumeric: "tabular-nums",
              }}
            >
              {vpDims.width} x {vpDims.height}
            </span>
          ) : null}
        </div>
      )}

      {/* ---- Iframe Container ---- */}
      <div
        className="flex-1 min-h-0 flex items-center justify-center overflow-auto"
        style={{ backgroundColor: vpDims ? "var(--ezy-bg)" : undefined }}
      >
        <div
          style={
            vpDims
              ? {
                  width: vpDims.width, height: vpDims.height,
                  border: "1px solid var(--ezy-border)",
                  borderRadius: PREVIEW_FRAME_RADIUS, overflow: "hidden", flexShrink: 0,
                }
              : { width: "100%", height: "100%" }
          }
        >
          {showWaiting ? (
            <DevServerWaitingState devServer={linkedDevServer ?? null} />
          ) : useIframe ? (
            <iframe
              key={iframeKey}
              ref={iframeRef}
              src={iframeSrc}

              className="w-full h-full border-none"
              style={{ backgroundColor: "#ffffff" }}
            />
          ) : (
            /* Native surface anchor. Nothing renders INSIDE it — the wry webview
             * is a child HWND parked over this rect by the geometry driver, so
             * any DOM child would be painted over. Same white backdrop the
             * iframe used, so the pre-load frame looks identical. */
            <div
              ref={surfaceAnchorRef}
              data-browser-surface
              className="w-full h-full"
              // Deliberately NOT white. This colour is only ever visible when the
              // webview is absent, and a white anchor made "no surface at all"
              // look identical to "a loaded blank page" — which is exactly how
              // the threadpool-starvation hang presented ("white at all times").
              // The webview paints its own white background once it exists.
              style={{
                backgroundColor: "var(--ezy-bg)",
                position: "relative",
              }}
            >
              {(surfaceError || browserViewId == null) && (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: 24,
                    textAlign: "center",
                    fontSize: 12,
                    lineHeight: 1.5,
                    color: "var(--ezy-text-muted)",
                    backgroundColor: "var(--ezy-surface)",
                  }}
                >
                  {surfaceError ?? "Starting browser\u2026"}
                </div>
              )}
            </div>
          )}
        </div>
      </div>


      {/* ---- Downloads shelf (Chrome's download bubble) ----
       *  position:fixed because the pane is portaled into an overflow:hidden
       *  slot; an absolutely-positioned panel would be clipped away. The native
       *  surface is suppressed while this is open (see `hidden` above) because a
       *  child HWND always paints over DOM.                                   */}
      {downloadsOpen && (
        <div
          ref={downloadsPanelRef}
          data-ctx-surface="browser-downloads"
          style={{
            position: "fixed",
            top: downloadsAnchor.top,
            right: downloadsAnchor.right,
            width: 340,
            maxHeight: 360,
            overflowY: "auto",
            backgroundColor: "var(--ezy-surface-raised, var(--ezy-surface))",
            border: "1px solid var(--ezy-border)",
            borderRadius: 6,
            boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
            zIndex: 400,
            overflowX: "hidden",
          }}
          className="ezy-popup-scroll"
        >
          <div
            style={{
              padding: "7px 10px",
              fontSize: 11,
              fontWeight: 600,
              color: "var(--ezy-text-secondary)",
              borderBottom: "1px solid var(--ezy-border-subtle)",
              position: "sticky",
              top: 0,
              backgroundColor: "var(--ezy-surface-raised, var(--ezy-surface))",
            }}
          >
            Downloads
          </div>

          {downloads.length === 0 && (
            <div style={{ padding: "10px", fontSize: 11, color: "var(--ezy-text-muted)" }}>
              Nothing downloaded yet. Every download asks before it is saved.
            </div>
          )}

          {[...downloads].reverse().map((d) => (
            <div
              key={d.url}
              style={{
                padding: "8px 10px",
                borderBottom: "1px solid var(--ezy-border-subtle)",
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  color: "var(--ezy-text)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                data-tooltip={d.url}
              >
                {d.name}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color:
                    d.status === "failed"
                      ? "var(--ezy-red)"
                      : "var(--ezy-text-muted)",
                  marginTop: 2,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                data-tooltip={d.path ?? undefined}
              >
                {d.status === "pending"
                  ? "Waiting for your decision"
                  : d.status === "downloading"
                    ? "Saving\u2026"
                    : d.status === "done"
                      ? (d.path ?? "Saved")
                      : d.status === "denied"
                        ? "Blocked"
                        : "Failed"}
              </div>

              {d.status === "pending" && (
                <div style={{ display: "flex", gap: 6, marginTop: 7 }}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => allowDownload(d)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") allowDownload(d);
                    }}
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      padding: "3px 10px",
                      borderRadius: 4,
                      cursor: "pointer",
                      backgroundColor: "var(--ezy-accent)",
                      color: "#000",
                      outline: "none",
                    }}
                  >
                    Save
                  </div>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => denyDownload(d)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") denyDownload(d);
                    }}
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      padding: "3px 10px",
                      borderRadius: 4,
                      cursor: "pointer",
                      backgroundColor: "var(--ezy-border)",
                      color: "var(--ezy-text)",
                      outline: "none",
                    }}
                  >
                    Block
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ---- DevTools Panel (tabbed) ---- */}
      {devtoolsTab !== null && (
        <div
          className="flex flex-col"
          style={{
            height: devtoolsHeight,
            borderTop: "1px solid var(--ezy-border)",
            backgroundColor: "var(--ezy-surface)",
            flexShrink: 0,
          }}
        >
          {/* Resize handle */}
          <div
            onMouseDown={startResize}
            data-tooltip="Drag to resize"
            style={{
              height: 4,
              marginTop: -2,
              marginBottom: -2,
              cursor: "row-resize",
              flexShrink: 0,
              zIndex: 1,
            }}
          />
          {/* Tab header */}
          <div
            className="flex items-center gap-1 select-none"
            style={{
              height: 28, padding: "0 8px", flexShrink: 0,
              borderBottom: "1px solid var(--ezy-border)",
            }}
          >
            {DEVTOOLS_TABS.map(({ tab, label }) => (
              <div
                key={tab}
                role="button"
                tabIndex={0}
                onClick={() => switchTab(tab)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") switchTab(tab);
                }}
                style={{
                  fontSize: 11,
                  padding: "2px 8px",
                  borderRadius: 4,
                  cursor: "pointer",
                  backgroundColor:
                    devtoolsTab === tab
                      ? "var(--ezy-accent-dim)"
                      : "transparent",
                  color:
                    devtoolsTab === tab
                      ? "#ffffff"
                      : "var(--ezy-text-muted)",
                  fontWeight: devtoolsTab === tab ? 600 : 400,
                  fontFamily: "inherit",
                  transition: "background-color 0.15s, color 0.15s",
                  outline: "none",
                }}
              >
                {label}
              </div>
            ))}

            {captureActive && (
              <span
                style={{
                  fontSize: 10, padding: "1px 6px", borderRadius: 8,
                  backgroundColor: "var(--ezy-accent-dim)",
                  color: "#ffffff", marginLeft: 2, fontWeight: 600,
                }}
              >
                live
              </span>
            )}

            {tabBadgeCount() > 0 && (
              <span
                style={{
                  fontSize: 10, padding: "1px 6px", borderRadius: 8,
                  backgroundColor: "var(--ezy-surface-raised)",
                  color: "var(--ezy-text-muted)",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {tabBadgeCount()}
              </span>
            )}

            {/* Auto-debug toggle — only on console tab */}
            {devtoolsTab === "console" && (
              <NavButton
                title={autoDebug ? "Disable auto error debug" : "Enable auto error debug"}
                onClick={() => useBrowserConsoleStore.getState().setAutoDebug(!autoDebug)}
                active={autoDebug}
                hoverColor="#ef4444"
              >
                <FaBug size={11} color="currentColor" />
              </NavButton>
            )}

            <div className="flex-1" />

            {!captureActive && (
              <span style={{ fontSize: 10, color: "var(--ezy-text-muted)" }}>
                {useIframe ? "Proxy unavailable" : "Surface not ready"}
              </span>
            )}

            {/* Context action */}
            {(devtoolsTab === "console" || devtoolsTab === "network" || devtoolsTab === "elements") && (
              <NavButton title="Clear" onClick={clearActive}>
                <FaTrash size={12} color="currentColor" />
              </NavButton>
            )}
            {devtoolsTab === "storage" && (
              <NavButton title="Refresh storage" onClick={refreshStorage}>
                <BiRefresh size={12} color="currentColor" />
              </NavButton>
            )}

            <NavButton
              title={devtoolsPinned ? "Unpin DevTools" : "Pin DevTools (auto-open)"}
              onClick={togglePin}
            >
              {devtoolsPinned ? (
                <FaLock size={12} color="currentColor" />
              ) : (
                <FaLockOpen size={12} color="currentColor" />
              )}
            </NavButton>

            <NavButton title="Close DevTools" onClick={() => setDevtoolsTab(null)}>
              <FaXmark size={12} color="currentColor" />
            </NavButton>
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-auto" style={{ padding: "4px 0" }}>
            {/* ---- Console Tab ---- */}
            {devtoolsTab === "console" && (
              <>
                {consoleEntries.length === 0 && (
                  <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--ezy-text-muted)" }}>
                    {captureActive ? "No console output yet." : "Console capture is not connected."}
                  </div>
                )}
                {consoleEntries.map((entry) => {
                  const selected = consoleSelectedIds.has(entry.id);
                  return (
                    <div
                      key={entry.id}
                      className="flex gap-2"
                      style={{
                        padding: "1px 12px", fontSize: 12, lineHeight: "18px",
                        color: consoleMethodColor(entry.method),
                        borderBottom: "1px solid var(--ezy-border-subtle)",
                        cursor: consoleSelectMode ? "pointer" : undefined,
                        backgroundColor: selected ? "rgba(255,255,255,0.06)" : undefined,
                      }}
                      onClick={consoleSelectMode ? () => toggleConsoleSelected(entry.id) : undefined}
                    >
                      {consoleSelectMode && (
                        <span
                          style={{
                            flexShrink: 0, width: 14, height: 14,
                            borderRadius: "50%",
                            border: selected ? "none" : "1.5px solid var(--ezy-text-muted)",
                            backgroundColor: selected ? "var(--ezy-accent, #10b981)" : "transparent",
                            display: "inline-flex", alignItems: "center", justifyContent: "center",
                            alignSelf: "center",
                            transition: "background-color 100ms ease",
                          }}
                        >
                          {selected && (
                            <FaCheck size={8} color="#fff" />
                          )}
                        </span>
                      )}
                      <span
                        style={{
                          fontSize: 10, color: "var(--ezy-text-muted)",
                          fontVariantNumeric: "tabular-nums",
                          flexShrink: 0, lineHeight: "18px",
                        }}
                      >
                        {fmtTime(entry.timestamp)}
                      </span>
                      <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                        {entry.text}
                      </span>
                    </div>
                  );
                })}
                <div ref={consoleEndRef} />
              </>
            )}

            {/* ---- Network Tab ---- */}
            {devtoolsTab === "network" && (
              <>
                {/* Column headers */}
                <div
                  className="flex gap-2 select-none"
                  style={{
                    padding: "2px 12px", fontSize: 10, lineHeight: "16px",
                    color: "var(--ezy-text-muted)", fontWeight: 600,
                    borderBottom: "1px solid var(--ezy-border-subtle)",
                    position: "sticky", top: 0,
                    backgroundColor: "var(--ezy-surface)",
                  }}
                >
                  <span style={{ width: 36, flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>Status</span>
                  <span style={{ width: 44, flexShrink: 0 }}>Method</span>
                  <span style={{ flex: 1, minWidth: 0 }}>URL</span>
                  <span style={{ width: 52, flexShrink: 0, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>Time</span>
                  <span style={{ width: 56, flexShrink: 0, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>Size</span>
                </div>
                {networkEntries.length === 0 && (
                  <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--ezy-text-muted)" }}>
                    {captureActive ? "No network requests yet." : "Network capture is not connected."}
                  </div>
                )}
                {networkEntries.map((entry, i) => (
                  <div
                    key={`${entry.id}-${i}`}
                    className="flex gap-2"
                    style={{
                      padding: "1px 12px", fontSize: 11, lineHeight: "18px",
                      borderBottom: "1px solid var(--ezy-border-subtle)",
                      color: entry.error ? "var(--ezy-red)" : "var(--ezy-text)",
                    }}
                  >
                    <span
                      style={{
                        width: 36, flexShrink: 0,
                        fontVariantNumeric: "tabular-nums",
                        color: statusColor(entry.status),
                        fontWeight: 600,
                      }}
                    >
                      {entry.status === -1 ? "\u2022\u2022\u2022" : entry.status}
                    </span>
                    <span style={{ width: 44, flexShrink: 0, color: "var(--ezy-text-secondary)" }}>
                      {entry.method}
                    </span>
                    <span
                      style={{
                        flex: 1, minWidth: 0,
                        overflow: "hidden", textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      data-tooltip={entry.error ? `${entry.url}\n${entry.error}` : entry.url}
                    >
                      {entry.url}
                    </span>
                    <span
                      style={{
                        width: 52, flexShrink: 0, textAlign: "right",
                        fontVariantNumeric: "tabular-nums",
                        color: "var(--ezy-text-muted)",
                      }}
                    >
                      {entry.status === -1 ? "" : fmtDuration(entry.duration)}
                    </span>
                    <span
                      style={{
                        width: 56, flexShrink: 0, textAlign: "right",
                        fontVariantNumeric: "tabular-nums",
                        color: "var(--ezy-text-muted)",
                      }}
                    >
                      {entry.status === -1 ? "" : fmtSize(entry.size)}
                    </span>
                  </div>
                ))}
                <div ref={networkEndRef} />
              </>
            )}

            {/* ---- Elements Tab ---- */}
            {devtoolsTab === "elements" && (
              <>
                {!inspectedElement && (
                  <div
                    className="flex flex-col items-center justify-center h-full gap-2"
                    style={{ padding: "16px 12px" }}
                  >
                    <FaCrosshairs size={24} color="var(--ezy-text-muted)" style={{ opacity: 0.5 }} />
                    <span style={{ fontSize: 12, color: "var(--ezy-text-secondary)", fontWeight: 500 }}>
                      No element selected
                    </span>
                    <span style={{ fontSize: 11, color: "var(--ezy-text-muted)", textAlign: "center", maxWidth: 320, lineHeight: "16px" }}>
                      Click the inspect button in the toolbar, then click any
                      element in the preview to inspect it.
                    </span>
                  </div>
                )}
                {inspectedElement && (
                  <div style={{ padding: "6px 12px" }}>
                    {/* Element selector */}
                    <div style={{ marginBottom: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ezy-accent)" }}>
                        {"<"}{inspectedElement.tag}{">"}
                      </span>
                      {inspectedElement.id && (
                        <span
                          style={{
                            fontSize: 11, marginLeft: 6, padding: "1px 6px",
                            borderRadius: 4, backgroundColor: "var(--ezy-surface-raised)",
                            color: "var(--ezy-text)",
                          }}
                        >
                          #{inspectedElement.id}
                        </span>
                      )}
                      {inspectedElement.classes && (
                        <span
                          style={{
                            fontSize: 11, marginLeft: 4, color: "var(--ezy-text-secondary)",
                          }}
                        >
                          .{inspectedElement.classes.split(/\s+/).join(".")}
                        </span>
                      )}
                    </div>

                    {/* Dimensions */}
                    <div style={{ fontSize: 11, color: "var(--ezy-text-muted)", marginBottom: 8, fontVariantNumeric: "tabular-nums" }}>
                      {inspectedElement.rect.width} x {inspectedElement.rect.height}px
                      {" \u2014 "}
                      top: {inspectedElement.rect.top}, left: {inspectedElement.rect.left}
                    </div>

                    {/* Computed styles */}
                    <div style={{ fontSize: 11, color: "var(--ezy-text-muted)", fontWeight: 600, marginBottom: 4 }}>
                      Computed Styles
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "1px 12px" }}>
                      {Object.entries(inspectedElement.styles)
                        .filter(([, v]) => v && v !== "none" && v !== "normal" && v !== "auto" && v !== "visible" && v !== "0px")
                        .map(([key, val]) => (
                          <div key={key} style={{ display: "contents" }}>
                            <span style={{ fontSize: 11, color: "var(--ezy-text-muted)", lineHeight: "18px" }}>
                              {key}
                            </span>
                            <span style={{ fontSize: 11, color: "var(--ezy-text)", lineHeight: "18px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {val}
                            </span>
                          </div>
                        ))}
                    </div>
                  </div>
                )}
              </>
            )}

            {/* ---- Storage Tab ---- */}
            {devtoolsTab === "storage" && (
              <>
                {!storageData && (
                  <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--ezy-text-muted)" }}>
                    {captureActive ? "Loading storage..." : "Storage viewer is not connected."}
                  </div>
                )}
                {storageData && (
                  <>
                    {/* localStorage */}
                    <StorageSection
                      title="localStorage"
                      data={storageData.localStorage}
                    />
                    {/* sessionStorage */}
                    <StorageSection
                      title="sessionStorage"
                      data={storageData.sessionStorage}
                    />
                    {/* Cookies */}
                    <StorageSection
                      title="Cookies"
                      data={storageData.cookies}
                    />
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  StorageSection — renders a key-value section in the Storage tab    */
/* ------------------------------------------------------------------ */

function StorageSection({
  title,
  data,
}: {
  title: string;
  data: Record<string, string>;
}) {
  const keys = Object.keys(data);

  return (
    <div style={{ marginBottom: 8 }}>
      <div
        className="flex items-center gap-2"
        style={{
          padding: "4px 12px", fontSize: 11, fontWeight: 600,
          color: "var(--ezy-text-secondary)",
          borderBottom: "1px solid var(--ezy-border-subtle)",
          position: "sticky", top: 0,
          backgroundColor: "var(--ezy-surface)",
        }}
      >
        {title}
        <span
          style={{
            fontSize: 10, padding: "0px 5px", borderRadius: 6,
            backgroundColor: "var(--ezy-surface-raised)",
            color: "var(--ezy-text-muted)",
            fontWeight: 400, fontVariantNumeric: "tabular-nums",
          }}
        >
          {keys.length}
        </span>
      </div>
      {keys.length === 0 && (
        <div style={{ padding: "3px 12px", fontSize: 11, color: "var(--ezy-text-muted)" }}>
          (empty)
        </div>
      )}
      {keys.map((key) => (
        <div
          key={key}
          className="flex gap-3"
          style={{
            padding: "1px 12px", fontSize: 11, lineHeight: "18px",
            borderBottom: "1px solid var(--ezy-border-subtle)",
          }}
        >
          <span
            style={{
              width: 140, flexShrink: 0,
              color: "var(--ezy-accent)",
              overflow: "hidden", textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            data-tooltip={key}
          >
            {key}
          </span>
          <span
            style={{
              flex: 1, minWidth: 0,
              color: "var(--ezy-text-muted)",
              overflow: "hidden", textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            data-tooltip={data[key]}
          >
            {data[key]}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  DevServerWaitingState — shown in linked browser panes while the    */
/*  dev server hasn't reached "running" with a real port yet. Replaces */
/*  the iframe to avoid the "can't reach page" race.                   */
/* ------------------------------------------------------------------ */

function DevServerWaitingState({
  devServer,
}: {
  devServer:
    | {
        status: "starting" | "running" | "stopped" | "error";
        port: number;
        command?: string;
        projectName?: string;
        errorMessage?: string;
        serverId?: string;
      }
    | null;
}) {
  // Map dev-server state to a one-line human description. Cyan/emerald/red
  // only — CLAUDE.md bans amber/yellow/blue, and tinted soft badges.
  const status = devServer?.status ?? "starting";
  const port = devServer?.port ?? 0;
  const isError = status === "error" || status === "stopped";

  let statusLine: string;
  if (isError && devServer?.errorMessage) {
    statusLine = devServer.errorMessage;
  } else if (status === "stopped") {
    statusLine = "Dev server stopped.";
  } else if (status === "error") {
    statusLine = "Dev server failed to start.";
  } else if (port === 0) {
    statusLine = "Starting — detecting port…";
  } else if (devServer?.serverId) {
    statusLine = "Opening SSH tunnel…";
  } else {
    statusLine = "Connecting…";
  }

  const accent = isError ? "var(--ezy-red, #d13b3b)" : "var(--ezy-accent)";

  return (
    <div
      className="w-full h-full flex items-center justify-center"
      style={{
        backgroundColor: "var(--ezy-surface)",
        color: "var(--ezy-text)",
        // Subtle vignette for atmosphere — keeps the area from feeling like a
        // blank crash page when the iframe is intentionally not loaded yet.
        backgroundImage:
          "radial-gradient(ellipse at center, var(--ezy-surface-raised, var(--ezy-surface)) 0%, var(--ezy-surface) 60%, var(--ezy-bg) 100%)",
      }}
    >
      <div
        style={{
          textAlign: "center",
          maxWidth: 360,
          padding: "0 24px",
        }}
      >
        {/* Spinner / error icon. Continuous rotation only — no animate-pulse. */}
        <div
          style={{
            width: 36,
            height: 36,
            margin: "0 auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: accent,
          }}
        >
          {isError ? (
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          ) : (
            <svg className="animate-spin" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 12a9 9 0 1 1-6.2-8.55" />
            </svg>
          )}
        </div>

        <div
          style={{
            marginTop: 18,
            fontSize: 14,
            fontWeight: 600,
            letterSpacing: "-0.01em",
            color: "var(--ezy-text)",
          }}
        >
          {isError ? "Dev server unavailable" : "Waiting for dev server"}
        </div>

        <div
          style={{
            marginTop: 8,
            fontSize: 12,
            lineHeight: 1.5,
            color: "var(--ezy-text-muted)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {statusLine}
        </div>

        {devServer?.command && (
          <div
            style={{
              marginTop: 14,
              padding: "6px 10px",
              fontSize: 11,
              color: "var(--ezy-text-secondary)",
              backgroundColor: "var(--ezy-surface-raised, var(--ezy-bg))",
              border: "1px solid var(--ezy-border)",
              borderRadius: 4,
              display: "inline-block",
              maxWidth: "100%",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontVariantNumeric: "tabular-nums",
            }}
            data-tooltip={devServer.command}
          >
            {devServer.command}
          </div>
        )}
      </div>
    </div>
  );
}
