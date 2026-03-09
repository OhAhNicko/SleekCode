# Dev Server Tab → Sidebar Panel Conversion

**Date:** 2026-03-09

## Summary

Converted the Dev Servers "tab" from a full-page view into a compact sidebar-style panel (260px wide), matching the existing file/search sidebar pattern. Added mutual exclusion so the sidebar and dev server panel can't be open simultaneously. Also added: duplicate server prevention per project, removable stopped servers, and minor UX polish (button reorder, full URL display, visual separator).

## Changes Made

### 1. Sidebar panel architecture
- Added `devServerPanelOpen` boolean + `toggleDevServerPanel()` to `sidebarSlice.ts`
- Mutual exclusion: opening sidebar closes dev server panel and vice versa (both handled in their respective toggle functions)
- The dev-server-tab still exists in the store as a system tab (for protection logic in `removeTab`), but is never rendered as a full page — `App.tsx` returns `null` for `tab.isDevServerTab` in the tab render loop

### 2. Tab cycling and fallback safety
- `Ctrl+Tab` / `Ctrl+Shift+Tab` cycling filters out `isDevServerTab` to prevent landing on a blank page
- `removeTab` fallback prefers non-system tabs; the store `merge` function redirects persisted `activeTabId === "dev-server-tab"` to the first non-system tab
- `App.tsx` has a `useEffect` that catches stale `activeTabId === "dev-server-tab"` at runtime and redirects + opens the panel

### 3. Compact DevServerTab component
- Outer container: 260px, same structure as `Sidebar.tsx` (flexShrink 0, borderRight, full height)
- Header: 34px, uppercase label, count badge, add button
- Server rows: two-line layout (name + actions on line 1, command + URL on line 2), no card borders, just bottom border separators
- Smaller icon buttons (22px vs 28px), smaller fonts (10-12px)
- Removed inline BrowserPreview split — URL clicks always open in a tab

### 4. Duplicate server prevention
- All three spawn sites (TabBar `spawnDevServer`, App.tsx startup restore, DevServerTab AddServerForm) check for existing servers with the same `workingDir` (normalized for slash differences)
- TabBar returns the existing terminalId; AddServerForm closes silently; startup restore uses a `seenDirs` Set

### 5. Removable stopped servers
- X button appears in action buttons when `status === "stopped"` or `status === "error"`
- Calls `removeDevServer(server.id)` from the store

## Key Design Decisions

- **Keep the system tab in the store** — removing it entirely would require touching many `isDevServerTab` filter checks across TabBar, tabSlice, store merge, etc. Cheaper to keep it as a hidden system tab and just never render it.
- **Preview toggle button removed** — at 260px there's no room for an inline split preview. The `previewInProjectTab` setting is still used by `DevServerRow` for URL click behavior, controllable from Settings if needed.
- **Active panel border** — the dev server button's `borderRight` uses `var(--ezy-border)` (stronger) when active vs `var(--ezy-border-subtle)` when inactive, to prevent it visually merging with adjacent tabs.

## Prevention

- When converting a full-page component to a sidebar panel, audit ALL places that set `activeTabId` to that tab's ID (keyboard shortcuts, tab cycling, fallbacks in removeTab, persisted state merge).
- Path normalization (`replace(/\\/g, "/")`) is essential for dedup logic in WSL/Windows mixed environments.

## Verification

1. `npx tsc --noEmit` — passes clean
2. Click Dev Server icon — toggles panel on/off
3. Open sidebar (Ctrl+B) while panel is open — panel closes
4. Open panel while sidebar is open — sidebar closes
5. Ctrl+Tab never lands on blank dev-server-tab page
6. Opening same project in two tabs — only one dev server spawned
7. Stop a server — X button appears, clicking removes the row
