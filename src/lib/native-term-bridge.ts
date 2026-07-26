import { invoke } from "@tauri-apps/api/core";

export type Rect = { x: number; y: number; width: number; height: number };
export type NativeTermId = number;

export function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

/** Thickness of the frameless window's invisible resize border. Mirrors
 * `HANDLE` in components/WindowResizeHandles.tsx — keep the two in step. */
const WINDOW_RESIZE_EDGE_PX = 6;

/**
 * `rectOf` for a native pane's ANCHOR, pulled back off the window's resize
 * edges.
 *
 * The resize handles are DOM (`position: fixed`, z-index 9999), but a native
 * pane is a child HWND and sits above ALL webview content — so a pane flush
 * with the window's right edge swallowed the East handle and the window simply
 * could not be resized from that side (user-reported 2026-07-26).
 *
 * Only the far edges are trimmed, never the origin: shrinking width/height
 * keeps the surface origin on the anchor's origin, so everything that
 * positions itself off the anchor — IME popup, file-link tooltip, TUI
 * scrollbar, composer — stays aligned with the grid. Moving x/y instead would
 * silently shift all of them.
 *
 * The vacated strip is painted by the pane root in the terminal background, so
 * it is invisible; only that pane's column count changes.
 *
 * Left and top need no trim: the pane's own left gap clears the West handle,
 * and the tab bar owns the top.
 */
export function surfaceRectOf(el: Element): Rect {
  const r = rectOf(el);
  const overRight = r.x + r.width - (window.innerWidth - WINDOW_RESIZE_EDGE_PX);
  if (overRight > 0) r.width = Math.max(1, r.width - overRight);
  const overBottom =
    r.y + r.height - (window.innerHeight - WINDOW_RESIZE_EDGE_PX);
  if (overBottom > 0) r.height = Math.max(1, r.height - overBottom);
  return r;
}

// ===========================================================================
// Phase 1 surface — types only. invoke()/listen() wrappers land once
// workstream-R confirms the Rust signatures (sent for review).
// ===========================================================================

export type CursorStyle = "bar" | "block" | "underline";

// R1 wire format: indexed ansi0..15 fields. Rust deserializes via
// #[serde(rename_all = "camelCase")] so cursorAccent maps to cursor_accent.
// Strings are "#RRGGBB" or "#RRGGBBAA" hex; selection typically has alpha.
export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selection: string;
  ansi0: string;
  ansi1: string;
  ansi2: string;
  ansi3: string;
  ansi4: string;
  ansi5: string;
  ansi6: string;
  ansi7: string;
  ansi8: string;
  ansi9: string;
  ansi10: string;
  ansi11: string;
  ansi12: string;
  ansi13: string;
  ansi14: string;
  ansi15: string;
  /** Optional replacement for xterm indices 16..=255 — exactly 240 entries, in
   *  order. Light themes send a canvas-adapted palette here; omitting it keeps
   *  the renderer's standard xterm cube. */
  extendedAnsi?: string[];
}

export interface FontSpec {
  family: string;
  sizePx: number;
}

export interface CreateOpts {
  rect: Rect;
  dpr: number;
  theme: TerminalTheme;
  font: FontSpec;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  scrollback: number;
  // P2a/P7a: initial keyboard-focus state (isActive && appWindowFocused at
  // create time). Rust serde-defaults this to false when omitted; the
  // set_focused effect re-asserts the live value on any later change.
  focused: boolean;
  /** Opt in to the process-wide wgpu Device/Queue (Settings toggle). Read once
   *  at create, so flipping the toggle only affects panes opened afterwards. */
  sharedGpu: boolean;
}

export interface ViewportState {
  baseY: number;
  viewportY: number;
  cursorY: number;
  length: number;
  cols: number;
  rows: number;
}

export interface ProposedDimensions {
  cols: number;
  rows: number;
}

export interface SearchOpts {
  caseSensitive?: boolean;
  regex?: boolean;
  wholeWord?: boolean;
}

export type SearchDirection = "forward" | "backward";

