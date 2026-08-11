/**
 * The facts attached to a ticket row, split across its two lines.
 *
 * TITLE line (with the ticket key): a short, right-aligned run sitting just
 * before the status badge. Space is scarce there, so these render as bare
 * values and lean on their tooltip for meaning — "2h ago", not "upd 2h ago".
 * `updated` lives here by default: when a ticket last moved is the fact you
 * scan for, and it belongs beside the key rather than a line below it.
 *
 * DETAILS line: two clusters mirroring the title line's structure, so the
 * whole row reads down clean vertical edges.
 *
 *   LEFT, "who":  request type / organization / reporter (then extras, site)
 *                 as true COLUMNS: fixed flex-basis cells in a fixed order,
 *                 and an enabled fact the row lacks still RESERVES its cell —
 *                 that reservation is what the first design got wrong; cells
 *                 that only existed when filled drifted every column after
 *                 them. Bases shrink proportionally, so the columns stay on
 *                 one x down the list at any rail width.
 *   RIGHT, "when": priority chip + times, right-aligned so the same fact
 *                 lands on the same right edge on every row — the badge's
 *                 column, continued one line down.
 *
 * Priority only appears when it is EXCEPTIONAL: Medium/Normal is nearly every
 * ticket on a support queue, and repeating it is what buried the urgent ones.
 * `created` always reads "sent 4d ago" — two bare relative times on one row
 * are indistinguishable, and "sent" is the register a support queue uses.
 *
 * Which facts appear at all is `jiraRowMetaShow`; which of those ride the title
 * line is `jiraRowTitleFields`. Cell ids are the SAME keys those settings use,
 * so there is no mapping table to drift.
 */
import type { JiraRowMetaShow } from "../../store/recentProjectsSlice";
import { relativeShortIso } from "../../lib/relative-time";
import { priorityBucket } from "../../lib/jira-row-sort";
import { badgeInkFor } from "../../lib/jira-colors";
import { getTheme } from "../../lib/themes";
import { useAppStore } from "../../store";

export interface JiraMetaCell {
  id: string;
  /** Empty string = a reserved column the row has no value for. The cell
   *  still takes its width so the columns after it don't move. */
  text: string;
  tooltip?: string;
  /** Flex BASIS of the cell's column, in px. Omitted = the flexible last
   *  column. Shrinkable — proportional shrink keeps columns aligned across
   *  rows because every row shares the same bases. */
  width?: number;
  /** Render as a solid chip instead of bare text (priority). "urgent" takes
   *  the theme's red; "low" the neutral border fill. There is no "default"
   *  chip — default priority is omitted at build time. */
  chip?: "urgent" | "low";
  /** Bold. `updated` carries it: "what moved" is the fact the list is scanned
   *  by, and at 10px muted it drowned next to the status badge. */
  strong?: boolean;
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
  /** The status NAME, for rows too narrow to carry the status badge (the
   *  vertical tree's degraded mode). Leads the right cluster: it is state,
   *  not identity, and the right cluster's flexShrink:0 keeps it visible
   *  where the left phrase would have ellipsed it away. */
  statusText?: string;
}

/** Column basis for the "who" cells. One shared number: equal bases shrink
 *  equally, which is what keeps the columns aligned across rows when the rail
 *  narrows. Holds a typical org / request-type name at font-scale 1. */
const W_WHO = 110;

/** " — 2026-08-11 14:31"-style suffix for the time tooltips: the row shows
 *  the relative register, the hover answers "when exactly", in the user's
 *  own locale. Empty (not "Invalid Date") when the ISO is missing or bad. */
function exactTime(iso?: string): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "" : ` — ${new Date(ms).toLocaleString()}`;
}

export interface JiraRowCells {
  /** Rides the ticket-key line, right-aligned before the status badge. */
  title: JiraMetaCell[];
  /** Details line, left cluster — "who". One separated phrase; ellipses. */
  metaLeft: JiraMetaCell[];
  /** Details line, right cluster — "when". Right-aligned, never shrinks. */
  metaRight: JiraMetaCell[];
}

