import { useEffect, useRef, useCallback, useState, useMemo } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { getTheme, getEffectiveTerminalTheme } from "../lib/themes";
import { usePty } from "../hooks/usePty";
import { useAppStore } from "../store";
import { registerPtyWrite, unregisterPtyWrite, getTerminalDataListener } from "../store/terminalSlice";
import { useClipboardImageStore } from "../store/clipboardImageStore";
import type { TerminalType } from "../types";
import { DEFAULT_CLI_FONT_SIZE } from "../store/recentProjectsSlice";
import { CommandBlockParser, type CommandBlock } from "../lib/command-block-parser";
import { shouldInjectShellIntegration } from "../lib/shell-integration";
import { supportsSessionResume } from "../lib/session-resume";
import { createFilePathLinkProvider } from "../lib/file-link-provider";
import { readSessionContext, type ContextInfo } from "../lib/context-parser";
import { invoke } from "@tauri-apps/api/core";
import { toWslPath } from "../lib/terminal-config";
import { recordTerminalActivity, recordTerminalWrite, recordTerminalResize, clearTerminalActivity } from "../lib/terminal-activity";
import TerminalHeader from "./TerminalHeader";
import CommandBlockOverlay from "./CommandBlockOverlay";
import ClipboardImagePreview from "./ClipboardImagePreview";
import { useClipboardImagePaste } from "../hooks/useClipboardImagePaste";
import PromptComposer from "./PromptComposer";
import hackRegularUrl from "../fonts/hack-regular.woff2?url";
import hackBoldUrl from "../fonts/hack-bold.woff2?url";

// Track session IDs already claimed by panes in this app instance.
// Prevents multiple panes from claiming the same session file during disk lookup.
const claimedSessionIds = new Set<string>();

// Load Hack font via JS FontFace API — bypasses CSS @font-face which
// can fail silently in Tauri's WebView due to URL resolution issues.
let hackFontReady: Promise<void> | null = null;
function ensureHackFont(): Promise<void> {
  if (hackFontReady) return hackFontReady;
  const regular = new FontFace("Hack", `url(${hackRegularUrl})`, { weight: "400", style: "normal" });
  const bold = new FontFace("Hack", `url(${hackBoldUrl})`, { weight: "700", style: "normal" });
  document.fonts.add(regular);
  document.fonts.add(bold);
  hackFontReady = Promise.all([regular.load(), bold.load()]).then(() => {});
  return hackFontReady;
}

/** Terminal IDs that should suppress auto-focus on init (background open). */
export const suppressFocusTerminals = new Set<string>();

interface TerminalPaneProps {
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
  /** Per-tab backend override. Falls back to global setting if omitted. */
  backend?: import("../types").TerminalBackend;
}

