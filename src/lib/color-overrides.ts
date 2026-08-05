// User color overrides: named presets whose colors sit on top of the active
// theme. Only keys the user actually set override; everything else stays
// theme-default, and the preset follows the user across theme switches.
//
// Key names deliberately match xterm's ITheme properties (plus three MADE
// extensions), so a terminal override map can be spread directly onto a theme
// object in getEffectiveTerminalTheme.

/** Core single-purpose colors. `link`/`searchMatch`/`searchMatchActive` are
 *  MADE extensions carried on EffectiveTerminalTheme, not standard ITheme. */
export const CORE_OVERRIDE_KEYS = [
  "background",
  "foreground",
  "cursor",
  "cursorAccent",
  "selectionBackground",
  "selectionForeground",
  "link",
  "searchMatch",
  "searchMatchActive",
] as const;

/** The 16 ANSI palette slots — what CLI output (diff added/removed lines,
 *  prompts, syntax) is actually drawn with. */
export const ANSI_OVERRIDE_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

/** App-chrome tokens (outside the pane): the accent and the +N/−N diff stat
 *  badges. These never reach the terminal theme — App.tsx feeds them into the
 *  CSS vars. */
export const CHROME_OVERRIDE_KEYS = ["accent", "diffAdd", "diffRemove"] as const;

export const OVERRIDE_KEYS = [
  ...CORE_OVERRIDE_KEYS,
  ...ANSI_OVERRIDE_KEYS,
  ...CHROME_OVERRIDE_KEYS,
] as const;

export type OverrideKey = (typeof OVERRIDE_KEYS)[number];

/** Sparse: only keys the user set exist. Values are always "#RRGGBB" — the
 *  picker normalizes #RGB and rejects 8-digit hex, because the native renderer
 *  drops alpha where xterm would honor it. */
export type ColorOverrides = Partial<Record<OverrideKey, string>>;

export interface TerminalColorPreset {
  id: string;
  name: string;
  overrides: ColorOverrides;
  createdAt: number;
}

/** Row copy for Settings — authored once so the search filter, labels and the
 *  per-renderer caveats stay in a single place. */
export const OVERRIDE_KEY_LABELS: Record<
  OverrideKey,
  { label: string; description?: string }
> = {
  background: { label: "Background" },
  foreground: { label: "Text" },
  cursor: { label: "Cursor" },
  cursorAccent: {
    label: "Cursor accent",
    description: "Text inside the block cursor. Xterm panes only.",
  },
  selectionBackground: { label: "Selection" },
  selectionForeground: { label: "Selected text" },
  link: {
    label: "Links",
    description: "Native panes only — xterm cannot recolor links.",
  },
  searchMatch: { label: "Search match" },
  searchMatchActive: {
    label: "Active search match",
    description: "The single match the pane's match counter is on.",
  },
  black: { label: "Black" },
  red: { label: "Red" },
  green: { label: "Green" },
  yellow: { label: "Yellow" },
  blue: { label: "Blue" },
  magenta: { label: "Magenta" },
  cyan: { label: "Cyan" },
  white: { label: "White" },
  brightBlack: { label: "Bright black" },
  brightRed: { label: "Bright red" },
  brightGreen: { label: "Bright green" },
  brightYellow: { label: "Bright yellow" },
  brightBlue: { label: "Bright blue" },
  brightMagenta: { label: "Bright magenta" },
  brightCyan: { label: "Bright cyan" },
  brightWhite: { label: "Bright white" },
  accent: {
    label: "Accent",
    description: "The app's highlight color — buttons, rings, active markers.",
  },
  diffAdd: {
    label: "Diff added badge",
    description: "The +N counters in tabs and app chrome.",
  },
  diffRemove: {
    label: "Diff removed badge",
    description: "The −N counters in tabs and app chrome.",
  },
};

/** Sorbet's pastel palette (themes.ts) + pastel purple, the picker's quick
 *  swatches. Yellow is Sorbet's own ANSI yellow — already at pastel lightness. */
export const SWATCH_PRESET_COLORS = [
  "#80e2ad", // pastel green (Sorbet accent)
  "#92bcff", // periwinkle
  "#f4b4d1", // pastel pink
  "#fd8183", // coral
  "#8fdfdf", // pastel cyan
  "#f2d5a0", // pastel yellow
  "#c4b5fd", // pastel purple
  "#ffffff", // white
] as const;

const CHROME_KEY_SET: ReadonlySet<string> = new Set(CHROME_OVERRIDE_KEYS);

/** The subset of an override map that applies to the terminal theme itself —
 *  chrome badge tokens stripped. Returns null when nothing terminal-facing is
 *  set, so callers can skip the override spread entirely. */
export function terminalOverrides(
  overrides: ColorOverrides | null | undefined
): ColorOverrides | null {
  if (!overrides) return null;
  const entries = Object.entries(overrides).filter(([k]) => !CHROME_KEY_SET.has(k));
  if (entries.length === 0) return null;
  return Object.fromEntries(entries) as ColorOverrides;
}
