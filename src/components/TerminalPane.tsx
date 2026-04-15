import { useEffect, useRef, useCallback, useState, useMemo } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SearchAddon } from "@xterm/addon-search";
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
import { readSessionsIndex, resolveSessionName } from "../lib/sessions-index";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toWslPath } from "../lib/terminal-config";
import { recordTerminalActivity, recordTerminalWrite, recordTerminalResize, clearTerminalActivity } from "../lib/terminal-activity";
import TerminalHeader from "./TerminalHeader";
import CommandBlockOverlay from "./CommandBlockOverlay";
import ClipboardImagePreview from "./ClipboardImagePreview";
import { useClipboardImagePaste } from "../hooks/useClipboardImagePaste";
import PromptComposer from "./PromptComposer";
import TerminalSearchBar from "./TerminalSearchBar";
import hackRegularUrl from "../fonts/hack-regular.woff2?url";
import hackBoldUrl from "../fonts/hack-bold.woff2?url";

// Track session IDs already claimed by panes in this app instance.
// Prevents multiple panes from claiming the same session file during disk lookup.
const claimedSessionIds = new Set<string>();

/** Atomically claim a session ID. Returns true if this caller won the claim. */
function claimSessionId(id: string): boolean {
  if (claimedSessionIds.has(id)) return false;
  claimedSessionIds.add(id);
  return true;
}

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
  onSwitchSession?: (newSessionId: string | undefined) => void;
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
  onSwitchSession,
  paneCount = 1,
  backend,
}: TerminalPaneProps) {
  // Seed claimed set with persisted IDs so new panes don't steal them
  if (sessionResumeId) claimedSessionIds.add(sessionResumeId);

  // Track whether the session came from a trusted source (props/restore or explicit switch)
  // vs detected from disk (may claim old/wrong session). Untrusted sessions don't show names.
  const [sessionTrusted, setSessionTrusted] = useState(!!sessionResumeId);

  // Register persisted session in per-project registry (deferred to avoid setState during render)
  const registeredRef = useRef<string | null>(null);
  useEffect(() => {
    if (sessionResumeId && registeredRef.current !== sessionResumeId) {
      registeredRef.current = sessionResumeId;
      useAppStore.getState().registerProjectSession(workingDir, {
        id: sessionResumeId,
        name: "",
        type: terminalType,
        createdAt: Date.now(),
        isRenamed: false,
      });
    }
  }, [sessionResumeId, workingDir, terminalType]);
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
  const [zoomIndicator, setZoomIndicator] = useState<number | null>(null);
  const zoomIndicatorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const jumpBtnRef = useRef<HTMLDivElement>(null);
  const scrollToPromptRef = useRef<() => void>(() => {});
  const scrollToNextPromptRef = useRef<() => void>(() => {});
  // Track prompts submitted via PromptComposer with their buffer line + timestamp
  const promptTimestampsRef = useRef<{ text: string; line: number; timestamp: number }[]>([]);
  // Saved scroll position — continuously updated by onScroll so the value is always
  // current BEFORE display:none / DOM detach / fit() can reset the xterm viewport to 0.
  const savedViewportYRef = useRef<number | null>(null);
  const wasAtBottomRef = useRef(true);
  // When true, the scroll guard in onScroll is bypassed (used by intentional scrolls
  // like Ctrl+Home or prompt navigation that legitimately go to low viewport positions).
  const scrollGuardActiveRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  const paneCountRef = useRef(paneCount);
  paneCountRef.current = paneCount;
  const cliFontSizeRef = useRef(cliFontSize);
  cliFontSizeRef.current = cliFontSize;
  const useShellIntegration = shouldInjectShellIntegration(terminalType);
  // EzyComposer is only for AI CLI terminals — not plain shell or devserver
  const composerSupported = terminalType !== "shell" && terminalType !== "devserver";
  const composerSupportedRef = useRef(composerSupported);
  composerSupportedRef.current = composerSupported;

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

  // --- Write-batching: coalesce PTY data chunks and flush once per animation frame ---
  const pendingChunksRef = useRef<Uint8Array[]>([]);
  const pendingBytesRef = useRef(0);
  const batchRafRef = useRef(0);

  const flushPtyBatch = useCallback(() => {
    batchRafRef.current = 0;
    const term = terminalRef.current;
    const chunks = pendingChunksRef.current;
    const totalBytes = pendingBytesRef.current;
    if (!term || chunks.length === 0) return;

    // Concatenate all pending chunks into a single write
    if (chunks.length === 1) {
      term.write(chunks[0]);
    } else {
      const merged = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      term.write(merged);
    }
    pendingChunksRef.current = [];
    pendingBytesRef.current = 0;

    // Batch activity recording per flush instead of per chunk
    recordTerminalActivity(terminalId, terminalTypeRef.current, totalBytes);
  }, [terminalId]);

  const handlePtyData = useCallback((data: Uint8Array) => {
    // Queue data for batched write on next animation frame
    pendingChunksRef.current.push(new Uint8Array(data));
    pendingBytesRef.current += data.length;
    if (!batchRafRef.current) {
      batchRafRef.current = requestAnimationFrame(flushPtyBatch);
    }

    // These side-effects must stay immediate (per-chunk):
    // Notify external data listeners (e.g. port detection for dev servers)
    getTerminalDataListener(terminalId)?.(data);

    // Re-open composer after restart once PTY has started producing output
    if (awaitingRestartDataRef.current) {
      awaitingRestartDataRef.current = false;
      const s = useAppStore.getState();
      if (composerSupported && s.promptComposerEnabled && s.promptComposerAlwaysVisible) {
        setComposerOpen(true);
      }
    }

    // On first data from a resumable CLI, look up session ID from disk after a short delay.
    // Skip if this pane already has a session ID (restored from persist).
    if (!sessionLookupDone.current && supportsSessionResume(terminalTypeRef.current) && !sessionResumeIdPropRef.current) {
      sessionLookupDone.current = true;

      // Track IDs that failed atomic claim (another pane claimed between invoke and claim).
      // Added to excludeIds on retries so the backend returns different results.
      const skippedIds = new Set<string>();

      const lookupSession = async (): Promise<boolean> => {
        try {
          const backend = backendRef.current ?? useAppStore.getState().terminalBackend ?? "wsl";
          const type = terminalTypeRef.current;
          const excludeIds = [...claimedSessionIds, ...skippedIds];
          let id: string | null = null;

          // For Claude, only claim sessions modified within the last 2 minutes.
          // This prevents new panes from picking up old sessions (whose cost
          // would be incorrectly shown as this pane's cost).
          const claudeMaxAge = type === "claude" ? 120 : undefined;

          if (backend === "native") {
            // macOS/Linux native: use native paths and native session commands
            const nativeCwd = workingDirRef.current;
            console.log(`[SessionResume] lookup for ${type} (native), cwd="${nativeCwd}"`);
            if (!nativeCwd) { console.log(`[SessionResume] no cwd, skipping`); return false; }
            if (type === "claude") {
              id = await invoke<string | null>("get_claude_session_id_native", { projectPath: nativeCwd, excludeIds, maxAgeSecs: claudeMaxAge });
            } else if (type === "codex") {
              id = await invoke<string | null>("get_codex_session_id_native", { projectPath: nativeCwd, excludeIds });
            } else if (type === "gemini") {
              id = await invoke<string | null>("get_gemini_session_id_native", { projectPath: nativeCwd, excludeIds });
            }
          } else if (backend === "windows") {
            // Windows native: use native Windows path and Windows session commands
            const winCwd = workingDirRef.current;
            console.log(`[SessionResume] lookup for ${type} (windows), cwd="${winCwd}"`);
            if (!winCwd) { console.log(`[SessionResume] no cwd, skipping`); return false; }
            if (type === "claude") {
              id = await invoke<string | null>("get_claude_session_id_windows", { projectPath: winCwd, excludeIds, maxAgeSecs: claudeMaxAge });
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
              id = await invoke<string | null>("get_claude_session_id", { projectPath: wslCwd, excludeIds, maxAgeSecs: claudeMaxAge });
            } else if (type === "codex") {
              id = await invoke<string | null>("get_codex_session_id", { projectPath: wslCwd, excludeIds });
            } else if (type === "gemini") {
              id = await invoke<string | null>("get_gemini_session_id", { projectPath: wslCwd, excludeIds });
            }
          }

          console.log(`[SessionResume] ${type} lookup result: id=${id}`);
          if (id) {
            // Atomic claim: if another pane already claimed this ID between
            // our invoke() and now, back off and retry with a different ID.
            // (claimedSessionIds + maxAgeSecs are sufficient to prevent
            // cross-pane theft and stale session claims — no need to also
            // check projectSessions, which persists across app restarts and
            // blocks reclaiming sessions that Claude CLI reuses.)
            if (!claimSessionId(id)) {
              console.log(`[SessionResume] ${id.slice(0, 8)} already claimed by another pane`);
              skippedIds.add(id);
              return false;
            }
            setSessionTrusted(true);
            // Eagerly update ref so handleRestart sees the new ID
            // even before React re-renders with the updated prop.
            sessionResumeIdPropRef.current = id;
            onSessionResumeIdRef.current?.(id);
            return true;
          }
        } catch (e) {
          console.error(`[SessionResume] disk lookup failed:`, e);
        }
        return false;
      };

      // First attempt after 5s, retry at 20s, final attempt at 60s.
      // The recency filter (120s) prevents claiming old sessions, so retries
      // give the new session time to create its JSONL file.
      setTimeout(async () => {
        if (!(await lookupSession())) {
          setTimeout(async () => {
            if (!(await lookupSession())) {
              setTimeout(lookupSession, 40000);
            }
          }, 15000);
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

    function showZoomIndicator(size: number) {
      clearTimeout(zoomIndicatorTimer.current);
      setZoomIndicator(size);
      zoomIndicatorTimer.current = setTimeout(() => setZoomIndicator(null), 1200);
    }

    const manyPanes = paneCountRef.current > 6; // used for WebGL stagger delay
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
      scrollback: paneCount <= 3 ? 10000 : paneCount <= 6 ? 5000 : paneCount <= 9 ? 3000 : 1500,
      convertEol: true,
      minimumContrastRatio: 1,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon((_event, uri) => {
      // Open URLs in the system default browser via Tauri's opener plugin.
      // The default handler uses window.open() which is blocked in Tauri's WebView.
      openUrl(uri).catch(() => {});
    }));

    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    searchAddonRef.current = searchAddon;

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
          const buf = term.buffer.active;
          const wasAtBottom = buf.baseY - buf.viewportY <= 3;
          const savedViewport = buf.viewportY;
          const webgl = new WebglAddon();
          term.loadAddon(webgl);
          // Force WebGL to rebuild glyph atlas with the correct font
          term.options.fontFamily = "Hack, monospace";
          term.options.fontSize = baseFontSize;
          fitAddon.fit();
          if (wasAtBottom) {
            term.scrollToBottom();
          } else {
            term.scrollToLine(Math.min(savedViewport, buf.baseY));
          }
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

    // Scroll-to-prompt — PgUp jumps to the last prompt.
    // Repeated presses navigate backwards through earlier prompts.

    // Clear the scroll guard and sync tracked position to where the terminal
    // actually is. Must be called in a rAF so xterm has settled.
    function clearScrollGuard() {
      requestAnimationFrame(() => {
        try {
          const buf = term.buffer.active;
          savedViewportYRef.current = buf.viewportY;
          wasAtBottomRef.current = buf.baseY - buf.viewportY <= 3;
        } catch { /* disposed */ }
        scrollGuardActiveRef.current = false;
      });
    }

    function scrollToPrompt() {
      scrollGuardActiveRef.current = true;
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
              clearScrollGuard();
              return;
            }
          }
          // All prompts are at or below viewport — scroll to the last one
          term.scrollToLine(completed[completed.length - 1].promptLine);
          clearScrollGuard();
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
          clearScrollGuard();
          return;
        }
      }
      scrollGuardActiveRef.current = false;
    }

    function scrollToNextPrompt() {
      scrollGuardActiveRef.current = true;
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
              clearScrollGuard();
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
          clearScrollGuard();
          return;
        }
      }
      // No next prompt found — scroll to bottom
      term.scrollToBottom();
      clearScrollGuard();
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

      // Ctrl+I — toggle prompt composer (AI terminals only)
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && (e.key === "i" || e.key === "I")) {
        const enabled = useAppStore.getState().promptComposerEnabled;
        if (enabled && composerSupportedRef.current) {
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
        scrollGuardActiveRef.current = true;
        term.scrollToTop();
        clearScrollGuard();
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

      // Ctrl+0 — reset font size to default
      if (e.key === "0" && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        const store = useAppStore.getState();
        store.setCliFontSize(terminalTypeRef.current, DEFAULT_CLI_FONT_SIZE);
        showZoomIndicator(DEFAULT_CLI_FONT_SIZE);
        return false;
      }

      // Scroll-to-prompt: PgUp/PgDn jump between prompts
      if (!e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        if (e.key === "PageUp") {
          scrollToPrompt();
          return false;
        }
        if (e.key === "PageDown") {
          scrollToNextPrompt();
          return false;
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

      // Ctrl+F — open search bar
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && (e.key === "f" || e.key === "F")) {
        setSearchOpen(true);
        return false;
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
    // Persistent scroll state across a resize sequence — when doFit() is called
    // multiple times in quick succession (ResizeObserver fires multiple times during
    // layout changes), the viewport position captured by the FIRST call is the only
    // reliable one. Subsequent calls may read a stale/reset viewport (WebGL renderer
    // can asynchronously reset viewportY between calls). By locking the scroll state
    // on the first call and only clearing it after the final deferred restore, we
    // guarantee the user's scroll position survives the entire resize sequence.
    let resizeLocked = false;
    let resizeWasAtBottom = false;
    let resizeSavedViewport = 0;
    let resizeRafId1 = 0;
    let resizeRafId2 = 0;
    function doFit() {
      try {
        if (el.clientWidth === 0 || el.clientHeight === 0) return;
        const w = el.clientWidth;
        const targetSize = w < 300 ? Math.max(baseFontSize - 3, 10) : w < 450 ? Math.max(baseFontSize - 2, 11) : w < 600 ? Math.max(baseFontSize - 1, 12) : baseFontSize;
        if (targetSize !== currentFontSize) {
          currentFontSize = targetSize;
          term.options.fontSize = targetSize;
        }
        // Preserve scroll position across fit — layout changes (e.g. game pane
        // toggle, browser preview) resize the container, and fit() resets viewport.
        // Save BEFORE fit, restore AFTER fit + after a rAF to ensure xterm has
        // processed the resize internally.
        //
        // CRITICAL: Only capture viewport state on the FIRST doFit() in a resize
        // sequence. Subsequent calls may read a corrupted viewportY (WebGL renderer
        // resets it asynchronously after fit()). The locked state persists until
        // the double-rAF deferred restore completes.
        const buf = term.buffer.active;
        if (!resizeLocked) {
          let vY = buf.viewportY;
          let wasBot = buf.baseY - vY <= 3;
          // After DOM detachment (slot moved between Panel divs), viewportY
          // reads as 0 because the browser reset scrollTop while the element
          // was disconnected. Try two fallbacks:
          // 1) savedViewportYRef (updated by onScroll before detachment)
          // 2) data attributes on the viewport element (survive detachment)
          if (vY <= 1 && buf.baseY > 20) {
            if (savedViewportYRef.current !== null && savedViewportYRef.current > 1) {
              vY = Math.min(savedViewportYRef.current, buf.baseY);
              wasBot = wasAtBottomRef.current;
            } else {
              const vp = el.querySelector(".xterm-viewport") as HTMLElement | null;
              const domY = parseFloat(vp?.dataset.savedViewportY ?? "0");
              if (domY > 1) {
                vY = Math.min(domY, buf.baseY);
                wasBot = vp?.dataset.savedWasAtBottom === "1";
              }
            }
          }
          resizeWasAtBottom = wasBot;
          resizeSavedViewport = vY;
          resizeLocked = true;
        }
        // Cancel any pending deferred restores from a previous doFit() call —
        // they would use the same locked state, but the terminal dimensions have
        // changed again so we need a fresh deferred restore after THIS fit().
        cancelAnimationFrame(resizeRafId1);
        cancelAnimationFrame(resizeRafId2);
        fitAddon.fit();
        // Immediate restore
        if (resizeWasAtBottom) {
          term.scrollToBottom();
        } else {
          term.scrollToLine(Math.min(resizeSavedViewport, buf.baseY));
        }
        // Deferred restore — xterm may process the resize asynchronously
        // (especially with WebGL renderer), resetting scroll after our
        // immediate restore. Double-rAF ensures we restore after xterm settles.
        // Save the viewport position right after fit — if it changes before
        // the deferred restore, the user scrolled manually and we should not
        // override their position.
        const postFitViewport = term.buffer.active.viewportY;
        resizeRafId1 = requestAnimationFrame(() => {
          resizeRafId2 = requestAnimationFrame(() => {
            try {
              const buf2 = term.buffer.active;
              if (resizeWasAtBottom) {
                // ALWAYS re-scroll to bottom — active output between the
                // immediate restore and this rAF may have pushed baseY past
                // viewportY, breaking xterm's auto-follow. Re-engaging bottom
                // ensures the terminal keeps following new output.
                term.scrollToBottom();
              } else if (buf2.viewportY === postFitViewport) {
                // Only restore if viewport hasn't been manually scrolled since fit
                term.scrollToLine(Math.min(resizeSavedViewport, buf2.baseY));
              }
            } catch { /* disposed */ }
            // Unlock: the resize sequence is complete, next doFit() captures fresh state
            resizeLocked = false;
          });
        });
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
      // Exception: Gemini CLI clears and redraws the entire screen on SIGWINCH
      // (resize signal), causing a jarring "reload" flash. Always debounce Gemini
      // so it gets exactly ONE resize after the layout settles.
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
    const scrollDisposable = term.onScroll(() => {
      updateJumpBtn();
      const buf = term.buffer.active;
      const currentY = buf.viewportY;

      // --- Universal scroll guard ---
      // Many operations (DOM detach, fitAddon.fit(), WebGL async resets) can
      // reset the xterm viewport toward the top without user intent.
      // Detection: viewportY suddenly drops far from saved position toward the
      // buffer start. The "jump ratio" (how far toward 0 vs. where we were)
      // catches both full resets (→0) and partial resets (→5, →10).
      // Gradual user scrolling updates savedViewportYRef each step, keeping
      // the ratio small. Intentional jumps set scrollGuardActiveRef.
      if (scrollGuardActiveRef.current) {
        // Guard restoration in progress — do NOT update saved position.
        // fit() / WebGL may fire intermediate resets during restoration;
        // tracking those would corrupt the good saved value.
        return;
      }
      const savedY = savedViewportYRef.current;
      // Trigger when viewport jumped more than 80% toward the top from a
      // significant position (savedY > 20 prevents false positives on short buffers).
      const jumpedToTop = savedY !== null && savedY > 20 && buf.baseY > 20 &&
        currentY < savedY * 0.2;
      if (jumpedToTop) {
        // Automated reset detected — restore last known good position
        scrollGuardActiveRef.current = true;
        const restoreY = Math.min(savedY, buf.baseY);
        const wasBottom = wasAtBottomRef.current;
        if (wasBottom) {
          term.scrollToBottom();
        } else {
          term.scrollToLine(restoreY);
        }
        // Double-rAF: WebGL / doFit() may async-reset again after our restore.
        // Check and re-restore, then sync refs to the final settled position.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            try {
              const buf2 = term.buffer.active;
              if (savedY > 20 && buf2.viewportY < savedY * 0.2 && buf2.baseY > 20) {
                if (wasBottom) {
                  term.scrollToBottom();
                } else {
                  term.scrollToLine(Math.min(restoreY, buf2.baseY));
                }
              }
              // Sync refs to the final settled position before clearing the guard
              savedViewportYRef.current = buf2.viewportY;
              wasAtBottomRef.current = buf2.baseY - buf2.viewportY <= 3;
            } catch { /* disposed */ }
            scrollGuardActiveRef.current = false;
          });
        });
        return; // Don't update savedViewportYRef — keep the good value
      }

      // Normal scroll — track position
      savedViewportYRef.current = currentY;
      wasAtBottomRef.current = buf.baseY - currentY <= 3;
      // Persist to DOM — these data attributes survive DOM detachment (which
      // silently resets scrollTop). Used by PaneGrid for slot restoration and
      // by doFit() as a fallback when savedViewportYRef might be stale.
      const vp = el.querySelector(".xterm-viewport") as HTMLElement | null;
      if (vp) {
        vp.dataset.savedScrollTop = String(vp.scrollTop);
        vp.dataset.savedViewportY = String(currentY);
        vp.dataset.savedWasAtBottom = buf.baseY - currentY <= 3 ? "1" : "0";
      }
    });
    let jumpDebounce: ReturnType<typeof setTimeout> | undefined;
    const renderDisposable = term.onRender(() => {
      clearTimeout(jumpDebounce);
      jumpDebounce = setTimeout(updateJumpBtn, 200);
    });

    // Ctrl+Scroll wheel — zoom font size (per terminal type)
    const MIN_FONT_SIZE = 8;
    const MAX_FONT_SIZE = 32;
    function handleWheel(e: WheelEvent) {
      if (!e.ctrlKey) return;
      e.preventDefault(); // prevent browser zoom
      const store = useAppStore.getState();
      const currentSize = store.cliFontSizes[terminalTypeRef.current] ?? DEFAULT_CLI_FONT_SIZE;
      const delta = e.deltaY < 0 ? 1 : -1;
      const newSize = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, currentSize + delta));
      if (newSize !== currentSize) {
        store.setCliFontSize(terminalTypeRef.current, newSize);
        showZoomIndicator(newSize);
      }
    }
    el.addEventListener("wheel", handleWheel, { passive: false });

    // --- DOM-level scroll guard (second layer) ---
    // xterm's public onScroll API may not fire for all viewport changes (e.g.,
    // during fit() buffer reflow in production builds). As a safety net, we also
    // watch the raw DOM scroll event on the .xterm-viewport element, which fires
    // for EVERY scrollTop change without exception.
    const viewportEl = el.querySelector(".xterm-viewport") as HTMLElement | null;
    let domGuardTimer = 0;
    function onViewportScroll() {
      if (scrollGuardActiveRef.current) return;
      const buf = term.buffer.active;
      const currentY = buf.viewportY;
      const savedY = savedViewportYRef.current;
      // Same ratio-based detection as the xterm onScroll guard
      const jumpedToTop = savedY !== null && savedY > 20 && buf.baseY > 20 &&
        currentY < savedY * 0.2;
      if (jumpedToTop) {
        scrollGuardActiveRef.current = true;
        const restoreY = Math.min(savedY, buf.baseY);
        const wasBottom = wasAtBottomRef.current;
        if (wasBottom) {
          term.scrollToBottom();
        } else {
          term.scrollToLine(restoreY);
        }
        // Clear guard after settling — use setTimeout (more reliable than
        // rAF in production builds where rAF timing can differ).
        clearTimeout(domGuardTimer);
        domGuardTimer = window.setTimeout(() => {
          try {
            const buf2 = term.buffer.active;
            // One more check — if still near top, restore again
            if (savedY > 20 && buf2.viewportY < savedY * 0.2 && buf2.baseY > 20) {
              if (wasBottom) term.scrollToBottom();
              else term.scrollToLine(Math.min(restoreY, buf2.baseY));
            }
            savedViewportYRef.current = buf2.viewportY;
            wasAtBottomRef.current = buf2.baseY - buf2.viewportY <= 3;
          } catch { /* disposed */ }
          scrollGuardActiveRef.current = false;
        }, 150);
      } else {
        // Normal scroll — track position (catches events xterm onScroll missed)
        savedViewportYRef.current = currentY;
        wasAtBottomRef.current = buf.baseY - currentY <= 3;
        // Persist to DOM for PaneGrid slot restoration + doFit() fallback
        if (viewportEl) {
          viewportEl.dataset.savedScrollTop = String(viewportEl.scrollTop);
          viewportEl.dataset.savedViewportY = String(currentY);
          viewportEl.dataset.savedWasAtBottom = buf.baseY - currentY <= 3 ? "1" : "0";
        }
      }
    }
    viewportEl?.addEventListener("scroll", onViewportScroll, { passive: true });

    cleanupRef.current = () => {
      viewportEl?.removeEventListener("scroll", onViewportScroll);
      clearTimeout(domGuardTimer);
      el.removeEventListener("wheel", handleWheel);
      disposed = true;
      clearInlineHint();
      clearTimeout(webglTimer);
      clearTimeout(jumpDebounce);
      cancelAnimationFrame(settleRaf1);
      cancelAnimationFrame(settleRaf2);
      clearTimeout(settleTimer);
      clearTimeout(retryTimer);
      clearTimeout(fitTimer);
      cancelAnimationFrame(resizeRafId1);
      cancelAnimationFrame(resizeRafId2);
      // Flush any pending write batch synchronously before disposing
      if (batchRafRef.current) {
        cancelAnimationFrame(batchRafRef.current);
        batchRafRef.current = 0;
        flushPtyBatch();
      }
      observer.disconnect();
      fileLinkDisposable.dispose();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      scrollDisposable.dispose();
      renderDisposable.dispose();
      blockParserRef.current?.dispose();
      blockParserRef.current = null;
      searchAddonRef.current = null;
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

    let pollCount = 0;

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
        // Auto-update session name in registry from CLI output.
        // Claude: CUSTOM_TITLE only appears from /rename → authoritative (always overrides).
        // Codex/Gemini: auto-generated titles → soft update (won't override EzyDev renames).
        // Late session detection: if we still don't have a sessionResumeId,
        // try disk lookup again without the 2-minute recency filter.
        if (!sessionResumeId && supportsSessionResume(terminalType)) {
          try {
            const type = terminalType;
            const excludeIds = [...claimedSessionIds];
            let id: string | null = null;
            if (backend === "native") {
              const cwd = workingDir;
              if (type === "claude") id = await invoke<string | null>("get_claude_session_id_native", { projectPath: cwd, excludeIds });
              else if (type === "codex") id = await invoke<string | null>("get_codex_session_id_native", { projectPath: cwd, excludeIds });
              else if (type === "gemini") id = await invoke<string | null>("get_gemini_session_id_native", { projectPath: cwd, excludeIds });
            } else if (backend === "windows") {
              const cwd = workingDir;
              if (type === "claude") id = await invoke<string | null>("get_claude_session_id_windows", { projectPath: cwd, excludeIds });
              else if (type === "codex") id = await invoke<string | null>("get_codex_session_id_windows", { projectPath: cwd, excludeIds });
              else if (type === "gemini") id = await invoke<string | null>("get_gemini_session_id_windows", { projectPath: cwd, excludeIds });
            } else {
              const wslCwd = toWslPath(workingDir);
              if (wslCwd) {
                if (type === "claude") id = await invoke<string | null>("get_claude_session_id", { projectPath: wslCwd, excludeIds });
                else if (type === "codex") id = await invoke<string | null>("get_codex_session_id", { projectPath: wslCwd, excludeIds });
                else if (type === "gemini") id = await invoke<string | null>("get_gemini_session_id", { projectPath: wslCwd, excludeIds });
              }
            }
            if (id && claimSessionId(id)) {
              console.log(`[SessionResume] late detection found: ${id.slice(0, 8)}`);
              setSessionTrusted(true);
              sessionResumeIdPropRef.current = id;
              onSessionResumeIdRef.current?.(id);
            }
          } catch (e) {
            console.error("[SessionResume] late detection failed:", e);
          }
        }
        if (sessionResumeId) {
          const store = useAppStore.getState();
          const key = workingDir.replace(/\\/g, "/");
          const existing = (store.projectSessions[key] ?? []).find((s) => s.id === sessionResumeId);
          const autoName = info.sessionName || info.summary;

          // Ensure session exists in registry (disk detection doesn't register)
          if (!existing) {
            store.registerProjectSession(workingDir, {
              id: sessionResumeId,
              name: autoName || "",
              type: terminalType,
              createdAt: Date.now(),
              isRenamed: false,
            });
          } else if (autoName) {
            if (terminalType === "claude") {
              // Claude /rename is intentional — always override, even EzyDev user renames
              if (existing.name !== autoName) {
                store.renameProjectSession(workingDir, sessionResumeId, autoName);
              }
            } else {
              // Codex/Gemini auto-titles — only update if user hasn't renamed in EzyDev
              store.updateProjectSessionAutoName(workingDir, sessionResumeId, autoName);
            }
          } else if (existing && !existing.name && !existing.isRenamed) {
            // No name from CLI — try sessions-index for a firstPrompt slug
            const effectiveBackend = backendRef.current ?? useAppStore.getState().terminalBackend ?? "wsl";
            readSessionsIndex(workingDir, effectiveBackend).then((entries) => {
              const entry = entries.find((e) => e.sessionId === sessionResumeId);
              if (entry) {
                const slugName = resolveSessionName(entry);
                if (slugName && slugName !== sessionResumeId.slice(0, 8)) {
                  store.updateProjectSessionAutoName(workingDir, sessionResumeId, slugName);
                }
              }
            });
          }
        }

        // Session drift detection: every 6th poll (~30s), check if the CLI
        // switched sessions (e.g. via /resume). If the latest session for
        // this project is different from our tracked one, switch to it.
        pollCount++;
        if (sessionResumeId && supportsSessionResume(terminalType) && pollCount % 6 === 0) {
          try {
            const type = terminalType;
            // Don't exclude the current session — we want to see if a NEWER one exists
            const excludeIds = [...claimedSessionIds].filter((id) => id !== sessionResumeId);
            let newId: string | null = null;
            if (backend === "native") {
              const cwd = workingDir;
              if (type === "claude") newId = await invoke<string | null>("get_claude_session_id_native", { projectPath: cwd, excludeIds });
              else if (type === "codex") newId = await invoke<string | null>("get_codex_session_id_native", { projectPath: cwd, excludeIds });
              else if (type === "gemini") newId = await invoke<string | null>("get_gemini_session_id_native", { projectPath: cwd, excludeIds });
            } else if (backend === "windows") {
              const cwd = workingDir;
              if (type === "claude") newId = await invoke<string | null>("get_claude_session_id_windows", { projectPath: cwd, excludeIds });
              else if (type === "codex") newId = await invoke<string | null>("get_codex_session_id_windows", { projectPath: cwd, excludeIds });
              else if (type === "gemini") newId = await invoke<string | null>("get_gemini_session_id_windows", { projectPath: cwd, excludeIds });
            } else {
              const wslCwd = toWslPath(workingDir);
              if (wslCwd) {
                if (type === "claude") newId = await invoke<string | null>("get_claude_session_id", { projectPath: wslCwd, excludeIds });
                else if (type === "codex") newId = await invoke<string | null>("get_codex_session_id", { projectPath: wslCwd, excludeIds });
                else if (type === "gemini") newId = await invoke<string | null>("get_gemini_session_id", { projectPath: wslCwd, excludeIds });
              }
            }
            if (newId && newId !== sessionResumeId && claimSessionId(newId)) {
              console.log(`[SessionResume] drift detected: ${sessionResumeId.slice(0, 8)} → ${newId.slice(0, 8)}`);
              // Release old claim so other panes can use it
              claimedSessionIds.delete(sessionResumeId);
              setSessionTrusted(true);
              sessionResumeIdPropRef.current = newId;
              onSessionResumeIdRef.current?.(newId);
            }
          } catch (e) {
            console.error("[SessionResume] drift check failed:", e);
          }
        }
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
      if (composerSupported && composerAlwaysVisible && !composerDismissedRef.current && !composerOpen) {
        setComposerOpen(true);
      }
    }
  }, [isActive, composerAlwaysVisible, composerOpen, composerSupported]);

  // Force repaint when container becomes visible (tab switch).
  // display:none prevents xterm rendering and resets viewport scrollTop.
  // IntersectionObserver detects when the container becomes visible again.
  // Scroll restoration uses savedViewportYRef (continuously tracked by onScroll).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry || !terminalRef.current) return;
        if (entry.isIntersecting) {
          recordTerminalResize(terminalId);
          terminalRef.current.refresh(0, terminalRef.current.rows - 1);
          // Restore scroll position from onScroll-tracked ref.
          const savedY = savedViewportYRef.current;
          if (savedY !== null) {
            const term = terminalRef.current;
            const wasBottom = wasAtBottomRef.current;
            scrollGuardActiveRef.current = true;
            const restore = () => {
              try {
                if (wasBottom) {
                  term.scrollToBottom();
                } else {
                  const buf = term.buffer.active;
                  term.scrollToLine(Math.min(savedY, buf.baseY));
                }
              } catch { /* disposed */ }
            };
            restore();
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                restore();
                try {
                  const buf = term.buffer.active;
                  savedViewportYRef.current = buf.viewportY;
                  wasAtBottomRef.current = buf.baseY - buf.viewportY <= 3;
                } catch { /* disposed */ }
                scrollGuardActiveRef.current = false;
              });
            });
          }
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
        try {
          // Preserve scroll position across fit — same pattern as ResizeObserver
          const buf = term.buffer.active;
          const wasAtBottom = buf.baseY - buf.viewportY <= 3;
          const savedViewport = buf.viewportY;
          fit.fit();
          if (wasAtBottom) {
            term.scrollToBottom();
          } else {
            term.scrollToLine(Math.min(savedViewport, buf.baseY));
          }
        } catch { /* container may be detached */ }
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // Auto-open composer when "always visible" is enabled.
  useEffect(() => {
    // Open composer for all panes (including background). The suppressAutoFocus
    // prop on PromptComposer already prevents focus-stealing for background panes.
    if (composerSupported && composerAlwaysVisible && !composerDismissedRef.current) {
      setComposerOpen(true);
    }
  }, [composerAlwaysVisible, composerSupported]);

  // Theme hot-swap
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = effectiveTerminalTheme;
    }
  }, [effectiveTerminalTheme]);

  // Live font-size update when user changes CLI font size in settings
  useEffect(() => {
    const term = terminalRef.current;
    const fit = fitAddonRef.current;
    if (term) {
      term.options.fontSize = cliFontSize;
      if (fit) {
        const buf = term.buffer.active;
        const wasAtBottom = buf.baseY - buf.viewportY <= 3;
        const savedViewport = buf.viewportY;
        fit.fit();
        if (wasAtBottom) {
          term.scrollToBottom();
        } else {
          term.scrollToLine(Math.min(savedViewport, buf.baseY));
        }
      }
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
    const isCli = terminalType === "codex" || terminalType === "gemini" || terminalType === "claude";

    // Record prompt with buffer line + timestamp for prompt history dropdown
    if (isCli && terminalRef.current) {
      const buf = terminalRef.current.buffer.active;
      promptTimestampsRef.current.push({
        text,
        line: buf.baseY + buf.cursorY,
        timestamp: Date.now(),
      });
    }

    if (isCli) {
      // Always use bracketed paste for CLI terminals so the TUI ingests the
      // entire input atomically.  Without it, long text (e.g. file paths for
      // image attachments) may not be fully processed before Enter arrives,
      // causing incomplete submissions.
      //
      // Claude Code parses bracketed paste asynchronously — long text needs a
      // proportionally longer delay before Enter, otherwise Enter arrives while
      // the REPL is still ingesting and the text shows as "[Text #N]" instead
      // of being submitted.  Scale: 150ms base + 1ms per char over 200 chars,
      // capped at 2s.
      const content = text + (terminalType === "gemini" ? " " : "");
      const baseDelay = terminalType === "claude" ? 150 : 80;
      const extraDelay = terminalType === "claude" ? Math.min(Math.max(0, content.length - 200), 1850) : 0;
      const pasteDelay = baseDelay + extraDelay;
      write("\x1b[200~" + content + "\x1b[201~");
      setTimeout(() => write("\r"), pasteDelay);
    } else {
      // Shell terminals: write directly (no bracketed paste needed)
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
    promptTimestampsRef.current = [];
    // Hide composer and search bar until PTY produces output again
    awaitingRestartDataRef.current = true;
    setComposerOpen(false);
    setSearchOpen(false);
    // Only re-enable session lookup if we don't already have a session ID.
    // If we DO have one, keep it — restart should use the SAME session, not find a new one.
    if (!sessionResumeIdPropRef.current) {
      sessionLookupDone.current = false;
    }
    setRestartKey((k) => k + 1);
  }, [terminalType]);

  const onSwitchSessionRef = useRef(onSwitchSession);
  onSwitchSessionRef.current = onSwitchSession;

  const handleSwitchSession = useCallback((newSessionId: string | undefined) => {
    // User explicitly switched — mark as trusted
    setSessionTrusted(!!newSessionId);
    // Release old session claim
    if (sessionResumeIdPropRef.current) {
      claimedSessionIds.delete(sessionResumeIdPropRef.current);
    }
    if (newSessionId) {
      claimedSessionIds.add(newSessionId);
      sessionLookupDone.current = true;
    } else {
      // New session — allow auto-detection to pick up the fresh session
      sessionLookupDone.current = false;
    }
    // Clear terminal
    if (terminalRef.current) {
      terminalRef.current.clear();
      terminalRef.current.reset();
    }
    setLaunchedWithYolo(!!useAppStore.getState().cliYolo[terminalType]);
    setExited(false);
    setContextInfo(null);
    setCommandBlocks([]);
    promptTimestampsRef.current = [];
    awaitingRestartDataRef.current = true;
    setComposerOpen(false);
    setSearchOpen(false);
    // Update layout tree (prop will update on re-render)
    onSwitchSessionRef.current?.(newSessionId);
    // Eagerly update ref so the PTY spawn reads the correct session ID
    // before React delivers the prop update.
    sessionResumeIdPropRef.current = newSessionId;
    // Trigger PTY re-spawn
    setRestartKey((k) => k + 1);
  }, [terminalType]);

  // Prompt history dropdown: scan buffer for prompt-like lines and merge with
  // PromptComposer timestamps for clean text + relative time display.
  const getPromptEntries = useCallback(() => {
    const term = terminalRef.current;
    if (!term) return [];
    const buf = term.buffer.active;
    const maxLine = buf.baseY + term.rows;
    const entries: { line: number; text: string; timestamp?: number; fromComposer: boolean }[] = [];
    const promptRegex = /^[>❯›»]\s/;

    for (let i = 0; i < maxLine; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const raw = line.translateToString(false);
      const trimmed = raw.trim();
      if (!promptRegex.test(trimmed)) continue;
      // Skip if prompt char not at column 0-1
      const col = raw.search(/[>❯›»]/);
      if (col > 1) continue;
      // Skip numbered selection items (> 3. Option)
      const after = trimmed.replace(/^[>❯›»]\s?/, "").trim();
      if (/^\d+[.)]/.test(after)) continue;
      if (after.length < 2) continue;

      // Try to match with a PromptComposer entry (±3 line tolerance)
      const match = promptTimestampsRef.current.find(
        (p) => Math.abs(p.line - i) <= 3
      );
      entries.push({
        line: i,
        text: match?.text ?? after,
        timestamp: match?.timestamp,
        fromComposer: !!match,
      });
    }
    return entries;
  }, []);

  // Scroll terminal to a specific buffer line (used by prompt history dropdown)
  const handleScrollToPromptLine = useCallback((line: number) => {
    const term = terminalRef.current;
    if (!term) return;
    scrollGuardActiveRef.current = true;
    term.scrollToLine(line);
    requestAnimationFrame(() => {
      try {
        const buf = term.buffer.active;
        savedViewportYRef.current = buf.viewportY;
        wasAtBottomRef.current = buf.baseY - buf.viewportY <= 3;
      } catch { /* disposed */ }
      scrollGuardActiveRef.current = false;
    });
  }, []);

  const handleSearchClose = useCallback(() => {
    searchAddonRef.current?.clearDecorations();
    setSearchOpen(false);
    if (isActive) terminalRef.current?.focus();
  }, [isActive]);

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
          backend={backend}
          sessionResumeId={sessionResumeId}
          sessionTrusted={sessionTrusted}
          onSwitchSession={handleSwitchSession}
          getPromptEntries={getPromptEntries}
          onScrollToPromptLine={handleScrollToPromptLine}
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
        {searchOpen && searchAddonRef.current && (
          <TerminalSearchBar
            searchAddon={searchAddonRef.current}
            onClose={handleSearchClose}
            isActive={isActive}
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
            isActive={isActive}
            didStealRef={composerDidStealRef}
            suppressAutoFocus={!!focusSuppressedRef.current}
          />
        )}
        {/* Zoom indicator — shows briefly when Ctrl+Scroll or Ctrl+0 changes font size */}
        {zoomIndicator !== null && (
          <div
            style={{
              position: "absolute",
              top: 8,
              left: "50%",
              transform: "translateX(-50%)",
              padding: "4px 12px",
              borderRadius: 6,
              backgroundColor: "var(--ezy-surface-raised)",
              border: "1px solid var(--ezy-border)",
              color: "var(--ezy-fg)",
              fontSize: 12,
              fontFamily: "system-ui, sans-serif",
              pointerEvents: "none",
              zIndex: 20,
              opacity: 0.9,
              whiteSpace: "nowrap",
            }}
          >
            {Math.round((zoomIndicator / DEFAULT_CLI_FONT_SIZE) * 100)}%
          </div>
        )}
        {/* Jump-to-bottom button — appears below scrollbar thumb when scrolled up */}
        <div
          ref={jumpBtnRef}
          style={{
            display: "none",
            position: "absolute",
            right: 12,
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
