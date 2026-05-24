import { invoke } from "@tauri-apps/api/core";

export type Rect = { x: number; y: number; width: number; height: number };
export type NativeTermId = number;

export type NativeTermSpikeCmd =
  | "native_term_spike_create"
  | "native_term_spike_resize"
  | "native_term_spike_destroy"
  | "native_term_spike_show"
  | "native_term_spike_hide"
  | "native_term_spike_set_region";

export function nativeTermSpikeCreate(args: {
  rect: Rect;
  dpr: number;
}): Promise<NativeTermId> {
  return invoke<NativeTermId>("native_term_spike_create", args);
}

export function nativeTermSpikeResize(
  id: NativeTermId,
  rect: Rect,
  dpr: number,
): Promise<void> {
  return invoke<void>("native_term_spike_resize", { id, rect, dpr });
}

export function nativeTermSpikeDestroy(id: NativeTermId): Promise<void> {
  return invoke<void>("native_term_spike_destroy", { id });
}

export function nativeTermSpikeShow(id: NativeTermId): Promise<void> {
  return invoke<void>("native_term_spike_show", { id });
}

export function nativeTermSpikeHide(id: NativeTermId): Promise<void> {
  return invoke<void>("native_term_spike_hide", { id });
}

// holes are PANE-relative (overlay rect minus pane rect), not window-relative.
export function nativeTermSpikeSetRegion(
  id: NativeTermId,
  holes: Rect[],
): Promise<void> {
  return invoke<void>("native_term_spike_set_region", { id, holes });
}

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
  rects: Rect[]; // pane-local (inner-widget overlay marks)
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
  | "cell_hover_end";

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
}

export function nativeTermEventChannel(
  id: NativeTermId,
  kind: NativeTermEventKind,
): string {
  return `native_term:${id}:${kind}`;
}

// ===========================================================================
// Phase 1 invoke() wrappers. Wire format locked per R coordination thread.
// The Rust commands land in R1.c (atomic swap with spike commands), so calling
// these before then will reject with "command not found". TerminalPaneNative
// continues to use the spike commands until R1.c.
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
  | "native_term_set_theme"
  | "native_term_set_font"
  | "native_term_set_cursor_style"
  | "native_term_get_buffer_lines"
  | "native_term_get_viewport_state"
  | "native_term_get_selection"
  | "native_term_scroll_to_bottom"
  | "native_term_scroll_to_line"
  | "native_term_clear"
  | "native_term_reset"
  | "native_term_search"
  | "native_term_search_clear"
  | "native_term_key_event_forward"
  | "native_term_ime_commit"
  | "native_term_ime_preedit";

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

// Resolves AFTER `resized` event fires (R confirmation #3). Awaiters can
// trust that get_viewport_state will return post-resize cols/rows.
// `correlationId` is optional — pass a monotonic counter from the caller
// to match the originating request against the Resized event payload.
export function nativeTermResize(
  id: NativeTermId,
  rect: Rect,
  dpr: number,
  correlationId?: number,
): Promise<void> {
  return invoke<void>("native_term_resize", { id, rect, dpr, correlationId });
}

// Honors cols<20 narrow guard: returned cols is capped at 20, rows at 1.
export function nativeTermProposeDimensions(
  id: NativeTermId,
  width: number,
  height: number,
): Promise<ProposedDimensions> {
  return invoke<ProposedDimensions>("native_term_propose_dimensions", {
    id,
    width,
    height,
  });
}

// --- PTY ---

// Synchronous registration; bytes flow on next pty.rs read after resolve.
export function nativeTermAttachPty(
  id: NativeTermId,
  ptyId: number,
): Promise<void> {
  return invoke<void>("native_term_attach_pty", { id, ptyId });
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

// --- Input ---

// JS-originated key injection (palette shortcuts, paste). The native widget
// owns its own keyboard via WM_KEY* — DO NOT addEventListener("keydown") on
// the pane container; that would double-deliver.
export function nativeTermKeyEventForward(
  id: NativeTermId,
  ev: KeyEventDTO,
): Promise<void> {
  return invoke<void>("native_term_key_event_forward", { id, ev });
}

export function nativeTermImeCommit(
  id: NativeTermId,
  text: string,
): Promise<void> {
  return invoke<void>("native_term_ime_commit", { id, text });
}

export function nativeTermImePreedit(
  id: NativeTermId,
  text: string,
  cursor: number,
): Promise<void> {
  return invoke<void>("native_term_ime_preedit", { id, text, cursor });
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
