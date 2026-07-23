import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from "react";
import type { Terminal } from "@xterm/xterm";
import { useAppStore } from "../store";
import type { TerminalType, TerminalBackend } from "../types";
import type { CommandBlock } from "../lib/command-block-parser";
import {
  type NativeTermId,
  type SearchResult,
  type TerminalTheme as NativeTermTheme,
  rectOf,
  subscribeResized,
  subscribeExit,
  subscribeRButton,
  subscribeMousePassthrough,
  subscribeKeyDownPreview,
  subscribeScroll,
  subscribeFocusGained,
  subscribeFocusLost,
  nativeTermCreate,
  nativeTermDestroy,
  nativeTermSetFocused,
  nativeTermFocusKeyboard,
  nativeTermScrollToBottom,
  nativeTermScrollToLine,
  nativeTermSearch,
  nativeTermSearchClear,
  nativeTermSetSearchHighlights,
  nativeTermGetBufferLines,
  nativeTermGetViewportState,
  nativeTermSetTheme,
  nativeTermSetCursorStyle,
  nativeTermSetFont,
  nativeTermSetCopyOnSelect,
  nativeTermProposeDimensions,
} from "../lib/native-term-bridge";
import { useNativeCommandBlocks } from "../hooks/useNativeCommandBlocks";
import { useNativeFileLinks } from "../native-term/useNativeFileLinks";
import { usePtyNative } from "../hooks/usePtyNative";
import type { NativeRendererSlice } from "../store/nativeRendererSlice";
import ImeCompositionPopup from "../native-term/ImeCompositionPopup";
import FileLinkTooltip from "../native-term/FileLinkTooltip";
import { useNativePaneRegion } from "../native-term/useNativePaneRegion";
import { useOverlayPopupAnchor } from "../native-term/useOverlayPopupAnchor";
import { queueGeom } from "../native-term/frameSync";
import TerminalHeader, { type PromptEntry } from "./TerminalHeader";
import PromptComposer from "./PromptComposer";
import { useClipboardImagePaste } from "../hooks/useClipboardImagePaste";
import { registerPaneSearch, unregisterPaneSearch } from "../lib/pane-search-registry";
import {
  registerPtyWrite,
  unregisterPtyWrite,
  registerTerminalFocus,
  unregisterTerminalFocus,
  getTerminalDataListener,
} from "../store/terminalSlice";
import {
  recordTerminalActivity,
  recordTerminalWrite,
  recordTerminalResize,
  clearTerminalActivity,
} from "../lib/terminal-activity";
import { getTheme, getEffectiveTerminalTheme } from "../lib/themes";
import { DEFAULT_CLI_FONT_SIZE } from "../store/recentProjectsSlice";
import { TERMINAL_FONT_FAMILY } from "../lib/terminal-fonts";
import { invoke } from "@tauri-apps/api/core";
import { supportsSessionResume } from "../lib/session-resume";
import { toWslPath } from "../lib/terminal-config";
import { readSessionContext, type ContextInfo } from "../lib/context-parser";
import { readSessionFirstPrompt, slugify } from "../lib/sessions-index";
// Session-detection state + helpers shared with the xterm pane. MUST come
// from TerminalPaneXterm so both renderers resolve claims/dedup against ONE
// universe — a separate copy here would let an xterm pane and a native pane
// claim the same Claude session (header/session steal class of bugs).
import {
  claimedSessionIds,
  claimSessionId,
  paneSpawnMs,
  panesWithLockedSession,
  paneWorkingDir,
  lookupClaudeBySpawn,
} from "./TerminalPaneXterm";

// Until `store/index.ts` (M-list) registers `createNativeRendererSlice`,
// these fields aren't visible on AppStore at the type level. Cast through
// the slice interface. Patch plan in J1 wrap-up adds the slice; the cast
// can be removed afterwards.
type AppStoreWithNative = ReturnType<typeof useAppStore.getState> & NativeRendererSlice;

// Fallback ANSI palette mirrored from the Rust default in
// renderer/mod.rs::ThemeColors::default_tango. Used to fill in any slot a
// MADE theme doesn't define (defensive — current themes provide all 16, but
// guarantees we always ship a complete wire payload).
const FALLBACK_ANSI: Record<string, string> = {
  ansi0: "#000000",
  ansi1: "#cc0000",
  ansi2: "#4e9a06",
  ansi3: "#c4a000",
  ansi4: "#3465a4",
  ansi5: "#75507b",
  ansi6: "#06989a",
  ansi7: "#d3d7cf",
  ansi8: "#555753",
  ansi9: "#ef2929",
  ansi10: "#8ae234",
  ansi11: "#fce94f",
  ansi12: "#729fcf",
  ansi13: "#ad7fa8",
  ansi14: "#34e2e2",
  ansi15: "#eeeeec",
};

/// Convert an EFFECTIVE terminal theme (xterm ITheme shape from
/// `getEffectiveTerminalTheme` — includes the active-pane background lift
/// and vibrant ANSI overlay, exactly what the legacy xterm pane renders
/// with) to the native_term wire-format TerminalTheme. xterm ITheme uses
/// `selectionBackground` / `black`/.../`brightWhite`; the Rust side wants
/// `selection` and `ansi0..15`. Defensive fallbacks for undeclared keys.
function madeThemeToNative(t: Record<string, string | undefined>): NativeTermTheme {
  const pick = (key: string, fallback: string): string =>
    t[key] ?? fallback;
  return {
    background: pick("background", "#0d0d11"),
    foreground: pick("foreground", "#d3d7cf"),
    cursor: pick("cursor", "#dbd6cf"),
    cursorAccent: pick("cursorAccent", "#0d0d11"),
    selection: pick("selectionBackground", "#44556b"),
    ansi0: pick("black", FALLBACK_ANSI.ansi0),
    ansi1: pick("red", FALLBACK_ANSI.ansi1),
    ansi2: pick("green", FALLBACK_ANSI.ansi2),
    ansi3: pick("yellow", FALLBACK_ANSI.ansi3),
    ansi4: pick("blue", FALLBACK_ANSI.ansi4),
    ansi5: pick("magenta", FALLBACK_ANSI.ansi5),
    ansi6: pick("cyan", FALLBACK_ANSI.ansi6),
    ansi7: pick("white", FALLBACK_ANSI.ansi7),
    ansi8: pick("brightBlack", FALLBACK_ANSI.ansi8),
    ansi9: pick("brightRed", FALLBACK_ANSI.ansi9),
    ansi10: pick("brightGreen", FALLBACK_ANSI.ansi10),
    ansi11: pick("brightYellow", FALLBACK_ANSI.ansi11),
    ansi12: pick("brightBlue", FALLBACK_ANSI.ansi12),
    ansi13: pick("brightMagenta", FALLBACK_ANSI.ansi13),
    ansi14: pick("brightCyan", FALLBACK_ANSI.ansi14),
    ansi15: pick("brightWhite", FALLBACK_ANSI.ansi15),
  };
}

// Phase 1 J1 — native-mode terminal pane.
// Public prop shape mirrors TerminalPane (the xterm-backed pane) so the
// 30-line selector wrapping both is a drop-in. Heavy lifting (full overlay
// parity, OSC 133 plumbing, prompt-detection, jump-to-bottom, search,
// IME popup, command-block overlay) lands in Phase 2 — this file owns:
//
//   1. Lifecycle: create the native HWND, drive resize, destroy on unmount.
//   2. PTY hookup via usePtyNative, attach_pty wired post-create.
//   3. Event subscription scaffold for the bridge channels.
//   4. Slot for overlay components (Phase 2 plugs them into terminalDivRef).
//   5. Registry registration via nativeRendererSlice so O's coordinator can
//      see this pane.
//
// P7a: lifecycle runs on the production command surface — one
// `native_term_create` carries the full CreateOpts (theme/font/cursor/
// scrollback/focused), so the first frame already paints with the user's
// settings; hot-swap effects below handle every later change.

interface TerminalPaneNativeProps {
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
  backend?: TerminalBackend;
}

