import { useLayoutEffect, useRef, useState } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import {
  nativeTermSpikeCreate,
  nativeTermSpikeDestroy,
  nativeTermSpikeResize,
  rectOf,
  type NativeTermId,
} from "../lib/native-term-bridge";
import { RegionDriver } from "../native-term/RegionDriver";
import { useAnimatedOverlay } from "../native-term/useAnimatedOverlay";

const PANE_WIDTH = 800;
const PANE_HEIGHT = 500;
const SPAWN_PTY = true; // R1.c live verification: attach a real shell PTY
const PTY_COLS = 80;
const PTY_ROWS = 24;

export default function NativeTerminalSpike() {
  const paneDivRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [termId, setTermId] = useState<NativeTermId | null>(null);

  useAnimatedOverlay({
    overlayRef,
    originX: 32,
    originY: 32,
    amplitudePx: 50,
    periodMs: 2000,
  });

  useLayoutEffect(() => {
    const el = paneDivRef.current;
    if (!el) return;
    let cancelled = false;
    let createdId: NativeTermId | null = null;
    let ptyId: number | null = null;
    let raf2Id = 0;

    const raf1 = requestAnimationFrame(() => {
      raf2Id = requestAnimationFrame(async () => {
        if (cancelled) return;
        try {
          const id = await nativeTermSpikeCreate({
            rect: rectOf(el),
            dpr: window.devicePixelRatio,
          });
          if (cancelled) {
            nativeTermSpikeDestroy(id).catch(() => {});
            return;
          }
          createdId = id;
          setTermId(id);

          if (SPAWN_PTY) {
            // Spawn a cmd.exe PTY and attach it to the native term. The JS
            // Channels here just discard data — Rust's pty_route side-channel
            // routes bytes directly to the parser bridge worker thread.
            const onData = new Channel<number[]>();
            onData.onmessage = () => {
              /* discarded — native side-channel owns routing */
            };
            const onExit = new Channel<number>();
            onExit.onmessage = (code) => {
              console.log("[native-spike] pty exit", code);
            };
            try {
              // PowerShell with PSReadLine emits SGR codes for its prompt
              // (visible verification of the per-cell color pipeline). -NoLogo
              // skips the multi-line startup banner so the prompt appears
              // immediately. cmd.exe emits no SGR by default and would render
              // monochrome regardless of the renderer's color support.
              const spawnedPtyId = await invoke<number>("pty_spawn", {
                command: "powershell.exe",
                args: ["-NoLogo"],
                cols: PTY_COLS,
                rows: PTY_ROWS,
                cwd: null,
                env: { TERM: "xterm-256color", COLORTERM: "truecolor" },
                onData,
                onExit,
              });
              if (cancelled) {
                invoke("pty_kill", { ptyId: spawnedPtyId }).catch(() => {});
                return;
              }
              ptyId = spawnedPtyId;
              await invoke("native_term_attach_pty", {
                id,
                ptyId: spawnedPtyId,
                cols: PTY_COLS,
                rows: PTY_ROWS,
              });
              console.log(
                "[native-spike] PTY attached: term=%d pty=%d (%dx%d)",
                id,
                spawnedPtyId,
                PTY_COLS,
                PTY_ROWS,
              );
              // (SGR inject removed — its bytes raced PowerShell's startup
              // through the same parser channel and confused cursor state
              // during typing tests. Colors are verified separately; this
              // path now exercises only the live shell.)
            } catch (err) {
              console.error("[native-spike] pty spawn/attach failed", err);
            }
          }
        } catch (err) {
          console.error("[native-spike] create failed", err);
        }
      });
    });

    const ro = new ResizeObserver(() => {
      if (createdId == null) return;
      nativeTermSpikeResize(createdId, rectOf(el), window.devicePixelRatio).catch(
        () => {},
      );
    });
    ro.observe(el);

    const onWinChange = () => {
      if (createdId == null || !el.isConnected) return;
      nativeTermSpikeResize(createdId, rectOf(el), window.devicePixelRatio).catch(
        () => {},
      );
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
      if (ptyId != null) {
        invoke("pty_kill", { ptyId }).catch(() => {});
      }
      if (createdId != null) {
        nativeTermSpikeDestroy(createdId).catch(() => {});
      }
    };
  }, []);

  return (
    <div
      ref={paneDivRef}
      style={{
        position: "fixed",
        top: 80,
        left: 80,
        width: PANE_WIDTH,
        height: PANE_HEIGHT,
        border: "1px solid #444",
        background: "transparent",
        pointerEvents: "auto",
        zIndex: 99998,
      }}
    >
      <div ref={anchorRef} style={{ position: "absolute", inset: 0 }} />
      <div
        ref={overlayRef}
        data-native-spike-overlay
        style={{
          position: "absolute",
          left: 32,
          top: 32,
          width: 240,
          height: 80,
          background: "#1f1f1f",
          color: "#fff",
          padding: "8px 12px",
          fontFamily: "system-ui, sans-serif",
          fontSize: 13,
          lineHeight: 1.4,
          zIndex: 10,
        }}
      >
        OVERLAY TEST
        <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>
          termId: {termId ?? "(pending)"}
        </div>
      </div>
      {termId != null && (
        <RegionDriver
          termId={termId}
          paneRef={paneDivRef}
          overlayRef={overlayRef}
        />
      )}
    </div>
  );
}
