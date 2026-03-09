# React Icons Migration & Arrow Ligatures in EzyComposer

**Date:** 2026-03-09

## Summary

Replaced 142 hand-drawn inline SVG icons across 7 components with `react-icons` library equivalents, and added `->` / `<-` arrow ligature rendering in the EzyComposer prompt composer. This improves visual consistency, maintainability, and gives the app a more polished look.

## Two Major Changes

### 1. Arrow Ligatures in EzyComposer

**Goal:** When the user types `->` or `<-` in the EzyComposer textarea, visually render them as arrow icons (like WezTerm font ligatures).

**Approach:** Leveraged the existing transparent-textarea + overlay architecture used for slash command coloring and console tag rendering.

**Key challenge — Width alignment:** The textarea still contains `->` (2 characters), but the arrow icon is a single element. If the overlay renders a 1-character-wide arrow, the cursor position drifts out of alignment with the overlay text.

**Solution:** Render the arrow icon followed by an **invisible filler character** (`<span style={{ color: "transparent" }}>-</span>`). This maintains the 2-character width: arrow icon (1ch) + invisible char (1ch) = 2ch, matching the textarea's `->` exactly. Letter-spacing is inherited naturally.

**Implementation details:**
- `renderWithArrows(text)` — module-level function that splits on `/<-|->/ ` regex, returns React nodes with arrow icons + filler
- `hasArrows` computed flag triggers the overlay when no other overlay (slash commands, console tags) is active
- All three overlay paths (console tag, slash command, arrow-only) call `renderWithArrows()` so arrows work in combination with other features
- Arrow icons: `HiMiniArrowLongRight` / `HiMiniArrowLongLeft` from `react-icons/hi2`, scale 1.5, top -1px
- Submitted text is unmodified — `->` is sent as-is to the CLI

**What we tried and tuned:**
- Unicode `→` (U+2192) — worked but looked too thick at larger sizes
- Unicode `⟶` (U+27F6 long arrow) — thinner but still not ideal
- `FaArrowRightLong` from fa6 — good but user preferred `HiMiniArrowLongRight`
- `fontWeight: 300` on arrow — no effect because Hack font only has one weight (faux-light doesn't work on monospace)
- Scale went through 1.0 → 1.35 → 1.5 (final)
- Top offset: -2px → -1px (final)

**Terminal side was skipped:** xterm.js renders character-by-character in canvas/WebGL, so font ligatures don't work natively. Would require `@xterm/addon-ligatures` + a ligature-capable font (not Hack), or a custom decoration addon. Deferred for future.

### 2. React Icons Migration

**Goal:** Replace hand-drawn inline SVGs with `react-icons` library for consistency and maintainability.

**Strategy:**
1. First pass: agents replaced SVGs with best-fit icons from any react-icons set
2. Consolidation pass: standardized to a small set of icon families the user approved
3. Fine-tuning pass: user swapped specific icons to preferred alternatives

**Established icon sets (user-approved):**
- `fa` (Font Awesome 4) — chevrons, checks, folders, locks, play/stop, terminal, desktop, globe, trash, expand
- `fa6` (Font Awesome 6) — xmark, plus, bolt, gear, server, pencil, code-pull-request, arrows-rotate, wand-magic-sparkles
- `bi` (BoxIcons) — refresh, timer, sidebar, expand-vertical, solid-send, screenshot
- `ai` (Ant Design Icons) — pushpin outline/filled, fill-code
- `hi2` (Heroicons 2) — mini-arrow-long-right/left
- `pi` (Phosphor Icons) — kanban-duotone
- `tb` (Tabler Icons) — browser-plus, browser-minus

**What was NOT replaced (intentionally preserved as custom SVGs):**
- CLI brand icons (Claude diamond, Codex square, Gemini circle) — brand-specific colors/shapes
- Window title bar controls (minimize, maximize/restore, close) — pixel-perfect for Tauri chrome
- Server/monitor composite icons — multi-element layout representations
- Terminal prompt icon (>_) — specific to terminal aesthetic
- Promptifier spinner — animated SVG, no react-icons equivalent
- Empty state illustrations — large decorative SVGs

**Components modified and icon counts:**
| Component | Icons Replaced |
|---|---|
| PromptComposer | 5 (prompt chevron, wand, send, console, arrows) |
| TabBar | ~21 (close, plus, pin, folder, bolt, gear, server, chevrons, checks, sidebar, kanban, code review, browser toggle) |
| TerminalHeader | 4 (drag handle, chevron, check, close) |
| BrowserPreview | 17 (navigation, refresh×2 distinct, globe, external link, inspect, terminal, desktop, timer, close, trash, lock/unlock, check) |
| DevServerTab | 11 (refresh, pencil, stop, play, expand, close, folder, chevrons, plus) |
| ServersPanel | 3 (plus, pencil, trash) |
| ClipboardImageStrip | 2 (screenshot, expand) |

**Browser Preview refresh differentiation:**
- Normal refresh: `BiRefresh` (single circular arrow)
- Hard reload (clear storage): `FaArrowsRotate` (two arrows rotating) — visually distinct

**Browser Preview toggle icon:**
- `TbBrowserPlus` when no browser pane exists
- `TbBrowserMinus` when browser pane is open
- Uses `findAllBrowserPanes()` to check current state

## Key Gotchas & Lessons

1. **Arrow ligature width alignment is critical** — replacing 2 chars with 1 icon misaligns cursor. Always add an invisible filler character to preserve the original character count width.

2. **`fontWeight` has no effect on Hack** — it's a single-weight monospace font. Faux-light/bold rendering from the browser doesn't work. Use different icon/character or `transform: scale()` instead.

3. **`transform: scale()` on icons doesn't affect layout** — it's purely visual, so it's the safest way to resize icons without breaking alignment or surrounding element spacing.

4. **Icon set consistency matters** — mixing too many icon families creates visual inconsistency (different stroke widths, fill styles). Consolidating to a curated set early prevents rework.

5. **Brand/custom icons should stay as SVGs** — CLI icons (Claude, Codex, Gemini) have specific brand colors and shapes that no icon library matches. Same for window chrome controls.

6. **react-icons `color` prop vs SVG `stroke`/`fill`** — when replacing SVGs that used `stroke={color}`, pass `color={color}` to the react-icon component. React-icons uses `currentColor` internally and the `color` prop sets it.

## Verification

1. `npx tsc --noEmit` — passes clean
2. Visual check: all icons render correctly in TabBar, TerminalHeader, BrowserPreview, DevServerTab, ServersPanel, PromptComposer, ClipboardImageStrip
3. Arrow ligatures: type `->` and `<-` in EzyComposer to verify visual rendering
4. Browser toggle: open/close browser pane to verify icon switches between plus/minus
5. No icon set imports from `io5`, `md`, `fi` remain (consolidated away)
