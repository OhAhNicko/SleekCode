/**
 * Per-pane imperative actions, registered by whichever renderer owns the pane.
 *
 * One registry so a menu item can be written once and work on BOTH renderers:
 * the xterm pane registers `term.scrollToTop()`, the native pane registers
 * `nativeTermScrollToLine(id, 0)`, and the terminal provider just calls
 * `getTerminalActions(id)?.scrollToTop()`.
 *
 * Deliberately a registry and not a `made:*` CustomEvent. The menu's Paste item
 * was dead for months because it dispatched `made:paste-text` into a void — no
 * listener existed anywhere. A registry cannot fail that way: if nothing
 * registered, the lookup returns undefined and the menu disables the row
 * instead of silently doing nothing.
 *
 * Outside Zustand for the same reason as the sibling registries in
 * `store/terminalSlice.ts` and `lib/pane-search-registry.ts` — nothing renders
 * off these, so storing them would churn re-renders.
 */
export interface TerminalActions {
  scrollToTop(): void;
  scrollToBottom(): void;
  restart(): void;
}

const registry: Record<string, TerminalActions> = {};

export function registerTerminalActions(terminalId: string, actions: TerminalActions): void {
  registry[terminalId] = actions;
}

export function unregisterTerminalActions(terminalId: string): void {
  delete registry[terminalId];
}

export function getTerminalActions(terminalId: string): TerminalActions | undefined {
  return registry[terminalId];
}
