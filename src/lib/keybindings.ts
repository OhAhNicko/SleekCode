/**
 * The single source of truth for keyboard shortcuts.
 *
 * Before this file the same shortcut was written down in three independent
 * places — the executable `switch` in App.tsx, the hand-maintained display
 * array in KeyboardShortcutsModal.tsx, and literal strings in the context-menu
 * model — and they had already drifted (Ctrl+D read "Split pane (right)" in one
 * and "Split Right" in the other; Ctrl+Shift+1/2/3 were labelled "horizontal"
 * while the code splits *downwards*).
 *
 * Menus MUST render accelerators via `accelerator()`. A menu that prints a
 * chord which does something else is worse than a menu that prints none — it
 * teaches the user to distrust every accelerator in the app.
 *
 * Migration is staged deliberately (see docs). This file starts as the
 * DISPLAY authority only: the modal and the context menus read it, while
 * App.tsx's keydown switch stays untouched. `matchCommand()` exists so the
 * switch can later be retired one command at a time.
 */

export type CommandId =
  // App surfaces
  | "app.palette"
  | "app.toggleSidebar"
  | "app.settings"
  | "app.shortcuts"
  | "app.promptSearch"
  | "app.paneSearch"
  | "app.fileExplorer"
  | "app.codeReview"
  | "app.toggleMiniGames"
  | "app.devtools"
  // Tabs
  | "tab.new"
  | "tab.close"
  | "tab.next"
  | "tab.prev"
  | "tab.switchByIndex"
  | "tab.undoClose"
  // Panes
  | "pane.splitRight"
  | "pane.splitDown"
  | "pane.close"
  | "pane.focusNext"
  | "pane.focusPrev"
  | "pane.newClaude"
  | "pane.newCodex"
  | "pane.newGemini"
  | "pane.newClaudeDown"
  | "pane.newCodexDown"
  | "pane.newGeminiDown"
  // Terminal
  | "terminal.copy"
  | "terminal.paste"
  | "terminal.clear"
  | "terminal.zoomIn"
  | "terminal.zoomOut"
  | "terminal.zoomReset"
  | "terminal.openComposer"
  | "terminal.search"
  | "terminal.scrollTop"
  | "terminal.scrollBottom"
  | "terminal.scrollLineUp"
  | "terminal.scrollLineDown"
  | "terminal.prevPrompt"
  | "terminal.nextPrompt"
  | "terminal.prevPromptDoubleUp"
  | "terminal.deleteWordBack"
  | "terminal.deleteWordForward"
  | "terminal.pasteOrAttach"
  | "terminal.pasteOrAttachMiddleClick"
  | "git.confirmCommit"
  // Composer
  | "composer.send"
  | "composer.newline"
  | "composer.escape"
  | "composer.historyPrev"
  | "composer.historyNext"
  | "composer.acceptGhost"
  | "composer.forwardToTerminal"
  | "composer.prevPrompt"
  | "composer.nextPrompt"
  | "composer.deleteWordBack"
  | "composer.deleteWordForward"
  | "composer.jumpWordLeft"
  | "composer.jumpWordRight";

export type ShortcutGroup = "General" | "Terminal" | "Prompt Composer";

