import { getTheme, DEFAULT_THEME_ID } from "./themes";

// Re-export the default theme for backward compatibility.
// Components that need dynamic theming should use getTheme(themeId) directly.
const defaultTheme = getTheme(DEFAULT_THEME_ID);

export const EZYDEV_THEME = defaultTheme.terminal;

export const SURFACE_COLORS = {
  bg: defaultTheme.surface.bg,
  surface: defaultTheme.surface.surface,
  surfaceRaised: defaultTheme.surface.surfaceRaised,
  border: defaultTheme.surface.border,
  borderLight: defaultTheme.surface.borderLight,
  text: defaultTheme.surface.text,
  textMuted: defaultTheme.surface.textMuted,
  accent: defaultTheme.surface.accent,
  accentHover: defaultTheme.surface.accentHover,
} as const;
