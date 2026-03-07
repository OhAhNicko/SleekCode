# EzyComposer Image Autocomplete + Pane-Specific Image Attachment

**Date:** 2026-03-07

## Summary

Implemented `im`/`img` + Tab autocomplete for clipboard images in the EzyComposer (prompt composer overlay), including ghost text hints, Tab cycling through images, and pane-specific image attachment. The feature required matching the existing terminal-side implementation while adapting it to React's controlled-input model, and isolating attached images per-pane instead of sharing them globally.

## Key Features Built

1. **Ghost text overlay** — faded hint text positioned over the textarea showing what Tab will insert
2. **Tab autocomplete** — `im`/`img` + Tab replaces trigger with `[Img 1]` and attaches thumbnail
3. **Tab cycling** — subsequent Tabs replace `[Img 1]` with `[Img 2]`, `[Img 3]` (wrapping), matching the terminal implementation
4. **Submit dedup** — `[Img N]` labels already in text aren't double-appended on submit
5. **Per-pane image isolation** — each EzyComposer instance tracks its own attached images via local state
6. **Auto-paste integration** — "Auto paste screenshots" toggle routes to the active composer when enabled

## Failed Attempts and Why They Failed

### Attempt 1: Tab handler gated on `ghostText` state

```typescript
if (e.key === "Tab" && ... && ghostText) {
```

**Why it failed:** The Tab handler depended on React state `ghostText` being truthy. `ghostText` is set via `setGhostText()` inside `updateGhost()` which runs in `onChange`. Due to React's batching, the state might not have been committed by the time the next `keydown` event fires. More importantly, `onChange` fires on character input — by the time the user presses Tab (a separate keystroke), the state should be set, but this coupling was fragile and unnecessary.

**Fix:** Made the Tab handler self-contained — it reads `ta.value` directly from the DOM and computes trigger/availability inline, with no dependency on `ghostText` state.

### Attempt 2: Tab cycling by appending (not replacing)

Initial cycling implementation appended `[Img 2]` after `[Img 1]` on subsequent Tab presses:

```typescript
newText = text + ` [Img ${num}]`;
```

**Why it failed:** The existing terminal implementation (TerminalPane lines 462-477) REPLACES the current label — it erases `[Img 1]` with backspaces and writes `[Img 2]`. The user expects to select ONE image at a time with Tab cycling, not accumulate all images. Screenshot confirmed: `> [Img 1] [Img 2] [Img 3]` all appeared at once.

**Fix:** Matched the terminal implementation exactly — `imgCycleRef` tracks the current number, Tab replaces the label in-place using `text.slice(0, -prevLabel.length) + nextLabel`, and swaps the single thumbnail in local state.

### Attempt 3: `nextAvailableImageNum()` for cycling instead of modular arithmetic

Early ghost text logic used `nextAvailableImageNum()` which skips already-referenced images. This was designed for "type `im` multiple times to reference different images" but was incorrectly applied to Tab cycling.

**Why it failed:** Tab cycling should wrap (1 -> 2 -> 3 -> 1), not skip. The terminal implementation uses simple modular arithmetic: `(current % imageCount) + 1`. The "skip already referenced" logic is for the ghost text hint when composing new `im` triggers, not for cycling.

**Fix:** Tab cycling uses `(imgCycleRef.current.num % imageCount) + 1`. Ghost text still uses `nextAvailableImageNum` for suggesting what the next `im` + Tab will insert.

### Attempt 4: Global `composerImages` store shared across panes

Initially, attached images were stored in `useClipboardImageStore.composerImages` — a single global array.

**Why it failed:** Every PromptComposer instance subscribed to the same array. Adding an image in pane 1 showed the thumbnail in pane 2 as well.

**Fix:** Converted to local `useState<ClipboardImage[]>` in each PromptComposer. External sources (TabBar clicks, auto-paste) communicate via a `pendingComposerImage` slot in the global store, which includes a `terminalId` so only the targeted composer picks it up.

### Attempt 5: Using `terminals.isActive` to route images to the active pane

When TabBar clicks needed to target a specific pane, the first approach used `Object.values(terminals).find(t => t.isActive)` from the app store.

**Why it failed:** `isActive` is set by `onFocus` on the TerminalPane div (`onClick={onFocus}`). When the user clicks a TabBar thumbnail, they're clicking the TabBar — NOT a pane. So `isActive` might point to a stale pane or none at all.

**Fix:** Added `activeComposerTerminalId` to the clipboard store. Each PromptComposer registers its `terminalId` on mount and on textarea focus. TabBar and auto-paste read `activeComposerTerminalId` instead of the unreliable `isActive` flag.

## Architecture Decisions

- **Local state for per-instance data, global store for cross-component messaging** — `localImages` is `useState` because it's per-composer. `pendingComposerImage` is global because TabBar needs to send images to a specific composer without a direct reference.
- **`activeComposerTerminalId` as source of truth** — more reliable than `isActive` terminal flag because it's set by the actual textarea focus event, not by pane click.
- **Matching terminal implementation pattern** — the EzyComposer Tab cycling mirrors TerminalPane's `imgCycle`/`imgRecentChars` pattern (modular cycling, trigger detection, ghost text) but adapted for React controlled inputs.

## Prevention

- **When building React equivalents of imperative terminal features:** Don't gate React event handlers on state from a different event cycle. Use DOM values (`ta.value`) directly in key handlers instead of relying on state set by `onChange`.
- **Tab cycling = replace, not append:** Any "cycle through options" UI should replace the current selection, not accumulate. Check existing implementations before building new ones.
- **Per-instance UI state goes in local `useState`, not global stores:** Global Zustand stores are shared across all component instances. Use local state + a "pending" message pattern for cross-component communication when instances need isolation.
- **`isActive` terminal flag is only updated on pane click:** Don't use it for routing from non-pane UI elements (TabBar, menus). Use a dedicated tracking field that's updated on the actual focus event of the target component.

## Verification

- `npx tsc --noEmit` — clean (0 errors)
- `npm run build` — passes
- Tab autocomplete: type `im` + Tab inserts `[Img 1]`, Tab again replaces with `[Img 2]`
- Per-pane: image added to pane 1's composer doesn't appear in pane 2's composer
- Submit dedup: images added via Tab autocomplete (`[Img 1]` in text) aren't duplicated on send
- Auto-paste: new clipboard images route to the last focused composer pane
