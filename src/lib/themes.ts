import type { ITheme } from "@xterm/xterm";

export interface EzyDevSurface {
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
}

export interface EzyDevTheme {
  id: string;
  name: string;
  terminal: ITheme;
  surface: EzyDevSurface;
}

// ─── Default (GitHub Dark) ───────────────────────────────────────────

const defaultTheme: EzyDevTheme = {
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

const nordTheme: EzyDevTheme = {
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

const draculaTheme: EzyDevTheme = {
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

const cyberpunkTheme: EzyDevTheme = {
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

const oceanTheme: EzyDevTheme = {
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

const auroraTheme: EzyDevTheme = {
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

const monokaiTheme: EzyDevTheme = {
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

// ─── Gruvbox Dark ───────────────────────────────────────────────────

const gruvboxDarkTheme: EzyDevTheme = {
  id: "gruvbox-dark",
  name: "Gruvbox Dark",
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

// ─── Solarized Dark ────────────────────────────────────────────────

const solarizedDarkTheme: EzyDevTheme = {
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

const blackSteelTheme: EzyDevTheme = {
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

/** Returns the effective terminal theme, optionally with vibrant colors overlaid. */
export function getEffectiveTerminalTheme(themeId: string, vibrant: boolean): ITheme {
  const base = getTheme(themeId).terminal;
  if (!vibrant) return base;
  return { ...base, ...VIBRANT_ANSI_16, extendedAnsi: VIBRANT_EXTENDED_ANSI };
}

// ─── Exports ─────────────────────────────────────────────────────────

export const THEMES: EzyDevTheme[] = [
  defaultTheme,
  nordTheme,
  draculaTheme,
  cyberpunkTheme,
  oceanTheme,
  auroraTheme,
  monokaiTheme,
  gruvboxDarkTheme,
  solarizedDarkTheme,
  blackSteelTheme,
];

export const THEMES_MAP: Record<string, EzyDevTheme> = Object.fromEntries(
  THEMES.map((t) => [t.id, t])
);

export const DEFAULT_THEME_ID = "default";

export function getTheme(id: string): EzyDevTheme {
  return THEMES_MAP[id] ?? defaultTheme;
}
