# EzyDev — Architecture

## Overview
Desktop AI terminal workspace built with Tauri v2 + React 19 + TypeScript. Users spawn AI CLI tools (Claude Code, Codex CLI, Gemini CLI) and shell terminals in resizable pane grids, organized by project tabs.

## Stack
- **Desktop shell**: Tauri v2 (Rust backend, WebView2 frontend)
- **Frontend**: React 19 + TypeScript + Vite + Tailwind CSS 4
- **Terminal**: xterm.js with FitAddon, WebglAddon, WebLinksAddon
- **PTY**: `tauri-plugin-pty` (wraps `portable-pty` / Windows ConPTY)
- **Panes**: `react-resizable-panels` (recursive split layout)
- **State**: Zustand with persist middleware (localStorage)
- **Editor**: CodeMirror 6 with syntax highlighting

## Directory Structure
```
src/
├── App.tsx                    # Root: TabBar + Workspace + CommandPalette + SnippetPanel + CommandHistory
├── main.tsx                   # React entry point
├── index.css                  # Tailwind imports + global styles
├── components/
│   ├── TabBar.tsx             # Project tab bar with directory picker + saved layouts
│   ├── Workspace.tsx          # Tab workspace wrapper with tool selector
│   ├── PaneGrid.tsx           # Recursive split pane renderer + AI error handling
│   ├── TerminalPane.tsx       # xterm.js terminal component
│   ├── TerminalHeader.tsx     # Per-pane header with actions (split, snippets, etc.)
│   ├── ToolSelector.tsx       # AI CLI picker dropdown
│   ├── DevServerTab.tsx       # Dev server aggregation view
│   ├── BrowserPreview.tsx     # Iframe browser preview pane
│   ├── EditorPane.tsx         # CodeMirror 6 editor pane
│   ├── KanbanBoard.tsx        # Task board with drag-drop
│   ├── TemplatePicker.tsx     # Workspace layout template selector
│   ├── CommandBlockOverlay.tsx # Per-block UI overlay (gutter, actions, copy, explain error)
│   ├── CommandPalette.tsx     # Ctrl+K command palette with search + keyboard nav
│   ├── CommandHistory.tsx     # Searchable command history panel
│   ├── SnippetPanel.tsx       # Snippet list, run, edit, variable fill dialog
│   ├── SnippetEditor.tsx      # Create/edit snippet form with auto-detected variables
│   ├── ServersPanel.tsx       # Remote SSH server management
│   └── RemoteFileBrowser.tsx  # Remote directory browser
├── hooks/
│   └── usePty.ts              # PTY lifecycle hook (spawn/write/resize/kill)
├── store/
│   ├── index.ts               # Zustand store root with persist (8 slices)
│   ├── tabSlice.ts            # Tab/workspace state
│   ├── terminalSlice.ts       # Terminal + dev server state + PTY write callbacks
│   ├── serverSlice.ts         # Remote SSH server state
│   ├── themeSlice.ts          # Theme selection state
│   ├── kanbanSlice.ts         # Task board state
│   ├── launchConfigSlice.ts   # Saved workspace layout configurations
│   ├── snippetSlice.ts        # Parameterized command snippets
│   └── historySlice.ts        # Command history (1000-entry FIFO cap)
├── lib/
│   ├── terminal-config.ts     # CLI command configs per tool type
│   ├── themes.ts              # 7 built-in themes with terminal + surface colors
│   ├── layout-utils.ts        # splitPane, removePane, tree utilities
│   ├── command-block-parser.ts # OSC 133 parser with output capture
│   ├── shell-integration.ts   # Bash shell integration script injection
│   ├── workspace-templates.ts # Workspace layout template definitions
│   └── editor-theme.ts        # CodeMirror theme adapter
└── types/
    └── index.ts               # Shared TypeScript types

src-tauri/
├── Cargo.toml                 # Rust deps (tauri-plugin-pty, dialog, os)
├── tauri.conf.json            # App config (EzyDev, 1280x800)
├── capabilities/default.json  # Permissions (pty, dialog, os)
└── src/
    ├── main.rs                # Windows entry point
    └── lib.rs                 # Plugin registration
```

## Data Flow
1. **PTY**: `usePty` hook → `tauri-pty` spawn → ConPTY process
2. **Terminal I/O**: PTY `onData` → `terminal.write()`, `terminal.onData()` → PTY `write()`
3. **Resize**: ResizeObserver → FitAddon.fit() → PTY resize(cols, rows)
4. **Layout**: PaneLayout tree (recursive split/leaf) → PaneGrid renders recursively
5. **State**: Zustand store with 8 slices, persist middleware saves to localStorage
6. **Command Blocks**: OSC 133 parser → CommandBlockOverlay → action bar + history feed
7. **AI Error Flow**: CommandBlockOverlay → PaneGrid.handleExplainError → find/spawn AI terminal → PTY write
8. **Snippets**: SnippetPanel → variable interpolation → PTY write to active terminal
9. **Command Palette**: Ctrl+K → dynamic action registry (tabs, themes, configs, snippets, history)

## Pane Layout Model
Recursive tree type: `PaneLeaf | PaneSplit | PaneBrowser | PaneEditor | PaneKanban`
- Leaf: single terminal pane
- Split: horizontal or vertical with two children
- Browser: iframe preview pane
- Editor: CodeMirror 6 file editor
- Kanban: task board

## Store Architecture (8 Slices)
| Slice | Persisted | Purpose |
|-------|-----------|---------|
| TabSlice | Yes | Tab management (system + user tabs) |
| TerminalSlice | No | Terminal instances + dev servers + PTY write callbacks |
| ServerSlice | Yes | Remote SSH server configs |
| ThemeSlice | Yes | Active theme selection |
| KanbanSlice | Yes | Task board cards |
| LaunchConfigSlice | Yes | Saved workspace layout configurations |
| SnippetSlice | Yes | Parameterized command snippets |
| HistorySlice | Yes | Command history (1000-entry FIFO) |

## PTY Write Callbacks
Runtime-only registry (not persisted) stored outside Zustand to avoid re-renders:
- `registerPtyWrite(terminalId, writeFn)` — called in TerminalPane on mount
- `unregisterPtyWrite(terminalId)` — called on unmount
- `getPtyWrite(terminalId)` — used by AI error explain, snippets, history re-run
- `getAllPtyWriteTerminalIds()` — used to find available terminals

## Key Decisions
- Polling-based PTY read (invoke loop, 4096-byte chunks) — acceptable for <8 terminals
- Zustand persist saves tab layouts, configs, snippets, history — not live terminal state
- ConPTY for Windows native terminal support
- WebGL renderer with canvas fallback for xterm.js
- PTY write callbacks stored outside Zustand to avoid unnecessary re-renders
- Command history capped at 1000 entries with FIFO eviction
- Snippet variable detection via regex `$VAR_NAME` pattern
