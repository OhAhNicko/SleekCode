/**
 * The app's selectable sans faces (Settings → Appearance → UI font).
 *
 * ─── ADDING A FONT ────────────────────────────────────────────────────────
 *
 * 1. Drop the woff2 (+ its license) in `src/fonts/`. Prefer a variable file —
 *    one request covers the whole 200–800 weight range the UI spans. Take it
 *    from the upstream fontsource build (latin + latin-ext) and copy its
 *    unicode-ranges verbatim, so fallback behaves like the faces already here.
 *    Vendor the file; do not add a fourth npm font dependency, and note that
 *    `npm install` cannot be run from WSL in this repo anyway.
 * 2. Add the @font-face block(s) to `src/fonts/ui-fonts.css`. That file is
 *    imported by BOTH webviews, so one block is enough; do not re-declare it
 *    in index.css or overlay.css.
 * 3. Append one entry to UI_FONTS below.
 *
 * That is the whole change. The `UiFont` type, the persisted store value, the
 * settings picker and the `--ezy-font-ui` / `--ezy-tracking-ui` injection all
 * derive from the array, so nothing else needs editing and TypeScript will not
 * let the union drift out of sync with the registry.
 *
 * Three things to keep in mind:
 *
 * - End every stack with the DEFAULT face, not with system-ui. If a woff2 ever
 *   fails to load, the app should fall back to its own typography rather than
 *   to whatever Segoe UI or San Francisco happens to be.
 * - Declare the @font-face in `src/fonts/ui-fonts.css` and NOWHERE else. A face
 *   declared in index.css exists only in the main webview, so the overlay
 *   renders context menus in a fallback while the app looks correct — which is
 *   invisible until someone screenshots a menu. Inter itself shipped that way.
 * - The picker is a `Dropdown`, not a `SegmentedControl`; it outgrew the
 *   segmented row at six entries. Adding a face needs no change there — but do
 *   keep the option rendering in its own face, since the point of the list is
 *   that each row is a specimen.
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
  /**
   * Optional `letter-spacing` for this face, as a CSS length.
   *
   * Tracking belongs to a TYPEFACE, not to the app: the value that makes Inter
   * look drawn-on-purpose makes a low-vision face harder to read. So it rides
   * in the registry entry next to the stack and switches with it, rather than
   * living as one global rule the font picker silently invalidates.
   *
   * Omit it and the face renders at its designed spacing — which is the right
   * answer for most of them, and the reason this is optional rather than `0`.
   */
  readonly tracking?: string;
}

const INTER_STACK = '"Inter Variable", "Inter", system-ui, -apple-system, sans-serif';

export const UI_FONTS = [
  {
    id: "inter",
    label: "Inter",
    stack: INTER_STACK,
    /* Measured, not taste: overlaying MADE's Inter on a screenshot of a
       shipping product's UI, the glyphs matched outline-for-outline while the
       word ran ~2% wider — the difference was all tracking. Inter's own
       designer ships the same guidance, and the app has been drawing it a
       notch loose since the day it was made the default. */
    tracking: "-0.011em",
  },
  {
    id: "atkinson",
    label: "Atkinson",
    stack: `"Atkinson Hyperlegible Next Zero", ${INTER_STACK}`,
    /* Deliberately untracked. The whole point of this face is letterform
       separation for low-vision reading; tightening it undoes the feature it
       was picked for. */
  },
  {
    id: "geist",
    label: "Geist",
    stack: `"Geist Variable", ${INTER_STACK}`,
  },
  {
    id: "plex",
    label: "IBM Plex Sans",
    stack: `"IBM Plex Sans Variable", ${INTER_STACK}`,
  },
  {
    id: "schibsted",
    label: "Schibsted Grotesk",
    stack: `"Schibsted Grotesk Variable", ${INTER_STACK}`,
  },
  {
    id: "publicsans",
    label: "Public Sans",
    stack: `"Public Sans Variable", ${INTER_STACK}`,
  },
] as const satisfies readonly UiFontDef[];

export type UiFont = (typeof UI_FONTS)[number]["id"];

/** The face used when nothing is chosen, and the fallback for an unknown id. */
export const DEFAULT_UI_FONT: UiFont = "inter";

/** The app's PRIMARY LABEL size in px, and the anchor the whole chrome scales
 *  against. The UI is authored at 17 distinct sizes (the mass at 11/12/13px),
 *  so there is no single size to set outright — instead App.tsx divides the
 *  user's pick by this to get `--ezy-font-scale`, and every authored size is
 *  `calc(var(--ezy-font-scale, 1) * Npx)`. At the default the ratio is 1 and
 *  the app renders exactly as authored. */
export const UI_FONT_SIZE_DEFAULT = 13;

/** Bounds of the Settings → Appearance stepper, ≈80%–130% of the anchor.
 *  The ceiling is where the chrome stops fitting: row heights are FIXED (30/32/
 *  36px) because the setting scales text only, so past ~17px a single-line row
 *  crowds and fixed-width badges start to ellipsize. */
export const UI_FONT_SIZE_MIN = 10;
export const UI_FONT_SIZE_MAX = 17;

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

/**
 * Tracking for a persisted id, as a CSS `letter-spacing` value.
 *
 * Returns "normal" for a face that declares none — never "" and never
 * `undefined`. Both of those reach the CSS var as an empty or literal-undefined
 * token, at which point `letter-spacing` is invalid and the declaration is
 * dropped, so the PREVIOUS font's tracking stays on screen until something else
 * repaints. Switching to an untracked face has to actively say "normal".
 *
 * Unknown ids resolve like uiFontStack does — through the default, not through
 * the raw id.
 */
export function uiFontTracking(id: string): string {
  // Widened to UiFontDef on purpose. `as const satisfies` keeps each entry's
  // literal type, so an entry that omits `tracking` has no such property at all
  // and the union cannot be read through — the interface is where the field is
  // optional.
  const font: UiFontDef =
    UI_FONTS.find((f) => f.id === id) ?? UI_FONTS.find((f) => f.id === DEFAULT_UI_FONT)!;
  return font.tracking ?? "normal";
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
