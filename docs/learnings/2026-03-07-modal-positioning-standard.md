# Standardize popup/modal positioning

## Summary
Unified all three full-screen modals (TemplatePicker, CommandPalette, ImagePreviewModal) to a consistent positioning standard: top-aligned at 15vh, 448px max-width, 32px header height.

## Symptoms
Each modal had different positioning:
- **TemplatePicker**: vertically centered, fixed width (480/400px depending on step), 12px vertical header padding
- **CommandPalette**: `paddingTop: 80` (fixed pixels), fixed width 520px, 12px vertical header padding
- **ImagePreviewModal**: vertically centered, `maxWidth: "80vw"`, no fixed header height

This created visual inconsistency when switching between modals.

## Root cause
Modals were built independently at different times without a shared positioning convention.

## Fix
Applied a uniform standard across all three modals:

| Property | Before (varied) | After (standard) |
|----------|-----------------|-------------------|
| Vertical align | `center` or `paddingTop: 80` | `flex-start` + `paddingTop: "15vh"` |
| Width | Fixed px (400-520) or `80vw` | `maxWidth: 448, width: "100%"` |
| Header height | Implicit (padding-based) | Explicit `height: 32` with `padding: "0 16px"` |

Key detail: ImagePreviewModal kept `maxHeight: "80vh"` for image scroll constraint, and the header got `flexShrink: 0` to prevent compression.

## Prevention
- When creating new modals, follow this standard: `items-start` + `pt-[15vh]`, `max-w-md` (448px), `h-8` header.
- Reference any existing modal as a template.

## Verification
- `npm run build` passes
- Visual: open each modal and confirm top-aligned at ~15vh, 448px max width, 32px header
