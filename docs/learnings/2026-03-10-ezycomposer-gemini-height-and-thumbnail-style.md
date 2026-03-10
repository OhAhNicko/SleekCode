# EzyComposer: Gemini height tuning & thumbnail style unification

**Date:** 2026-03-10

## Summary

Three small but precise EzyComposer refinements:
1. Reduced Gemini composer card height by raising the bottom border 5px total (bottom padding reduced from symmetric to `-5`).
2. Changed EzyComposer image thumbnails from a bottom label bar style to match the TabBar's top-left number badge style (8x8px badge, font 6).
3. Added a trailing space when sending text from EzyComposer to Gemini's TUI, as a workaround for Gemini sometimes not fully ingesting the last character before Enter arrives.

## Key details

### Gemini card height
- The Gemini card padding was originally symmetric: `Math.round((cellHeight * 0.4 + 6) / 2)` on both top and bottom.
- User requested raising the bottom border by 3px, then 2px more — total 5px reduction on bottom padding only.
- Final: `Math.round((cellHeight * 0.4 + 6) / 2) - 5` for bottom padding.
- **Gotcha**: Card sizing is extremely sensitive — `cardTop` and padding are coupled. Changing only bottom padding raises the bottom border without shifting content position.

### Thumbnail style
- Old EzyComposer style: 28x28px, full-width bottom bar with label text (`rgba(0,0,0,0.6)` background, font 7px).
- New style (matching TabBar): 26x26px, 8x8px number badge in top-left corner with `terminalCursor` background, white bold text, font 6px.
- The TabBar uses `var(--ezy-accent)` for badge background and 12x12px badge at font 8 — EzyComposer uses a smaller variant (8x8, font 6) since the thumbnails sit inside the compact composer row.

### Gemini trailing space
- Gemini's TUI editor sometimes doesn't fully ingest the last character when text and Enter are sent in rapid succession (even with the 80ms delay).
- Fix: append a single trailing space to the text payload for Gemini only (`terminalType === "gemini" ? " " : ""`).
- This only affects the single-line non-bracketed-paste path. Multi-line (bracketed paste) is unchanged.

## Prevention
- When tuning card dimensions, always change ONE side's padding at a time — don't adjust `cardTop` simultaneously unless intentionally shifting the whole card.
- When unifying visual styles across components, check the exact pixel sizes — a badge that looks right at 26x26 in the TabBar may need to be proportionally smaller in the composer context.

## Verification
- `npx tsc --noEmit` — passes clean
- `npx vite build` — passes clean
- Visual check: Gemini composer card is more compact, thumbnails show number badge in top-left corner
