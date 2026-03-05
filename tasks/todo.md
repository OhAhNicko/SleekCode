# EzyDev — Implementation Progress

## Phase 1: Project Scaffolding (DONE)
- [x] Scaffold Tauri v2 + React + TS + Vite
- [x] Install all deps (xterm, react-resizable-panels, zustand, tailwind v4, tauri-pty)
- [x] Create directory structure
- [x] Define TypeScript types
- [x] Set up Zustand store with slice pattern + persist
- [x] Register tauri-plugin-pty in Rust
- [x] Update CLAUDE.md project section

## Phase 2-9: Core Features (DONE)
- [x] PTY Backend, Terminal UI, Pane Grid, Tab System, AI CLI, Dev Server Tab, Browser Preview, Polish

---

# BridgeSpace-Inspired Features

## Phase 1: Full App Theming (DONE)
- [x] 1A: Create `src/lib/themes.ts` — 7 themes with terminal + surface colors
- [x] 1B: Create `src/store/themeSlice.ts` — themeId state + setTheme action
- [x] 1C: Modify `src/store/index.ts` — compose themeSlice, add to persist
- [x] 1D: Modify `src/index.css` — add missing CSS vars
- [x] 1E: Modify `src/App.tsx` — CSS var injection from theme
- [x] 1F: Modify `src/lib/terminal-theme.ts` — re-export from default theme
- [x] 1G: Modify `src/components/TerminalPane.tsx` — theme hot-swap + CSS vars
- [x] 1H: Migrate all component files from hardcoded hex → `var(--ezy-*)`
- [x] 1I: Add theme picker UI to `src/components/TabBar.tsx`

## Phase 2: Workspace Templates + Auto Agent Launch (DONE)
- [x] 2A: Create `src/lib/workspace-templates.ts`
- [x] 2B: Modify `src/lib/layout-utils.ts` — buildLayoutFromTemplate
- [x] 2C: Create `src/components/TemplatePicker.tsx`
- [x] 2D: Modify stores — addTabWithLayout, addTerminals batch
- [x] 2E: Modify Workspace.tsx + TabBar.tsx — integration

## Phase 3: Editor Panes (DONE)
- [x] 3A: Add PaneEditor type + Tauri file commands
- [x] 3B: Install CodeMirror dependencies
- [x] 3C: Create editor-theme.ts + EditorPane.tsx
- [x] 3D: Modify PaneGrid + TerminalHeader — editor integration

## Phase 4: Kanban / Task Board (DONE)
- [x] 4A: Create kanbanSlice.ts + types
- [x] 4B: Create TaskCard.tsx + KanbanBoard.tsx
- [x] 4C: Integrate as pinned tab + pane type

## Phase 5: Command Blocks (DONE)
- [x] 5A: Create shell-integration.ts + command-block-parser.ts
- [x] 5B: Create CommandBlockOverlay.tsx
- [x] 5C: Modify TerminalPane + usePty — integration

---

# Warp-Inspired Feature Roadmap

## Phase 1: Enhanced Command Blocks UI (DONE)
- [x] Extend CommandBlock interface with endTimestamp, outputText
- [x] Add extractOutput + getBlockOutput methods to parser
- [x] Redesign CommandBlockOverlay: left gutter, duration, copy, explain error placeholder, collapse chevron

## Phase 2: Command Palette — Ctrl+K (DONE)
- [x] Create CommandPalette.tsx with search, keyboard nav, grouped results
- [x] Register Ctrl+K shortcut in App.tsx
- [x] Actions: tab navigation, themes, new tab + extensible extraActions

## Phase 3: Launch Configurations (DONE)
- [x] Create launchConfigSlice.ts with save/load/delete/rename
- [x] Compose into store + persist
- [x] Add "Saved Layouts" section + "Save Current Layout" to TabBar dropdown
- [x] Register launch configs as palette actions