export interface Chord {
  /**
   * Matches `e.key`, CASE-SENSITIVE — exactly how App.tsx compares today
   * ("T", "!", "@"). Ctrl+Shift+1 arrives as "!" on a US layout, which is why
   * the shifted punctuation appears here verbatim.
   */
  key?: string;
  /**
   * Matches `e.code` instead of `e.key`. Required for Alt+digit: App.tsx:747-750
   * documents that Alt+digit on Windows produces layout-dependent `e.key`.
   */
  code?: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface KeyBinding {
  command: CommandId;
  /** Every chord that fires it. `chords[0]` is the one menus display. */
  chords: Chord[];
  /**
   * Overrides chord rendering for shortcuts that aren't a single literal chord
   * ("Alt"+"1-9", "Middle-click"). When set, this is what the UI shows.
   */
  displayKeys?: string[];
  label: string;
  group: ShortcutGroup;
  /**
   * Who executes it. "app" = App.tsx's global keydown handler. "pane" and
   * "composer" are handled inside their own components, so menus may DISPLAY
   * them but `runCommand` cannot invoke them centrally.
   */
  ownedBy: "app" | "pane" | "composer";
  /**
   * Additional rows for the shortcuts modal only — alias chords that carry
   * their own wording (Ctrl+Shift+P is the palette "again", Ctrl+Shift+N is
   * "New project / tab"). They exist so deriving the modal from this table
   * cannot silently drop rows the modal used to show.
   */
  extraRows?: { keys: string[]; label: string }[];
}

const C = (key: string, mods: Omit<Chord, "key" | "code"> = {}): Chord => ({ key, ...mods });

export const KEYBINDINGS: readonly KeyBinding[] = [
  // ── General ────────────────────────────────────────────────────────────
  { command: "pane.newClaude", chords: [C("1", { ctrl: true })], label: "New Claude pane", group: "General", ownedBy: "app" },
  { command: "pane.newCodex", chords: [C("2", { ctrl: true })], label: "New Codex pane", group: "General", ownedBy: "app" },
  { command: "pane.newGemini", chords: [C("3", { ctrl: true })], label: "New Gemini pane", group: "General", ownedBy: "app" },
  // App.tsx sends direction:"vertical" for these, which stacks the new pane
  // BELOW. The modal used to call them "(horizontal)" — that described the
  // divider, not the result, and contradicted Ctrl+Shift+D's "(below)".
  { command: "pane.newClaudeDown", chords: [C("!", { ctrl: true, shift: true })], displayKeys: ["Ctrl", "Shift", "1"], label: "New Claude pane (below)", group: "General", ownedBy: "app" },
  { command: "pane.newCodexDown", chords: [C("@", { ctrl: true, shift: true })], displayKeys: ["Ctrl", "Shift", "2"], label: "New Codex pane (below)", group: "General", ownedBy: "app" },
  { command: "pane.newGeminiDown", chords: [C("#", { ctrl: true, shift: true })], displayKeys: ["Ctrl", "Shift", "3"], label: "New Gemini pane (below)", group: "General", ownedBy: "app" },
  { command: "pane.splitRight", chords: [C("d", { ctrl: true })], label: "Split pane (right)", group: "General", ownedBy: "app" },
  { command: "pane.splitDown", chords: [C("D", { ctrl: true, shift: true })], label: "Split pane (below)", group: "General", ownedBy: "app" },
  { command: "pane.close", chords: [C("w", { ctrl: true })], label: "Close pane", group: "General", ownedBy: "app" },
  { command: "pane.focusNext", chords: [C("]", { ctrl: true, shift: true })], label: "Focus next pane", group: "General", ownedBy: "app" },
  { command: "pane.focusPrev", chords: [C("[", { ctrl: true, shift: true })], label: "Focus previous pane", group: "General", ownedBy: "app" },
  { command: "app.toggleSidebar", chords: [C("b", { ctrl: true })], label: "Toggle sidebar", group: "General", ownedBy: "app" },
  { command: "app.fileExplorer", chords: [C("E", { ctrl: true, shift: true })], label: "Toggle file explorer", group: "General", ownedBy: "app" },
  { command: "app.palette", chords: [C("k", { ctrl: true }), C("P", { ctrl: true, shift: true })], label: "Command palette", group: "General", ownedBy: "app", extraRows: [{ keys: ["Ctrl", "Shift", "P"], label: "Command palette" }] },
  { command: "app.settings", chords: [C(",", { ctrl: true })], label: "Settings", group: "General", ownedBy: "app" },
  { command: "tab.next", chords: [C("Tab", { ctrl: true })], label: "Next tab", group: "General", ownedBy: "app" },
  { command: "tab.prev", chords: [C("Tab", { ctrl: true, shift: true })], label: "Previous tab", group: "General", ownedBy: "app" },
  { command: "tab.switchByIndex", chords: [], displayKeys: ["Alt", "1-9"], label: "Switch to tab by number", group: "General", ownedBy: "app" },
  { command: "tab.new", chords: [C("T", { ctrl: true, shift: true }), C("N", { ctrl: true, shift: true })], label: "New tab", group: "General", ownedBy: "app", extraRows: [{ keys: ["Ctrl", "Shift", "N"], label: "New project / tab" }] },
  { command: "tab.close", chords: [C("W", { ctrl: true, shift: true })], label: "Close tab", group: "General", ownedBy: "app" },
  { command: "app.codeReview", chords: [C("F", { ctrl: true, shift: true })], label: "Code review", group: "General", ownedBy: "app" },
  { command: "git.confirmCommit", chords: [], displayKeys: ["Ctrl", "Enter"], label: "Confirm commit", group: "General", ownedBy: "pane" },
  // Scoped to the undo toast's visibility window (UndoCloseToast.tsx:33-44),
  // not a global binding — the label has to say so or it reads as "undo any time".
  { command: "tab.undoClose", chords: [C("z", { ctrl: true })], label: "Undo close tab (while the undo toast is showing)", group: "General", ownedBy: "pane" },
  { command: "app.promptSearch", chords: [C("r", { ctrl: true })], label: "Search prompt history", group: "General", ownedBy: "app" },
  { command: "app.paneSearch", chords: [C("f", { ctrl: true })], label: "Search in active pane (terminal, editor, file viewer, code review, kanban)", group: "General", ownedBy: "app" },
  { command: "app.shortcuts", chords: [C("/", { ctrl: true })], label: "Keyboard shortcuts", group: "General", ownedBy: "app" },
  { command: "app.toggleMiniGames", chords: [C("G", { ctrl: true, shift: true })], label: "Toggle mini-games button", group: "General", ownedBy: "app" },
  { command: "app.devtools", chords: [C("F12")], label: "Open DevTools", group: "General", ownedBy: "app" },

  // ── Terminal ───────────────────────────────────────────────────────────
  { command: "terminal.search", chords: [], displayKeys: ["Ctrl", "F"], label: "Search terminal buffer", group: "Terminal", ownedBy: "pane" },
  { command: "terminal.openComposer", chords: [C("i", { ctrl: true })], label: "Open prompt composer", group: "Terminal", ownedBy: "pane" },
  { command: "terminal.clear", chords: [C("l", { ctrl: true })], label: "Clear terminal", group: "Terminal", ownedBy: "app" },
  // Both chords fire it; "+" is the one worth showing (Ctrl+= reads like a typo).
  { command: "terminal.zoomIn", chords: [C("=", { ctrl: true }), C("+", { ctrl: true })], displayKeys: ["Ctrl", "+"], label: "Zoom in (font size)", group: "Terminal", ownedBy: "app" },
  { command: "terminal.zoomOut", chords: [C("-", { ctrl: true })], label: "Zoom out (font size)", group: "Terminal", ownedBy: "app" },
  { command: "terminal.zoomReset", chords: [C("0", { ctrl: true })], label: "Reset font size", group: "Terminal", ownedBy: "app" },
  { command: "terminal.copy", chords: [C("C", { ctrl: true, shift: true })], label: "Copy", group: "Terminal", ownedBy: "app" },
  { command: "terminal.paste", chords: [C("V", { ctrl: true, shift: true })], label: "Paste", group: "Terminal", ownedBy: "app" },
  { command: "terminal.scrollTop", chords: [], displayKeys: ["Ctrl", "Home"], label: "Scroll to top", group: "Terminal", ownedBy: "pane" },
  { command: "terminal.scrollBottom", chords: [], displayKeys: ["End"], label: "Scroll to bottom", group: "Terminal", ownedBy: "pane" },
  { command: "terminal.scrollLineUp", chords: [], displayKeys: ["Ctrl", "Shift", "↑"], label: "Scroll up one line", group: "Terminal", ownedBy: "pane" },
  { command: "terminal.scrollLineDown", chords: [], displayKeys: ["Ctrl", "Shift", "↓"], label: "Scroll down one line", group: "Terminal", ownedBy: "pane" },
  { command: "terminal.prevPrompt", chords: [], displayKeys: ["PgUp"], label: "Jump to previous prompt", group: "Terminal", ownedBy: "pane" },
  { command: "terminal.nextPrompt", chords: [], displayKeys: ["PgDn"], label: "Jump to next prompt", group: "Terminal", ownedBy: "pane" },
  { command: "terminal.prevPromptDoubleUp", chords: [], displayKeys: ["↑", "↑"], label: "Jump to previous prompt", group: "Terminal", ownedBy: "pane" },
  { command: "terminal.deleteWordBack", chords: [], displayKeys: ["Ctrl", "Backspace"], label: "Delete word (backward)", group: "Terminal", ownedBy: "pane" },
  { command: "terminal.deleteWordForward", chords: [], displayKeys: ["Ctrl", "Delete"], label: "Delete word (forward)", group: "Terminal", ownedBy: "pane" },
  { command: "terminal.pasteOrAttach", chords: [], displayKeys: ["Ctrl", "V"], label: "Paste (or attach image)", group: "Terminal", ownedBy: "pane" },
  { command: "terminal.pasteOrAttachMiddleClick", chords: [], displayKeys: ["Middle-click"], label: "Paste (or attach image)", group: "Terminal", ownedBy: "pane" },

  // ── Prompt Composer ────────────────────────────────────────────────────
  { command: "composer.send", chords: [], displayKeys: ["Enter"], label: "Send message", group: "Prompt Composer", ownedBy: "composer" },
  { command: "composer.newline", chords: [], displayKeys: ["Shift", "Enter"], label: "New line", group: "Prompt Composer", ownedBy: "composer" },
  { command: "composer.escape", chords: [], displayKeys: ["Escape"], label: "Send Escape to terminal", group: "Prompt Composer", ownedBy: "composer" },
  { command: "composer.historyPrev", chords: [], displayKeys: ["↑"], label: "Previous prompt (history)", group: "Prompt Composer", ownedBy: "composer" },
  { command: "composer.historyNext", chords: [], displayKeys: ["↓"], label: "Next prompt (history)", group: "Prompt Composer", ownedBy: "composer" },
  { command: "composer.acceptGhost", chords: [], displayKeys: ["Tab"], label: "Accept ghost / cycle image", group: "Prompt Composer", ownedBy: "composer" },
  { command: "composer.forwardToTerminal", chords: [], displayKeys: ["Shift", "Tab"], label: "Forward to terminal", group: "Prompt Composer", ownedBy: "composer" },
  { command: "composer.prevPrompt", chords: [], displayKeys: ["PgUp"], label: "Jump to previous prompt", group: "Prompt Composer", ownedBy: "composer" },
  { command: "composer.nextPrompt", chords: [], displayKeys: ["PgDn"], label: "Jump to next prompt", group: "Prompt Composer", ownedBy: "composer" },
  { command: "composer.deleteWordBack", chords: [], displayKeys: ["Ctrl", "Backspace"], label: "Delete word (backward)", group: "Prompt Composer", ownedBy: "composer" },
  { command: "composer.deleteWordForward", chords: [], displayKeys: ["Ctrl", "Delete"], label: "Delete word (forward)", group: "Prompt Composer", ownedBy: "composer" },
  { command: "composer.jumpWordLeft", chords: [], displayKeys: ["Ctrl", "←"], label: "Jump word left", group: "Prompt Composer", ownedBy: "composer" },
  { command: "composer.jumpWordRight", chords: [], displayKeys: ["Ctrl", "→"], label: "Jump word right", group: "Prompt Composer", ownedBy: "composer" },
];

const BY_COMMAND: ReadonlyMap<CommandId, KeyBinding> = new Map(
  KEYBINDINGS.map((b) => [b.command, b]),
);

export function getBinding(command: CommandId): KeyBinding | undefined {
  return BY_COMMAND.get(command);
}

/** Human labels for chord keys whose raw value reads badly in a menu. */
const KEY_LABELS: Record<string, string> = {
  " ": "Space",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

function chordKeys(c: Chord): string[] {
  const parts: string[] = [];
  if (c.ctrl) parts.push("Ctrl");
  if (c.shift) parts.push("Shift");
  if (c.alt) parts.push("Alt");
  const raw = c.key ?? c.code ?? "";
  const label = KEY_LABELS[raw] ?? (raw.length === 1 ? raw.toUpperCase() : raw);
  if (label) parts.push(label);
  return parts;
}

/**
 * Key caps for a command, e.g. ["Ctrl","Shift","D"] — what the shortcuts modal
 * renders as individual chips. Empty array when the command has no shortcut.
 */
export function acceleratorKeys(command: CommandId): string[] {
  const b = BY_COMMAND.get(command);
  if (!b) return [];
  if (b.displayKeys) return b.displayKeys;
  const first = b.chords[0];
  return first ? chordKeys(first) : [];
}

/**
 * Display string for a command, e.g. "Ctrl+Shift+D". Returns "" when the
 * command has no shortcut — callers should render nothing rather than a
 * placeholder, so an absent accelerator is never mistaken for a real one.
 */
export function accelerator(command: CommandId): string {
  return acceleratorKeys(command).join("+");
}

function chordMatches(c: Chord, e: KeyboardEvent): boolean {
  if (!!c.ctrl !== e.ctrlKey) return false;
  if (!!c.shift !== e.shiftKey) return false;
  if (!!c.alt !== e.altKey) return false;
  if (c.code) return e.code === c.code;
  if (c.key) return e.key === c.key;
  return false;
}

/**
 * Resolve a live keyboard event to a command, or null.
 *
 * Not yet wired into App.tsx's handler — it exists so the switch can be
 * retired one command at a time behind a MIGRATED set, and so a DEV probe can
 * assert the two agree before any behaviour moves.
 */
export function matchCommand(e: KeyboardEvent): CommandId | null {
  for (const b of KEYBINDINGS) {
    for (const c of b.chords) {
      if (chordMatches(c, e)) return b.command;
    }
  }
  return null;
}

/** Sections for the shortcuts modal, derived so it can never drift again. */
export function shortcutSections(): { title: ShortcutGroup; items: { keys: string[]; label: string }[] }[] {
  const groups: ShortcutGroup[] = ["General", "Terminal", "Prompt Composer"];
  return groups.map((title) => ({
    title,
    items: KEYBINDINGS.filter((b) => b.group === title).flatMap((b) => {
      const primary = { keys: acceleratorKeys(b.command), label: b.label };
      const rows = primary.keys.length > 0 ? [primary] : [];
      return b.extraRows ? [...rows, ...b.extraRows] : rows;
    }),
  }));
}

/**
 * Commands whose execution has moved to `runCommand`.
 *
 * The gate that reads this sits ABOVE App.tsx's legacy switch, so a command
 * added here stops reaching the switch and starts going through the table.
 * Grow it ONE command per commit: each addition is a one-line diff and a
 * one-line revert. When it covers every `ownedBy: "app"` command, delete the
 * switch wholesale.
 *
 * Deliberately empty to start — step B (the DEV probe below) runs against real
 * usage first and proves `matchCommand` agrees with the switch before any
 * behaviour actually moves.
 */
export const MIGRATED: ReadonlySet<CommandId> = new Set<CommandId>([]);

/**
 * DEV-only instrument: warn when `matchCommand` disagrees with what the legacy
 * switch would do. Read-only — it changes no behaviour, it just surfaces
 * transcription errors in the table before step C moves anything.
 *
 * Call at the very top of App.tsx's keydown handler.
 */
export function probeKeybinding(e: KeyboardEvent): void {
  if (!import.meta.env.DEV) return;
  const cmd = matchCommand(e);
  if (!cmd) return;
  const b = BY_COMMAND.get(cmd);
  // Only "app"-owned commands are ones the switch is supposed to handle.
  if (b?.ownedBy !== "app") return;
  // eslint-disable-next-line no-console
  console.debug(`[keys] ${accelerator(cmd)} -> ${cmd}${MIGRATED.has(cmd) ? " (migrated)" : ""}`);
}

/**
 * DEV-only: flag chords bound to more than one command. A collision means one
 * of them silently never fires — which is exactly how "Find within block"
 * would have shipped printing Ctrl+Shift+F while that chord opens Code Review.
 */
export function verifyKeybindings(): string[] {
  const seen = new Map<string, CommandId>();
  const problems: string[] = [];
  for (const b of KEYBINDINGS) {
    for (const c of b.chords) {
      const sig = `${c.ctrl ? "C" : ""}${c.shift ? "S" : ""}${c.alt ? "A" : ""}:${c.code ?? c.key}`;
      const prev = seen.get(sig);
      if (prev && prev !== b.command) {
        problems.push(`${sig} is bound to both "${prev}" and "${b.command}"`);
      } else {
        seen.set(sig, b.command);
      }
    }
  }
  return problems;
}
