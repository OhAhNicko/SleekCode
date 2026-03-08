# Dev Server URL Hidden by Container Query Threshold

**Date:** 2026-03-08

## Summary

The full URL (`http://localhost:PORT`) in dev server rows was being hidden prematurely by a CSS container query. The breakpoint was set at 480px, but the grid column minimum was 460px, meaning the container query fired almost always — swapping the full URL for just `:PORT` even when there was ~30px of room to spare.

## Symptoms

- Full URL text (`http://localhost:1420`) not visible in dev server rows
- Only the short `:PORT` form shown (or appearing "gone" at a glance)
- Issue present at normal window widths

## Root Cause

CSS container query breakpoint mismatch:

```css
/* Grid sets minimum column width to 460px */
gridTemplateColumns: "repeat(auto-fill, minmax(460px, 1fr))"

/* Container query hid full URL at 480px — only 20px above the grid minimum */
@container (max-width: 480px) {
  .devserver-url-port { display: inline; }
  .devserver-url-full { display: none; }
}
```

The `.devserver-row` element has `containerType: "inline-size"`, making it a CSS container. Since grid cells are often at or near their 460px minimum, the 480px breakpoint triggered almost always — hiding the full URL when it could easily fit.

## Fix

Lowered the container query breakpoint from 480px to 450px in `src/index.css`:

```css
@container (max-width: 450px) { ... }
```

This gives 10px of buffer below the grid minimum (460px), so the full URL stays visible at normal widths and only collapses when the container is genuinely narrow.

## Prevention

- When using CSS container queries alongside CSS Grid `minmax()`, ensure the container query breakpoint is **below** the grid minimum — not above it.
- Test responsive container queries at the exact `minmax` minimum width.

## Verification

- `npm run build` passes
- At 460px+ grid columns, the full `http://localhost:PORT` URL is visible
- Below 450px (if manually forced), it gracefully falls back to `:PORT`
