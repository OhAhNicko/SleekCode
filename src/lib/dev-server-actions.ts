/**
 * Start / restart for ONE dev server, published by `DevServerTerminalHost`.
 *
 * The host is the only place that can do either correctly: it owns the PTY
 * panes AND the detection refs (`resolvedRef`, `portDetectedRef`,
 * `stoppedMonitorRef`, the scan buffers, the grace timers). Those refs must be
 * cleared SYNCHRONOUSLY, before the store update that triggers the re-render —
 * a ref mutation doesn't re-render, so a later effect clearing them is too late
 * and the main effect has already skipped registering a port-detection listener
 * (docs/learnings/2026-03-09-devserver-stopped-detection.md, "Bug 2").
 *
 * The sidebar row (`DevServerTab`) reimplemented start/restart with a bare
 * `getPtyWrite(...)` and no way to reach those refs, so its buttons ran the
 * command and then parked the row on "detecting…" forever. Hence a registry
 * rather than a second implementation: one owner, and every surface — sidebar
 * buttons, the expanded panel's header, the row context menu, the port-edit
 * restart — calls the same function.
 *
 * A registry and not a `made:*` CustomEvent, for the reason spelled out in
 * `terminal-actions.ts`: an event with no listener fails silently, a missing
 * registration here makes the caller's `?.()` a visible no-op instead of a fake
 * "starting" the server never leaves.
 */
export interface DevServerActions {
  /** Run the command. Respawns the pane's terminal first if the PTY is gone. */
  start(): void;
  /** ^C the running process and re-run the command, or respawn if the PTY is gone. */
  restart(): void;
}

const registry: Record<string, DevServerActions> = {};

export function registerDevServerActions(devServerId: string, actions: DevServerActions): void {
  registry[devServerId] = actions;
}

export function unregisterDevServerActions(devServerId: string): void {
  delete registry[devServerId];
}

export function getDevServerActions(devServerId: string): DevServerActions | undefined {
  return registry[devServerId];
}
