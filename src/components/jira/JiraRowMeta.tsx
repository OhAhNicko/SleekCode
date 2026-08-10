/**
 * The muted line(s) under a ticket row: which customer, how it came in, when it
 * moved, when it was sent, how urgent, who filed it — plus any extra Jira field
 * the user added in Settings.
 *
 * COLUMNS, NOT A SENTENCE. Every enabled fact gets a fixed-width cell in a
 * fixed order, so the same fact sits at the same x on every row and the list
 * can be read down a column instead of parsed per row. The last cell is the
 * flexible one and is the only thing allowed to ellipse; line 1 (key + status
 * badge) stays whole no matter what.
 *
 * "sent 3d ago" rather than "created 3d ago": for a support queue the useful
 * question is when the customer sent the ticket in, and `sent` is both shorter
 * and closer to how the work is actually talked about.
 */
import type { JiraRowMetaShow } from "../../store/recentProjectsSlice";
import { relativeShortIso } from "../../lib/relative-time";

export interface JiraMetaCell {
  id: string;
  text: string;
  /** Fixed cell width in px. Omitted = takes the remaining room and ellipses. */
  width?: number;
  tooltip?: string;
}

export interface JiraRowMetaFacts {
  updatedIso?: string;
  createdIso?: string;
  priorityName?: string;
  reporterName?: string;
  /** JSM Organizations — the customer company that raised the ticket. */
  organization?: string;
  /** JSM Request type — which request form/platform it came in on. */
  requestType?: string;
  /** User-picked extra fields, keyed by Jira field id. */
  extra?: Record<string, string>;
  /** Only rendered when more than one Jira site is configured — otherwise it
   *  is the same word on every row. */
  siteName?: string;
}

/** Relative times are `tabular-nums`, so a fixed cell never twitches as the
 *  digits change; these widths hold "12mo ago" at font-scale 1. */
const W_TIME = 74;
const W_PRIORITY = 56;

export function buildRowMeta(
  facts: JiraRowMetaFacts,
  show: JiraRowMetaShow,
  extraIds: string[] = [],
  labelFor: (id: string) => string = (id) => id,
): JiraMetaCell[] {
  const cells: JiraMetaCell[] = [];
  // Organization leads: in a support queue "which customer" is what the eye is
  // actually hunting for, and the leading cell is the one that never ellipses.
  if (show.organization && facts.organization) {
    cells.push({ id: "org", text: facts.organization, width: 110, tooltip: "Organization" });
  }
  if (show.requestType && facts.requestType) {
    cells.push({ id: "req", text: facts.requestType, width: 110, tooltip: "Request type" });
  }
  if (show.updated) {
    const t = relativeShortIso(facts.updatedIso);
    if (t) cells.push({ id: "upd", text: `upd ${t}`, width: W_TIME, tooltip: "Last updated" });
  }
  if (show.created) {
    const t = relativeShortIso(facts.createdIso);
    if (t) cells.push({ id: "sent", text: `sent ${t}`, width: W_TIME, tooltip: "Created" });
  }
  if (show.priority && facts.priorityName) {
    cells.push({ id: "pri", text: facts.priorityName, width: W_PRIORITY, tooltip: "Priority" });
  }
  if (show.reporter && facts.reporterName) {
    cells.push({ id: "rep", text: facts.reporterName, width: 110, tooltip: "Reporter" });
  }
  for (const id of extraIds) {
    const text = facts.extra?.[id];
    if (text) cells.push({ id, text, width: 110, tooltip: labelFor(id) });
  }
  if (facts.siteName) cells.push({ id: "site", text: facts.siteName });
  // The LAST cell gives up its fixed width and takes the remainder, so a row
  // never ends in a hard gap and the flexible one is always the same column.
  if (cells.length > 0) cells[cells.length - 1] = { ...cells[cells.length - 1], width: undefined };
  return cells;
}

export default function JiraRowMeta({
  cells,
  fontPx = 10,
  muted = true,
}: {
  cells: JiraMetaCell[];
  fontPx?: number;
  /** Full-color rows already have a colored ground; a muted token would fight
   *  it, so those pass `muted={false}` and lean on opacity instead. */
  muted?: boolean;
}) {
  if (cells.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        minWidth: 0,
        fontSize: `calc(var(--ezy-font-scale, 1) * ${fontPx}px)`,
        fontVariantNumeric: "tabular-nums",
        color: muted ? "var(--ezy-text-muted)" : undefined,
        opacity: muted ? 1 : 0.75,
      }}
    >
      {cells.map((c) => (
        <span
          key={c.id}
          data-tooltip={c.tooltip}
          style={{
            width: c.width,
            // A fixed cell must not be squeezed by its neighbours or the
            // column stops being a column.
            flex: c.width === undefined ? "1 1 auto" : "0 0 auto",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {c.text}
        </span>
      ))}
    </div>
  );
}
