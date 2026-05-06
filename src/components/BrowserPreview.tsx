import { useState, useRef, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../store";
import { useBrowserConsoleStore, type ConsoleEntry } from "../store/browserConsoleStore";
import { FaCheck, FaChevronLeft, FaChevronRight, FaGlobe, FaExternalLinkAlt, FaCrosshairs, FaTerminal, FaDesktop, FaTrash, FaLock, FaLockOpen, FaBug } from "react-icons/fa";
import { FaArrowsRotate, FaXmark } from "react-icons/fa6";
import { BiRefresh, BiTimer } from "react-icons/bi";
import PaneExpandButton from "./PaneExpandButton";

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
      title={title}
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
  // Show waiting state only when the pane is linked and not yet ready.
  const showWaiting = !!linkedTabId && !linkedReady;

  /* ---- URL & History ---- */
  // For linked panes, prefer the live URL once known; otherwise fall back to
  // initialUrl (which may be about:blank or a stored URL from a saved layout).
  const initialResolvedUrl = linkedLiveUrl ?? initialUrl;
  const [url, setUrl] = useState(initialResolvedUrl);
  const [inputUrl, setInputUrl] = useState(initialResolvedUrl);
  const [history, setHistory] = useState<string[]>([initialResolvedUrl]);
  const [historyIndex, setHistoryIndex] = useState(0);

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
    () => localStorage.getItem("ezydev-devtools-pinned") === "true"
  );
  const [devtoolsTab, setDevtoolsTab] = useState<DevtoolsTab | null>(
    () => localStorage.getItem("ezydev-devtools-pinned") === "true" ? "console" : null
  );
  const lastTabRef = useRef<DevtoolsTab>("console");
  const [devtoolsHeight, setDevtoolsHeight] = useState<number>(() => {
    const saved = Number(localStorage.getItem("ezydev-devtools-height"));
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

  // Mirror console entries to standalone store for EzyComposer access
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
  // Listen for EzyComposer requesting console tab to open
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

  /* ---- Proxy state ---- */
  const [proxyPort, setProxyPort] = useState<number | null>(null);
  const [iframeKey, setIframeKey] = useState(0);
  const [proxyActive, setProxyActive] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const devtoolsTabRef = useRef<DevtoolsTab | null>(null);
  devtoolsTabRef.current = devtoolsTab;

  /* ---- Navigation ---- */

  const normalizeUrl = (raw: string): string => {
    const t = raw.trim();
    if (!t.startsWith("http://") && !t.startsWith("https://")) {
      return `http://${t}`;
    }
    return t;
  };

  const navigateTo = useCallback(
    (raw: string) => {
      const target = normalizeUrl(raw);
      setHistory((prev) => [...prev.slice(0, historyIndex + 1), target]);
      setHistoryIndex((prev) => prev + 1);
      setUrl(target);
      setInputUrl(target);
    },
    [historyIndex],
  );

  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < history.length - 1;

  const goBack = useCallback(() => {
    if (!canGoBack) return;
    const idx = historyIndex - 1;
    setHistoryIndex(idx);
    setUrl(history[idx]);
    setInputUrl(history[idx]);
  }, [canGoBack, history, historyIndex]);

  const goForward = useCallback(() => {
    if (!canGoForward) return;
    const idx = historyIndex + 1;
    setHistoryIndex(idx);
    setUrl(history[idx]);
    setInputUrl(history[idx]);
  }, [canGoForward, history, historyIndex]);

  /* ---- Refresh / Hard Reload ---- */

  const refresh = useCallback(() => {
    setIframeKey((k) => k + 1);
  }, []);

  const hardReload = useCallback(() => {
    try {
      iframeRef.current?.contentWindow?.postMessage(
        { type: "ezydev-clear-storage" },
        "*",
      );
    } catch {
      /* cross-origin safety */
    }
    setTimeout(() => setIframeKey((k) => k + 1), 150);
  }, []);

  /* ---- DevTools toggle / tab switching ---- */

  const toggleDevtools = useCallback(() => {
    setDevtoolsTab((prev) => {
      if (prev !== null) return null;
      return lastTabRef.current;
    });
  }, []);

  const switchTab = useCallback((tab: DevtoolsTab) => {
    setDevtoolsTab(tab);
    lastTabRef.current = tab;
  }, []);

  /* ---- Element inspector toggle ---- */

  const toggleInspect = useCallback(() => {
    const newVal = !inspectModeRef.current;
    setInspectMode(newVal);
    inspectModeRef.current = newVal;
    const msg = newVal ? "ezydev-inspect-start" : "ezydev-inspect-stop";
    iframeRef.current?.contentWindow?.postMessage({ type: msg }, "*");
  }, []);

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

  /* ---- Listen for all postMessage events from injected script ---- */

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!e.data?.type) return;

      if (e.data.type === "ezydev-console") {
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

      if (e.data.type === "ezydev-network") {
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

      if (e.data.type === "ezydev-inspect-result") {
        const el = e.data.element as InspectedElement;
        setInspectedElement(el);
        setDevtoolsTab("elements");
        lastTabRef.current = "elements";
      }

      if (e.data.type === "ezydev-storage") {
        setStorageData({
          localStorage: e.data.localStorage as Record<string, string>,
          sessionStorage: e.data.sessionStorage as Record<string, string>,
          cookies: e.data.cookies as Record<string, string>,
          timestamp: e.data.timestamp as number,
        });
      }

      if (e.data.type === "ezydev-url") {
        try {
          const proxyUrl = new URL(e.data.url as string);
          const parsed = new URL(url);
          const original = `${parsed.origin}${proxyUrl.pathname}${proxyUrl.search}${proxyUrl.hash}`;
          setInputUrl(original);
        } catch {
          /* ignore */
        }
      }

      if (e.data.type === "ezydev-ready") {
        // Re-enable inspect mode on new page loads
        if (inspectModeRef.current) {
          iframeRef.current?.contentWindow?.postMessage(
            { type: "ezydev-inspect-start" },
            "*",
          );
        }
        // Auto-fetch storage if Storage tab is active
        if (devtoolsTabRef.current === "storage") {
          iframeRef.current?.contentWindow?.postMessage(
            { type: "ezydev-read-storage" },
            "*",
          );
        }
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [url]);

  /* ---- Auto-fetch storage when switching to Storage tab ---- */

  useEffect(() => {
    if (devtoolsTab === "storage" && proxyActive) {
      iframeRef.current?.contentWindow?.postMessage(
        { type: "ezydev-read-storage" },
        "*",
      );
    }
  }, [devtoolsTab, proxyActive]);

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
    localStorage.setItem("ezydev-devtools-pinned", String(devtoolsPinned));
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
        localStorage.setItem("ezydev-devtools-height", String(h));
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
    iframeRef.current?.contentWindow?.postMessage(
      { type: "ezydev-read-storage" },
      "*",
    );
  }, []);

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

        <NavButton title="Refresh" onClick={refresh}>
          <BiRefresh size={14} color="currentColor" />
        </NavButton>

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
            onKeyDown={(e) => e.key === "Enter" && navigateTo(inputUrl)}
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
                  borderRadius: 4, overflow: "hidden", flexShrink: 0,
                }
              : { width: "100%", height: "100%" }
          }
        >
          {showWaiting ? (
            <DevServerWaitingState devServer={linkedDevServer ?? null} />
          ) : (
            <iframe
              key={iframeKey}
              ref={iframeRef}
              src={iframeSrc}
              title="Browser Preview"
              className="w-full h-full border-none"
              style={{ backgroundColor: "#ffffff" }}
            />
          )}
        </div>
      </div>

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
            title="Drag to resize"
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

            {proxyActive && (
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

            {!proxyActive && (
              <span style={{ fontSize: 10, color: "var(--ezy-text-muted)" }}>
                Proxy unavailable
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
                    {proxyActive ? "No console output yet." : "Console capture requires the preview proxy."}
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
                    {proxyActive ? "No network requests yet." : "Network capture requires the preview proxy."}
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
                      title={entry.error ? `${entry.url}\n${entry.error}` : entry.url}
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
                    {proxyActive ? "Loading storage..." : "Storage viewer requires the preview proxy."}
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
            title={key}
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
            title={data[key]}
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
            title={devServer.command}
          >
            {devServer.command}
          </div>
        )}
      </div>
    </div>
  );
}