export default function TerminalPane({
  terminalId,
  terminalType,
  workingDir,
  isActive,
  onClose,
  onChangeType,
  onFocus,
  onSwapPane,
  onExplainError,
  onPtyReady,
  onPtyExit,
  hideChrome,
  serverId,
  sessionResumeId,
  onSessionResumeId,
  paneCount = 1,
  backend,
}: TerminalPaneProps) {
  // Seed claimed set with persisted IDs so new panes don't steal them
  if (sessionResumeId) claimedSessionIds.add(sessionResumeId);
  const serverName = useAppStore((s) => {
    if (!serverId) return undefined;
    return s.servers.find((srv) => srv.id === serverId)?.name;
  });
  const themeId = useAppStore((s) => s.themeId);
  const vibrantColors = useAppStore((s) => s.vibrantColors);
  const theme = getTheme(themeId);
  const effectiveTerminalTheme = useMemo(() => getEffectiveTerminalTheme(themeId, vibrantColors), [themeId, vibrantColors]);
  const cliFontSize = useAppStore((s) => s.cliFontSizes[terminalType] ?? DEFAULT_CLI_FONT_SIZE);
  const copyOnSelect = useAppStore((s) => s.copyOnSelect);
  const copyOnSelectRef = useRef(copyOnSelect);
  useEffect(() => { copyOnSelectRef.current = copyOnSelect; }, [copyOnSelect]);
  const backendRef = useRef(backend);
  backendRef.current = backend;
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const focusRestorerRef = useRef<(() => void) | null>(null);
  // Consume suppressFocusTerminals synchronously on first render so the
  // value is available to PromptComposer's suppressAutoFocus prop BEFORE
  // any useEffects fire.  initTerminal (async) later sets up the DOM blocker.
  const focusSuppressedRef = useRef<boolean | null>(null);
  if (focusSuppressedRef.current === null) {
    focusSuppressedRef.current = suppressFocusTerminals.has(terminalId);
    if (focusSuppressedRef.current) {
      suppressFocusTerminals.delete(terminalId);
    }
  }
  const [launchedWithYolo, setLaunchedWithYolo] = useState(() => !!useAppStore.getState().cliYolo[terminalType]);
  const [restartKey, setRestartKey] = useState(0);
  const [exited, setExited] = useState(false);
  const [contextInfo, setContextInfo] = useState<ContextInfo | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const composerDidStealRef = useRef(false);
  const [commandBlocks, setCommandBlocks] = useState<CommandBlock[]>([]);
  const blockParserRef = useRef<CommandBlockParser | null>(null);
  const recordedBlocksRef = useRef<Set<string>>(new Set());
  const initialDims = useRef({ cols: 80, rows: 24 });
  const [termReady, setTermReady] = useState(false);
  const jumpBtnRef = useRef<HTMLDivElement>(null);
  const scrollToPromptRef = useRef<() => void>(() => {});
  const scrollToNextPromptRef = useRef<() => void>(() => {});
  const cleanupRef = useRef<(() => void) | null>(null);
  const paneCountRef = useRef(paneCount);
  paneCountRef.current = paneCount;
  const cliFontSizeRef = useRef(cliFontSize);
  cliFontSizeRef.current = cliFontSize;
  const useShellIntegration = shouldInjectShellIntegration(terminalType);

  // Session resume: look up session ID from Claude's local storage on disk
  const onSessionResumeIdRef = useRef(onSessionResumeId);
  onSessionResumeIdRef.current = onSessionResumeId;
  const terminalTypeRef = useRef(terminalType);
  terminalTypeRef.current = terminalType;
  const workingDirRef = useRef(workingDir);
  workingDirRef.current = workingDir;
  const sessionResumeIdPropRef = useRef(sessionResumeId);
  sessionResumeIdPropRef.current = sessionResumeId;
  const sessionLookupDone = useRef(false);
  // Tracks whether we're waiting for PTY data after a restart (hides composer until loaded)
  const awaitingRestartDataRef = useRef(false);

  const handlePtyData = useCallback((data: Uint8Array) => {
    terminalRef.current?.write(new Uint8Array(data));
    recordTerminalActivity(terminalId, terminalTypeRef.current, data.length);
    // Notify external data listeners (e.g. port detection for dev servers)
    getTerminalDataListener(terminalId)?.(data);

    // Re-open composer after restart once PTY has started producing output
    if (awaitingRestartDataRef.current) {
      awaitingRestartDataRef.current = false;
      const s = useAppStore.getState();
      if (s.promptComposerEnabled && s.promptComposerAlwaysVisible) {
        setComposerOpen(true);
      }
    }

    // On first data from a resumable CLI, look up session ID from disk after a short delay.
    // Skip if this pane already has a session ID (restored from persist).
    if (!sessionLookupDone.current && supportsSessionResume(terminalTypeRef.current) && !sessionResumeIdPropRef.current) {
      sessionLookupDone.current = true;

      const lookupSession = async (): Promise<boolean> => {
        try {
          const backend = backendRef.current ?? useAppStore.getState().terminalBackend ?? "wsl";
          const type = terminalTypeRef.current;
          const excludeIds = [...claimedSessionIds];
          let id: string | null = null;

          if (backend === "windows") {
            // Windows native: use native Windows path and Windows session commands
            const winCwd = workingDirRef.current;
            console.log(`[SessionResume] lookup for ${type} (windows), cwd="${winCwd}"`);
            if (!winCwd) { console.log(`[SessionResume] no cwd, skipping`); return false; }
            if (type === "claude") {
              id = await invoke<string | null>("get_claude_session_id_windows", { projectPath: winCwd, excludeIds });
            } else if (type === "codex") {
              id = await invoke<string | null>("get_codex_session_id_windows", { projectPath: winCwd, excludeIds });
            } else if (type === "gemini") {
              id = await invoke<string | null>("get_gemini_session_id_windows", { projectPath: winCwd, excludeIds });
            }
          } else {
            // WSL backend: convert path and use WSL commands
            const wslCwd = toWslPath(workingDirRef.current);
            console.log(`[SessionResume] lookup for ${type}, wslCwd="${wslCwd}", workingDir="${workingDirRef.current}"`);
            if (!wslCwd) { console.log(`[SessionResume] no wslCwd, skipping`); return false; }
            if (type === "claude") {
              id = await invoke<string | null>("get_claude_session_id", { projectPath: wslCwd, excludeIds });
            } else if (type === "codex") {
              id = await invoke<string | null>("get_codex_session_id", { projectPath: wslCwd, excludeIds });
            } else if (type === "gemini") {
              id = await invoke<string | null>("get_gemini_session_id", { projectPath: wslCwd, excludeIds });
            }
          }

          console.log(`[SessionResume] ${type} lookup result: id=${id}`);
          if (id) {
            claimedSessionIds.add(id);
            onSessionResumeIdRef.current?.(id);
            return true;
          }
        } catch (e) {
          console.error(`[SessionResume] disk lookup failed:`, e);
        }
        return false;
      };

      // First attempt after 5s, retry at 20s if session file wasn't created yet
      setTimeout(async () => {
        if (!(await lookupSession())) {
          setTimeout(lookupSession, 15000);
        }
      }, 5000);
    }
  }, []);

  const onPtyExitRef = useRef(onPtyExit);
  onPtyExitRef.current = onPtyExit;

  const handlePtyExit = useCallback((exitCode: number) => {
    setExited(true);
    clearTerminalActivity(terminalId);
    terminalRef.current?.write("\r\n\x1b[38;2;139;148;158m[Process exited]\x1b[0m\r\n");
    onPtyExitRef.current?.(exitCode);
  }, [terminalId]);

  const { write, resize, kill } = usePty({
    terminalType,
    terminalId,
    workingDir,
    cols: initialDims.current.cols,
    rows: initialDims.current.rows,
    onData: handlePtyData,
    onExit: handlePtyExit,
    serverId,
    sessionResumeId,
    injectShellIntegration: useShellIntegration,
    ready: termReady,
    restartKey,
    forceYolo: launchedWithYolo,
    backend,
  });

  // Initialize xterm.js (waits for Hack font to load — canvas renderer
  // only uses fonts available at init time, unlike DOM text which auto-swaps)
  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;

    // Ensure Hack font is loaded before creating the terminal.
    // Canvas/WebGL renderers snapshot the font at init — late-loading fonts are ignored.
    const container = containerRef.current;
    ensureHackFont()
      .catch(() => {}) // font load failed — proceed with fallback fonts
      .then(() => {
        if (cancelled || !container.isConnected) return;
        initTerminal(container);
      });

    function initTerminal(el: HTMLElement) {

    const manyPanes = paneCountRef.current > 6; // used for scrollback budget
    const baseFontSize = cliFontSizeRef.current;

    const term = new Terminal({
      theme: effectiveTerminalTheme,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 2,
      fontFamily: "Hack, monospace",
      fontSize: baseFontSize,
      fontWeight: "normal",
      fontWeightBold: "bold",
      lineHeight: 1.2,
      letterSpacing: 0, // Must stay 0 — any value >0 gaps box-drawing chars in ALL renderers (DOM, WebGL, Canvas)
      allowTransparency: true,
      allowProposedApi: true,
      scrollback: manyPanes ? 2000 : 10000,
      convertEol: true,
      minimumContrastRatio: 1,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    // File path link provider — Ctrl+Click to open in FileViewerPane
    const fileLinkDisposable = term.registerLinkProvider(
      createFilePathLinkProvider(term, workingDir)
    );

    let disposed = false;
    term.open(el);

    // When "Open panes in background" created this terminal, suppress ALL
    // focus attempts until the user explicitly activates this pane.
    //
    // Override the textarea's `focus` method at the DOM instance level.
    // This shadows HTMLElement.prototype.focus on this specific element,
    // blocking ALL focus regardless of source — xterm internal core calls,
    // browser auto-focus, tab navigation, everything. No event-listener
    // registration-order issues (capture-phase listeners on the target
    // element fire in registration order, not by phase — xterm registers
    // its listener in open() before us, so it would fire first).
    if (focusSuppressedRef.current) {
      const textarea = el.querySelector('textarea');
      if (textarea) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (textarea as any).focus = function () { /* blocked */ };
        focusRestorerRef.current = () => {
          // Remove instance override → prototype method is restored
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          delete (textarea as any).focus;
          focusSuppressedRef.current = false;
          focusRestorerRef.current = null;
        };
      }

      // Blur immediately in case open() or the browser already focused it
      term.blur();
    }

    term.onSelectionChange(() => {
      if (!copyOnSelectRef.current) return;
      const sel = term.getSelection();
      if (sel) navigator.clipboard.writeText(sel).catch(() => {});
    });

    // Unicode 11 for correct emoji widths — must load after open()
    try {
      const unicode11 = new Unicode11Addon();
      term.loadAddon(unicode11);
      term.unicode.activeVersion = "11";
    } catch {
      // Fall back to default unicode handling
    }

    fitAddon.fit();

    // Defer PTY-ready signal until layout has settled. The first fit() can
    // race with CSS grid distribution during session restore — measuring
    // before panels have final sizes yields tiny cols (e.g. 5). Double-rAF
    // waits one full layout+paint cycle; if cols are still unreasonably
    // small (container in transitional state), retry up to 10×100ms before
    // giving up. This prevents spawning PTYs at 5 cols which causes TUI
    // apps (Claude CLI) to render their welcome screen in a 5-char column.
    let readySignalled = false;
    let readyRetries = 0;
    const MAX_READY_RETRIES = 10; // 10 × 100ms = 1s max extra wait
    const MIN_READY_COLS = 20;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    function signalReady() {
      if (readySignalled || disposed) return;

      // Verify dimensions are reasonable — during session restore, CSS grid
      // may not have distributed final sizes yet, giving us tiny cols.
      // Retry a few times to wait for layout to settle.
      if (term.cols < MIN_READY_COLS && readyRetries < MAX_READY_RETRIES) {
        readyRetries++;
        retryTimer = setTimeout(() => {
          if (disposed) return;
          try {
            if (el.clientWidth > 0 && el.clientHeight > 0) {
              fitAddon.fit();
            }
          } catch { /* container may be detached */ }
          signalReady();
        }, 100);
        return;
      }

      readySignalled = true;
      initialDims.current = { cols: term.cols, rows: term.rows };
      setTermReady(true);
    }

    let settleRaf2 = 0;
    const settleRaf1 = requestAnimationFrame(() => {
      settleRaf2 = requestAnimationFrame(() => {
        try {
          if (!disposed && el.clientWidth > 0 && el.clientHeight > 0) {
            fitAddon.fit();
          }
        } catch { /* container may be detached */ }
        signalReady();
      });
    });
    // Safety net for late layout shifts (autoSaveId restoring panel sizes)
    const settleTimer = setTimeout(() => {
      try {
        if (!disposed && el.clientWidth > 0 && el.clientHeight > 0) {
          fitAddon.fit();
        }
      } catch { /* container may be detached */ }
      signalReady();
    }, 300);

    // Defer WebGL addon — GPU context init is expensive and blocks first paint.
    // Always try WebGL (DOM renderer applies letterSpacing as CSS letter-spacing,
    // creating 1px gaps between box-drawing chars → dashed appearance).
    // Stagger delay for many panes to reduce peak concurrent GPU context requests.
    // Chrome caps at ~16 WebGL contexts = MAX_PANES, so all panes should get one.
    // Try/catch handles failures gracefully (falls back to canvas/DOM renderer).
    const webglDelay = manyPanes ? 200 + Math.floor(Math.random() * 800) : 200;
    const webglTimer = setTimeout(() => {
      try {
        if (!disposed && el.offsetHeight) {
          const webgl = new WebglAddon();
          term.loadAddon(webgl);
          // Force WebGL to rebuild glyph atlas with the correct font
          term.options.fontFamily = "Hack, monospace";
          term.options.fontSize = baseFontSize;
          fitAddon.fit();
        }
      } catch {
        // Context limit exceeded — canvas/DOM renderer is the fallback
      }
    }, webglDelay);

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Register command block parser for shell terminals
    if (useShellIntegration) {
      const parser = new CommandBlockParser(term, setCommandBlocks);
      parser.register();
      blockParserRef.current = parser;
    }

    // Scroll-to-prompt — double-tap Up Arrow or PgUp jumps to the last prompt.
    // Repeated presses navigate backwards through earlier prompts.
    let lastUpArrowTime = 0;

    function scrollToPrompt() {
      const buf = term.buffer.active;
      const viewportTop = buf.viewportY;

      // Try command blocks first (shell integration provides precise prompt lines)
      const parser = blockParserRef.current;
      if (parser) {
        const blocks = parser.getBlocks();
        const completed = blocks.filter(b => b.exitCode !== null);
        if (completed.length > 0) {
          // Find the last prompt line above the current viewport top
          for (let i = completed.length - 1; i >= 0; i--) {
            if (completed[i].promptLine < viewportTop) {
              term.scrollToLine(completed[i].promptLine);
              return;
            }
          }
          // All prompts are at or below viewport — scroll to the last one
          term.scrollToLine(completed[completed.length - 1].promptLine);
          return;
        }
      }

      // Fallback: scan buffer backwards for prompt-like lines ($ , # , ❯ )
      const startLine = Math.max(0, viewportTop - 1);
      for (let i = startLine; i >= 0; i--) {
        const line = buf.getLine(i);
        if (!line) continue;
        const text = line.translateToString().trimEnd();
        if (/[$#❯]\s/.test(text)) {
          term.scrollToLine(i);
          return;
        }
      }
    }

    function scrollToNextPrompt() {
      const buf = term.buffer.active;
      const viewportTop = buf.viewportY;

      const parser = blockParserRef.current;
      if (parser) {
        const blocks = parser.getBlocks();
        const completed = blocks.filter(b => b.exitCode !== null);
        if (completed.length > 0) {
          // Find the first completed prompt below the current viewport
          // Use viewportTop + 2 to skip the prompt we're currently viewing
          const threshold = viewportTop + 2;
          for (let i = 0; i < completed.length; i++) {
            if (completed[i].promptLine >= threshold) {
              term.scrollToLine(completed[i].promptLine);
              return;
            }
          }
        }
      }

      // Fallback: scan buffer forwards for prompt-like lines
      const maxLine = buf.baseY + term.rows;
      for (let i = viewportTop + 2; i < maxLine; i++) {
        const line = buf.getLine(i);
        if (!line) continue;
        const text = line.translateToString().trimEnd();
        if (/[$#❯]\s/.test(text)) {
          term.scrollToLine(i);
          return;
        }
      }
      // No next prompt found — scroll to bottom
      term.scrollToBottom();
    }

    scrollToPromptRef.current = scrollToPrompt;
    scrollToNextPromptRef.current = scrollToNextPrompt;

    // IMG TAB autocomplete — type "img" then press TAB to insert [Img 1],
    // press TAB again to cycle through [Img 2], [Img 3].
    const imgRecentChars = { current: "" };
    const imgCycle = { current: null as { num: number } | null };

    // Inline ghost text — written directly to xterm via ANSI escape sequences.
    // We search the buffer for the trigger text ("im"/"img") because TUI apps
    // like Claude CLI hide the real cursor and draw their own, so cursorY is
    // unreliable for positioning.
    let hintTimer: ReturnType<typeof setTimeout> | undefined;
    let ghostInfo: { row: number; col: number; len: number } | null = null;

    function showInlineHint(text: string, trigger: string) {
      clearInlineHint();
      hintTimer = setTimeout(() => {
        if (disposed) return;
        const buf = term.buffer.active;
        // Search ALL buffer lines — TUI apps like Claude CLI render near the
        // top of the screen, so searching only the last N lines misses them.
        for (let i = buf.length - 1; i >= 0; i--) {
          const line = buf.getLine(i);
          if (!line) continue;
          const lineText = line.translateToString().trimEnd();
          if (lineText.toLowerCase().endsWith(trigger)) {
            const row = i - buf.baseY + 1;
            const col = lineText.length + 1;
            term.write(`\x1b7\x1b[${row};${col}H\x1b[90m${text}\x1b[0m\x1b8`);
            ghostInfo = { row, col, len: text.length };
            return;
          }
        }
      }, 300);
    }

    function clearInlineHint() {
      clearTimeout(hintTimer);
      if (ghostInfo) {
        const { row, col, len } = ghostInfo;
        // Save cursor, move to ghost position, overwrite with spaces, restore
        term.write(`\x1b7\x1b[${row};${col}H${" ".repeat(len)}\x1b8`);
        ghostInfo = null;
      }
    }

    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== "keydown") return true;

      // Ctrl+I — toggle prompt composer
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && (e.key === "i" || e.key === "I")) {
        const enabled = useAppStore.getState().promptComposerEnabled;
        if (enabled) {
          setComposerOpen((v) => {
            composerDismissedRef.current = v; // closing → dismissed; opening → clear
            return !v;
          });
          return false;
        }
      }

      // Windows Terminal keybindings
      if (e.key === "End" && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        term.scrollToBottom();
        return false;
      }
      if (e.key === "Home" && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        term.scrollToTop();
        return false;
      }
      if (e.key === "ArrowUp" && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
        term.scrollLines(-1);
        return false;
      }
      if (e.key === "ArrowDown" && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
        term.scrollLines(1);
        return false;
      }
      if (e.key === "Backspace" && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        write("\x1b\x7f"); // backward-kill-word (same as Alt+Backspace)
        return false;
      }
      if (e.key === "Delete" && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        write("\x1b[3;3~"); // kill-word forward (same as Alt+Delete)
        return false;
      }

      // Scroll-to-prompt: PgUp/PgDn jump between prompts, double-tap Up Arrow
      if (!e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        if (e.key === "PageUp") {
          scrollToPrompt();
          return false;
        }
        if (e.key === "PageDown") {
          scrollToNextPrompt();
          return false;
        }
        if (e.key === "ArrowUp") {
          const now = Date.now();
          if (now - lastUpArrowTime < 350) {
            lastUpArrowTime = 0;
            scrollToPrompt();
            return false;
          }
          lastUpArrowTime = now;
        }
      }

      // TAB without modifiers — check for img autocomplete
      if (e.key === "Tab" && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        const clipStore = useClipboardImageStore.getState();
        const imageCount = Math.min(clipStore.images.length, 3);

        if (imgCycle.current && imageCount > 0) {
          // Cycling — erase current label, insert next
          e.preventDefault();
          const prevLabel = `[Img ${imgCycle.current.num}]`;
          const nextNum = (imgCycle.current.num % imageCount) + 1;
          const nextLabel = `[Img ${nextNum}]`;
          imgCycle.current = { num: nextNum };
          clipStore.setLastInsertion({ text: nextLabel, terminalId, timestamp: Date.now() });
          clearInlineHint();
          // Defer write — synchronous invoke during xterm key processing can be swallowed
          setTimeout(() => {
            write("\x7f".repeat(prevLabel.length));
            setTimeout(() => write(nextLabel), 5);
          }, 0);
          return false;
        }

        if (imgRecentChars.current.toLowerCase().endsWith("img") && imageCount > 0) {
          // First TAB — erase "img", insert [Img 1]
          e.preventDefault();
          const label = "[Img 1]";
          imgRecentChars.current = "";
          imgCycle.current = { num: 1 };
          clipStore.setLastInsertion({ text: label, terminalId, timestamp: Date.now() });
          clearInlineHint();
          // Defer write — synchronous invoke during xterm key processing can be swallowed
          setTimeout(() => {
            write("\x7f".repeat(3));
            setTimeout(() => write(label), 5);
          }, 0);
          return false;
        }

        if (imgRecentChars.current.toLowerCase().endsWith("im") && imageCount > 0) {
          // First TAB from "im" — erase "im", insert [Img 1]
          e.preventDefault();
          const label = "[Img 1]";
          imgRecentChars.current = "";
          imgCycle.current = { num: 1 };
          clipStore.setLastInsertion({ text: label, terminalId, timestamp: Date.now() });
          clearInlineHint();
          setTimeout(() => {
            write("\x7f".repeat(2));
            setTimeout(() => write(label), 5);
          }, 0);
          return false;
        }

        clearInlineHint();
        return true; // Let shell handle normal TAB completion
      }

      // Mark real user keystrokes for activity tracking (not TUI control sequences)
      if (!e.ctrlKey && !e.altKey && !e.metaKey && (e.key.length === 1 || e.key === "Enter" || e.key === "Backspace")) {
        recordTerminalWrite(terminalId);
      }

      // Track typed characters for autocomplete detection
      if (!e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.key.length === 1) {
          imgRecentChars.current = (imgRecentChars.current + e.key).slice(-3);
          imgCycle.current = null;

          // Show inline ghost text for partial/full "img" match
          const clipStore = useClipboardImageStore.getState();
          const imageCount = Math.min(clipStore.images.length, 3);
          const buf = imgRecentChars.current.toLowerCase();
          if (buf === "img" && imageCount > 0) {
            showInlineHint(" 1]", "img");
          } else if (buf.endsWith("im") && imageCount > 0) {
            showInlineHint("g 1]", "im");
          } else {
            clearInlineHint();
          }
        } else if (e.key === "Backspace") {
          imgRecentChars.current = imgRecentChars.current.slice(0, -1);
          imgCycle.current = null;
          clearInlineHint();
        } else if (!["Shift", "CapsLock"].includes(e.key)) {
          imgRecentChars.current = "";
          imgCycle.current = null;
          clearInlineHint();
        }
      }

      return true; // Let xterm handle all other keys
    });

    // Wire terminal input to PTY
    const dataDisposable = term.onData((data) => {
      if (!exited) write(data);
    });

    const resizeDisposable = term.onResize((e) => {
      recordTerminalResize(terminalId);
      resize(e.cols, e.rows);
    });

    // Debounced ResizeObserver for auto-fit + dynamic font scaling.
    // Without debounce, N panes × 60fps = N×60 fit() calls/sec during window resize,
    // each doing synchronous DOM measurement + PTY resize IPC → blocks main thread.
    // 100ms debounce: fit() fires once after resize stops. Zero work during drag.
    let fitTimer: ReturnType<typeof setTimeout> | undefined;
    let currentFontSize = baseFontSize;
    let lastWidth = el.clientWidth;
    let lastHeight = el.clientHeight;
    function doFit() {
      try {
        if (el.clientWidth === 0 || el.clientHeight === 0) return;
        const w = el.clientWidth;
        const targetSize = w < 300 ? Math.max(baseFontSize - 3, 10) : w < 450 ? Math.max(baseFontSize - 2, 11) : w < 600 ? Math.max(baseFontSize - 1, 12) : baseFontSize;
        if (targetSize !== currentFontSize) {
          currentFontSize = targetSize;
          term.options.fontSize = targetSize;
        }
        // Preserve scroll position across fit — layout changes (e.g. browser
        // preview toggle) resize the container, and fit() can reset viewport.
        const buf = term.buffer.active;
        const wasAtBottom = buf.viewportY >= buf.baseY;
        const savedViewport = buf.viewportY;
        fitAddon.fit();
        if (wasAtBottom) {
          term.scrollToBottom();
        } else {
          const target = Math.min(savedViewport, buf.baseY);
          term.scrollToLine(target);
        }
        lastWidth = el.clientWidth;
        lastHeight = el.clientHeight;
      } catch {
        // Container may be detached
      }
    }
    const observer = new ResizeObserver(() => {
      clearTimeout(fitTimer);
      // Large jump (pane added/removed) → fit immediately to prevent scroll drift.
      // Small incremental changes (window drag) → debounce.
      const dw = Math.abs(el.clientWidth - lastWidth);
      const dh = Math.abs(el.clientHeight - lastHeight);
      if (dw > 50 || dh > 50) {
        doFit();
      } else {
        fitTimer = setTimeout(doFit, 100);
      }
    });
    observer.observe(el);

    // "Jump to bottom" button — positioned below the scrollbar thumb when scrolled up
    function updateJumpBtn() {
      const btn = jumpBtnRef.current;
      if (!btn) return;
      const buf = term.buffer.active;
      if (buf.viewportY >= buf.baseY) {
        btn.style.display = "none";
      } else {
        const totalLines = buf.baseY + term.rows;
        const thumbBottom = (buf.viewportY + term.rows) / totalLines;
        const containerH = el.clientHeight;
        const y = Math.min(Math.round(thumbBottom * containerH) + 6, containerH - 28);
        btn.style.display = "flex";
        btn.style.top = `${y}px`;
      }
    }
    const scrollDisposable = term.onScroll(updateJumpBtn);
    const renderDisposable = term.onRender(updateJumpBtn);

    cleanupRef.current = () => {
      disposed = true;
      clearInlineHint();
      clearTimeout(webglTimer);
      cancelAnimationFrame(settleRaf1);
      cancelAnimationFrame(settleRaf2);
      clearTimeout(settleTimer);
      clearTimeout(retryTimer);
      clearTimeout(fitTimer);
      observer.disconnect();
      fileLinkDisposable.dispose();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      scrollDisposable.dispose();
      renderDisposable.dispose();
      blockParserRef.current?.dispose();
      blockParserRef.current = null;
      clearTerminalActivity(terminalId);
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
    } // end initTerminal

    return () => {
      cancelled = true;
      cleanupRef.current?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId]);

  // Register PTY write callback for external access (AI explain, snippets)
  useEffect(() => {
    registerPtyWrite(terminalId, write);
    onPtyReady?.();
    return () => unregisterPtyWrite(terminalId);
  }, [terminalId, write]); // onPtyReady intentionally omitted — fire once on PTY init

  // Feed completed command blocks into history store
  useEffect(() => {
    const addHistoryEntry = useAppStore.getState().addHistoryEntry;
    const tabs = useAppStore.getState().tabs;
    const tab = tabs.find((t) =>
      t.layout.type === "terminal" ? t.layout.terminalId === terminalId : false
    );
    const tabName = tab?.name ?? "Shell";

    for (const block of commandBlocks) {
      if (block.exitCode !== null && !recordedBlocksRef.current.has(block.id)) {
        recordedBlocksRef.current.add(block.id);
        addHistoryEntry({
          command: block.command,
          exitCode: block.exitCode,
          timestamp: block.timestamp,
          endTimestamp: block.endTimestamp,
          workingDir,
          terminalId,
          tabName,
        });
      }
    }
  }, [commandBlocks, terminalId, workingDir]);

  // Clear terminal when CLI type changes (PTY restarts via usePty)
  const prevTypeRef = useRef(terminalType);
  useEffect(() => {
    if (prevTypeRef.current !== terminalType) {
      prevTypeRef.current = terminalType;
      if (terminalRef.current) {
        terminalRef.current.clear();
        terminalRef.current.reset();
      }
      setExited(false);
      setContextInfo(null);
      setCommandBlocks([]);
      sessionLookupDone.current = false;
    }
  }, [terminalType]);

  // Periodically read context percentage from CLI session JSONL files.
  // Starts immediately — backend searches all recent sessions when no
  // specific session ID is available yet. Once sessionResumeId is
  // discovered, polls switch to the specific session for precise data.
  useEffect(() => {
    const supported = terminalType === "claude" || terminalType === "codex" || terminalType === "gemini";
    if (!supported) return;

    const poll = async () => {
      const backend = backendRef.current ?? useAppStore.getState().terminalBackend ?? "wsl";
      const info = await readSessionContext(terminalType, sessionResumeId || undefined, backend);
      if (info !== null) {
        // Merge partial updates — rate_limits and info come from different
        // server events. Keep previous rate_limits when new poll has none.
        setContextInfo((prev) => ({
          ...info,
          rateLimitFiveHour: info.rateLimitFiveHour ?? prev?.rateLimitFiveHour ?? null,
          rateLimitWeekly: info.rateLimitWeekly ?? prev?.rateLimitWeekly ?? null,
        }));
      }
      // On null, retain previous value (stale > absent)
    };

    // Short delay (2s) for WSL to be ready on cold start, then poll every 5s.
    // If data isn't available yet, null is returned and we retain the previous value.
    const startTimer = setTimeout(() => {
      poll();
      intervalId = setInterval(poll, 5000);
    }, 2000);
    let intervalId: ReturnType<typeof setInterval> | undefined;

    return () => {
      clearTimeout(startTimer);
      if (intervalId) clearInterval(intervalId);
    };
  }, [terminalType, sessionResumeId]);

  // Composer settings — declared early because isActive effect references them.
  const composerAlwaysVisible = useAppStore((s) => s.promptComposerEnabled && s.promptComposerAlwaysVisible);
  const composerDismissedRef = useRef(false);

  // Focus the active pane — also removes the DOM focus blocker if it was
  // installed by the "open in background" feature, and opens the deferred
  // composer (was skipped to prevent focus steal on background open).
  useEffect(() => {
    if (isActive) {
      focusRestorerRef.current?.();
      terminalRef.current?.focus();
      // Open composer now that the pane is active (deferred from background open)
      if (composerAlwaysVisible && !composerDismissedRef.current && !composerOpen) {
        setComposerOpen(true);
      }
    }
  }, [isActive, composerAlwaysVisible, composerOpen]);

  // Force repaint when container becomes visible (tab switch).
  // xterm.js doesn't render while display:none — IntersectionObserver
  // detects visibility changes and triggers a refresh.
  // Does NOT call fit() — the ResizeObserver already handles that.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && terminalRef.current) {
          // Set resize lockout BEFORE any reflow output arrives — prevents
          // idle AI panes from briefly showing as "active" on tab switch.
          // This covers the case where terminal dimensions didn't change
          // (same window size) so term.onResize never fires.
          recordTerminalResize(terminalId);
          terminalRef.current.refresh(0, terminalRef.current.rows - 1);
        }
      },
      { threshold: 0.01 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [terminalId]);

  // Repaint after window minimize → restore (or alt-tab back).
  // WebGL renderer loses its context while the document is hidden;
  // neither ResizeObserver nor IntersectionObserver fire on restore
  // because the element size and intersection haven't changed.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const term = terminalRef.current;
      const fit = fitAddonRef.current;
      if (!term) return;
      term.refresh(0, term.rows - 1);
      if (fit) {
        try { fit.fit(); } catch { /* container may be detached */ }
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // Auto-open composer when "always visible" is enabled.
  useEffect(() => {
    // Don't open composer when pane was opened in background — its many
    // focus paths (onRender position changes, hidden→visible transitions)
    // would steal focus from the original pane.  Deferred until isActive.
    if (composerAlwaysVisible && !composerDismissedRef.current && !focusSuppressedRef.current) {
      setComposerOpen(true);
    }
  }, [composerAlwaysVisible]);

  // Theme hot-swap
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = effectiveTerminalTheme;
    }
  }, [effectiveTerminalTheme]);

  // Live font-size update when user changes CLI font size in settings
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.fontSize = cliFontSize;
      fitAddonRef.current?.fit();
    }
  }, [cliFontSize]);

  const handleToggleCollapse = useCallback((blockId: string) => {
    blockParserRef.current?.toggleCollapse(blockId);
  }, []);

  // Clipboard image paste detection
  const { pastedImage, dismissPreview } = useClipboardImagePaste({
    containerRef,
    terminalRef,
    terminalType,
    terminalId,
    write,
    exited,
  });

  // Auto-dismiss image preview after 8 seconds
  useEffect(() => {
    if (!pastedImage) return;
    const timer = setTimeout(dismissPreview, 8000);
    return () => clearTimeout(timer);
  }, [pastedImage, dismissPreview]);

  const handleComposerSubmit = useCallback((text: string) => {
    // Codex/Gemini TUI editors process keystrokes asynchronously — sending text+\r
    // in one write causes \r to arrive before the editor finishes ingesting text.
    // Split into text first, then Enter after a delay.
    const needsDelayedEnter = terminalType === "codex" || terminalType === "gemini";

    if (text.includes("\n")) {
      // Multi-line: use bracketed paste so the CLI treats it as one input,
      // then send Enter after a short delay (immediate \r gets swallowed)
      write("\x1b[200~" + text + "\x1b[201~");
      setTimeout(() => write("\r"), 50);
    } else if (needsDelayedEnter) {
      write(text + (terminalType === "gemini" ? " " : ""));
      setTimeout(() => write("\r"), 80);
    } else {
      // Single-line: write directly (no bracketed paste needed)
      write(text + "\r");
    }
    // Don't steal focus from textarea when always-visible — the composer handles its own focus
    const alwaysOn = useAppStore.getState().promptComposerEnabled && useAppStore.getState().promptComposerAlwaysVisible;
    if (!alwaysOn) {
      terminalRef.current?.focus();
    }
  }, [write, terminalType]);

  const handleComposerClose = useCallback(() => {
    composerDismissedRef.current = true;
    setComposerOpen(false);
    terminalRef.current?.focus();
  }, []);

  const handleRestart = useCallback(() => {
    if (terminalRef.current) {
      terminalRef.current.clear();
      terminalRef.current.reset();
    }
    // Capture current YOLO state at restart time — updates badge + forceYolo for spawn
    setLaunchedWithYolo(!!useAppStore.getState().cliYolo[terminalType]);
    setExited(false);
    setContextInfo(null);
    setCommandBlocks([]);
    // Hide composer until PTY produces output again
    awaitingRestartDataRef.current = true;
    setComposerOpen(false);
    // Only re-enable session lookup if we don't already have a session ID.
    // If we DO have one, keep it — restart should use the SAME session, not find a new one.
    if (!sessionResumeIdPropRef.current) {
      sessionLookupDone.current = false;
    }
    setRestartKey((k) => k + 1);
  }, [terminalType]);

  const handleClose = useCallback(() => {
    kill();
    onClose();
  }, [kill, onClose]);

  return (
    <div
      className={`terminal-pane flex flex-col h-full w-full ${isActive ? "pane-active" : ""}`}
      style={{ backgroundColor: "var(--ezy-bg)" }}
      data-terminal-id={terminalId}
      onClick={onFocus}
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
          serverName={serverName}
          isYolo={launchedWithYolo}
          contextInfo={contextInfo}
          workingDir={workingDir}
        />
      )}
      <div className="flex-1 min-h-0 relative" style={{ backgroundColor: "var(--ezy-bg)" }}>
        <div
          ref={containerRef}
          className="h-full w-full"
        />
        {useShellIntegration && (
          <CommandBlockOverlay
            terminal={terminalRef.current}
            blocks={commandBlocks}
            onToggleCollapse={handleToggleCollapse}
            onExplainError={onExplainError}
          />
        )}
        {pastedImage && (
          <ClipboardImagePreview
            thumbnailUrl={pastedImage.thumbnailUrl}
            filePath={pastedImage.filePath}
            onDismiss={dismissPreview}
          />
        )}
        {composerOpen && !hideChrome && (
          <PromptComposer
            onSubmit={handleComposerSubmit}
            onClose={handleComposerClose}
            write={write}
            alwaysVisible={composerAlwaysVisible}
            terminalBg={theme.terminal.background ?? "#0d1117"}
            terminalFg={theme.terminal.foreground ?? "#e6edf3"}
            terminalCursor={theme.terminal.cursor ?? "#58a6ff"}
            fontSize={cliFontSize}
            containerRef={containerRef}
            terminal={terminalRef.current}
            terminalId={terminalId}
            terminalType={terminalType}
            workingDir={workingDir}
            scrollToPrompt={() => scrollToPromptRef.current()}
            scrollToNextPrompt={() => scrollToNextPromptRef.current()}
            didStealRef={composerDidStealRef}
            suppressAutoFocus={!!focusSuppressedRef.current}
          />
        )}
        {/* Jump-to-bottom button — appears below scrollbar thumb when scrolled up */}
        <div
          ref={jumpBtnRef}
          style={{
            display: "none",
            position: "absolute",
            right: 4,
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
          onClick={() => terminalRef.current?.scrollToBottom()}
          title="Jump to bottom"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="2,3 6,7 10,3" />
            <line x1="3" y1="9.5" x2="9" y2="9.5" />
          </svg>
        </div>
      </div>
    </div>
  );
}
