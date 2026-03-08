# Moving pane-header buttons to TabBar: scoping mistakes

## Summary

Session focused on decluttering pane headers by moving buttons to the TabBar, fixing dev server restore on restart, and reorganizing UI controls. The critical bug was incorrectly implementing the Tasks button as a tab switch instead of a pane addition.

## Symptoms

1. Clicking "Tasks" in TabBar caused blank screen — all tabs rendered with `display: none`
2. User was stuck on the kanban system tab with no X button to close it
3. Remote Servers system tab became unexpectedly visible after filtering changes

## Root cause (Tasks button failure)

**Faulty reasoning:** When moving the "Open Tasks" button from the pane header to the TabBar, I treated it like a tab navigation action (`setActiveTab(kanbanTabId)`) instead of what it actually was — adding a kanban pane to the active project tab's layout.

The original pane-header code was:
```typescript
const kanbanPane = { type: "kanban", id: generatePaneId() };
handleLayoutChange(splitPane(tab.layout, paneId, "horizontal", kanbanPane));
```

This adds a kanban pane *inside* the project workspace. But I changed it to:
```typescript
const kanban = tabs.find((t) => t.isKanbanTab);
if (kanban) setActiveTab(kanban.id);
```

This switches to the kanban *system tab*, which is a completely different thing. The blank screen happened because:
- The kanban system tab may not have existed in persisted state
- Switching to a non-existent tab left `activeTabId` pointing to nothing
- All tabs rendered as `display: none` since none matched `activeTabId`

**Why the mistake happened:** I confused "Tasks" (a per-project kanban pane) with "Kanban Tab" (the system tab). Moving a button from pane-level to tab-level doesn't change what the button DOES — it still adds a pane. The only difference is that from the TabBar, there's no specific terminal to split from, so `addPaneAsGrid` should be used instead of `splitPane`.

## Fix

```typescript
// Correct TabBar implementation — adds pane, doesn't switch tabs
onClick={() => {
  const tab = tabs.find((t) => t.id === activeTabId);
  if (!tab || tab.isDevServerTab || tab.isServersTab || tab.isKanbanTab) return;
  const kanbanPane = { type: "kanban", id: generatePaneId() };
  useAppStore.getState().updateTabLayout(tab.id, addPaneAsGrid(tab.layout, kanbanPane));
}}
```

## Other changes in this session

- **Dev server restore:** Added `serverCommand` to Tab type, startup effect in App.tsx with fallback to `recentProjects`
- **Browser preview URL:** Fixed `https` → `http`
- **Pane counter:** Changed from all-leaves to CLI-only count via `findAllTerminalIds`
- **Dev server badge:** Changed from dot to numbered pill (12px)
- **Remote Servers tab:** Hidden from tab bar, accessible via settings dropdown toggle
- **Browser preview toggle:** Click again to close all browser panes
- **Split buttons moved:** Removed from pane header, added split-down icon to each CLI row in the chevron dropdown

## Prevention

1. **When moving a button between components, preserve its exact behavior.** Read the original handler, understand what it does, then adapt it for the new context (e.g., no `termId` available → use `addPaneAsGrid` instead of `splitPane`).
2. **"Pane" vs "Tab" distinction is critical.** A pane lives inside a tab's layout tree. A tab is a top-level workspace. Adding a pane !== switching tabs.
3. **System tabs (kanban, servers, dev-server) should not be directly user-addressable** — they're infrastructure. User-facing actions should manipulate panes within project tabs.
4. **When filtering system tabs from visibility, check ALL references** — hiding kanban but not servers exposed the servers tab unexpectedly.

## Verification

- `npm run build` passes
- Tasks button adds kanban pane to active project layout
- Browser preview toggles on/off with same button
- Remote Servers accessible via settings dropdown, closable via same toggle
- Split-down button available per CLI type in the add-pane dropdown
- Pane header only has type picker, drag handle, and close button
