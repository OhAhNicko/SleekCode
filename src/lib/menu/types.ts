import type { OverlayMenuItem, OverlayMenuPayload } from "../overlay-menu-model";
import type { CommandId } from "../keybindings";
import type { MenuContext, SurfaceKind } from "./context";

/**
 * Canonical section order. Every provider's groups land in one of these
 * buckets, so "edit" is always at the top and "app" always at the bottom no
 * matter which providers contributed — a menu's shape stays predictable even
 * when several surfaces stack (a composer inside a pane inside the app).
 */
export const GROUP_ORDER = [
  "edit", // cut / copy / paste
  "selection", // things that act on what's selected
  "target", // things that act on the clicked object itself
  "block", // command-block scoped actions
  "pane", // pane lifecycle
  "layout", // splits, float, expand
  "view", // toggles, scroll, zoom
  "sound", // per-project notification sound
  "app", // app-wide fallbacks
] as const;

export type MenuGroupId = (typeof GROUP_ORDER)[number];

export type MenuItemSpec = {
  /** Namespaced and globally unique: "<surface>.<verb>". The dedupe key. */
  id: string;
  label: string;
  sublabel?: string;
  /** Key into CTX_ICONS. */
  iconId?: string;
  /**
   * Preferred accelerator source — the engine resolves the display string from
   * the keybinding table. Never hardcode a shortcut: a menu that prints a
   * chord which does something else is worse than one that prints none.
   */
  command?: CommandId;
  /** Escape hatch for non-keyboard accelerators ("Middle-click"). */
  shortcut?: string;
  checked?: boolean;
  danger?: boolean;
  badge?: string;
  swatch?: string;
  sticky?: boolean;
  indent?: number;
  trailing?: { id: string; iconId: string; title?: string };
  /**
   * Disabled + WHY. Absent => enabled.
   *
   * This is the only way to express "belongs on this surface but is not
   * available right now". `reason` is required by the type, so an unexplained
   * greyed row cannot be shipped by accident.
   *
   * The other half of the policy is structural: an item that can NEVER apply to
   * the clicked target is simply not returned, and cannot be, because a
   * provider only runs when its own surface is in the context stack.
   */
  unavailable?: { reason: string };
  /** Nested items. Lowered to an inline expander — the overlay has no flyouts. */
  submenu?: MenuItemSpec[];
  /** Runs in the MAIN webview. Never serialized, never crosses the bridge. */
  run: (ctx: MenuContext, data?: { ctrl: boolean }) => void;
};

export type MenuGroup = {
  id: MenuGroupId;
  /** Section header, uppercased by the renderer. */
  title?: string;
  items: MenuItemSpec[];
  /** Colour grid instead of rows (tab colours). */
  swatches?: { id: string; color: string | null; label: string; selected?: boolean; run: (ctx: MenuContext) => void }[];
};

export type MenuPhase = "sync" | "enriched";

export type MenuProviderArgs<C extends MenuContext> = {
  /** The context this provider matched. */
  ctx: C;
  /** Full stack, innermost -> outermost, always ending in the app context. */
  stack: readonly MenuContext[];
  phase: MenuPhase;
};

export type MenuProvider<K extends SurfaceKind = SurfaceKind> = {
  /** Unique; used in DEV diagnostics. */
  id: string;
  surface: K;
  /** Tie-break within the same stack depth. Lower first. */
  order: number;
  /**
   * Return ONLY applicable items.
   *   HIDE    => don't return the item at all.
   *   DISABLE => return it with `unavailable: { reason }`.
   * Returning [] is legal: "this surface contributes nothing here".
   */
  build(args: MenuProviderArgs<Extract<MenuContext, { kind: K }>>): MenuGroup[];
};

export type BuiltMenu = {
  payload: OverlayMenuPayload;
  /** actionId -> closure. Stays main-side. */
  runners: Map<string, (ctx: MenuContext, data?: { ctrl: boolean }) => void>;
  /** The context each runner should receive. */
  contexts: Map<string, MenuContext>;
};

export type { OverlayMenuItem };
