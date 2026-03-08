# Fleet Picker, Inter Font, Extra Panes & Toggle Behavior

## Summary

Replaced the per-pane dropdown agent assignment in TemplatePicker with a count-based stepper UI (inspired by BridgeSpace). Changed the app's global font from Hack (monospace) to Inter (sans-serif), keeping Hack only for terminal panes. Added "Additional Panes" checkboxes (code review, browser preview, tasks) that open as extra splits beyond the CLI grid. Made code review and browser preview buttons toggle (click to open, click again to close). Removed the File Viewer button from both the tab bar and the template picker since the sidebar file browser covers that workflow.

## Key Decisions

- **Agent picker**: Count-based steppers with +/- buttons, checkboxes, and quick action pills (SELECT ALL, 1 EACH, FILL EVENLY, CLEAR). No preselection — user must explicitly assign all slots.
- **Template switching preserves choices**: When switching from a 2-slot to 3-slot layout, existing agent counts are kept and slots expand. When shrinking, excess is trimmed from the last agents (Gemini first, then Codex, then Claude).
- **Font split**: Inter Variable for all UI chrome, Hack for terminal content only. Terminal panes already explicitly set `fontFamily: "Hack, monospace"` via xterm.js options, so changing the global body font doesn't affect them.
- **Extra panes are additive**: They wrap the terminal layout in a horizontal split (70/30) on the right, not consuming CLI slots.
- **Right-side pane placement**: Code review and file viewer panes open on the far right by wrapping the entire layout, not by splitting the first terminal (which would place them in the middle).
- **Toggle behavior**: Tab bar buttons for code review and browser preview toggle the pane on/off. This is the standard for right-side utility panes.

## Gotchas Encountered

### 1. `splitPane(firstLeafId)` places panes in the MIDDLE, not far right
The existing `splitPane` function finds the target pane by ID and wraps it in a split with the new pane. When used with `findFirstLeafId`, this splits the first terminal — placing the new pane next to it inside the grid, not at the outer edge. To place a pane at the far right of the entire layout, you must wrap the **entire layout** in a new split node: `{ type: "split", children: [entireLayout, newPane] }`.

### 2. Translucent button backgrounds violate design rules
The LAUNCH WORKSPACE button was initially implemented with `rgba(57, 211, 83, 0.12)` background + accent border (tinted/translucent style). This violates the app's design rule requiring solid opaque backgrounds with white text. Fixed to `--ezy-accent-dim` with `#fff` text.

### 3. `@fontsource-variable/inter` is the right package
Not `@fontsource/inter` (which is the static version with separate files per weight). The variable font version bundles all weights in a single woff2 and is imported as `"Inter Variable"` in the font-family stack.

## Prevention

- When placing utility panes (code review, file viewer, browser), always wrap the entire layout tree — never split an individual terminal pane.
- Tab bar buttons for utility panes should always toggle (check if pane exists -> remove it, else add it).
- Always check design rules before styling buttons: solid backgrounds, no translucent/tinted badges.

## Verification

1. `npx tsc --noEmit` — passes
2. `npm run build` — passes
3. Open app -> New Tab -> select layout -> verify steppers, quick actions, slot allocation panel
4. Verify template switching preserves agent counts
5. Verify code review button toggles open/close
6. Verify browser preview button toggles open/close
7. Verify Inter font renders in all UI chrome, Hack only in terminals
