# Per-CLI Settings & YOLO Mode

**Date:** 2026-03-07

## Summary

Added per-CLI font size settings and a Claude-specific YOLO mode (`--dangerously-skip-permissions`) to the settings dropdown. Key design decisions around per-terminal state tracking vs global store state.

## Features Implemented

1. **Per-CLI font size selector** — collapsible sections in settings dropdown for Claude, Codex, Gemini with +/- stepper (range 10-24)
2. **Collapsible Theme section** — moved to bottom of dropdown, collapsed by default
3. **Claude YOLO mode** — toggle that passes `--dangerously-skip-permissions` flag at spawn time
4. **YOLO badge** — shown in terminal header, Add Pane dropdown, and Assign Agents picker

## Key Design Decision: Per-Terminal vs Global State for YOLO Badge

### Problem

The YOLO badge on terminal headers needs to reflect whether **that specific terminal** was launched with the flag — not just whether the global toggle is currently on. If user enables YOLO, spawns a Claude terminal, then disables YOLO, that terminal should still show the badge (it *was* launched with the flag).

### Initial (Wrong) Approach

Read `claudeYolo` from the global Zustand store in `TerminalHeader`. This meant:
- All Claude terminals showed/hid the badge simultaneously when the toggle changed
- No way to distinguish terminals launched with vs without YOLO

### Correct Approach

Capture the YOLO state **once at terminal mount time** using a lazy `useState` initializer in `TerminalPane`:

```tsx
const [launchedWithYolo] = useState(() =>
  terminalType === "claude" && useAppStore.getState().claudeYolo
);
```

This freezes the value to whatever the setting was when the pane was created. The value is passed as an `isYolo` prop to `TerminalHeader`, which no longer reads the store directly for this.

## Architecture: Extra Args Flow

The `--dangerously-skip-permissions` flag flows through two spawn paths:

1. **Normal spawn**: `usePty` → `getTerminalConfig(type, resumeId, extraArgs)` → appended to `args` array
2. **Pooled spawn**: `usePty` → `getPooledInitCommand(type, cwd, resumeId, extraArgs)` → appended to `exec` command string

Both `getTerminalConfig` and `getPooledInitCommand` gained an optional `extraArgs?: string[]` parameter. The flag is placed **before** resume args so both features compose cleanly.

## Prevention

- **Per-terminal flags must be captured at mount time** — never read global store state reactively for "was this terminal launched with X?" questions. Use `useState(() => store.getState().x)` pattern.
- **Native `<select>` elements can't render badges** — for the Assign Agents picker, append text to the option label (`"Claude (YOLO)"`) and show a separate badge element next to the `<select>`.

## Verification

- `npx tsc --noEmit` — clean
- Toggle YOLO on, open Claude pane → badge visible in header
- Toggle YOLO off → existing Claude pane keeps badge, new panes don't get it
- Font size changes apply live to running terminals via reactive `useEffect`
