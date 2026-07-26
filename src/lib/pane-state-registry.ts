import type { AltScreenEvent } from "./native-term-bridge";

/**
 * Per-pane runtime facts that context menus need SYNCHRONOUSLY.
 *
 * Kept outside Zustand deliberately — same reasoning as the PTY write callbacks
 * (`store/terminalSlice.ts`) and the pane search openers
 * (`lib/pane-search-registry.ts`): these change on every selection drag and
 * every alt-screen transition, and nothing renders off them, so putting them in
 * the store would churn re-renders for no benefit.
 *
 * Why it exists: a right-click menu has to decide "is Copy available?" in the
 * same tick it builds its item list. For a NATIVE pane the selection lives in
 * Rust (`native_term_get_selection`), so asking for it is an async invoke — far
 * too late. Rust already pushes every selection change over the `selection`
 * channel, so we mirror it here and the answer is a plain object read.
 *
 * This is also what makes `Copy` work at all on native panes: the old menu ran
 * `document.execCommand("copy")`, which reads the *webview's* DOM selection and
 * can never see a native pane's — so it silently copied nothing.
 */
export interface PaneState {
  /** Last selection reported by the pane. Empty string = nothing selected. */
  selection: string;
  /** DECSET 1049 — a fullscreen TUI owns the screen (no scrollback to scroll). */
  altScreen: boolean;
  /** DECSET 1000/1002/1003 — the TUI wants raw mouse reports. */
  mouseReporting: boolean;
  /** The PTY has exited; the pane is a corpse (clear/reset/paste are pointless). */
  exited: boolean;
}

const EMPTY: PaneState = {
  selection: "",
  altScreen: false,
  mouseReporting: false,
  exited: false,
};

const states: Record<string, PaneState> = {};

/**
 * Live probes, for panes whose facts are readable on demand instead of pushed.
 *
 * The two renderers genuinely differ here. A NATIVE pane's state lives in
 * another process, so Rust pushes it over event channels (see the setters
 * below). An XTERM pane's `Terminal` object is right here in the main webview,
 * and xterm.js fires no event for mode changes at all — `XtermTuiScrollbar`
 * has to poll `modes.mouseTrackingMode` for exactly this reason. Reading it at
 * menu-build time is both simpler and fresher than mirroring it on a timer.
 *
 * Probe results win over pushed values, since a probe is by definition current.
 */
const probes: Record<string, () => Partial<PaneState>> = {};

export function registerPaneStateProbe(
  terminalId: string,
  probe: () => Partial<PaneState>,
): void {
  probes[terminalId] = probe;
}

export function unregisterPaneStateProbe(terminalId: string): void {
  delete probes[terminalId];
}

function mutate(terminalId: string, patch: Partial<PaneState>): void {
  states[terminalId] = { ...(states[terminalId] ?? EMPTY), ...patch };
}

export function setPaneSelection(terminalId: string, selection: string): void {
  mutate(terminalId, { selection });
}

export function setPaneAltScreen(terminalId: string, e: AltScreenEvent): void {
  mutate(terminalId, { altScreen: e.active, mouseReporting: e.mouseReporting });
}

export function setPaneExited(terminalId: string, exited: boolean): void {
  mutate(terminalId, { exited });
}

/**
 * Never throws and never returns undefined — an unknown id yields the zero
 * value. Menu builders run against panes that may have just unmounted, and a
 * menu that crashes is worse than one that shows `Copy` disabled.
 */
export function getPaneState(terminalId: string): PaneState {
  const pushed = states[terminalId] ?? EMPTY;
  const probe = probes[terminalId];
  if (!probe) return pushed;
  try {
    return { ...pushed, ...probe() };
  } catch {
    // A probe reaching into a torn-down xterm instance must not take the menu
    // down with it — fall back to whatever was last pushed.
    return pushed;
  }
}

export function clearPaneState(terminalId: string): void {
  delete states[terminalId];
  delete probes[terminalId];
}