export interface SearchResult {
  total: number;
  activeIndex: number;
  // D-review: alacritty SIGNED grid line of the active match — same space
  // as nativeTermScrollToLine's absLine ([-history, screen); negative =
  // scrollback). Callers scroll the active match into view with it. Only
  // meaningful when activeIndex >= 0 (0 otherwise).
  activeLine: number;
  // P6a: pane-local CONTENT-space rects (y = absolute grid line × cell
  // height, negative for scrollback rows). Opaque to JS — round-trip them
  // VERBATIM into nativeTermSetSearchHighlights; the native renderer
  // translates by the live scroll offset each frame and clips off-viewport
  // rows, so highlights track their text while the user scrolls.
  rects: Rect[];
}

export interface KeyEventDTO {
  code: string;
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  repeat: boolean;
}

export interface KeyModifiers {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

// --- Event payloads ---

export type Osc133Kind = "A" | "B" | "C" | "D";

export interface Osc133Event {
  kind: Osc133Kind;
  exitCode: number | null;
  absLine: number;
}

export interface ExitEvent {
  code: number;
}

export interface SelectionEvent {
  text: string;
}

export interface ScrollEvent {
  viewportY: number;
  baseY: number;
}

export interface CursorEvent {
  x: number;
  y: number;
  h: number; // fractional logical px, for IME positioning
}

export interface LinkHoverEvent {
  uri: string;
  rect: Rect;
}

export interface LinkClickEvent {
  uri: string;
  line: number;
  col: number;
  modifiers: KeyModifiers;
}

export interface KeyDownPreviewEvent {
  ev: KeyEventDTO;
}

export interface ImeCompositionEvent {
  text: string;
  cursor: number;
  committed: boolean;
}

export interface ResizedEvent {
  cols: number;
  rows: number;
  // Echoes correlationId from native_term_resize; null if the resize
  // originated from a non-JS source (parent WM_SIZE) or wasn't passed.
  correlationId: number | null;
  // Real glyph-grid cell metrics in LOGICAL px — grid-positioned popups
  // (file-link tooltip) must use these, not hardcoded 14px-Hack mirrors.
  cellW: number;
  cellH: number;
}

export interface DataRateEvent {
  bytes: number;
  sinceMs: number; // 50ms-coalesced in Rust
}

// Pane-local coords (R proposal accepted). Compose with paneRect for viewport.
export interface RButtonEvent {
  x: number;
  y: number;
}

export interface MousePassthroughEvent {
  x: number;
  y: number;
}

// Fires on every mouse move inside the pane that changes cell coords.
// Wire format on Rust side is i64 line / u32 col — `line` can be negative
// when scrollback rows are visible above the viewport. JS treats both as
// `number`; don't constrain to unsigned. R suppresses redundant emissions
// for sub-cell movement (only fires when (line, col) changes).
// Consumer (TS): file-link-provider regex-scans the line via
// nativeTermGetBufferLines and renders hover tooltip / Ctrl+Click handler.
// Wide CJK chars are normalized R-side to report the start col of the
// glyph (not the continuation cell).
export interface CellHoverEvent {
  line: number;
  col: number;
}

// Paired with CellHoverEvent. No payload — emitted when the mouse leaves
// the pane (WM_MOUSELEAVE on Win32). Consumer hides any open hover tooltip.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CellHoverEndEvent {}

// P2a: the native HWND gained keyboard focus (WM_SETFOCUS click-to-focus
// path). No payload — the JS side marks the pane active and sets the store's
// nativePaneFocused flag; visuals stay JS-authoritative via
// native_term_set_focused.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface FocusGainedEvent {}

/** A mouse button went down on this pane. Payload-less; used only to dismiss
 *  floating popups (see emit_pointer_down in native_term/events.rs — nothing
 *  else reports a click on an ALREADY-focused pane). */
export interface PointerDownEvent {}

// P2b: the native HWND lost keyboard focus (WM_KILLFOCUS). No payload. On
// Windows the tauri onFocusChanged event mirrors WEBVIEW focus only, so when
// a native pane holds Win32 focus an Alt-Tab away produces no JS blur — this
// event is the store's only signal to clear nativePaneFocused.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface FocusLostEvent {}

/**
 * DECSET 1049 alternate-screen state. `active` = a fullscreen TUI owns the
 * screen (Claude's `/tui fullscreen`, vim, htop). The alt buffer has no
 * scrollback, so MADE's own scrollbar has nothing to show and the TUI scrolls
 * itself — the pane swaps scrollbars on this edge. Emitted on transition only.
 */
export interface AltScreenEvent {
  active: boolean;
  /** The TUI has DECSET 1000/1002/1003 mouse reporting on, i.e. it wants wheel
   * events. Precondition for MADE's TUI scrollbar: without it there is no way
   * to drive the TUI's own scroller. */
  mouseReporting: boolean;
}

/**
 * A wheel scroll forwarded to a fullscreen TUI as mouse-report bytes.
 * `notches` is signed: positive = wheel up (older content). Lets the pane
 * scrollbar track scrolling the USER drove with the wheel, not just its own.
 */
export interface TuiScrollEvent {
  notches: number;
}

/**
 * Ctrl+Up / Ctrl+Down pressed inside a fullscreen TUI: jump to the previous
 * (`dir` +1, older) or next (`dir` -1, newer) message. Rust claims the key and
 * emits this instead of forwarding it, because the TUI has no message-level
 * scroll command — the pane performs the jump by scrolling until Claude's
 * sticky prompt row changes.
 */
export interface TuiPromptNavEvent {
  dir: number;
}

/**
 * OSC 0 / OSC 2 terminal title. Empty string = title reset (OSC 104 /
 * ResetTitle), meaning "fall back to the pane's normal label".
 */
export interface TitleEvent {
  title: string;
}

/**
 * Desktop notification requested by the program (OSC 9 / 99 / 777). Claude
 * emits one when it wants attention; which sequence depends on its
 * `notifChannel` setting. `title` may be empty — OSC 9 and Kitty carry a body
 * only — so the UI supplies its own.
 */
export interface NotifyEvent {
  title: string;
  body: string;
}

/**
 * ConEmu progress (OSC 9;4). `state`: 0 clear, 1 normal, 2 error,
 * 3 indeterminate, 4 paused. `percent` is 0-100, meaningless for 0 and 3.
 */
export interface ProgressEvent {
  state: number;
  percent: number;
}

// Discriminated union of all event kinds. Channel suffix maps to payload.
export type NativeTermEventKind =
  | "osc133"
  | "exit"
  | "selection"
  | "scroll"
  | "cursor"
  | "link_hover"
  | "link_click"
  | "key_down_preview"
  | "ime_composition"
  | "resized"
  | "data_rate"
  | "r_button"
  | "mouse_passthrough"
  | "cell_hover"
  | "cell_hover_end"
  | "focus_gained"
  | "pointer_down"
  | "focus_lost"
  | "alt_screen"
  | "tui_scroll"
  | "tui_prompt_nav"
  | "title"
  | "notify"
  | "progress";

export interface NativeTermEventPayloadMap {
  osc133: Osc133Event;
  exit: ExitEvent;
  selection: SelectionEvent;
  scroll: ScrollEvent;
  cursor: CursorEvent;
  link_hover: LinkHoverEvent;
  link_click: LinkClickEvent;
  key_down_preview: KeyDownPreviewEvent;
  ime_composition: ImeCompositionEvent;
  resized: ResizedEvent;
  data_rate: DataRateEvent;
  r_button: RButtonEvent;
  mouse_passthrough: MousePassthroughEvent;
  cell_hover: CellHoverEvent;
  cell_hover_end: CellHoverEndEvent;
  focus_gained: FocusGainedEvent;
  pointer_down: PointerDownEvent;
  focus_lost: FocusLostEvent;
  alt_screen: AltScreenEvent;
  tui_scroll: TuiScrollEvent;
  tui_prompt_nav: TuiPromptNavEvent;
  title: TitleEvent;
  notify: NotifyEvent;
  progress: ProgressEvent;
}

export function nativeTermEventChannel(
  id: NativeTermId,
  kind: NativeTermEventKind,
): string {
  return `native_term:${id}:${kind}`;
}

// ===========================================================================
// Production invoke() wrappers. Wire format locked per R coordination thread;
// these map 1:1 onto the Rust command surface in
// `src-tauri/src/native_term/mod.rs` (the Phase-0 debug aliases were deleted
// in P7a).
// ===========================================================================

export type NativeTermCmd =
  | "native_term_create"
  | "native_term_destroy"
  | "native_term_reap_all"
  | "native_term_show"
  | "native_term_hide"
  | "native_term_resize"
  | "native_term_propose_dimensions"
  | "native_term_attach_pty"
  | "native_term_detach_pty"
  | "native_term_set_region"
  | "native_term_frame_sync"
  | "native_term_set_theme"
  | "native_term_set_font"
  | "native_term_set_cursor_style"
  | "native_term_set_focused"
  | "native_term_set_hover_link"
  | "native_term_get_metrics"
  | "native_term_set_copy_on_select"
  | "native_term_focus_keyboard"
  | "native_term_get_buffer_lines"
  | "native_term_get_viewport_state"
  | "native_term_get_selection"
  | "native_term_scroll_to_bottom"
  | "native_term_scroll_to_line"
  | "native_term_clear"
  | "native_term_reset"
  | "native_term_search"
  | "native_term_search_clear"
  | "native_term_set_search_highlights"
  | "native_term_tui_scroll"
  | "native_term_set_wheel_acceleration"
  | "native_term_set_prompt_nav";

// --- Lifecycle ---

/**
 * One-shot reap of native terms left behind by a PREVIOUS page load.
 *
 * The Rust registry is process-wide and outlives the webview, but every window
 * in it is owned by a React effect. A reload (F5, devtools reload, a Vite full
 * reload in dev) discards that JS without running cleanup, so the old page's
 * HWNDs stay alive and visible over the new one — they lurk behind the new
 * panes until something moves those panes (opening the settings sidebar, a
 * browser preview) and then a dead "no PTY attached yet" pane appears from
 * nowhere.
 *
 * ORDERING, not just timing: `nativeTermCreate` awaits this, so the reap is
 * guaranteed to complete before the first pane of this page exists. Firing it
 * from a boot effect instead would race the first pane's create — and reaping
 * a live pane is a worse bug than the one being fixed.
 *
 * Idempotent per page: the promise is memoised, so later creates await an
 * already-settled promise. A failure is swallowed and NOT retried — a retry
 * loop could reap this page's own panes once they exist.
 *
 * The memo lives on `window`, NOT in a module-level `let`: in dev, Vite can
 * hot-replace THIS module while the page keeps running, which would reset a
 * module-level flag and let the next create reap the panes this very page is
 * using. A page reload gets a fresh `window`; an HMR swap does not — which is
 * exactly the distinction that matters here.
 */
const REAP_KEY = "__madeNativeTermReaped";

type ReapHost = { [REAP_KEY]?: Promise<void> };

export function ensureFreshSession(): Promise<void> {
  const host = window as unknown as ReapHost;
  let sessionReap = host[REAP_KEY];
  if (!sessionReap) {
    sessionReap = invoke<number>("native_term_reap_all")
      .then((n) => {
        if (n > 0) {
          console.warn(
            `[native-term] reaped ${n} orphaned pane(s) from a previous page load`,
          );
        }
      })
      .catch((e) => {
        console.error("[native-term] reap of orphaned panes failed", e);
      });
    host[REAP_KEY] = sessionReap;
  }
  return sessionReap;
}

export async function nativeTermCreate(opts: CreateOpts): Promise<NativeTermId> {
  await ensureFreshSession();
  return invoke<NativeTermId>("native_term_create", { opts });
}

export function nativeTermDestroy(id: NativeTermId): Promise<void> {
  return invoke<void>("native_term_destroy", { id });
}

export function nativeTermShow(id: NativeTermId): Promise<void> {
  return invoke<void>("native_term_show", { id });
}

export function nativeTermHide(id: NativeTermId): Promise<void> {
  return invoke<void>("native_term_hide", { id });
}

// --- Geometry ---

// Resolves after the window/surface resize only. The grid/PTY commit runs
// ~150ms later on the Rust settle timer and announces itself via the
// `resized` event — await that event, not this promise, for post-resize
// cols/rows. `correlationId` is optional — pass a monotonic counter from
// the caller to match the originating request against the Resized payload
// (settle-driven commits carry correlationId: null).
export function nativeTermResize(
  id: NativeTermId,
  rect: Rect,
  dpr: number,
  correlationId?: number,
): Promise<void> {
  return invoke<void>("native_term_resize", { id, rect, dpr, correlationId });
}

// Honors cols<20 narrow guard: returned cols is capped at 20, rows at 1.
// widthPx/heightPx are LOGICAL CSS px (rectOf convention) — the Rust side
// multiplies by its cached dpr. Wire args are u32 (Rust
// `native_term_propose_dimensions(id, width_px, height_px)`), so fractional
// getBoundingClientRect values are rounded here or serde rejects the invoke.
export function nativeTermProposeDimensions(
  id: NativeTermId,
  widthPx: number,
  heightPx: number,
): Promise<ProposedDimensions> {
  return invoke<ProposedDimensions>("native_term_propose_dimensions", {
    id,
    widthPx: Math.max(0, Math.round(widthPx)),
    heightPx: Math.max(0, Math.round(heightPx)),
  });
}

// --- PTY ---

// Synchronous registration; bytes flow on next pty.rs read after resolve.
// cols/rows are REQUIRED by the Rust command (they size the alacritty Term
// the parser bridge spawns) — omitting them makes serde reject the invoke.
export function nativeTermAttachPty(
  id: NativeTermId,
  ptyId: number,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke<void>("native_term_attach_pty", { id, ptyId, cols, rows });
}

export function nativeTermDetachPty(id: NativeTermId): Promise<void> {
  return invoke<void>("native_term_detach_pty", { id });
}

// --- Region (pane-local holes) ---

export function nativeTermSetRegion(
  id: NativeTermId,
  holes: Rect[],
): Promise<void> {
  return invoke<void>("native_term_set_region", { id, holes });
}

// --- Frame sync (P4a/P4b batched geometry + regions) ---

// One entry of the batched `native_term_frame_sync` command. `rect` + `dpr`
// together request the same work as `native_term_resize` (they must be sent
// together — Rust treats a half-specified pair as a per-entry error);
// `holes` requests the same work as `native_term_set_region` (pane-local
// coords). Any combination may be present on one entry.
export interface FrameSyncEntry {
  id: NativeTermId;
  rect?: Rect;
  dpr?: number;
  holes?: Rect[];
}

// Batched per-frame geometry sync: one invoke carries every pane's rect/dpr
// move and/or hole-region update for a layout frame. Rust applies the window
// moves in a single BeginDeferWindowPos/EndDeferWindowPos transaction so
// panes flanking a splitter reposition atomically. Entries are processed
// independently — a stale/destroyed id is logged Rust-side and never fails
// the batch, so the returned promise resolves Ok even on partial failures.
// Callers should route through `src/native-term/frameSync.ts` (the per-frame
// coalescer) rather than invoking this directly from rAF loops.
export function nativeTermFrameSync(entries: FrameSyncEntry[]): Promise<void> {
  return invoke<void>("native_term_frame_sync", { entries });
}

// --- Appearance hot-swap ---

export function nativeTermSetTheme(
  id: NativeTermId,
  theme: TerminalTheme,
): Promise<void> {
  return invoke<void>("native_term_set_theme", { id, theme });
}

export function nativeTermSetFont(
  id: NativeTermId,
  family: string,
  sizePx: number,
): Promise<void> {
  return invoke<void>("native_term_set_font", { id, family, sizePx });
}

export function nativeTermSetCursorStyle(
  id: NativeTermId,
  style: CursorStyle,
  blink: boolean,
): Promise<void> {
  return invoke<void>("native_term_set_cursor_style", { id, style, blink });
}

// P2b: JS-authoritative cursor focus. Caller computes
// `isActive && appWindowFocused` (store is the single source of truth) and
// pushes it here; the renderer draws a solid/blinking cursor when focused
// and a hollow outline when not. Win32 WM_SETFOCUS/WM_KILLFOCUS never drive
// this directly.
export function nativeTermSetFocused(
  id: NativeTermId,
  focused: boolean,
): Promise<void> {
  return invoke<void>("native_term_set_focused", { id, focused });
}

/** Mirror the JS regex-link hover state onto the pane (hand cursor on Ctrl). */
export function nativeTermSetHoverLink(id: NativeTermId, active: boolean): Promise<void> {
  return invoke<void>("native_term_set_hover_link", { id, active });
}

/** Pull the pane's real glyph metrics (logical px) — the first `resized`
 * event races the JS subscription, so grid-positioned popups query once. */
export function nativeTermGetMetrics(id: NativeTermId): Promise<[number, number]> {
  return invoke<[number, number]>("native_term_get_metrics", { id });
}

// N-b copy-on-select: mirror the JS `copyOnSelect` store flag onto the pane.
// When false (legacy default), a mouse-selection in the native pane emits its
// `selection` event but does NOT auto-copy to the clipboard. Rust reads this
// in WM_LBUTTONUP. Tauri maps the camelCase arg to the snake_case Rust param.
export function nativeTermSetCopyOnSelect(
  id: NativeTermId,
  copyOnSelect: boolean,
): Promise<void> {
  return invoke<void>("native_term_set_copy_on_select", { id, copyOnSelect });
}

// P7b: route Win32 KEYBOARD focus to the pane's HWND — parity with the xterm
// pane calling term.focus() on activation. Distinct from
// nativeTermSetFocused (cursor visual only). Rust posts WM_APP_FOCUS to the
// pane's wnd_proc (thread-correct SetFocus, no activation); WM_SETFOCUS then
// emits focus_gained exactly like the click-to-focus path. Call sites MUST
// guard hard — isActive && appWindowFocused &&
// document.activeElement === document.body — focus-steal from
// composer/search/rename inputs is a known failure class in this repo.
export function nativeTermFocusKeyboard(id: NativeTermId): Promise<void> {
  return invoke<void>("native_term_focus_keyboard", { id });
}

// --- Buffer reads (replace term.buffer.active.*) ---

// Mutex-locked snapshots, near-instant per R confirmation #4.
export function nativeTermGetBufferLines(
  id: NativeTermId,
  start: number,
  end: number,
): Promise<string[]> {
  return invoke<string[]>("native_term_get_buffer_lines", { id, start, end });
}

export function nativeTermGetViewportState(
  id: NativeTermId,
): Promise<ViewportState> {
  return invoke<ViewportState>("native_term_get_viewport_state", { id });
}

export function nativeTermGetSelection(
  id: NativeTermId,
): Promise<string | null> {
  return invoke<string | null>("native_term_get_selection", { id });
}

/**
 * Opt a pane into MADE claiming Ctrl+Up / Ctrl+Down for sticky-prompt
 * navigation. Enable only for pane types that have that UI (Claude), so the
 * keys keep reaching the TUI everywhere else.
 */
export function nativeTermSetPromptNav(
  id: NativeTermId,
  enabled: boolean,
): Promise<void> {
  return invoke<void>("native_term_set_prompt_nav", { id, enabled });
}

/**
 * Toggle Warp-style velocity acceleration on MADE's OWN scrollback wheel
 * scrolling (fast flicks travel further per notch). Applies to the local
 * scroll path only — wheel events forwarded to a mouse-reporting TUI stay raw,
 * because the TUI may run its own ramp (Claude does).
 */
export function nativeTermSetWheelAcceleration(
  id: NativeTermId,
  enabled: boolean,
): Promise<void> {
  return invoke<void>("native_term_set_wheel_acceleration", { id, enabled });
}

/**
 * Drive a fullscreen TUI's own scroller with synthesized wheel events
 * (`notches` signed; positive = up/older). Resolves false when the TUI has no
 * mouse reporting enabled, in which case nothing was sent and the caller
 * should fall back to page keys.
 */
export function nativeTermTuiScroll(
  id: NativeTermId,
  notches: number,
): Promise<boolean> {
  return invoke<boolean>("native_term_tui_scroll", { id, notches });
}

export function nativeTermScrollToBottom(id: NativeTermId): Promise<void> {
  return invoke<void>("native_term_scroll_to_bottom", { id });
}

export function nativeTermScrollToLine(
  id: NativeTermId,
  absLine: number,
): Promise<void> {
  return invoke<void>("native_term_scroll_to_line", { id, absLine });
}

export function nativeTermClear(id: NativeTermId): Promise<void> {
  return invoke<void>("native_term_clear", { id });
}

export function nativeTermReset(id: NativeTermId): Promise<void> {
  return invoke<void>("native_term_reset", { id });
}

// --- Search ---

export function nativeTermSearch(
  id: NativeTermId,
  query: string,
  opts: SearchOpts,
  direction: SearchDirection,
): Promise<SearchResult> {
  return invoke<SearchResult>("native_term_search", {
    id,
    query,
    opts,
    direction,
  });
}

export function nativeTermSearchClear(id: NativeTermId): Promise<void> {
  return invoke<void>("native_term_search_clear", { id });
}

// Phase 3: push the rects from a SearchResult to the renderer so it can draw
// the highlight overlay. Decoupled from `nativeTermSearch` so callers can opt
// out of the overlay (e.g. when previewing a live-typed regex). Best-effort —
// errors are surfaced to the caller but typical use sites `.catch(() => {})`
// them since a missing/destroyed pane is a benign race.
export function nativeTermSetSearchHighlights(
  id: NativeTermId,
  rects: Rect[],
): Promise<void> {
  return invoke<void>("native_term_set_search_highlights", { id, rects });
}

// NOTE (input): there are deliberately NO key/IME injection wrappers here.
// The native widget owns its own keyboard via WM_KEY*/WM_IME_* — DO NOT
// addEventListener("keydown") on the pane container; that would
// double-deliver. (The unimplemented key_event_forward / ime_commit /
// ime_preedit wrappers were deleted in P7a — they never had Rust handlers.)

// --- Debug / perf instrumentation (P0) ---

// Snapshot of the native pane's render counters + cached geometry. Counter
// semantics live in Rust (`renderer/pipeline.rs`). All counters are live:
// framesSkippedClean is wired by the P3a clean-frame early-out; wakesPosted
// and wakesCoalesced by the P3b RenderWake (zeros while no PTY is attached).
// Rust serializes with #[serde(rename_all = "camelCase")].
export interface DebugStats {
  framesRendered: number;
  framesSkippedClean: number;
  lastFrameCpuMs: number;
  frameCpuMsEwma: number;
  configures: number;
  wakesPosted: number;
  wakesCoalesced: number;
  attached: boolean;
  visible: boolean;
  cellWPx: number;
  cellHPx: number;
  dpr: number;
  surfaceW: number;
  surfaceH: number;
  // Static-canvas geometry: surfaceW/H report the oversized fixed canvas the
  // wgpu surface spans (parent-client-sized); paneW/H report the VISIBLE
  // pane (physical px) — what the JS rect describes.
  paneW: number;
  paneH: number;
}

export function nativeTermDebugStats(id: NativeTermId): Promise<DebugStats> {
  return invoke<DebugStats>("native_term_debug_stats", { id });
}

// ===========================================================================
// Phase 1 event subscribers. Each returns a Promise<UnlistenFn> — caller
// awaits to register, calls the returned fn to remove. All channel names
// computed via `nativeTermEventChannel(id, kind)`.
// Note: link_hover, link_click events don't fire until Phase R3 (OSC 8
// hyperlinks). Subscribing earlier is harmless — listener idles.
// ===========================================================================

type Unlisten = () => void;

async function subscribe<K extends NativeTermEventKind>(
  id: NativeTermId,
  kind: K,
  cb: (payload: NativeTermEventPayloadMap[K]) => void,
): Promise<Unlisten> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<NativeTermEventPayloadMap[K]>(
    nativeTermEventChannel(id, kind),
    (e) => cb(e.payload),
  );
}

