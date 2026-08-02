import type { ITheme } from "@xterm/xterm";

export interface MadeSurface {
  bg: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  borderSubtle: string;
  borderLight: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  accentHover: string;
  accentDim: string;
  accentGlow: string;
  red: string;
  cyan: string;
  /** Diff counts (+N / −N). SEMANTIC, not decorative: these must never be
   *  wired to `accent`/`red`, because a red-accent theme like Black Steel
   *  collapses both into one color and the two numbers stop being readable
   *  as added-vs-removed — see
   *  docs/learnings/2026-03-12-semantic-colors-and-theme-additions.md.
   *  Optional: omit and the theme gets SEMANTIC_DIFF_* below. Override only
   *  with a pair that still reads unmistakably as green-vs-red. */
  diffAdd?: string;
  diffRemove?: string;
}

/** The universal diff pair, used by every theme that does not override it.
 *  Deliberately theme-independent — see `diffAdd` above. */
export const SEMANTIC_DIFF_ADD = "#4ade80";
export const SEMANTIC_DIFF_REMOVE = "#f87171";

export interface MadeTheme {
  id: string;
  name: string;
  terminal: ITheme;
  surface: MadeSurface;
  /** Multiplier applied to every corner radius via `--ezy-radius-scale`
   *  (App.tsx theme effect). Unset = 1 = the standard MADE radii. */
  radiusScale?: number;
}

// ─── Default (GitHub Dark) ───────────────────────────────────────────

const defaultTheme: MadeTheme = {
  id: "default",
  name: "Default",
  terminal: {
    background: "#0d1117",
    foreground: "#e6edf3",
    cursor: "#58a6ff",
    cursorAccent: "#0d1117",
    selectionBackground: "#264f78",
    selectionForeground: "#e6edf3",
    selectionInactiveBackground: "#264f7844",
    black: "#484f58",
    red: "#ff7b72",
    green: "#3fb950",
    yellow: "#d2a8ff",
    blue: "#79c0ff",
    magenta: "#d2a8ff",
    cyan: "#39d353",
    white: "#e6edf3",
    brightBlack: "#6e7681",
    brightRed: "#ffa198",
    brightGreen: "#56d364",
    brightYellow: "#e2c5ff",
    brightBlue: "#a5d6ff",
    brightMagenta: "#e2c5ff",
    brightCyan: "#56d364",
    brightWhite: "#ffffff",
  },
  surface: {
    bg: "#0d1117",
    surface: "#161b22",
    surfaceRaised: "#1c2128",
    border: "#30363d",
    borderSubtle: "#21262d",
    borderLight: "#484f58",
    text: "#e6edf3",
    textSecondary: "#c9d1d9",
    textMuted: "#8b949e",
    accent: "#39d353",
    accentHover: "#2ea043",
    accentDim: "#238636",
    accentGlow: "rgba(255, 255, 255, 0.06)",
    red: "#f85149",
    cyan: "#58d5c1",
  },
};

// ─── Nord ────────────────────────────────────────────────────────────

const nordTheme: MadeTheme = {
  id: "nord",
  name: "Nord",
  terminal: {
    background: "#2e3440",
    foreground: "#d8dee9",
    cursor: "#88c0d0",
    cursorAccent: "#2e3440",
    selectionBackground: "#434c5e",
    selectionForeground: "#d8dee9",
    selectionInactiveBackground: "#434c5e88",
    black: "#3b4252",
    red: "#bf616a",
    green: "#a3be8c",
    yellow: "#ebcb8b",
    blue: "#81a1c1",
    magenta: "#b48ead",
    cyan: "#88c0d0",
    white: "#e5e9f0",
    brightBlack: "#4c566a",
    brightRed: "#bf616a",
    brightGreen: "#a3be8c",
    brightYellow: "#ebcb8b",
    brightBlue: "#81a1c1",
    brightMagenta: "#b48ead",
    brightCyan: "#8fbcbb",
    brightWhite: "#eceff4",
  },
  surface: {
    bg: "#2e3440",
    surface: "#3b4252",
    surfaceRaised: "#434c5e",
    border: "#4c566a",
    borderSubtle: "#3b4252",
    borderLight: "#616e88",
    text: "#eceff4",
    textSecondary: "#d8dee9",
    textMuted: "#7b88a1",
    accent: "#88c0d0",
    accentHover: "#8fbcbb",
    accentDim: "#5e81ac",
    accentGlow: "rgba(255, 255, 255, 0.06)",
    red: "#bf616a",
    cyan: "#8fbcbb",
  },
};

// ─── Dracula ─────────────────────────────────────────────────────────

const draculaTheme: MadeTheme = {
  id: "dracula",
  name: "Dracula",
  terminal: {
    background: "#282a36",
    foreground: "#f8f8f2",
    cursor: "#f8f8f2",
    cursorAccent: "#282a36",
    selectionBackground: "#44475a",
    selectionForeground: "#f8f8f2",
    selectionInactiveBackground: "#44475a88",
    black: "#21222c",
    red: "#ff5555",
    green: "#50fa7b",
    yellow: "#f1fa8c",
    blue: "#bd93f9",
    magenta: "#ff79c6",
    cyan: "#8be9fd",
    white: "#f8f8f2",
    brightBlack: "#6272a4",
    brightRed: "#ff6e6e",
    brightGreen: "#69ff94",
    brightYellow: "#ffffa5",
    brightBlue: "#d6acff",
    brightMagenta: "#ff92df",
    brightCyan: "#a4ffff",
    brightWhite: "#ffffff",
  },
  surface: {
    bg: "#282a36",
    surface: "#2d2f3d",
    surfaceRaised: "#343746",
    border: "#44475a",
    borderSubtle: "#343746",
    borderLight: "#6272a4",
    text: "#f8f8f2",
    textSecondary: "#e2e0dc",
    textMuted: "#6272a4",
    accent: "#bd93f9",
    accentHover: "#caa8ff",
    accentDim: "#9470d6",
    accentGlow: "rgba(255, 255, 255, 0.06)",
    red: "#ff5555",
    cyan: "#8be9fd",
  },
};

// ─── Cyberpunk ───────────────────────────────────────────────────────

