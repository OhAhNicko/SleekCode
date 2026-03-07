# Session Restore: Terminal Types Not Persisted in Layout Tree

**Date:** 2026-03-06

## Summary

Implemented a "Restore last session" setting that preserves all tabs across app restarts. The initial implementation appeared to work (tabs were restored) but terminals always spawned as `"shell"` (PowerShell) instead of their original types (Claude, Gemini, etc.). The root cause was that `terminalType` was never written into the persisted layout tree during tab creation.

## Symptoms

- Toggle ON, open tabs with different terminal types (Claude Code, Gemini CLI, etc.), close app, reopen
- All tabs restore but every terminal shows "PowerShell" header and spawns a plain shell
- The pane layout structure (splits, sizes) restores correctly — only the terminal types are wrong

## Root Cause

Terminal types lived in two separate places:

1. **Runtime `terminals` store** (`Record<string, TerminalInstance>`) — has the `type` field, but is NOT persisted (cleared on restart)
2. **Layout tree** (`PaneLeaf` in `Tab.layout`) — IS persisted, but had no `terminalType` field

When `buildLayoutFromTemplate()` creates leaves, it only sets `{ type: "terminal", id, terminalId }`. The actual terminal type (claude, shell, etc.) was passed separately to `addTerminals()` which writes to the runtime store only. On restore, the auto-spawn effect found leaves without `terminalType` and fell back to `"shell"`.

### Why the first implementation missed this

The plan correctly identified that `terminalType` needed to be added to `PaneLeaf` and that `handleSpawnTerminal`/`handleInitialSpawn`/`handleTerminalSplit` in Workspace.tsx needed to persist it. However, these handlers only fire **after** a terminal is interacted with (split, type change, etc.). The **primary creation path** — `handleTemplateSelected` in TabBar.tsx — calls `buildLayoutFromTemplate()` + `addTerminals()` directly and never touches the Workspace handlers. So types were only stamped when users manually changed types or split panes, not during initial tab creation.

A second creation path in TabBar.tsx (recent project reopen with saved template) had the same gap.

### Three categories of leaf creation paths

1. **TabBar template creation** (`handleTemplateSelected`, recent project reopen) — creates all leaves at once via `buildLayoutFromTemplate()`. **Was missing type stamps.**
2. **Workspace runtime splits** (`handleTerminalSplit`, split-terminal event, explain-error) — creates individual leaves. Some were fixed in the initial implementation, others were missed.
3. **Workspace initial spawn** (`handleInitialSpawn`) — single-leaf tabs. Was correctly handled.

## Fix

1. Added `stampTerminalTypes(layout, terminalIds, types)` helper in `layout-utils.ts` that walks a layout tree and sets `terminalType` on each matching leaf
2. Both TabBar creation paths now call `stampTerminalTypes()` before passing the layout to `addTabWithLayout()`
3. All Workspace leaf-creation paths include `terminalType` on newly created leaf objects
4. Added `isRestoredLeaf` check to prevent the ToolSelector from flashing on restored single-pane tabs

## Prevention

- When adding persistence for runtime-only data, **trace ALL creation paths** — not just the ones in the component you're editing. Search for every callsite that creates the data structure.
- The pattern "data exists in two stores, only one is persisted" is a red flag. When bridging them, ensure the persisted store gets populated at every entry point.
- For layout tree persistence: any field that affects terminal behavior MUST be set at leaf creation time, not deferred to later interaction handlers.

## Verification

1. `npm run build` — passes clean (0 type errors)
2. Manual test:
   - Toggle ON > open mixed-type tabs (shell + claude + gemini) > close app > reopen > all terminals restore with correct types and headers
   - Toggle OFF > same test > only pinned + system tabs survive
   - Split pane with different types > restart > both panes correct
