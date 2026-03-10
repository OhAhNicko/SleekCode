# EzyComposer Cursor-Ghost Text Overlap Fix

**Date:** 2026-03-09

## Summary

The blinking textarea cursor in EzyComposer overlapped with the first character of ghost text (CLI suggestions) and placeholder text, making it hard to read. Fixed by replacing the native `placeholder` attribute with a custom overlay and offsetting both ghost and placeholder overlays 10px from the cursor when the textarea is empty.

## Symptoms

- The blinking cursor visually cut through the first letter of ghost/placeholder text ("W" in "Write tests...", "I" in "Implement...")
- Appeared on all CLI types (Claude, Codex, Gemini, shell, devserver)

## Root Cause

The textarea cursor renders at position 0 (the start of the text content area). The ghost text overlay and native placeholder also start at position 0. Since a textarea cursor is a thin vertical line drawn at the exact position of the first character, they overlap visually.

## Debugging Story — Multiple Failed Attempts

### Attempt 1: `marginLeft` on the ghost text `<span>`
Added `marginLeft: 6` to the `effectiveGhost` span inside the ghost overlay. **Had zero visible effect.** The reason: the text the user was seeing was NOT the ghost overlay — it was the **native textarea `placeholder` attribute** rendering "Write tests for the recent changes" (from `PLACEHOLDER_SUGGESTIONS`). The ghost overlay (`effectiveGhost`) only shows CLI suggestions, and the native placeholder is a completely separate rendering path controlled by the browser. Editing the overlay span had no impact on the native placeholder.

### Attempt 2: `paddingLeft` on the container div
Added `paddingLeft: 3` to the parent `<div>` wrapping the textarea and overlays. **No effect on the overlap** because `paddingLeft` shifts both the textarea cursor AND the absolutely-positioned overlays (whose `left: 0` refers to the padding edge of the containing block). Both elements moved right equally, maintaining the same relative overlap.

### Attempt 3: `paddingLeft` on textarea + all overlays
Added `padding: "0 0 0 6px"` to the textarea AND all 5 overlays. **No visible change** because both cursor and overlay text shifted by exactly 6px. The gap between cursor and first character remained identical — just shifted 6px to the right.

### Why these failed — the core insight
The cursor and the first character in a textarea are **always at the same position** (the content area start). Any padding/margin applied to BOTH the textarea and overlay shifts them equally — no gap is created. The only way to create a gap is to offset the overlay WITHOUT offsetting the textarea, which means the text positions will differ (causing a jump on tab-accept).

## Fix

1. **Removed the native `placeholder` attribute** from the textarea entirely
2. **Added a custom placeholder overlay** (`position: absolute`) that renders `PLACEHOLDER_SUGGESTIONS` text when the textarea is empty and no ghost text is active
3. **Set `left: 10` on the placeholder overlay** so it starts 10px after the cursor
4. **Set `left: value ? 0 : 10` on the ghost text overlay** — 10px offset when empty (gap from cursor), 0px when typing (aligns with typed text for slash command coloring etc.)
5. Accepted the trade-off: tab-completing ghost text causes a 10px leftward jump (text snaps from ghost position to cursor position)

## Prevention

- **Native textarea `placeholder` cannot be independently positioned** from the cursor — if you need a gap between cursor and placeholder text, you must use a custom overlay instead of the `placeholder` attribute
- **`paddingLeft` on textarea shifts cursor AND text equally** — it cannot create a gap between cursor and text content. It only shifts everything relative to the container.
- **Always identify WHICH element renders the visible text** before attempting CSS fixes — the ghost overlay and native placeholder are completely separate rendering paths
- **Gap vs no-jump is a fundamental trade-off** for textarea ghost text — you cannot have both without animating or using a custom caret

## Verification

1. `npm run build` — passes
2. Visual: open any terminal pane, focus the EzyComposer textarea — the placeholder/ghost text should have a visible ~10px gap from the blinking cursor
3. Tab-accept a ghost suggestion — text appears at cursor position (10px jump left, expected)
4. Type text with slash commands — colored overlay aligns perfectly with typed text (no offset when `value` is non-empty)