const cyberpunkTheme: MadeTheme = {
  id: "cyberpunk",
  name: "Cyberpunk",
  terminal: {
    background: "#0a0e14",
    foreground: "#e0e0e0",
    cursor: "#ff2eaf",
    cursorAccent: "#0a0e14",
    selectionBackground: "#1a1e2e",
    selectionForeground: "#e0e0e0",
    selectionInactiveBackground: "#1a1e2e88",
    black: "#1a1e2e",
    red: "#ff3c6f",
    green: "#39ff14",
    yellow: "#ffe600",
    blue: "#00d4ff",
    magenta: "#ff2eaf",
    cyan: "#00ffc8",
    white: "#e0e0e0",
    brightBlack: "#3d4466",
    brightRed: "#ff6b8a",
    brightGreen: "#65ff4a",
    brightYellow: "#fff44f",
    brightBlue: "#42e0ff",
    brightMagenta: "#ff65c5",
    brightCyan: "#42ffd9",
    brightWhite: "#ffffff",
  },
  surface: {
    bg: "#0a0e14",
    surface: "#111520",
    surfaceRaised: "#1a1e2e",
    border: "#2a2e3e",
    borderSubtle: "#1a1e2e",
    borderLight: "#3d4466",
    text: "#e0e0e0",
    textSecondary: "#b0b0b0",
    textMuted: "#5a5e7e",
    accent: "#ff2eaf",
    accentHover: "#ff65c5",
    accentDim: "#b8207a",
    accentGlow: "rgba(255, 255, 255, 0.06)",
    red: "#ff3c6f",
    cyan: "#00ffc8",
  },
};

// ─── Ocean ───────────────────────────────────────────────────────────

const oceanTheme: MadeTheme = {
  id: "ocean",
  name: "Ocean",
  terminal: {
    background: "#0b1929",
    foreground: "#d6deeb",
    cursor: "#80a4c2",
    cursorAccent: "#0b1929",
    selectionBackground: "#1d3b53",
    selectionForeground: "#d6deeb",
    selectionInactiveBackground: "#1d3b5388",
    black: "#152a3e",
    red: "#ef5350",
    green: "#22da6e",
    yellow: "#c5e478",
    blue: "#82aaff",
    magenta: "#c792ea",
    cyan: "#7fdbca",
    white: "#d6deeb",
    brightBlack: "#3c5d7b",
    brightRed: "#f07178",
    brightGreen: "#4ae88c",
    brightYellow: "#d9f08e",
    brightBlue: "#9cc4ff",
    brightMagenta: "#ddb0f6",
    brightCyan: "#9ae9d8",
    brightWhite: "#ffffff",
  },
  surface: {
    bg: "#0b1929",
    surface: "#112240",
    surfaceRaised: "#1d3b53",
    border: "#2a4a6b",
    borderSubtle: "#1d3b53",
    borderLight: "#3c5d7b",
    text: "#d6deeb",
    textSecondary: "#b0bec5",
    textMuted: "#5f7e97",
    accent: "#82aaff",
    accentHover: "#9cc4ff",
    accentDim: "#5a7ec2",
    accentGlow: "rgba(255, 255, 255, 0.06)",
    red: "#ef5350",
    cyan: "#7fdbca",
  },
};

// ─── Aurora ──────────────────────────────────────────────────────────

const auroraTheme: MadeTheme = {
  id: "aurora",
  name: "Aurora",
  terminal: {
    background: "#1a1b26",
    foreground: "#c0caf5",
    cursor: "#c0caf5",
    cursorAccent: "#1a1b26",
    selectionBackground: "#33467c",
    selectionForeground: "#c0caf5",
    selectionInactiveBackground: "#33467c88",
    black: "#15161e",
    red: "#f7768e",
    green: "#9ece6a",
    yellow: "#e0af68",
    blue: "#7aa2f7",
    magenta: "#bb9af7",
    cyan: "#7dcfff",
    white: "#c0caf5",
    brightBlack: "#414868",
    brightRed: "#f7768e",
    brightGreen: "#9ece6a",
    brightYellow: "#e0af68",
    brightBlue: "#7aa2f7",
    brightMagenta: "#bb9af7",
    brightCyan: "#7dcfff",
    brightWhite: "#c0caf5",
  },
  surface: {
    bg: "#1a1b26",
    surface: "#1f2335",
    surfaceRaised: "#292e42",
    border: "#3b4261",
    borderSubtle: "#292e42",
    borderLight: "#545c7e",
    text: "#c0caf5",
    textSecondary: "#a9b1d6",
    textMuted: "#565f89",
    accent: "#7aa2f7",
    accentHover: "#89b4fa",
    accentDim: "#5a7ec2",
    accentGlow: "rgba(255, 255, 255, 0.06)",
    red: "#f7768e",
    cyan: "#7dcfff",
  },
};

// ─── Monokai ─────────────────────────────────────────────────────────

const monokaiTheme: MadeTheme = {
  id: "monokai",
  name: "Monokai",
  terminal: {
    background: "#272822",
    foreground: "#f8f8f2",
    cursor: "#f8f8f0",
    cursorAccent: "#272822",
    selectionBackground: "#49483e",
    selectionForeground: "#f8f8f2",
    selectionInactiveBackground: "#49483e88",
    black: "#272822",
    red: "#f92672",
    green: "#a6e22e",
    yellow: "#f4bf75",
    blue: "#66d9ef",
    magenta: "#ae81ff",
    cyan: "#a1efe4",
    white: "#f8f8f2",
    brightBlack: "#75715e",
    brightRed: "#f92672",
    brightGreen: "#a6e22e",
    brightYellow: "#f4bf75",
    brightBlue: "#66d9ef",
    brightMagenta: "#ae81ff",
    brightCyan: "#a1efe4",
    brightWhite: "#f9f8f5",
  },
  surface: {
    bg: "#272822",
    surface: "#2d2e27",
    surfaceRaised: "#3e3d32",
    border: "#49483e",
    borderSubtle: "#3e3d32",
    borderLight: "#75715e",
    text: "#f8f8f2",
    textSecondary: "#e0e0da",
    textMuted: "#75715e",
    accent: "#a6e22e",
    accentHover: "#b8f334",
    accentDim: "#7ca61e",
    accentGlow: "rgba(255, 255, 255, 0.06)",
    red: "#f92672",
    cyan: "#a1efe4",
  },
};

// ─── Gruvbox Hard ───────────────────────────────────────────────────
//
// The *hard* contrast variant (#1d2021). `id` stays "gruvbox-dark" so
// anyone who already had this selected keeps it — only the label moved.

