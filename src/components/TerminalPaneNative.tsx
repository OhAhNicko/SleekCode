import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import type { TerminalType, TerminalBackend } from "../types";
import type { CommandBlock } from "../lib/command-block-parser";
import {
  type NativeTermId,
  rectOf,
  subscribeResized,
  subscribeExit,
} from "../lib/native-term-bridge";
import { usePtyNative } from "../hooks/usePtyNative";
import type { NativeRendererSlice } from "../store/nativeRendererSlice";

// Until `store/index.ts` (M-list) registers `createNativeRendererSlice`,
// these fields aren't visible on AppStore at the type level. Cast through
// the slice interface. Patch plan in J1 wrap-up adds the slice; the cast
// can be removed afterwards.
type AppStoreWithNative = ReturnType<typeof useAppStore.getState> & NativeRendererSlice;

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
// Until R's full Phase 1 command surface lands (per signature confirmation
// thread), create/resize/destroy use the spike commands as a temporary
// fallback so the selector can be wired in dev mode.

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
  onClose: _onClose,
  onChangeType: _onChangeType,
  onFocus,
  onSwapPane: _onSwapPane,
  onExplainError: _onExplainError,
  onPtyReady,
  onPtyExit,
  hideChrome: _hideChrome,
  serverId,
  sessionResumeId,
  onSessionResumeId: _onSessionResumeId,
  onSwitchSession: _onSwitchSession,
  paneCount: _paneCount = 1,
  backend,
}: TerminalPaneNativeProps) {
  void terminalId;

  const paneDivRef = useRef<HTMLDivElement | null>(null);
  const terminalDivRef = useRef<HTMLDivElement | null>(null);
  const [termId, setTermId] = useState<NativeTermId | null>(null);
  const [cols, setCols] = useState(80);
  const [rows, setRows] = useState(24);
  const [ptyReady, setPtyReady] = useState(false);

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
          // Phase 1: real `native_term_create` lands once R confirms
          // CreateOpts shape. Temporarily using the spike create — the
          // spike command surface and the real one both return u32 and
          // both accept (rect, dpr) — the difference is the optional
          // CreateOpts fields.
          const id = await invoke<NativeTermId>("native_term_spike_create", {
            rect: rectOf(el),
            dpr: window.devicePixelRatio,
          });
          if (cancelled) {
            void invoke("native_term_spike_destroy", { id }).catch(() => {});
            return;
          }
          createdId = id;
          setTermId(id);
          registerNativeTerm(id);
          setPtyReady(true);
        } catch (err) {
          console.error("[TerminalPaneNative] create failed", err);
        }
      });
    });

    const ro = new ResizeObserver(() => {
      if (createdId == null) return;
      void invoke("native_term_spike_resize", {
        id: createdId,
        rect: rectOf(el),
        dpr: window.devicePixelRatio,
      }).catch(() => {});
    });
    ro.observe(el);

    const onWinChange = () => {
      if (createdId == null || !el.isConnected) return;
      void invoke("native_term_spike_resize", {
        id: createdId,
        rect: rectOf(el),
        dpr: window.devicePixelRatio,
      }).catch(() => {});
    };
    window.addEventListener("resize", onWinChange);
    window.addEventListener("scroll", onWinChange, true);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1);
      if (raf2Id) cancelAnimationFrame(raf2Id);
      ro.disconnect();
      window.removeEventListener("resize", onWinChange);
      window.removeEventListener("scroll", onWinChange, true);
      if (createdId != null) {
        unregisterNativeTerm(createdId);
        void invoke("native_term_spike_destroy", { id: createdId }).catch(
          () => {},
        );
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
        setCols(p.cols);
        setRows(p.rows);
      });
      unlistens.push(u1);

      const u2 = await subscribeExit(termId, (p) => {
        if (cancelled) return;
        onPtyExit?.(p.code);
      });
      unlistens.push(u2);

      // Phase 2 wires: osc133 → command-block-parser, selection → clipboard,
      // scroll → jump-to-bottom button, cursor → IME popup, link_hover/click
      // → file-link-provider, key_down_preview → custom-key handlers,
      // ime_composition → ImeCompositionPopup, data_rate → terminal-activity,
      // r_button → GlobalContextMenu, mouse_passthrough → splitter drag.
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

  // ── PTY hookup ────────────────────────────────────────────────────────
  // Native mode: bytes route to Rust via R's pty_route::sender_for(id)
  // branch in pty.rs. The JS-side onData channel stays live during rollout
  // (plan hard requirement) — we just don't write into a JS renderer.
  const handlePtyData = useCallback((_data: Uint8Array) => {
    // No-op: native side consumes bytes directly via the attached pty_id.
    // Phase 2 may surface bytes here for log/recording features.
  }, []);

  const handlePtyExit = useCallback(
    (code: number) => {
      onPtyExit?.(code);
    },
    [onPtyExit],
  );

  usePtyNative({
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
    backend,
    attachTo: termId,
  });

  // ── Focus delegation ──────────────────────────────────────────────────
  const onPaneClick = useCallback(() => {
    if (!isActive) onFocus();
  }, [isActive, onFocus]);

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
      {/* Terminal anchor — R's HWND positions itself over this div's bounding rect. */}
      <div
        ref={terminalDivRef}
        data-native-term-anchor
        data-pane-id={terminalId}
        style={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          position: "relative",
          background: "transparent",
        }}
      />
      {/* Overlay slot: Phase 2 plugs TerminalHeader, PromptComposer,
          PaneSearchBar, CommandBlockOverlay, ClipboardImagePreview,
          jump-to-bottom button here — all read termId + paneDivRef to
          publish their rect into overlayRegionSlice (O's territory) which
          drives the hole-cut. */}
    </div>
  );
}
