// Shared display model for GENERIC anchored dropdown menus rendered by the
// overlay webview (kind "anchored-menu" in OverlayRoot). Same contract as the
// right-click context menu: the MAIN webview owns the action closures and
// emits this JSON-safe model; the overlay renders it and bounces the chosen
// `actionId` back over `overlay:action`. Icons come from CTX_ICONS in
// menu-icons.tsx (shared JSX, bundled into both webviews).

export type OverlayMenuItem = {
  actionId: string;
  label: string;
  /**
   * Dim second line under the label (e.g. a project path).
   *
   * ADDS A ROW OF HEIGHT. Decide it at build time — introducing one from an
   * async pass resizes an already-open menu under the user's pointer.
   */
  sublabel?: string;
  /** Right-aligned dim hint (keyboard shortcut / meta text). */
  shortcut?: string;
  /** Key into CTX_ICONS. */
  iconId?: string;
  /** Leading checkmark (pickers: current session / terminal type). */
  checked?: boolean;
  /**
   * STICKY row: picking it does NOT close the menu. The action still bounces
   * to the main webview, which updates the payload in place (e.g. flipping
   * `checked`) — the open menu just re-renders with the new state.
   *
   * Use for toggles that the user may want to flip and then keep using the
   * menu (the "Native renderer (beta)" mode row in the Add-pane dropdown).
   * Without this, a toggle click ran the normal close path — overlay drops
   * the popup, the window hides, and the app blinks while the user has to
   * reopen the menu just to see the checkmark.
   */
  sticky?: boolean;
  /** Small leading color square (tab color menus etc.). */
  swatch?: string;
  /** Render red (destructive actions). */
  danger?: boolean;
  disabled?: boolean;
  /**
   * Why this row is disabled, shown as a tooltip on hover.
   *
   * A greyed row with no explanation reads as a broken app — the user cannot
   * tell "not applicable here" from "this feature is busted". Context-menu
   * providers are required to supply a reason whenever they disable an item;
   * this is where it surfaces. Rendered through the overlay's own tip host,
   * never `title=` (that draws OS chrome the rest of the app has dropped).
   */
  disabledReason?: string;
  /**
   * Nesting depth for inline expanders. 0/undefined = flush with the section.
   *
   * The overlay has no flyout submenus — its popup registry is flat and each
   * popup needs a keepalive from the main webview, which would not know a
   * submenu had opened. A `sticky` parent row that reveals indented children
   * gets the same job done with no new machinery.
   */
  indent?: number;
  /** Solid red trailing badge text (e.g. "YOLO"). */
  badge?: string;
  /** Trailing secondary icon-button with its own action (e.g. split-down). */
  trailing?: { actionId: string; iconId: string; title?: string };
};

export type OverlayMenuSection = {
  /** Optional non-interactive section header. */
  title?: string;
  items: OverlayMenuItem[];
  /**
   * Render this section as a swatch grid instead of a list of rows.
   *
   * Lets a colour picker be the last section OF a menu rather than a separate
   * popup — the tab menu shows its actions and its project colours in one
   * surface, instead of the old dedicated "swatch-menu" kind.
   */
  swatches?: { actionId: string; color: string | null; label: string; selected?: boolean }[];
};

export type OverlayMenuPlacement =
  | "below-start" // menu's left edge = anchor's left edge, below it
  | "below-end" //   menu's right edge = anchor's right edge, below it
  | "above-start"
  | "above-end"
  /**
   * Corner AT the cursor, the native right-click convention. Differs from
   * "below-start" in two ways that matter: no gap (the menu touches the
   * pointer), and on right-edge overflow it MIRRORS to the left of the cursor
   * rather than sliding along the viewport edge — sliding would drop the menu
   * under the pointer and arm an instant mis-click.
   */
  | "cursor";

export type OverlayMenuPayload = {
  sections: OverlayMenuSection[];
  placement: OverlayMenuPlacement;
  /** Fixed width px. Omitted => min-width 200, intrinsic. */
  width?: number;
  /** Gap between anchor and menu, default 4. */
  gap?: number;
  /** Max height px before the item list scrolls. */
  maxHeight?: number;
};