export function buildRowCells(
  facts: JiraRowMetaFacts,
  show: JiraRowMetaShow,
  titleFields: string[] = [],
  extraIds: string[] = [],
  labelFor: (id: string) => string = (id) => id,
): JiraRowCells {
  const onTitle = new Set(titleFields);
  const left: JiraMetaCell[] = [];
  const right: JiraMetaCell[] = [];

  // The "who" columns, in queue-reading order: which FORM it came in on,
  // which customer, which person. An enabled fact the row lacks still pushes
  // its (empty) cell — reserving the column is the whole alignment mechanic.
  if (show.requestType) {
    left.push({
      id: "requestType",
      text: facts.requestType ?? "",
      tooltip: facts.requestType ? "Request type" : undefined,
      width: W_WHO,
    });
  }
  if (show.organization) {
    left.push({
      id: "organization",
      text: facts.organization ?? "",
      tooltip: facts.organization ? "Organization" : undefined,
      width: W_WHO,
    });
  }
  if (show.reporter) {
    left.push({
      id: "reporter",
      text: facts.reporterName ?? "",
      tooltip: facts.reporterName ? "Reporter" : undefined,
      width: W_WHO,
    });
  }
  for (const id of extraIds) {
    const text = facts.extra?.[id];
    if (text) left.push({ id, text, tooltip: labelFor(id), width: W_WHO });
  }
  // The site is context, never identity — it closes the line.
  if (facts.siteName) left.push({ id: "site", text: facts.siteName, tooltip: "Jira site" });

  if (facts.statusText) {
    right.push({ id: "status", text: facts.statusText, tooltip: "Status" });
  }
  if (show.priority && facts.priorityName) {
    const bucket = priorityBucket(facts.priorityName);
    // Default priority is the queue's background noise — omitted entirely so
    // the exceptional rows are the only ones that carry a chip.
    if (bucket !== "default") {
      right.push({
        id: "priority",
        text: facts.priorityName,
        tooltip: `Priority: ${facts.priorityName}`,
        chip: bucket === "urgent" ? "urgent" : "low",
      });
    }
  }
  const updated = show.updated ? relativeShortIso(facts.updatedIso) : "";
  if (updated) {
    right.push({
      id: "updated",
      text: updated,
      tooltip: `Last updated${exactTime(facts.updatedIso)}`,
      strong: true,
    });
  }
  const created = show.created ? relativeShortIso(facts.createdIso) : "";
  if (created) {
    right.push({
      id: "created",
      text: `sent ${created}`,
      tooltip: `Created${exactTime(facts.createdIso)}`,
    });
  }

  const all = [...left, ...right];
  const metaLeft = left.filter((c) => !onTitle.has(c.id));
  // The LAST column gives up its basis and takes the remaining room, so the
  // line never ends in a hard gap — usually the reporter, whose names and
  // e-mail addresses are the longest thing here.
  if (metaLeft.length > 0) {
    metaLeft[metaLeft.length - 1] = { ...metaLeft[metaLeft.length - 1], width: undefined };
  }
  return {
    // A reserved-but-empty cell must not ride the title line — an empty span
    // there would still cost its flex gap.
    title: all.filter((c) => onTitle.has(c.id) && c.text !== "").map((c) => ({ ...c, width: undefined })),
    metaLeft,
    metaRight: right.filter((c) => !onTitle.has(c.id)),
  };
}

/**
 * Priority as a solid chip, in the status badge's visual language (same
 * radius, padding, 9px/600 type) but content-width — it is an exception
 * marker, not a column.
 *
 * The urgent fill is the THEME's red, so the ink can't be a constant: the
 * themes range from pastel (#fd8183, wants dark ink) to saturated (#cc241d,
 * wants light). `badgeInkFor` needs the hex, and the CSS var can't give it
 * one, so the chip reads the active theme directly — the same source
 * App.tsx feeds `--ezy-red` from.
 */
function PriorityChip({
  cell,
  dim,
  ring,
}: {
  cell: JiraMetaCell;
  /** Archived rows: neutral fill, matching the status badge's `dim` — a
   *  dimmed red chip would read as a translucent "soft badge". */
  dim?: boolean;
  /** Inset hairline for full-color rows, where the row's own color can
   *  otherwise swallow the chip. */
  ring?: string;
}) {
  const themeId = useAppStore((s) => s.themeId);
  const neutral = dim || cell.chip !== "urgent";
  return (
    <span
      data-tooltip={cell.tooltip}
      style={{
        flexShrink: 0,
        boxSizing: "border-box",
        display: "inline-block",
        padding: "1px 5px",
        borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
        backgroundColor: neutral ? "var(--ezy-border)" : "var(--ezy-red)",
        color: neutral ? "var(--ezy-text-muted)" : badgeInkFor(getTheme(themeId).surface.red),
        boxShadow: ring ? `inset 0 0 0 1px ${ring}` : undefined,
        fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
        fontWeight: 600,
        lineHeight: 1.45,
        letterSpacing: "0.02em",
        textTransform: "uppercase",
        whiteSpace: "nowrap",
      }}
    >
      {cell.text}
    </span>
  );
}