const gruvboxDarkHardTheme: MadeTheme = {
  id: "gruvbox-dark",
  name: "Gruvbox Hard",
  terminal: {
    background: "#1d2021",
    foreground: "#ebdbb2",
    cursor: "#ebdbb2",
    cursorAccent: "#1d2021",
    selectionBackground: "#504945",
    selectionForeground: "#ebdbb2",
    selectionInactiveBackground: "#50494588",
    black: "#282828",
    red: "#cc241d",
    green: "#98971a",
    yellow: "#d79921",
    blue: "#458588",
    magenta: "#b16286",
    cyan: "#689d6a",
    white: "#a89984",
    brightBlack: "#928374",
    brightRed: "#fb4934",
    brightGreen: "#b8bb26",
    brightYellow: "#fabd2f",
    brightBlue: "#83a598",
    brightMagenta: "#d3869b",
    brightCyan: "#8ec07c",
    brightWhite: "#ebdbb2",
  },
  surface: {
    bg: "#1d2021",
    surface: "#282828",
    surfaceRaised: "#3c3836",
    border: "#504945",
    borderSubtle: "#32302f",
    borderLight: "#665c54",
    text: "#ebdbb2",
    textSecondary: "#d5c4a1",
    textMuted: "#928374",
    accent: "#b8bb26",
    accentHover: "#d5c67a",
    accentDim: "#98971a",
    accentGlow: "rgba(255, 255, 255, 0.06)",
    red: "#fb4934",
    cyan: "#8ec07c",
  },
};

// ─── Gruvbox Dark (measured from Warp) ──────────────────────────────
//
// Sampled pixel-for-pixel out of a Warp screenshot rather than copied from
// the gruvbox spec, because the Hard variant above uses the *hard*
// background (#1d2021) while Warp ships the *medium* one. Measured: canvas
// #282828, chrome #31302e, active tab #43413b, block cursor #fc802d, text
// #ebdbb2. The 16 ANSI colors are canonical gruvbox — Warp matches there.
//
// `id` keeps its original "-v2" suffix on purpose: it is persisted in
// localStorage, so renaming it would reset everyone using this theme.

const gruvboxDarkTheme: MadeTheme = {
  id: "gruvbox-dark-v2",
  name: "Gruvbox Dark",
  terminal: {
    background: "#282828",
    foreground: "#ebdbb2",
    cursor: "#fc802d",
    cursorAccent: "#282828",
    selectionBackground: "#504945",
    selectionForeground: "#ebdbb2",
    selectionInactiveBackground: "#50494588",
    black: "#282828",
    red: "#cc241d",
    green: "#98971a",
    yellow: "#d79921",
    blue: "#458588",
    magenta: "#b16286",
    cyan: "#689d6a",
    white: "#a89984",
    brightBlack: "#928374",
    brightRed: "#fb4934",
    brightGreen: "#b8bb26",
    brightYellow: "#fabd2f",
    brightBlue: "#83a598",
    brightMagenta: "#d3869b",
    brightCyan: "#8ec07c",
    brightWhite: "#ebdbb2",
  },
  surface: {
    bg: "#282828",
    surface: "#31302e",
    surfaceRaised: "#43413b",
    border: "#504945",
    borderSubtle: "#3c3836",
    borderLight: "#665c54",
    text: "#ebdbb2",
    textSecondary: "#d5c4a1",
    textMuted: "#928374",
    accent: "#fc802d",
    accentHover: "#fd9753",
    accentDim: "#d65d0e",
    accentGlow: "rgba(255, 255, 255, 0.06)",
    red: "#fb4934",
    cyan: "#8ec07c",
  },
};

// ─── Solarized Dark ────────────────────────────────────────────────

const solarizedDarkTheme: MadeTheme = {
  id: "solarized-dark",
  name: "Solarized Dark",
  terminal: {
    background: "#002b36",
    foreground: "#839496",
    cursor: "#839496",
    cursorAccent: "#002b36",
    selectionBackground: "#073642",
    selectionForeground: "#93a1a1",
    selectionInactiveBackground: "#07364288",
    black: "#073642",
    red: "#dc322f",
    green: "#859900",
    yellow: "#b58900",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#2aa198",
    white: "#eee8d5",
    brightBlack: "#586e75",
    brightRed: "#cb4b16",
    brightGreen: "#586e75",
    brightYellow: "#657b83",
    brightBlue: "#839496",
    brightMagenta: "#6c71c4",
    brightCyan: "#93a1a1",
    brightWhite: "#fdf6e3",
  },
  surface: {
    bg: "#002b36",
    surface: "#073642",
    surfaceRaised: "#0a4050",
    border: "#1a5468",
    borderSubtle: "#0a4050",
    borderLight: "#586e75",
    text: "#93a1a1",
    textSecondary: "#839496",
    textMuted: "#586e75",
    accent: "#2aa198",
    accentHover: "#35bdb3",
    accentDim: "#1a7a73",
    accentGlow: "rgba(255, 255, 255, 0.06)",
    red: "#dc322f",
    cyan: "#268bd2",
  },
};

// ─── Black Steel (Dr. Disrespect) ───────────────────────────────────

const blackSteelTheme: MadeTheme = {
  id: "black-steel",
  name: "Black Steel",
  terminal: {
    background: "#09090b",
    foreground: "#d4d4d8",
    cursor: "#dc2626",
    cursorAccent: "#09090b",
    selectionBackground: "#302020",
    selectionForeground: "#fafafa",
    selectionInactiveBackground: "#30202066",
    black: "#18181b",
    red: "#ef4444",
    green: "#4ade80",
    yellow: "#fbbf24",
    blue: "#60a5fa",
    magenta: "#f472b6",
    cyan: "#22d3ee",
    white: "#d4d4d8",
    brightBlack: "#3f3f46",
    brightRed: "#f87171",
    brightGreen: "#86efac",
    brightYellow: "#fde68a",
    brightBlue: "#93c5fd",
    brightMagenta: "#f9a8d4",
    brightCyan: "#67e8f9",
    brightWhite: "#fafafa",
  },
  surface: {
    bg: "#09090b",
    surface: "#131316",
    surfaceRaised: "#1c1c20",
    border: "#27272a",
    borderSubtle: "#1c1c20",
    borderLight: "#3f3f46",
    text: "#fafafa",
    textSecondary: "#d4d4d8",
    textMuted: "#a1a1aa",
    accent: "#dc2626",
    accentHover: "#ef4444",
    accentDim: "#991b1b",
    accentGlow: "rgba(255, 255, 255, 0.06)",
    red: "#ef4444",
    cyan: "#71717a",
  },
};

