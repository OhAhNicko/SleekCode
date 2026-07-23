// Shared display model for GENERIC anchored dropdown menus rendered by the
// overlay webview (kind "anchored-menu" in OverlayRoot). Same contract as the
// right-click context menu: the MAIN webview owns the action closures and
// emits this JSON-safe model; the overlay renders it and bounces the chosen
// `actionId` back over `overlay:action`. Icons come from CTX_ICONS in
// context-menu-model.tsx (shared JSX, bundled into both webviews).

export type OverlayMenuItem = {
  actionId: string;
  label: string;
  /** Dim second line under the label (e.g. a project path). */
  sublabel?: string;
  /** Right-aligned dim hint (keyboard shortcut / meta text). */
  shortcut?: string;
  /** Key into CTX_ICONS. */
  iconId?: string;
  /** Leading checkmark (pickers: current session / terminal type). */
  checked?: boolean;
  /** Small leading color square (tab color menus etc.). */
  swatch?: string;
  /** Render red (destructive actions). */
  danger?: boolean;
  disabled?: boolean;
  /** Solid red trailing badge text (e.g. "YOLO"). */
  badge?: string;
  /** Trailing secondary icon-button with its own action (e.g. split-down). */
  trailing?: { actionId: string; iconId: string; title?: string };
};

export type OverlayMenuSection = {
  /** Optional non-interactive section header. */
  title?: string;
  items: OverlayMenuItem[];
};

export type OverlayMenuPlacement =
  | "below-start" // menu's left edge = anchor's left edge, below it
  | "below-end" //   menu's right edge = anchor's right edge, below it
  | "above-start"
  | "above-end";

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
