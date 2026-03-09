# Tab Drag-to-Reorder (Warp-style)

## Summary

Implemented pointer-based drag-to-reorder for the TabBar. Tabs leave their slot when dragged (other tabs shift in), a blank placeholder slot travels to the target position, and a pixel-perfect ghost clone of the tab floats under the cursor locked to the tabbar row. On pointer up, `reorderTabs` commits the new order.

---

## Implementation story

### Attempt 1 — 2px drop-indicator approach

**Plan:** Keep the dragged tab visible (dimmed at 30% opacity) in its original slot. Show a 2px accent-colored vertical bar to indicate where it will land. On release, commit.

**Result:** Built and shipped. User confirmed it worked, but the UX felt wrong — the tab didn't "leave" its position, it just dimmed in place. Users expect the tab to vacate its spot and for surrounding tabs to shift, like Chrome's tab drag behavior.

**Why it felt wrong:** The 2px line gives no spatial feedback about where the tab will *end up*. You're looking at a tiny sliver, not a tab-shaped slot. The user's mental model is "the tab is lifted and moved", not "a cursor is pointing at a gap".

### Attempt 2 — Slot-based approach (correct model, wrong ghost)

**Plan:**
- Render the dragged tab as `null` in the list → its slot disappears → other tabs shift left
- Insert a blank placeholder `<div>` of exactly `tabWidth` at the `insertBeforeId` position
- Float a ghost label div under the cursor

**Result:** The slot behavior was correct. However the ghost looked like a placeholder badge with just the tab name — not like the real tab. The user described it as "some sort of placeholder" not the actual tab.

**Root cause:** The ghost was a minimal `<div>` with just `{ghostTab.name}` text. It had rounded corners, a shadow, and constrained width — it looked like a tooltip or chip, not a tab.

### Attempt 3 — Full ghost clone (final)

**Fix:** Replace the ghost with a full tab clone:
- **Width:** `dragState.tabWidth` (exact same width as the real tab, captured at `pointerdown`)
- **Height:** `38px` (the tabbar height), not 32px (which was wrong)
- **Y position:** `rect.top` captured from the tab's bounding rect at drag start — locked to the tabbar row, not following cursor Y
- **X position:** `e.clientX - ds.offsetX` — follows cursor horizontally, offset so the grab point stays under the finger
- **Contents:** identical icon (`renderTabIcon`), label span, and close/pin button DOM (buttons are invisible via `opacity: 0` since ghost is non-interactive)
- **Background:** matches the real tab (`var(--ezy-surface)` if active, `var(--ezy-bg)` otherwise), including pinned diagonal stripe pattern
- **Shadow + border:** `boxShadow: "0 8px 24px rgba(0,0,0,0.5)"` + `border: "1px solid var(--ezy-border)"` gives the "lifted" feel

---

## Key architectural decisions

### `tabWidth` captured at `onPointerDown`
Not computed during render or from state — captured from `e.currentTarget.getBoundingClientRect().width` the moment the user clicks. This ensures the ghost is exactly the same width as the tab that was grabbed, even if tabs have variable widths.

### `tabTop` captured at `onPointerDown`
Ghost Y is locked to `rect.top` of the grabbed tab, not the pointer's Y. This means the ghost stays in the tabbar row at all times, which matches the "dragging an actual tab" mental model. If you drag the ghost far below the tabbar, it doesn't follow — it stays in position horizontally only.

### `display: contents` wrapper for placeholder + button
Each tab is wrapped in `<div style={{ display: "contents" }}>` so that the placeholder slot and the button are both direct flex children of the container. The wrapper itself has zero layout impact. This lets us conditionally render the placeholder before the button without changing the flex structure.

### `data-tab-id` on each `<button>`
`getInsertBeforeId()` queries `[data-tab-id]` elements to find midpoints. This must only be on **non-dragged** tabs (which are skipped via `null` return), so the position calculation ignores the dragged tab's original DOM position.

### `setDragState` in the `pointerup` handler uses functional update
```ts
setDragState((prev) => {
  if (prev) reorderTabs(prev.tabId, prev.insertBeforeId);
  return null;
});
```
This reads the latest `dragState` without needing it in the effect dependency array, avoiding stale closure issues.

### System tabs are not draggable
`if (e.button !== 0 || isSystemTab) return;` in `onPointerDown` — Kanban, DevServer, Servers tabs have no `data-tab-id` attribute and do not start drags.

---

## Prevention / Design Rules

- **Ghost must be a full clone, not a summary** — any drag-ghost that shows less information than the real element feels like a placeholder tooltip. Clone the full DOM structure.
- **Lock ghost Y to the element's row** — capture `rect.top` at drag start and pin the ghost there. Following cursor Y makes the ghost float away from the row and breaks the spatial illusion.
- **Capture width/top at pointerdown, not during render** — these values need to be stable for the full drag lifetime. Capturing at init time is the right pattern.
- **Skip the dragged item in the list, insert placeholder** — dimming the item in place is the wrong UX for reorder. The slot must actually disappear.

---

## Verification

1. `npm run typecheck` → 0 errors
2. `npm run build` → passes (pre-existing chunk size warning unrelated)
3. Manual: drag tab left/right → ghost looks identical to the real tab, locked to tabbar row
4. Manual: clicking without dragging still activates the tab
5. Manual: system tabs (Dev Servers, Servers icon) are not draggable
