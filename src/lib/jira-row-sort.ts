/**
 * Sorting and grouping for the ticket rail's Assigned / Unassigned lists.
 *
 * The AUTHORITATIVE sort happens server-side, in the JQL (see the Rust
 * `order_clause`): the result page is capped at 50 rows, so sorting only in JS
 * would reorder the wrong 50 — "oldest first" would show the oldest of the
 * newest fifty. What lives here is the matching presentation-side sort, so the
 * list reorders the instant the control is used instead of waiting for a poll.
 */
import type {
  JiraListTicket,
  JiraSortDir,
  JiraSortKey,
  JiraStatusCategoryKey,
} from "../store/recentProjectsSlice";
import { STATUS_CATEGORY_LABEL, STATUS_CATEGORY_ORDER, statusCategoryOf } from "./jira-status-colors";

export const JIRA_SORT_KEYS: JiraSortKey[] = [
  "updated",
  "created",
  "priority",
  "status",
  "key",
  "summary",
];

export const JIRA_SORT_LABEL: Record<JiraSortKey, string> = {
  updated: "Last updated",
  created: "Created",
  priority: "Priority",
  status: "Status",
  key: "Ticket key",
  summary: "Summary",
};

/**
 * Rank a priority, lowest number = most urgent.
 *
 * `siteOrder` — Jira's OWN priority order, from /rest/api/3/priority, cached
 * per site — is the authority and wins whenever it is present.
 *
 * The rest is the fallback for a site that denies that endpoint. Jira's SEARCH
 * response carries no rank at all: just a name and an id, and the id is only
 * 1..5 highest→lowest on the DEFAULT scheme — a custom scheme numbers them
 * arbitrarily. So well-known names win first, the numeric id is a tiebreak,
 * and anything unrecognised sorts last rather than faking a position.
 */
const PRIORITY_RANK: Record<string, number> = {
  HIGHEST: 0,
  BLOCKER: 0,
  CRITICAL: 1,
  HIGH: 1,
  MAJOR: 1,
  MEDIUM: 2,
  NORMAL: 2,
  LOW: 3,
  MINOR: 3,
  LOWEST: 4,
  TRIVIAL: 4,
};

/**
 * Display bucket for the ticket rows' priority chip. NAME table only — the
 * site order and id fallback exist for SORTING, where every row must land
 * somewhere; a chip that guessed from them would paint "Standard" red on one
 * site and neutral on another. "default" (Medium/Normal) is what the rows
 * hide: on a support queue it is nearly every ticket, and repeating it is
 * what buries the exceptional ones.
 */
export function priorityBucket(name: string): "urgent" | "default" | "low" | "unknown" {
  const rank = PRIORITY_RANK[name.trim().toUpperCase()];
  if (rank === undefined) return "unknown";
  if (rank <= 1) return "urgent";
  if (rank === 2) return "default";
  return "low";
}

export function priorityRank(name?: string, id?: string, siteOrder?: string[]): number {
  // The site's OWN order wins whenever we have it — that is Jira's ranking,
  // not an inference from the label.
  if (name && siteOrder && siteOrder.length > 0) {
    const i = siteOrder.findIndex((p) => p.toLowerCase() === name.trim().toLowerCase());
    if (i >= 0) return i;
  }
  if (name) {
    const known = PRIORITY_RANK[name.trim().toUpperCase()];
    if (known !== undefined) return known;
  }
  const numeric = id ? Number(id) : NaN;
  if (Number.isFinite(numeric)) return 10 + numeric;
  return Number.MAX_SAFE_INTEGER;
}

/** Missing values always sort LAST, in both directions. A row whose `created`
 *  predates the field being fetched should sit out of the way, not win the
 *  "oldest" slot on the strength of an empty string. */
function cmpMaybe(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? -1 : 1;
}

export function compareIssues(
  a: JiraListTicket,
  b: JiraListTicket,
  key: JiraSortKey,
  dir: JiraSortDir,
  siteOrder?: string[],
): number {
  let base = 0;
  switch (key) {
    case "updated":
      base = cmpMaybe(a.updatedIso, b.updatedIso);
      break;
    case "created":
      base = cmpMaybe(a.createdIso, b.createdIso);
      break;
    case "priority": {
      const ra = priorityRank(a.priorityName, a.priorityId, siteOrder);
      const rb = priorityRank(b.priorityName, b.priorityId, siteOrder);
      // Rank ascending IS "most urgent first", so invert: a "descending"
      // priority sort must put Highest on top, the way every issue tracker
      // behaves. Without this, "desc" would surface Lowest.
      base = ra === rb ? 0 : ra < rb ? 1 : -1;
      break;
    }
    case "status":
      base = a.status.localeCompare(b.status);
      break;
    case "summary":
      base = (a.summary || "").localeCompare(b.summary || "");
      break;
    case "key":
      base = a.key.localeCompare(b.key, undefined, { numeric: true });
      break;
  }
  // Stable tiebreak so equal rows never swap between renders.
  if (base === 0) base = a.key.localeCompare(b.key, undefined, { numeric: true });
  return dir === "asc" ? base : -base;
}

export function sortIssues(
  rows: JiraListTicket[],
  key: JiraSortKey,
  dir: JiraSortDir,
  siteOrder?: string[],
): JiraListTicket[] {
  return [...rows].sort((a, b) => compareIssues(a, b, key, dir, siteOrder));
}

export interface JiraRowGroup {
  /** Stable fold key. Namespaced by mode so a status literally named "DONE"
   *  can never share an id with the Done category. */
  id: string;
  label: string;
  /** Status color for the header square; null for categories, which are not a
   *  status and so have no color of their own. */
  status: string | null;
  rows: JiraListTicket[];
}

/**
 * Bucket rows for the collapsible-group modes. "flat" returns a single unnamed
 * group so callers have one shape to render either way.
 *
 * Group ORDER follows the rows' existing sort (first appearance wins) for
 * status mode, and Jira's own board order for category mode — a category list
 * that reshuffled as tickets moved would be unreadable.
 */
export function groupIssues(
  rows: JiraListTicket[],
  mode: "flat" | "status" | "category",
): JiraRowGroup[] {
  if (mode === "flat") return [{ id: "", label: "", status: null, rows }];

  if (mode === "category") {
    const buckets = new Map<JiraStatusCategoryKey, JiraListTicket[]>();
    for (const r of rows) {
      const cat = statusCategoryOf(r.statusCategory);
      const list = buckets.get(cat);
      if (list) list.push(r);
      else buckets.set(cat, [r]);
    }
    return STATUS_CATEGORY_ORDER.filter((c) => buckets.has(c)).map((c) => ({
      id: `cat:${c}`,
      label: STATUS_CATEGORY_LABEL[c],
      status: null,
      rows: buckets.get(c) ?? [],
    }));
  }

  const buckets = new Map<string, JiraListTicket[]>();
  for (const r of rows) {
    const name = r.status || "No status";
    const list = buckets.get(name);
    if (list) list.push(r);
    else buckets.set(name, [r]);
  }
  return [...buckets.entries()].map(([name, list]) => ({
    id: `status:${name}`,
    label: name,
    status: name,
    rows: list,
  }));
}