// ─── Graphite (monochrome) ──────────────────────────────────────────
//
// Every surface token is exactly neutral (r === g === b). The hierarchy is
// carried by brightness alone: near-white ink is the loudest thing on
// screen, controls sit a step below it in silver. The accent is
// deliberately mid-grey rather than white — the ToggleSwitch thumb is
// #fff, so a white track would swallow it (this keeps ~3:1 against it).
//
// The 16 ANSI colors keep just enough chroma (~30% saturation) that
// `git diff` red/green and error text still read at a glance; MADE's own
// danger color stays properly red for the same reason.

const graphiteTheme: MadeTheme = {
  id: "graphite",
  name: "Graphite",
  terminal: {
    background: "#101010",
    foreground: "#e6e6e6",
    cursor: "#e6e6e6",
    cursorAccent: "#101010",
    selectionBackground: "#333333",
    selectionForeground: "#f2f2f2",
    selectionInactiveBackground: "#33333388",
    black: "#2a2a2a",
    red: "#a85b5b",
    green: "#7f9a6b",
    yellow: "#a89264",
    blue: "#6b8299",
    magenta: "#8e7a94",
    cyan: "#6f9090",
    white: "#b8b8b8",
    brightBlack: "#4d4d4d",
    brightRed: "#c47a7a",
    brightGreen: "#9db98a",
    brightYellow: "#c7b184",
    brightBlue: "#8aa0b8",
    brightMagenta: "#ad99b3",
    brightCyan: "#8fb0b0",
    brightWhite: "#f2f2f2",
  },
  surface: {
    bg: "#101010",
    surface: "#242424",
    surfaceRaised: "#303030",
    border: "#3d3d3d",
    borderSubtle: "#292929",
    borderLight: "#525252",
    text: "#f2f2f2",
    textSecondary: "#b8b8b8",
    textMuted: "#7a7a7a",
    accent: "#949494",
    accentHover: "#b5b5b5",
    accentDim: "#6b6b6b",
    accentGlow: "rgba(255, 255, 255, 0.06)",
    red: "#c25b5b",
    cyan: "#c9c9c9",
  },
};

// ─── Goldphite (monochrome + gold) ──────────────────────────────────
//
// Graphite with a single warm accent. The gold is a deep antique tone
// rather than a bright metallic one for the same reason Graphite's accent
// is silver: the ToggleSwitch thumb is #fff, and anything lighter than
// ~#959595-equivalent luminance swallows it. #b08d3a keeps 3.1:1 against
// the thumb while still reading 6:1 as text on the background. The
// brighter #d4af37 is reserved for hover and the terminal cursor, where
// nothing sits on top of it.

const goldphiteTheme: MadeTheme = {
  id: "goldphite",
  name: "Goldphite",
  terminal: {
    background: "#101010",
    foreground: "#e6e6e6",
    cursor: "#d4af37",
    cursorAccent: "#101010",
    selectionBackground: "#333333",
    selectionForeground: "#f2f2f2",
    selectionInactiveBackground: "#33333388",
    black: "#2a2a2a",
    red: "#a85b5b",
    green: "#7f9a6b",
    yellow: "#a89264",
    blue: "#6b8299",
    magenta: "#8e7a94",
    cyan: "#6f9090",
    white: "#b8b8b8",
    brightBlack: "#4d4d4d",
    brightRed: "#c47a7a",
    brightGreen: "#9db98a",
    brightYellow: "#c7b184",
    brightBlue: "#8aa0b8",
    brightMagenta: "#ad99b3",
    brightCyan: "#8fb0b0",
    brightWhite: "#f2f2f2",
  },
  surface: {
    bg: "#101010",
    surface: "#242424",
    surfaceRaised: "#303030",
    border: "#3d3d3d",
    borderSubtle: "#292929",
    borderLight: "#525252",
    text: "#f2f2f2",
    textSecondary: "#b8b8b8",
    textMuted: "#7a7a7a",
    accent: "#b08d3a",
    accentHover: "#d4af37",
    accentDim: "#7d6427",
    accentGlow: "rgba(255, 255, 255, 0.06)",
    red: "#c25b5b",
    cyan: "#c9c9c9",
  },
};

// ─── Heads (POS pastels) ────────────────────────────────────────────
//
// Sampled pixel-for-pixel from a screenshot of the Heads POS app the user
// works with (cos.png): canvas #131313, panel #1d1d1d, tile #272727, pill
// #323232, pastel action colors green #80e2ad / periwinkle #92bcff / pink
// #f4b4d1, coral notification dot #fd8183, ghost-logo gray #454545.
//
// The accent is the pastel green the app uses for its highlighted actions,
// kept authentic per user choice even though the white ToggleSwitch thumb
// sits at ~1.6:1 on it — the track color change still signals state. All
// four app colors appear: green = accent, periwinkle = cyan token + ANSI
// blue, coral = red token, pink = ANSI magenta. ANSI yellow/cyan have no
// source in the app and are authored at the same pastel lightness.
//
// radiusScale doubles every corner radius (6px surfaces → 12px) to match
// the app's pillowy tiles — the only theme that sets it.

const headsTheme: MadeTheme = {
  id: "heads",
  name: "Heads",
  radiusScale: 2,
  terminal: {
    background: "#131313",
    foreground: "#ececec",
    cursor: "#80e2ad",
    cursorAccent: "#131313",
    // Selection is the app's pink at terminal weight: same hue (333°) as the
    // "Flere rader" tile, darkened until it sits the same distance off the
    // canvas as the plain grey it replaces (1.5:1) so it highlights without
    // becoming a block. `selectionForeground` repaints selected text white
    // regardless of its ANSI color, and clears 12.2:1 on this.
    selectionBackground: "#56253b",
    selectionForeground: "#ffffff",
    selectionInactiveBackground: "#56253b88",
    black: "#272727",
    red: "#fd8183",
    green: "#80e2ad",
    yellow: "#f2d5a0",
    blue: "#92bcff",
    magenta: "#f4b4d1",
    cyan: "#8fdfdf",
    white: "#d9d9d9",
    brightBlack: "#454545",
    brightRed: "#ffa3a5",
    brightGreen: "#a0e9c2",
    brightYellow: "#f8e3bc",
    brightBlue: "#b3d0ff",
    brightMagenta: "#f9cbdf",
    brightCyan: "#b2ebeb",
    brightWhite: "#ffffff",
  },
  surface: {
    bg: "#131313",
    surface: "#1d1d1d",
    surfaceRaised: "#272727",
    border: "#323232",
    borderSubtle: "#232323",
    borderLight: "#454545",
    text: "#f5f5f5",
    textSecondary: "#c4c4c4",
    textMuted: "#8a8a8a",
    accent: "#80e2ad",
    accentHover: "#a0e9c2",
    accentDim: "#57b585",
    accentGlow: "rgba(255, 255, 255, 0.06)",
    red: "#fd8183",
    cyan: "#92bcff",
    // The only theme that restyles the diff counts, straight off the POS app's
    // own tiles: green "Opprett kunde" and pink "Flere rader" (11.9:1 / 10.9:1
    // on this canvas). Pink rather than the coral `red` above is deliberate —
    // it is the palette the app actually ships. The two sit at nearly the same
    // luminance, so they are told apart by hue; the +/− signs carry the meaning
    // regardless.
    diffAdd: "#80e2ad",
    diffRemove: "#f4b4d1",
  },
};

