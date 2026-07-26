import type {
  OverlayMenuItem,
  OverlayMenuPayload,
  OverlayMenuSection,
} from "../overlay-menu-model";
import { accelerator } from "../keybindings";
import type { MenuContext } from "./context";
import { GROUP_ORDER, type BuiltMenu, type MenuGroup, type MenuGroupId, type MenuItemSpec, type MenuPhase, type MenuProvider } from "./types";

const providers: MenuProvider[] = [];

/** Registered at module load. Import order decides nothing — `order` does. */
export function registerMenuProvider(p: MenuProvider): void {
  if (import.meta.env.DEV && providers.some((x) => x.id === p.id)) {
    console.warn(`[menu] duplicate provider id "${p.id}"`);
  }
  providers.push(p as MenuProvider);
}

/** Test/HMR seam. */
export function _resetMenuProviders(): void {
  providers.length = 0;
}

function toOverlayItem(spec: MenuItemSpec): OverlayMenuItem {
  const shortcut = spec.command ? accelerator(spec.command) : spec.shortcut;
  return {
    actionId: spec.id,
    label: spec.label,
    sublabel: spec.sublabel,
    // Empty string would render an empty accelerator column; omit instead.
    shortcut: shortcut || undefined,
    iconId: spec.iconId,
    checked: spec.checked,
    sticky: spec.sticky,
    swatch: spec.swatch,
    danger: spec.danger,
    badge: spec.badge,
    indent: spec.indent,
    disabled: !!spec.unavailable,
    disabledReason: spec.unavailable?.reason,
    trailing: spec.trailing
      ? { actionId: spec.trailing.id, iconId: spec.trailing.iconId, title: spec.trailing.title }
      : undefined,
  };
}

/**
 * Lower `submenu` into indented rows.
 *
 * Providers get to express the nesting they mean; the renderer decides how to
 * present it. If real flyouts ever arrive, only this function changes — no
 * provider is touched.
 */
function flatten(spec: MenuItemSpec, depth: number, out: MenuItemSpec[]): void {
  out.push(depth === 0 ? spec : { ...spec, indent: depth });
  if (spec.submenu) {
    for (const child of spec.submenu) flatten(child, depth + 1, out);
  }
}

/**
 * Build the menu for a context stack.
 *
 * Merge order is deterministic: by stack depth (innermost surface first), then
 * by provider `order`; groups bucket into the fixed GROUP_ORDER; duplicate item
 * ids resolve first-wins, so an inner surface can override an outer one's item
 * simply by emitting the same id.
 */
export function buildMenu(
  stack: readonly MenuContext[],
  phase: MenuPhase,
  opts?: { width?: number },
): BuiltMenu {
  type Entry = { group: MenuGroup; ctx: MenuContext; depth: number; order: number };
  const entries: Entry[] = [];

  stack.forEach((ctx, depth) => {
    const matching = providers
      .filter((p) => p.surface === ctx.kind)
      .sort((a, b) => a.order - b.order);
    for (const p of matching) {
      let groups: MenuGroup[] = [];
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        groups = p.build({ ctx: ctx as any, stack, phase }) ?? [];
      } catch (err) {
        // One bad provider must not blank the whole menu.
        if (import.meta.env.DEV) console.error(`[menu] provider "${p.id}" threw`, err);
        groups = [];
      }
      for (const group of groups) entries.push({ group, ctx, depth, order: p.order });
    }
  });

  entries.sort((a, b) => a.depth - b.depth || a.order - b.order);

  const runners = new Map<string, MenuItemSpec["run"]>();
  const contexts = new Map<string, MenuContext>();
  const seen = new Set<string>();
  const buckets = new Map<MenuGroupId, { title?: string; items: OverlayMenuItem[]; swatches: NonNullable<OverlayMenuSection["swatches"]> }>();

  for (const { group, ctx } of entries) {
    let bucket = buckets.get(group.id);
    if (!bucket) {
      bucket = { title: group.title, items: [], swatches: [] };
      buckets.set(group.id, bucket);
    }
    if (!bucket.title && group.title) bucket.title = group.title;

    const flat: MenuItemSpec[] = [];
    for (const spec of group.items) flatten(spec, 0, flat);

    for (const spec of flat) {
      if (seen.has(spec.id)) continue; // innermost surface already claimed it
      seen.add(spec.id);
      bucket.items.push(toOverlayItem(spec));
      runners.set(spec.id, spec.run);
      contexts.set(spec.id, ctx);
    }

    for (const sw of group.swatches ?? []) {
      if (seen.has(sw.id)) continue;
      seen.add(sw.id);
      bucket.swatches.push({ actionId: sw.id, color: sw.color, label: sw.label, selected: sw.selected });
      runners.set(sw.id, sw.run);
      contexts.set(sw.id, ctx);
    }
  }

  const sections: OverlayMenuSection[] = [];
  for (const id of GROUP_ORDER) {
    const b = buckets.get(id);
    if (!b) continue;
    if (b.items.length === 0 && b.swatches.length === 0) continue;
    sections.push({
      title: b.title,
      items: b.items,
      swatches: b.swatches.length > 0 ? b.swatches : undefined,
    });
  }

  if (import.meta.env.DEV) {
    for (const s of sections) {
      if (s.items.length > 0 && s.items.every((i) => i.disabled)) {
        console.warn(
          `[menu] every item in section "${s.title ?? "(untitled)"}" is disabled — should the whole group be hidden?`,
        );
      }
    }
  }

  const payload: OverlayMenuPayload = {
    sections,
    placement: "cursor",
    width: opts?.width,
  };

  if (import.meta.env.DEV) {
    try {
      JSON.stringify(payload);
    } catch {
      console.error("[menu] payload is not JSON-safe — a closure or DOM node leaked into it");
    }
  }

  return { payload, runners, contexts };
}

/**
 * DEV guard for anyone who reintroduces in-place patching of an OPEN menu.
 *
 * Currently unused BY DESIGN: nothing patches a live menu any more, because
 * doing so is what made it resize. Kept because the moment someone adds an
 * async pass back, this is the check that catches the regression.
 *
 * The rule: an in-place patch must not change the menu's SIZE. A menu that grows under a hovering cursor is a mis-click generator.
 *
 * The signature covers item order AND whether each row has a sublabel, because
 * a sublabel is a second line — adding one grows the row and therefore the
 * whole menu. That is not hypothetical: "Copy git branch" shipped with the
 * branch name as a sublabel, so the menu visibly resized ~½ second after
 * opening, once the git lookup landed. An id-only check missed it.
 *
 * Genuinely safe to change: `unavailable`, `checked`, `badge` — all of which
 * repaint within the existing row box.
 */
export function assertSameLayout(a: OverlayMenuPayload, b: OverlayMenuPayload): void {
  if (!import.meta.env.DEV) return;
  const sig = (p: OverlayMenuPayload) =>
    p.sections
      .flatMap((s) => [
        ...s.items.map((i) => `${i.actionId}${i.sublabel ? ":sub" : ""}`),
        ...(s.swatches ?? []).map((w) => w.actionId),
      ])
      .join("|");
  if (sig(a) !== sig(b)) {
    console.error(
      "[menu] enrichment changed the menu's size — only unavailable/checked/badge may change",
      { sync: sig(a), enriched: sig(b) },
    );
  }
}
