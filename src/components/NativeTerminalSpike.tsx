import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import {
  nativeTermCreate,
  nativeTermDebugStats,
  nativeTermDestroy,
  nativeTermResize,
  rectOf,
  type CreateOpts,
  type DebugStats,
  type NativeTermId,
  type Rect,
} from "../lib/native-term-bridge";
import { RegionDriver } from "../native-term/RegionDriver";
import { useAnimatedOverlay } from "../native-term/useAnimatedOverlay";
import { TERMINAL_FONT_FAMILY } from "../lib/terminal-fonts";

const PANE_WIDTH = 800;
const PANE_HEIGHT = 500;
const SPAWN_PTY = true; // R1.c live verification: attach a real shell PTY
const PTY_COLS = 80;
const PTY_ROWS = 24;

// P7a: the debug page now uses the production `native_term_create`, which
// requires a full CreateOpts. Mirror the Rust-side Tango defaults the old
// spike_create relied on (renderer/mod.rs ThemeColors::default_tango) so the
// smoke test renders identically. focused: true because this page is
// single-pane with no activation model — the cursor should always blink.
function defaultCreateOpts(rect: Rect, dpr: number): CreateOpts {
  return {
    rect,
    dpr,
    theme: {
      background: "#0d0d11",
      foreground: "#d3d7cf",
      cursor: "#dbd6cf",
      cursorAccent: "#0d0d11",
      selection: "#44556b",
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
    },
    font: { family: TERMINAL_FONT_FAMILY, sizePx: 14 },
    cursorStyle: "block",
    cursorBlink: true,
    scrollback: 10000,
    focused: true,
  };
}

export default function NativeTerminalSpike() {
  const paneDivRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [termId, setTermId] = useState<NativeTermId | null>(null);
  const [stats, setStats] = useState<DebugStats | null>(null);

  // P0 perf instrumentation: poll the native pane's debug counters once per
  // second while a term exists. Read-only — no effect on render scheduling.
  useEffect(() => {
    if (termId == null) return;
    let disposed = false;
    const tick = () => {
      nativeTermDebugStats(termId)
        .then((s) => {
          if (!disposed) setStats(s);
        })
        .catch(() => {
          /* pane may be mid-teardown — benign */
        });
    };
    tick();
    const interval = window.setInterval(tick, 1000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [termId]);

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
          const id = await nativeTermCreate(
            defaultCreateOpts(rectOf(el), window.devicePixelRatio),
          );
          if (cancelled) {
            nativeTermDestroy(id).catch(() => {});
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
      nativeTermResize(createdId, rectOf(el), window.devicePixelRatio).catch(
        () => {},
      );
    });
    ro.observe(el);

    const onWinChange = () => {
      if (createdId == null || !el.isConnected) return;
      nativeTermResize(createdId, rectOf(el), window.devicePixelRatio).catch(
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
        nativeTermDestroy(createdId).catch(() => {});
      }
    };
  }, []);

  return (
    <>
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
    {/* P0 debug stats readout. Sits BELOW the pane rect so the native HWND
        never occludes it (no region hole needed). Plain neutral text —
        default font + tabular-nums per the UI rules (no font-mono at small
        sizes, no amber/yellow/blue, no animation). */}
    {termId != null && stats != null && (
      <div
        style={{
          position: "fixed",
          top: 80 + PANE_HEIGHT + 8,
          left: 80,
          width: PANE_WIDTH,
          color: "#a3a3a3",
          fontFamily: "system-ui, sans-serif",
          fontSize: 11,
          lineHeight: 1.5,
          fontVariantNumeric: "tabular-nums",
          zIndex: 99998,
          pointerEvents: "none",
        }}
      >
        <div>
          frames {stats.framesRendered} (skipped clean{" "}
          {stats.framesSkippedClean}) | frame cpu{" "}
          {stats.lastFrameCpuMs.toFixed(2)}ms (ewma{" "}
          {stats.frameCpuMsEwma.toFixed(2)}ms) | configures {stats.configures}{" "}
          | wakes {stats.wakesPosted} posted / {stats.wakesCoalesced} coalesced
        </div>
        <div>
          {stats.attached ? "attached" : "detached"} |{" "}
          {stats.visible ? "visible" : "hidden"} | cell{" "}
          {stats.cellWPx.toFixed(1)}x{stats.cellHPx.toFixed(1)}px | dpr{" "}
          {stats.dpr} | surface {stats.surfaceW}x{stats.surfaceH}px | pane{" "}
          {stats.paneW}x{stats.paneH}px
        </div>
      </div>
    )}
    </>
  );
}
