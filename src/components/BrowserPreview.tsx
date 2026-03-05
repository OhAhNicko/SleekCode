import { useState, useRef, useCallback } from "react";

interface BrowserPreviewProps {
  initialUrl: string;
  onClose: () => void;
}

export default function BrowserPreview({
  initialUrl,
  onClose,
}: BrowserPreviewProps) {
  const [url, setUrl] = useState(initialUrl);
  const [inputUrl, setInputUrl] = useState(initialUrl);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const navigate = useCallback(() => {
    let target = inputUrl.trim();
    if (!target.startsWith("http://") && !target.startsWith("https://")) {
      target = `http://${target}`;
    }
    setUrl(target);
    setInputUrl(target);
  }, [inputUrl]);

  const refresh = useCallback(() => {
    if (iframeRef.current) {
      iframeRef.current.src = url;
    }
  }, [url]);

  return (
    <div
      className="flex flex-col h-full w-full"
      style={{ backgroundColor: "var(--ezy-bg)" }}
    >
      {/* URL bar */}
      <div
        className="flex items-center gap-2 select-none"
        style={{
          height: 36,
          backgroundColor: "var(--ezy-surface)",
          borderBottom: "1px solid var(--ezy-border)",
          padding: "0 8px",
        }}
      >
        {/* Navigation buttons */}
        <button
          onClick={refresh}
          title="Refresh"
          className="p-1 rounded transition-colors"
          style={{ backgroundColor: "transparent" }}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-border)"}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="var(--ezy-text-muted)"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <path d="M2 8a6 6 0 1 1 1.76 4.24" />
            <polyline points="2,4 2,8 6,8" />
          </svg>
        </button>

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
            onKeyDown={(e) => e.key === "Enter" && navigate()}
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

        {/* Close button */}
        <button
          onClick={onClose}
          title="Close Preview"
          className="p-1 rounded transition-colors group"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="var(--ezy-text-muted)"
            strokeWidth="1.5"
            strokeLinecap="round"
            className="group-hover:stroke-[var(--ezy-red)]"
          >
            <line x1="4" y1="4" x2="12" y2="12" />
            <line x1="12" y1="4" x2="4" y2="12" />
          </svg>
        </button>
      </div>

      {/* iframe */}
      <div className="flex-1 min-h-0">
        <iframe
          ref={iframeRef}
          src={url}
          title="Browser Preview"
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
          className="w-full h-full border-none"
          style={{ backgroundColor: "#ffffff" }}
        />
      </div>
    </div>
  );
}
