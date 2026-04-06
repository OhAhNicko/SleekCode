import { useRef, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Terminal } from "@xterm/xterm";
import { promptify } from "../lib/promptify";
import { useAppStore } from "../store";
import { useClipboardImageStore, type ClipboardImage } from "../store/clipboardImageStore";
import { useBrowserConsoleStore } from "../store/browserConsoleStore";
import { getImageLabel, resolveImagePath } from "../lib/clipboard-insert";
import { toWslPath } from "../lib/terminal-config";
import { SLASH_COMMANDS, SLASH_ARG_HINTS, loadUserSkills, type SlashCommand } from "../lib/slash-commands";
import type { TerminalType } from "../types";
import { HiMiniArrowLongRight, HiMiniArrowLongLeft } from "react-icons/hi2";
import { FaWandMagicSparkles, FaCopy, FaDeleteLeft } from "react-icons/fa6";
import { useUndoClearStore } from "../store/undoClearStore";
import { BiSolidSend } from "react-icons/bi";
import { AiFillCode } from "react-icons/ai";
import { FaAngleRight, FaExpand, FaBug } from "react-icons/fa";
import ImagePreviewModal from "./ImagePreviewModal";

const PLACEHOLDER_SUGGESTIONS = [
  "Fix the bug in...",
  "Refactor this to be more readable",
  "Add error handling for edge cases",
  "Write tests for the recent changes",
  "Explain how this module works",
  "Find and fix potential issues in...",
  "Add input validation to...",
  "Review this file for security issues",
  "Simplify the logic in...",
  "Add types to the untyped functions",
  "Optimize the slow query in...",
  "Create a reusable hook for...",
  "Add retry logic for failed requests",
  "Find unused code and clean up",
  "Add logging for debugging...",
  "Write a helper function for...",
  "Add keyboard shortcuts for...",
  "Implement loading and error states",
  "Move this into a shared utility",
  "Add caching to reduce API calls",
];

/** Stable empty array to avoid selector re-renders when pane has no history. */
const EMPTY_HISTORY: string[] = [];

function randomPlaceholder(): string {
  return PLACEHOLDER_SUGGESTIONS[Math.floor(Math.random() * PLACEHOLDER_SUGGESTIONS.length)];
}

