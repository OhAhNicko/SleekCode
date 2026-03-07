# TemplatePicker: Single-View UX Refactor

**Date:** 2026-03-07

## Summary

Refactored the TemplatePicker popup from a two-step wizard (Step 1: Choose Layout, Step 2: Assign Agents) into a single unified view where the layout grid is always visible and agent assignment slots appear inline below it when a template is selected.

## Symptoms

- Choosing "Single pane" immediately created the workspace without showing agent assignment (user couldn't pick Claude vs Shell)
- After fixing that to always show step 2, the user was stuck on the "Assign Agents" screen with only a "Back" button to return to layout selection — bad discoverability
- Two-step wizard hides context: once in step 2, the user can't see/compare layouts without going back

## Root cause

The original design used a `step` state variable (1 or 2) that conditionally rendered either the template grid OR the agent assignment — never both. Single-pane templates had an early return that skipped step 2 entirely.

## Fix

1. Removed the `step` state variable entirely
2. Layout grid is always rendered with a selected-state highlight (accent border + glow background) on the active template
3. Agent assignment section renders conditionally below the grid only when `selectedTemplate` is non-null
4. User can click a different template at any time — the agent slots update immediately
5. "Create Workspace" button only appears after a template is selected

## Additional changes in this session

- Reordered `TERMINAL_OPTIONS` array: Claude first, Shell last (was Shell first)
- Default slot fill changed from `"shell"` to `"claude"` so all panes default to Claude

## Prevention

- For popup/modal UX, prefer single-view layouts over multi-step wizards when the total content fits in one screen
- Always ensure single-pane templates go through the same flow as multi-pane templates

## Verification

- `npm run build` passes
- Open new tab/project: layout grid visible, click any template, agent slots appear below, can switch templates freely, "Create Workspace" only after selection
