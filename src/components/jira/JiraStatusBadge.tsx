/**
 * A ticket's Jira status as a solid color chip.
 *
 * THE WIDTH IS THE POINT. `width` is fixed and `flexShrink: 0`, and the badge
 * is pinned as the last flex item before the row's menu button — so its left
 * edge sits at the same x on every row, whatever the status is called, with no
 * measurement and no layout pass. "Waiting for support" and "To Do" start in
 * the same column; the long one ellipses inside its own box instead of
 * shoving the column around. The full text is always on the tooltip.
 *
 * Fill is solid, never translucent, and the ink is picked by real WCAG
 * contrast (`badgeInkFor`) rather than the BT.601 heuristic used for full-color
 * rows — at 9px/600 the four presets that heuristic gets wrong are genuinely
 * hard to read.
 */
import { badgeInkFor } from "../../lib/jira-colors";

export default function JiraStatusBadge({
  status,
  color,
  width,
  dim,
  ring,
}: {
  status: string;
  color: string;
  /** Fixed cell width in px — the alignment mechanic. */
  width: number;
  /** Archived rows: neutral fill instead of the status color. Dimming a
   *  colored badge would read as a translucent "soft badge"; going neutral
   *  says "no live status", which is also truer. */
  dim?: boolean;
  /** Inset hairline, for full-color rows where the badge color and the row
   *  color can otherwise be the same hue and the chip disappears. */
  ring?: string;
}) {
  const bg = dim ? "var(--ezy-border)" : color;
  return (
    <span
      data-tooltip={status}
      style={{
        width,
        flexShrink: 0,
        boxSizing: "border-box",
        display: "inline-block",
        textAlign: "center",
        padding: "1px 5px",
        borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
        backgroundColor: bg,
        color: dim ? "var(--ezy-text-muted)" : badgeInkFor(bg),
        // Inset, so gaining the ring never changes the chip's box size.
        boxShadow: ring ? `inset 0 0 0 1px ${ring}` : undefined,
        fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
        fontWeight: 600,
        lineHeight: 1.45,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {status}
    </span>
  );
}

/** Badge width for a given rail width. Wide enough for "In Progress" at the
 *  narrow end and most real status names at the wide end, and never so wide
 *  that it eats the ticket key's room. */
export function statusBadgeWidth(railWidth: number): number {
  return Math.round(Math.min(132, Math.max(56, railWidth - 176)));
}
