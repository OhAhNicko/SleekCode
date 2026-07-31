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

/** Black-or-white text for readable contrast on a full-color row. */
export function contrastTextFor(hex: string): string {
  const m = hex.replace("#", "");
  const full = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  // Perceived luminance (ITU-R BT.601).
  return (r * 299 + g * 587 + b * 114) / 1000 > 140 ? "#111417" : "#f5f6f7";
}
