// P4b: per-frame IPC coordinator for native-pane geometry + hole regions.
//
// During a splitter drag every native pane's rAF driver used to fire its own
// invoke per change (`native_term_resize` per pane
// PLUS `native_term_set_region` per pane — up to 3+ IPC round-trips in one
// animation frame). This module coalesces all of them into ONE
// `native_term_frame_sync` invoke per frame; the Rust side (P4a) applies the
// window moves in a single BeginDeferWindowPos/EndDeferWindowPos transaction
// so panes flanking a splitter reposition atomically.
//
// Contract:
//   - queueGeom / queueRegion store latest-wins entries keyed by term id;
//     geometry and holes queued for the same id merge into a single entry.
//   - The first queue call arms the flush cycle; at most ONE
//     `native_term_frame_sync` invoke happens per animation frame, and at
//     most one is IN FLIGHT at any time (backpressure — see `inFlight`).
//     If Rust services slower than the display rate, sends self-pace to
//     the service rate instead of backlogging Tauri's command queue.
//   - flushNow() (drag release) flushes whatever is queued immediately.
//   - Failed invokes are swallowed: Rust already logs per-entry failures as
//     benign (stale/destroyed ids race teardown), and a rejection must never
//     throw into a rAF/timer callback.
//   - setDragActive/isDragActive: module-level flag driven by PaneGrid's
//     splitter onDragging (fires only on drag start/end). While true,
//     useNativePaneRegion skips hole recomputation entirely (coarsening);
//     geometry keeps flowing so panes track the splitter every frame.
//
// Scheduling note — why not a bare single-shot requestAnimationFrame:
// every producer is itself a self-re-registering rAF loop (pushGeom in
// TerminalPaneNative, the region tick in useNativePaneRegion), and rAF
// callbacks run in registration order. A flush rAF armed from INSIDE a
// producer callback always lands on the NEXT frame, interleaved among the
// producers' own re-registrations — traced out, that flushes only every
// second or third frame during a continuous drag and can batch pane A's
// current-frame rect with pane B's last-frame rect (one-frame shear across
// the splitter). Instead:
//   - a 0ms timer armed during the frame runs AFTER the entire rAF batch,
//     so the flush sees every producer's value from THIS frame (coherent,
//     zero-frame latency);
//   - a keep-alive rAF re-arms that timer each subsequent frame while
//     traffic is flowing (arming only from producer queue calls would skip
//     a frame), and disarms itself on the first frame that queues nothing.
// Net cadence: one invoke per frame while values change, ~one idle rAF +
// no-op timer after a burst, silence when idle.

import {
  nativeTermFrameSync,
  type FrameSyncEntry,
  type NativeTermId,
  type Rect,
} from "../lib/native-term-bridge";

type Pending = { rect?: Rect; dpr?: number; holes?: Rect[] };

const pending = new Map<NativeTermId, Pending>();
let keepAliveRafId: number | null = null;
let timerArmed = false;
let dragActive = false;
// Backpressure: at most ONE frame_sync invoke in flight. Without this, a
// drag produces invokes at display-refresh rate while Rust services each
// one with two blocking vsync presents (sync render per flanking pane) —
// slower than they arrive. Tauri's command queue then backlogs unboundedly
// and drains AFTER release, visibly replaying the drag in slow motion and
// re-arming the 150ms grid-commit settle timer for every stale entry
// (observed: ~3s until text re-wrapped). With the guard, latest-wins
// merging in `pending` collapses stale intermediates while the wire is
// busy, so Rust only ever sees the freshest geometry.
let inFlight = false;
// Failsafe: if the PanelResizeHandle that armed dragActive unmounts
// mid-drag, onDragging(false) never fires and hole recomputation would
// stay frozen for every native pane forever. 10s is far longer than any
// sane splitter drag; if it ever fires during a real (marathon) drag the
// only cost is that hole updates resume flowing mid-drag.
const DRAG_WATCHDOG_MS = 10_000;
let dragWatchdogId: ReturnType<typeof setTimeout> | null = null;

function entryFor(id: NativeTermId): Pending {
  let e = pending.get(id);
  if (!e) {
    e = {};
    pending.set(id, e);
  }
  return e;
}

