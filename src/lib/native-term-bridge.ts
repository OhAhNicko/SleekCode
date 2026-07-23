import { invoke } from "@tauri-apps/api/core";

export type Rect = { x: number; y: number; width: number; height: number };
export type NativeTermId = number;

export function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
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

// P2b: the native HWND lost keyboard focus (WM_KILLFOCUS). No payload. On
// Windows the tauri onFocusChanged event mirrors WEBVIEW focus only, so when
// a native pane holds Win32 focus an Alt-Tab away produces no JS blur — this
// event is the store's only signal to clear nativePaneFocused.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface FocusLostEvent {}

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
  | "focus_lost";

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
  focus_lost: FocusLostEvent;
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
  | "native_term_set_search_highlights";

// --- Lifecycle ---

export function nativeTermCreate(opts: CreateOpts): Promise<NativeTermId> {
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

export function subscribeFocusLost(
  id: NativeTermId,
  cb: () => void,
): Promise<Unlisten> {
  return subscribe(id, "focus_lost", () => cb());
}
