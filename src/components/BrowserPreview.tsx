import { useState, useRef, useCallback, useEffect } from "react";

interface BrowserPreviewProps {
  initialUrl: string;
  onClose: () => void;
}

interface ConsoleEntry {
  id: number;
  method: "log" | "warn" | "error" | "info";
  text: string;
  timestamp: number;
}

type ViewportMode = "responsive" | "mobile" | "fold" | "tablet" | "desktop" | "custom";

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

/* ------------------------------------------------------------------ */
/*  Console capture script — injected into fetched HTML via srcdoc.    */
/*  Overrides console methods + captures uncaught errors/rejections.  */
/* ------------------------------------------------------------------ */
const CONSOLE_CAPTURE_SCRIPT = `(function(){
if(window.__ezydevConsoleInjected)return;
window.__ezydevConsoleInjected=true;
var O={};
['log','warn','error','info'].forEach(function(m){
  O[m]=console[m];
  console[m]=function(){
    O[m].apply(console,arguments);
    try{
      var a=[];
      for(var i=0;i<arguments.length;i++){
        try{a.push(typeof arguments[i]==='object'?JSON.stringify(arguments[i]):String(arguments[i]))}
        catch(e){a.push(String(arguments[i]))}
      }
      window.parent.postMessage({type:'ezydev-console',method:m,text:a.join(' '),timestamp:Date.now()},'*');
    }catch(e){}
  };
});
window.addEventListener('error',function(e){
  window.parent.postMessage({type:'ezydev-console',method:'error',
    text:e.message+(e.filename?' at '+e.filename+':'+e.lineno:''),timestamp:Date.now()},'*');
});
window.addEventListener('unhandledrejection',function(e){
  window.parent.postMessage({type:'ezydev-console',method:'error',
    text:'Unhandled Promise: '+(e.reason&&e.reason.message?e.reason.message:String(e.reason)),timestamp:Date.now()},'*');
});
})();`;

