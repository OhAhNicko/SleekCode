/**
 * Per-ticket color: a stable, deterministic pick from the shared project
 * palette, hashed off the ticket key — no storage, same color every session.
 * Shown as the ticket row's left edge and used to tint the ticket's Claude
 * pane, mirroring the per-project pane tint for ordinary tabs.
 */
import {
  PROJECT_COLOR_PRESETS,
  getProjectColor,
  type ProjectColorId,
} from "../store/recentProjectsSlice";

export function ticketColor(ticket: string): string {
  let h = 0;
  for (let i = 0; i < ticket.length; i++) h = (h * 31 + ticket.charCodeAt(i)) >>> 0;
  return PROJECT_COLOR_PRESETS[h % PROJECT_COLOR_PRESETS.length].color;
}

/** Override from the row's context menu wins; else the stable hash pick. */
export function resolveTicketColor(
  ticket: string,
  overrides?: Record<string, ProjectColorId>,
): string {
  const id = overrides?.[ticket];
  if (id) {
    const c = getProjectColor(id);
    if (c) return c;
  }
  return ticketColor(ticket);
}

function rgbOf(hex: string): [number, number, number] {
  const m = hex.replace("#", "");
  const full = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  return [
    parseInt(full.slice(0, 2), 16) || 0,
    parseInt(full.slice(2, 4), 16) || 0,
    parseInt(full.slice(4, 6), 16) || 0,
  ];
}

/** Black-or-white text for readable contrast on a full-color row. */
export function contrastTextFor(hex: string): string {
  const [r, g, b] = rgbOf(hex);
  // Perceived luminance (ITU-R BT.601).
  return (r * 299 + g * 587 + b * 114) / 1000 > 140 ? "#111417" : "#f5f6f7";
}

/**
 * Black-or-white ink for a small, BOLD label on a solid color fill — status
 * badges. Whichever ink wins the actual WCAG contrast ratio.
 *
 * Separate from `contrastTextFor`, which is a BT.601 brightness heuristic with
 * a 140 threshold. That heuristic picks the WRONG ink for four of the eleven
 * palette presets (red, green, purple and pink all land at 3.2–4.0:1 against
 * white, under AA, while black would clear 5:1) — tolerable on a full-width
 * row of 12px text, not on a 9px/600 badge.
 *
 * `contrastTextFor` is deliberately left alone: it governs the existing
 * full-color ticket rows, and flipping four colors' text there is a visible
 * regression nobody asked for.
 */
export function badgeInkFor(hex: string): string {
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = rgbOf(hex).map((v) => lin(v / 255));
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const vsDark = (L + 0.05) / 0.05; // ink #000-ish
  const vsLight = 1.05 / (L + 0.05); // ink #fff-ish
  return vsDark > vsLight ? "#111417" : "#f5f6f7";
}
