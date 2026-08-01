/**
 * The app's selectable sans faces (Settings → Appearance → UI font).
 *
 * ─── ADDING A FONT ────────────────────────────────────────────────────────
 *
 * 1. Drop the woff2 (+ its license) in `src/fonts/`. Prefer a variable file —
 *    one request covers the whole 200–800 weight range the UI spans.
 * 2. Add the @font-face block(s) to `src/fonts/ui-fonts.css`. That file is
 *    imported by BOTH webviews, so one block is enough; do not re-declare it
 *    in index.css or overlay.css.
 * 3. Append one entry to UI_FONTS below.
 *
 * That is the whole change. The `UiFont` type, the persisted store value, the
 * settings picker and the `--ezy-font-ui` injection all derive from the array,
 * so nothing else needs editing and TypeScript will not let the union drift out
 * of sync with the registry.
 *
 * Two things to keep in mind:
 *
 * - End every stack with the DEFAULT face, not with system-ui. If a woff2 ever
 *   fails to load, the app should fall back to its own typography rather than
 *   to whatever Segoe UI or San Francisco happens to be.
 * - `SegmentedControl` stops being the right control past about three entries —
 *   its options split the row evenly and get cramped. At that point move the
 *   row in SettingsPane to a dropdown; the registry itself does not change.
 *
 * NOT part of this system: the terminal face (Hack) and the Sora wordmark.
 * Hack is wired through TERMINAL_FONT_FAMILY and the native renderer's bundled
 * TTFs, and Atkinson-style proportional faces would break column alignment.
 * ──────────────────────────────────────────────────────────────────────────
 */

export interface UiFontDef {
  /** Persisted in the store — do not rename one after release, or existing
   *  users' saved value stops resolving and silently reverts to the default. */
  readonly id: string;
  /** Shown in the picker, rendered in this font's own face. */
  readonly label: string;
  /** Full CSS font-family stack, ending in the default face. */
  readonly stack: string;
}

const INTER_STACK = '"Inter Variable", "Inter", system-ui, -apple-system, sans-serif';

export const UI_FONTS = [
  {
    id: "inter",
    label: "Inter",
    stack: INTER_STACK,
  },
  {
    id: "atkinson",
    label: "Atkinson",
    stack: `"Atkinson Hyperlegible Next Zero", ${INTER_STACK}`,
  },
] as const satisfies readonly UiFontDef[];

export type UiFont = (typeof UI_FONTS)[number]["id"];

/** The face used when nothing is chosen, and the fallback for an unknown id. */
export const DEFAULT_UI_FONT: UiFont = "inter";

/**
 * Resolve a persisted id to a stack.
 *
 * Falls back to the default rather than trusting the id, because the store
 * value outlives this array: a user who downgrades, or who has an id we later
 * remove, would otherwise hand `undefined` to the CSS var and get the string
 * "undefined" as a font-family — which renders as an unstyled fallback with no
 * error anywhere. Take the id as untrusted input.
 */
export function uiFontStack(id: string): string {
  return (
    UI_FONTS.find((f) => f.id === id)?.stack ??
    UI_FONTS.find((f) => f.id === DEFAULT_UI_FONT)!.stack
  );
}

/** Picker options. Each label renders in the face it selects, so the choice
 *  reads as a specimen rather than a word. */
export const UI_FONT_OPTIONS: {
  value: UiFont;
  label: string;
  fontFamily: string;
}[] = UI_FONTS.map((f) => ({
  value: f.id,
  label: f.label,
  fontFamily: f.stack,
}));
