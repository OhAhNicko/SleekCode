/**
 * Per-STATUS color: the rail's left stripe and its status badge, always the
 * same hue for the same status wherever it appears (Tickets tab, Assigned,
 * Unassigned, and the ticket pane header).
 *
 * Sibling to jira-colors.ts, which colors a TICKET by its key. The two are
 * deliberately separate axes: a ticket keeps its identity color for the life of
 * the investigation, while its status color changes as the ticket moves.
 *
 * WHY NOT A BARE HASH. jira-colors hashes straight into the palette and accepts
 * collisions, because two tickets sharing a color is a coincidence you notice
 * once. Statuses are different: a workflow has ~6 of them, all visible at once,
 * and with 11 presets a naive hash collides about 81% of the time — which
 * defeats the entire point of coloring by status. So `buildStatusColorMap`
 * walks the statuses in a stable order and LINEAR-PROBES forward past taken
 * slots. Collision-free up to 11 statuses, deterministic for a given set.
 *
 * THE TRADE: because probing depends on the set, adding a new status can shift
 * the colors of the ones it collided with (never all of them — only the
 * losers of that one slot). A workflow's status list is near-static, so this
 * costs a rare one-time reshuffle; pinning a color in Settings > Jira ("Status
 * colours: Manual") makes it permanent for anyone who cares.
 */
import { PROJECT_COLOR_PRESETS } from "../store/recentProjectsSlice";
import type { JiraStatusCategoryKey } from "../store/recentProjectsSlice";

/** Map key for a status name. Jira status names are free text with
 *  human-entered spacing and casing, so "In  progress" and "In Progress" must
 *  not become two different colors. */
export function normalizeStatus(name: string): string {
  return name.trim().replace(/\s+/g, " ").toUpperCase();
}

/** Same FNV-ish hash as jira-colors.ticketColor — kept identical so the two
 *  color axes at least feel like one system. */
function hashIndex(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % PROJECT_COLOR_PRESETS.length;
}

/**
 * Assign every status a distinct palette color where possible.
 *
 * Sorted first so the result depends only on the SET of statuses, never on the
 * order they happened to arrive from Jira — otherwise a row's color would
 * flicker as polls reorder the list.
 */
export function buildStatusColorMap(names: Iterable<string>): Map<string, string> {
  const unique = [...new Set([...names].map(normalizeStatus))].filter(Boolean).sort();
  const out = new Map<string, string>();
  const taken = new Set<number>();
  for (const name of unique) {
    const start = hashIndex(name);
    let slot = start;
    // Probe forward for a free preset; once every preset is taken, reuse is
    // unavoidable and the hash pick is as good as any.
    for (let step = 0; step < PROJECT_COLOR_PRESETS.length; step++) {
      const candidate = (start + step) % PROJECT_COLOR_PRESETS.length;
      if (!taken.has(candidate)) {
        slot = candidate;
        break;
      }
    }
    taken.add(slot);
    out.set(name, PROJECT_COLOR_PRESETS[slot].color);
  }
  return out;
}

/**
 * The color a status renders in. A manual override wins, but ONLY in manual
 * mode — flipping back to Auto must actually restore the automatic colors
 * rather than silently keeping whatever was pinned.
 */
export function resolveStatusColor(
  status: string,
  auto: Map<string, string>,
  mode: "auto" | "manual",
  overrides: Record<string, string> | undefined,
): string {
  const key = normalizeStatus(status);
  if (mode === "manual") {
    const pinned = overrides?.[key];
    if (pinned) return pinned;
  }
  return auto.get(key) ?? PROJECT_COLOR_PRESETS[hashIndex(key)].color;
}

/** Jira's coarse bucket, defaulting to "new" for a ticket polled before the
 *  field was fetched (an old snapshot) — the least misleading guess, since a
 *  ticket we are actively watching is far more likely open than done. */
export function statusCategoryOf(key: string | undefined): JiraStatusCategoryKey {
  return key === "done" || key === "indeterminate" || key === "new" ? key : "new";
}

/** Store-level mirror of useJiraTicketRows' `statusColorOf` for code that
 *  runs outside React (the notification emitter). It must land on the SAME
 *  hue the rail shows, and `buildStatusColorMap`'s probing depends on the
 *  full name set — so the inputs replicate the hook's exactly: the three
 *  queue lists plus every snapshot. Structurally typed to stay import-cycle
 *  free of the store. */
export function statusColorFromState(
  s: {
    jiraAssignedTickets?: Array<{ status?: string }> | null;
    jiraUnassignedTickets?: Array<{ status?: string }> | null;
    jiraAssignedDoneTickets?: Array<{ status?: string }> | null;
    jiraTicketSnapshots?: Record<string, { statusName?: string } | undefined> | null;
    jiraStatusColorMode?: "auto" | "manual" | null;
    jiraStatusColors?: Record<string, string> | null;
  },
  status: string,
): string {
  const names: string[] = [];
  for (const t of s.jiraAssignedTickets ?? []) if (t.status) names.push(t.status);
  for (const t of s.jiraUnassignedTickets ?? []) if (t.status) names.push(t.status);
  for (const t of s.jiraAssignedDoneTickets ?? []) if (t.status) names.push(t.status);
  for (const snap of Object.values(s.jiraTicketSnapshots ?? {})) {
    if (snap?.statusName) names.push(snap.statusName);
  }
  return resolveStatusColor(
    status,
    buildStatusColorMap(names),
    s.jiraStatusColorMode ?? "auto",
    s.jiraStatusColors ?? undefined,
  );
}

export const STATUS_CATEGORY_LABEL: Record<JiraStatusCategoryKey, string> = {
  new: "To do",
  indeterminate: "In progress",
  done: "Done",
};

/** Fixed display order for category groups — Jira's own board order. */
export const STATUS_CATEGORY_ORDER: JiraStatusCategoryKey[] = ["new", "indeterminate", "done"];