/** Escape a string for safe use inside an HTML attribute value. */
const escAttr = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

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
          ? "var(--ezy-accent)"
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
/*  BrowserPreview                                                     */
/* ------------------------------------------------------------------ */
export default function BrowserPreview({
  initialUrl,
  onClose,
}: BrowserPreviewProps) {
  /* ---- URL & History ---- */
  const [url, setUrl] = useState(initialUrl);
  const [inputUrl, setInputUrl] = useState(initialUrl);
  const [history, setHistory] = useState<string[]>([initialUrl]);
  const [historyIndex, setHistoryIndex] = useState(0);

  /* ---- Viewport ---- */
  const [viewportMode, setViewportMode] =
    useState<ViewportMode>("responsive");
  const [customWidth, setCustomWidth] = useState(1280);
  const [customHeight, setCustomHeight] = useState(800);

  /* ---- Console ---- */
  const [showConsole, setShowConsole] = useState(false);
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([]);
  const [isCrossOrigin, setIsCrossOrigin] = useState(false);
  const consoleEndRef = useRef<HTMLDivElement>(null);
  const entryIdRef = useRef(0);

  /* ---- Auto-reload ---- */
  const [autoReload, setAutoReload] = useState(false);

  /* ---- Srcdoc proxy (enables console capture for cross-port localhost) ---- */
  const [srcdocHtml, setSrcdocHtml] = useState<string | null>(null);
  const [fetchKey, setFetchKey] = useState(0);

  const iframeRef = useRef<HTMLIFrameElement>(null);

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
    setFetchKey((k) => k + 1);
  }, []);

  const hardReload = useCallback(() => {
    // In srcdoc mode localStorage is shared with the parent app — skip clearing.
    // In direct-src mode (cross-origin fallback), try to clear but it'll fail silently.
    if (srcdocHtml == null) {
      try {
        const cw = iframeRef.current?.contentWindow;
        if (cw) cw.localStorage.clear();
      } catch {
        /* cross-origin */
      }
    }
    setFetchKey((k) => k + 1);
  }, [srcdocHtml]);

  /* ---- Fetch + srcdoc proxy ---- */
  /*
   * Strategy: fetch the page HTML through Vite's /__ezy_proxy__ middleware
   * (server-side fetch — no CORS restrictions), inject <base> + console
   * capture script, then load it as srcdoc. Srcdoc iframes with
   * allow-same-origin inherit the parent's origin, so postMessage works.
   * Falls back to direct src={url} if the proxy fetch fails.
   */

  useEffect(() => {
    let cancelled = false;

    // Clear previous srcdoc so iframe falls back to src={url} immediately
    // (shows the page while the fetch is in flight).
    setSrcdocHtml(null);
    setIsCrossOrigin(false);

    (async () => {
      try {
        // Fetch through Vite's server-side proxy to bypass CORS
        const proxyUrl = `/__ezy_proxy__?url=${encodeURIComponent(url)}`;
        const res = await fetch(proxyUrl, { cache: "no-store" });
        if (cancelled || !res.ok) {
          if (!cancelled) setIsCrossOrigin(true);
          return;
        }

        const ct = res.headers.get("content-type") || "";
        if (!ct.includes("text/html")) {
          // Non-HTML content (image, JSON, etc.) — keep direct src, no console
          return;
        }

        const html = await res.text();
        if (cancelled) return;

        // Build the injection: <base> for URL resolution + console capture script
        const baseTag = `<base href="${escAttr(url)}">`;
        const scriptTag = `<script>${CONSOLE_CAPTURE_SCRIPT}</script>`;
        const injection = baseTag + scriptTag;

        let modified: string;
        const headMatch = html.match(/<head[^>]*>/i);
        if (headMatch) {
          modified = html.replace(headMatch[0], headMatch[0] + injection);
        } else {
          modified = `<head>${injection}</head>` + html;
        }

        if (!cancelled) {
          setSrcdocHtml(modified);
          setIsCrossOrigin(false);
        }
      } catch {
        // Proxy fetch failed — network error or server not running.
        if (!cancelled) setIsCrossOrigin(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [url, fetchKey]);

  /* ---- Console message listener ---- */

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type !== "ezydev-console") return;
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
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  /* ---- Auto-scroll console to bottom ---- */

  useEffect(() => {
    consoleEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [consoleEntries]);

  /* ---- Auto-reload interval ---- */

  useEffect(() => {
    if (!autoReload) return;
    const id = setInterval(() => setFetchKey((k) => k + 1), 2000);
    return () => clearInterval(id);
  }, [autoReload]);

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

  /* ---- Helpers ---- */

  const fmtTime = (ts: number) => {
    const d = new Date(ts);
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map((n) => String(n).padStart(2, "0"))
      .join(":");
  };

  const methodColor = (m: ConsoleEntry["method"]) => {
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

  /* ================================================================ */
  /*  Render                                                           */
  /* ================================================================ */

  return (
    <div
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
        {/* Back */}
        <NavButton title="Back" disabled={!canGoBack} onClick={goBack}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="10,3 5,8 10,13" />
          </svg>
        </NavButton>

        {/* Forward */}
        <NavButton
          title="Forward"
          disabled={!canGoForward}
          onClick={goForward}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="6,3 11,8 6,13" />
          </svg>
        </NavButton>

        {/* Refresh */}
        <NavButton title="Refresh" onClick={refresh}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <path d="M2 8a6 6 0 1 1 1.76 4.24" />
            <polyline points="2,4 2,8 6,8" />
          </svg>
        </NavButton>

        {/* Hard Reload */}
        <NavButton
          title="Hard Reload (clear storage)"
          onClick={hardReload}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <path d="M2 8a6 6 0 1 1 1.76 4.24" />
            <polyline points="2,4 2,8 6,8" />
            <line x1="6" y1="6" x2="10" y2="10" />
            <line x1="10" y1="6" x2="6" y2="10" />
          </svg>
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
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="var(--ezy-text-muted)"
            strokeWidth="1.3"
            style={{ flexShrink: 0, marginRight: 6 }}
          >
            <circle cx="8" cy="8" r="6" />
            <path d="M2 8h12M8 2c-2 2-2 10 0 12M8 2c2 2 2 10 0 12" />
          </svg>
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

        {/* Console toggle */}
        <NavButton
          title={showConsole ? "Hide Console" : "Show Console"}
          onClick={() => setShowConsole((v) => !v)}
          active={showConsole}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="4,5 7,8 4,11" />
            <line x1="9" y1="11" x2="12" y2="11" />
          </svg>
        </NavButton>

        {/* Auto-reload toggle */}
        <NavButton
          title={autoReload ? "Stop Auto-reload" : "Auto-reload every 2s"}
          onClick={() => setAutoReload((v) => !v)}
          active={autoReload}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <path d="M2 8a6 6 0 1 1 1.76 4.24" />
            <polyline points="2,4 2,8 6,8" />
            <circle cx="11" cy="11" r="2.5" fill="none" strokeWidth="1.2" />
            <line x1="11" y1="9.5" x2="11" y2="11" strokeWidth="1.2" />
            <line x1="11" y1="11" x2="12" y2="11" strokeWidth="1.2" />
          </svg>
        </NavButton>

        {/* Close */}
        <NavButton
          title="Close Preview"
          onClick={onClose}
          hoverColor="var(--ezy-red)"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <line x1="4" y1="4" x2="12" y2="12" />
            <line x1="12" y1="4" x2="4" y2="12" />
          </svg>
        </NavButton>
      </div>

      {/* ---- Viewport Toolbar ---- */}
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

        {/* Dimension label or custom inputs */}
        {viewportMode === "custom" ? (
          <div className="flex items-center gap-1" style={{ marginLeft: 4 }}>
            <input
              type="number"
              value={customWidth}
              onChange={(e) => setCustomWidth(Number(e.target.value) || 0)}
              style={{
                width: 52,
                height: 20,
                fontSize: 11,
                backgroundColor: "var(--ezy-bg)",
                color: "var(--ezy-text)",
                border: "1px solid var(--ezy-border)",
                borderRadius: 3,
                padding: "0 4px",
                fontFamily: "inherit",
                fontVariantNumeric: "tabular-nums",
                outline: "none",
              }}
            />
            <span style={{ fontSize: 11, color: "var(--ezy-text-muted)" }}>
              x
            </span>
            <input
              type="number"
              value={customHeight}
              onChange={(e) => setCustomHeight(Number(e.target.value) || 0)}
              style={{
                width: 52,
                height: 20,
                fontSize: 11,
                backgroundColor: "var(--ezy-bg)",
                color: "var(--ezy-text)",
                border: "1px solid var(--ezy-border)",
                borderRadius: 3,
                padding: "0 4px",
                fontFamily: "inherit",
                fontVariantNumeric: "tabular-nums",
                outline: "none",
              }}
            />
          </div>
        ) : vpDims ? (
          <span
            style={{
              fontSize: 11,
              color: "var(--ezy-text-muted)",
              marginLeft: 4,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {vpDims.width} x {vpDims.height}
          </span>
        ) : null}
      </div>

      {/* ---- Iframe Container ---- */}
      <div
        className="flex-1 min-h-0 flex items-center justify-center overflow-auto"
        style={{ backgroundColor: vpDims ? "var(--ezy-bg)" : undefined }}
      >
        <div
          style={
            vpDims
              ? {
                  width: vpDims.width,
                  height: vpDims.height,
                  border: "1px solid var(--ezy-border)",
                  borderRadius: 4,
                  overflow: "hidden",
                  flexShrink: 0,
                }
              : { width: "100%", height: "100%" }
          }
        >
          <iframe
            ref={iframeRef}
            {...(srcdocHtml != null
              ? { srcDoc: srcdocHtml }
              : { src: url })}
            title="Browser Preview"
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
            className="w-full h-full border-none"
            style={{ backgroundColor: "#ffffff" }}
          />
        </div>
      </div>

      {/* ---- Console Panel ---- */}
      {showConsole && (
        <div
          className="flex flex-col"
          style={{
            height: 200,
            borderTop: "1px solid var(--ezy-border)",
            backgroundColor: "var(--ezy-surface)",
          }}
        >
          {/* Console header */}
          <div
            className="flex items-center gap-2 select-none"
            style={{
              height: 28,
              padding: "0 8px",
              borderBottom: "1px solid var(--ezy-border)",
              flexShrink: 0,
            }}
          >
            <span
              style={{
                fontSize: 11,
                color: "var(--ezy-text-secondary)",
                fontWeight: 600,
              }}
            >
              Console
            </span>
            {srcdocHtml != null && (
              <span
                style={{
                  fontSize: 10,
                  padding: "1px 6px",
                  borderRadius: 8,
                  backgroundColor: "var(--ezy-accent-dim)",
                  color: "var(--ezy-accent)",
                }}
              >
                live
              </span>
            )}
            {consoleEntries.length > 0 && (
              <span
                style={{
                  fontSize: 10,
                  padding: "1px 6px",
                  borderRadius: 8,
                  backgroundColor: "var(--ezy-surface-raised)",
                  color: "var(--ezy-text-muted)",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {consoleEntries.length}
              </span>
            )}
            <div className="flex-1" />
            {isCrossOrigin && (
              <span style={{ fontSize: 10, color: "var(--ezy-text-muted)" }}>
                Cross-origin fallback (no CORS)
              </span>
            )}
            {/* Clear */}
            <NavButton
              title="Clear console"
              onClick={() => setConsoleEntries([])}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              >
                <polyline points="3,6 3,13 13,13 13,6" />
                <line x1="1" y1="6" x2="15" y2="6" />
                <polyline points="6,6 6,3 10,3 10,6" />
                <line x1="6.5" y1="8.5" x2="6.5" y2="11" />
                <line x1="9.5" y1="8.5" x2="9.5" y2="11" />
              </svg>
            </NavButton>
            {/* Close console */}
            <NavButton
              title="Close console"
              onClick={() => setShowConsole(false)}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              >
                <line x1="4" y1="4" x2="12" y2="12" />
                <line x1="12" y1="4" x2="4" y2="12" />
              </svg>
            </NavButton>
          </div>

          {/* Console entries */}
          <div className="flex-1 overflow-auto" style={{ padding: "4px 0" }}>
            {consoleEntries.length === 0 && isCrossOrigin && (
              <div
                className="flex flex-col items-center justify-center h-full gap-2"
                style={{ padding: "16px 12px" }}
              >
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="var(--ezy-text-muted)"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  style={{ opacity: 0.5 }}
                >
                  <rect x="2" y="2" width="12" height="12" rx="2" />
                  <line x1="8" y1="6" x2="8" y2="8.5" />
                  <circle
                    cx="8"
                    cy="10.5"
                    r="0.5"
                    fill="var(--ezy-text-muted)"
                  />
                </svg>
                <span
                  style={{
                    fontSize: 12,
                    color: "var(--ezy-text-secondary)",
                    fontWeight: 500,
                  }}
                >
                  Console unavailable (cross-origin)
                </span>
                <span
                  style={{
                    fontSize: 11,
                    color: "var(--ezy-text-muted)",
                    textAlign: "center",
                    maxWidth: 320,
                    lineHeight: "16px",
                  }}
                >
                  The dev server did not return CORS headers, so the console
                  proxy could not load the page. Open browser DevTools (F12) to
                  inspect directly.
                </span>
              </div>
            )}
            {consoleEntries.length === 0 && !isCrossOrigin && (
              <div
                style={{
                  padding: "8px 12px",
                  fontSize: 11,
                  color: "var(--ezy-text-muted)",
                }}
              >
                No console output yet.
              </div>
            )}
            {consoleEntries.map((entry) => (
              <div
                key={entry.id}
                className="flex gap-2"
                style={{
                  padding: "1px 12px",
                  fontSize: 12,
                  lineHeight: "18px",
                  color: methodColor(entry.method),
                  borderBottom: "1px solid var(--ezy-border-subtle)",
                }}
              >
                <span
                  style={{
                    fontSize: 10,
                    color: "var(--ezy-text-muted)",
                    fontVariantNumeric: "tabular-nums",
                    flexShrink: 0,
                    lineHeight: "18px",
                  }}
                >
                  {fmtTime(entry.timestamp)}
                </span>
                <span
                  style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}
                >
                  {entry.text}
                </span>
              </div>
            ))}
            <div ref={consoleEndRef} />
          </div>
        </div>
      )}
    </div>
  );
}
