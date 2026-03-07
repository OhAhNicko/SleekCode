import { useRef, useEffect, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import { promptify } from "../lib/promptify";
import { useAppStore } from "../store";
import { useClipboardImageStore, type ClipboardImage } from "../store/clipboardImageStore";
import { getImageLabel } from "../lib/clipboard-insert";

interface PromptComposerProps {
  onSubmit: (text: string) => void;
  onClose: () => void;
  write: (data: string) => void;
  alwaysVisible: boolean;
  terminalBg: string;
  terminalFg: string;
  terminalCursor: string;
  fontSize: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
  terminal: Terminal | null;
  terminalId: string;
  scrollToPrompt: () => void;
  scrollToNextPrompt: () => void;
}

export default function PromptComposer({
  onSubmit,
  onClose,
  write,
  alwaysVisible,
  terminalBg,
  terminalFg,
  terminalCursor,
  fontSize,
  containerRef,
  terminal,
  terminalId,
  scrollToPrompt,
  scrollToNextPrompt,
}: PromptComposerProps) {
  const promptHistory = useAppStore((s) => s.promptHistory);
  const addPromptHistory = useAppStore((s) => s.addPromptHistory);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("");
  // Start offscreen (-9999) until first valid prompt is found; avoids flash at top
  const [topOffset, setTopOffset] = useState<number>(-9999);
  const didStealText = useRef(false);
  // History navigation: -1 = composing new text, 0 = most recent, 1 = second most recent, etc.
  const [historyIdx, setHistoryIdx] = useState(-1);
  const draftRef = useRef(""); // saves in-progress text when navigating history
  const [promptifying, setPromptifying] = useState(false);
  const [ghostText, setGhostText] = useState("");
  const imgCycleRef = useRef<{ num: number } | null>(null); // tracks current [Img N] for Tab cycling
  const [localImages, setLocalImages] = useState<ClipboardImage[]>([]);
  const pendingImage = useClipboardImageStore((s) => s.pendingComposerImage);

  // Scan viewport for the prompt line and return its pixel offset (or null).
  // Extracted as a plain function so it can be called from both the initial
  // effect and the continuous onRender listener.
  function scanPromptPosition(): { offset: number; existing: string } | null {
    const container = containerRef.current;
    if (!container || !terminal) return null;
    const screen = container.querySelector(".xterm-screen") as HTMLElement | null;
    if (!screen) return null;

    const cellHeight = screen.clientHeight / terminal.rows;
    const buf = terminal.buffer.active;
    const parentEl = container.parentElement;
    const screenTopPx = parentEl
      ? screen.getBoundingClientRect().top - parentEl.getBoundingClientRect().top
      : 0;

    const vpStart = buf.viewportY;
    const vpEnd = vpStart + terminal.rows - 1;

    // Pass 1: prompt-like characters (>, ❯, ›, »)
    for (let i = vpEnd; i >= vpStart; i--) {
      const line = buf.getLine(i);
      if (!line) continue;
      const text = line.translateToString().trim();
      const m = text.match(/^([>❯›»])\s?(.*)/);
      if (m) {
        const row = i - vpStart;
        return { offset: Math.round(screenTopPx + row * cellHeight), existing: (m[2] ?? "").trimEnd() };
      }
    }

    // Pass 2: shell prompts ending with $ or >
    for (let i = vpEnd; i >= vpStart; i--) {
      const line = buf.getLine(i);
      if (!line) continue;
      const text = line.translateToString().trim();
      if (/[>$❯]\s*$/.test(text) && text.length < 80) {
        const row = i - vpStart;
        return { offset: Math.round(screenTopPx + row * cellHeight), existing: "" };
      }
    }

    // Last resort: last non-empty line
    for (let i = vpEnd; i >= vpStart; i--) {
      const line = buf.getLine(i);
      if (!line) continue;
      if (line.translateToString().trim().length > 0) {
        const row = i - vpStart;
        return { offset: Math.round(screenTopPx + row * cellHeight), existing: "" };
      }
    }
    return null;
  }

  // Initial scan + steal text on mount.
  // Also poll quickly until the prompt is found (Claude CLI takes a few seconds to start).
  const foundPromptRef = useRef(false);
  useEffect(() => {
    function tryFind() {
      const result = scanPromptPosition();
      if (result) {
        foundPromptRef.current = true;
        setTopOffset(result.offset);
        if (result.existing && !didStealText.current) {
          didStealText.current = true;
          setValue(result.existing);
          write("\x7f".repeat(result.existing.length));
        }
        return true;
      }
      return false;
    }
    if (tryFind()) return;
    // Poll every 200ms until prompt appears (stops after 15s max)
    const start = Date.now();
    const timer = setInterval(() => {
      if (tryFind() || Date.now() - start > 15000) clearInterval(timer);
    }, 200);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Continuously reposition when terminal renders (prompt may move after commands).
  // When position changes (new prompt appeared), auto-focus the textarea.
  const lastOffsetRef = useRef(0);
  useEffect(() => {
    if (!terminal) return;
    const disposable = terminal.onRender(() => {
      const result = scanPromptPosition();
      if (!result) return;
      setTopOffset(result.offset);
      // Position changed → new prompt appeared (e.g. after Claude finished or ESC cancel)
      if (result.offset !== lastOffsetRef.current) {
        lastOffsetRef.current = result.offset;
        if (alwaysVisible) {
          setTimeout(() => textareaRef.current?.focus(), 30);
        }
      }
    });
    return () => disposable.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal, alwaysVisible]);

  // Pick up pending images targeted at this pane
  useEffect(() => {
    if (!pendingImage || pendingImage.terminalId !== terminalId) return;
    const img = pendingImage.image;
    setLocalImages((prev) => {
      if (prev.some((i) => i.id === img.id)) return prev;
      return [...prev, img];
    });
    useClipboardImageStore.getState().setPendingComposerImage(null);
  }, [pendingImage, terminalId]);

  // Auto-focus on mount + register as active composer
  useEffect(() => {
    useClipboardImageStore.getState().setActiveComposerTerminalId(terminalId);
    const timer = setTimeout(() => textareaRef.current?.focus(), 30);
    return () => clearTimeout(timer);
  }, [terminalId]);

  // Auto-resize textarea height
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [value]);

  function submit() {
    const ta = textareaRef.current;
    if (!ta) return;
    let text = ta.value.trim();
    if (!text) return;
    // Append image labels for attached images (skip if already in text via autocomplete)
    if (localImages.length > 0) {
      const missing = localImages
        .map((img) => getImageLabel(img.winPath))
        .filter((label) => !text.includes(label));
      if (missing.length > 0) {
        text = text + " " + missing.join(" ");
      }
    }
    addPromptHistory(text);
    onSubmit(text);
    setLocalImages([]);
    setValue("");
    setHistoryIdx(-1);
    draftRef.current = "";
    if (alwaysVisible) {
      setTimeout(() => textareaRef.current?.focus(), 30);
    } else {
      onClose();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    // Scroll-to-prompt: PgUp/PgDn jump between prompts (same behavior as terminal)
    if (!e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      if (e.key === "PageUp") {
        e.preventDefault();
        scrollToPrompt();
        return;
      }
      if (e.key === "PageDown") {
        e.preventDefault();
        scrollToNextPrompt();
        return;
      }
    }
    // Ctrl+I — toggle composer off (even in always-visible mode)
    if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && (e.key === "i" || e.key === "I")) {
      e.preventDefault();
      onClose();
      return;
    }
    // Ctrl+V — attach image if clipboard has one, otherwise default paste
    if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "v" || e.key === "V")) {
      const store = useClipboardImageStore.getState();
      // Only attach image if the most recent clipboard content is an image
      if (store.images.length > 0 && store.lastSeq === store.lastImageSeq) {
        e.preventDefault();
        const img = store.images[0];
        setLocalImages((prev) => {
          if (prev.some((i) => i.id === img.id)) return prev;
          return [...prev, img];
        });
        return;
      }
      // Otherwise let default paste happen
      return;
    }
    // ESC — forward to terminal (cancel Claude operation)
    if (e.key === "Escape") {
      e.preventDefault();
      write("\x1b");
      return;
    }
    // Up arrow — navigate to previous prompt in history (only when cursor is on first line)
    if (e.key === "ArrowUp" && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      const ta = textareaRef.current;
      const cursorOnFirstLine = !ta || !ta.value.substring(0, ta.selectionStart).includes("\n");
      if (!cursorOnFirstLine) return; // let textarea handle cursor movement
      if (promptHistory.length === 0) return;
      e.preventDefault();
      const newIdx = historyIdx + 1;
      if (newIdx >= promptHistory.length) return; // already at oldest
      if (historyIdx === -1) draftRef.current = value; // save current draft
      setHistoryIdx(newIdx);
      setValue(promptHistory[newIdx]);
      return;
    }
    // Down arrow — navigate to next (newer) prompt or back to draft (only when cursor is on last line)
    if (e.key === "ArrowDown" && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      const ta = textareaRef.current;
      const cursorOnLastLine = !ta || !ta.value.substring(ta.selectionEnd).includes("\n");
      if (!cursorOnLastLine) return; // let textarea handle cursor movement
      if (historyIdx < 0) return; // already at draft
      e.preventDefault();
      const newIdx = historyIdx - 1;
      if (newIdx < 0) {
        setHistoryIdx(-1);
        setValue(draftRef.current);
      } else {
        setHistoryIdx(newIdx);
        setValue(promptHistory[newIdx]);
      }
      return;
    }
    // Tab — autocomplete [Img N] from "im"/"img" trigger, or cycle (replace) to next image
    if (e.key === "Tab" && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      const ta = textareaRef.current;
      if (!ta) return;
      const text = ta.value;
      const clipStore = useClipboardImageStore.getState();
      const imageCount = Math.min(clipStore.images.length, 3);
      if (imageCount === 0) return; // no images — let default Tab happen

      // Cycling — replace current [Img N] with [Img next]
      if (imgCycleRef.current) {
        const prevLabel = `[Img ${imgCycleRef.current.num}]`;
        const nextNum = (imgCycleRef.current.num % imageCount) + 1;
        const nextLabel = `[Img ${nextNum}]`;
        if (text.endsWith(prevLabel)) {
          e.preventDefault();
          const newText = text.slice(0, -prevLabel.length) + nextLabel;
          imgCycleRef.current = { num: nextNum };
          setValue(newText);
          setGhostText("");
          // Swap composer thumbnail: remove old, add new
          const oldNum = nextNum === 1 ? imageCount : nextNum - 1;
          const oldImg = clipStore.images[oldNum - 1];
          const newImg = clipStore.images[nextNum - 1];
          setLocalImages((prev) => {
            let updated = oldImg ? prev.filter((i) => i.id !== oldImg.id) : prev;
            if (newImg && !updated.some((i) => i.id === newImg.id)) {
              updated = [...updated, newImg];
            }
            return updated;
          });
          return;
        }
      }

      // First TAB — "im" or "img" trigger → erase trigger, insert [Img 1]
      const triggerLen = text.endsWith("img") ? 3 : text.endsWith("im") ? 2 : 0;
      if (triggerLen > 0) {
        e.preventDefault();
        const label = "[Img 1]";
        const newText = text.slice(0, -triggerLen) + label;
        imgCycleRef.current = { num: 1 };
        setValue(newText);
        setGhostText("");
        const img = clipStore.images[0];
        if (img) {
          setLocalImages((prev) => {
            if (prev.some((i) => i.id === img.id)) return prev;
            return [...prev, img];
          });
        }
        return;
      }

      // No match — let default Tab behavior happen
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
  }

  // Compute ghost text for "im"/"img" autocomplete
  // Returns the next available image number (skips already-referenced images)
  function nextAvailableImageNum(text: string): number | null {
    const images = useClipboardImageStore.getState().images;
    if (images.length === 0) return null;
    for (let i = 0; i < images.length; i++) {
      const label = `[Img ${i + 1}]`;
      if (!text.includes(label)) return i + 1;
    }
    return null;
  }

  function updateGhost(text: string) {
    const num = nextAvailableImageNum(text);
    if (num === null) { setGhostText(""); return; }
    if (text.endsWith("img")) {
      setGhostText(` ${num}]`);
    } else if (text.endsWith("im")) {
      setGhostText(`g ${num}]`);
    } else {
      setGhostText("");
    }
  }

  return (
    <div
      style={{
        position: "absolute",
        top: topOffset,
        left: 0,
        right: 14,
        zIndex: 20,
        backgroundColor: terminalBg,
        padding: "0 10px 2px 10px",
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <span
        style={{
          color: terminalCursor,
          fontFamily: "Hack, monospace",
          fontSize,
          lineHeight: 1.4,
          letterSpacing: 1,
          flexShrink: 0,
          opacity: 0.7,
          userSelect: "none",
        }}
      >
        &gt;
      </span>
      <div style={{ flex: 1, position: "relative", minWidth: 0 }}>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => { setValue(e.target.value); setHistoryIdx(-1); imgCycleRef.current = null; updateGhost(e.target.value); }}
          onKeyDown={handleKeyDown}
          onFocus={() => useClipboardImageStore.getState().setActiveComposerTerminalId(terminalId)}
          onWheel={(e) => e.stopPropagation()}
          rows={1}
          placeholder="Type your prompt..."
          spellCheck={false}
          style={{
            width: "100%",
            backgroundColor: "transparent",
            color: terminalFg,
            fontFamily: "Hack, monospace",
            fontSize,
            lineHeight: 1.4,
            letterSpacing: 1,
            border: "none",
            outline: "none",
            resize: "none",
            padding: 0,
            margin: 0,
            overflowY: "auto",
            overflowX: "hidden",
            caretColor: terminalCursor,
            animation: promptifying ? "promptify-pulse 1.5s ease-in-out infinite" : "none",
          }}
        />
        {/* Ghost text overlay — shows autocomplete suggestion */}
        {ghostText && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              pointerEvents: "none",
              fontFamily: "Hack, monospace",
              fontSize,
              lineHeight: 1.4,
              letterSpacing: 1,
              padding: 0,
              margin: 0,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              color: "transparent",
            }}
          >
            {/* Invisible real text to push ghost to the right position */}
            <span>{value}</span>
            <span style={{ color: terminalFg, opacity: 0.35 }}>{ghostText}</span>
          </div>
        )}
      </div>
      {promptifying && (
        <style>{`@keyframes promptify-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }`}</style>
      )}
      {/* Attached image thumbnails — click to remove */}
      {localImages.map((img) => {
        const label = getImageLabel(img.winPath);
        return (
          <div
            key={img.id}
            onClick={() => setLocalImages((prev) => prev.filter((i) => i.id !== img.id))}
            style={{
              position: "relative",
              width: 28,
              height: 28,
              borderRadius: 3,
              overflow: "hidden",
              cursor: "pointer",
              border: `1.5px solid ${terminalCursor}`,
              flexShrink: 0,
            }}
            title={`${label} attached — click to remove`}
          >
            <img
              src={img.dataUri}
              alt={label}
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            />
            <span
              style={{
                position: "absolute",
                bottom: 0,
                left: 0,
                right: 0,
                fontSize: 7,
                lineHeight: "10px",
                textAlign: "center",
                color: "#fff",
                backgroundColor: "rgba(0,0,0,0.6)",
                fontFamily: "Hack, monospace",
              }}
            >
              {label}
            </span>
          </div>
        );
      })}
      {/* Promptifier button */}
      <div
        onClick={() => {
          const text = textareaRef.current?.value.trim();
          if (!text || promptifying) return;
          setPromptifying(true);
          promptify(text)
            .then((rewritten) => {
              setValue(rewritten);
              setHistoryIdx(-1);
              setTimeout(() => textareaRef.current?.focus(), 30);
            })
            .catch((err) => {
              console.error("[Promptifier]", err);
            })
            .finally(() => setPromptifying(false));
        }}
        style={{
          flexShrink: 0,
          marginTop: 1,
          cursor: value.trim() && !promptifying ? "pointer" : "default",
          opacity: promptifying ? 1 : value.trim() ? 0.6 : 0.2,
          transition: "opacity 120ms ease",
        }}
        onMouseEnter={(e) => {
          if (value.trim() && !promptifying) e.currentTarget.style.opacity = "1";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.opacity = promptifying ? "1" : value.trim() ? "0.6" : "0.2";
        }}
        title="Promptify — rewrite as detailed prompt"
      >
        {promptifying ? (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ animation: "spin 1s linear infinite" }}>
            <circle cx="8" cy="8" r="6" stroke={terminalCursor} strokeWidth="1.5" strokeDasharray="28 10" strokeLinecap="round" />
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke={terminalCursor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 14l7-7" />
            <path d="M9 7l1.5-1.5 1 1L10 8z" fill={terminalCursor} stroke="none" />
            <path d="M12.5 1.5l2 2-1.5 1.5-2-2z" />
            <path d="M5 2v2M4 3h2" />
            <path d="M12 10v2M11 11h2" />
          </svg>
        )}
      </div>
      {/* Send button */}
      <div
        onClick={submit}
        style={{
          flexShrink: 0,
          marginTop: 2,
          cursor: value.trim() ? "pointer" : "default",
          opacity: value.trim() ? 0.8 : 0.25,
          transition: "opacity 120ms ease",
        }}
        onMouseEnter={(e) => {
          if (value.trim()) e.currentTarget.style.opacity = "1";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.opacity = value.trim() ? "0.8" : "0.25";
        }}
        title="Send (Enter)"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke={terminalCursor}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2 8h10M8 4l4 4-4 4" />
        </svg>
      </div>
    </div>
  );
}
