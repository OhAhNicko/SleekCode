# Copy-on-Select Terminal Feature

## Summary

Added an opt-in "Copy on select" toggle to EzyDev terminals. When enabled, any completed text selection in an xterm.js pane is automatically written to the system clipboard — matching the behaviour of Warp, WezTerm, and iTerm2. The toggle is surfaced in the Settings dropdown → Behavior section and persists across sessions via localStorage.

## Implementation

### Pattern used: stable ref for event handlers registered at terminal init

xterm.js terminal setup runs once inside a `useEffect` with a ref-guarded init block. Event handlers registered there (via `term.onSelectionChange`) capture the closure at registration time. If we read `copyOnSelect` from the store directly inside that closure, it would always see the value at mount time and never update.

**Solution**: read the store value into a `useRef`, and keep the ref in sync with a small `useEffect`:

```ts
const copyOnSelect = useAppStore((s) => s.copyOnSelect);
const copyOnSelectRef = useRef(copyOnSelect);
useEffect(() => { copyOnSelectRef.current = copyOnSelect; }, [copyOnSelect]);
```

Inside the terminal setup effect, the handler reads `copyOnSelectRef.current` — always the latest value without re-registering the listener:

```ts
term.onSelectionChange(() => {
  if (!copyOnSelectRef.current) return;
  const sel = term.getSelection();
  if (sel) navigator.clipboard.writeText(sel).catch(() => {});
});
```

This is the same pattern already used in `usePty` and other xterm hooks in this codebase.

### Why not re-register on toggle change?

`onSelectionChange` would need to be disposed and re-added whenever `copyOnSelect` changes. The disposable approach is messier and risks double-registration on fast toggles. The ref approach is simpler, cheaper, and idiomatic.

### Why `catch(() => {})` on `writeText`?

`navigator.clipboard.writeText` is async and can throw in contexts where clipboard access is denied (e.g., document not focused, permissions). The error is benign — the user just doesn't get the copy. Silencing it avoids unhandled promise rejections in the console.

## Files changed

| File | Change |
|------|--------|
| `src/store/recentProjectsSlice.ts` | `copyOnSelect: boolean` field + `setCopyOnSelect` setter, default `false` |
| `src/store/index.ts` | `copyOnSelect` added to `partialize` for persistence |
| `src/components/TerminalPane.tsx` | Store read → stable ref → `onSelectionChange` handler |
| `src/components/TabBar.tsx` | Store bindings + toggle row in Behavior section (after "Auto-paste screenshots") |

## Prevention

- Any future xterm event handler that reads reactive state should use the **stable ref pattern** (`useRef` + `useEffect` sync), not read store state directly in a closure registered at mount.
- All new global settings must be: (1) added to `RecentProjectsSlice` interface + initial state + setter, (2) added to `partialize` in `index.ts`, (3) exposed via a toggle in TabBar Behavior section.

## Verification

```bash
npm run typecheck   # passed, no new errors
npm run build       # passed, 44s build
```

Manual: toggle ON → select terminal text → paste confirms clipboard updated. Toggle OFF → selection no longer copies. Reload → state persists.