export default function TerminalPaneNative({
  terminalId,
  terminalType,
  workingDir,
  isActive,
  onClose,
  onChangeType,
  onFocus,
  onSwapPane,
  onExplainError: _onExplainError,
  onPtyReady,
  onPtyExit,
  hideChrome,
  serverId,
  sessionResumeId,
  onSessionResumeId,
  onSwitchSession,
  paneCount: _paneCount = 1,
  backend,
}: TerminalPaneNativeProps) {
  void terminalId;

  const paneDivRef = useRef<HTMLDivElement | null>(null);
  const terminalDivRef = useRef<HTMLDivElement | null>(null);
  const [termId, setTermId] = useState<NativeTermId | null>(null);
  const [cols, setCols] = useState(80);
  const [rows, setRows] = useState(24);
  const [cellMetrics, setCellMetrics] = useState<{ w: number; h: number } | null>(null);
  const [ptyReady, setPtyReady] = useState(false);
  // Bumped to force usePtyNative to kill + respawn the PTY (session switch).
  // Same mechanism as TerminalPaneXterm's restartKey — the spawn effect is
  // keyed on it, so a bump detaches the native term, kills the old PTY and
  // spawns a fresh one that reads the (eagerly updated) resume session ID.
  const [restartKey, setRestartKey] = useState(0);

  // ── Session remember (parity with TerminalPaneXterm) ─────────────────
  // Seed claimed set with persisted IDs so new panes don't steal them.
  if (sessionResumeId) claimedSessionIds.add(sessionResumeId);

  // Trusted = restored from persist or explicit switch; disk-detected
  // sessions become trusted once atomically claimed.
  const [sessionTrusted, setSessionTrusted] = useState(!!sessionResumeId);
  const [contextInfo, setContextInfo] = useState<ContextInfo | null>(null);
  const sessionLookupDone = useRef(false);
  const sessionRetryCancelRef = useRef<(() => void) | null>(null);
  // First-PTY-data timestamp (minus 2s cushion) — the floor for spawn-based
  // detection; session files started before it belong to another pane.
  const ptySpawnTimeRef = useRef<number>(0);
  const sessionResumeIdPropRef = useRef(sessionResumeId);
  sessionResumeIdPropRef.current = sessionResumeId;
  const onSessionResumeIdRef = useRef(onSessionResumeId);
  onSessionResumeIdRef.current = onSessionResumeId;
  const terminalTypeRef = useRef(terminalType);
  terminalTypeRef.current = terminalType;
  const workingDirRef = useRef(workingDir);
  workingDirRef.current = workingDir;
  const backendRef = useRef(backend);
  backendRef.current = backend;
  const serverIdRef = useRef(serverId);
  serverIdRef.current = serverId;

  // Register persisted/detected sessions in the per-project registry AND kick
  // off auto-naming from the session's first user prompt (xterm parity).
  // Retries every 5s until a name is set or the session is renamed.
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
    if (!sessionResumeId || !supportsSessionResume(terminalType)) return;
    const sid = sessionResumeId;
    const wd = workingDir;
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | undefined;

    const tryFetch = async (): Promise<boolean> => {
      const store = useAppStore.getState();
      const key = wd.replace(/\\/g, "/");
      const existing = (store.projectSessions[key] ?? []).find((s) => s.id === sid);
      if (existing?.isRenamed) return true;
      if (existing?.name) return true;
      const isSsh = !!serverId;
      const effectiveBackend = isSsh
        ? "ssh"
        : (backendRef.current ?? useAppStore.getState().terminalBackend ?? "wsl");
      // WSL backend needs a Unix path; SSH wd is already remote Unix.
      const pathForBackend = effectiveBackend === "wsl" ? toWslPath(wd) : wd;
      try {
        const prompt = await readSessionFirstPrompt(pathForBackend, effectiveBackend, sid, serverId);
        if (prompt) {
          const slug = slugify(prompt);
          if (slug) {
            store.updateProjectSessionAutoName(wd, sid, slug);
            return true;
          }
        }
      } catch { /* silent */ }
      return false;
    };

    const start = setTimeout(async () => {
      if (cancelled) return;
      if (await tryFetch()) return;
      intervalId = setInterval(async () => {
        if (cancelled) return;
        if (await tryFetch()) {
          if (intervalId) { clearInterval(intervalId); intervalId = undefined; }
        }
      }, 5000);
    }, 2000);

    return () => {
      cancelled = true;
      clearTimeout(start);
      if (intervalId) clearInterval(intervalId);
    };
  }, [sessionResumeId, workingDir, terminalType, serverId]);

  // Register this resumable pane's spawn ordering + locked state so older
  // panes (xterm OR native — shared maps) don't steal a newly-added pane's
  // session (see newerResumablePaneStillResolving in TerminalPaneXterm).
  useEffect(() => {
    if (supportsSessionResume(terminalType)) {
      if (!paneSpawnMs.has(terminalId)) paneSpawnMs.set(terminalId, Date.now());
      paneWorkingDir.set(terminalId, workingDir.replace(/\\/g, "/"));
    } else {
      paneSpawnMs.delete(terminalId);
      paneWorkingDir.delete(terminalId);
    }
  }, [terminalId, terminalType, workingDir]);
  useEffect(() => {
    if (sessionResumeId) panesWithLockedSession.add(terminalId);
    else panesWithLockedSession.delete(terminalId);
  }, [sessionResumeId, terminalId]);
  useEffect(() => () => {
    paneSpawnMs.delete(terminalId);
    panesWithLockedSession.delete(terminalId);
    paneWorkingDir.delete(terminalId);
  }, [terminalId]);

  // Context/header info poll. Deliberately ONLY when this pane has locked its
  // own session — the "__latest__" fallback the xterm pane uses is ambiguous
  // when panes share a working dir (another pane's session/model/cost would
  // show here); an unlocked native pane just shows nothing until detection
  // locks. Mirrors the xterm poll call signature + 5s cadence.
  useEffect(() => {
    if (!sessionResumeId || !supportsSessionResume(terminalType)) {
      setContextInfo(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      const isSsh = !!serverIdRef.current;
      const info = await readSessionContext(
        terminalType,
        sessionResumeId,
        backend,
        serverIdRef.current,
        isSsh ? workingDirRef.current : undefined,
      );
      if (!cancelled && info) setContextInfo(info);
    };
    void poll();
    const intervalId = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [sessionResumeId, terminalType, backend]);

  // ── Overlay state (parity with TerminalPaneXterm) ────────────────────
  const [composerOpen, setComposerOpen] = useState(false);
  const composerDidStealRef = useRef(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFocusBump, setSearchFocusBump] = useState(0);
  // Local PaneSearchBar state — wired to native_term_search (R3).
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchRegex, setSearchRegex] = useState(false);
  const [searchWholeWord, setSearchWholeWord] = useState(false);
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);

  // Native pane has no xterm Terminal — pass a typed-null ref to hooks that
  // expect one. TODO(R3): swap for a Rust-backed shim once buffer reads exist.
  const nullTerminalRef = useRef<Terminal | null>(null);

  // Theme + font for PromptComposer styling (read from store like xterm pane).
  const themeId = useAppStore((s) => s.themeId);
  const theme = useMemo(() => getTheme(themeId), [themeId]);
  // P7a: mirror themeId into a ref so the create effect can build the
  // CreateOpts.theme payload without adding themeId to its dep array
  // (which would tear down + recreate the HWND on every theme switch).
  // Live changes flow through the theme hot-swap effect below.
  const themeIdRef = useRef(themeId);
  useEffect(() => { themeIdRef.current = themeId; }, [themeId]);
  // Legacy-pane parity: vibrant ANSI + active-pane background lift ride the
  // effective theme (same helper the xterm pane uses). Ref for the create
  // path; the hot-swap effect below reads the live values.
  const vibrantColors = useAppStore((s) => s.vibrantColors);
  const vibrantColorsRef = useRef(vibrantColors);
  useEffect(() => { vibrantColorsRef.current = vibrantColors; }, [vibrantColors]);
  const nativeCursorStyle = useAppStore((s) => s.nativeCursorStyle);
  const nativeCursorBlink = useAppStore((s) => s.nativeCursorBlink);
  // Mirror cursor settings into refs so the create effect can read the
  // latest values without rerunning when the user toggles them. Live updates
  // are handled by the separate hot-swap effect below.
  const nativeCursorStyleRef = useRef(nativeCursorStyle);
  const nativeCursorBlinkRef = useRef(nativeCursorBlink);
  useEffect(() => { nativeCursorStyleRef.current = nativeCursorStyle; }, [nativeCursorStyle]);
  useEffect(() => { nativeCursorBlinkRef.current = nativeCursorBlink; }, [nativeCursorBlink]);
  // P2b: whether the app effectively has focus. Derived in the store as
  // webviewFocused || nativePaneFocused, because on Windows tauri's
  // onFocusChanged mirrors WEBVIEW focus only — clicking a native pane blurs
  // the webview while the app stays foreground; the pane's own
  // focus_gained/focus_lost events (below) supply the native half. A pane's
  // cursor is focused iff isActive && appWindowFocused — computed here in JS
  // only (composer/search inputs take webview focus while the pane stays
  // active and must keep blinking).
  const appWindowFocused = useAppStore((s) => s.appWindowFocused);
  // Mirror isActive + the pane-activation callback into refs so the
  // focus_gained subscription (registered in the event effect below) can
  // read the latest values without growing that effect's dep array —
  // same pattern as the cursor-style refs above. appWindowFocused is
  // mirrored too (P7a) so the create effect can seed CreateOpts.focused
  // with the live `isActive && appWindowFocused` value.
  const isActiveRef = useRef(isActive);
  const onFocusRef = useRef(onFocus);
  const appWindowFocusedRef = useRef(appWindowFocused);
  useEffect(() => { isActiveRef.current = isActive; }, [isActive]);
  useEffect(() => { onFocusRef.current = onFocus; }, [onFocus]);
  useEffect(() => { appWindowFocusedRef.current = appWindowFocused; }, [appWindowFocused]);
  // N-b: copy-on-select store flag (legacy default false). Pushed to the
  // native pane below so a mouse-selection auto-copies only when enabled.
  const copyOnSelect = useAppStore((s) => s.copyOnSelect);
  const cliFontSize = useAppStore((s) => s.cliFontSizes[terminalType] ?? DEFAULT_CLI_FONT_SIZE);
  // P5b: mirror the CLI font size into a ref so the create effect can push
  // the initial set_font without adding cliFontSize to its dep array (which
  // would tear down + recreate the HWND on every size change). Live changes
  // flow through the dedicated font hot-swap effect below.
  const cliFontSizeRef = useRef(cliFontSize);
  useEffect(() => { cliFontSizeRef.current = cliFontSize; }, [cliFontSize]);
  const composerAlwaysVisible = useAppStore(
    (s) => s.promptComposerEnabled && s.promptComposerAlwaysVisible,
  );
  // MadeComposer is only for AI CLI terminals — not plain shell or devserver
  const composerSupported = terminalType !== "shell" && terminalType !== "devserver";

  // Jump-to-bottom: tracks viewportY vs baseY from native `scroll` events.
  // viewportY is negative when scrolled up into scrollback; 3-line tolerance
  // (per repo memory feedback_viewport_at_bottom_tolerance.md) prevents
  // race-condition flicker during rapid output.
  const [isAtBottom, setIsAtBottom] = useState(true);
  // Overlay-migrated: the button renders in the overlay webview above the
  // native pane (kind "jump-btn", anchored to the terminal rect below, next
  // to the exit-banner hook); its click bounces back as the "jump" action.

  // ── Process-exit feedback (S15, xterm parity) ────────────────────────
  // `exited` flips true when the attached PTY dies. It (a) gates clipboard
  // image paste (threaded into useClipboardImagePaste below — xterm blocks
  // input after exit the same way) and (b) drives the DOM "[Process exited]"
  // banner rendered over the terminal anchor. The native pane has no xterm
  // buffer to write the banner into (the way TerminalPaneXterm does at
  // ~:610), so it's a DOM overlay instead.
  const [exited, setExited] = useState(false);
  // Phase 1 overlay migration: the "[Process exited]" banner now renders in the
  // transparent OVERLAY webview (above the native panes — no hole cut). We emit
  // the pane anchor rect while `exited` so the overlay draws the banner at the
  // pane's bottom-center. `exited` still gates clipboard paste below.
  useOverlayPopupAnchor({
    id: `exit-banner-${terminalId}`,
    kind: "exit-banner",
    open: exited,
    anchorRef: terminalDivRef,
  });

  // Jump-to-bottom button (overlay-rendered) — appears while scrolled into
  // history; the overlay bounces "jump" back and we scroll the native pane.
  useOverlayPopupAnchor({
    id: `jump-btn-${terminalId}`,
    kind: "jump-btn",
    open: !isAtBottom,
    anchorRef: terminalDivRef,
    onAction: (action) => {
      if (action !== "jump" || termId == null) return;
      void nativeTermScrollToBottom(termId).catch(() => {});
    },
  });

  const registerNativeTerm = useAppStore(
    (s) => (s as AppStoreWithNative).registerNativeTerm,
  );
  const unregisterNativeTerm = useAppStore(
    (s) => (s as AppStoreWithNative).unregisterNativeTerm,
  );

  // ── HWND lifecycle ────────────────────────────────────────────────────
  useLayoutEffect(() => {
    const el = terminalDivRef.current;
    if (!el) return;
    let cancelled = false;
    let createdId: NativeTermId | null = null;
    let raf2Id = 0;

    const raf1 = requestAnimationFrame(() => {
      raf2Id = requestAnimationFrame(async () => {
        if (cancelled) return;
        try {
          // P7a: ONE `native_term_create` carries the full CreateOpts —
          // theme, font (Hack + the user's CLI font size), cursor
          // style/blink, scrollback and the live focus state — so the
          // first frame already paints with the user's settings and the
          // dimension handshake below runs against the real font metrics.
          // Everything is read through refs so this effect's dep array
          // stays create-once; live changes flow through the dedicated
          // hot-swap effects below.
          const id = await nativeTermCreate({
            rect: rectOf(el),
            dpr: window.devicePixelRatio,
            theme: madeThemeToNative(
              getEffectiveTerminalTheme(
                themeIdRef.current,
                vibrantColorsRef.current,
                isActiveRef.current,
              ) as Record<string, string | undefined>,
            ),
            font: {
              family: TERMINAL_FONT_FAMILY,
              sizePx: cliFontSizeRef.current,
            },
            cursorStyle: nativeCursorStyleRef.current,
            cursorBlink: nativeCursorBlinkRef.current,
            scrollback: 10000,
            focused: isActiveRef.current && appWindowFocusedRef.current,
          });
          if (cancelled) {
            void nativeTermDestroy(id).catch(() => {});
            return;
          }
          createdId = id;
          registerNativeTerm(id);
          // ── P1c: initial-size handshake (kills the 80x24 flash) ────────
          // Re-read the anchor rect: during pane-grid mount the div can
          // report 0x0 for a frame or two. Retry on successive rAFs
          // (bounded) rather than spawning the PTY at guessed dims
          // (learnings: pty-spawn-dimensions-race). On exhaustion we still
          // call propose — its Rust-side floors (cols>=20, rows>=1) keep
          // the spawn sane.
          let rect = rectOf(el);
          for (
            let attempt = 0;
            attempt < 10 && (rect.width <= 0 || rect.height <= 0);
            attempt++
          ) {
            await new Promise<void>((r) => requestAnimationFrame(() => r()));
            if (cancelled) return;
            rect = rectOf(el);
          }
          // Ask Rust for the real cols/rows for this rect (LOGICAL px —
          // rectOf convention; Rust multiplies by its cached dpr).
          let dims = { cols: 80, rows: 24 };
          try {
            dims = await nativeTermProposeDimensions(
              id,
              rect.width,
              rect.height,
            );
          } catch (e) {
            console.error("[TerminalPaneNative] propose_dimensions failed", e);
          }
          if (cancelled) return;
          // Publish dims BEFORE termId, all in one synchronous block —
          // React batches these, so when usePtyNative's spawn effect fires
          // (keyed on `ready: termId != null`) the cols/rows props and
          // colsRef/rowsRef already hold the real values and the PTY spawns
          // at the correct size. Do NOT add a JS pty_resize on `resized`
          // events — Rust resizes the PTY itself (double-resize otherwise).
          setCols(dims.cols);
          setRows(dims.rows);
          setTermId(id);
          setPtyReady(true);
        } catch (err) {
          console.error("[TerminalPaneNative] create failed", err);
        }
      });
    });

    // Geometry driver: a continuous rAF re-read with a no-change guard.
    // A bare ResizeObserver (the previous approach) misses POSITION-only
    // changes — e.g. the header settling into flow pushes this inner div down
    // without changing its size, so the surface stayed at the pane top and the
    // header drew over the first rows. RO also coalesces during a fast divider
    // drag, so the native surface lagged the DOM header. Re-reading rectOf(el)
    // every frame and pushing only on change fixes both. Mirrors the existing
    // region driver in useNativePaneRegion.ts:47-103.
    let geomRafId = 0;
    let lastGeomJson = "";
    const pushGeom = () => {
      geomRafId = requestAnimationFrame(pushGeom);
      if (createdId == null || !el.isConnected) return;
      const rect = rectOf(el);
      if (rect.width <= 0 || rect.height <= 0) return;
      const dpr = window.devicePixelRatio;
      const json = JSON.stringify([rect, dpr]);
      if (json === lastGeomJson) return;
      lastGeomJson = json;
      // P4b: route through the frame-sync coalescer instead of a direct
      // resize invoke — all panes' geometry (and hole) updates for a frame
      // merge into ONE `native_term_frame_sync` batch, applied Rust-side in
      // a single DeferWindowPos transaction (atomic splitter moves).
      queueGeom(createdId, rect, dpr);
    };
    geomRafId = requestAnimationFrame(pushGeom);

    // ResizeObserver now only resets the guard so the next rAF tick re-pushes
    // promptly after a size change (the rAF read covers position changes).
    const ro = new ResizeObserver(() => {
      lastGeomJson = "";
    });
    ro.observe(el);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1);
      if (raf2Id) cancelAnimationFrame(raf2Id);
      if (geomRafId) cancelAnimationFrame(geomRafId);
      ro.disconnect();
      if (createdId != null) {
        unregisterNativeTerm(createdId);
        void nativeTermDestroy(createdId).catch(() => {});
      }
    };
  }, [registerNativeTerm, unregisterNativeTerm]);

  // ── Event subscriptions ──────────────────────────────────────────────
  // Subscribes to per-id channels emitted by the Rust renderer. Subscriber
  // shapes match `NativeTermEventPayloadMap` in native-term-bridge.ts.
  useEffect(() => {
    if (termId == null) return;
    let cancelled = false;
    const unlistens: Array<() => void> = [];

    (async () => {
      const u1 = await subscribeResized(termId, (p) => {
        if (cancelled) return;
        // Lock out the activity tracker around a reflow so the redraw burst
        // the resize triggers isn't misread as AI output.
        recordTerminalResize(terminalId);
        setCols(p.cols);
        setRows(p.rows);
        // Real glyph metrics (logical px) for grid-positioned popups.
        if (p.cellW > 0 && p.cellH > 0) {
          setCellMetrics((prev) =>
            prev && prev.w === p.cellW && prev.h === p.cellH
              ? prev
              : { w: p.cellW, h: p.cellH },
          );
        }
      });
      unlistens.push(u1);

      const u2 = await subscribeExit(termId, (p) => {
        if (cancelled) return;
        // Gate input + show the banner regardless of which exit channel
        // fires first (this native-renderer event or usePtyNative's onExit →
        // handlePtyExit). setExited is idempotent, so both firing is safe.
        setExited(true);
        onPtyExit?.(p.code);
      });
      unlistens.push(u2);

      // Right-click bridge: native pane reports pane-local (x, y) in
      // logical px. GlobalContextMenu installs a window-level
      // `contextmenu` listener (see GlobalContextMenu.tsx) and reads
      // `clientX/clientY` plus `[data-terminal-id]` ancestry from the
      // event target. We synthesize a contextmenu event at the right
      // viewport coords with the terminal anchor as the target so the
      // "isTerminal" branch (Clear / Split / Close Pane items) lights up.
      const u3 = await subscribeRButton(termId, (p) => {
        if (cancelled) return;
        const paneEl = paneDivRef.current;
        if (!paneEl) return;
        const r = paneEl.getBoundingClientRect();
        const clientX = r.left + p.x;
        const clientY = r.top + p.y;
        // Prefer dispatching on an element annotated with
        // [data-terminal-id] so GlobalContextMenu detects "terminal"
        // context. The xterm pane sets this on its root; for the native
        // pane we tag the terminal anchor in JSX below.
        const target =
          (terminalDivRef.current as Element | null) ?? (paneEl as Element);
        const evt = new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          button: 2,
        });
        target.dispatchEvent(evt);
      });
      unlistens.push(u3);

      // Splitter mouse-passthrough bridge.
      // TODO(J-track): real wiring. This project uses
      // `react-resizable-panels` (see src/components/PaneGrid.tsx),
      // which attaches pointer listeners on the handle itself rather
      // than document-level listeners during drag. Synthesizing a
      // `mousemove` on `document` does NOT initiate a panel resize —
      // the library only starts dragging on a real pointerdown atop
      // the handle. Until we have a custom splitter or a library
      // upgrade with an imperative API, we just log so we can confirm
      // the event reaches JS in dev builds.
      const u4 = await subscribeMousePassthrough(termId, (p) => {
        if (cancelled) return;
        if (import.meta.env.DEV) {
          console.debug(
            "[TerminalPaneNative] mouse_passthrough (stub)",
            termId,
            p,
          );
        }
      });
      unlistens.push(u4);

      // key_down_preview bridge: native HWND captures keyboard focus when
      // clicked, so React's window-level shortcut listener (App.tsx ~line 599)
      // never sees Ctrl+K et al. Rust whitelists UI shortcuts (Ctrl+K/B/F/,, Slash,
      // Alt+1..9) and emits this event; we synthesize a window-level
      // KeyboardEvent so the existing handler dispatches without modification.
      const u5 = await subscribeKeyDownPreview(termId, (p) => {
        if (cancelled) return;
        const ev = new KeyboardEvent("keydown", {
          key: p.ev.key,
          code: p.ev.code,
          ctrlKey: p.ev.ctrl,
          shiftKey: p.ev.shift,
          altKey: p.ev.alt,
          metaKey: p.ev.meta,
          repeat: p.ev.repeat,
          bubbles: true,
          cancelable: true,
        });
        // Dispatch on the terminal ANCHOR (bubbles to window, so app-level
        // shortcut listeners behave exactly as before) instead of window
        // directly: container-scoped hooks — useClipboardImagePaste's Ctrl+V
        // image-paste path — never saw the replay when it targeted window,
        // which is why image paste was dead on native panes.
        (terminalDivRef.current ?? window).dispatchEvent(ev);
      });
      unlistens.push(u5);

      // scroll → jump-to-bottom button visibility.
      // viewportY is the top visible row relative to baseY; at the very
      // bottom viewportY == 0 (or close to it). Use a 3-line tolerance.
      const u6 = await subscribeScroll(termId, (p) => {
        if (cancelled) return;
        setIsAtBottom(p.viewportY >= -3);
      });
      unlistens.push(u6);

      // focus_gained (P2a click-to-focus): the native HWND took Win32
      // keyboard focus. Set the store's nativePaneFocused flag (the webview
      // is about to fire — or already fired — a blur, since WebView2's
      // LostFocus triggers whenever a sibling HWND takes Win32 focus; the
      // derived appWindowFocused stays true through that) and activate this
      // pane — mirrors the onPaneClick delegation. Refs keep this effect's
      // dep array stable.
      const u7 = await subscribeFocusGained(termId, () => {
        if (cancelled) return;
        useAppStore.getState().setNativePaneFocused(true);
        if (!isActiveRef.current) onFocusRef.current();
      });
      unlistens.push(u7);

      // focus_lost (P2b): the native HWND lost Win32 keyboard focus. Clear
      // the store's native flag — this is the ONLY blur signal when the
      // user Alt-Tabs away while a native pane holds focus (the webview
      // already blurred earlier, so onFocusChanged stays silent). Focus
      // moving pane→pane is safe: WM_KILLFOCUS (old) precedes WM_SETFOCUS
      // (new), so the paired focus_gained lands after this and re-sets the
      // flag; clicking back into the webview re-asserts via
      // onFocusChanged(true).
      const u8 = await subscribeFocusLost(termId, () => {
        if (cancelled) return;
        useAppStore.getState().setNativePaneFocused(false);
      });
      unlistens.push(u8);

      // Phase 2 wires: osc133 → useNativeCommandBlocks (hook below),
      // cell_hover/link_click → useNativeFileLinks (hook below),
      // selection → clipboard, data_rate → terminal-activity.
      // cursor + ime_composition: ImeCompositionPopup subscribes directly.

      // ── Attach-race re-sync (Run A review finding) ────────────────────
      // Rust's attach-tail commit_dims can emit `resized` BEFORE the
      // listen() registrations above complete, leaving cols/rows stale at
      // their pre-attach values. Now that the resized listener is live,
      // re-read the anchor rect and re-propose once. Idempotent — any
      // later `resized` event simply overwrites these values, and
      // propose_dimensions has no Rust-side side effects.
      if (cancelled) return;
      const el = terminalDivRef.current;
      if (el) {
        const rect = rectOf(el);
        if (rect.width > 0 && rect.height > 0) {
          try {
            const dims = await nativeTermProposeDimensions(
              termId,
              rect.width,
              rect.height,
            );
            if (cancelled) return;
            setCols(dims.cols);
            setRows(dims.rows);
          } catch {
            // Benign race: pane destroyed mid-invoke.
          }
        }
      }
    })();

    return () => {
      cancelled = true;
      for (const u of unlistens) u();
    };
  }, [termId, onPtyExit]);

  // ── Notify parent of PTY readiness once create + spawn both resolved ──
  useEffect(() => {
    if (ptyReady && termId != null) onPtyReady?.();
  }, [ptyReady, termId, onPtyReady]);

  // ── Theme hot-swap ────────────────────────────────────────────────────
  // Re-push the palette to the native renderer whenever the user switches
  // themes. The first apply happens inside the create flow above; this
  // effect handles every subsequent change. Cheap: one IPC + atomic Rust
  // swap. Dep array is intentionally `[termId, themeId]` only — `theme`
  // is derived from `themeId` and would cause a redundant re-render trigger.
  useEffect(() => {
    if (termId == null) return;
    // Legacy-pane parity: the effective theme carries the ACTIVE-pane
    // background lift + vibrant ANSI overlay, so the native pane matches
    // the xterm pane's lighter focused background and re-tints on focus
    // changes exactly like the legacy renderer.
    void nativeTermSetTheme(
      termId,
      madeThemeToNative(
        getEffectiveTerminalTheme(themeId, vibrantColors, isActive) as Record<
          string,
          string | undefined
        >,
      ),
    ).catch(
      (e) => console.error("[TerminalPaneNative] set_theme update failed", e),
    );
  }, [termId, themeId, vibrantColors, isActive]);

  // ── Cursor style/blink hot-swap ───────────────────────────────────────
  // Re-push the cursor settings whenever the user changes them in Settings.
  // First apply happens in the create flow above.
  useEffect(() => {
    if (termId == null) return;
    void nativeTermSetCursorStyle(termId, nativeCursorStyle, nativeCursorBlink).catch(
      (e) => console.error("[TerminalPaneNative] set_cursor_style update failed", e),
    );
  }, [termId, nativeCursorStyle, nativeCursorBlink]);

  // ── Copy-on-select push (N-b) ─────────────────────────────────────────
  // Mirror the `copyOnSelect` store flag onto the native pane. Legacy default
  // is false: selecting text emits a `selection` event but does not auto-copy
  // to the clipboard. The Rust WM_LBUTTONUP arm gates its copy on this. Also
  // fires once on termId-flip so a freshly-created pane starts in sync.
  useEffect(() => {
    if (termId == null) return;
    void nativeTermSetCopyOnSelect(termId, copyOnSelect).catch(
      (e) => console.error("[TerminalPaneNative] set_copy_on_select update failed", e),
    );
  }, [termId, copyOnSelect]);

  // ── Font hot-swap (P5b) ───────────────────────────────────────────────
  // Re-push the font whenever the user changes the CLI font size (same
  // store field the xterm pane reads). Rust-side set_font re-derives the
  // cell metrics and runs commit_dims (Term::resize → resize_grid →
  // resize_pty_sync → `resized` emit), so cols/rows and the PTY adjust
  // automatically. First apply happens in the create flow above (the
  // termId-flip firing here re-sends the same values — idempotent:
  // commit_dims no-ops when the grid already matches).
  useEffect(() => {
    if (termId == null) return;
    void nativeTermSetFont(termId, TERMINAL_FONT_FAMILY, cliFontSize).catch(
      (e) => console.error("[TerminalPaneNative] set_font update failed", e),
    );
  }, [termId, cliFontSize]);

  // ── Cursor focus push (P2b) ───────────────────────────────────────────
  // JS-authoritative: the store computes the single source of truth
  // (isActive && appWindowFocused) and pushes it to the renderer. Errors
  // are benign races (pane tearing down mid-invoke).
  useEffect(() => {
    if (termId == null) return;
    void nativeTermSetFocused(termId, isActive && appWindowFocused).catch(() => {});
  }, [termId, isActive, appWindowFocused]);

  // ── Win32 keyboard-focus routing (P7b) ────────────────────────────────
  // Parity with the xterm pane, which calls term.focus() when it becomes
  // the active pane: route Win32 keyboard focus to the native HWND so
  // typing works without an extra click. DELIBERATELY its own effect —
  // isolated so it can be reverted alone if a focus-steal case surfaces
  // (repo history: composer mount steal, background .focus() theft).
  // ALL guards must hold, or we do nothing:
  //   - isActive: never focus a background pane
  //     (feedback_focus_calls_isactive).
  //   - appWindowFocused: never fight another app for focus.
  //   - document.activeElement === document.body: NON-NEGOTIABLE — if the
  //     composer, pane search, tab rename, or ANY other webview input owns
  //     focus, this effect must not steal it. Only when webview focus is
  //     parked on <body> (nothing interactive focused) may the HWND claim
  //     keyboard focus.
  useEffect(() => {
    if (termId == null || !isActive || !appWindowFocused) return;
    if (document.activeElement !== document.body) return;
    // Focus-handoff popups (overlay pane search): while the OVERLAY webview
    // legitimately holds OS focus, appWindowFocused stays true via
    // overlayFocused — but the activeElement guard above only sees THIS
    // document, not the overlay's focused <input>. Without this check the
    // appWindowFocused dip-and-recover (webview blur → overlay:focus lands
    // over the bus) re-ran this effect and yanked Win32 focus back to the
    // pane the instant the search bar opened.
    if (useAppStore.getState().overlayFocused) return;
    void nativeTermFocusKeyboard(termId).catch(() => {});
  }, [termId, isActive, appWindowFocused]);

  // ── PTY hookup ────────────────────────────────────────────────────────
  // Native mode: bytes route to Rust via R's pty_route::sender_for(id)
  // branch in pty.rs. The JS-side onData channel stays live during rollout
  // (plan hard requirement) — we just don't write into a JS renderer.
  const handlePtyData = useCallback((data: Uint8Array) => {
    // Native side RENDERS bytes directly via the attached pty_id, but the
    // JS onData channel is still the tap for cross-cutting consumers that
    // must see raw output regardless of renderer:
    //   1. Registered data listeners (dev-server port/URL/error/stopped
    //      detection registers one via registerTerminalDataListener) — without
    //      this forward, dev-server native panes never leave "starting".
    //   2. Terminal-activity signal ("AI working" WIP badge, git auto-refresh,
    //      ai-time tracking) — recordTerminalActivity below. Note: the Rust
    //      side ALSO emits a coalesced `data_rate` event we subscribe to, but
    //      forwarding here keeps the listener contract identical to xterm.
    getTerminalDataListener(terminalId)?.(data);
    // Terminal-activity signal: feeds the per-tab "AI working" WIP badge, git
    // auto-refresh, and ai-time tracking. recordTerminalActivity self-gates to
    // AI CLI types and honors the write/resize lockouts set below (so the
    // user's own echo and resize redraws don't read as AI output).
    recordTerminalActivity(terminalId, terminalTypeRef.current, data.length);
    // This channel is also the "PTY is alive" signal: on first data from a
    // resumable CLI, look up the session ID from disk — mirrors
    // TerminalPaneXterm's initial detection (same floor, atomic claim, and
    // retry semantics; do not diverge from the xterm guards).
    if (!sessionLookupDone.current && supportsSessionResume(terminalTypeRef.current) && !sessionResumeIdPropRef.current) {
      sessionLookupDone.current = true;
      // Session files with startedAt < this belong to a DIFFERENT pane or
      // instance. 2s cushion for clock skew + early sidecar write.
      ptySpawnTimeRef.current = Date.now() - 2000;

      // IDs that failed atomic claim (another pane claimed between invoke
      // and claim) — excluded on retries so the backend returns new results.
      const skippedIds = new Set<string>();

      const lookupSession = async (): Promise<boolean> => {
        try {
          const sshServerId = serverIdRef.current;
          const isSsh = !!sshServerId;
          const backendNow = isSsh
            ? "ssh"
            : (backendRef.current ?? useAppStore.getState().terminalBackend ?? "wsl");
          const type = terminalTypeRef.current;
          const excludeIds = [...claimedSessionIds, ...skippedIds];
          let id: string | null = null;

          // Precise spawn-based detection for Claude via ~/.claude/sessions
          // sidecars (cwd + startedAt). Only sessions started AFTER this
          // pane spawned. Skipped for SSH (sidecars aren't mirrored remotely).
          if (type === "claude" && !isSsh) {
            try {
              id = await lookupClaudeBySpawn(backendNow, workingDirRef.current, ptySpawnTimeRef.current, excludeIds, "initial-native");
              if (id) {
                console.log(`[SessionResume] native precise (spawn-based) match: ${id.slice(0, 8)}`);
              }
            } catch (e) {
              console.warn("[SessionResume] native spawn-based lookup failed, falling back:", e);
            }
            if (id) {
              if (!claimSessionId(id)) {
                skippedIds.add(id);
                id = null;
              } else {
                setSessionTrusted(true);
                sessionResumeIdPropRef.current = id;
                onSessionResumeIdRef.current?.(id);
                return true;
              }
            }
          }

          // Fallback: mtime-based lookup. Claude limited to sessions touched
          // within the last 2 minutes so old sessions are never claimed.
          const claudeMaxAge = type === "claude" ? 120 : undefined;

          if (isSsh) {
            const server = useAppStore.getState().servers.find((s) => s.id === sshServerId);
            const remoteCwd = workingDirRef.current;
            if (!server || !remoteCwd) return false;
            if (server.authMethod !== "ssh-key" || !server.sshKeyPath) return false;
            const sshArgs = {
              host: server.host,
              username: server.username,
              identityFile: server.sshKeyPath,
              remoteProjectPath: remoteCwd,
              excludeIds,
            };
            if (type === "claude") {
              id = await invoke<string | null>("get_claude_session_id_ssh", { ...sshArgs, maxAgeSecs: claudeMaxAge });
            } else if (type === "codex") {
              id = await invoke<string | null>("get_codex_session_id_ssh", { ...sshArgs, maxAgeSecs: null });
            } else if (type === "gemini") {
              id = await invoke<string | null>("get_gemini_session_id_ssh", { ...sshArgs, maxAgeSecs: null });
            }
          } else if (backendNow === "native") {
            const nativeCwd = workingDirRef.current;
            if (!nativeCwd) return false;
            if (type === "claude") {
              id = await invoke<string | null>("get_claude_session_id_native", { projectPath: nativeCwd, excludeIds, maxAgeSecs: claudeMaxAge });
            } else if (type === "codex") {
              id = await invoke<string | null>("get_codex_session_id_native", { projectPath: nativeCwd, excludeIds });
            } else if (type === "gemini") {
              id = await invoke<string | null>("get_gemini_session_id_native", { projectPath: nativeCwd, excludeIds });
            }
          } else if (backendNow === "windows") {
            const winCwd = workingDirRef.current;
            if (!winCwd) return false;
            if (type === "claude") {
              id = await invoke<string | null>("get_claude_session_id_windows", { projectPath: winCwd, excludeIds, maxAgeSecs: claudeMaxAge });
            } else if (type === "codex") {
              id = await invoke<string | null>("get_codex_session_id_windows", { projectPath: winCwd, excludeIds });
            } else if (type === "gemini") {
              id = await invoke<string | null>("get_gemini_session_id_windows", { projectPath: winCwd, excludeIds });
            }
          } else {
            const wslCwd = toWslPath(workingDirRef.current);
            if (!wslCwd) return false;
            if (type === "claude") {
              id = await invoke<string | null>("get_claude_session_id", { projectPath: wslCwd, excludeIds, maxAgeSecs: claudeMaxAge });
            } else if (type === "codex") {
              id = await invoke<string | null>("get_codex_session_id", { projectPath: wslCwd, excludeIds });
            } else if (type === "gemini") {
              id = await invoke<string | null>("get_gemini_session_id", { projectPath: wslCwd, excludeIds });
            }
          }

          console.log(`[SessionResume] native ${type} lookup result: id=${id}`);
          if (id) {
            if (!claimSessionId(id)) {
              console.log(`[SessionResume] ${id.slice(0, 8)} already claimed by another pane`);
              skippedIds.add(id);
              return false;
            }
            setSessionTrusted(true);
            // Eagerly update the ref so a re-render before the persisted
            // prop lands doesn't re-arm detection.
            sessionResumeIdPropRef.current = id;
            onSessionResumeIdRef.current?.(id);
            return true;
          }
        } catch (e) {
          console.error(`[SessionResume] native disk lookup failed:`, e);
        }
        return false;
      };

      // Retry schedule mirrors xterm: 5s, 20s, then 60s × 10 (~10.5 min).
      const RETRY_DELAYS_MS = [5_000, 20_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000];
      let attempt = 0;
      let timerId: ReturnType<typeof setTimeout> | null = null;
      const scheduleNext = () => {
        if (attempt >= RETRY_DELAYS_MS.length) return;
        const delay = RETRY_DELAYS_MS[attempt++];
        timerId = setTimeout(async () => {
          timerId = null;
          if (await lookupSession()) return;
          scheduleNext();
        }, delay);
      };
      sessionRetryCancelRef.current?.();
      sessionRetryCancelRef.current = () => {
        if (timerId !== null) {
          clearTimeout(timerId);
          timerId = null;
        }
        attempt = RETRY_DELAYS_MS.length;
      };
      scheduleNext();
    }
  }, []);

  const handlePtyExit = useCallback(
    (code: number) => {
      // Mirror TerminalPaneXterm.handlePtyExit (~:606-612): flag exit (gates
      // input + shows the banner), stop the "AI working" activity badge from
      // spinning forever, and cancel any in-flight session-lookup retries.
      setExited(true);
      clearTerminalActivity(terminalId);
      sessionRetryCancelRef.current?.();
      onPtyExit?.(code);
    },
    [onPtyExit, terminalId],
  );

  const { write: ptyWrite } = usePtyNative({
    terminalType,
    terminalId,
    workingDir,
    cols,
    rows,
    onData: handlePtyData,
    onExit: handlePtyExit,
    serverId,
    sessionResumeId,
    ready: termId != null,
    restartKey,
    backend,
    attachTo: termId,
  });

  // ── PTY-write registry (legacy-pane parity) ───────────────────────────
  // External actions reach the active terminal through `getPtyWrite(id)`:
  // clipboard-image insert (topbar strip / paste), snippets, command
  // history, dev-server key sends, AI-explain, etc. The xterm pane
  // registers `write`; the native pane must register its own `ptyWrite`
  // (forwards bytes to the attached PTY) or ALL of those silently no-op on
  // native panes (the reported "paste image does nothing"). Gated on
  // termId so the write only registers once the PTY is actually attached.
  useEffect(() => {
    if (termId == null) return;
    registerPtyWrite(terminalId, ptyWrite);
    return () => unregisterPtyWrite(terminalId);
  }, [terminalId, termId, ptyWrite]);

  // Focus registry: external actions (e.g. returning focus to the pane
  // after an image insert) call `getTerminalFocus(id)`. Route it to the
  // native HWND keyboard-focus command (guarded activeElement check lives
  // Rust-side / in the dedicated focus effect; this is the explicit
  // external-request path, same contract as the xterm pane's `.focus()`).
  useEffect(() => {
    if (termId == null) return;
    const id = termId;
    registerTerminalFocus(terminalId, () => {
      void nativeTermFocusKeyboard(id).catch(() => {});
    });
    return () => unregisterTerminalFocus(terminalId);
  }, [terminalId, termId]);

  // ── Hole-cut driver ───────────────────────────────────────────────────
  // Reads globally-published overlay rects from `overlayRegionSlice`,
  // intersects each with this pane's bounding rect, and emits pane-local
  // holes via `native_term_set_region` every rAF (with no-change skip).
  // Slice-sourced variant: no overlayRefs prop drilling needed.
  // MUST be the ANCHOR div (terminalDivRef), not the outer paneDivRef: the
  // native HWND is positioned over the anchor's rect, and Rust interprets
  // holes relative to the WINDOW origin. Converting against paneDivRef
  // (which includes the 30px in-flow header) shifted every hole 30px down —
  // popups lost their top band behind terminal pixels.
  useNativePaneRegion({ termId: termId ?? 0, paneRef: terminalDivRef });

  // ── Focus delegation ──────────────────────────────────────────────────
  const onPaneClick = useCallback(() => {
    if (!isActive) onFocus();
  }, [isActive, onFocus]);

  // ── PromptComposer handlers ───────────────────────────────────────────
  const composerWrite = useCallback(
    (data: string) => {
      // User-originated write: lock out the activity tracker briefly so the
      // shell's echo of this input doesn't register as AI output.
      recordTerminalWrite(terminalId);
      ptyWrite(data);
    },
    [ptyWrite, terminalId],
  );
  // Legacy-pane parity (was a no-op → composer submits sent NOTHING on
  // native panes): PromptComposer.submit() records history + calls onSubmit
  // but never writes the prompt body itself — the parent's onSubmit is the
  // actual PTY write. Mirror TerminalPaneXterm.handleComposerSubmit exactly,
  // using ptyWrite. CLI TUIs (claude/codex/gemini) need bracketed paste + a
  // length-scaled delayed Enter so the REPL ingests the whole prompt before
  // the carriage return (otherwise long prompts land as "[Text #N]").
  const handleComposerSubmit = useCallback(
    (text: string) => {
      recordTerminalWrite(terminalId);
      const isCli =
        terminalType === "claude" ||
        terminalType === "codex" ||
        terminalType === "gemini";
      if (isCli) {
        const content = text + (terminalType === "gemini" ? " " : "");
        const baseDelay = terminalType === "claude" ? 150 : 80;
        const extraDelay =
          terminalType === "claude"
            ? Math.min(Math.max(0, content.length - 200), 1850)
            : 0;
        const pasteDelay = baseDelay + extraDelay;
        ptyWrite("\x1b[200~" + content + "\x1b[201~");
        setTimeout(() => ptyWrite("\r"), pasteDelay);
      } else {
        ptyWrite(text + "\r");
      }
    },
    [ptyWrite, terminalId, terminalType],
  );
  const handleComposerClose = useCallback(() => {
    setComposerOpen(false);
  }, []);

  // ── Native command blocks + file links ────────────────────────────────
  const { commandBlocks, promptLines } = useNativeCommandBlocks(termId);
  const { hover: fileLinkHover } = useNativeFileLinks({ termId, workingDir });

  // ── Scroll-to-prompt / scroll-to-next-prompt (S10, xterm parity) ──────
  // PgUp/PgDn in PromptComposer jump between prompts. Prompt positions come
  // from OSC 133;A `absLine` values in `promptLines` (scrollback-origin
  // space, 0 = oldest buffered line). nativeTermScrollToLine and
  // ViewportState.viewportY both use alacritty's SIGNED space
  // ([-history, screen); 0 = live bottom, negative = scrollback), so each
  // prompt maps to signed = absLine + baseY (baseY = -history) — the exact
  // conversion the prompt-cache + header scroll-to-prompt-line path already
  // use. promptLines is read through a ref so the callbacks keep a stable
  // identity for PromptComposer (which the stubs also had). Best-effort:
  // a torn-down pane racing the async viewport read is swallowed.
  const promptLinesRef = useRef<number[]>([]);
  promptLinesRef.current = promptLines;

  const handleScrollToPrompt = useCallback(() => {
    if (termId == null) return;
    void (async () => {
      try {
        const vp = await nativeTermGetViewportState(termId);
        const signed = promptLinesRef.current
          .map((a) => a + vp.baseY)
          .sort((x, y) => x - y);
        if (signed.length === 0) return;
        // Nearest prompt strictly ABOVE the viewport top edge; if none is
        // above, wrap to the most-recent prompt (mirrors xterm scrollToPrompt
        // "all prompts at/below viewport → scroll to the last one").
        let target: number | null = null;
        for (let i = signed.length - 1; i >= 0; i--) {
          if (signed[i] < vp.viewportY) {
            target = signed[i];
            break;
          }
        }
        if (target == null) target = signed[signed.length - 1];
        await nativeTermScrollToLine(termId, target);
      } catch {
        // Benign race: pane torn down mid-invoke.
      }
    })();
  }, [termId]);

  const handleScrollToNextPrompt = useCallback(() => {
    if (termId == null) return;
    void (async () => {
      try {
        const vp = await nativeTermGetViewportState(termId);
        const signed = promptLinesRef.current
          .map((a) => a + vp.baseY)
          .sort((x, y) => x - y);
        if (signed.length === 0) return;
        // First prompt at/below the viewport top + 2 (the +2 skips the prompt
        // currently pinned to the top after a jump — mirrors xterm
        // scrollToNextPrompt). No prompt below → snap to the live bottom.
        const threshold = vp.viewportY + 2;
        const next = signed.find((s) => s >= threshold);
        if (next != null) {
          await nativeTermScrollToLine(termId, next);
        } else {
          await nativeTermScrollToBottom(termId);
        }
      } catch {
        // Benign race: pane torn down mid-invoke.
      }
    })();
  }, [termId]);

  // ── Command-history recording (S8, xterm parity ~:1556-1578) ──────────
  // Feed completed native command blocks into the shared history store so
  // the command palette / history view sees shell runs from native panes
  // too. Deduped by block id via recordedBlocksRef so re-renders (and the
  // async command/output backfill in useNativeCommandBlocks) never double-
  // record. NATIVE DIVERGENCE: a native block is first pushed with an empty
  // `command` (exitCode already set at OSC 133;D) and the real command text
  // is backfilled asynchronously; we therefore wait for a non-empty command
  // before recording (and only then mark it recorded) so history never gets
  // a blank entry. Trade-off: a block whose backfill never resolves is
  // dropped rather than logged empty — acceptable (xterm always has the
  // command synchronously, so it doesn't hit this).
  const recordedBlocksRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const addHistoryEntry = useAppStore.getState().addHistoryEntry;
    const tabs = useAppStore.getState().tabs;
    const tab = tabs.find((t) =>
      t.layout?.type === "terminal" ? t.layout.terminalId === terminalId : false,
    );
    const tabName = tab?.name ?? "Shell";

    for (const block of commandBlocks) {
      if (
        block.exitCode !== null &&
        block.command &&
        !recordedBlocksRef.current.has(block.id)
      ) {
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

  // ── PaneSearchBar handlers ────────────────────────────────────────────
  const handleSearchClose = useCallback(() => {
    setSearchOpen(false);
    setSearchResult(null);
    if (termId != null) {
      void nativeTermSearchClear(termId).catch(() => {});
    }
  }, [termId]);

  const runSearch = useCallback(
    (direction: "forward" | "backward") => {
      if (termId == null || searchQuery.length === 0) {
        setSearchResult(null);
        return;
      }
      nativeTermSearch(
        termId,
        searchQuery,
        {
          caseSensitive: searchCaseSensitive,
          regex: searchRegex,
          wholeWord: searchWholeWord,
        },
        direction,
      )
        .then((r) => {
          setSearchResult(r);
          // Push rects to the renderer so the highlight overlay draws.
          // Best-effort: a destroyed pane racing this call is benign.
          void nativeTermSetSearchHighlights(termId, r.rects).catch(() => {});
          // D-review: bring the active match into the viewport — the
          // renderer clips off-viewport rects by design, so without this
          // Find Next/Prev against a scrollback match updated the counter
          // while visibly doing nothing. activeLine is Rust-computed in
          // the same signed space nativeTermScrollToLine consumes.
          if (r.activeIndex >= 0) {
            void nativeTermScrollToLine(termId, r.activeLine).catch(() => {});
          }
        })
        .catch(() => setSearchResult(null));
    },
    [termId, searchQuery, searchCaseSensitive, searchRegex, searchWholeWord],
  );
  const onSearchNext = useCallback(() => runSearch("forward"), [runSearch]);
  const onSearchPrev = useCallback(() => runSearch("backward"), [runSearch]);

  // PaneSearchBar wants { index, count } — translate from SearchResult.
  const searchMatchInfo = useMemo(
    () =>
      searchResult
        ? { index: searchResult.activeIndex, count: searchResult.total }
        : null,
    [searchResult],
  );

  // Pane search — overlay-rendered (kind "pane-search", focus handoff). The
  // input lives in the OVERLAY (it needs real keyboard focus, which the
  // NOACTIVATE overlay only takes while this popup is open); search state +
  // the Rust search backend stay here. Query text streams back as the
  // "query" action; toggles/nav bounce as actions and update the payload.
  useOverlayPopupAnchor({
    id: `pane-search-${terminalId}`,
    kind: "pane-search",
    open: searchOpen,
    anchorRef: terminalDivRef,
    payload: searchOpen
      ? {
          caseSensitive: searchCaseSensitive,
          regex: searchRegex,
          wholeWord: searchWholeWord,
          hasMatchInfo: searchMatchInfo != null,
          matchIndex: searchMatchInfo?.index ?? 0,
          matchCount: searchMatchInfo?.count ?? 0,
          focusBump: searchFocusBump,
        }
      : null,
    onAction: (action, data) => {
      switch (action) {
        case "query":
          setSearchQuery(((data as { q?: string } | undefined)?.q ?? ""));
          break;
        case "next":
          onSearchNext();
          break;
        case "prev":
          onSearchPrev();
          break;
        case "toggle-case":
          setSearchCaseSensitive((v) => !v);
          break;
        case "toggle-regex":
          setSearchRegex((v) => !v);
          break;
        case "toggle-word":
          setSearchWholeWord((v) => !v);
          break;
        case "close":
          handleSearchClose();
          // Focus handoff back: the overlay just released the foreground;
          // return the keyboard to this pane (guarded by isActive per the
          // background-focus-theft rule).
          if (isActive && termId != null) {
            void nativeTermFocusKeyboard(termId).catch(() => {});
          }
          break;
      }
    },
  });

  // Register this pane's "open search" callback so the central Ctrl+F handler
  // in App.tsx can reach us (matches xterm pane behavior).
  useEffect(() => {
    registerPaneSearch(terminalId, () => {
      setSearchOpen(true);
      setSearchFocusBump((n) => n + 1);
    });
    return () => unregisterPaneSearch(terminalId);
  }, [terminalId]);

  // ── Clipboard image paste ─────────────────────────────────────────────
  // Native HWND captures most paste events directly, but mount the hook so
  // any pastes that reach the React container (e.g. focus outside HWND) work.
  const { pastedImage, dismissPreview } = useClipboardImagePaste({
    containerRef: terminalDivRef,
    terminalRef: nullTerminalRef,
    terminalType,
    terminalId,
    write: composerWrite,
    exited,
    onFocus,
  });

  // Auto-dismiss image preview after 8 seconds (matches xterm pane).
  useEffect(() => {
    if (!pastedImage) return;
    const timer = setTimeout(dismissPreview, 8000);
    return () => clearTimeout(timer);
  }, [pastedImage, dismissPreview]);

  // "Image pasted" preview card — overlay-rendered above the native pane
  // (kind "clipboard-image-preview"; thumbnail crosses the bus as data: URI).
  useOverlayPopupAnchor({
    id: `clipboard-image-preview-${terminalId}`,
    kind: "clipboard-image-preview",
    open: !!pastedImage,
    anchorRef: terminalDivRef,
    payload: pastedImage
      ? {
          thumbnailUrl: pastedImage.thumbnailUrl,
          filePath: pastedImage.filePath,
        }
      : null,
    onAction: (action) => {
      if (action === "dismiss") dismissPreview();
    },
  });

  // ── TerminalHeader props ──────────────────────────────────────────────
  // Context bar (model / context % / cost) is fed by the session poll above
  // once this pane locks its own session; prompt history comes from the
  // OSC 133 prompt-line cache below.
  const handleClose = useCallback(() => onClose(), [onClose]);
  const handleRestart = useCallback(() => {
    // Restart not yet implemented for native panes — would tear down the PTY
    // and respawn. For now, just close the pane and let the user reopen.
    onClose();
  }, [onClose]);
  const handleSwitchSession = useCallback(
    (sid: string | undefined) => {
      // Claim bookkeeping parity with TerminalPaneXterm.handleSwitchSession:
      // an explicit switch is trusted; release the old claim, then either
      // claim the new ID or re-arm auto-detection for a fresh session.
      setSessionTrusted(!!sid);
      if (sessionResumeIdPropRef.current) {
        claimedSessionIds.delete(sessionResumeIdPropRef.current);
      }
      if (sid) {
        claimedSessionIds.add(sid);
        sessionRetryCancelRef.current?.();
        sessionLookupDone.current = true;
      } else {
        sessionRetryCancelRef.current?.();
        sessionLookupDone.current = false;
      }
      setContextInfo(null);
      onSwitchSession?.(sid);
      // Eagerly update the ref so the PTY spawn reads the correct session ID
      // before React delivers the prop update.
      sessionResumeIdPropRef.current = sid;
      // Run E review fix: actually respawn the PTY (xterm parity). Without
      // this the claim/trust bookkeeping above changes the header while the
      // running CLI stays on the OLD session — prompts would go to a session
      // the header no longer shows, and the released old ID becomes
      // stealable by other panes while still live. The bump re-runs
      // usePtyNative's spawn effect: cleanup detaches the native term +
      // kills the old PTY, then a fresh spawn (with the new --resume flag)
      // re-attaches — Rust creates a new Term, so old buffer content drops.
      setRestartKey((k) => k + 1);
    },
    [onSwitchSession],
  );
  // Prompt-entry cache: keyed by absolute line, populated lazily on
  // getPromptEntries() calls. Avoids re-fetching the same buffer line per
  // render. New OSC 133;A events show up in `promptLines`; lines not yet
  // in the cache are fetched and merged into the cache (and the resulting
  // entries returned via the ref so the next getPromptEntries() call sees
  // them without another await).
  const promptEntriesRef = useRef<PromptEntry[]>([]);
  const promptCacheRef = useRef<Map<number, PromptEntry>>(new Map());
  const inflightLinesRef = useRef<Set<number>>(new Set());
  const [, bumpPromptCache] = useState(0);

  useEffect(() => {
    if (termId == null) return;
    const cache = promptCacheRef.current;
    const inflight = inflightLinesRef.current;
    const needs = promptLines.filter(
      (line) => !cache.has(line) && !inflight.has(line),
    );

    // Track which prompt-lines came from a command block (so we can mark
    // fromComposer=false reliably; future composer-originated entries can
    // set true). Currently all native-detected prompts are non-composer.
    void commandBlocks;

    if (needs.length === 0) {
      // Rebuild the array even if nothing was fetched — promptLines may
      // have shrunk (e.g. term reset).
      promptEntriesRef.current = promptLines
        .map((line) => cache.get(line))
        .filter((e): e is PromptEntry => !!e);
      return;
    }

    let cancelled = false;
    (async () => {
      // D-review coordinate fix: promptLines hold OSC 133 absLine values
      // (scrollback-origin space, 0 = oldest buffered line) while
      // nativeTermGetBufferLines takes alacritty's SIGNED space
      // [-history, screen) — map through the LIVE baseY (= -history) at
      // fetch time or every read returns empty once history exists. The
      // cache stays keyed by absLine (stable identifier).
      let baseY = 0;
      try {
        baseY = (await nativeTermGetViewportState(termId)).baseY;
      } catch {
        // No PTY attached yet — keep 0 (fresh pane, no history).
      }
      if (cancelled) return;
      for (const line of needs) {
        inflight.add(line);
        try {
          const lines = await nativeTermGetBufferLines(
            termId,
            line + baseY,
            line + baseY + 1,
          );
          if (cancelled) return;
          const text = (lines[0] ?? "").trimEnd();
          cache.set(line, { line, text, fromComposer: false });
        } catch {
          // Mark with empty text so we don't refetch indefinitely.
          cache.set(line, { line, text: "", fromComposer: false });
        } finally {
          inflight.delete(line);
        }
      }
      if (cancelled) return;
      promptEntriesRef.current = promptLines
        .map((line) => cache.get(line))
        .filter((e): e is PromptEntry => !!e);
      // Bump a state counter so TerminalHeader (which calls getPromptEntries
      // on each render via onRefreshContext) re-reads. Cheap — just an int.
      bumpPromptCache((n) => n + 1);
    })();

    return () => {
      cancelled = true;
    };
  }, [termId, promptLines, commandBlocks]);

  const getPromptEntries = useCallback(
    (): PromptEntry[] => promptEntriesRef.current,
    [],
  );
  const handleScrollToPromptLine = useCallback(
    (line: number) => {
      if (termId == null) return;
      // D-review coordinate fix: `line` is an OSC 133 absLine
      // (scrollback-origin space); nativeTermScrollToLine takes alacritty's
      // SIGNED space where 0 = bottom of the live screen. Convert through
      // the live baseY (= -history) at CLICK time — passing the raw
      // positive value clamped to offset 0 and jumped to the bottom
      // instead of the prompt.
      void (async () => {
        try {
          const vp = await nativeTermGetViewportState(termId);
          await nativeTermScrollToLine(termId, line + vp.baseY);
        } catch {
          // Benign race: pane torn down mid-invoke.
        }
      })();
    },
    [termId],
  );
  const refreshContext = useCallback((): void => {
    // TerminalHeader passes its internal "refresh" callback through this
    // prop. We stash it so the prompt-cache async loop can trigger it
    // after a fetch resolves.
    // (No-op when called directly — actual nudges flow via the ref above.)
  }, []);

  return (
    <div
      ref={paneDivRef}
      onClick={onPaneClick}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        minWidth: 0,
      }}
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
          serverId={serverId}
          isYolo={false}
          contextInfo={contextInfo}
          workingDir={workingDir}
          backend={backend}
          sessionResumeId={sessionResumeId}
          sessionTrusted={sessionTrusted}
          onSwitchSession={handleSwitchSession}
          getPromptEntries={getPromptEntries}
          onScrollToPromptLine={handleScrollToPromptLine}
          onRefreshContext={refreshContext}
        />
      )}
      {/* Terminal anchor — R's HWND positions itself over this div's bounding rect. */}
      <div
        ref={terminalDivRef}
        data-native-term-anchor
        data-pane-id={terminalId}
        data-terminal-id={terminalId}
        style={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          position: "relative",
          background: "transparent",
        }}
      />
      {/* IME pre-edit overlay. Subscribes to ime_composition + cursor
          directly so cursor moves don't re-render the whole pane. */}
      {termId != null && (
        // terminalDivRef, NOT paneDivRef: caret coords are grid-relative and
        // the native HWND covers the anchor div (paneDivRef adds the 30px
        // in-flow header — same off-by-header trap as the hole-cut driver).
        <ImeCompositionPopup termId={termId} paneRef={terminalDivRef} />
      )}
      {/* File-link tooltip — shown on cell_hover when the hovered text
          matches a file path. Publishes its rect via useOverlayPublisher
          so the native HWND cuts a hole and the tooltip is visible above
          WebView2. Click-to-open uses the existing Rust-side Ctrl+click
          flow on OSC 8 hyperlinks; this tooltip is display-only. */}
      {termId != null && (
        // terminalDivRef for the same grid-origin reason as the IME popup.
        <FileLinkTooltip
          termId={termId}
          hover={fileLinkHover}
          paneRef={terminalDivRef}
          cellW={cellMetrics?.w}
          cellH={cellMetrics?.h}
        />
      )}
      {/* Pane search — overlay-rendered with FOCUS HANDOFF (the overlay
          becomes focusable while the bar hosts the input; see the
          "pane-search" kind hook above). The last hole-cut user is gone. */}
      {/* ClipboardImagePreview — overlay-rendered (hook below the paste hook). */}
      {/* PromptComposer — AI CLI prompt input. Internal effects guard on
          null terminal; cursor/buffer-dependent features are inert until
          R3 surfaces a Rust-backed terminal shim. */}
      {composerOpen && !hideChrome && composerSupported && (
        <PromptComposer
          onSubmit={handleComposerSubmit}
          onClose={handleComposerClose}
          write={composerWrite}
          alwaysVisible={composerAlwaysVisible}
          terminalBg={theme.terminal.background ?? "#0d1117"}
          terminalFg={theme.terminal.foreground ?? "#e6edf3"}
          terminalCursor={theme.terminal.cursor ?? "#58a6ff"}
          fontSize={cliFontSize}
          containerRef={terminalDivRef}
          terminal={null}
          terminalId={terminalId}
          terminalType={terminalType}
          workingDir={workingDir}
          scrollToPrompt={handleScrollToPrompt}
          scrollToNextPrompt={handleScrollToNextPrompt}
          isActive={isActive}
          didStealRef={composerDidStealRef}
          suppressAutoFocus={false}
        />
      )}
      {/* Process-exited banner, jump-to-bottom button and clipboard-image
          preview are overlay-rendered (useOverlayPopupAnchor hooks above) —
          no DOM here, no hole cut. */}
    </div>
  );
}