## Phase 4: AI Error Explanation (DONE)
- [x] Add PTY write callback registry (registerPtyWrite/unregisterPtyWrite/getPtyWrite)
- [x] Register PTY write callback in TerminalPane
- [x] Enable "Explain Error" button in CommandBlockOverlay
- [x] Handle explain error in PaneGrid: find AI terminal or spawn one, write prompt

## Phase 5: Workflows / Snippets (DONE)
- [x] Create snippetSlice.ts with variable detection + interpolation
- [x] Compose into store + persist
- [x] Create SnippetEditor.tsx with auto-detected variables
- [x] Create SnippetPanel.tsx with list, run, edit, delete, variable fill dialog
- [x] Add "Snippets" button to TerminalHeader
- [x] Register snippets as palette actions

## Phase 6: Rich Command History (DONE)
- [x] Create historySlice.ts with 1000-entry FIFO cap
- [x] Compose into store + persist
- [x] Feed completed command blocks from TerminalPane into history
- [x] Create CommandHistory.tsx: searchable, copy, double-click re-run
- [x] Register "Open Command History" palette action

## Verification
- [x] `npx tsc --noEmit` — clean after each phase
- [x] No hardcoded hex remaining (only brand colors as expected)

---

# Warp-Inspired: Enhanced + Dropdown & Project Sidebar

## Steps
- [x] 1. + Dropdown restructure (TabBar.tsx) — Quick Launch items
- [x] 2. Rust commands (list_dir + search_in_files) in lib.rs
- [x] 3. Types + sidebarSlice + store composition
- [x] 4. FileExplorer component
- [x] 5. GlobalSearch component
- [x] 6. Sidebar container
- [x] 7. App.tsx layout + Ctrl+B shortcut
- [x] 8. TabBar toggle wiring
- [x] 9. PaneGrid file open handler
- [x] 10. TypeScript verification (`npx tsc --noEmit` — clean)

## Review
All features implemented. `npx tsc --noEmit` passes clean.
`npm run build` fails at vite/rollup step due to pre-existing WSL native module issue (not related to changes).

---

# Code Review Pane + Tabbed File Viewer + Browser Preview Button

## Code Review Pane (DONE)
- [x] 1. Rust backend: 6 git Tauri commands (git_is_repo, git_status, git_diff, git_branches, git_revert_hunk, git_discard_file)
- [x] 2. TypeScript types: PaneCodeReview, ComparisonMode, GitFileStatus, GitBranchInfo, DiffHunk, DiffLine, FileDiff
- [x] 3. Diff parser utility (src/lib/diff-parser.ts)
- [x] 4. Layout utils: codereview case in findAllTerminalIds
- [x] 5. CodeReviewPane.tsx — main container with header, comparison mode, branch picker
- [x] 6. CodeReviewFileList.tsx — file list sidebar with status badges
- [x] 7. CodeReviewDiffView.tsx — unified diff rendering with hunk revert, discard, open in editor
- [x] 8. PaneGrid integration + ezydev:open-codereview event listener
- [x] 9. App.tsx: Ctrl+Shift+G shortcut + command palette action
- [x] 10. Tauri permissions for git commands
- [x] 11. TabBar Code Review button (git branch icon)

## Tabbed File Viewer (DONE)
- [x] 1. PaneFileViewer type added to PaneLayout union
- [x] 2. FileViewerPane.tsx — Warp-style tabbed file browser with CodeMirror
- [x] 3. Layout utils: fileviewer case in findAllTerminalIds
- [x] 4. PaneGrid integration + ezydev:open-fileviewer event listener
- [x] 5. TabBar File Viewer button (native file dialog, multi-select)
- [x] 6. Command palette action
- [x] 7. Fixed infinite render loop (removed onFilesChange callback, kept tab state local)

## Browser Preview Button (DONE)
- [x] Restored onOpenBrowser button in TerminalHeader.tsx

## Verification
- `npx tsc --noEmit` — clean (0 errors)
- TabBar buttons properly vertically centered with alignSelf: "center"