function flush(): void {
  if (pending.size === 0) return;
  // In-flight guard (see `inFlight` above): entries keep merging
  // latest-wins in `pending`; the finally-chain below re-flushes the
  // moment the wire frees up, so a drag-release flushNow() is never lost —
  // it just rides the next (immediate) send as the freshest geometry.
  if (inFlight) return;
  const entries: FrameSyncEntry[] = [];
  for (const [id, e] of pending) {
    entries.push({ id, rect: e.rect, dpr: e.dpr, holes: e.holes });
  }
  pending.clear();
  inFlight = true;
  // Never throw into a rAF/timer callback; Rust logs per-entry failures.
  nativeTermFrameSync(entries)
    .catch(() => {})
    .finally(() => {
      inFlight = false;
      if (pending.size > 0) flush();
    });
}

// End-of-frame flush: timer tasks run after the current rAF batch, so all
// producers that will queue this frame have queued by the time this fires.
function armEndOfFrameFlush(): void {
  if (timerArmed) return;
  timerArmed = true;
  setTimeout(() => {
    timerArmed = false;
    if (pending.size > 0) {
      flush();
    } else {
      // Idle frame — nothing queued since the last flush. Wind down the
      // keep-alive loop; the next queue call re-arms everything.
      if (keepAliveRafId != null) {
        cancelAnimationFrame(keepAliveRafId);
        keepAliveRafId = null;
      }
    }
  }, 0);
}

function keepAliveTick(): void {
  keepAliveRafId = requestAnimationFrame(keepAliveTick);
  armEndOfFrameFlush();
}

function schedule(): void {
  armEndOfFrameFlush();
  if (keepAliveRafId == null) {
    keepAliveRafId = requestAnimationFrame(keepAliveTick);
  }
}

/** Queue a window move+resize for `id` (same work as `native_term_resize`).
 * rect is WINDOW-CLIENT logical px (rectOf convention); dpr rides along —
 * the Rust wire format requires the pair together. Latest-wins per frame. */
export function queueGeom(id: NativeTermId, rect: Rect, dpr: number): void {
  const e = entryFor(id);
  e.rect = rect;
  e.dpr = dpr;
  schedule();
}

/** Queue a hole-region update for `id` (same work as
 * `native_term_set_region`; holes are PANE-LOCAL coords). Latest-wins. */
export function queueRegion(id: NativeTermId, holes: Rect[]): void {
  entryFor(id).holes = holes;
  schedule();
}

/** Drop any queued-but-unflushed hole update for `id`. Called from the
 * region driver's cleanup right before it clears holes with a direct
 * `native_term_set_region` invoke — otherwise a stale queued entry could
 * flush AFTER that clear and re-cut dead holes into a live window. */
export function dropPendingRegion(id: NativeTermId): void {
  const e = pending.get(id);
  if (!e) return;
  delete e.holes;
  if (e.rect === undefined && e.dpr === undefined) pending.delete(id);
}

/** Drag-release exact sync: flush whatever is queued RIGHT NOW instead of
 * waiting for the end-of-frame timer, so the final geometry+holes land
 * immediately. Safe on an empty queue; any armed timer then finds nothing
 * pending and winds the keep-alive loop down naturally. */
export function flushNow(): void {
  flush();
}

/** Splitter drag state — set by PaneGrid's PanelResizeHandle onDragging.
 * Every transition clears/re-arms the stuck-flag watchdog (see
 * DRAG_WATCHDOG_MS above): arming starts the timeout, releasing cancels
 * it. PaneGrid additionally clears the flag in its unmount cleanup. */
export function setDragActive(active: boolean): void {
  dragActive = active;
  if (dragWatchdogId != null) {
    clearTimeout(dragWatchdogId);
    dragWatchdogId = null;
  }
  if (active) {
    dragWatchdogId = setTimeout(() => {
      dragWatchdogId = null;
      dragActive = false;
      console.warn(
        "[frameSync] dragActive stuck for 10s — clearing (handle unmounted mid-drag?)"
      );
    }, DRAG_WATCHDOG_MS);
  }
}

/** Read by useNativePaneRegion to coarsen hole updates during a drag. */
export function isDragActive(): boolean {
  return dragActive;
}