/** Lighten a hex color by a fixed amount (0-255 per channel). */
function lightenHex(hex: string, amount: number): string {
  const h = hex.replace("#", "");
  const r = Math.min(255, parseInt(h.substring(0, 2), 16) + amount);
  const g = Math.min(255, parseInt(h.substring(2, 4), 16) + amount);
  const b = Math.min(255, parseInt(h.substring(4, 6), 16) + amount);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

/** Convert hex to rgba. */
function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

const ARROW_ICON_STYLE: React.CSSProperties = { display: "inline-block", verticalAlign: "middle", transform: "scale(1.5)", position: "relative", top: -1 };

/**
 * Replace "->" and "<-" with visual arrow ligatures + invisible filler char
 * to maintain 2-char width alignment with the textarea underneath.
 */
function renderWithArrows(text: string): React.ReactNode {
  if (!text.includes("->") && !text.includes("<-")) return text;
  // Split on -> and <- while keeping the delimiter
  const parts = text.split(/(<-|->)/);
  const nodes: React.ReactNode[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === "->") {
      nodes.push(<span key={`→${i}`}><HiMiniArrowLongRight style={ARROW_ICON_STYLE} /><span style={{ color: "transparent" }}>-</span></span>);
    } else if (p === "<-") {
      nodes.push(<span key={`←${i}`}><HiMiniArrowLongLeft style={ARROW_ICON_STYLE} /><span style={{ color: "transparent" }}>-</span></span>);
    } else if (p) {
      nodes.push(p);
    }
  }
  return <>{nodes}</>;
}

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
  terminalType: TerminalType;
  workingDir: string;
  scrollToPrompt: () => void;
  scrollToNextPrompt: () => void;
  isActive: boolean;
  didStealRef: React.MutableRefObject<boolean>;
  /** When true, skip auto-focus on mount (pane opened in background). */
  suppressAutoFocus?: boolean;
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
  terminalType,
  workingDir,
  scrollToPrompt,
  scrollToNextPrompt,
  isActive,
  didStealRef,
  suppressAutoFocus = false,
}: PromptComposerProps) {
  // Track the terminal's actual font size (may differ from the store value when
  // TerminalPane's doFit() scales font down for narrow panes). Updated by
  // resize observers so the composer re-renders when the terminal font changes.
  const [effectiveFontSize, setEffectiveFontSize] = useState(terminal?.options.fontSize ?? fontSize);
  const panePromptHistory = useAppStore((s) => s.panePromptHistory);
  const promptHistory = panePromptHistory[terminalId] ?? EMPTY_HISTORY;
  const addPromptHistory = useAppStore((s) => s.addPromptHistory);
  const composerExpansion = useAppStore((s) => s.composerExpansion);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const [value, setValue] = useState("");
  // Start offscreen (-9999) until first valid prompt is found; avoids flash at top
  const [topOffset, setTopOffset] = useState<number>(-9999);
  const [cellHeight, setCellHeight] = useState(0);
  const [hidden, setHidden] = useState(false);
  const hiddenRef = useRef(false);
  const resizingUntilRef = useRef(0); // timestamp until which auto-hide is suppressed (resize transition)
  const notAtBottomSinceRef = useRef(0); // hysteresis: timestamp when isAtBottom first failed
  const showTimeRef = useRef(0); // timestamp when composer last became visible
  const didStealText = didStealRef;
  // History navigation: -1 = composing new text, 0 = most recent, 1 = second most recent, etc.
  const [historyIdx, setHistoryIdx] = useState(-1);
  const draftRef = useRef(""); // saves in-progress text when navigating history
  const [promptifying, setPromptifying] = useState(false);
  const [placeholder, setPlaceholder] = useState(randomPlaceholder);
  const [ghostText, setGhostText] = useState("");
  const [cliSuggestion, setCliSuggestion] = useState("");
  const [slashMatches, setSlashMatches] = useState<SlashCommand[]>([]);
  const [slashSelectedIdx, setSlashSelectedIdx] = useState(0);
  const [slashScrollOffset, setSlashScrollOffset] = useState(0);
  const SLASH_VISIBLE = 8;
  const [userSkills, setUserSkills] = useState<SlashCommand[]>([]);
  const slashGhostEnabled = useAppStore((s) => s.slashCommandGhostText);
  const promptLineIdxRef = useRef(-1); // last known prompt line for re-scanning
  const submittedLineIdxRef = useRef(-1); // line to skip after submit (old echoed >)
  const valueRef = useRef(value);
  valueRef.current = value;
  const imgCycleRef = useRef<{ num: number } | null>(null); // tracks current [Img N] for Tab cycling
  const slashTokenRef = useRef<{ start: number; end: number } | null>(null); // position of current slash token in value
  const [localImages, setLocalImages] = useState<ClipboardImage[]>([]);
  const [previewImage, setPreviewImage] = useState<{ dataUri: string; winPath: string } | null>(null);
  const [imgCtxMenu, setImgCtxMenu] = useState<{ x: number; y: number; imgId: string } | null>(null);
  const [consoleSnippet, setConsoleSnippet] = useState<{ tag: string; formatted: string } | null>(null);
  const consoleTagRef = useRef<string | null>(null); // current tag text in textarea
  const browserPreviewOpen = useBrowserConsoleStore((s) => s.active);
  const consoleEntryCount = useBrowserConsoleStore((s) => s.entries.length);
  const consoleSelectMode = useBrowserConsoleStore((s) => s.selectMode);
  const consoleSelectedIds = useBrowserConsoleStore((s) => s.selectedIds);
  const autoDebug = useBrowserConsoleStore((s) => s.autoDebug);
  const consoleErrorCount = useBrowserConsoleStore((s) =>
    s.entries.reduce((n, e) => n + (e.method === "error" ? 1 : 0), 0),
  );
  const pendingImage = useClipboardImageStore((s) => s.pendingComposerImage);

  // Listen for file-drop events dispatched by the global useFileDrop hook
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const handler = (e: Event) => {
      const paths = (e as CustomEvent<{ paths: string[] }>).detail.paths;
      if (!paths.length) return;
      const insertion = paths.join(" ");
      setValue((prev) => (prev ? prev + " " + insertion : insertion));
    };
    el.addEventListener("ezydev:file-drop", handler);
    return () => el.removeEventListener("ezydev:file-drop", handler);
  }, []);

  // Listen for global prompt insert (from Ctrl+R search modal)
  useEffect(() => {
    const handler = (e: Event) => {
      if (!isActiveRef.current) return;
      const text = (e as CustomEvent<string>).detail;
      if (text) {
        setValue(text);
        setHistoryIdx(-1);
        draftRef.current = "";
        setTimeout(() => textareaRef.current?.focus(), 30);
      }
    };
    window.addEventListener("ezydev:insert-prompt", handler);
    return () => window.removeEventListener("ezydev:insert-prompt", handler);
  }, []);

  // Listen for undo-clear-composer events (from UndoClearToast Ctrl+Z / Undo button)
  useEffect(() => {
    const handler = (e: Event) => {
      if (!isActiveRef.current) return;
      const text = (e as CustomEvent<string>).detail;
      if (text) {
        setValue(text);
        setHistoryIdx(-1);
        draftRef.current = "";
        setTimeout(() => textareaRef.current?.focus(), 30);
      }
    };
    window.addEventListener("ezydev:undo-clear-composer", handler);
    return () => window.removeEventListener("ezydev:undo-clear-composer", handler);
  }, []);

  // Detect dim/ghost cell: SGR dim, palette grays, or RGB grays.
  function isCellDim(cell: { isDim(): number; isFgPalette(): boolean; isFgRGB(): boolean; getFgColor(): number }): boolean {
    if (cell.isDim()) return true;
    if (cell.isFgPalette()) {
      const c = cell.getFgColor();
      // Palette 8 = bright black; 232-250 = xterm-256 dark grays
      return c === 8 || (c >= 232 && c <= 250);
    }
    if (cell.isFgRGB()) {
      const rgb = cell.getFgColor();
      const r = (rgb >> 16) & 0xFF;
      const g = (rgb >> 8) & 0xFF;
      const b = rgb & 0xFF;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      // Gray-ish and dim (all channels close, below brightness threshold)
      return max < 180 && (max - min) < 40;
    }
    return false;
  }

  // Detect interactive CLI mode (question dialogs, plan acceptance, tool permissions).
  // Only checks lines BELOW the prompt line — old hints scrolled above don't count.
  // Each CLI has its own hint strings — adjust these when testing each CLI's interactive UI.
  const interactiveHints: Record<string, string[]> = {
    claude: ["enter to select", "arrow keys", "esc to cancel"],
    codex: ["enter to select", "arrow keys", "esc to cancel"],   // TODO: verify with actual Codex interactive UI
    gemini: ["enter to select", "arrow keys", "esc to cancel"],  // TODO: verify with actual Gemini interactive UI
  };

  function isInteractiveMode(promptLineIdx: number): boolean {
    if (!terminal) return false;
    const hints = interactiveHints[terminalType] ?? interactiveHints.claude;
    const buf = terminal.buffer.active;
    // Only check a few lines near the prompt — interactive dialogs show hints
    // right next to the prompt, not in distant status bars. Scanning the whole
    // viewport caused false positives (e.g. Gemini's status bar contains
    // "esc" which matched "esc to cancel", hiding the composer permanently).
    const checkEnd = Math.min(promptLineIdx + 4, buf.viewportY + terminal.rows - 1);
    for (let i = promptLineIdx; i <= checkEnd; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const text = line.translateToString().toLowerCase();
      if (hints.some((h) => text.includes(h))) {
        return true;
      }
    }
    return false;
  }

  // Scan viewport for the prompt line and return its pixel offset (or null).
  // Extracted as a plain function so it can be called from both the initial
  // effect and the continuous onRender listener.
  function scanPromptPosition(): { offset: number; existing: string; cellHeight: number; promptLineIdx: number; promptPass: 1 | 2 | 3 } | null {
    const container = containerRef.current;
    if (!container || !terminal) return null;
    const screen = container.querySelector(".xterm-screen") as HTMLElement | null;
    if (!screen) return null;

    // Get accurate cell height. The xterm canvas is sized to exactly
    // rows * cellHeight (no unused space), unlike screen.clientHeight which
    // may include unused pixels at the bottom that cause drift.
    const canvas = screen.querySelector("canvas") as HTMLCanvasElement | null;
    const core = (terminal as any)._core;
    const rendererCellH: number | undefined = core?._renderService?.dimensions?.css?.cell?.height;
    const canvasH = canvas?.style.height ? parseFloat(canvas.style.height) : 0;
    const cellHeight = rendererCellH
      ?? (canvasH > 0 ? canvasH / terminal.rows : screen.clientHeight / terminal.rows);
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
        // Skip indented prompt chars (selection markers in interactive UI)
        const rawText = line.translateToString(false);
        const promptCol = rawText.search(/[>❯›»]/);
        if (promptCol > 1) continue;
        // Skip numbered selection items (e.g., "> 3. Option text")
        const after = (m[2] ?? "").trim();
        if (/^\d+[.)]/.test(after)) continue;
        // Skip if > is far from the bottom of viewport content — it's an old prompt,
        // not the current input prompt (which is always near the bottom)
        let lastContentLine = i;
        for (let j = vpEnd; j > i; j--) {
          const b = buf.getLine(j);
          if (b && b.translateToString().trim().length > 0) { lastContentLine = j; break; }
        }
        if (lastContentLine - i > 6) continue;

        const row = i - vpStart;
        // Build existing from non-dim cells only (excludes CLI ghost suggestions)
        let existing = "";
        let contentCol = 0;
        for (let c = 0; c < terminal.cols; c++) {
          const cell = line.getCell(c);
          if (!cell) break;
          const ch = cell.getChars();
          if (ch && /[>❯›»]/.test(ch)) {
            contentCol = c + 1;
            const next = line.getCell(c + 1);
            if (next && next.getChars() === " ") contentCol = c + 2;
            break;
          }
        }
        for (let c = contentCol; c < terminal.cols; c++) {
          const cell = line.getCell(c);
          if (!cell) break;
          const ch = cell.getChars();
          if (!ch) continue;
          if (isCellDim(cell)) break;
          existing += ch;
        }
        return { offset: Math.round(screenTopPx + row * cellHeight), existing: existing.trimEnd(), cellHeight, promptLineIdx: i, promptPass: 1 };
      }
    }

    // Pass 2: shell prompts ending with $ or >
    for (let i = vpEnd; i >= vpStart; i--) {
      const line = buf.getLine(i);
      if (!line) continue;
      const text = line.translateToString().trim();
      if (/[>$❯]\s*$/.test(text) && text.length < 80) {
        const row = i - vpStart;
        return { offset: Math.round(screenTopPx + row * cellHeight), existing: "", cellHeight, promptLineIdx: i, promptPass: 2 };
      }
    }

    // Last resort: last non-empty line
    for (let i = vpEnd; i >= vpStart; i--) {
      const line = buf.getLine(i);
      if (!line) continue;
      if (line.translateToString().trim().length > 0) {
        const row = i - vpStart;
        return { offset: Math.round(screenTopPx + row * cellHeight), existing: "", cellHeight, promptLineIdx: i, promptPass: 3 };
      }
    }
    return null;
  }

  // Scan the prompt line for CLI autocomplete suggestion (dimmed/gray ghost text).
  function scanCliSuggestion(promptLineIdx: number): string {
    if (!terminal) return "";
    const buf = terminal.buffer.active;
    const line = buf.getLine(promptLineIdx);
    if (!line) return "";

    // Find content start (after prompt char + optional space)
    let contentStart = 0;
    for (let col = 0; col < terminal.cols; col++) {
      const cell = line.getCell(col);
      if (!cell) break;
      const ch = cell.getChars();
      if (ch && /[>❯›»]/.test(ch)) {
        contentStart = col + 1;
        const next = line.getCell(col + 1);
        if (next && next.getChars() === " ") contentStart = col + 2;
        break;
      }
    }

    // Scan cells: skip non-dim (user text), collect dim/gray (suggestion)
    let suggestion = "";
    let seenDim = false;
    for (let col = contentStart; col < terminal.cols; col++) {
      const cell = line.getCell(col);
      if (!cell) break;
      const ch = cell.getChars();
      if (!ch && !seenDim) continue;
      if (!ch && seenDim) break;

      if (isCellDim(cell)) {
        seenDim = true;
        suggestion += ch;
      } else if (seenDim) {
        break;
      }
    }

    const trimmed = suggestion.trimEnd();
    // Gemini's internal placeholder — ignore it, we show our own placeholder suggestions
    if (terminalType === "gemini" && trimmed.startsWith("Type your message")) return "";
    return trimmed;
  }

  // Initial scan + steal text on mount.
  // Also poll quickly until the prompt is found (Claude CLI takes a few seconds to start).
  const foundPromptRef = useRef(false);
  const seenPass1Ref = useRef(false); // tracks if we've ever found a Pass 1 prompt (real "> " prompt)
  useEffect(() => {
    function tryFind() {
      const result = scanPromptPosition();
      if (result) {
        foundPromptRef.current = true;
        setTopOffset(result.offset);
        setCellHeight(result.cellHeight);
        promptLineIdxRef.current = result.promptLineIdx;
        // Show the composer (background pane onRender may have hidden it
        // before the poll found the prompt)
        if (hiddenRef.current) {
          hiddenRef.current = false;
          setHidden(false);
        }
        if (result.existing && !didStealText.current) {
          didStealText.current = true;
          setValue(result.existing);
          write("\x7f".repeat(result.existing.length));
        }
        return true;
      }
      return false;
    }
    // Poll every 200ms until the prompt position stabilizes.
    // Don't stop immediately on first hit — the CLI's TUI may still be loading and the
    // initial position (e.g. from startup noise) can be wrong. Keep polling for 1s after
    // first success so the position corrects once the real prompt settles.
    const start = Date.now();
    let firstHitAt = 0;
    const timer = setInterval(() => {
      const found = tryFind();
      const now = Date.now();
      if (found && firstHitAt === 0) firstHitAt = now;
      const timedOut = now - start > 15000;
      const stabilized = firstHitAt > 0 && now - firstHitAt >= 1000;
      if (timedOut || stabilized) clearInterval(timer);
    }, 200);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal]);

  // Continuously reposition when terminal renders (prompt may move after commands).
  // When position changes (new prompt appeared), auto-focus the textarea.
  const lastOffsetRef = useRef(0);
  useEffect(() => {
    if (!terminal) return;
    const disposable = terminal.onRender(() => {
      const buf = terminal.buffer.active;
      const vpStart = buf.viewportY;
      const vpEnd = vpStart + terminal.rows - 1;
      const isAtBottom = vpStart + terminal.rows >= buf.length;

      // Known prompt line — check if it's within the visible viewport
      const promptIdx = promptLineIdxRef.current;
      const isPromptVisible = promptIdx >= 0 && promptIdx >= vpStart && promptIdx <= vpEnd;

      // Helper: compute pixel offset + cellHeight for a known buffer line index
      // without re-scanning (avoids matching old > chars when scrolled)
      function offsetForLine(lineIdx: number): { offset: number; cellHeight: number } | null {
        const container = containerRef.current;
        if (!container) return null;
        const scr = container.querySelector(".xterm-screen") as HTMLElement | null;
        if (!scr) return null;
        const parentEl = container.parentElement;
        const sTop = parentEl
          ? scr.getBoundingClientRect().top - parentEl.getBoundingClientRect().top
          : 0;
        const canvas = scr.querySelector("canvas") as HTMLCanvasElement | null;
        const core = (terminal as any)._core;
        const rCellH: number | undefined = core?._renderService?.dimensions?.css?.cell?.height;
        const cH = canvas?.style.height ? parseFloat(canvas.style.height) : 0;
        const rows = terminal!.rows;
        const ch = rCellH ?? (cH > 0 ? cH / rows : scr.clientHeight / rows);
        const row = lineIdx - vpStart;
        return { offset: Math.round(sTop + row * ch), cellHeight: ch };
      }

      // ── Background panes ──
      if (!isActiveRef.current) {
        if (isPromptVisible) {
          // Prompt at known index — unhide
          if (hiddenRef.current) {

            hiddenRef.current = false;
            setHidden(false);
          }
          notAtBottomSinceRef.current = 0;
        } else if (isAtBottom) {
          // Terminal at bottom but promptLineIdxRef is stale (e.g. Gemini cleared
          // buffer on SIGWINCH). Scan for prompt at its new position.
          const check = scanPromptPosition();
          if (check) {
            promptLineIdxRef.current = check.promptLineIdx;
            setTopOffset(check.offset);
            setCellHeight(check.cellHeight);
            if (hiddenRef.current) {

              hiddenRef.current = false;
              setHidden(false);
            }
          }
          // Don't hide even if scan fails — at bottom means prompt will appear
          notAtBottomSinceRef.current = 0;
        } else {
          // Not at bottom, prompt not visible — user scrolled away
          if (!hiddenRef.current && promptLineIdxRef.current >= 0) {

            hiddenRef.current = true;
            setHidden(true);
          }
          notAtBottomSinceRef.current = notAtBottomSinceRef.current || Date.now();
        }
        return;
      }

      // ── Active pane ──

      // Case 1: At the bottom — do a full scan to find/update the prompt
      if (isAtBottom) {
        notAtBottomSinceRef.current = 0;

        const result = scanPromptPosition();
        if (!result) return;

        // Skip the old echoed prompt line after a submit — wait for the NEW prompt
        if (submittedLineIdxRef.current >= 0 && result.promptLineIdx === submittedLineIdxRef.current) return;
        // Found a new prompt — clear the skip marker
        submittedLineIdxRef.current = -1;

        // For always-visible CLI composers, hide during interactive mode.
        // Also hide on Pass 2/3 if we've previously seen a Pass 1 prompt —
        // during startup the CLI hasn't rendered its real prompt yet, so Pass 2/3
        // matches are just banner text, not interactive dialogs.
        // Skip auto-hide during resize transitions — CLIs like Gemini clear and
        // redraw the screen on SIGWINCH, causing mid-redraw scans to find Pass 2/3.
        if (result.promptPass === 1) seenPass1Ref.current = true;
        const isResizing = Date.now() < resizingUntilRef.current;
        if (alwaysVisible && !isResizing && (
          isInteractiveMode(result.promptLineIdx) ||
          (result.promptPass !== 1 && seenPass1Ref.current)
        )) {

          setHidden(true);
          hiddenRef.current = true;
          textareaRef.current?.blur();
          terminal.focus();
          return;
        }

        // Transitioning from hidden → visible (AI finished, prompt reappeared)
        if (hiddenRef.current) {
          // Don't call scrollToBottom() here — it fights manual scrolling.
          // The user or TerminalPane's doFit() manages scroll position.
          setTimeout(() => textareaRef.current?.focus(), 30);
          showTimeRef.current = Date.now();
        }
        setHidden(false);
        hiddenRef.current = false;
        setTopOffset(result.offset);
        setCellHeight(result.cellHeight);
        promptLineIdxRef.current = result.promptLineIdx;
        if (!valueRef.current) {
          setCliSuggestion(scanCliSuggestion(result.promptLineIdx));
        }
        if (result.offset !== lastOffsetRef.current) {
          lastOffsetRef.current = result.offset;
          if (alwaysVisible) {
            setTimeout(() => textareaRef.current?.focus(), 30);
          }
        }
        return;
      }

      // Case 2: Scrolled but prompt line still visible — reposition without re-scanning.
      // Validate the stored line still looks like a prompt (it may have become
      // stale if the CLI output new content and the prompt moved to a new line).
      if (isPromptVisible) {
        notAtBottomSinceRef.current = 0;
        const storedLine = buf.getLine(promptIdx);
        const storedText = storedLine?.translateToString().trim() ?? "";
        const stillLooksLikePrompt = /^[>❯›»]/.test(storedText);

        if (stillLooksLikePrompt) {
          const result = offsetForLine(promptIdx);
          if (result != null) {
            setTopOffset(result.offset);
            setCellHeight(result.cellHeight);
            if (hiddenRef.current) {
              setHidden(false);
              hiddenRef.current = false;
            }
          }
          return;
        }
        // Stored prompt line is stale — fall through to full scan
        const freshResult = scanPromptPosition();
        if (freshResult) {
          setTopOffset(freshResult.offset);
          setCellHeight(freshResult.cellHeight);
          promptLineIdxRef.current = freshResult.promptLineIdx;
          if (hiddenRef.current) {
            setHidden(false);
            hiddenRef.current = false;
          }
        } else if (!hiddenRef.current) {

          hiddenRef.current = true;
          setHidden(true);
          textareaRef.current?.blur();
        }
        return;
      }

      // Case 3: Prompt scrolled out of view — hide.
      if (!hiddenRef.current) {

        hiddenRef.current = true;
        setHidden(true);
        textareaRef.current?.blur();
      }
    });
    return () => disposable.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal, alwaysVisible]);

  // Re-scan when the xterm screen is resized (fitAddon.fit ran, layout settled).
  // This corrects stale topOffset/cellHeight when 16 panes open simultaneously and
  // the CSS grid layout wasn't stable when the initial tryFind() fired.
  //
  // Also observe the container's parent (the position:relative wrapper) — this
  // element resizes immediately during pane drag, while .xterm-screen only resizes
  // after fitAddon.fit() runs (debounced 100ms). Without this, the composer stays
  // at its old position during the entire drag.
  useEffect(() => {
    if (!terminal) return;
    const container = containerRef.current;
    if (!container) return;
    const screen = container.querySelector(".xterm-screen") as HTMLElement | null;
    if (!screen) return;

    function doScan() {
      const result = scanPromptPosition();
      if (result) {
        setTopOffset(result.offset);
        setCellHeight(result.cellHeight);
        promptLineIdxRef.current = result.promptLineIdx;
      }
      // Sync effective font size — doFit() may have scaled the terminal font
      // for narrow panes without triggering a React re-render.
      if (terminal) {
        setEffectiveFontSize(terminal.options.fontSize ?? fontSize);
      }
    }

    // Scan that also unhides the composer if a valid prompt is found.
    // Used by resize observers to recover from mid-resize auto-hide.
    function doScanAndUnhide() {
      const result = scanPromptPosition();
      if (result) {
        setTopOffset(result.offset);
        setCellHeight(result.cellHeight);
        promptLineIdxRef.current = result.promptLineIdx;
        if (result.promptPass === 1 && hiddenRef.current) {

          setHidden(false);
          hiddenRef.current = false;
        }
      }
    }

    // Observer on .xterm-screen: fires after fitAddon.fit().
    // Double-rAF matches the settling pattern in TerminalPane's doFit() —
    // WebGL renderer processes resize asynchronously and needs two frames.
    let rafId1 = 0;
    let rafId2 = 0;
    const screenObserver = new ResizeObserver(() => {
      // Suppress auto-hide during resize transitions — CLIs like Gemini
      // clear and redraw the screen on SIGWINCH, causing mid-redraw scans
      // to find Pass 2/3 and hide the composer permanently.
      resizingUntilRef.current = Date.now() + 500;
      cancelAnimationFrame(rafId1);
      cancelAnimationFrame(rafId2);
      rafId1 = requestAnimationFrame(() => {
        rafId2 = requestAnimationFrame(doScan);
      });
    });
    screenObserver.observe(screen);

    // Observer on container parent: fires immediately during pane drag.
    // The terminal re-fits after 100ms debounce, then needs ~2 frames to settle.
    // Schedule two scans: one at 150ms (during drag, best-effort) and a final
    // correction at 350ms (guaranteed settled after fit + WebGL double-rAF).
    // The final scan also unhides the composer if it was hidden mid-resize.
    let parentTimer1: ReturnType<typeof setTimeout> | undefined;
    let parentTimer2: ReturnType<typeof setTimeout> | undefined;
    const parent = container.parentElement;
    const parentObserver = parent ? new ResizeObserver(() => {
      resizingUntilRef.current = Date.now() + 500;
      clearTimeout(parentTimer1);
      clearTimeout(parentTimer2);
      parentTimer1 = setTimeout(doScan, 150);
      parentTimer2 = setTimeout(doScanAndUnhide, 350);
    }) : null;
    parentObserver?.observe(parent!);

    return () => {
      cancelAnimationFrame(rafId1);
      cancelAnimationFrame(rafId2);
      clearTimeout(parentTimer1);
      clearTimeout(parentTimer2);
      screenObserver.disconnect();
      parentObserver?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal]);

  // Periodic position correction — catches any alignment drift for all panes
  // (including background/unfocused). Runs every 10s, lightweight: one buffer
  // scan + 2 DOM rect reads. Also recovers hidden composers if prompt reappeared.
  useEffect(() => {
    if (!terminal) return;
    const interval = setInterval(() => {
      const result = scanPromptPosition();
      if (result) {
        setTopOffset(result.offset);
        setCellHeight(result.cellHeight);
        promptLineIdxRef.current = result.promptLineIdx;
        if (hiddenRef.current && result.promptPass === 1) {
          hiddenRef.current = false;
          setHidden(false);
        }
      }
    }, 10000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal]);

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

  // Load user-defined custom commands from ~/.<cli>/commands/ and <project>/.<cli>/commands/
  // Runs for claude, codex, and gemini; re-runs if terminalType or workingDir changes.
  useEffect(() => {
    loadUserSkills(terminalType, workingDir).then(setUserSkills).catch(() => {});
  }, [terminalType, workingDir]);

  // Auto-focus on mount + register as active composer
  useEffect(() => {
    useClipboardImageStore.getState().setActiveComposerTerminalId(terminalId);
    if (suppressAutoFocus) return; // pane opened in background — don't steal focus
    const timer = setTimeout(() => textareaRef.current?.focus(), 30);
    return () => clearTimeout(timer);
  }, [terminalId]);

  // Re-focus the textarea after the user clicks the terminal area, but only when
  // scrolled to the bottom. This uses a delayed refocus instead of mousedown
  // preventDefault, so scrolling, text selection, and scrollbar drag all work normally.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !alwaysVisible) return;
    function onClick() {
      if (hiddenRef.current) return;
      if (!terminal) return;
      const buf = terminal.buffer.active;
      const isAtBottom = buf.viewportY + terminal.rows >= buf.length - 1;
      if (!isAtBottom) return;
      // Short delay lets xterm process the click first, then reclaim focus
      setTimeout(() => textareaRef.current?.focus(), 150);
    }
    container.addEventListener("click", onClick);
    return () => container.removeEventListener("click", onClick);
  }, [containerRef, alwaysVisible, terminal]);

  // Auto-resize textarea height based on expansion mode.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const sh = ta.scrollHeight;
    if (composerExpansion === "scroll") {
      const h = Math.min(sh, 120);
      ta.style.height = `${h}px`;
      ta.style.overflowY = sh > 120 ? "auto" : "hidden";
    } else {
      const h = Math.min(sh, 200);
      ta.style.height = `${h}px`;
      ta.style.overflowY = "hidden";
    }
  }, [value, composerExpansion]);

  // "down" mode: add paddingBottom to the xterm parent so the terminal shrinks,
  // making room for the composer at the bottom. The existing ResizeObserver on the
  // xterm container detects the size change and calls fitAddon.fit() automatically.
  useEffect(() => {
    if (composerExpansion !== "down") {
      // Reset padding when not in "down" mode
      const parent = containerRef.current?.parentElement;
      if (parent) parent.style.paddingBottom = "";
      return;
    }
    const composerEl = composerRef.current;
    const parent = containerRef.current?.parentElement;
    if (!composerEl || !parent) return;

    const ro = new ResizeObserver(() => {
      const h = composerEl.offsetHeight;
      parent.style.paddingBottom = h > 0 ? `${h}px` : "";
    });
    ro.observe(composerEl);
    // Set initial padding
    const h = composerEl.offsetHeight;
    parent.style.paddingBottom = h > 0 ? `${h}px` : "";

    return () => {
      ro.disconnect();
      parent.style.paddingBottom = "";
    };
  }, [composerExpansion, containerRef]);

  // Re-scan prompt position after expansion mode changes.
  // When switching from "down" → "up"/"scroll", the paddingBottom cleanup alters
  // the layout. Wait one frame for the browser reflow before re-scanning so that
  // topOffset and cellHeight reflect the actual post-cleanup geometry.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const result = scanPromptPosition();
      if (result) {
        setTopOffset(result.offset);
        setCellHeight(result.cellHeight);
      }
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerExpansion]);

  // Scan when pane becomes active OR terminal becomes available.
  // Sets promptLineIdxRef + shows composer (the initial poll and onRender
  // skip scanning for inactive panes, so this fills the gap).
  useEffect(() => {
    if (!terminal) return;
    requestAnimationFrame(() => {
      const result = scanPromptPosition();
      if (result) {
        setTopOffset(result.offset);
        setCellHeight(result.cellHeight);
        promptLineIdxRef.current = result.promptLineIdx;
        if (hiddenRef.current) {
          setHidden(false);
          hiddenRef.current = false;
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, terminal]);

  // Re-scan prompt position after font size changes (Ctrl+Scroll zoom).
  // fitAddon.fit() runs and reflows the terminal, but the ResizeObserver may
  // fire before xterm finishes re-rendering. Double-rAF waits for xterm to
  // settle before re-scanning.
  useEffect(() => {
    if (!terminal) return;
    setEffectiveFontSize(terminal.options.fontSize ?? fontSize);
    const raf1 = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const result = scanPromptPosition();
        if (result) {
          setTopOffset(result.offset);
          setCellHeight(result.cellHeight);
        }
      });
    });
    return () => cancelAnimationFrame(raf1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontSize]);

  // Dynamically update [Console, N rows] tag as user selects/deselects entries
  useEffect(() => {
    if (!consoleSelectMode) return;
    const store = useBrowserConsoleStore.getState();
    const selected = store.entries.filter((e) => store.selectedIds.has(e.id));
    const oldTag = consoleTagRef.current;

    if (selected.length === 0) {
      // Remove tag + its visual space from textarea
      if (oldTag) {
        setValue((prev) => prev.replace(oldTag + " ", "").replace(" " + oldTag, "").replace(oldTag, ""));
        consoleTagRef.current = null;
        setConsoleSnippet(null);
      }
      return;
    }

    const newTag = `[Console, ${selected.length} row${selected.length > 1 ? "s" : ""}]`;
    const lines = selected.map((e) => `[${e.method}] ${e.text}`).join("\n");
    const formatted = `--- Browser Console (${selected.length} entr${selected.length > 1 ? "ies" : "y"}) ---\n${lines}\n---`;
    setConsoleSnippet({ tag: newTag, formatted });

    if (oldTag) {
      // Replace old tag text with updated tag (space stays in place)
      setValue((prev) => prev.replace(oldTag, newTag));
    } else {
      // Insert tag with a visual space: before if text precedes, after otherwise
      const ta = textareaRef.current;
      if (ta) {
        const before = ta.value.slice(0, ta.selectionStart);
        const after = ta.value.slice(ta.selectionEnd);
        const hasBefore = before.trimEnd().length > 0;
        const insert = hasBefore ? " " + newTag : newTag + " ";
        setValue(before + insert + after);
        setTimeout(() => {
          ta.selectionStart = ta.selectionEnd = before.length + insert.length;
          ta.focus();
        }, 0);
      }
    }
    consoleTagRef.current = newTag;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consoleSelectedIds, consoleSelectMode]);

  // One-click insert all console errors as a placeholder tag
  const insertErrorDebug = () => {
    const store = useBrowserConsoleStore.getState();
    const errors = store.entries.filter((e) => e.method === "error");
    if (errors.length === 0) return;

    // Exit manual select mode if active
    if (store.selectMode) store.setSelectMode(false);

    const newTag = `[Error Debug, ${errors.length} error${errors.length > 1 ? "s" : ""}]`;
    const lines = errors.map((e) => `[error] ${e.text}`).join("\n");
    const formatted = `--- Browser Console Errors (${errors.length} entr${errors.length > 1 ? "ies" : "y"}) ---\n${lines}\n---`;

    const oldTag = consoleTagRef.current;
    if (oldTag) {
      setValue((prev) => prev.replace(oldTag, newTag));
    } else {
      const ta = textareaRef.current;
      if (ta) {
        const before = ta.value.slice(0, ta.selectionStart);
        const after = ta.value.slice(ta.selectionEnd);
        const hasBefore = before.trimEnd().length > 0;
        const insert = hasBefore ? " " + newTag : newTag + " ";
        setValue(before + insert + after);
        setTimeout(() => {
          ta.selectionStart = ta.selectionEnd = before.length + insert.length;
          ta.focus();
        }, 0);
      }
    }
    consoleTagRef.current = newTag;
    setConsoleSnippet({ tag: newTag, formatted });
  };

  // Re-scan CLI suggestion when textarea empties; clear when user types anything
  useEffect(() => {
    if (!value && promptLineIdxRef.current >= 0) {
      setCliSuggestion(scanCliSuggestion(promptLineIdxRef.current));
    } else if (value) {
      setCliSuggestion("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Find the slash token at the cursor position (works mid-sentence).
  // Returns the query text after "/" and the character range, or null if no token.
  function findSlashToken(val: string, cursorPos: number): { query: string; start: number; end: number } | null {
    // Search backwards from cursor for "/" preceded by start-of-string or whitespace
    for (let i = cursorPos - 1; i >= 0; i--) {
      const ch = val[i];
      if (ch === " " || ch === "\n" || ch === "\t") return null; // whitespace before finding /
      if (ch === "/") {
        if (i === 0 || /\s/.test(val[i - 1])) {
          return { query: val.slice(i + 1, cursorPos).toLowerCase(), start: i, end: cursorPos };
        }
        return null; // "/" in the middle of a word
      }
    }
    return null;
  }

  function computeSlashMatches(val: string, cursorPos: number): SlashCommand[] {
    const builtins = SLASH_COMMANDS[terminalType] ?? [];
    // User skills take precedence: remove any built-in whose name is overridden by a skill
    const skillNames = new Set(userSkills.map((s) => s.name));
    const commands = [
      ...builtins.filter((c) => !skillNames.has(c.name)),
      ...userSkills,
    ];
    if (!commands.length) { slashTokenRef.current = null; return []; }
    const token = findSlashToken(val, cursorPos);
    if (!token) { slashTokenRef.current = null; return []; }
    slashTokenRef.current = { start: token.start, end: token.end };
    const query = token.query;
    const matches = query === "" ? commands : commands.filter((c) => (c.label ?? c.name).startsWith(query));
    // Auto-close: exactly 1 match, query is exact label, no arg hint → popup closes so next Enter submits directly
    if (matches.length === 1 && query !== "") {
      const only = matches[0];
      const label = (only.label ?? only.name).toLowerCase();
      const hasArgHint = !!(SLASH_ARG_HINTS[terminalType] ?? {})[only.name];
      if (label === query && !hasArgHint) { slashTokenRef.current = null; return []; }
    }
    return matches;
  }

  function selectSlashCommand(cmd: SlashCommand) {
    const token = slashTokenRef.current;
    const insertion = "/" + cmd.name + " ";
    let newVal: string;
    let cursorAt: number;
    if (token) {
      // Splice into position — works mid-sentence
      newVal = value.slice(0, token.start) + insertion + value.slice(token.end);
      cursorAt = token.start + insertion.length;
    } else {
      newVal = insertion;
      cursorAt = insertion.length;
    }
    setValue(newVal);
    setHistoryIdx(-1);
    imgCycleRef.current = null;
    setSlashMatches([]);
    setSlashSelectedIdx(0); setSlashScrollOffset(0);
    slashTokenRef.current = null;
    updateGhost(newVal);
    setTimeout(() => {
      const ta = textareaRef.current;
      if (ta) { ta.selectionStart = ta.selectionEnd = cursorAt; ta.focus(); }
    }, 0);
  }

  function submit() {
    const ta = textareaRef.current;
    if (!ta) return;
    let text = ta.value.trim();
    if (!text) return;
    // Resolve attached images: replace [Img N] labels with actual file paths
    // so CLIs (Claude, Codex, Gemini) can read the image files
    if (localImages.length > 0) {
      const backend = useAppStore.getState().terminalBackend ?? "wsl";
      const resolvePath = (winPath: string) =>
        backend === "windows" ? winPath : toWslPath(winPath);

      // Replace any [Img N] labels already in text (from autocomplete) with file paths
      for (const img of localImages) {
        const label = getImageLabel(img.winPath);
        if (text.includes(label)) {
          text = text.split(label).join(resolvePath(img.winPath));
        }
      }

      // Append file paths for attached images not yet referenced in text
      const unreferenced = localImages.filter((img) => {
        const filePath = resolvePath(img.winPath);
        return !text.includes(filePath);
      });
      if (unreferenced.length > 0) {
        text = text + " " + unreferenced.map((img) => resolvePath(img.winPath)).join(" ");
      }
    }
    // Expand console snippet placeholder into formatted text
    if (consoleSnippet) {
      // Strip the visual space around the tag, then expand
      const expansion = "\n\n" + consoleSnippet.formatted + "\n\n";
      const tag = consoleSnippet.tag;
      if (text.includes(tag + " ")) {
        text = text.replace(tag + " ", expansion);
      } else if (text.includes(" " + tag)) {
        text = text.replace(" " + tag, expansion);
      } else {
        text = text.replace(tag, expansion);
      }
      setConsoleSnippet(null);
      consoleTagRef.current = null;
      useBrowserConsoleStore.getState().clearSelection();
    }
    addPromptHistory(terminalId, text);
    onSubmit(text);
    setLocalImages([]);
    setValue("");
    setHistoryIdx(-1);
    draftRef.current = "";
    // Mark the old prompt line so the scan skips it (it'll be echoed as
    // command history). Don't reset promptLineIdxRef to -1 — that causes
    // the composer to vanish entirely in some CLIs (e.g. Gemini).
    submittedLineIdxRef.current = promptLineIdxRef.current;
    setPlaceholder(randomPlaceholder());
    if (alwaysVisible) {
      setTimeout(() => textareaRef.current?.focus(), 30);
    } else {
      onClose();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    // Slash command popup: intercept arrows, Tab, Enter, Escape when popup is open
    if (slashMatches.length > 0) {
      if (e.key === "ArrowDown" && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setSlashSelectedIdx((prev) => {
          const next = (prev + 1) % slashMatches.length;
          setSlashScrollOffset((off) => {
            if (next === 0) return 0; // wrapped to top
            if (next >= off + SLASH_VISIBLE) return next - SLASH_VISIBLE + 1;
            return off;
          });
          return next;
        });
        return;
      }
      if (e.key === "ArrowUp" && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setSlashSelectedIdx((prev) => {
          const next = (prev - 1 + slashMatches.length) % slashMatches.length;
          setSlashScrollOffset((off) => {
            if (next === slashMatches.length - 1) return Math.max(0, slashMatches.length - SLASH_VISIBLE); // wrapped to bottom
            if (next < off) return next;
            return off;
          });
          return next;
        });
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        selectSlashCommand(slashMatches[slashSelectedIdx]);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const cmd = slashMatches[slashSelectedIdx];
        const token = slashTokenRef.current;
        const typedQuery = token ? value.slice(token.start + 1, token.end).toLowerCase() : "";
        const cmdLabel = (cmd.label ?? cmd.name).toLowerCase();
        const hasArgHint = !!(SLASH_ARG_HINTS[terminalType] ?? {})[cmd.name];
        // If user already typed the exact command name and it needs no argument,
        // close the popup and submit directly — no double-Enter needed.
        if (typedQuery === cmdLabel && !hasArgHint) {
          setSlashMatches([]);
          setSlashSelectedIdx(0); setSlashScrollOffset(0);
          slashTokenRef.current = null;
          submit();
        } else {
          selectSlashCommand(cmd);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashMatches([]);
        setSlashSelectedIdx(0); setSlashScrollOffset(0);
        return;
      }
    }
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
    // Ctrl+Backspace — custom word deletion that treats "/command" as a single unit
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === "Backspace") {
      const ta = textareaRef.current;
      if (!ta) return;
      const pos = ta.selectionStart;
      if (pos === 0) return;
      const text = ta.value;
      let i = pos - 1;
      // Skip trailing whitespace
      while (i >= 0 && /\s/.test(text[i])) i--;
      // Skip word characters (stop at whitespace or /)
      while (i >= 0 && !/\s/.test(text[i]) && text[i] !== "/") i--;
      // If we landed on "/" preceded by start-of-string or whitespace, delete it too
      if (i >= 0 && text[i] === "/" && (i === 0 || /\s/.test(text[i - 1]))) {
        i--;
      }
      const deleteFrom = i + 1;
      if (deleteFrom < pos) {
        e.preventDefault();
        const newVal = text.slice(0, deleteFrom) + text.slice(pos);
        setValue(newVal);
        setHistoryIdx(-1);
        imgCycleRef.current = null;
        updateGhost(newVal);
        const matches = computeSlashMatches(newVal, deleteFrom);
        setSlashMatches(matches);
        setSlashSelectedIdx(0); setSlashScrollOffset(0);
        setTimeout(() => { ta.selectionStart = ta.selectionEnd = deleteFrom; }, 0);
      }
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
      // Skip if hidden or just re-shown (prevents accidental triggers during interactive dialogue)
      if (hiddenRef.current || Date.now() - showTimeRef.current < 300) return;
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
      // Skip if hidden or just re-shown (prevents accidental triggers during interactive dialogue)
      if (hiddenRef.current || Date.now() - showTimeRef.current < 300) return;
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
    // Shift+Tab — forward to terminal (e.g. mode toggle in Claude) but keep focus
    if (e.key === "Tab" && e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      write("\x1b[Z");
      return;
    }
    // Tab — autocomplete [Img N] from "im"/"img" trigger, or cycle (replace) to next image
    if (e.key === "Tab" && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      const ta = textareaRef.current;
      if (!ta) return;
      const text = ta.value;
      const clipStore = useClipboardImageStore.getState();
      const imageCount = Math.min(clipStore.images.length, 3);

      if (imageCount > 0) {
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
      }

      // CLI autocomplete — accept suggestion into textarea only (sent on Enter via onSubmit)
      if (cliSuggestion) {
        e.preventDefault();
        setValue(value + cliSuggestion);
        setCliSuggestion("");
        return;
      }

      // Placeholder ghost — accept the rotating placeholder suggestion (strip trailing "...", add space)
      if (!value && placeholder) {
        e.preventDefault();
        setValue(placeholder.replace(/\.\.\.$/, "") + " ");
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

  // Image ghost text takes priority over CLI suggestion
  // Image ghost text works with any value; CLI suggestion only when textarea is empty
  const effectiveGhost = ghostText || (!value ? cliSuggestion : "");

  // Slash command inline ghost suffix (opt-in setting): remainder of top match name after what's typed
  const slashGhostSuffix = (() => {
    if (!slashGhostEnabled || slashMatches.length === 0 || !slashTokenRef.current) return "";
    const top = slashMatches[slashSelectedIdx] ?? slashMatches[0];
    const token = slashTokenRef.current;
    const typed = value.slice(token.start + 1, token.end); // text after "/"
    return (top.label ?? top.name).slice(typed.length);
  })();

  // Argument hint ghost: shown after a completed "/<cmd> " token.
  // e.g. "some text /rename " → shows "[name]". Disappears as user types argument.
  const argHintGhost = (() => {
    const ta = textareaRef.current;
    if (!ta) return "";
    const cursor = ta.selectionStart ?? value.length;
    // Look for "/<cmd> " ending exactly at cursor
    const before = value.slice(0, cursor);
    const m = before.match(/(?:^|\s)\/([a-z][\w-]*) $/);
    if (!m) return "";
    return (SLASH_ARG_HINTS[terminalType] ?? {})[m[1]] ?? "";
  })();

  // Build set of all known command names for highlighting completed commands in the textarea
  const knownCommandNames = (() => {
    const names = new Set<string>();
    for (const c of (SLASH_COMMANDS[terminalType] ?? [])) names.add(c.name);
    for (const c of userSkills) names.add(c.name);
    return names;
  })();

  // Segment the value into normal text and recognized slash command tokens for coloring.
  // A command token is "/<name>" at start-of-string or after whitespace, followed by whitespace or end.
  const styledSegments = (() => {
    if (!value || knownCommandNames.size === 0) return null;
    const segments: Array<{ text: string; isCmd: boolean }> = [];
    let i = 0;
    let hasCmd = false;
    while (i < value.length) {
      if (value[i] === "/" && (i === 0 || /\s/.test(value[i - 1]))) {
        let found = false;
        for (const name of knownCommandNames) {
          if (value.startsWith(name, i + 1) &&
              (i + 1 + name.length >= value.length || /\s/.test(value[i + 1 + name.length]))) {
            const cmdText = "/" + name;
            segments.push({ text: cmdText, isCmd: true });
            i += cmdText.length;
            hasCmd = true;
            found = true;
            break;
          }
        }
        if (!found) {
          // Collect as normal text
          let j = i + 1;
          while (j < value.length && !(value[j] === "/" && (j === 0 || /\s/.test(value[j - 1])))) j++;
          segments.push({ text: value.slice(i, j), isCmd: false });
          i = j;
        }
      } else {
        let j = i + 1;
        while (j < value.length && !(value[j] === "/" && /\s/.test(value[j - 1]))) j++;
        segments.push({ text: value.slice(i, j), isCmd: false });
        i = j;
      }
    }
    return hasCmd ? segments : null;
  })();

  const hasArrows = value.includes("->") || value.includes("<-");

  const useCard = terminalType === "codex" || terminalType === "gemini";
  const isGemini = terminalType === "gemini";
  const isCodex = terminalType === "codex";

  void (isCodex); // used by cardLeft/cardRight/cardPadding below
  const cardLeft = isCodex ? 7 : isGemini ? 8 : 0;
  const cardRight = isCodex ? 11 : isGemini ? 10 : 14;
  const cardPadding = isCodex
    ? `${Math.round((cellHeight + 12) / 2)}px 10px ${Math.round((cellHeight + 12) / 2) - 1}px`
    : isGemini
      ? `${Math.round((cellHeight * 0.4 + 6) / 2) - 2}px 10px ${Math.round((cellHeight * 0.4 + 6) / 2)}px`
      : "3px 10px";

  // All modes: position the composer so its top edge aligns with the prompt row.
  // The composer always starts at the prompt and grows downward naturally.
  // Mode differences (up vs down vs scroll) only affect textarea height behavior
  // and whether paddingBottom is used — NOT the anchor position.
  // Per-CLI vertical nudge to align with each CLI's input prompt
  // Nudge derived from card padding formulas so it auto-scales with cellHeight.
  // Compensates for: card top-padding + border (1px) + textarea wrapper top (4px).
  // Claude composer height ≈ 6px padding + effectiveFontSize*1.4.
  // The overflow beyond one cellHeight goes downward into the statusbar.
  // Shift the composer up by the overflow amount so it goes into the prompt
  // line above (which the composer already covers).
  const actualFont = terminal?.options.fontSize ?? effectiveFontSize;
  const claudeComposerH = 6 + actualFont * 1.4;
  const claudeOverflow = cellHeight > 0 ? Math.max(0, claudeComposerH - cellHeight) : 0;
  const promptNudge = isCodex
    ? -(Math.round((cellHeight + 12) / 2) + 4)
    : isGemini
      ? -(Math.round((cellHeight * 0.4 + 6) / 2) + 2)
      : -(Math.round(claudeOverflow) - 3);
  const positionStyle: React.CSSProperties = { top: `${topOffset + promptNudge}px` };

  return (
    <>
    <div
      ref={composerRef}
      data-composer
      style={{
        position: "absolute",
        ...positionStyle,
        left: cardLeft,
        right: cardRight,
        zIndex: 20,
        backgroundColor: useCard ? lightenHex(terminalBg, 20) : terminalBg,
        padding: cardPadding,
        display: hidden ? "none" : "flex",
        alignItems: "center",
        gap: 8,
        ...(useCard
          ? {
              border: `1px solid ${hexToRgba(terminalCursor, 0.25)}`,
              borderRadius: 6,
              boxShadow: `0 2px 8px rgba(0,0,0,0.35), 0 0 0 1px rgba(0,0,0,0.15)`,
            }
          : {}),
      }}
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => {
        if (e.ctrlKey) return; // let Ctrl+Scroll propagate for zoom
        if (terminal) terminal.scrollLines(e.deltaY > 0 ? 3 : -3);
      }}
    >
      {/* Slash command popup — appears above the composer */}
      {slashMatches.length > 0 && (() => {
        const hasMore = slashMatches.length > SLASH_VISIBLE;
        const canScrollUp = slashScrollOffset > 0;
        const canScrollDown = slashScrollOffset + SLASH_VISIBLE < slashMatches.length;
        const visibleSlice = slashMatches.slice(slashScrollOffset, slashScrollOffset + SLASH_VISIBLE);
        return (
          <div
            style={{
              position: "absolute",
              bottom: "100%",
              left: 0,
              right: 0,
              marginBottom: 4,
              backgroundColor: lightenHex(terminalBg, 18),
              border: `1px solid ${hexToRgba(terminalCursor, 0.2)}`,
              borderRadius: 5,
              boxShadow: "0 -2px 10px rgba(0,0,0,0.4)",
              zIndex: 10,
              overflow: "hidden",
            }}
          >
            {visibleSlice.map((cmd, visIdx) => {
              const realIdx = slashScrollOffset + visIdx;
              return (
                <div
                  key={cmd.name + (cmd.label ?? "")}
                  onMouseDown={(e) => { e.preventDefault(); selectSlashCommand(cmd); }}
                  onMouseEnter={() => setSlashSelectedIdx(realIdx)}
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 10,
                    padding: "4px 10px",
                    cursor: "pointer",
                    backgroundColor: realIdx === slashSelectedIdx ? lightenHex(terminalBg, 36) : "transparent",
                  }}
                >
                  <span
                    style={{
                      fontFamily: "Hack, monospace",
                      fontSize: effectiveFontSize - 1,
                      minWidth: 90,
                      flexShrink: 0,
                    }}
                  >
                    {(() => {
                      const label = cmd.label ?? cmd.name;
                      const token = slashTokenRef.current;
                      const matchLen = token ? value.slice(token.start + 1, token.end).length : 0;
                      return (
                        <>
                          <span style={{ color: terminalCursor }}>/{label.slice(0, matchLen)}</span>
                          <span style={{ color: terminalFg, opacity: 0.5 }}>{label.slice(matchLen)}</span>
                        </>
                      );
                    })()}
                  </span>
                  <span
                    style={{
                      fontSize: effectiveFontSize - 2,
                      color: terminalFg,
                      opacity: 0.5,
                      overflow: "hidden",
                      whiteSpace: "nowrap",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {cmd.description}
                  </span>
                </div>
              );
            })}
            {/* Footer: arrows (only when scrollable) + page counter (always) */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "3px 10px 4px",
                fontSize: effectiveFontSize - 2,
                color: terminalFg,
                opacity: 0.45,
              }}
            >
              {hasMore && (
                <>
                  <span style={{ opacity: canScrollUp ? 1 : 0.3 }}>&#9650;</span>
                  <span style={{ opacity: canScrollDown ? 1 : 0.3 }}>&#9660;</span>
                </>
              )}
              <span style={{ marginLeft: hasMore ? 2 : 0 }}>
                ({slashSelectedIdx + 1}/{slashMatches.length})
              </span>
            </div>
          </div>
        );
      })()}
      <FaAngleRight
        style={{
          color: terminalCursor,
          fontSize: effectiveFontSize,
          flexShrink: 0,
          opacity: 0.7,
          userSelect: "none",
          position: "relative",
          top: useCard ? 0 : -3,
          transform: "scale(1.2)",
        }}
      />
      <div style={{ flex: 1, position: "relative", minWidth: 0, top: isGemini ? 4 : isCodex ? 4 : 0 }}>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            let newVal = e.target.value;
            // Protect console tag + its adjacent space from deletion
            const tag = consoleTagRef.current;
            if (tag) {
              if (!newVal.includes(tag)) return;
              const idx = newVal.indexOf(tag);
              const hasSpaceAfter = newVal[idx + tag.length] === " ";
              const hasSpaceBefore = idx > 0 && newVal[idx - 1] === " ";
              const oldIdx = value.indexOf(tag);
              const hadSpaceAfter = value[oldIdx + tag.length] === " ";
              const hadSpaceBefore = oldIdx > 0 && value[oldIdx - 1] === " ";
              if ((hadSpaceAfter && !hasSpaceAfter) || (hadSpaceBefore && !hasSpaceBefore)) return;
              // Auto-insert space when user types directly before the tag
              if (idx > 0 && !hasSpaceBefore && newVal[idx - 1] !== " ") {
                newVal = newVal.slice(0, idx) + " " + newVal.slice(idx);
              }
            }
            setValue(newVal); setHistoryIdx(-1); imgCycleRef.current = null; updateGhost(newVal);
            const cursorPos = e.target.selectionStart ?? newVal.length;
            const matches = computeSlashMatches(newVal, cursorPos);
            setSlashMatches(matches);
            setSlashSelectedIdx(0); setSlashScrollOffset(0);
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            useClipboardImageStore.getState().setActiveComposerTerminalId(terminalId);
            // Re-scan position on focus to correct any accumulated drift + unhide
            const result = scanPromptPosition();
            if (result) {
              setTopOffset(result.offset);
              setCellHeight(result.cellHeight);
              if (hiddenRef.current) {
                setHidden(false);
                hiddenRef.current = false;
              }
            }
          }}
          onBlur={() => { setSlashMatches([]); setSlashSelectedIdx(0); setSlashScrollOffset(0); }}
          onAuxClick={(e) => {
            if (e.button !== 1) return; // middle-click only
            e.preventDefault();
            navigator.clipboard.readText().then((text) => {
              if (!text) return;
              const ta = textareaRef.current;
              if (!ta) return;
              const start = ta.selectionStart;
              const end = ta.selectionEnd;
              const newVal = value.slice(0, start) + text + value.slice(end);
              setValue(newVal);
              const cursor = start + text.length;
              requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = cursor; });
            }).catch(() => {});
          }}
          onWheel={(e) => {
            e.stopPropagation();
            // Forward wheel events to the terminal so scrolling works while composer has focus
            if (terminal) {
              terminal.scrollLines(e.deltaY > 0 ? 3 : -3);
            }
          }}
          rows={1}
          spellCheck={false}
          style={{
            width: "100%",
            backgroundColor: "transparent",
            color: (consoleTagRef.current && value.includes(consoleTagRef.current)) || styledSegments || hasArrows ? "transparent" : terminalFg,
            fontFamily: "Hack, monospace",
            fontSize: effectiveFontSize,
            lineHeight: 1.4,
            letterSpacing: 1,
            border: "none",
            outline: "none",
            resize: "none",
            padding: 0,
            margin: 0,
            marginTop: 0,
            overflowY: composerExpansion === "scroll" ? "auto" : "hidden",
            overflowX: "hidden",
            caretColor: terminalCursor,
            animation: promptifying ? "promptify-pulse 1.5s ease-in-out infinite" : "none",
          }}
        />
        {/* Console tag overlay — renders all text with the tag grayed out */}
        {consoleTagRef.current && value.includes(consoleTagRef.current) && (() => {
          const tag = consoleTagRef.current!;
          const idx = value.indexOf(tag);
          const before = value.slice(0, idx);
          const after = value.slice(idx + tag.length);
          return (
            <div
              aria-hidden
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                pointerEvents: "none",
                fontFamily: "Hack, monospace",
                fontSize: effectiveFontSize,
                lineHeight: 1.4,
                letterSpacing: 1,
                padding: 0,
                margin: 0,
                marginTop: 0,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              <span style={{ color: terminalFg }}>{renderWithArrows(before)}</span>
              <span style={{ color: terminalFg, opacity: 0.35 }}>{renderWithArrows(tag)}</span>
              <span style={{ color: terminalFg }}>{renderWithArrows(after)}</span>
            </div>
          );
        })()}
        {/* Slash command color overlay — renders completed commands in teal */}
        {styledSegments && !(consoleTagRef.current && value.includes(consoleTagRef.current)) && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              pointerEvents: "none",
              fontFamily: "Hack, monospace",
              fontSize: effectiveFontSize,
              lineHeight: 1.4,
              letterSpacing: 1,
              padding: 0,
              margin: 0,
              marginTop: 0,
                whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {styledSegments.map((seg, i) => (
              <span key={i} style={{ color: seg.isCmd ? "#5eead4" : terminalFg }}>{renderWithArrows(seg.text)}</span>
            ))}
          </div>
        )}
        {/* Arrow ligature overlay — renders -> as → when no other overlay is active */}
        {hasArrows && !styledSegments && !(consoleTagRef.current && value.includes(consoleTagRef.current)) && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              pointerEvents: "none",
              fontFamily: "Hack, monospace",
              fontSize: effectiveFontSize,
              lineHeight: 1.4,
              letterSpacing: 1,
              padding: 0,
              margin: 0,
              marginTop: 0,
                whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              color: terminalFg,
            }}
          >
            {renderWithArrows(value)}
          </div>
        )}
        {/* Ghost text overlay — shows image autocomplete, CLI suggestion, slash command ghost, or arg hint */}
        {(effectiveGhost || slashGhostSuffix || argHintGhost) && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              top: 0,
              left: value ? 0 : 10,
              right: 0,
              pointerEvents: "none",
              fontFamily: "Hack, monospace",
              fontSize: effectiveFontSize,
              lineHeight: 1.4,
              letterSpacing: 1,
              padding: 0,
              margin: 0,
              marginTop: 0,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              color: "transparent",
            }}
          >
            {/* Invisible real text to push ghost to the right position */}
            <span>{value}</span>
            {effectiveGhost && <span style={{ color: terminalFg, opacity: 0.35 }}>{effectiveGhost}</span>}
            {slashGhostSuffix && <span style={{ color: terminalFg, opacity: 0.35 }}>{slashGhostSuffix}</span>}
            {argHintGhost && <span style={{ color: terminalFg, opacity: 0.35 }}>{argHintGhost}</span>}
          </div>
        )}
        {/* Custom placeholder overlay — offset from cursor to prevent overlap */}
        {!value && !effectiveGhost && !slashGhostSuffix && !argHintGhost && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              top: 0,
              left: 10,
              right: 0,
              pointerEvents: "none",
              fontFamily: "Hack, monospace",
              fontSize: effectiveFontSize,
              lineHeight: 1.4,
              letterSpacing: 1,
              padding: 0,
              margin: 0,
              marginTop: 0,
              whiteSpace: "nowrap",
              overflow: "hidden",
              color: terminalFg,
              opacity: 0.3,
            }}
          >
            {placeholder}
          </div>
        )}
      </div>
      {promptifying && (
        <style>{`@keyframes promptify-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }`}</style>
      )}
      {/* Attached image thumbnails */}
      {localImages.map((img, i) => (
          <div
            key={img.id}
            onClick={() => setLocalImages((prev) => prev.filter((im) => im.id !== img.id))}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setImgCtxMenu({ x: e.clientX, y: e.clientY, imgId: img.id });
            }}
            style={{
              position: "relative",
              top: useCard ? 0 : -5,
              width: 26,
              height: 26,
              borderRadius: 4,
              overflow: "hidden",
              cursor: "pointer",
              border: `1px solid ${terminalCursor}`,
              flexShrink: 0,
            }}
            title={`Image ${i + 1} attached — click to remove, right-click for options`}
          >
            <img
              src={img.dataUri}
              alt={`Image ${i + 1}`}
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            />
            {/* Number badge (top-left) */}
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: 8,
                height: 8,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: terminalCursor,
                borderBottomRightRadius: 2,
                fontSize: 6,
                fontWeight: 700,
                color: "#fff",
                lineHeight: 1,
              }}
            >
              {i + 1}
            </div>
            {/* View full image button (top-right) */}
            <div
              onClick={(e) => {
                e.stopPropagation();
                setPreviewImage({ dataUri: img.dataUri, winPath: img.winPath });
              }}
              title="View full image"
              style={{
                position: "absolute",
                top: 0,
                right: 0,
                width: 14,
                height: 14,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: "rgba(0,0,0,0.6)",
                borderBottomLeftRadius: 3,
                opacity: 0,
                transition: "opacity 120ms ease",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = "0"; }}
            >
              <FaExpand size={8} color="white" />
            </div>
          </div>
        ))}
      {/* Error Debug button — auto-collects error entries */}
      {browserPreviewOpen && autoDebug && consoleErrorCount > 0 && (
        <div
          tabIndex={0}
          onClick={insertErrorDebug}
          style={{
            flexShrink: 0,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "2px 6px",
            borderRadius: 4,
            backgroundColor: "#dc2626",
            color: "#fff",
            fontSize: 11,
            fontWeight: 600,
            fontVariantNumeric: "tabular-nums",
            transition: "opacity 120ms ease",
            opacity: 0.9,
            position: "relative",
            top: useCard ? 0 : -3,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.9"; }}
          title={`Insert ${consoleErrorCount} console error${consoleErrorCount > 1 ? "s" : ""} into prompt`}
        >
          <FaBug size={10} color="#fff" />
          {consoleErrorCount}
        </div>
      )}
      {/* Console insert button — only visible when browser preview is open */}
      {browserPreviewOpen && (
        <div
          tabIndex={0}
          onClick={() => {
            const store = useBrowserConsoleStore.getState();
            if (store.selectMode) {
              // Exit select mode — remove only the tag (+ adjacent space) from textarea
              store.setSelectMode(false);
              const tag = consoleTagRef.current;
              if (tag) {
                setValue((prev) => prev.replace(tag + " ", "").replace(" " + tag, "").replace(tag, "").trim());
              }
              setConsoleSnippet(null);
              consoleTagRef.current = null;
            } else {
              store.setRequestOpenConsole(true);
              store.setSelectMode(true);
            }
          }}
          style={{
            flexShrink: 0,
            marginTop: 0,
            cursor: "pointer",
            opacity: consoleSelectMode ? 1 : consoleEntryCount > 0 ? 0.6 : 0.2,
            transition: "opacity 120ms ease",
            position: "relative",
            top: useCard ? 0 : -3,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; }}
          onMouseLeave={(e) => {
            e.currentTarget.style.opacity = consoleSelectMode ? "1" : consoleEntryCount > 0 ? "0.6" : "0.2";
          }}
          title={consoleSelectMode ? "Done selecting" : "Select console entries to insert"}
        >
          <AiFillCode size={16} color={terminalCursor} />
        </div>
      )}
      {/* Copy / Clear — stacked vertically to save space */}
      {value.trim() && (
        <div style={{
          display: "flex",
          flexDirection: "column",
          gap: 5,
          flexShrink: 0,
          position: "relative",
          top: useCard ? 0 : -3,
        }}>
          <div
            tabIndex={0}
            onClick={() => {
              const text = textareaRef.current?.value;
              if (text) navigator.clipboard.writeText(text).catch(() => {});
            }}
            style={{
              cursor: "pointer",
              opacity: 0.4,
              transition: "opacity 120ms ease",
              lineHeight: 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.4"; }}
            title="Copy to clipboard"
          >
            <FaCopy size={10} color={terminalCursor} />
          </div>
          <div
            tabIndex={0}
            onClick={() => {
              const text = textareaRef.current?.value;
              if (!text?.trim()) return;
              useUndoClearStore.getState().setClearedText(text);
              setValue("");
              setHistoryIdx(-1);
              draftRef.current = "";
              imgCycleRef.current = null;
              setGhostText("");
              setLocalImages([]);
              if (consoleSnippet) {
                setConsoleSnippet(null);
                consoleTagRef.current = null;
                useBrowserConsoleStore.getState().clearSelection();
              }
            }}
            style={{
              cursor: "pointer",
              opacity: 0.4,
              transition: "opacity 120ms ease",
              lineHeight: 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.4"; }}
            title="Clear (Ctrl+Z to undo)"
          >
            <FaDeleteLeft size={11} color={terminalCursor} />
          </div>
        </div>
      )}
      {/* Promptifier button */}
      <div
        tabIndex={0}
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
          marginTop: 0,
          cursor: value.trim() && !promptifying ? "pointer" : "default",
          opacity: promptifying ? 1 : value.trim() ? 0.6 : 0.2,
          transition: "opacity 120ms ease",
          position: "relative",
          top: useCard ? 0 : -3,
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
          <FaWandMagicSparkles size={16} color={terminalCursor} />
        )}
      </div>
      {/* Send button */}
      <div
        tabIndex={0}
        onClick={submit}
        style={{
          flexShrink: 0,
          marginTop: 0,
          cursor: value.trim() ? "pointer" : "default",
          opacity: value.trim() ? 0.8 : 0.25,
          transition: "opacity 120ms ease",
          position: "relative",
          top: useCard ? 0 : -3,
        }}
        onMouseEnter={(e) => {
          if (value.trim()) e.currentTarget.style.opacity = "1";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.opacity = value.trim() ? "0.8" : "0.25";
        }}
        title="Send (Enter)"
      >
        <BiSolidSend size={16} color={terminalCursor} />
      </div>
    </div>
    {previewImage && (
      <ImagePreviewModal
        dataUri={previewImage.dataUri}
        winPath={previewImage.winPath}
        onDelete={() => {
          setLocalImages((prev) => prev.filter((im) => im.winPath !== previewImage.winPath));
          setPreviewImage(null);
        }}
        onClose={() => setPreviewImage(null)}
      />
    )}
    {/* Right-click context menu for image thumbnails — portaled to body to avoid clipping */}
    {imgCtxMenu && (() => {
      const ctxImg = localImages.find((im) => im.id === imgCtxMenu.imgId);
      if (!ctxImg) return null;
      const items: { label: string; action: () => void; color?: string }[] = [
        {
          label: "Expand",
          action: () => {
            setPreviewImage({ dataUri: ctxImg.dataUri, winPath: ctxImg.winPath });
            setImgCtxMenu(null);
          },
        },
        {
          label: "Copy",
          action: () => {
            fetch(ctxImg.dataUri)
              .then((r) => r.blob())
              .then((blob) => navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]))
              .catch(() => {});
            setImgCtxMenu(null);
          },
        },
        {
          label: "Copy filepath",
          action: () => {
            navigator.clipboard.writeText(resolveImagePath(ctxImg.winPath)).catch(() => {});
            setImgCtxMenu(null);
          },
        },
        {
          label: "Attached to prompt",
          action: () => setImgCtxMenu(null),
          color: "var(--ezy-text-muted)",
        },
        {
          label: "Delete",
          action: () => {
            setLocalImages((prev) => prev.filter((im) => im.id !== ctxImg.id));
            setImgCtxMenu(null);
          },
          color: "#f87171",
        },
      ];
      return createPortal(
        <div
          style={{ position: "fixed", inset: 0, zIndex: 210 }}
          onClick={() => setImgCtxMenu(null)}
          onContextMenu={(e) => { e.preventDefault(); setImgCtxMenu(null); }}
        >
          <div
            style={{
              position: "absolute",
              top: Math.min(imgCtxMenu.y, window.innerHeight - 200),
              left: Math.min(imgCtxMenu.x, window.innerWidth - 170),
              backgroundColor: "var(--ezy-surface-raised)",
              border: "1px solid var(--ezy-border)",
              borderRadius: 6,
              padding: "4px 0",
              minWidth: 160,
              boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {items.map((item) => (
              <div
                key={item.label}
                onClick={item.action}
                style={{
                  padding: "6px 12px",
                  fontSize: 12,
                  color: item.color ?? "var(--ezy-text)",
                  cursor: "pointer",
                  transition: "background-color 80ms ease",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--ezy-surface)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
              >
                {item.label}
              </div>
            ))}
          </div>
        </div>,
        document.body,
      );
    })()}
    </>
  );
}
