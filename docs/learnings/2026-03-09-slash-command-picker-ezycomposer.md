# Slash Command Picker for EzyComposer

## Summary

Implemented a full slash command picker popup inside EzyComposer (PromptComposer.tsx) with:
- Popup dropdown filtering as user types `/...` — always on for claude/codex/gemini, hidden for shell/devserver
- Inline ghost text mode (opt-in setting) showing command completion suffix
- Arg hint ghost (`[name]`) for commands that require arguments (e.g. `/rename`)
- 60 Claude, 27 Codex, 36 Gemini built-in commands from official docs
- Dynamic user skill loading from `~/.claude/commands/`, `~/.codex/prompts/`, `~/.gemini/commands/`
- Codex-specific UX: display as `/test` in popup but send `/prompts:test` to CLI (label vs name split)
- Auto-close: popup closes exactly when the full command name has been typed, enabling single-Enter submit

## Key Files

| File | Role |
|---|---|
| `src/lib/slash-commands.ts` | Command data, arg hints, user skill loader |
| `src/components/PromptComposer.tsx` | Popup state, handlers, JSX, ghost text |
| `src/store/recentProjectsSlice.ts` | `slashCommandGhostText: boolean` setting |
| `src/components/TabBar.tsx` | Settings toggle for inline ghost text |
| `src/components/TerminalPane.tsx` | Passes `workingDir` prop to PromptComposer |

## Double-Enter Bug: Symptoms, Root Cause, Fix

### Symptom
When typing a slash command by hand (e.g. `/clear`) and pressing Enter, the popup intercepted the Enter key and called `selectSlashCommand()` (inserting `/clear ` and keeping focus). The user then had to press Enter a second time to actually submit. Classic double-Enter.

### First Fix Attempt — Enter handler logic
The initial fix was in `handleKeyDown`: if the popup is open and Enter is pressed, check if the typed query exactly matches the selected command's label with no arg hint — if so, close the popup and call `submit()` directly instead of `selectSlashCommand()`.

```ts
// BUGGY: popup still open when Enter fires
if (typedQuery === cmdLabel && !hasArgHint) {
  setSlashMatches([]);
  setSlashSelectedIdx(0);
  submit();
}
```

**This worked for Enter, but introduced a new bug**: "popup disappears on the second character." The root cause was that the "exact match with 1 match" check was being applied somewhere else too aggressively during the filter phase, clearing matches prematurely.

### Why the Enter handler approach is insufficient
The Enter handler only fires when the user explicitly presses Enter. But the mental model is: **the popup should close the moment the full command is typed**, not when Enter is pressed. The popup disappearing on Enter is still one interaction too late — users see a "stuck" popup even though they've already typed the full command.

### Correct Fix — Auto-close in `computeSlashMatches`
The fix belongs in `computeSlashMatches`, which runs on every keystroke via `onChange`. After filtering to matches, apply the auto-close guard:

```ts
const matches = query === "" ? commands : commands.filter((c) => (c.label ?? c.name).startsWith(query));
// Auto-close: exactly 1 match, query is exact label, no arg hint
if (matches.length === 1 && query !== "") {
  const only = matches[0];
  const label = (only.label ?? only.name).toLowerCase();
  const hasArgHint = !!(SLASH_ARG_HINTS[terminalType] ?? {})[only.name];
  if (label === query && !hasArgHint) return [];
}
return matches;
```

When the user types the last character of a complete command, `computeSlashMatches` returns `[]`, `setSlashMatches([])` is called via `onChange`, the popup vanishes. The next Enter press has `slashMatches.length === 0` — the popup block is skipped entirely — and `submit()` fires directly.

### The `matches.length === 1` Guard is Critical
This prevents premature closing when a typed prefix is an exact match for one command but a prefix for another. Example: Claude has both `status` (60 chars) and `statusline`. When the user types `/status`:
- Without the guard: 1 result for `status`, closes → correct
- Actually `status` IS in the list AND `statusline` also starts with `status` → 2 matches → guard doesn't trigger

Wait — both `status` and `statusline` match `/status`? Yes: `/status` starts with `status`, and `statusline` also starts with `status`. So `matches.length === 2`, the guard doesn't trigger, popup stays open. This is exactly correct — the user can still arrow-down to pick `statusline`. Only when they type `/statusline` (1 match, exact) does the popup close.

## Codex namePrefix: label vs name split

Codex user prompts are invoked as `/prompts:test` but displaying `/prompts:test` in the popup looks ugly. The solution: `SlashCommand` gets an optional `label` field for display/filtering, while `name` holds the actual inserted value.

```ts
export interface SlashCommand {
  name: string;    // inserted: "prompts:test"
  label?: string;  // displayed/filtered: "test"
  description: string;
}
```

- `computeSlashMatches` filters on `(c.label ?? c.name)`
- Popup displays `/{cmd.label ?? cmd.name}`
- `selectSlashCommand` inserts `"/" + cmd.name + " "` (the full value)
- User sees `/test` in popup, gets `/prompts:test ` in textarea

## User Skill Loading

`loadUserSkills(terminalType, workingDir)` scans per-CLI directories for `.md` files:

```ts
const CLI_CUSTOM_COMMANDS = {
  claude: { globalDir: ".claude/commands", projectDir: ".claude/commands" },
  codex:  { globalDir: ".codex/prompts",   namePrefix: "prompts:" },
  gemini: { globalDir: ".gemini/commands", projectDir: ".gemini/commands" },
};
```

- Uses Tauri `invoke("list_dir")` + `invoke("read_file")` — no new Rust code needed
- `homeDir()` from `@tauri-apps/api/path` is available via `core:default` capability
- First line of `.md` file becomes the description
- Project-level deduplicates against global (same `baseName`) — project wins
- Codex has no project-level support (confirmed from official docs)
- Results are merged into built-ins, with user skills taking precedence by name

## Arg Hint Ghost Text

For commands requiring arguments (e.g. `/rename`), a placeholder hint appears after the command is accepted:

```ts
export const SLASH_ARG_HINTS: Partial<Record<string, Record<string, string>>> = {
  claude: { rename: "[name]" },
};
```

- Shown as dim overlay text when textarea value matches `^/cmd ` exactly
- Disappears when user types anything after the space
- Auto-close guard skips commands with arg hints (`!hasArgHint`) so popup stays after `/rename` is typed, keeping the ghost hint visible

## Prevention

- **Popup auto-close belongs in the filtering function**, not in key handlers — key handlers are too late and create UX confusion.
- **`matches.length === 1` is the right guard** for auto-close — prevents closing when the typed text is a prefix of multiple commands (e.g. `status` vs `statusline`).
- **Never use Enter handler for "exact match submit"** — the popup should be gone before Enter fires.
- **`homeDir()` doesn't require Tauri rebuild** — it's part of `core:default` capability already granted.

## Verification

```bash
npm run typecheck  # passes (only pre-existing usePty.ts error)
```

Manual:
1. Claude pane → `/` → popup shows all 60 commands
2. Type `/cle` → shows `clear`; type `a` (→ `/clea`) → still shows; type `r` (→ `/clear`) → popup closes
3. Press Enter → submits directly (no double-Enter)
4. Type `/stat` → shows `status` + `statusline` (both match); type `u` → shows both; type `s` → shows both; finish typing `statusline` → popup closes
5. `/rename` → popup shows `rename`; type `e` (last char) → popup closes + arg hint `[name]` appears dimly
6. Type a name → hint vanishes
7. Codex pane with a custom prompt `test.md` → shows `/test` in popup → sends `/prompts:test ` to terminal
8. Shell pane → type `/` → no popup
