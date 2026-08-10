/**
 * The facts attached to a ticket row, split across its two lines.
 *
 * TITLE line (with the ticket key): a short, right-aligned run sitting just
 * before the status badge. Space is scarce there, so these render as bare
 * values and lean on their tooltip for meaning — "2h ago", not "upd 2h ago".
 * `updated` lives here by default: when a ticket last moved is the fact you
 * scan for, and it belongs beside the key rather than a line below it.
 *
 * DETAILS line: fixed-width cells in a fixed order, so the same fact sits at
 * the same x on every row and the list reads down a column. Only the last cell
 * is flexible and allowed to ellipse.
 *
 * Which facts appear at all is `jiraRowMetaShow`; which of those ride the title
 * line is `jiraRowTitleFields`. Cell ids are the SAME keys those settings use,
 * so there is no mapping table to drift.
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

export interface JiraRowCells {
  /** Rides the ticket-key line, right-aligned before the status badge. */
  title: JiraMetaCell[];
  /** The details line under it. */
  meta: JiraMetaCell[];
}

export function buildRowCells(
  facts: JiraRowMetaFacts,
  show: JiraRowMetaShow,
  titleFields: string[] = [],
  extraIds: string[] = [],
  labelFor: (id: string) => string = (id) => id,
): JiraRowCells {
  const onTitle = new Set(titleFields);
  const all: JiraMetaCell[] = [];

  // Organization leads the details line: in a support queue "which customer"
  // is what the eye hunts for, and the leading cell never ellipses.
  if (show.organization && facts.organization) {
    all.push({ id: "organization", text: facts.organization, width: 110, tooltip: "Organization" });
  }
  if (show.requestType && facts.requestType) {
    all.push({ id: "requestType", text: facts.requestType, width: 110, tooltip: "Request type" });
  }

  const updated = show.updated ? relativeShortIso(facts.updatedIso) : "";
  const created = show.created ? relativeShortIso(facts.createdIso) : "";
  if (updated) {
    all.push({ id: "updated", text: updated, width: W_TIME, tooltip: "Last updated" });
  }
  if (created) {
    // Two bare relative times on ONE line are indistinguishable, so the
    // created one keeps a word — but only when it actually shares a line with
    // `updated`. Alone (or once `updated` has moved to the title), it is bare
    // like everything else and the tooltip carries the meaning.
    const shareALine = !!updated && onTitle.has("updated") === onTitle.has("created");
    all.push({
      id: "created",
      text: shareALine ? `sent ${created}` : created,
      width: W_TIME,
      tooltip: "Created",
    });
  }
  if (show.priority && facts.priorityName) {
    all.push({ id: "priority", text: facts.priorityName, width: W_PRIORITY, tooltip: "Priority" });
  }
  if (show.reporter && facts.reporterName) {
    all.push({ id: "reporter", text: facts.reporterName, width: 110, tooltip: "Reporter" });
  }
  for (const id of extraIds) {
    const text = facts.extra?.[id];
    if (text) all.push({ id, text, width: 110, tooltip: labelFor(id) });
  }
  // The site is a details-line fact only — it is context, never identity.
  if (facts.siteName) all.push({ id: "site", text: facts.siteName });

  const title = all.filter((c) => onTitle.has(c.id)).map((c) => ({ ...c, width: undefined }));
  const meta = all.filter((c) => !onTitle.has(c.id));
  // The LAST details cell gives up its fixed width and takes the remainder, so
  // a row never ends in a hard gap and the flexible one is always the same
  // column.
  if (meta.length > 0) meta[meta.length - 1] = { ...meta[meta.length - 1], width: undefined };
  return { title, meta };
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

/**
 * The title line's fact run. Sits between the ticket key and the status badge.
 *
 * SHRINKS FIRST, deliberately: the key carries `flexShrink: 0` and the badge a
 * fixed width, so this run is what gives when the rail narrows. That keeps both
 * invariants intact — the key is never truncated and the badge column stays on
 * one x down the whole list.
 */
export function JiraTitleFacts({
  cells,
  fontPx = 10,
  muted = true,
}: {
  cells: JiraMetaCell[];
  fontPx?: number;
  muted?: boolean;
}) {
  if (cells.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        flex: "0 1 auto",
        minWidth: 0,
        overflow: "hidden",
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
