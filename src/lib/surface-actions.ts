/**
 * Handlers that live inside a component, exposed to context-menu providers.
 *
 * Most list surfaces (code review rows, server rows, browser panes, editor
 * tabs) keep their actions as component-local closures — they are not store
 * actions, so a provider cannot call them directly. Rather than inventing a
 * `made:*` event per action and hoping someone listens (the exact failure that
 * left `made:paste-text` inert for months), each component registers its
 * handlers ONCE under its surface role.
 *
 * Registration is per SURFACE, not per row — handlers take the row id. One
 * registration per mounted component, not one per list item.
 *
 * A provider that finds no registration disables the row with a reason instead
 * of rendering an action that silently does nothing.
 */
export type SurfaceRole =
  | "kanban-card"
  | "kanban-col"
  | "review-file"
  | "server"
  | "devserver"
  | "editor-tab"
  | "browser"
  | "sidebar"
  | "jira-ticket"
  | "jira-assigned"
  | "game-sidebar"
  | "knowledge"
  | "knowledge-note";

export type SurfaceActions = Record<string, (id: string) => void>;

const registry: Partial<Record<SurfaceRole, SurfaceActions>> = {};

export function registerSurfaceActions(role: SurfaceRole, actions: SurfaceActions): void {
  registry[role] = actions;
}

export function unregisterSurfaceActions(role: SurfaceRole): void {
  delete registry[role];
}

export function getSurfaceActions(role: SurfaceRole): SurfaceActions | undefined {
  return registry[role];
}

/** True when `role` has a handler named `action` registered right now. */
export function hasSurfaceAction(role: SurfaceRole, action: string): boolean {
  return typeof registry[role]?.[action] === "function";
}

export function runSurfaceAction(role: SurfaceRole, action: string, id: string): void {
  registry[role]?.[action]?.(id);
}
