# Terminal Font Rendering — Hack Font + Quality Tuning

**Date:** 2026-03-07

## Summary

Changed the terminal font from the default system monospace to Hack (Warp's default) and tuned xterm.js rendering settings to get as close to Warp's text quality as possible. Also implemented smart grid pane placement and dynamic font scaling.

## Symptoms

- Terminal text looked noticeably worse than Warp's rendering
- Default system monospace font lacked the polish of a purpose-built coding font
- At 16 panes (4x4 grid), the app became unresponsive — buttons and window resize stopped working

## Root Cause (Font Loading)

Getting Hack font to render in xterm.js required overcoming multiple layers:

1. **CSS `@font-face` fails silently in Tauri WebView** — relative `url()` paths in CSS are resolved by Vite at build time, but Tauri's WebView can resolve them differently at runtime. The font appeared loaded in DevTools but wasn't actually used by the canvas renderer.

2. **xterm.js canvas/WebGL renderers snapshot fonts at init time** — unlike DOM text which auto-swaps when fonts load late, the canvas renderer measures glyph widths once during `term.open()`. If the font isn't available at that moment, the renderer locks onto the fallback font permanently.

3. **WebGL addon builds its own glyph texture atlas** — even if the correct font was available at `term.open()`, loading the WebGL addon later creates a new atlas that may not pick up the font. Must re-apply `fontFamily` and `fontSize` after WebGL loads to force atlas rebuild.

### Failed Attempts

- **Attempt 1: CSS `@font-face` with absolute `/fonts/` path** — Vite passes absolute paths through without processing; Tauri's WebView couldn't resolve them.
- **Attempt 2: CSS `@font-face` with relative `./fonts/` path** — Vite processed the URL correctly, but the canvas renderer still didn't pick up the font because it loaded asynchronously after terminal init.
- **Attempt 3: FontFace API without waiting** — Called `document.fonts.add()` and `load()` but didn't await the promise before creating the terminal. Font wasn't ready at init time.
- **Debugging red herring: line 171 override** — During debugging, a line that re-applied `term.options.fontFamily` after `term.open()` kept overwriting test values (like "serif" or "Courier New"), making it appear the font setting wasn't working at all. Discovered by testing with obviously different fonts.

### Working Solution

```typescript
import hackRegularUrl from "../fonts/hack-regular.woff2?url";
// Vite ?url import gives resolved URL that works in both dev and prod

const regular = new FontFace("Hack", `url(${hackRegularUrl})`, { weight: "400" });
document.fonts.add(regular);
await regular.load(); // WAIT for font to be ready

// Only THEN create the terminal
const term = new Terminal({ fontFamily: "Hack, monospace", ... });
term.open(el);

// After WebGL loads, re-apply font to rebuild glyph atlas
const webgl = new WebglAddon();
term.loadAddon(webgl);
term.options.fontFamily = "Hack, monospace";
term.options.fontSize = 15;
```

## Root Cause (Rendering Quality)

Even with the correct font, xterm.js text looked worse than Warp because:

- Warp uses a custom GPU text renderer (wgpu/Metal) with precise subpixel glyph positioning
- xterm.js WebGL renders text to an off-screen Canvas 2D, then uploads as WebGL textures — extra indirection layer
- This gap is architectural and can't be fully closed in a WebView

### What Helped

- `fontSize: 15` (matched Warp's visual size)
- `lineHeight: 1.2` (tighter than default)
- `letterSpacing: 1` (user preference after testing)
- `minimumContrastRatio: 1` (preserve exact theme colors)
- `-webkit-font-smoothing: antialiased` + `text-rendering: optimizeLegibility` in CSS
- `font-feature-settings: "kern" 1, "liga" 1` for kerning and ligatures

### What Hurt (removed)

- **`image-rendering: pixelated` on canvas** — Forces nearest-neighbor interpolation, designed for pixel art. Makes text jaggier with DPI scaling. Browser's default bicubic interpolation is better for text.
- **Excessive `letterSpacing`** — Hack has carefully designed cell widths. Too much extra spacing looks wrong.

## Root Cause (Performance)

16 WebGL contexts exceed Chrome's ~16 context limit, causing thrashing. 16 ResizeObservers firing at 60fps = 960 fit() calls/sec during window resize.

### Fix

- Debounced ResizeObserver (100ms) — fit() fires once after resize stops
- Skip WebGL addon when >6 panes (canvas renderer is fine for small panes)
- Reduced scrollback to 2000 for >6 panes
- Dynamic font scaling based on pane width (15px down to 12px)

## Prevention

- **Always use JavaScript FontFace API for fonts in canvas-rendered contexts** — CSS @font-face is unreliable for non-DOM rendering
- **Always await font loading before creating canvas-based terminals**
- **Never use `image-rendering: pixelated` for text** — only for actual pixel art
- **Test font changes with obviously different fonts first** (serif, Courier New) to verify the setting actually works before debugging subtle differences
- **WebGL context limits matter** — skip GPU acceleration when many instances are active

## Verification

1. `npm run build` — passes
2. Restart app — Hack font renders correctly in terminal
3. Resize window small — font scales down to 14/13/12
4. Open 4x4 grid — app remains responsive (canvas renderer, no WebGL)
5. Compare side-by-side with Warp — noticeably closer in quality