export function subscribeOsc133(
  id: NativeTermId,
  cb: (e: Osc133Event) => void,
): Promise<Unlisten> {
  return subscribe(id, "osc133", cb);
}

export function subscribeExit(
  id: NativeTermId,
  cb: (e: ExitEvent) => void,
): Promise<Unlisten> {
  return subscribe(id, "exit", cb);
}

export function subscribeSelection(
  id: NativeTermId,
  cb: (e: SelectionEvent) => void,
): Promise<Unlisten> {
  return subscribe(id, "selection", cb);
}

export function subscribeScroll(
  id: NativeTermId,
  cb: (e: ScrollEvent) => void,
): Promise<Unlisten> {
  return subscribe(id, "scroll", cb);
}

export function subscribeCursor(
  id: NativeTermId,
  cb: (e: CursorEvent) => void,
): Promise<Unlisten> {
  return subscribe(id, "cursor", cb);
}

export function subscribeLinkHover(
  id: NativeTermId,
  cb: (e: LinkHoverEvent) => void,
): Promise<Unlisten> {
  return subscribe(id, "link_hover", cb);
}

export function subscribeLinkClick(
  id: NativeTermId,
  cb: (e: LinkClickEvent) => void,
): Promise<Unlisten> {
  return subscribe(id, "link_click", cb);
}

