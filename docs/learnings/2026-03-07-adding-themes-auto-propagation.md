# Adding Themes to EzyDev — Auto-Propagation System

**Date:** 2026-03-07

## Summary

Added Gruvbox Dark and Solarized Dark themes to EzyDev. The theme system is well-architected — adding a new theme requires editing only `src/lib/themes.ts` (define the theme constant + append to `THEMES` array). Everything else auto-propagates.

## How the Theme System Works

1. `THEMES` array feeds `THEMES_MAP` (Record lookup) and `getTheme()` (fallback to default).
2. `TabBar.tsx` reads `THEMES` for the dropdown selector — new themes appear automatically.
3. `App.tsx` injects CSS variables from `theme.surface` on theme change — UI surfaces update automatically.
4. `terminal-config.ts` and `editor-theme.ts` read from the active theme — terminal/editor colors update automatically.

## Key Details

- Each `EzyDevTheme` has two sections: `terminal` (xterm.js `ITheme` with 16 ANSI colors + selection/cursor) and `surface` (`EzyDevSurface` with bg/border/text/accent colors for the UI chrome).
- Theme `id` must be kebab-case (e.g. `gruvbox-dark`) — used as the persisted key in Zustand/localStorage.
- Theme `name` is display text in the dropdown (e.g. `Gruvbox Dark`).

## Verification

- `npx tsc --noEmit` passes clean.
- `npm run build` fails at vite/rollup step due to pre-existing WSL native module issue (`@rollup/rollup-linux-x64-gnu` missing) — unrelated to theme changes. This is a known WSL cross-compilation issue.

## Prevention

- When adding future themes, only `src/lib/themes.ts` needs editing. No other files.
- Use canonical color palettes from official sources (e.g. gruvbox-community, solarized) to ensure accuracy.