// ─── Heads 2.0 (POS pastels, rationed) ──────────────────────────────
//
// Same source app as `heads`, but designed from it rather than sampled
// off it. The screenshot's real idea is not its hex values — it is that
// colour is RATIONED: of ~20 action tiles only five are coloured, the
// rest are inert grey with dimmed labels, and the tiles separate by fill
// with no stroke at all. v1 lifted the swatches and spent them evenly;
// 2.0 spends them the way the app does.
//
// Three consequences, in order of how much they change the theme:
//
// 1. Accent is periwinkle, not mint. In the app, periwinkle marks the
//    tiles that TAKE YOU SOMEWHERE (Kassaoppgjør, Backoffice, Åpne
//    kasse) and mint marks the ones that COMMIT (Opprett kunde, Hent
//    parkert). A terminal accent is navigational — focus ring, active
//    tab, cursor — so periwinkle is the honest mapping and v1 had it
//    inverted. Mint keeps its commit role as `surface.cyan`, the
//    secondary signal.
//
// 2. The four authentic app colours live in the BRIGHT row, verbatim:
//    mint #80e2ad, periwinkle #92bcff, pink #f4b4d1, coral #fd8183. The
//    normal row is those same hues pulled down ~1.4-1.7x in luminance.
//    So the true Heads palette appears exactly where the terminal itself
//    says "this matters" — the same rationing, one layer down. v1
//    scattered the four across both rows and invented yellow/cyan from
//    nothing; here they are derived at the ramp's own lightness so they
//    read as family, and every hue clears 4.5:1 on the canvas (v1's
//    pastels all sat at one lightness and smeared at 13px).
//
// 3. Neutrals carry a faint cool cast (#101315 vs v1's flat #131313) so
//    the pastels read as emitted rather than pasted on, and `border`
//    drops to #2b3033 — just above the tile it edges — because the app
//    has no strokes. Separation comes from the fill steps; borderLight
//    (#454b4e, the ghost-logo grey) is kept for edges that must be seen.
//
// radiusScale 2 is inherited: the pillowy 12px tile is the app's most
// physical trait and the one thing v1 got exactly right.
//
// Known hole, stated rather than hidden: the white ToggleSwitch thumb
// sits at 1.93:1 on the periwinkle track. That is short of 3:1, but it
// is better than v1's 1.57:1 on mint, and the track colour change still
// carries the state.

const heads2Theme: MadeTheme = {
  id: "heads2",
  name: "Heads 2.0",
  radiusScale: 2,
  terminal: {
    background: "#101315",
    foreground: "#eef1f0",
    cursor: "#92bcff",
    cursorAccent: "#101315",
    // Periwinkle-tinted rather than v1's neutral grey — selection is a
    // navigational state, so it belongs to the accent hue.
    selectionBackground: "#2b3742",
    selectionForeground: "#ffffff",
    selectionInactiveBackground: "#2b374288",
    black: "#232829",
    red: "#e8595c",
    green: "#3fb87a",
    yellow: "#c2a05e",
    blue: "#6d9de8",
    magenta: "#d47aa6",
    cyan: "#4fb9b0",
    white: "#bdc4c3",
    brightBlack: "#5a6265",
    brightRed: "#fd8183",
    brightGreen: "#80e2ad",
    brightYellow: "#f0d29b",
    brightBlue: "#92bcff",
    brightMagenta: "#f4b4d1",
    brightCyan: "#8fd9d2",
    brightWhite: "#ffffff",
  },
  surface: {
    bg: "#101315",
    surface: "#191d20",
    surfaceRaised: "#232829",
    border: "#2b3033",
    borderSubtle: "#1f2426",
    borderLight: "#454b4e",
    text: "#eef1f0",
    textSecondary: "#bdc4c3",
    textMuted: "#87908f",
    accent: "#92bcff",
    accentHover: "#b3d0ff",
    accentDim: "#5b82c4",
    accentGlow: "rgba(255, 255, 255, 0.06)",
    red: "#fd8183",
    cyan: "#7ee0ab",
  },
};

// ─── Panini (light) ─────────────────────────────────────────────────
//
// MADE's only light theme. Palette borrowed from the `panini` token set in
// the wc-draft project (src/ui/theme/tokens.css, read-only reference):
// warm sticker-album paper #f3ecd8, ink #1b1a17, sticker red #e8462b,
// pitch green #2f7d4f, gold #c8a24b, paper line #d8cfb4, deep cyan
// #0f8fa6. The ANSI set is darkened from those hues so it stays legible on
// cream — on a light background "bright" means more contrast, i.e. darker,
// which is why brightWhite is ink rather than white.
//
// accentGlow must be a DARK wash here: every dark theme uses a white one,
// which is invisible on paper.

const paniniTheme: MadeTheme = {
  id: "panini",
  name: "Panini",
  terminal: {
    background: "#f3ecd8",
    foreground: "#1b1a17",
    cursor: "#e8462b",
    cursorAccent: "#f3ecd8",
    selectionBackground: "#dfd3ad",
    selectionForeground: "#1b1a17",
    selectionInactiveBackground: "#dfd3ad88",
    // Darkened from the panini hues until each clears 4.5:1 on paper for the
    // normal set and 4.0:1 for bright — the source palette was built for
    // large UI shapes, not 13px terminal text.
    black: "#1b1a17",
    red: "#c43921",
    green: "#2d794c",
    yellow: "#876618",
    blue: "#1f6f8a",
    magenta: "#9c3f6b",
    cyan: "#0c7588",
    white: "#6b6452",
    brightBlack: "#797263",
    brightRed: "#d03f26",
    brightGreen: "#1a8435",
    brightYellow: "#8a7034",
    brightBlue: "#2e7b9c",
    brightMagenta: "#b4527c",
    brightCyan: "#1d7e90",
    brightWhite: "#2f2b23",
  },
  surface: {
    bg: "#f3ecd8",
    surface: "#ffffff",
    surfaceRaised: "#fbf5e4",
    border: "#d8cfb4",
    borderSubtle: "#e7dfc4",
    borderLight: "#bfb492",
    text: "#1b1a17",
    textSecondary: "#4a453a",
    textMuted: "#6b6452",
    accent: "#e8462b",
    accentHover: "#cf3a21",
    accentDim: "#a82d18",
    accentGlow: "rgba(27, 26, 23, 0.06)",
    red: "#d23b22",
    cyan: "#0f8fa6",
  },
};