export default function JiraRowMeta({
  left,
  right,
  fontPx = 10,
  muted = true,
  leftInset = 0,
  rightInset = 0,
  dim,
  ring,
}: {
  left: JiraMetaCell[];
  right: JiraMetaCell[];
  fontPx?: number;
  /** Full-color rows already have a colored ground; a muted token would fight
   *  it, so those pass `muted={false}` and lean on opacity instead. */
  muted?: boolean;
  /** Starts the phrase under the KEY — past the reserved chevron/dot slots —
   *  so the two lines share a left edge. */
  leftInset?: number;
  /** Ends the right cluster under the status badge's right edge — hamburger
   *  width + title-line gap — so the two lines share a right edge too. */
  rightInset?: number;
  /** Archived rows: the priority chip goes neutral, like the badge. */
  dim?: boolean;
  /** Full-color rows: hairline for the chip, same as the badge's. */
  ring?: string;
}) {
  // Reserved-but-empty columns don't count: a row with no facts at all keeps
  // its single-line height instead of carrying a blank details line.
  if (!left.some((c) => c.text !== "") && right.length === 0) return null;
  // On full-color rows the softening 0.75 sits on the TEXT, never on a
  // cluster: the chip lives inside the right cluster, and a container opacity
  // would composite it translucent over the row color — the "soft badge" look
  // this app bans, with the chip's contrast-picked ink no longer holding.
  const textOpacity = muted ? undefined : 0.75;
  // statusText only exists on rows too narrow for the badge, so it is the one
  // right-cluster cell allowed to give: the cluster un-pins and the status
  // ellipses rather than pushing the row past its inset.
  const shrinkable = right.some((c) => c.id === "status");
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        minWidth: 0,
        paddingLeft: leftInset,
        paddingRight: rightInset,
        fontSize: `calc(var(--ezy-font-scale, 1) * ${fontPx}px)`,
        fontVariantNumeric: "tabular-nums",
        color: muted ? "var(--ezy-text-muted)" : undefined,
      }}
    >
      {left.length > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flex: "1 1 auto",
            minWidth: 0,
            overflow: "hidden",
            opacity: textOpacity,
          }}
        >
          {left.map((c) => (
            <span
              key={c.id}
              data-tooltip={c.tooltip}
              style={{
                // The column mechanic: a shared basis that shrinks in step on
                // every row (empty cells included), the flexible last column
                // grows into the rest.
                flex: c.width === undefined ? "1 1 auto" : `0 1 ${c.width}px`,
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
      )}
      {right.length > 0 && (
        // marginLeft:auto, not space-between: the cluster stays pinned right
        // even when the left phrase is empty.
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flex: shrinkable ? "0 1 auto" : "0 0 auto",
            minWidth: 0,
            marginLeft: "auto",
          }}
        >
          {right.map((c) =>
            c.chip ? (
              <PriorityChip key={c.id} cell={c} dim={dim} ring={ring} />
            ) : (
              <span
                key={c.id}
                data-tooltip={c.tooltip}
                style={
                  c.id === "status"
                    ? {
                        flex: "0 1 auto",
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        opacity: textOpacity,
                      }
                    : {
                        flexShrink: 0,
                        whiteSpace: "nowrap",
                        opacity: textOpacity,
                        fontWeight: c.strong ? 600 : undefined,
                      }
                }
              >
                {c.text}
              </span>
            ),
          )}
        </div>
      )}
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
  dim,
  ring,
}: {
  cells: JiraMetaCell[];
  fontPx?: number;
  muted?: boolean;
  dim?: boolean;
  ring?: string;
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
      }}
    >
      {cells.map((c) =>
        c.chip ? (
          <PriorityChip key={c.id} cell={c} dim={dim} ring={ring} />
        ) : (
          <span
            key={c.id}
            data-tooltip={c.tooltip}
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              // Text softens on full-color rows; a chip sibling must not —
              // see the matching note in JiraRowMeta.
              opacity: muted ? undefined : 0.75,
              fontWeight: c.strong ? 600 : undefined,
            }}
          >
            {c.text}
          </span>
        ),
      )}
    </div>
  );
}