export function subscribeKeyDownPreview(
  id: NativeTermId,
  cb: (e: KeyDownPreviewEvent) => void,
): Promise<Unlisten> {
  return subscribe(id, "key_down_preview", cb);
}

export function subscribeImeComposition(
  id: NativeTermId,
  cb: (e: ImeCompositionEvent) => void,
): Promise<Unlisten> {
  return subscribe(id, "ime_composition", cb);
}

export function subscribeResized(
  id: NativeTermId,
  cb: (e: ResizedEvent) => void,
): Promise<Unlisten> {
  return subscribe(id, "resized", cb);
}

export function subscribeDataRate(
  id: NativeTermId,
  cb: (e: DataRateEvent) => void,
): Promise<Unlisten> {
  return subscribe(id, "data_rate", cb);
}

export function subscribeRButton(
  id: NativeTermId,
  cb: (e: RButtonEvent) => void,
): Promise<Unlisten> {
  return subscribe(id, "r_button", cb);
}

export function subscribeMousePassthrough(
  id: NativeTermId,
  cb: (e: MousePassthroughEvent) => void,
): Promise<Unlisten> {
  return subscribe(id, "mouse_passthrough", cb);
}

export function subscribeCellHover(
  id: NativeTermId,
  cb: (e: CellHoverEvent) => void,
): Promise<Unlisten> {
  return subscribe(id, "cell_hover", cb);
}