// ─── Porcelain (light) ──────────────────────────────────────────────
//
// Cool, near-neutral paper with slate ink and one indigo accent. Where Panini
// is warm and printed, this is screen-white and clinical — the two light
// themes should not read as variations of each other.
//
// The ANSI hues were chosen first, then their lightness was SOLVED for: every
// normal entry clears 4.5:1 against the paper and every bright one 4.0:1.
// Picking light-theme terminal colors by eye is how you end up with a yellow
// nobody can read.

const porcelainTheme: MadeTheme = {
  id: "porcelain",
  name: "Porcelain",
  terminal: {
    background: "#fbfbfd",
    foreground: "#1c2024",
    cursor: "#4a5bd0",
    cursorAccent: "#fbfbfd",
    selectionBackground: "#d7dcf5",
    selectionForeground: "#1c2024",
    selectionInactiveBackground: "#d7dcf588",
    black: "#1c2024",
    red: "#cf4146",
    green: "#27844f",
    yellow: "#916f21",
    blue: "#4a5bd0",
    magenta: "#9e54c2",
    cyan: "#0b808e",
    white: "#6b7280",
    brightBlack: "#8b919c",
    brightRed: "#dd454a",
    brightGreen: "#2a8d55",
    brightYellow: "#9b7724",
    brightBlue: "#5a6ae0",
    brightMagenta: "#a457c9",
    brightCyan: "#0c8998",
    brightWhite: "#2b3138",
  },
  surface: {
    bg: "#fbfbfd",
    surface: "#ffffff",
    surfaceRaised: "#f2f3f7",
    border: "#dcdfe6",
    borderSubtle: "#ebedf2",
    borderLight: "#bcc1cc",
    text: "#1c2024",
    textSecondary: "#454b54",
    textMuted: "#6b7280",
    accent: "#4a5bd0",
    accentHover: "#3b49ae",
    accentDim: "#2f3a8c",
    accentGlow: "rgba(28, 32, 36, 0.06)",
    red: "#c9372c",
    cyan: "#0e7490",
  },
};

// ─── Solarized Light ────────────────────────────────────────────────
//
// Ethan Schoonover's palette, the counterpart to the Solarized Dark already in
// this list — base3 paper, base02 ink, and the canonical accent hues. Those
// accents are deliberately equiluminant, which is Solarized's whole idea and
// also why several of them sit near 3:1 on base3; each is darkened the minimum
// needed to clear 4.5:1 (bright: 4.0:1) so 13px terminal text stays readable.
// The hues themselves are untouched.

const solarizedLightTheme: MadeTheme = {
  id: "solarized-light",
  name: "Solarized Light",
  terminal: {
    background: "#fdf6e3",
    foreground: "#4f6169",
    cursor: "#cb4b16",
    cursorAccent: "#fdf6e3",
    selectionBackground: "#eee8d5",
    selectionForeground: "#073642",
    selectionInactiveBackground: "#eee8d588",
    black: "#073642",
    red: "#d5302d",
    green: "#687800",
    yellow: "#8f6c00",
    blue: "#2076b3",
    magenta: "#ca347c",
    cyan: "#217e77",
    white: "#5f747c",
    brightBlack: "#7d9199",
    brightRed: "#dc322f",
    brightGreen: "#708100",
    brightYellow: "#997400",
    brightBlue: "#237ebf",
    brightMagenta: "#d33682",
    brightCyan: "#238780",
    brightWhite: "#002b36",
  },
  surface: {
    bg: "#fdf6e3",
    surface: "#fffdf5",
    surfaceRaised: "#eee8d5",
    border: "#ddd6c1",
    borderSubtle: "#eee8d5",
    borderLight: "#b9b19c",
    text: "#073642",
    textSecondary: "#4f6169",
    textMuted: "#5f747c",
    accent: "#2076b3",
    accentHover: "#1a5f91",
    accentDim: "#14496f",
    accentGlow: "rgba(7, 54, 66, 0.06)",
    red: "#d5302d",
    cyan: "#217e77",
  },
};

// ─── Vibrant ANSI palette (toggle overlay) ──────────────────────────

// Basic 16 ANSI colors — vibrant replacements for indices 0-15
const VIBRANT_ANSI_16: Partial<ITheme> = {
  black: "#3a3a3a",
  red: "#ff5f5f",
  green: "#5fff87",
  yellow: "#ffd75f",
  blue: "#5fafff",
  magenta: "#ff5fd7",
  cyan: "#5fdfdf",
  white: "#e4e4e4",
  brightBlack: "#6c6c6c",
  brightRed: "#ff8787",
  brightGreen: "#87ffaf",
  brightYellow: "#ffff87",
  brightBlue: "#87d7ff",
  brightMagenta: "#ff87ff",
  brightCyan: "#87ffff",
  brightWhite: "#ffffff",
};

// Standard 256-color cube intensity levels: [0, 95, 135, 175, 215, 255]
const STD_LEVELS = [0, 0x5f, 0x87, 0xaf, 0xd7, 0xff];

/** Boost saturation + brightness of an RGB triplet. */
function vibrantize(r: number, g: number, b: number): [number, number, number] {
  const avg = (r + g + b) / 3;
  const satBoost = 0.75;
  const brightLift = 12;
  return [
    Math.max(0, Math.min(255, Math.round(r + (r - avg) * satBoost + brightLift))),
    Math.max(0, Math.min(255, Math.round(g + (g - avg) * satBoost + brightLift))),
    Math.max(0, Math.min(255, Math.round(b + (b - avg) * satBoost + brightLift))),
  ];
}

function toHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");
}

