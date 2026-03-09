# Browser Preview UX Improvements

## Summary

Added three quality-of-life features to `BrowserPreview.tsx`:
1. **Viewport bar toggle** — hidden by default, toggled via a monitor icon in the URL bar
2. **Open in default browser** — external-link button in the URL bar sends the current URL to the OS default browser
3. **Pin DevTools** — a lock-icon button in the DevTools header that persists DevTools open-state to `localStorage` so the panel auto-opens every time a browser preview is opened

A secondary thread involved iteratively refining the pin button's icon states across several rounds of feedback.

---

## Pin button icon iteration — what failed and why

### Attempt 1: `active` prop (background color highlight)
Used `active={devtoolsPinned}` on the `NavButton`. This applies `--ezy-accent-dim` background + `--ezy-accent` text color.

**Why it failed:** User found the colored background too distracting for a low-priority "persistent state" indicator. Background color draws too much attention in a dense toolbar.

**Lesson:** `active` prop is appropriate for mode toggles the user consciously interacts with (inspect mode, auto-reload). For "set and forget" persistence flags, a subtle icon change is less disruptive.

### Attempt 2: Filled pin vs outline pin
Same SVG path for both states — `fill="currentColor"` for pinned, `fill="none"` stroke-only for unpinned. Used `--ezy-surface` color to "cut out" the internal cross-line and circle.

**Why it failed:** The difference between a filled and an outline version of the same small (12px) icon is hard to notice at a glance. The visual delta was too subtle.

**Lesson:** For binary icon states at small sizes, the two icons should have meaningfully different **shapes**, not just fill vs stroke.

### Attempt 3: Filled pin vs outline pin (different closed-polygon path)
Tried `M9.5 1.5 L14.5 6.5 L10 11 L5 10 Z` as a closed filled polygon. Cross-line drawn in `--ezy-surface` to simulate a "cut through" on the filled body.

**Why it failed:** User said "change the icon more" — the shape was recognizably the same pin, just solid. Shape similarity at this scale made the two states feel the same.

### Attempt 4: Pin (unpinned) → Closed padlock (pinned) ✓
Replaced the pinned icon entirely with a closed padlock: `<rect>` body + shackle `<path>` that loops closed.

**Why it worked:** Lock and pin are semantically related but visually distinct shapes. At 12px the padlock rectangle is immediately recognizable vs the diagonal pin line. User confirmed "I like it!"

### Attempt 5: Open lock (unpinned) → Closed lock (pinned)
User asked to make the unpinned state also a lock (open version). Initial path: `M5.5 7.5V5.5a2.5 2.5 0 0 1 5 0V3` — shackle with right arm going straight up to y=3.

**Issue:** Not visually prominent enough — the straight-up right arm looked nearly identical to the closed lock at small sizes because the gap between arm-end (y=3) and lock body (y=7.5) wasn't dramatic enough.

### Attempt 6: Angled open arm
Changed to `M5.5 7.5V5.5a2.5 2.5 0 0 1 5 0L13 1.5` — right arm angled outward to upper-right corner.

**Why it failed:** User asked to "make the lock handle more open" — the angled arm looked odd, like the lock was broken rather than open.

**Lesson:** Angling the shackle arm away from center reads as "damaged" not "open". The conventional open-lock icon uses the same symmetric U shape but with the right arm lifted high and clearly not inserted.

### Attempt 7: Raised symmetric shackle ✓
`M5.5 7.5V4a2.5 2.5 0 0 1 5 0` — left arm goes to y=4 (instead of y=5.5), arc to right side at y=4. Right arm NOT inserted into body, ends at y=4 with a 3.5px gap above the lock body top (y=7.5).

**Why it worked:** Same recognizable U-shape as the closed lock, but clearly unlatched. Large gap between shackle end and lock body is the standard open-lock convention and reads correctly.

---

## Implementation notes

### `openUrl` from `@tauri-apps/plugin-opener`
Already used in `DevServerTab.tsx` — just add the import. No new permissions needed.

### `devtoolsPinned` lazy init pattern
Both `devtoolsPinned` and `devtoolsTab` use lazy initializer functions (`useState(() => ...)`) to read `localStorage` synchronously on mount — avoids a flash where DevTools appears closed then snaps open.

```ts
const [devtoolsPinned, setDevtoolsPinned] = useState(
  () => localStorage.getItem("ezydev-devtools-pinned") === "true"
);
const [devtoolsTab, setDevtoolsTab] = useState<DevtoolsTab | null>(
  () => localStorage.getItem("ezydev-devtools-pinned") === "true" ? "console" : null
);
```

### Viewport mode persists when bar is hidden
`showViewportBar` only controls visibility of the toolbar row. The `viewportMode` state is independent — hiding the bar does not reset the selected viewport.

---

## Prevention

- **Don't use `active` prop for "set and forget" persistence indicators** — use icon shape changes instead.
- **Icon state changes at 12px need meaningfully different shapes** — filled vs outline of the same path is not enough.
- **Open lock = raised symmetric U** — not angled, not tilted. The conventional open padlock is the same shape as closed but with the right shackle arm clearly not inserted into the body.

---

## Verification

```bash
npm run typecheck   # passed
npm run build       # passed (rollup native module issue — fixed by re-running npm install)
```