export function subscribeCellHoverEnd(
  id: NativeTermId,
  cb: () => void,
): Promise<Unlisten> {
  return subscribe(id, "cell_hover_end", () => cb());
}

export function subscribeFocusGained(
  id: NativeTermId,
  cb: () => void,
): Promise<Unlisten> {
  return subscribe(id, "focus_gained", () => cb());
}

export function subscribePointerDown(
  id: NativeTermId,
  cb: () => void,
): Promise<Unlisten> {
  return subscribe(id, "pointer_down", () => cb());
}

export function subscribeFocusLost(
  id: NativeTermId,
  cb: () => void,
): Promise<Unlisten> {
  return subscribe(id, "focus_lost", () => cb());
}

export function subscribeAltScreen(
  id: NativeTermId,
  cb: (e: AltScreenEvent) => void,
): Promise<Unlisten> {
  return subscribe(id, "alt_screen", cb);
}

export function subscribeTuiScroll(
  id: NativeTermId,
  cb: (e: TuiScrollEvent) => void,
): Promise<Unlisten> {
  return subscribe(id, "tui_scroll", cb);
}

export function subscribeTuiPromptNav(
  id: NativeTermId,
  cb: (e: TuiPromptNavEvent) => void,
): Promise<Unlisten> {
  return subscribe(id, "tui_prompt_nav", cb);
}

export function subscribeTitle(
  id: NativeTermId,
  cb: (e: TitleEvent) => void,
): Promise<Unlisten> {
  return subscribe(id, "title", cb);
}

export function subscribeNotify(
  id: NativeTermId,
  cb: (e: NotifyEvent) => void,
): Promise<Unlisten> {
  return subscribe(id, "notify", cb);
}

export function subscribeProgress(
  id: NativeTermId,
  cb: (e: ProgressEvent) => void,
): Promise<Unlisten> {
  return subscribe(id, "progress", cb);
}