/** Generate vibrant extendedAnsi palette (indices 16-255, 240 entries). */
function buildVibrantExtendedAnsi(): string[] {
  const colors: string[] = [];

  // Indices 16-231: 6×6×6 color cube — boost saturation + brightness
  for (let ri = 0; ri < 6; ri++) {
    for (let gi = 0; gi < 6; gi++) {
      for (let bi = 0; bi < 6; bi++) {
        const r = STD_LEVELS[ri], g = STD_LEVELS[gi], b = STD_LEVELS[bi];
        // Skip near-black/near-white (no meaningful saturation to boost)
        if (r + g + b < 30 || (r > 240 && g > 240 && b > 240)) {
          colors.push(toHex(r, g, b));
        } else {
          const [vr, vg, vb] = vibrantize(r, g, b);
          colors.push(toHex(vr, vg, vb));
        }
      }
    }
  }

  // Indices 232-255: grayscale ramp — slightly boost brightness
  for (let i = 0; i < 24; i++) {
    const gray = 8 + i * 10; // standard: 8, 18, 28, ..., 238
    const boosted = Math.min(255, gray + 12);
    colors.push(toHex(boosted, boosted, boosted));
  }

  return colors;
}

// Pre-compute once — avoids recalculating on every toggle
const VIBRANT_EXTENDED_ANSI = buildVibrantExtendedAnsi();

// ─── Light-background adaptation ────────────────────────────────────
//
// MADE themes the 16 ANSI colors, but CLIs lean on the 256-color cube, and
// every one of those 240 entries is a fixed value chosen on the assumption of
// a dark canvas. Measured against Panini's paper, 9 of the 10 colors Claude
// Code actually emits fell below 3:1 — the statusline, paths, branch and
// context meter were effectively invisible. Theming the 16 could never have
// fixed it.
//
// The transform is a lightness inversion in HSL: hue and saturation are kept
// exactly, only L flips. That is the right operation for a palette used for
// BOTH text and fills — a light foreground becomes a dark one, and a dark
// "subtle" fill becomes a light one, so each entry keeps its relationship to
// the background instead of just being clamped to a contrast floor.

function relLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return 0;
  const [r, g, b] = [1, 2, 3].map((i) => {
    const c = parseInt(m[i], 16) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** A terminal canvas this bright wants the light-adapted palette. */
export function isLightBackground(hex: string | undefined): boolean {
  return relLuminance(hex ?? "#000000") > 0.4;
}

/** Flip a color's HSL lightness, preserving hue and saturation. */
function invertLightness(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const r = parseInt(m[1], 16) / 255;
  const g = parseInt(m[2], 16) / 255;
  const b = parseInt(m[3], 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) {
    const v = Math.round((1 - l) * 255); // pure grey — ramp inverts cleanly
    return toHex(v, v, v);
  }
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;

  const nl = 1 - l;
  const q = nl < 0.5 ? nl * (1 + s) : nl + s - nl * s;
  const p = 2 * nl - q;
  const chan = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return toHex(
    Math.round(chan(h + 1 / 3) * 255),
    Math.round(chan(h) * 255),
    Math.round(chan(h - 1 / 3) * 255),
  );
}

/** The xterm defaults for indices 16-255, which is what a pane gets when no
 *  `extendedAnsi` is supplied — rebuilt here so it can be adapted. */
function buildStandardExtendedAnsi(): string[] {
  const colors: string[] = [];
  for (let ri = 0; ri < 6; ri++) {
    for (let gi = 0; gi < 6; gi++) {
      for (let bi = 0; bi < 6; bi++) {
        colors.push(toHex(STD_LEVELS[ri], STD_LEVELS[gi], STD_LEVELS[bi]));
      }
    }
  }
  for (let i = 0; i < 24; i++) {
    const gray = 8 + i * 10;
    colors.push(toHex(gray, gray, gray));
  }
  return colors;
}

const STANDARD_EXTENDED_ANSI = buildStandardExtendedAnsi();

function contrast(a: string, b: string): number {
  const [x, y] = [relLuminance(a), relLuminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** HSL lightness of #rrggbb, 0..1. */
function lightnessOf(hex: string): number {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return 0;
  const c = [1, 2, 3].map((i) => parseInt(m[i], 16) / 255);
  return (Math.max(...c) + Math.min(...c)) / 2;
}

/** Scale toward black until `hex` clears `target` against `bg`, keeping hue. */
function ensureContrast(hex: string, bg: string, target: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const c = [1, 2, 3].map((i) => parseInt(m[i], 16));
  for (let k = 1; k >= 0; k -= 0.02) {
    const cand = toHex(...(c.map((v) => Math.round(v * k)) as [number, number, number]));
    if (contrast(cand, bg) >= target) return cand;
  }
  return "#000000";
}

/**
 * Adapt one palette entry to a light canvas.
 *
 * Inversion alone is not enough: a fully saturated hue like #ffd700 sits at
 * HSL L=0.5, so flipping L returns it unchanged — it stayed at 1.19:1 on paper,
 * still invisible. Hence the contrast floor.
 *
 * The floor is applied only to entries that were LIGHT to begin with. Those are
 * the ones a CLI uses as foreground against a dark canvas. Entries that were
 * already dark (#5f0000, the diff-removed fill) become light after inversion
 * and must stay that way — they are backgrounds, and forcing them to 4:1
 * against the paper would turn a soft highlight into a solid block.
 */
function adaptForLight(hex: string, bg: string): string {
  const inverted = invertLightness(hex);
  return lightnessOf(hex) < 0.5 ? inverted : ensureContrast(inverted, bg, 4.0);
}

// Keyed by canvas + palette so each light theme gets a set tuned to its own
// paper, built once.
const lightPaletteCache = new Map<string, string[]>();
function lightExtendedAnsi(bg: string, vibrant: boolean): string[] {
  const key = `${bg}|${vibrant}`;
  let out = lightPaletteCache.get(key);
  if (!out) {
    const source = vibrant ? VIBRANT_EXTENDED_ANSI : STANDARD_EXTENDED_ANSI;
    out = source.map((c) => adaptForLight(c, bg));
    lightPaletteCache.set(key, out);
  }
  return out;
}

const lightVibrant16Cache = new Map<string, Partial<ITheme>>();
function lightVibrantAnsi16(bg: string): Partial<ITheme> {
  let out = lightVibrant16Cache.get(bg);
  if (!out) {
    out = Object.fromEntries(
      Object.entries(VIBRANT_ANSI_16).map(([k, v]) => [k, adaptForLight(v as string, bg)]),
    );
    lightVibrant16Cache.set(bg, out);
  }
  return out;
}

/** Subtle brightness lift applied to the active CLI pane (both container + xterm canvas). */
export const ACTIVE_PANE_LIFT = 0.05;

/** Lift each channel of #rrggbb toward 255 by `amount` (0..1). */
function lightenHex(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  const lift = (c: number) => Math.round(c + (255 - c) * amount);
  return toHex(lift(r), lift(g), lift(b));
}

/** Darken each channel of #rrggbb toward 0 by `amount` (0..1). */
function darkenHex(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const drop = (c: number) => Math.round(c * (1 - amount));
  return toHex(
    drop(parseInt(m[1], 16)),
    drop(parseInt(m[2], 16)),
    drop(parseInt(m[3], 16)),
  );
}

/** The active pane reads as "lifted" — which on paper means a shade DARKER,
 *  not lighter. Lightening a light theme's canvas just bleaches it. */
function activeShade(hex: string): string {
  return isLightBackground(hex)
    ? darkenHex(hex, ACTIVE_PANE_LIFT)
    : lightenHex(hex, ACTIVE_PANE_LIFT);
}

/** Default pane wash toward the project color, as a 0..1 blend fraction.
 *  User-adjustable via `projectPaneTintStrength` (whole percent, Settings >
 *  Appearance > Theme); every helper below takes the live amount with this as
 *  fallback so all surfaces — HWND canvas, xterm canvas, DOM padding strips,
 *  pane container — shift by the identical shade. 0.08 read as taking over
 *  the canvas; 0.04 is a hint you notice, not a color you sit in. */
export const PROJECT_TINT_AMOUNT = 0.04;

/** #rgb or #rrggbb → [r,g,b], null if neither. Project color presets are
 *  3-digit (#e55) while theme backgrounds are 6-digit. */
function parseHexRgb(hex: string): [number, number, number] | null {
  const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
  if (short) {
    return [
      parseInt(short[1] + short[1], 16),
      parseInt(short[2] + short[2], 16),
      parseInt(short[3] + short[3], 16),
    ];
  }
  const long = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!long) return null;
  return [parseInt(long[1], 16), parseInt(long[2], 16), parseInt(long[3], 16)];
}

/** Mix `tint` into `base` per channel by `amount` (0..1). */
function blendHex(base: string, tint: string, amount: number): string {
  const b = parseHexRgb(base);
  const t = parseHexRgb(tint);
  if (!b || !t) return base;
  const mix = (i: number) => Math.round(b[i] * (1 - amount) + t[i] * amount);
  return toHex(mix(0), mix(1), mix(2));
}

/** Project-color wash for any surface hex; identity when tint is null. */
export function projectTintBg(
  bg: string,
  tint: string | null | undefined,
  amount: number = PROJECT_TINT_AMOUNT,
): string {
  return tint ? blendHex(bg, tint, amount) : bg;
}

/** Container bg color for an active CLI pane in the given theme (shaded from `surface.bg`). */
export function getActivePaneBg(
  themeId: string,
  tint: string | null = null,
  tintAmount: number = PROJECT_TINT_AMOUNT,
): string {
  return activeShade(projectTintBg(getTheme(themeId).surface.bg, tint, tintAmount));
}

/** Container bg for an INACTIVE CLI pane. Without a tint this is a CSS var
 *  (identical to today's untinted container); with one it must become a
 *  concrete hex so the wash can blend into the theme surface. */
export function getInactivePaneBg(
  themeId: string,
  tint: string | null,
  tintAmount: number = PROJECT_TINT_AMOUNT,
): string {
  return tint ? projectTintBg(getTheme(themeId).surface.bg, tint, tintAmount) : "var(--ezy-bg)";
}

/** Returns the effective terminal theme, optionally with vibrant colors overlaid and an active-pane lift. */
export function getEffectiveTerminalTheme(
  themeId: string,
  vibrant: boolean,
  isActive: boolean = false,
  tint: string | null = null,
  tintAmount: number = PROJECT_TINT_AMOUNT,
): ITheme {
  const base = getTheme(themeId).terminal;
  const light = isLightBackground(base.background);
  // On a light canvas the 256-color cube has to be inverted or CLI output is
  // unreadable — see the light-background adaptation block above. The theme's
  // own 16 are already authored for the polarity, so only the vibrant overlay
  // needs flipping.
  const canvas = base.background ?? "#000000";
  const withVibrant = vibrant
    ? {
        ...base,
        ...(light ? lightVibrantAnsi16(canvas) : VIBRANT_ANSI_16),
        extendedAnsi: light ? lightExtendedAnsi(canvas, true) : VIBRANT_EXTENDED_ANSI,
      }
    : light
      ? { ...base, extendedAnsi: lightExtendedAnsi(canvas, false) }
      : base;
  // Project tint blends BEFORE the active lift so both pane states share the
  // wash and the active pane keeps exactly today's lift on top of it.
  const tinted = tint
    ? { ...withVibrant, background: projectTintBg(withVibrant.background ?? "#000000", tint, tintAmount) }
    : withVibrant;
  if (!isActive) return tinted;
  return {
    ...tinted,
    background: activeShade(tinted.background ?? "#000000"),
    cursorAccent: activeShade(tinted.cursorAccent ?? tinted.background ?? "#000000"),
  };
}

// ─── Exports ─────────────────────────────────────────────────────────

export const THEMES: MadeTheme[] = [
  defaultTheme,
  nordTheme,
  draculaTheme,
  cyberpunkTheme,
  oceanTheme,
  auroraTheme,
  monokaiTheme,
  gruvboxDarkTheme,
  gruvboxDarkHardTheme,
  solarizedDarkTheme,
  blackSteelTheme,
  graphiteTheme,
  goldphiteTheme,
  headsTheme,
  heads2Theme,
  paniniTheme,
  porcelainTheme,
  solarizedLightTheme,
];

export const THEMES_MAP: Record<string, MadeTheme> = Object.fromEntries(
  THEMES.map((t) => [t.id, t])
);

// MADE ships in Heads. Note this is the id of the theme a FRESH install lands
// on — `merge()` in store/index.ts spreads persisted state last, so anyone with
// a saved themeId keeps it and switches in Settings → Appearance instead.
// index.css's `:root` block mirrors headsTheme.surface so the pre-hydration
// frame matches; change both together or launch flashes the old palette.
export const DEFAULT_THEME_ID = "heads";

export function getTheme(id: string): MadeTheme {
  return THEMES_MAP[id] ?? defaultTheme;
}
